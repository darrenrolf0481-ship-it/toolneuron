import { createFileRoute } from "@tanstack/react-router";
import { BRANCH_NAME } from "@/lib/crimson/git";
import { parseRepo } from "@/lib/crimson/terminal";

/**
 * POST /api/git/fetch  {"repo":"owner/name","branch":"main","base":"<sha>"}
 *   → {ok:true, tip, ahead, subjects, changes:[{path, content|null, unsupported?}]}
 *   → {ok:false, error}
 *
 * What changed on a GitHub branch since `base` (the tip the browser last
 * saw), as the NET difference between the two commits' trees, so merges and
 * commit order on GitHub do not matter. Sizes and modes come from the trees,
 * so nothing too large is ever downloaded: a path over the size cap, a
 * symlink, a submodule, or a blob that is binary or not UTF-8 is returned as
 * `unsupported` with no contents. Used by git pull. Needs GITHUB_TOKEN and
 * the repo on GITHUB_REPOS; same access checks as push; one overall deadline,
 * cancelled when the browser goes away.
 */
const MAX_CHANGED = 300;
const MAX_FILE_BYTES = 200_000;
const MAX_TOTAL_BYTES = 1_500_000;
const DEADLINE_MS = 60_000;
const SHA = /^[0-9a-f]{40}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

type Entry = { path: string; mode: string; type: string; sha: string; size?: number };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

async function handle(request: Request): Promise<Response> {
  const { guardCloneCall, isCrossSite } = await import("@/lib/crimson/access.server");
  const { gh, githubToken, notAllowed, repoAllowed } = await import("@/lib/crimson/github.server");
  let refused: string | null;
  try {
    refused = guardCloneCall();
  } catch (error) {
    if (!isCrossSite(error)) throw error;
    return json({ ok: false, error: "Cross-site request refused." }, 403);
  }
  if (refused) return json({ ok: false, error: refused.replace("to clone", "to pull").replace("clones", "pulls") });
  if (!githubToken()) return json({ ok: false, error: "Pull is off: set GITHUB_TOKEN on the server." });

  const body = (await request.json().catch(() => null)) as { repo?: unknown; branch?: unknown; base?: unknown } | null;
  const repo = typeof body?.repo === "string" ? parseRepo(body.repo) : null;
  const branch = typeof body?.branch === "string" && BRANCH_NAME.test(body.branch) ? body.branch : null;
  const base = typeof body?.base === "string" && SHA.test(body.base) ? body.base : null;
  if (!repo || !branch || !base) return json({ ok: false, error: "Bad request." }, 400);
  if (!repoAllowed(repo)) return json({ ok: false, error: notAllowed(repo, "Pull") });

  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(DEADLINE_MS)]);
  const fail = (error: string) => (request.signal.aborted ? new Response(null, { status: 204 }) : json({ ok: false, error }));

  const ref = await gh<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${branch}`, { signal });
  if (!ref.ok) return fail(ref.status === 404 ? `GitHub has no branch '${branch}' in ${repo}.` : ref.error);
  const tip = ref.data.object.sha;
  if (tip === base) return json({ ok: true, tip, ahead: 0, subjects: [], changes: [] });

  // Is the last-seen tip still in GitHub's history? (Also gives the commit subjects.)
  const compare = await gh<{ status: string; ahead_by: number; commits: { commit: { message: string } }[] }>(`/repos/${repo}/compare/${base}...${tip}`, { signal });
  if (!compare.ok) return fail(compare.error);
  if (compare.data.status === "behind") return json({ ok: true, tip: base, ahead: 0, subjects: [], changes: [], note: `GitHub's '${branch}' is behind this project; nothing to pull.` });
  if (compare.data.status !== "ahead") {
    return fail(`GitHub's '${branch}' no longer contains the commit this project last saw (history was rewritten, e.g. a force push). Clone it again.`);
  }
  const subjects = compare.data.commits.map((item) => item.commit.message.split("\n")[0]).reverse().slice(0, 12);

  // Net change between the two trees.
  const treeOf = async (sha: string) => {
    const commit = await gh<{ tree: { sha: string } }>(`/repos/${repo}/git/commits/${sha}`, { signal });
    if (!commit.ok) return commit.error;
    const tree = await gh<{ truncated: boolean; tree: Entry[] }>(`/repos/${repo}/git/trees/${commit.data.tree.sha}?recursive=1`, { signal });
    if (!tree.ok) return tree.error;
    if (tree.data.truncated) return "the repository tree is too large for GitHub to list in one request; clone it again instead";
    return new Map(tree.data.tree.filter((entry) => entry.type !== "tree").map((entry) => [entry.path, entry]));
  };
  const before = await treeOf(base);
  if (typeof before === "string") return fail(before);
  const after = await treeOf(tip);
  if (typeof after === "string") return fail(after);
  const changedPaths = [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => {
      const a = before.get(path);
      const b = after.get(path);
      return !a || !b || a.sha !== b.sha || a.mode !== b.mode || a.type !== b.type;
    })
    .sort();
  if (changedPaths.length > MAX_CHANGED) return fail(`${changedPaths.length} files changed on GitHub; pulling more than ${MAX_CHANGED} at once is not supported. Clone it again.`);

  let total = 0;
  const changes: { path: string; content: string | null; unsupported?: boolean }[] = [];
  for (const path of changedPaths) {
    const entry = after.get(path);
    if (!entry) {
      changes.push({ path, content: null });
      continue;
    }
    // Symlinks (120000), submodules (commit / 160000) and anything too large are never downloaded.
    const size = entry.size ?? Infinity;
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755") || size > MAX_FILE_BYTES) {
      changes.push({ path, content: null, unsupported: true });
      continue;
    }
    if (total + size > MAX_TOTAL_BYTES) return fail(`more than ${MAX_TOTAL_BYTES / 1_000_000} MB of files changed on GitHub; too much for one pull. Clone it again.`);
    const blob = await gh<{ content: string; encoding: string }>(`/repos/${repo}/git/blobs/${entry.sha}`, { signal });
    if (!blob.ok) return fail(blob.error);
    const bytes = Buffer.from(blob.data.content, blob.data.encoding === "base64" ? "base64" : "utf8");
    total += bytes.length;
    try {
      if (bytes.subarray(0, 8000).includes(0)) throw new Error("binary");
      changes.push({ path, content: decoder.decode(bytes) });
    } catch {
      changes.push({ path, content: null, unsupported: true });
    }
  }
  return json({ ok: true, tip, ahead: compare.data.ahead_by, subjects, changes });
}

export const Route = createFileRoute("/api/git/fetch")({
  server: {
    handlers: {
      POST: ({ request }) => handle(request),
    },
  },
});
