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
import type { GitCommit as Commit, GitRemote as Remote, GitState, GitTree as Tree, ProjectFile } from "./types.ts";

export type { Commit, GitState, Remote, Tree };

export const MAX_COMMITS = 50;
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
  const remote =
    git.remote && typeof git.remote.repo === "string"
      ? { ...git.remote, dir: git.remote.dir ?? "", track: git.remote.track ?? {}, shas: git.remote.shas ?? {} }
      : undefined;
  return {
    initialized: Boolean(git.initialized),
    branch,
    staged: [],
    commits,
    index: git.index && typeof git.index === "object" ? git.index : { ...(head?.tree ?? {}) },
    blobs: git.blobs && typeof git.blobs === "object" ? git.blobs : {},
    branches,
    ...(remote ? { remote } : {}),
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

/** Commits from `from` back through parents, newest first (stops where history was trimmed). */
export function history(git: GitState, from: string | undefined = headCommit(git)?.id): Commit[] {
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
  return { git: { ...git, index, blobs }, added, missing };
}

/** Records the index as a new commit. Returns null when nothing is staged. */
export function commit(git: GitState, message: string, time: string): GitState | null {
  const index = git.index ?? {};
  if (compareTrees(headTree(git), index).length === 0) return null;
  const parent = headCommit(git)?.id;
  const id = hash(`${parent ?? ""}\n${time}\n${message}\n${JSON.stringify(index)}\n${git.commits.length}`).slice(0, 7);
  const branches = { ...(git.branches ?? {}), [git.branch]: id };
  return trim({ ...git, branches, commits: [{ id, message, time, parent, tree: { ...index } }, ...git.commits] });
}

/** Keeps the newest MAX_COMMITS commits plus every branch head, then drops unused blobs. */
function trim(git: GitState): GitState {
  const heads = new Set(Object.values(git.branches ?? {}).filter((id): id is string => Boolean(id)));
  const commits = git.commits.filter((commit, index) => index < MAX_COMMITS || heads.has(commit.id));
  return collect({ ...git, commits });
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
  if (start !== undefined || /^HEAD$/i.test(base)) return history(git, start)[steps];
  if (base.length < 4) return undefined;
  const matches = git.commits.filter((commit) => commit.id.startsWith(base));
  return matches.length === 1 ? history(git, matches[0].id)[steps] : undefined;
}

// ---------- branches ----------

export const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/$)[A-Za-z0-9._/-]{1,60}$/;

/** A file change to apply to the project: new contents, or null to delete. */
export type FileChange = { path: string; content: string | null };

/** What the working files must become to go from tree `from` to tree `to`. */
export function treeChanges(git: GitState, from: Tree, to: Tree): FileChange[] {
  return compareTrees(from, to).map((change) => ({ path: change.path, content: change.kind === "deleted" ? null : (blob(git, to[change.path]) ?? "") }));
}

/** Uncommitted work that switching or merging would overwrite: staged changes and edits to tracked files. */
export function dirty(git: GitState, work: Record<string, string>): string[] {
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
  return { git: { ...git, branch: name, index: { ...target } }, changes: treeChanges(git, headTree(git), target) };
}

/** Fast-forward merge of `name` into the current branch (the only kind available). */
export function mergeBranch(git: GitState, work: Record<string, string>, name: string): { git: GitState; changes: FileChange[]; note: string } | string {
  const branches = git.branches ?? {};
  if (!(name in branches)) return `branch '${name}' not found`;
  const ours = headCommit(git)?.id;
  const theirs = branches[name];
  if (isAncestor(git, theirs, ours)) return { git, changes: [], note: "Already up to date." };
  if (!isAncestor(git, ours, theirs)) return `${git.branch} and ${name} have diverged; only fast-forward merges are available (no merge commits or conflict resolution)`;
  const pending = dirty(git, work);
  if (pending.length) return `commit or restore your changes first: ${pending.slice(0, 5).join(", ")}`;
  const target = byId(git, theirs)?.tree ?? {};
  return {
    git: { ...git, branches: { ...branches, [git.branch]: theirs }, index: { ...target } },
    changes: treeChanges(git, headTree(git), target),
    note: `Fast-forward ${ours ?? "(empty)"}..${theirs}`,
  };
}

// ---------- remote (GitHub) ----------

/** Paths under `dir`, made relative to it ("" = the whole tree). */
export function subtree(tree: Tree, dir: string): Tree {
  if (!dir) return { ...tree };
  const prefix = `${dir}/`;
  return Object.fromEntries(Object.entries(tree).filter(([path]) => path.startsWith(prefix)).map(([path, id]) => [path.slice(prefix.length), id]));
}

export function setRemote(git: GitState, repo: string, dir: string, track: Record<string, string> = {}, shas: Record<string, string> = {}): GitState {
  return { ...git, remote: { repo, dir: dir.replace(/^\/+|\/+$/g, ""), track, shas } };
}

export function removeRemote(git: GitState): GitState {
  const next = { ...git };
  delete next.remote;
  return next;
}

export type PushPlan = {
  repo: string;
  /** Remote branch to update. */
  branch: string;
  /**
   * GitHub sha the new commits build on: the newest commit of this branch
   * already on GitHub. The server only fast-forwards: the remote branch must
   * be at this sha, or not exist yet. null = no commit of this branch is on
   * GitHub (the remote branch must not exist).
   */
  parentSha: string | null;
  /** Unpushed local commits, oldest first, as changes under the remote's folder. */
  commits: { id: string; message: string; changes: FileChange[] }[];
};

/** What `git push` must send: every commit on the current branch after the newest one already on GitHub. */
export function pushPlan(git: GitState): PushPlan | string {
  const remote = git.remote;
  if (!remote) return "no remote. git remote add origin owner/name [folder] (or clone a repo while GITHUB_TOKEN is set)";
  const line = history(git);
  if (line.length === 0) return "nothing to push: no commits yet";
  const knownIndex = line.findIndex((commit) => remote.shas[commit.id]);
  const branch = remote.track[git.branch] ?? git.branch;
  if (knownIndex === 0) return `Everything up-to-date (${remote.repo} ${branch})`;
  const pending = (knownIndex === -1 ? line : line.slice(0, knownIndex)).reverse();
  const base = knownIndex === -1 ? undefined : line[knownIndex];
  const parentSha = base ? remote.shas[base.id] : null;
  let previous = subtree(base?.tree ?? {}, remote.dir);
  const commits = pending.map((commit) => {
    const tree = subtree(commit.tree ?? {}, remote.dir);
    const changes = treeChanges(git, previous, tree);
    previous = tree;
    return { id: commit.id, message: commit.message, changes };
  });
  return { repo: remote.repo, branch, parentSha, commits };
}

/** Records the GitHub shas a push created. */
export function markPushed(git: GitState, localIds: string[], shas: string[], remoteBranch: string): GitState {
  if (!git.remote) return git;
  const known = { ...git.remote.shas };
  localIds.forEach((id, index) => {
    if (shas[index]) known[id] = shas[index];
  });
  return { ...git, remote: { ...git.remote, shas: known, track: { ...git.remote.track, [git.branch]: remoteBranch } } };
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
