/**
 * Real version history for the project, kept in the browser.
 *
 * Works like git's object model: file contents are stored once as blobs
 * (keyed by a content hash), a tree maps project paths to blobs, the index is
 * the tree that the next commit will record, each commit records its tree and
 * parent, and branches point at commits. So status, diff, log, restore,
 * switch and merge compare real contents.
 *
 * Nothing here talks to GitHub: pushPlan() works out what a push must send,
 * and the server (/api/git/push) sends it.
 *
 * Pure functions: every change returns a new GitState.
 */
import type { GitCommit as Commit, GitMerging as Merging, GitRemote as Remote, GitState, GitTree as Tree, ProjectFile } from "./types.ts";

export type { Commit, GitState, Merging, Remote, Tree };

/** Larger files are diffed as "changed" instead of line by line. */
const DIFF_CELL_LIMIT = 2_000_000;
const DIFF_MAX_LINES = 400;

export const EMPTY_GIT: GitState = { initialized: false, branch: "main", staged: [], commits: [], index: {}, blobs: {}, branches: { main: undefined } };

/** Fills fields that older saves lack. */
export function normalizeGit(raw: unknown): GitState {
  const git = (raw && typeof raw === "object" ? raw : {}) as Partial<GitState>;
  const commits = Array.isArray(git.commits) ? git.commits.filter((c) => c && typeof c.id === "string") : [];
  const branch = typeof git.branch === "string" && git.branch ? git.branch : "main";
  // Saves from before branches existed: the one branch points at the newest commit.
  const branches = git.branches && typeof git.branches === "object" ? { ...git.branches } : { [branch]: commits[0]?.id };
  if (!(branch in branches)) branches[branch] = undefined;
  const head = commits.find((commit) => commit.id === branches[branch]);
  let remote =
    git.remote && typeof git.remote.repo === "string"
      ? { ...git.remote, dir: git.remote.dir ?? "", track: git.remote.track ?? {}, shas: git.remote.shas ?? {} }
      : undefined;
  if (remote && !remote.tips) {
    // Saves from before tips were tracked: the best guess is the newest GitHub commit each tracked branch reaches.
    const tips: Record<string, string> = {};
    const partial = { ...(git as GitState), commits, branches, remote } as GitState;
    for (const [local, remoteBranch] of Object.entries(remote.track)) {
      const found = history(partial, branches[local]).find((commit) => remote!.shas[commit.id]);
      if (found) tips[remoteBranch] = remote.shas[found.id];
    }
    remote = { ...remote, tips };
  }
  return {
    initialized: Boolean(git.initialized),
    branch,
    staged: [],
    commits,
    index: git.index && typeof git.index === "object" ? git.index : { ...(head?.tree ?? {}) },
    blobs: git.blobs && typeof git.blobs === "object" ? git.blobs : {},
    branches,
    ...(remote ? { remote } : {}),
    ...(git.merging && typeof git.merging.theirs === "string" ? { merging: git.merging } : {}),
  };
}

/** 53-bit content hash (cyrb53), as 14 hex chars. Not cryptographic; collisions are vanishingly rare at this size. */
export function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** The project-relative path of a file ("src/main.py"); the single top folder is the project itself. */
export function pathOf(file: ProjectFile, files: ProjectFile[]): string {
  const byId = new Map(files.map((item) => [item.id, item]));
  const roots = files.filter((item) => item.parentId === null);
  const projectRoot = roots.length === 1 && roots[0].type === "folder" ? roots[0].id : null;
  const parts: string[] = [];
  let node: ProjectFile | undefined = file;
  const seen = new Set<string>();
  while (node && node.id !== projectRoot && !seen.has(node.id)) {
    seen.add(node.id);
    parts.unshift(node.name);
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
  return parts.join("/");
}

/** Path → contents of every file in the project. `live` overrides one file's contents (the open editor draft). */
export function workingFiles(files: ProjectFile[], live?: { id: string; content: string }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of files) {
    if (file.type !== "file") continue;
    out[pathOf(file, files)] = live && live.id === file.id ? live.content : (file.content ?? "");
  }
  return out;
}

function byId(git: GitState, id: string | undefined): Commit | undefined {
  return id === undefined ? undefined : git.commits.find((commit) => commit.id === id);
}

/** The current branch's head commit. */
export function headCommit(git: GitState): Commit | undefined {
  const branches = git.branches ?? { [git.branch]: git.commits[0]?.id };
  return byId(git, branches[git.branch]);
}

/** Every commit reachable from `from` through both parents, newest first (stops where history was trimmed). */
export function history(git: GitState, from: string | undefined = headCommit(git)?.id): Commit[] {
  const order = new Map(git.commits.map((commit, index) => [commit.id, index]));
  const out: Commit[] = [];
  const seen = new Set<string>();
  const stack = from ? [from] : [];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const commit = byId(git, id);
    if (!commit) continue;
    out.push(commit);
    if (commit.parent) stack.push(commit.parent);
    if (commit.parent2) stack.push(commit.parent2);
  }
  // Commits are stored newest first, and a commit is always stored after its parents exist.
  return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** The first-parent line from `from` (what HEAD~n walks). */
