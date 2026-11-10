/**
 * Code runners for the editor and terminal. Browser-only (call from event handlers).
 *
 * JavaScript isolation, outermost first:
 *  1. A fresh hidden <iframe sandbox="allow-scripts"> per run. Without
 *     allow-same-origin it gets an opaque origin: no access to this app's
 *     DOM, localStorage, IndexedDB or cookies, and no popups or navigation.
 *  2. A CSP inside it: default-src 'none' blocks fetch, XHR, WebSocket,
 *     images and imports. The only network-free escape hatch left is
 *     postMessage to this page, which we validate.
 *  3. The code runs in a Web Worker started by that iframe, so an endless
 *     loop never blocks the UI. It is terminated after RUN_TIMEOUT_MS.
 */

import { PY_LIMIT_SECONDS, runPyodide } from "./python-runtime";

const RUN_TIMEOUT_MS = 3000;
const MAX_OUTPUT_CHARS = 20_000;

/**
 * Run a file. `onStatus` receives live runtime notices (e.g. "Loading Python…")
 * while the final output is pending.
 */
export async function runSource(language: string, code: string, onStatus?: (line: string) => void): Promise<string> {
  if (language === "javascript" || language === "js") return runJs(code);
  if (language === "python" || language === "py") return runPython(code, onStatus);
  if (language === "html") return "[SYSTEM] HTML has no stdout. Switch to Preview.";
  if (language === "json") {
    try {
      JSON.parse(code);
      return "[SUCCESS] JSON parses.";
    } catch (error) {
      return `[ERROR] ${error instanceof Error ? error.message : "Invalid JSON"}`;
    }
  }
  return `[SYSTEM] No local interpreter for ${language || "this file"}. The node can still review it.`;
}

/** Worker script: console shim + the user's code inside an async function (top-level await works). */
function workerSource(code: string): string {
  return `"use strict";
let __size = 0; let __cut = false;
const __show = (v) => { if (typeof v === "string") return v; if (v instanceof Error) return v.name + ": " + v.message;
  try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch { return String(v); } };
const __push = (prefix, args) => { if (__cut) return; const line = prefix + args.map(__show).join(" ");
  __size += line.length; if (__size > ${MAX_OUTPUT_CHARS}) { __cut = true; postMessage({ line: "[WARN] Output truncated." }); return; } postMessage({ line }); };
const console = { log: (...a) => __push("", a), debug: (...a) => __push("", a), info: (...a) => __push("[INFO] ", a),
  warn: (...a) => __push("[WARN] ", a), error: (...a) => __push("[ERROR] ", a) };
self.console = console;
self.addEventListener("unhandledrejection", (e) => __push("[ERROR] Unhandled rejection: ", [e.reason]));
const __done = (error) => setTimeout(() => postMessage({ done: true, error }), 30);
(async () => {
${code}
})().then(() => __done(null), (e) => __done(e instanceof Error ? e.name + ": " + e.message : String(e)));
`;
}

