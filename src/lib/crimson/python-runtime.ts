/**
 * Real CPython (Pyodide, WebAssembly) for the editor and terminal. Browser-only.
 *
 * Isolation matches the JavaScript runner (see runtime.ts):
 *  - one hidden <iframe sandbox="allow-scripts"> with an opaque origin, so
 *    Python cannot reach this app's DOM, storage or cookies;
 *  - a CSP that allows network access ONLY to the pinned Pyodide folder on
 *    jsDelivr (runtime + packages), nothing else;
 *  - Python runs in a Web Worker inside that iframe, so a hang never blocks
 *    the UI. A run over PY_EXEC_TIMEOUT_MS kills the worker.
 *
 * Unlike the JS runner the iframe/worker is kept alive between runs so the
 * ~12 MB runtime loads once. Each run gets a fresh `__main__` namespace.
 * The worker is dropped after PY_IDLE_MS of inactivity to free memory.
 */

export const PYODIDE_VERSION = "314.0.7";
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const PY_EXEC_TIMEOUT_MS = 10_000;
const PY_LOAD_TIMEOUT_MS = 120_000;
const PY_IDLE_MS = 5 * 60_000;
const MAX_OUTPUT_CHARS = 20_000;

const DRIVER_PY = `import builtins, traceback
from pyodide.code import eval_code_async
def __tn_no_input(prompt=""):
    raise RuntimeError("input() is not available in the sandbox. Hard-code test values instead.")
builtins.input = __tn_no_input
__tn_err = None
try:
    await eval_code_async(__tn_src, {"__name__": "__main__"}, filename="<editor>")
except SystemExit as e:
    if e.code not in (None, 0):
        __tn_err = f"SystemExit: {e.code}"
except BaseException as e:
    if isinstance(e, SyntaxError):
        __tn_err = "".join(traceback.format_exception_only(type(e), e))
    else:
        tb = e.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename != "<editor>":
            tb = tb.tb_next
        __tn_err = "".join(traceback.format_exception(type(e), e, tb))
`;

const WORKER_SOURCE = `"use strict";
importScripts(${JSON.stringify(PYODIDE_BASE + "pyodide.js")});
// Runs the user's code in a fresh __main__ namespace and formats any error
// as a traceback that starts at the user's own "<editor>" frames.
const DRIVER = ${JSON.stringify(DRIVER_PY)};
let py = null, loading = null;
function ensure() {
  if (py) return Promise.resolve(py);
  if (!loading) loading = loadPyodide({ indexURL: ${JSON.stringify(PYODIDE_BASE)} })
    .then((p) => (py = p))
    .catch((e) => { loading = null; throw e; });
  return loading;
}
self.onmessage = async (event) => {
  const { id, code } = event.data;
  let size = 0, cut = false;
  const out = (line) => {
    if (cut) return;
    size += line.length;
    if (size > ${MAX_OUTPUT_CHARS}) { cut = true; postMessage({ id, line: "[WARN] Output truncated." }); return; }
    postMessage({ id, line });
  };
  let p;
  try {
    if (!py) postMessage({ id, status: "Loading Python ${PYODIDE_VERSION} (first run downloads ~12 MB)…" });
    p = await ensure();
  } catch (e) {
    postMessage({ id, done: true, loadFailed: true, error: String((e && e.message) || e) });
    return;
  }
  try {
    p.setStdout({ batched: (s) => out(s) });
    p.setStderr({ batched: (s) => out("[stderr] " + s) });
    p.setStdin({ error: true });
    await p.loadPackagesFromImports(code, {
      messageCallback: (m) => postMessage({ id, status: m }),
      errorCallback: (m) => out("[WARN] " + m),
    });
    postMessage({ id, phase: "exec" });
    const driver = p.toPy({ __tn_src: code });
    let error = null;
    try {
      await p.runPythonAsync(DRIVER, { globals: driver, filename: "<driver>" });
      error = driver.get("__tn_err") || null;
    } finally {
      driver.destroy();
    }
    postMessage({ id, done: true, error });
  } catch (e) {
    postMessage({ id, done: true, error: String((e && e.message) || e) });
  }
};
`;