export function firstParents(git: GitState, from: string | undefined): Commit[] {
  const out: Commit[] = [];
  const seen = new Set<string>();
  let commit = byId(git, from);
  while (commit && !seen.has(commit.id)) {
    seen.add(commit.id);
    out.push(commit);
    commit = byId(git, commit.parent);
  }
  return out;
}

/** The newest commit both `a` and `b` reach: where their histories split. */
export function mergeBase(git: GitState, a: string | undefined, b: string | undefined): Commit | undefined {
  const reach = new Set(history(git, b).map((commit) => commit.id));
  return history(git, a).find((commit) => reach.has(commit.id));
}

/** True when commit `ancestor` is `of` or one of its parents. */
export function isAncestor(git: GitState, ancestor: string | undefined, of: string | undefined): boolean {
  if (ancestor === undefined) return true;
  return history(git, of).some((commit) => commit.id === ancestor);
}

export function headTree(git: GitState): Tree {
  return headCommit(git)?.tree ?? {};
}

export type Change = { path: string; kind: "added" | "modified" | "deleted" };

/** Changes from tree `from` to tree `to`. */
export function compareTrees(from: Tree, to: Tree): Change[] {
  const out: Change[] = [];
  for (const path of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (!(path in from)) out.push({ path, kind: "added" });
    else if (!(path in to)) out.push({ path, kind: "deleted" });
    else if (from[path] !== to[path]) out.push({ path, kind: "modified" });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function treeOf(work: Record<string, string>): Tree {
  return Object.fromEntries(Object.entries(work).map(([path, content]) => [path, hash(content)]));
}

export type Status = {
  /** Index vs last commit: what `git commit` would record. */
  staged: Change[];
  /** Working files vs index, for paths the index tracks. */
  unstaged: Change[];
  /** Working files the index does not track. */
  untracked: string[];
};

export function status(git: GitState, work: Record<string, string>): Status {
  const index = git.index ?? {};
  const workTree = treeOf(work);
  const unstagedAll = compareTrees(index, workTree);
  return {
    staged: compareTrees(headTree(git), index),
    unstaged: unstagedAll.filter((change) => change.kind !== "added"),
    untracked: unstagedAll.filter((change) => change.kind === "added").map((change) => change.path),
  };
}

export function init(git: GitState): GitState {
  return { ...normalizeGit(git), initialized: true };
}

/**
 * Stages paths. "." stages everything, including deletions. A path that is
 * gone from the working files is staged as a deletion.
 */
export function add(git: GitState, work: Record<string, string>, paths: string[]): { git: GitState; added: string[]; missing: string[] } {
  const index = { ...(git.index ?? {}) };
  const blobs = { ...(git.blobs ?? {}) };
  const added: string[] = [];
  const missing: string[] = [];
  const all = paths.includes(".");
  const targets = all ? [...new Set([...Object.keys(work), ...Object.keys(index)])] : paths;
  for (const path of targets) {
    if (path in work) {
      const id = hash(work[path]);
      blobs[id] = work[path];
      if (index[path] !== id) added.push(path);
      index[path] = id;
    } else if (path in index) {
      delete index[path];
      added.push(path);
    } else missing.push(path);
  }
  const merging = git.merging ? { ...git.merging, unresolved: git.merging.unresolved.filter((path) => !(all || targets.includes(path))) } : undefined;
  return { git: { ...git, index, blobs, ...(merging ? { merging } : {}) }, added, missing };
}

/**
 * Records the index as a new commit. Returns null when nothing is staged.
 * While merging (see mergeBlockers), it records the merge commit, with the
 * merged-in commit as second parent, even if the tree did not change.
 */
export function commit(git: GitState, message: string, time: string): GitState | null {
  const index = git.index ?? {};
  const merging = git.merging;
  if (!merging && compareTrees(headTree(git), index).length === 0) return null;
  const parent = headCommit(git)?.id;
  const id = hash(`${parent ?? ""}\n${merging?.theirs ?? ""}\n${time}\n${message}\n${JSON.stringify(index)}\n${git.commits.length}`).slice(0, 7);
  const branches = { ...(git.branches ?? {}), [git.branch]: id };
  const made: Commit = { id, message, time, parent, ...(merging ? { parent2: merging.theirs } : {}), tree: { ...index } };
  const next = { ...git, branches, commits: [made, ...git.commits] };
  delete next.merging;
  return trim(next);
}

/** Why a merge cannot be committed yet ([] when it can, or when not merging). */
export function mergeBlockers(git: GitState): string[] {
  const merging = git.merging;
  if (!merging) return [];
  const out = merging.unresolved.map((path) => `${path}: still conflicted (fix it, then git add ${path})`);
  for (const path of merging.conflicts) {
    const staged = blob(git, git.index?.[path]);
    if (staged !== undefined && /^(<{7}|>{7}) /m.test(staged)) out.push(`${path}: the staged version still has conflict markers`);
  }
  return out;
}

/**
 * Commits exactly `files` (path → contents) on top of the last commit,
 * leaving anything else that is staged staged (used for a linked clone).
 * Refuses during a merge.
 */
export function commitFiles(git: GitState, files: Record<string, string>, message: string, time: string): GitState | string {
  if (git.merging) return "a merge is in progress";
  const added: Tree = {};
  const blobs = { ...(git.blobs ?? {}) };
  for (const [path, content] of Object.entries(files)) {
    const id = hash(content);
    blobs[id] = content;
    added[path] = id;
  }
  const parent = headCommit(git)?.id;
  const tree = { ...headTree(git), ...added };
  const id = hash(`${parent ?? ""}\n${time}\n${message}\n${JSON.stringify(tree)}\n${git.commits.length}`).slice(0, 7);
  const made: Commit = { id, message, time, parent, tree };
  return trim({ ...git, blobs, index: { ...(git.index ?? {}), ...added }, branches: { ...(git.branches ?? {}), [git.branch]: id }, commits: [made, ...git.commits] });
}

/**
 * Drops only commits nothing can reach (from a branch, a merge in progress,
 * or a commit GitHub's branches were last seen at), then the blobs nothing
 * refers to. Reachable history is never dropped: an incomplete history
 * makes merges and pushes wrong (see historyComplete). History lives in
 * IndexedDB (git-store.ts), so there is no fixed commit cap.
 */
function trim(git: GitState): GitState {
  const roots = new Set(Object.values(git.branches ?? {}).filter((id): id is string => Boolean(id)));
  if (git.merging) roots.add(git.merging.theirs);
  for (const sha of Object.values(git.remote?.tips ?? {})) {
    const id = Object.entries(git.remote?.shas ?? {}).find(([, known]) => known === sha)?.[0];
    if (id) roots.add(id);
  }
  const keep = new Set<string>();
  for (const root of roots) for (const commit of history(git, root)) keep.add(commit.id);
  const commits = git.commits.filter((commit) => keep.has(commit.id));
  // Forget GitHub shas of commits that are gone.
  const remote = git.remote ? { ...git.remote, shas: Object.fromEntries(Object.entries(git.remote.shas).filter(([id]) => keep.has(id))) } : undefined;
  return collect({ ...git, commits, ...(remote ? { remote } : {}) });
}

/** Drops blobs nothing refers to any more (after old commits fall off the end). */
export function collect(git: GitState): GitState {
  const used = new Set<string>([...Object.values(git.index ?? {}), ...git.commits.flatMap((commit) => Object.values(commit.tree ?? {}))]);
  const blobs = Object.fromEntries(Object.entries(git.blobs ?? {}).filter(([id]) => used.has(id)));
  return { ...git, blobs };
}

/** A commit by id or unique id prefix (at least 4 chars), a branch name, or HEAD / HEAD~n / <branch>~n. */
export function findCommit(git: GitState, ref: string): Commit | undefined {
  const back = ref.match(/^(.+?)(?:~(\d+))?$/);
  const base = back?.[1] ?? ref;
  const steps = Number(back?.[2] ?? 0);
  const start = /^HEAD$/i.test(base) ? headCommit(git)?.id : git.branches && base in git.branches ? git.branches[base] : undefined;
  if (start !== undefined || /^HEAD$/i.test(base)) return firstParents(git, start)[steps];
  if (base.length < 4) return undefined;
  const matches = git.commits.filter((commit) => commit.id.startsWith(base));
  return matches.length === 1 ? firstParents(git, matches[0].id)[steps] : undefined;
}

// ---------- branches ----------

export const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/$)[A-Za-z0-9._/-]{1,60}$/;

/** A file change to apply to the project: new contents, or null to delete. */
export type FileChange = { path: string; content: string | null };

/** What the working files must become to go from tree `from` to tree `to`. */
export function treeChanges(git: GitState, from: Tree, to: Tree): FileChange[] {
  return compareTrees(from, to).map((change) => ({ path: change.path, content: change.kind === "deleted" ? null : (blob(git, to[change.path]) ?? "") }));
}

/**
 * Untracked working files an operation would overwrite or delete: the path
 * exists in the working files, the index does not track it, and the
 * operation would leave different contents there (identical contents are
 * simply adopted, as git does). Real git refuses in this case too.
 */
export function untrackedCollisions(git: GitState, work: Record<string, string>, changes: FileChange[]): string[] {
  const index = git.index ?? {};
  return changes.filter((change) => change.path in work && !(change.path in index) && change.content !== work[change.path]).map((change) => change.path);
}

function collisionError(paths: string[]): string {
  return `untracked file(s) would be overwritten: ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ", …" : ""}. Add and commit them, or move them away, first`;
}

/** Uncommitted work that switching or merging would overwrite: staged changes and edits to tracked files. */
export function dirty(git: GitState, work: Record<string, string>): string[] {
  if (git.merging) return ["(a merge is in progress: commit it or git merge --abort)"];
  const state = status(git, work);
  return [...state.staged, ...state.unstaged].map((change) => change.path);
}

export function createBranch(git: GitState, name: string): GitState | string {
  if (!BRANCH_NAME.test(name)) return `'${name}' is not a valid branch name`;
  const branches = git.branches ?? {};
  if (name in branches) return `a branch named '${name}' already exists`;
  return { ...git, branches: { ...branches, [name]: headCommit(git)?.id } };
}

export function deleteBranch(git: GitState, name: string, force: boolean): GitState | string {
  const branches = { ...(git.branches ?? {}) };
  if (!(name in branches)) return `branch '${name}' not found`;
  if (name === git.branch) return `cannot delete '${name}': it is the current branch`;
  if (!force && !isAncestor(git, branches[name], headCommit(git)?.id)) return `'${name}' has commits not on ${git.branch}; use git branch -D to delete it anyway`;
  delete branches[name];
  const track = { ...(git.remote?.track ?? {}) };
  delete track[name];
  return trim({ ...git, branches, ...(git.remote ? { remote: { ...git.remote, track } } : {}) });
}

/**
 * Switches to `name`, refusing when uncommitted work would be lost. Returns
 * the new state and the file changes to apply.
 */
export function switchBranch(git: GitState, work: Record<string, string>, name: string): { git: GitState; changes: FileChange[] } | string {
  const branches = git.branches ?? {};
  if (!(name in branches)) return `branch '${name}' not found (git branch ${name} creates it)`;
  if (name === git.branch) return `already on '${name}'`;
  const pending = dirty(git, work);
  if (pending.length) return `commit or restore your changes first: ${pending.slice(0, 5).join(", ")}${pending.length > 5 ? ", …" : ""}`;
  const target = byId(git, branches[name])?.tree ?? {};
  const changes = treeChanges(git, headTree(git), target);
  const collisions = untrackedCollisions(git, work, changes);
  if (collisions.length) return collisionError(collisions);
  return { git: { ...git, branch: name, index: { ...target } }, changes };
}

/**
 * Merges branch `name` into the current one. Fast-forwards when possible;
 * otherwise a three-way merge: a merge commit if every file merges cleanly,
 * or a merge in progress (git.merging) with conflict markers in the files.
 */
export function mergeBranch(git: GitState, work: Record<string, string>, name: string, time: string): MergeResult | string {
  const branches = git.branches ?? {};
  if (!(name in branches)) return `branch '${name}' not found`;
  if (name === git.branch) return `cannot merge '${name}' into itself`;
  return mergeInto(git, work, branches[name], `Merge branch '${name}' into ${git.branch}`, time);
}

export type MergeResult = { git: GitState; changes: FileChange[]; note: string; conflicts: string[] };

/** Merges commit `theirs` into the current branch (shared by git merge and git pull). */
export function mergeInto(git: GitState, work: Record<string, string>, theirs: string | undefined, message: string, time: string): MergeResult | string {
  const branches = git.branches ?? {};
  const ours = headCommit(git)?.id;
  if (theirs === undefined || isAncestor(git, theirs, ours)) return { git, changes: [], note: "Already up to date.", conflicts: [] };
  const pending = dirty(git, work);
  if (pending.length) return `commit or restore your changes first: ${pending.slice(0, 5).join(", ")}${pending.length > 5 ? ", …" : ""}`;
  const target = byId(git, theirs)?.tree ?? {};
  if (isAncestor(git, ours, theirs)) {
    const changes = treeChanges(git, headTree(git), target);
    const collisions = untrackedCollisions(git, work, changes);
    if (collisions.length) return collisionError(collisions);
    return {
      git: { ...git, branches: { ...branches, [git.branch]: theirs }, index: { ...target } },
      changes,
      note: `Fast-forward ${ours ?? "(empty)"}..${theirs}`,
      conflicts: [],
    };
  }
  const base = mergeBase(git, ours, theirs);
  if (!base && (!historyComplete(git, ours) || !historyComplete(git, theirs))) {
    // Without the real common ancestor every difference would look like a change from nothing.
    return "these histories share an ancestor that is no longer stored (old commits were trimmed), so they cannot be merged safely";
  }
  const merged = mergeTrees(git, base?.tree ?? {}, headTree(git), target);
  const collisions = untrackedCollisions(git, work, merged.changes);
  if (collisions.length) return collisionError(collisions);
  const blobs = { ...(git.blobs ?? {}), ...merged.blobs };
  const index = { ...merged.clean };
  const touched = merged.changes.map((change) => change.path);
  if (merged.conflicts.length === 0) {
    const committed = commit({ ...git, blobs, index, merging: { theirs, message, unresolved: [], conflicts: [], touched } }, message, time)!;
    return { git: committed, changes: merged.changes, note: `Merge made (${touched.length} file(s) from the other side).`, conflicts: [] };
  }
  return {
    git: { ...git, blobs, index, merging: { theirs, message, unresolved: [...merged.conflicts], conflicts: [...merged.conflicts], touched } },
    changes: merged.changes,
    note: `Automatic merge failed in ${merged.conflicts.length} file(s); fix the conflict markers, git add each file, then git commit (or git merge --abort).`,
    conflicts: merged.conflicts,
  };
}

/** Undoes a merge in progress: the index and the files it changed go back to the last commit. */
export function abortMerge(git: GitState): { git: GitState; changes: FileChange[] } | string {
  if (!git.merging) return "no merge in progress";
  const head = headTree(git);
  const changes = git.merging.touched.map((path) => ({ path, content: head[path] === undefined ? null : (blob(git, head[path]) ?? "") }));
  const next: GitState = { ...git, index: { ...head } };
  delete next.merging;
  return { git: collect(next), changes };
}

/**
 * Three-way merge of trees. For each path: unchanged on one side → take the
 * other; changed on both → merge the lines (merge3). `clean` is the index
 * to record (conflicted paths keep our version there until resolved);
 * `changes` are what the working files must become.
 */
export function mergeTrees(git: GitState, base: Tree, ours: Tree, theirs: Tree): { clean: Tree; changes: FileChange[]; conflicts: string[]; blobs: Record<string, string> } {
  const clean: Tree = { ...ours };
  const changes: FileChange[] = [];
  const conflicts: string[] = [];
  const blobs: Record<string, string> = {};
  const paths = [...new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])].sort();
  for (const path of paths) {
    const b = base[path];
    const o = ours[path];
    const t = theirs[path];
    if (o === t || t === b) continue; // same on both sides, or only we changed it
    if (o === b) {
      // Only they changed it.
      if (t === undefined) delete clean[path];
      else clean[path] = t;
      changes.push({ path, content: t === undefined ? null : (blob(git, t) ?? "") });
      continue;
    }
    // Both changed it.
    if (o === undefined || t === undefined) {
      // Deleted on one side, changed on the other: keep the changed text and let the user decide.
      const kept = blob(git, o ?? t) ?? "";
      const side = o === undefined ? "deleted here, changed on the other side" : "changed here, deleted on the other side";
      const text = `<<<<<<< CONFLICT: ${side}. Keep this file (remove these marker lines) or delete it, then git add.\n>>>>>>> \n${kept}`;
      const id = hash(text);
      blobs[id] = text;
      changes.push({ path, content: text });
      conflicts.push(path);
      continue;
    }
    const result = merge3(blob(git, b), blob(git, o) ?? "", blob(git, t) ?? "");
    const id = hash(result.text);
    blobs[id] = result.text;
    if (result.conflict) conflicts.push(path);
    else clean[path] = id;
    changes.push({ path, content: result.text });
  }
  return { clean, changes, conflicts, blobs };
}