/** Runs inside the sandboxed iframe: starts the worker, enforces the timeout, reports back. */
const HOST_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:">
</head><body><script>
addEventListener("message", (event) => {
  if (event.source !== parent || !event.data || typeof event.data.source !== "string") return;
  const { id, source, timeout } = event.data;
  let worker; let finished = false; const logs = [];
  const finish = (payload) => {
    if (finished) return; finished = true;
    try { worker && worker.terminate(); } catch (e) {}
    parent.postMessage(Object.assign({ id, logs }, payload), "*");
  };
  try {
    worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
  } catch (err) {
    finish({ fatal: "Could not start an isolated worker: " + (err && err.message) });
    return;
  }
  // Lines stream in as they are printed, so output before a hang is kept.
  worker.onmessage = (m) => { if (m.data && m.data.done) finish({ error: m.data.error }); else if (m.data && typeof m.data.line === "string") logs.push(m.data.line); };
  worker.onerror = (e) => { e.preventDefault(); finish({ error: e.message || "Script error" }); };
  setTimeout(() => finish({ timeout: true }), timeout);
});
parent.postMessage({ ready: true }, "*");
</script></body></html>`;

type RunResult = { logs?: string[]; error?: string | null; timeout?: boolean; fatal?: string };

function runJs(code: string): Promise<string> {
  if (typeof document === "undefined") return Promise.resolve("[ERROR] The runner needs a browser.");
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise<RunResult>((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none";
    frame.srcdoc = HOST_HTML;

    let settled = false;
    const done = (result: RunResult) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearTimeout(guard);
      frame.remove();
      resolve(result);
    };
    const onMessage = (event: MessageEvent) => {
      // Only trust messages from this run's own frame (its origin is opaque, so check the window).
      if (event.source !== frame.contentWindow) return;
      const data = event.data as (RunResult & { ready?: boolean; id?: string }) | null;
      if (!data || typeof data !== "object") return;
      if (data.ready) {
        frame.contentWindow?.postMessage({ id, source: workerSource(code), timeout: RUN_TIMEOUT_MS }, "*");
        return;
      }
      if (data.id !== id) return;
      done({
        logs: Array.isArray(data.logs) ? data.logs.map(String).slice(0, 2000) : [],
        error: typeof data.error === "string" ? data.error.slice(0, 2000) : null,
        timeout: data.timeout === true,
        fatal: typeof data.fatal === "string" ? data.fatal.slice(0, 500) : undefined,
      });
    };
    // Backstop if the frame never answers (blocked, crashed).
    const guard = setTimeout(() => done({ fatal: "The isolated runner did not respond." }), RUN_TIMEOUT_MS + 3000);
    window.addEventListener("message", onMessage);
    document.body.appendChild(frame);
  }).then((result) => {
    if (result.fatal) return `[ERROR] ${result.fatal}`;
    const logs = result.logs ?? [];
    if (result.timeout) return [...logs, `[ERROR] Stopped after ${RUN_TIMEOUT_MS / 1000}s. Infinite loop?`].join("\n");
    if (result.error) return [...logs, `[ERROR] ${result.error}`].join("\n");
    logs.push(logs.length === 0 ? "[SUCCESS] Exited 0. No stdout." : "[SUCCESS] Exited 0.");
    return logs.join("\n");
  });
}

async function runPython(code: string, onStatus?: (line: string) => void): Promise<string> {
  if (typeof document === "undefined") return "[ERROR] The runner needs a browser.";
  const result = await runPyodide(code, onStatus);
  if (result.loadFailed) {
    return [
      `[WARN] Real Python is unavailable (${result.error ?? "load failed"}). Is the device offline?`,
      runPythonLite(code),
    ].join("\n");
  }
  const out = [...result.logs];
  if (result.timeout) out.push(`[ERROR] Stopped after ${PY_LIMIT_SECONDS}s. Infinite loop?`);
  else if (result.error) out.push(`[ERROR] ${result.error.trim()}`);
  else out.push(out.length === 0 ? "[SUCCESS] Exited 0. No stdout." : "[SUCCESS] Exited 0.");
  return out.join("\n");
}

/** Offline fallback: echoes print() literals only. It does not execute code. */
function runPythonLite(code: string): string {
  const out: string[] = ["[RUNTIME] python-lite fallback (echoes print() literals, does not execute)"];
  const prints = code.matchAll(/print\s*\(([\s\S]*?)\)/g);
  let saw = false;
  for (const match of prints) {
    saw = true;
    out.push(evalPrint(match[1].trim()));
  }
  if (!saw) out.push("[INFO] No print() calls found.");
  return out.join("\n");
}

function evalPrint(expr: string): string {
  const quoted = expr.match(/^f?(["'])([\s\S]*)\1$/);
  if (quoted) return quoted[2].replace(/\{[^}]*\}/g, "…");
  if (expr.includes(",")) return expr.split(",").map((part) => evalPrint(part.trim())).join(" ");
  return expr;
}
