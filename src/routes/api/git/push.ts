import { createFileRoute } from "@tanstack/react-router";
import { BRANCH_NAME } from "@/lib/crimson/git";
import { parseRepo } from "@/lib/crimson/terminal";

/**
 * POST /api/git/push — body: a PushPlan from git.ts
 *   {repo, branch, expectSha, commits: [{message, parents: [{sha}|{index}], changes: [{path, content|null}]}]}
 *   → {ok:true, shas:[…one per commit…], url, created}  |  {ok:false, error}
 *
 * Replays the local commits onto GitHub with the Git Data API (a tree and a
 * commit each, merge commits keep both parents, file modes are kept), then
 * moves the branch. Fast-forward only, never forced: the remote branch must
 * be at expectSha, or not exist yet. An empty repo is bootstrapped (see
 * bootstrapEmpty). Needs GITHUB_TOKEN; same access checks as chat.
 */
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const MAX_COMMITS = 50;

type Change = { path: string; content: string | null };
type Parent = { sha: string } | { index: number };
type Planned = { message: string; parents: Parent[]; changes: Change[] };
type Gh = (typeof import("@/lib/crimson/github.server"))["gh"];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

const SHA = /^[0-9a-f]{40}$/;
const validPath = (path: unknown): path is string =>
  typeof path === "string" && path.length > 0 && path.length < 400 && !path.startsWith("/") && !path.split("/").some((part) => part === "" || part === "." || part === "..");

function parseCommits(raw: unknown): Planned[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "nothing to push";
  if (raw.length > MAX_COMMITS) return `too many commits in one push (max ${MAX_COMMITS})`;
  const out: Planned[] = [];
  for (const [position, item] of raw.entries()) {
    const commit = (item && typeof item === "object" ? item : {}) as { message?: unknown; changes?: unknown; parents?: unknown };
    const message = typeof commit.message === "string" ? commit.message.trim().slice(0, 2000) : "";
    if (!message) return "every commit needs a message";
    if (!Array.isArray(commit.changes) || !Array.isArray(commit.parents) || commit.parents.length > 2) return "bad commit";
    const parents: Parent[] = [];
    for (const parent of commit.parents) {
      const p = (parent && typeof parent === "object" ? parent : {}) as { sha?: unknown; index?: unknown };
      if (typeof p.sha === "string" && SHA.test(p.sha)) parents.push({ sha: p.sha });
      else if (typeof p.index === "number" && Number.isInteger(p.index) && p.index >= 0 && p.index < position) parents.push({ index: p.index });
      else return "bad commit parent";
    }
    const changes: Change[] = [];
    for (const change of commit.changes) {
      const c = (change && typeof change === "object" ? change : {}) as { path?: unknown; content?: unknown };
      if (!validPath(c.path)) return `bad path: ${String(c.path).slice(0, 80)}`;
      if (c.content !== null && typeof c.content !== "string") return `bad contents for ${c.path}`;
      changes.push({ path: c.path, content: c.content as string | null });
    }
    out.push({ message, parents, changes });
  }
  return out;
}

/**
 * GitHub's Git Data API refuses to work in an empty repository. Create one
 * placeholder commit with the Contents API so it is no longer empty; the
 * caller then builds its own root commit and moves the branch over the
 * placeholder it just made (the only commit in the repo).
 */