type Hunk = { start: number; end: number; lines: string[] };

/** Base-line ranges each side replaced, from a line diff. */
function hunks(base: string[], other: string[]): Hunk[] | null {
  const ops = lineOps(base, other);
  if (!ops) return null;
  const out: Hunk[] = [];
  let at = 0;
  let current: Hunk | null = null;
  for (const op of ops) {
    if (op.kind === " ") {
      if (current) out.push(current);
      current = null;
      at++;
      continue;
    }
    current ??= { start: at, end: at, lines: [] };
    if (op.kind === "-") {
      current.end++;
      at++;
    } else current.lines.push(op.text);
  }
  if (current) out.push(current);
  return out;
}

/**
 * Line-level three-way merge. Changes to different parts of the file both
 * apply; overlapping changes that differ become a conflict block:
 *   <<<<<<< ours / ======= / >>>>>>> theirs
 */
export function merge3(base: string | undefined, ours: string, theirs: string): { text: string; conflict: boolean } {
  if (ours === theirs) return { text: ours, conflict: false };
  if (base === undefined) base = "";
  if (ours === base) return { text: theirs, conflict: false };
  if (theirs === base) return { text: ours, conflict: false };
  const B = base.split("\n");
  const oursHunks = hunks(B, ours.split("\n"));
  const theirsHunks = hunks(B, theirs.split("\n"));
  if (!oursHunks || !theirsHunks) {
    return { text: `<<<<<<< ours\n${ours}\n=======\n${theirs}\n>>>>>>> theirs (too large to merge line by line)`, conflict: true };
  }
  const all = [...oursHunks.map((hunk) => ({ ...hunk, side: "ours" as const })), ...theirsHunks.map((hunk) => ({ ...hunk, side: "theirs" as const }))].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  );
  const out: string[] = [];
  let conflict = false;
  let at = 0;
  let k = 0;
  while (k < all.length) {
    // A region: hunks that overlap (or insert at the same point) are resolved together.
    const region = [all[k]];
    let end = all[k].end;
    k++;
    while (k < all.length && (all[k].start < end || all[k].start === region[region.length - 1].start)) {
      region.push(all[k]);
      end = Math.max(end, all[k].end);
      k++;
    }
    const start = region[0].start;
    out.push(...B.slice(at, start));
    const rebuild = (side: "ours" | "theirs") => {
      const mine = region.filter((hunk) => hunk.side === side);
      const lines: string[] = [];
      let pos = start;
      for (const hunk of mine) {
        lines.push(...B.slice(pos, hunk.start), ...hunk.lines);
        pos = hunk.end;
      }
      lines.push(...B.slice(pos, end));
      return { lines, touched: mine.length > 0 };
    };
    const o = rebuild("ours");
    const t = rebuild("theirs");
    if (!t.touched) out.push(...o.lines);
    else if (!o.touched) out.push(...t.lines);
    else if (o.lines.join("\n") === t.lines.join("\n")) out.push(...o.lines);
    else {
      conflict = true;
      out.push("<<<<<<< ours", ...o.lines, "=======", ...t.lines, ">>>>>>> theirs");
    }
    at = end;
  }
  out.push(...B.slice(at));
  return { text: out.join("\n"), conflict };
}

