import { createFileRoute } from "@tanstack/react-router";
import { BRANCH_NAME } from "@/lib/crimson/git";
import { parseRepo } from "@/lib/crimson/terminal";

/**
 * POST /api/git/fetch  {"repo":"owner/name","branch":"main","base":"<sha>"}
 *   → {ok:true, head, commits:[{sha, message, changes:[{path, content|null}], skipped:[path]}]}
 *   → {ok:false, error}
 *
 * The commits on a GitHub branch after `base` (the newest commit the browser
 * knows is on GitHub), oldest first, each with the text contents of the files
 * it changed (relative to its first parent). Used by git pull. Binary,
 * oversized or non-UTF-8 files are listed in `skipped` instead. Needs
 * GITHUB_TOKEN; same access checks as push.
 */
const MAX_COMMITS = 50;
const MAX_FILE_BYTES = 200_000;
const MAX_TOTAL_BYTES = 1_500_000;
const SHA = /^[0-9a-f]{40}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

type CompareCommit = { sha: string; commit: { message: string } };
type CommitFile = { filename: string; status: string; sha?: string; previous_filename?: string };

async function handle(request: Request): Promise<Response> {
  const { guardCloneCall } = await import("@/lib/crimson/access.server");
  const { gh, githubToken } = await import("@/lib/crimson/github.server");
  let refused: string | null;
  try {
    refused = guardCloneCall();
  } catch {
    return json({ ok: false, error: "Cross-site request refused." }, 403);
  }
  if (refused) return json({ ok: false, error: refused.replace("to clone", "to pull").replace("clones", "pulls") });
  if (!githubToken()) return json({ ok: false, error: "Pull is off: set GITHUB_TOKEN on the server." });

  const body = (await request.json().catch(() => null)) as { repo?: unknown; branch?: unknown; base?: unknown } | null;
  const repo = typeof body?.repo === "string" ? parseRepo(body.repo) : null;
  const branch = typeof body?.branch === "string" && BRANCH_NAME.test(body.branch) ? body.branch : null;
  const base = typeof body?.base === "string" && SHA.test(body.base) ? body.base : null;
  if (!repo || !branch || !base) return json({ ok: false, error: "Bad request." }, 400);

  const compare = await gh<{ status: string; ahead_by: number; commits: CompareCommit[] }>(`/repos/${repo}/compare/${base}...${branch}`);
  if (!compare.ok) {
    if (compare.status === 404) return json({ ok: false, error: `GitHub has no branch '${branch}' in ${repo} (or the token cannot see it).` });
    return json({ ok: false, error: compare.error });
  }
  const { status, ahead_by: ahead } = compare.data;
  if (status === "identical") return json({ ok: true, head: base, commits: [] });
  if (status === "behind") return json({ ok: true, head: base, commits: [], note: "GitHub is behind this project; nothing to pull." });
  if (status !== "ahead") {
    return json({ ok: false, error: `GitHub's '${branch}' no longer contains the last commit this project knows (history was rewritten, e.g. a force push). Clone it again.` });
  }
  if (ahead > MAX_COMMITS || compare.data.commits.length < ahead) {
    return json({ ok: false, error: `GitHub has ${ahead} new commits on '${branch}'; pulling more than ${MAX_COMMITS} at once is not supported. Clone it again.` });
  }

  let total = 0;
  const out: { sha: string; message: string; changes: { path: string; content: string | null }[]; skipped: string[] }[] = [];
  for (const item of compare.data.commits) {
    const detail = await gh<{ files?: CommitFile[] }>(`/repos/${repo}/commits/${item.sha}`);
    if (!detail.ok) return json({ ok: false, error: detail.error });
    const files = detail.data.files ?? [];
    if (files.length >= 300) return json({ ok: false, error: `Commit ${item.sha.slice(0, 7)} changes 300+ files; too large to pull. Clone again.` });
    const changes: { path: string; content: string | null }[] = [];
    const skipped: string[] = [];
    for (const file of files) {
      if (file.status === "renamed" && file.previous_filename) changes.push({ path: file.previous_filename, content: null });
      if (file.status === "removed") {
        changes.push({ path: file.filename, content: null });
        continue;
      }
      if (!file.sha) continue;
      const blob = await gh<{ content: string; encoding: string; size: number }>(`/repos/${repo}/git/blobs/${file.sha}`);
      if (!blob.ok) return json({ ok: false, error: blob.error });
      if (blob.data.size > MAX_FILE_BYTES || total + blob.data.size > MAX_TOTAL_BYTES) {
        skipped.push(file.filename);
        continue;
      }
      const bytes = Buffer.from(blob.data.content, blob.data.encoding === "base64" ? "base64" : "utf8");
      let text: string;
      try {
        if (bytes.subarray(0, 8000).includes(0)) throw new Error("binary");
        text = decoder.decode(bytes);
      } catch {
        skipped.push(file.filename);
        continue;
      }
      total += blob.data.size;
      changes.push({ path: file.filename, content: text });
    }
    out.push({ sha: item.sha, message: item.commit.message, changes, skipped });
  }
  return json({ ok: true, head: out[out.length - 1]?.sha ?? base, commits: out });
}

export const Route = createFileRoute("/api/git/fetch")({
  server: {
    handlers: {
      POST: ({ request }) => handle(request),
    },
  },
});
