import { createFileRoute } from "@tanstack/react-router";
import { BRANCH_NAME } from "@/lib/crimson/git";
import { parseRepo } from "@/lib/crimson/terminal";

/**
 * POST /api/git/push — body: a PushPlan from git.ts
 *   {repo, branch, parentSha, commits: [{id, message, changes: [{path, content|null}]}]}
 *   → {ok:true, shas:[…one per commit…], url}  |  {ok:false, error}
 *
 * Replays the local commits onto GitHub with the Git Data API (one tree and
 * one commit each), then moves the branch. Fast-forward only, never forced:
 * the remote branch must be at parentSha, or not exist yet. Needs
 * GITHUB_TOKEN on the server; same access key and same-site checks as chat.
 */
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const MAX_COMMITS = 50;

type Change = { path: string; content: string | null };
type PlanBody = { repo?: unknown; branch?: unknown; parentSha?: unknown; commits?: unknown };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

const validPath = (path: unknown): path is string =>
  typeof path === "string" && path.length > 0 && path.length < 400 && !path.startsWith("/") && !path.split("/").some((part) => part === "" || part === "." || part === "..");

function parseCommits(raw: unknown): { message: string; changes: Change[] }[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "nothing to push";
  if (raw.length > MAX_COMMITS) return `too many commits in one push (max ${MAX_COMMITS})`;
  const out: { message: string; changes: Change[] }[] = [];
  for (const item of raw) {
    const commit = (item && typeof item === "object" ? item : {}) as { message?: unknown; changes?: unknown };
    const message = typeof commit.message === "string" ? commit.message.trim().slice(0, 2000) : "";
    if (!message) return "every commit needs a message";
    if (!Array.isArray(commit.changes)) return "bad commit changes";
    const changes: Change[] = [];
    for (const change of commit.changes) {
      const c = (change && typeof change === "object" ? change : {}) as { path?: unknown; content?: unknown };
      if (!validPath(c.path)) return `bad path: ${String(c.path).slice(0, 80)}`;
      if (c.content !== null && typeof c.content !== "string") return `bad contents for ${c.path}`;
      changes.push({ path: c.path, content: c.content as string | null });
    }
    out.push({ message, changes });
  }
  return out;
}

async function handle(request: Request): Promise<Response> {
  const { guardCloneCall } = await import("@/lib/crimson/access.server");
  const { gh, githubToken } = await import("@/lib/crimson/github.server");
  let refused: string | null;
  try {
    refused = guardCloneCall();
  } catch {
    return json({ ok: false, error: "Cross-site request refused." }, 403);
  }
  if (refused) return json({ ok: false, error: refused.replace("to clone", "to push").replace("clones", "pushes") });
  if (!githubToken()) return json({ ok: false, error: "Push is off: set GITHUB_TOKEN on the server (a fine-grained token with Contents: Read and write for the repo)." });

  const raw = await request.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) return json({ ok: false, error: "Push too large for one request (6 MB)." }, 413);
  let body: PlanBody;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "Bad request." }, 400);
  }
  const repo = typeof body.repo === "string" ? parseRepo(body.repo) : null;
  if (!repo) return json({ ok: false, error: "Bad repo." }, 400);
  const branch = typeof body.branch === "string" && BRANCH_NAME.test(body.branch) ? body.branch : null;
  if (!branch) return json({ ok: false, error: "Bad branch name." }, 400);
  const parentSha = typeof body.parentSha === "string" && /^[0-9a-f]{40}$/.test(body.parentSha) ? body.parentSha : null;
  const commits = parseCommits(body.commits);
  if (typeof commits === "string") return json({ ok: false, error: commits });

  // Where is the remote branch now?
  const ref = await gh<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch).replace(/%2F/g, "/")}`);
  const exists = ref.ok;
  if (!ref.ok && ref.status !== 404) return json({ ok: false, error: ref.error });
  if (exists && !parentSha) {
    return json({ ok: false, error: `${repo} already has a '${branch}' branch that shares no history with this project. Clone the repo (with GITHUB_TOKEN set) and work in that copy, or push to a new branch.` });
  }
  if (exists && ref.data.object.sha !== parentSha) {
    return json({ ok: false, error: `Rejected: ${repo} '${branch}' has commits this project does not have (not a fast-forward). Pull is not available; clone again to get them. Nothing was changed.` });
  }

  // File modes on the base tree, so executables stay executable.
  const modes = new Map<string, string>();
  let baseTree: string | undefined;
  if (parentSha) {
    const base = await gh<{ tree: { sha: string } }>(`/repos/${repo}/git/commits/${parentSha}`);
    if (!base.ok) return json({ ok: false, error: base.error });
    baseTree = base.data.tree.sha;
    const listing = await gh<{ tree: { path: string; mode: string; type: string }[] }>(`/repos/${repo}/git/trees/${baseTree}?recursive=1`);
    if (listing.ok) for (const entry of listing.data.tree) if (entry.type === "blob") modes.set(entry.path, entry.mode);
  }

  const shas: string[] = [];
  let parent = parentSha;
  for (const commit of commits) {
    let tree = baseTree;
    if (commit.changes.length > 0 || !tree) {
      const entries = commit.changes.map((change) =>
        change.content === null
          ? { path: change.path, mode: modes.get(change.path) ?? "100644", type: "blob", sha: null }
          : { path: change.path, mode: modes.get(change.path) ?? "100644", type: "blob", content: change.content },
      );
      const made = await gh<{ sha: string }>(`/repos/${repo}/git/trees`, { method: "POST", body: { ...(tree ? { base_tree: tree } : {}), tree: entries } });
      if (!made.ok) return json({ ok: false, error: `${made.error}${shas.length ? ` (after ${shas.length} commit(s); the branch was not moved)` : ""}` });
      tree = made.data.sha;
      for (const change of commit.changes) {
        if (change.content === null) modes.delete(change.path);
        else if (!modes.has(change.path)) modes.set(change.path, "100644");
      }
    }
    const created = await gh<{ sha: string }>(`/repos/${repo}/git/commits`, { method: "POST", body: { message: commit.message, tree, parents: parent ? [parent] : [] } });
    if (!created.ok) return json({ ok: false, error: `${created.error}${shas.length ? ` (after ${shas.length} commit(s); the branch was not moved)` : ""}` });
    shas.push(created.data.sha);
    parent = created.data.sha;
    baseTree = tree;
  }

  const moved = exists
    ? await gh(`/repos/${repo}/git/refs/heads/${branch}`, { method: "PATCH", body: { sha: parent, force: false } })
    : await gh(`/repos/${repo}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: parent } });
  if (!moved.ok) return json({ ok: false, error: `${moved.error} (the commits were made but the branch was not moved)` });
  return json({ ok: true, shas, url: `https://github.com/${repo}/tree/${branch}`, created: !exists });
}

export const Route = createFileRoute("/api/git/push")({
  server: {
    handlers: {
      POST: ({ request }) => handle(request),
    },
  },
});
