import { gunzipSync } from "node:zlib";
import { createFileRoute } from "@tanstack/react-router";
import { DEFAULT_CLONE_LIMITS, readTar } from "@/lib/crimson/tar";
import { parseRepo } from "@/lib/crimson/terminal";

/**
 * POST /api/clone  {"repo":"owner/name"}
 *   → {"ok":true,"repo":"owner/name","files":[{path,content}],"skipped":{…}}
 *   → {"ok":false,"error":"…"}
 *
 * Downloads a PUBLIC GitHub repository's current snapshot (the default
 * branch, as a tar.gz from GitHub's archive service) and returns its text
 * files, within DEFAULT_CLONE_LIMITS so the result fits in browser storage.
 * No token is used, so private repositories are not reachable. Only
 * github.com and codeload.github.com are ever fetched.
 *
 * Same access key and same-site checks as chat, with its own rate limit.
 */
const MAX_ARCHIVE_BYTES = 15 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 60 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(["github.com", "codeload.github.com"]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

async function readCapped(response: Response, cap: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function handle(request: Request): Promise<Response> {
  const { guardCloneCall } = await import("@/lib/crimson/access.server");
  let refused: string | null;
  try {
    refused = guardCloneCall();
  } catch {
    return json({ ok: false, error: "Cross-site request refused." }, 403);
  }
  if (refused) return json({ ok: false, error: refused });

  const body = (await request.json().catch(() => null)) as { repo?: unknown } | null;
  const repo = typeof body?.repo === "string" ? parseRepo(body.repo) : null;
  if (!repo) return json({ ok: false, error: "Give a public GitHub repo as owner/name." }, 400);

  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]);
  let response: Response;
  try {
    // Redirects to codeload.github.com; the final host is checked below.
    response = await fetch(`https://github.com/${repo}/archive/HEAD.tar.gz`, { signal, redirect: "follow", headers: { "User-Agent": "ToolNeuron-clone" } });
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 204 });
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    return json({ ok: false, error: timedOut ? "GitHub took too long to send the archive." : "Could not reach GitHub." });
  }
  const host = new URL(response.url).hostname;
  if (!ALLOWED_HOSTS.has(host)) return json({ ok: false, error: "GitHub redirected somewhere unexpected; refused." });
  if (response.status === 404) return json({ ok: false, error: `${repo} was not found. It may be private (only public repos can be cloned) or misspelled.` });
  if (!response.ok) return json({ ok: false, error: `GitHub returned ${response.status} for ${repo}.` });

  const archive = await readCapped(response, MAX_ARCHIVE_BYTES).catch(() => undefined);
  if (archive === undefined) return json({ ok: false, error: "The download from GitHub broke off." });
  if (archive === null) return json({ ok: false, error: `${repo} is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB compressed; too big to clone here.` });

  let tar: Uint8Array;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch {
    return json({ ok: false, error: `${repo} unpacks to more than ${MAX_UNPACKED_BYTES / 1024 / 1024} MB, or the archive is damaged.` });
  }
  const result = readTar(tar, DEFAULT_CLONE_LIMITS);
  if (result.files.length === 0) return json({ ok: false, error: `${repo} has no text files within the limits.` });
  return json({ ok: true, repo, files: result.files, skipped: result.skipped, limits: DEFAULT_CLONE_LIMITS });
}

export const Route = createFileRoute("/api/clone")({
  server: {
    handlers: {
      POST: ({ request }) => handle(request),
    },
  },
});