// ---------- remote (GitHub) ----------

/** Paths under `dir`, made relative to it ("" = the whole tree). */
export function subtree(tree: Tree, dir: string): Tree {
  if (!dir) return { ...tree };
  const prefix = `${dir}/`;
  return Object.fromEntries(Object.entries(tree).filter(([path]) => path.startsWith(prefix)).map(([path, id]) => [path.slice(prefix.length), id]));
}

export function setRemote(
  git: GitState,
  repo: string,
  dir: string,
  track: Record<string, string> = {},
  shas: Record<string, string> = {},
  tips: Record<string, string> = {},
): GitState {
  return { ...git, remote: { repo, dir: dir.replace(/^\/+|\/+$/g, ""), track, shas, tips } };
}

export function removeRemote(git: GitState): GitState {
  const next = { ...git };
  delete next.remote;
  return next;
}

/** The GitHub branch the local branch pushes to and pulls from. */
export function remoteBranchOf(git: GitState, localBranch = git.branch): string {
  return git.remote?.track[localBranch] ?? localBranch;
}

/** The local commit recorded for a GitHub sha, if any. */
export function localIdOf(git: GitState, sha: string | undefined): string | undefined {
  if (!sha || !git.remote) return undefined;
  return Object.entries(git.remote.shas).find(([id, known]) => known === sha && byId(git, id))?.[0];
}

