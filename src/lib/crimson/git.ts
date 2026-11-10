/**
 * Real version history for the project, kept in the browser.
 *
 * Works like git's object model, reduced to one branch: file contents are
 * stored once as blobs (keyed by a content hash), a tree maps project paths
 * to blobs, the index is the tree that the next commit will record, and each
 * commit records its tree. So status, diff, log and restore compare real
 * contents. There is no remote: nothing here talks to GitHub.
 *
 * Pure functions: every change returns a new GitState.
 */
import type { GitCommit as Commit, GitState, GitTree as Tree, ProjectFile } from "./types.ts";

export type { Commit, GitState, Tree };

export const MAX_COMMITS = 50;
/** Larger files are diffed as "changed" instead of line by line. */
const DIFF_CELL_LIMIT = 2_000_000;
const DIFF_MAX_LINES = 400;

export const EMPTY_GIT: GitState = { initialized: false, branch: "main", staged: [], commits: [], index: {}, blobs: {} };

/** Fills fields that older saves lack. */
export function normalizeGit(raw: unknown): GitState {
  const git = (raw && typeof raw === "object" ? raw : {}) as Partial<GitState>;
  const commits = Array.isArray(git.commits) ? git.commits.filter((c) => c && typeof c.id === "string") : [];
  const head = commits.find((commit) => commit.tree);
  return {
    initialized: Boolean(git.initialized),
    branch: typeof git.branch === "string" && git.branch ? git.branch : "main",
    staged: [],
    commits,
    index: git.index && typeof git.index === "object" ? git.index : { ...(head?.tree ?? {}) },
    blobs: git.blobs && typeof git.blobs === "object" ? git.blobs : {},
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

export function headCommit(git: GitState): Commit | undefined {
  return git.commits[0];
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
  const id = hash(`${parent ?? ""}\n${time}\n${message}\n${JSON.stringify(index)}`).slice(0, 7);
  const commits = [{ id, message, time, parent, tree: { ...index } }, ...git.commits].slice(0, MAX_COMMITS);
  return collect({ ...git, commits });
}

/** Drops blobs nothing refers to any more (after old commits fall off the end). */
export function collect(git: GitState): GitState {
  const used = new Set<string>([...Object.values(git.index ?? {}), ...git.commits.flatMap((commit) => Object.values(commit.tree ?? {}))]);
  const blobs = Object.fromEntries(Object.entries(git.blobs ?? {}).filter(([id]) => used.has(id)));
  return { ...git, blobs };
}

/** A commit by id or unique id prefix (at least 4 chars), or HEAD / HEAD~n. */
export function findCommit(git: GitState, ref: string): Commit | undefined {
  const back = ref.match(/^HEAD(?:~(\d+))?$/i);
  if (back) return git.commits[Number(back[1] ?? 0)];
  if (ref.length < 4) return undefined;
  const matches = git.commits.filter((commit) => commit.id.startsWith(ref));
  return matches.length === 1 ? matches[0] : undefined;
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