const HOST_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: ${PYODIDE_BASE}; connect-src ${PYODIDE_BASE}; worker-src blob:">
</head><body><script>
const SOURCE = ${JSON.stringify(WORKER_SOURCE)};
let worker = null, idle = null;
function getWorker() {
  if (!worker) {
    worker = new Worker(URL.createObjectURL(new Blob([SOURCE], { type: "text/javascript" })));
    worker.onmessage = (m) => onWorker(m.data);
    worker.onerror = (e) => { e.preventDefault(); if (current) finish({ error: e.message || "Python worker crashed", loadFailed: true }); kill(); };
  }
  return worker;
}
function kill() { try { worker && worker.terminate(); } catch (e) {} worker = null; }
let current = null; // { id, logs, execTimer, loadTimer }
function finish(payload) {
  if (!current) return;
  clearTimeout(current.execTimer); clearTimeout(current.loadTimer);
  parent.postMessage(Object.assign({ id: current.id, logs: current.logs, done: true }, payload), "*");
  current = null;
  clearTimeout(idle); idle = setTimeout(kill, ${PY_IDLE_MS});
}
function onWorker(data) {
  if (!current || !data || data.id !== current.id) return;
  if (typeof data.line === "string") current.logs.push(data.line);
  else if (typeof data.status === "string") parent.postMessage({ id: current.id, status: data.status }, "*");
  else if (data.phase === "exec") {
    clearTimeout(current.loadTimer);
    current.execTimer = setTimeout(() => { kill(); finish({ timeout: true }); }, ${PY_EXEC_TIMEOUT_MS});
  } else if (data.done) finish({ error: data.error, loadFailed: data.loadFailed === true });
}
addEventListener("message", (event) => {
  if (event.source !== parent || !event.data || typeof event.data.code !== "string" || current) return;
  clearTimeout(idle);
  current = { id: event.data.id, logs: [] };
  current.loadTimer = setTimeout(() => { kill(); finish({ error: "Python took too long to load.", loadFailed: true }); }, ${PY_LOAD_TIMEOUT_MS});
  try { getWorker().postMessage({ id: current.id, code: event.data.code }); }
  catch (e) { finish({ error: "Could not start an isolated worker: " + (e && e.message), loadFailed: true }); }
});
parent.postMessage({ ready: true }, "*");
</script></body></html>`;

export type PyResult = { logs: string[]; error: string | null; timeout: boolean; loadFailed: boolean };

let frame: HTMLIFrameElement | null = null;
let ready: Promise<void> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function ensureFrame(): Promise<void> {
  if (frame?.isConnected && ready) return ready;
  frame?.remove();
  const el = document.createElement("iframe");
  el.setAttribute("sandbox", "allow-scripts");
  el.setAttribute("aria-hidden", "true");
  el.tabIndex = -1;
  el.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none";
  el.srcdoc = HOST_HTML;
  frame = el;
  ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onReady);
      reject(new Error("The Python sandbox did not start."));
    }, 10_000);
    const onReady = (event: MessageEvent) => {
      if (event.source !== el.contentWindow || !(event.data as { ready?: boolean } | null)?.ready) return;
      clearTimeout(timer);
      window.removeEventListener("message", onReady);
      resolve();
    };
    window.addEventListener("message", onReady);
  });
  document.body.appendChild(el);
  ready.catch(() => {
    el.remove();
    if (frame === el) frame = null;
    ready = null;
  });
  return ready;
}

function runOnce(code: string, onStatus?: (line: string) => void): Promise<PyResult> {
  return ensureFrame().then(
    () =>
      new Promise<PyResult>((resolve) => {
        const el = frame!;
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const done = (result: PyResult) => {
          window.removeEventListener("message", onMessage);
          clearTimeout(guard);
          resolve(result);
        };
        const onMessage = (event: MessageEvent) => {
          if (event.source !== el.contentWindow) return;
          const data = event.data as {
            id?: string; status?: unknown; done?: boolean; logs?: unknown; error?: unknown; timeout?: unknown; loadFailed?: unknown;
          } | null;
          if (!data || data.id !== id) return;
          if (typeof data.status === "string" && !data.done) {
            onStatus?.(`[RUNTIME] ${data.status.slice(0, 200)}`);
            return;
          }
          if (!data.done) return;
          done({
            logs: Array.isArray(data.logs) ? data.logs.map(String).slice(0, 2000) : [],
            error: typeof data.error === "string" ? data.error.slice(0, 4000) : null,
            timeout: data.timeout === true,
            loadFailed: data.loadFailed === true,
          });
        };
        const guard = setTimeout(() => {
          // Frame wedged: throw it away so the next run starts clean.
          el.remove();
          if (frame === el) {
            frame = null;
            ready = null;
          }
          done({ logs: [], error: "The Python sandbox stopped responding.", timeout: false, loadFailed: true });
        }, PY_LOAD_TIMEOUT_MS + PY_EXEC_TIMEOUT_MS + 5000);
        window.addEventListener("message", onMessage);
        el.contentWindow?.postMessage({ id, code }, "*");
      }),
    (error: unknown) => ({
      logs: [],
      error: error instanceof Error ? error.message : String(error),
      timeout: false,
      loadFailed: true,
    }),
  );
}

/** Runs one program at a time (editor and terminal share the interpreter). */
export function runPyodide(code: string, onStatus?: (line: string) => void): Promise<PyResult> {
  const next = queue.then(() => runOnce(code, onStatus));
  queue = next.catch(() => undefined);
  return next;
}

export const PY_LIMIT_SECONDS = PY_EXEC_TIMEOUT_MS / 1000;