/** GitHub shas reachable from a commit (including its own). */
function knownReach(git: GitState, id: string | undefined): Set<string> {
  const shas = git.remote?.shas ?? {};
  return new Set(history(git, id).map((commit) => shas[commit.id]).filter((sha): sha is string => Boolean(sha)));
}

/** True when commit `from`'s history is fully stored (no parent was trimmed away). */
export function historyComplete(git: GitState, from: string | undefined): boolean {
  return history(git, from).every((commit) => (!commit.parent || byId(git, commit.parent)) && (!commit.parent2 || byId(git, commit.parent2)));
}

/** A commit's parent in a push: a sha already on GitHub, or an earlier commit of the same push (by position). */
export type PushParent = { sha: string } | { index: number };

export type PushPlan = {
  repo: string;
  /** Local branch the plan was made from (results are recorded against it). */
  localBranch: string;
  /** Remote branch to update. */
  branch: string;
  /** Where the GitHub branch must be now (null: it must not exist yet). The server never forces. */
  expectSha: string | null;
  /**
   * Unpushed commits, parents before children. `treeParent` is the index in
   * `parents` whose GitHub tree the commit is built on; `changes` are relative
   * to that parent's tree (paths relative to the remote folder). Files this
   * browser does not hold are absent from both trees, so they never appear in
   * `changes` and keep GitHub's version.
   */
  commits: { id: string; message: string; parents: PushParent[]; treeParent: number; changes: FileChange[] }[];
  /** With no commits: move the GitHub branch to this existing sha (a fast-forward). */
  moveTo?: string;
};