async function bootstrapEmpty(gh: Gh, repo: string): Promise<{ ok: true; branch: string; sha: string } | { ok: false; error: string }> {
  const info = await gh<{ default_branch: string }>(`/repos/${repo}`);
  if (!info.ok) return { ok: false, error: info.error };
  const made = await gh<{ commit: { sha: string } }>(`/repos/${repo}/contents/.toolneuron-bootstrap`, {
    method: "PUT",
    body: { message: "Placeholder so the repo is not empty (replaced by ToolNeuron's first push)", content: Buffer.from("placeholder\n").toString("base64") },
  });
  if (!made.ok) return { ok: false, error: made.error };
  return { ok: true, branch: info.data.default_branch, sha: made.data.commit.sha };
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
  let body: { repo?: unknown; branch?: unknown; expectSha?: unknown; commits?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "Bad request." }, 400);
  }
  const repo = typeof body.repo === "string" ? parseRepo(body.repo) : null;
  if (!repo) return json({ ok: false, error: "Bad repo." }, 400);
  const branch = typeof body.branch === "string" && BRANCH_NAME.test(body.branch) ? body.branch : null;
  if (!branch) return json({ ok: false, error: "Bad branch name." }, 400);
  const expectSha = typeof body.expectSha === "string" && SHA.test(body.expectSha) ? body.expectSha : null;
  const commits = parseCommits(body.commits);
  if (typeof commits === "string") return json({ ok: false, error: commits });

  // Where is the remote branch now?
  const ref = await gh<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${branch}`);
  let exists = ref.ok;
  let placeholder: { branch: string; sha: string } | null = null;
  if (!ref.ok && ref.status === 409) {
    // Empty repository.
    if (expectSha) return json({ ok: false, error: `${repo} is empty on GitHub, but this project expected commits there.` });
    const boot = await bootstrapEmpty(gh, repo);
    if (!boot.ok) return json({ ok: false, error: boot.error });
    placeholder = boot;
    exists = boot.branch === branch;
  } else if (!ref.ok && ref.status !== 404) {
    return json({ ok: false, error: ref.error });
  }
  if (ref.ok && !expectSha) {
    return json({ ok: false, error: `${repo} already has a '${branch}' branch that shares no history with this project. Clone the repo (with GITHUB_TOKEN set) and work in that copy, or push to a new branch.` });
  }
  if (ref.ok && ref.data.object.sha !== expectSha) {
    return json({ ok: false, error: `Rejected: ${repo} '${branch}' has commits this project does not have (not a fast-forward). Run git pull first. Nothing was changed.` });
  }

  // Trees of parents already on GitHub, and their file modes (so executables stay executable).
  const treeOfSha = new Map<string, string>();
  const modes = new Map<string, string>();
  const treeFor = async (sha: string): Promise<string | { error: string }> => {
    const known = treeOfSha.get(sha);
    if (known) return known;
    const found = await gh<{ tree: { sha: string } }>(`/repos/${repo}/git/commits/${sha}`);
    if (!found.ok) return { error: found.error };
    treeOfSha.set(sha, found.data.tree.sha);
    if (modes.size === 0) {
      const listing = await gh<{ tree: { path: string; mode: string; type: string }[] }>(`/repos/${repo}/git/trees/${found.data.tree.sha}?recursive=1`);
      if (listing.ok) for (const entry of listing.data.tree) if (entry.type === "blob") modes.set(entry.path, entry.mode);
    }
    return found.data.tree.sha;
  };

  const shas: string[] = [];
  const trees: string[] = [];
  const partial = () => (shas.length ? ` (after ${shas.length} commit(s); the branch was not moved)` : "");
  for (const commit of commits) {
    const parentShas = commit.parents.map((parent) => ("sha" in parent ? parent.sha : shas[parent.index]));
    let baseTree: string | undefined;
    const first = commit.parents[0];
    if (first) {
      if ("sha" in first) {
        const tree = await treeFor(first.sha);
        if (typeof tree !== "string") return json({ ok: false, error: tree.error + partial() });
        baseTree = tree;
      } else baseTree = trees[first.index];
    }
    let tree = baseTree;
    if (commit.changes.length > 0 || !tree) {
      const entries = commit.changes.map((change) =>
        change.content === null
          ? { path: change.path, mode: modes.get(change.path) ?? "100644", type: "blob", sha: null }
          : { path: change.path, mode: modes.get(change.path) ?? "100644", type: "blob", content: change.content },
      );
      const made = await gh<{ sha: string }>(`/repos/${repo}/git/trees`, { method: "POST", body: { ...(tree ? { base_tree: tree } : {}), tree: entries } });
      if (!made.ok) return json({ ok: false, error: made.error + partial() });
      tree = made.data.sha;
    }
    const created = await gh<{ sha: string }>(`/repos/${repo}/git/commits`, { method: "POST", body: { message: commit.message, tree, parents: parentShas } });
    if (!created.ok) return json({ ok: false, error: created.error + partial() });
    shas.push(created.data.sha);
    trees.push(tree!);
  }
  const tip = shas[shas.length - 1];

  // Move the branch: fast-forward only, except over our own placeholder in a repo that was empty.
  const overPlaceholder = (name: string) => placeholder !== null && placeholder.branch === name;
  const moved = exists
    ? await gh(`/repos/${repo}/git/refs/heads/${branch}`, { method: "PATCH", body: { sha: tip, force: overPlaceholder(branch) } })
    : await gh(`/repos/${repo}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: tip } });
  if (!moved.ok) return json({ ok: false, error: `${moved.error} (the commits were made but the branch was not moved)` });
  if (placeholder && placeholder.branch !== branch) {
    // The repo's default branch holds only the placeholder; point it at the pushed work too.
    await gh(`/repos/${repo}/git/refs/heads/${placeholder.branch}`, { method: "PATCH", body: { sha: tip, force: true } });
  }
  return json({ ok: true, shas, url: `https://github.com/${repo}/tree/${branch}`, created: !exists, bootstrapped: Boolean(placeholder) });
}

export const Route = createFileRoute("/api/git/push")({
  server: {
    handlers: {
      POST: ({ request }) => handle(request),
    },
  },
});