/**
 * Which parent of a merge commit to build its GitHub tree on: the one whose
 * known GitHub history covers the other's (after a pull-merge that is the
 * pulled commit, so files the browser does not hold come from the newest
 * GitHub state). Both cover: prefer a parent already on GitHub, else the
 * first. Neither: null (two sides each hold GitHub work the other lacks).
 */
export function treeParentOf(git: GitState, parents: string[]): number | null {
  if (parents.length < 2) return 0;
  const shas = git.remote?.shas ?? {};
  const reach = parents.map((id) => knownReach(git, id));
  const covers = (a: number, b: number) => [...reach[b]].every((sha) => reach[a].has(sha));
  const ok = parents.map((_, index) => parents.every((__, other) => other === index || covers(index, other)));
  const candidates = ok.flatMap((good, index) => (good ? [index] : []));
  if (candidates.length === 0) return null;
  return candidates.find((index) => shas[parents[index]]) ?? candidates[0];
}

/** What `git push` must send for the current branch. */
export function pushPlan(git: GitState): PushPlan | string {
  const remote = git.remote;
  if (!remote) return "no remote. git remote add origin owner/name [folder] (or clone a repo while GITHUB_TOKEN is set)";
  if (git.merging) return "a merge is in progress: fix the conflicts and git commit (or git merge --abort) before pushing";
  const head = headCommit(git);
  if (!head) return "nothing to push: no commits yet";
  const branch = remoteBranchOf(git);
  const known = (id: string | undefined) => (id ? remote.shas[id] : undefined);
  const tipSha = remote.tips?.[branch];
  if (tipSha) {
    const tipLocal = localIdOf(git, tipSha);
    if (!tipLocal) return `GitHub's ${branch} is at ${tipSha.slice(0, 7)}, which this project does not have: git pull first`;
    if (!isAncestor(git, tipLocal, head.id)) return `GitHub's ${branch} has commits this branch does not have: git pull first`;
  }
  // Unpushed = reachable without passing through a commit already on GitHub.
  const pending = new Set<string>();
  const stack = [head.id];
  while (stack.length) {
    const id = stack.pop()!;
    if (pending.has(id) || known(id)) continue;
    const commit = byId(git, id);
    if (!commit) return "part of this history was trimmed (only the newest commits are kept), so it cannot be pushed";
    pending.add(id);
    if (commit.parent) stack.push(commit.parent);
    if (commit.parent2) stack.push(commit.parent2);
  }
  const base = { repo: remote.repo, localBranch: git.branch, branch, expectSha: tipSha ?? null };
  if (pending.size === 0) {
    if (tipSha === known(head.id)) return `Everything up-to-date (${remote.repo} ${branch})`;
    return { ...base, commits: [], moveTo: known(head.id)! };
  }
  // Stored newest first, parents before children once reversed.
  const ordered = git.commits.filter((commit) => pending.has(commit.id)).reverse();
  const position = new Map(ordered.map((commit, index) => [commit.id, index]));
  const commits: PushPlan["commits"] = [];
  for (const commit of ordered) {
    const parentIds = [commit.parent, commit.parent2].filter((id): id is string => Boolean(id));
    const treeParent = treeParentOf(git, parentIds);
    if (treeParent === null) {
      return `merge ${commit.id} joins two sides that each have GitHub commits the other lacks; push one side first, or pull and merge again`;
    }
    const parents: PushParent[] = parentIds.map((id) => (known(id) ? { sha: known(id)! } : { index: position.get(id)! }));
    const before = subtree(byId(git, parentIds[treeParent])?.tree ?? {}, remote.dir);
    commits.push({ id: commit.id, message: commit.message, parents, treeParent, changes: treeChanges(git, before, subtree(commit.tree ?? {}, remote.dir)) });
  }
  return { ...base, commits };
}

/**
 * Records a push result against the branches the plan was made for (not
 * whatever is current when the reply arrives). `newTip` is set only when
 * the GitHub branch really moved.
 */
export function markPushed(git: GitState, plan: Pick<PushPlan, "repo" | "localBranch" | "branch" | "commits">, shas: string[], newTip: string | null): GitState {
  if (!git.remote || git.remote.repo !== plan.repo) return git;
  const known = { ...git.remote.shas };
  plan.commits.forEach((commit, index) => {
    if (shas[index]) known[commit.id] = shas[index];
  });
  const tips = { ...(git.remote.tips ?? {}) };
  if (newTip) tips[plan.branch] = newTip;
  return { ...git, remote: { ...git.remote, shas: known, tips, track: { ...git.remote.track, [plan.localBranch]: plan.branch } } };
}

// ---------- pull ----------

/** One path a pull brings: new text, null (deleted on GitHub), or unsupported (binary, too large, symlink…). */
export type PullChange = { path: string; content: string | null; unsupported?: boolean };

/**
 * Builds one local commit for a pull: the local tree of `baseId` (the commit
 * for GitHub's last-seen tip) plus the net changes from that tip to GitHub's
 * new tip, under the remote folder. A path GitHub now has in a form this app
 * cannot hold is dropped from the snapshot, unless this branch changed it
 * since the base, in which case the pull is refused (keeping our copy would
 * later push it over GitHub's version).
 */
export function pullSnapshot(
  git: GitState,
  baseId: string,
  tipSha: string,
  changes: PullChange[],
  message: string,
  time: string,
): { git: GitState; tip: string; dropped: string[] } | string {
  const remote = git.remote;
  const base = byId(git, baseId);
  if (!remote || !base) return "the commit GitHub was last seen at is not in local history; clone again";
  const prefix = remote.dir ? `${remote.dir}/` : "";
  const headTreeNow = headTree(git);
  const tree: Tree = { ...(base.tree ?? {}) };
  const blobs = { ...(git.blobs ?? {}) };
  const dropped: string[] = [];
  const refused: string[] = [];
  for (const change of changes) {
    const path = `${prefix}${change.path}`;
    if (change.unsupported) {
      if (!(path in tree)) continue; // not held here: GitHub keeps it as it is
      if (headTreeNow[path] !== tree[path]) refused.push(path);
      else {
        delete tree[path];
        dropped.push(path);
      }
      continue;
    }
    if (change.content === null) delete tree[path];
    else {
      const id = hash(change.content);
      blobs[id] = change.content;
      tree[path] = id;
    }
  }
  if (refused.length) {
    return `GitHub changed ${refused.slice(0, 5).join(", ")} into something this app cannot copy (binary or too large), and this branch changed it too. Resolve it on GitHub, or restore your copy (git checkout ${baseId} -- <path>), then pull`;
  }
  const id = hash(`${baseId}\n${tipSha}`);
  const made: Commit = { id, message, time, parent: baseId, tree };
  const commits = git.commits.some((commit) => commit.id === id) ? git.commits : [made, ...git.commits];
  return { git: { ...git, blobs, commits, remote: { ...remote, shas: { ...remote.shas, [id]: tipSha } } }, tip: id, dropped };
}

export function blob(git: GitState, id: string | undefined): string | undefined {
  return id === undefined ? undefined : git.blobs?.[id];
}

/** Unstages a path: the index entry goes back to the last commit's. */
export function unstage(git: GitState, path: string): GitState {
  const index = { ...(git.index ?? {}) };
  const head = headTree(git);
  if (path in head) index[path] = head[path];
  else delete index[path];
  return { ...git, index };
}

type Op = { kind: " " | "-" | "+"; text: string };

function lineOps(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  if (n * m > DIFF_CELL_LIMIT) return null;
  // LCS table, from the end, so the walk below goes forward.
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) ops.push({ kind: "-", text: a[i++] });
    else ops.push({ kind: "+", text: b[j++] });
  }
  while (i < n) ops.push({ kind: "-", text: a[i++] });
  while (j < m) ops.push({ kind: "+", text: b[j++] });
  return ops;
}

/**
 * Unified diff of one file, with 2 lines of context. `before`/`after`
 * undefined means the file does not exist on that side.
 */
export function diffText(path: string, before: string | undefined, after: string | undefined): string[] {
  if (before === after) return [];
  const header = [`diff --git a/${path} b/${path}`, before === undefined ? "new file" : after === undefined ? "deleted file" : "", `--- ${before === undefined ? "/dev/null" : `a/${path}`}`, `+++ ${after === undefined ? "/dev/null" : `b/${path}`}`].filter(Boolean);
  const a = before === undefined || before === "" ? [] : before.split("\n");
  const b = after === undefined || after === "" ? [] : after.split("\n");
  const ops = lineOps(a, b);
  if (!ops) return [...header, `(${a.length} → ${b.length} lines: too large to diff line by line)`];
  const out = [...header];
  const context = 2;
  let k = 0;
  while (k < ops.length) {
    if (ops[k].kind === " ") {
      k++;
      continue;
    }
    // One hunk: from a change back `context` lines, forward until `context` unchanged lines follow the last change.
    const start = Math.max(0, k - context);
    let end = k;
    let quiet = 0;
    while (end < ops.length && quiet <= context * 2) {
      quiet = ops[end].kind === " " ? quiet + 1 : 0;
      end++;
    }
    end = Math.min(ops.length, end - Math.max(0, quiet - context));
    const aStart = ops.slice(0, start).filter((op) => op.kind !== "+").length + 1;
    const bStart = ops.slice(0, start).filter((op) => op.kind !== "-").length + 1;
    const hunk = ops.slice(start, end);
    const aCount = hunk.filter((op) => op.kind !== "+").length;
    const bCount = hunk.filter((op) => op.kind !== "-").length;
    // Like git: an empty side starts at the line before (0 for a new file).
    out.push(`@@ -${aCount ? aStart : aStart - 1},${aCount} +${bCount ? bStart : bStart - 1},${bCount} @@`);
    for (const op of hunk) out.push(`${op.kind}${op.text}`);
    k = end;
    if (out.length > DIFF_MAX_LINES) return [...out.slice(0, DIFF_MAX_LINES), "(diff cut)"];
  }
  return out;
}

// ---------- applying changes to project files ----------

/**
 * Applies path-based changes to the project's file list: updates contents,
 * creates missing files (and their folders), deletes files. Folders left
 * empty by a delete stay. `newId` makes ids for created items.
 */
export function applyChanges(
  files: ProjectFile[],
  changes: FileChange[],
  newId: (n: number) => string,
  language: (name: string) => string,
): ProjectFile[] {
  let out = [...files];
  let made = 0;
  const roots = out.filter((item) => item.parentId === null);
  const projectRoot = roots.length === 1 && roots[0].type === "folder" ? roots[0].id : null;
  const childNamed = (parentId: string | null, name: string) => out.find((item) => item.parentId === parentId && item.name === name);
  for (const change of changes) {
    const parts = change.path.split("/");
    const name = parts.pop()!;
    let parentId: string | null = projectRoot;
    let missingFolder = false;
    for (const folder of parts) {
      let next = childNamed(parentId, folder);
      if (!next) {
        if (change.content === null) {
          missingFolder = true;
          break;
        }
        next = { id: newId(made++), name: folder, type: "folder", parentId, isOpen: false };
        out.push(next);
      }
      parentId = next.id;
    }
    if (missingFolder) continue;
    const existing = childNamed(parentId, name);
    if (change.content === null) {
      if (existing && existing.type === "file") out = out.filter((item) => item.id !== existing.id);
    } else if (existing && existing.type === "file") {
      const content = change.content;
      out = out.map((item) => (item.id === existing.id ? { ...item, content } : item));
    } else if (!existing) {
      out.push({ id: newId(made++), name, type: "file", parentId, language: language(name), content: change.content });
    }
  }
  return out;
}
