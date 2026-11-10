import * as Git from "./git.ts";
import type { GitState, ProjectFile } from "./types.ts";

export type TermEffect =
  | { type: "clear" }
  | { type: "cwd"; cwd: string }
  | { type: "ai"; prompt: string }
  /** owner/name of a public GitHub repository. */
  | { type: "clone"; repo: string }
  | { type: "run"; fileId: string; fileName: string }
  /** New git state, and file changes to apply (restore, checkout, switch, merge). */
  | { type: "git"; git: GitState; changes?: Git.FileChange[] }
  | { type: "push" };

export type TermCtx = {
  cwd: string;
  files: ProjectFile[];
  git: GitState;
  /** The open editor draft, which is newer than its file's saved content. */
  live?: { id: string; content: string };
};

const ROOT = "~/crimson-node";

export function interpret(input: string, ctx: TermCtx): { lines: string[]; effect?: TermEffect } {
  const cmd = input.trim();
  const [head, ...rest] = cmd.split(/\s+/);
  const arg = rest.join(" ").trim();

  if (cmd === "clear") return { lines: [], effect: { type: "clear" } };
  if (cmd === "help") {
    return {
      lines: [
        "Built-in commands. This is not a shell: only these run, against the project files.",
        "  help                     this list",
        "  clear                    flush the buffer",
        "  pwd / ls [path] / cd <dir>   walk the node (.. . ~ and a/b paths work)",
        "  cat <file>               read a project file (path, or a unique name)",
        "  status                   node snapshot",
        "  ai <prompt>              ask the active personality",
        "  python <file>            run real Python 3.14 (Pyodide) in the sandbox",
        "  node <file>              run JavaScript in the isolated sandbox",
        "  git ...                  real version history in this browser (git with no args for the list)",
        "  gh repo clone owner/name copy a public GitHub repo's text files into the project",
        "  echo / date / whoami",
      ],
    };
  }
  if (cmd === "pwd") return { lines: [ctx.cwd] };
  if (cmd === "whoami") return { lines: ["operator"] };
  if (cmd === "date") return { lines: [new Date().toString()] };
  if (head === "echo") return { lines: [arg] };
  if (cmd === "status") {
    const files = ctx.files.filter((file) => file.type === "file").length;
    return {
      lines: [
        "[SYSTEM] ToolNeuron node",
        `[INFO] files ${files}   git ${ctx.git.initialized ? ctx.git.branch : "uninitialized"}   staged ${ctx.git.staged.length}`,
        "[INFO] AI link is user-initiated. Nothing calls out on its own.",
      ],
    };
  }
  if (head === "ls") return { lines: listDir(arg, ctx) };
  if (head === "cd") return changeDir(arg || "~", ctx);
  if (head === "cat") {
    if (!arg) return { lines: ["[ERROR] cat needs a file name"] };
    return { lines: catFile(arg, ctx) };
  }
  if (head === "ai") {
    return {
      lines: ["NEURAL_LINK: holding for the personality…"],
      effect: { type: "ai", prompt: arg || "Read the node and suggest one useful next command." },
    };
  }
  if (head === "python" || head === "python3" || head === "node") {
    if (!arg) return { lines: [`[ERROR] ${head} needs a file name from the project`] };
    const found = findFile(arg, ctx);
    if (!found.ok) return { lines: [found.error] };
    return { lines: [`[SYSTEM] Launching ${found.file.name}`], effect: { type: "run", fileId: found.file.id, fileName: found.file.name } };
  }
  if (cmd.startsWith("gh repo clone") || (head === "git" && rest[0] === "clone")) {
    const raw = (cmd.startsWith("gh repo clone") ? cmd.replace(/^gh repo clone\s*/, "") : rest.slice(1).join(" ")).trim();
    const repo = parseRepo(raw);
    if (!repo) return { lines: ["[ERROR] clone needs a public GitHub repo: gh repo clone owner/name (or its https://github.com/... URL)"] };
    return { lines: [`Cloning ${repo} from GitHub…`], effect: { type: "clone", repo } };
  }
  if (head === "git") return git(rest, ctx);
  return { lines: [`[LOG] '${head}' is not a built-in command (this terminal is not a shell). Try help.`] };
}

/** "owner/name", "owner/name.git" or a github.com URL → "owner/name"; null if it is not one. */
export function parseRepo(raw: string): string | null {
  const text = raw.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const match = text.match(/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/);
  if (!match || match[2] === "." || match[2] === "..") return null;
  return `${match[1]}/${match[2]}`;
}

// ---------- paths ----------
// The node root holds the real project (the editor's file tree) under
// "project/".

type Node =
  | { kind: "root" }
  | { kind: "project" }
  | { kind: "stub"; path: string; children: string[]; file?: string[] }
  | { kind: "item"; item: ProjectFile };

const STUBS: Record<string, { children: string[]; file?: string[] }> = {
  vault: { children: ["(encrypted) open Hub → Vault"] },
};

/** Normalizes a target against cwd into segments below ROOT. Returns null if it climbs above the root. */
export function resolvePath(cwd: string, target: string): string[] | null {
  const base = cwd === ROOT ? [] : cwd.slice(ROOT.length + 1).split("/").filter(Boolean);
  let parts: string[];
  let start: string[];
  if (target === "~" || target === ROOT) return [];
  if (target.startsWith(`${ROOT}/`)) {
    start = [];
    parts = target.slice(ROOT.length + 1).split("/");
  } else if (target.startsWith("~/")) {
    start = [];
    parts = target.slice(2).split("/");
  } else if (target.startsWith("/")) {
    start = [];
    parts = target.slice(1).split("/");
  } else {
    start = base;
    parts = target.split("/");
  }
  const out = [...start];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out;
}

function projectChildren(parentId: string | null, ctx: TermCtx): ProjectFile[] {
  // The single top-level folder is the project itself; its children are listed under project/.
  const roots = ctx.files.filter((file) => file.parentId === null);
  if (parentId === null) {
    if (roots.length === 1 && roots[0].type === "folder") return ctx.files.filter((file) => file.parentId === roots[0].id);
    return roots;
  }
  return ctx.files.filter((file) => file.parentId === parentId);
}

function lookup(segments: string[], ctx: TermCtx): Node | null {
  if (segments.length === 0) return { kind: "root" };
  if (segments[0] !== "project") {
    const key = segments.join("/");
    const stub = STUBS[key];
    return stub ? { kind: "stub", path: key, children: stub.children, file: stub.file } : null;
  }
  let node: Node = { kind: "project" };
  for (const name of segments.slice(1)) {
    if (node.kind === "item" && node.item.type === "file") return null;
    const parentId: string | null = node.kind === "item" ? node.item.id : null;
    const next: ProjectFile | undefined = projectChildren(parentId, ctx).find((file) => file.name === name);
    if (!next) return null;
    node = { kind: "item", item: next };
  }
  return node;
}

const isDir = (node: Node) =>
  node.kind === "root" || node.kind === "project" || (node.kind === "stub" && !node.file) || (node.kind === "item" && node.item.type === "folder");

function display(segments: string[]) {
  return segments.length ? `${ROOT}/${segments.join("/")}` : ROOT;
}

function changeDir(target: string, ctx: TermCtx): { lines: string[]; effect?: TermEffect } {
  const segments = resolvePath(ctx.cwd, target.replace(/\/+$/, "") || "/");
  if (!segments) return { lines: ["[SYSTEM] Already at the node root."] };
  const node = lookup(segments, ctx);
  if (!node) return { lines: [`[ERROR] No such directory: ${target}`] };
  if (!isDir(node)) return { lines: [`[ERROR] Not a directory: ${target}`] };
  const next = display(segments);
  return { lines: [`[SYSTEM] ${next}`], effect: { type: "cwd", cwd: next } };
}

function listDir(target: string, ctx: TermCtx): string[] {
  const segments = resolvePath(ctx.cwd, target || ".");
  const node = segments ? lookup(segments, ctx) : null;
  if (!node) {
    // The cwd itself vanished (folder deleted or renamed in the editor).
    if (!target) return [`[WARN] ${ctx.cwd} no longer exists. cd ~`];
    return [`[ERROR] No such file or directory: ${target}`];
  }
  if (node.kind === "root") return ["project/", "vault/"];
  if (node.kind === "stub") return node.file ? [node.path.split("/").pop() ?? ""] : node.children;
  if (node.kind === "item" && node.item.type === "file") return [node.item.name];
  const children = projectChildren(node.kind === "item" ? node.item.id : null, ctx);
  if (children.length === 0) return ["(empty)"];
  return [...children]
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1))
    .map((file) => (file.type === "folder" ? `${file.name}/` : file.name));
}

/** A project file by path (relative to cwd or absolute); a bare name also matches if it is unique in the project. */
export function findFile(target: string, ctx: TermCtx): { ok: true; file: ProjectFile } | { ok: false; error: string } {
  const segments = resolvePath(ctx.cwd, target);
  const node = segments ? lookup(segments, ctx) : null;
  if (node?.kind === "item" && node.item.type === "file") return { ok: true, file: node.item };
  if (node && isDir(node)) return { ok: false, error: `[ERROR] ${target} is a directory` };
  if (!target.includes("/")) {
    const matches = ctx.files.filter((file) => file.type === "file" && file.name === target);
    if (matches.length === 1) return { ok: true, file: matches[0] };
    if (matches.length > 1) return { ok: false, error: `[ERROR] ${matches.length} files are named ${target}; give a path, e.g. project/src/${target}` };
  }
  return { ok: false, error: `[ERROR] ${target} is not in the project` };
}

function catFile(target: string, ctx: TermCtx): string[] {
  const segments = resolvePath(ctx.cwd, target);
  const node = segments ? lookup(segments, ctx) : null;
  if (node?.kind === "stub" && node.file) return node.file;
  const found = findFile(target, ctx);
  if (!found.ok) return [found.error];
  return (found.file.content ?? "").split("\n");
}

// ---------- git (real history, kept in the browser; see git.ts) ----------

const GIT_HELP = [
  "git init | status | add <path>|. | commit -m \"msg\"",
  "git log [-n N] | diff [--staged] [path] | show [commit]",
  "git restore [--staged] <path> | checkout <commit> -- <path>",
  "git branch [-d|-D name | name] | switch [-c] <name> | checkout [-b] <name> | merge <name>",
  "git remote [-v] | remote add origin owner/name [folder] | remote remove origin | push",
  "History lives in this browser. Merges are fast-forward only. Pull is not available.",
];

/** Turns a terminal path argument into repo paths ("src/main.py"); a folder expands to the files under it. */
function repoPaths(arg: string, ctx: TermCtx, known: string[]): string[] {
  const segments = resolvePath(ctx.cwd, arg.replace(/\/+$/, "") || ".");
  let path: string;
  if (segments && segments[0] === "project") path = segments.slice(1).join("/");
  else if (segments && segments.length === 0) path = "";
  else path = arg.replace(/^\.\//, "").replace(/^project\//, "").replace(/\/+$/, "");
  if (path === "" || path === ".") return ["."];
  const under = known.filter((item) => item.startsWith(`${path}/`));
  return under.length > 0 ? under : [path];
}

function changeLines(changes: Git.Change[], indent = "  "): string[] {
  return changes.map((change) => `${indent}${change.kind.padEnd(9)}${change.path}`);
}

/** A folder argument as a repo path ("" = the project root). */
function folderPath(arg: string, ctx: TermCtx): string {
  const segments = resolvePath(ctx.cwd, arg.replace(/\/+$/, ""));
  if (segments && segments[0] === "project") return segments.slice(1).join("/");
  if (segments && segments.length === 0) return "";
  return arg.replace(/^\.\//, "").replace(/^project\/?/, "").replace(/\/+$/, "");
}

function git(args: string[], ctx: TermCtx): { lines: string[]; effect?: TermEffect } {
  const repo = Git.normalizeGit(ctx.git);
  const sub = args[0];
  const work = () => Git.workingFiles(ctx.files, ctx.live);
  if (!sub) return { lines: GIT_HELP };
  if (sub === "init") {
    if (repo.initialized) return { lines: ["[WARN] Repository already initialized."] };
    return { lines: ["[SUCCESS] Initialized empty repository on main (history stays in this browser)."], effect: { type: "git", git: Git.init(repo) } };
  }
  if (!repo.initialized) return { lines: ["[ERROR] Not a repository. Run git init."] };

  if (sub === "status") {
    const state = Git.status(repo, work());
    const head = Git.headCommit(repo);
    const lines = [`On branch ${repo.branch}${head ? `, last commit ${head.id} ${head.message}` : ", no commits yet"}`];
    if (state.staged.length) lines.push("Changes to be committed:", ...changeLines(state.staged));
    if (state.unstaged.length) lines.push("Changes not staged (git add <path>):", ...changeLines(state.unstaged));
    if (state.untracked.length) lines.push("Untracked files (git add <path>):", ...state.untracked.map((path) => `  ${path}`));
    if (lines.length === 1) lines.push("nothing to commit, working tree clean");
    return { lines };
  }

  if (sub === "add") {
    const targets = args.slice(1).filter((arg) => arg !== "-A" && arg !== "--all");
    if (targets.length === 0 && args.length === 1) return { lines: ["[ERROR] git add <path> (or . for everything)"] };
    const current = work();
    const known = [...new Set([...Object.keys(current), ...Object.keys(repo.index ?? {})])];
    const paths = targets.length === 0 ? ["."] : targets.flatMap((arg) => repoPaths(arg, ctx, known));
    const result = Git.add(repo, current, paths);
    const lines = result.missing.map((path) => `[ERROR] pathspec '${path}' did not match any files`);
    lines.push(result.added.length ? `[SUCCESS] staged ${result.added.length} path(s): ${result.added.slice(0, 6).join(", ")}${result.added.length > 6 ? ", …" : ""}` : "[INFO] nothing new to stage");
    return { lines, effect: { type: "git", git: result.git } };
  }

  if (sub === "commit") {
    const message = args.slice(1).join(" ").replace(/^-m\s*/, "").replace(/^["']|["']$/g, "").trim();
    if (!message) return { lines: ['[ERROR] git commit -m "message"'] };
    const next = Git.commit(repo, message, new Date().toLocaleString());
    if (!next) return { lines: ["[WARN] Nothing staged. git add <path> first (git status shows what changed)."] };
    const made = next.commits[0];
    const count = Git.compareTrees(Git.headTree(repo), made.tree ?? {}).length;
    return { lines: [`[SUCCESS] [${repo.branch} ${made.id}] ${message}`, `  ${count} file(s) changed`], effect: { type: "git", git: next } };
  }

  if (sub === "log") {
    const n = Number(args[args.indexOf("-n") + 1]) || (args.find((arg) => /^-\d+$/.test(arg)) ? Number(args.find((arg) => /^-\d+$/.test(arg))!.slice(1)) : 10);
    if (repo.commits.length === 0) return { lines: ["[INFO] no commits yet"] };
    return {
      lines: repo.commits.slice(0, n).map((commit) => `${commit.id}  ${commit.time}  ${commit.message}${commit.tree ? "" : "  (no snapshot: made before history was real)"}`),
    };
  }

  if (sub === "diff") {
    const staged = args.includes("--staged") || args.includes("--cached");
    const pathArgs = args.slice(1).filter((arg) => !arg.startsWith("--"));
    const current = work();
    const index = repo.index ?? {};
    const from = staged ? Git.headTree(repo) : index;
    const changes = staged ? Git.compareTrees(from, index) : Git.status(repo, current).unstaged;
    const known = changes.map((change) => change.path);
    const wanted = pathArgs.length ? new Set(pathArgs.flatMap((arg) => repoPaths(arg, ctx, known))) : null;
    const lines: string[] = [];
    for (const change of changes) {
      if (wanted && !wanted.has(".") && !wanted.has(change.path)) continue;
      const before = Git.blob(repo, from[change.path]);
      const after = staged ? Git.blob(repo, index[change.path]) : current[change.path];
      lines.push(...Git.diffText(change.path, before, after));
    }
    return { lines: lines.length ? lines : [staged ? "[INFO] nothing staged" : "[INFO] no unstaged changes (try git diff --staged)"] };
  }

  if (sub === "show") {
    const commit = Git.findCommit(repo, args[1] ?? "HEAD");
    if (!commit) return { lines: [`[ERROR] unknown commit '${args[1] ?? "HEAD"}'`] };
    const lines = [`commit ${commit.id}`, `Date:   ${commit.time}`, "", `    ${commit.message}`, ""];
    if (!commit.tree) return { lines: [...lines, "(no snapshot: made before history was real)"] };
    const parent = commit.parent ? repo.commits.find((item) => item.id === commit.parent)?.tree ?? {} : {};
    for (const change of Git.compareTrees(parent, commit.tree)) {
      lines.push(...Git.diffText(change.path, Git.blob(repo, parent[change.path]), Git.blob(repo, commit.tree[change.path])));
    }
    return { lines };
  }

  if (sub === "restore") {
    const staged = args.includes("--staged");
    const targets = args.slice(1).filter((arg) => !arg.startsWith("--"));
    if (targets.length === 0) return { lines: ["[ERROR] git restore [--staged] <path>"] };
    const index = repo.index ?? {};
    const known = [...new Set([...Object.keys(work()), ...Object.keys(index), ...Object.keys(Git.headTree(repo))])];
    const paths = targets.flatMap((arg) => repoPaths(arg, ctx, known)).flatMap((path) => (path === "." ? known : [path]));
    if (staged) {
      const next = paths.reduce((state, path) => Git.unstage(state, path), repo);
      return { lines: [`[SUCCESS] unstaged ${paths.length} path(s)`], effect: { type: "git", git: next } };
    }
    return writeBack(repo, repo, paths, index, ctx, "restored from the index");
  }

  if (sub === "branch") {
    const flag = args[1];
    const branches = repo.branches ?? {};
    if (!flag) return { lines: Object.keys(branches).sort().map((name) => `${name === repo.branch ? "*" : " "} ${name}${branches[name] ? `  ${branches[name]}` : "  (no commits)"}`) };
    if (flag === "-d" || flag === "-D") {
      const result = Git.deleteBranch(repo, args[2] ?? "", flag === "-D");
      return typeof result === "string" ? { lines: [`[ERROR] ${result}`] } : { lines: [`[SUCCESS] Deleted branch ${args[2]}`], effect: { type: "git", git: result } };
    }
    const result = Git.createBranch(repo, flag);
    return typeof result === "string" ? { lines: [`[ERROR] ${result}`] } : { lines: [`[SUCCESS] Created branch ${flag} at ${Git.headCommit(repo)?.id ?? "(no commits)"}`], effect: { type: "git", git: result } };
  }

  if (sub === "switch" || (sub === "checkout" && !args.includes("--"))) {
    const create = args[1] === "-c" || args[1] === "-b";
    const name = create ? args[2] : args[1];
    if (!name) return { lines: [`[ERROR] git ${sub} ${sub === "switch" ? "[-c]" : "[-b]"} <branch>`] };
    let start = repo;
    if (create) {
      const made = Git.createBranch(repo, name);
      if (typeof made === "string") return { lines: [`[ERROR] ${made}`] };
      // A new branch starts at the current commit, so no files change.
      return { lines: [`[SUCCESS] Switched to a new branch '${name}'`], effect: { type: "git", git: { ...made, branch: name } } };
    }
    const result = Git.switchBranch(start, work(), name);
    if (typeof result === "string") return { lines: [`[ERROR] ${result}`] };
    start = result.git;
    return { lines: [`[SUCCESS] Switched to branch '${name}'${result.changes.length ? ` (${result.changes.length} file(s) updated)` : ""}`], effect: { type: "git", git: start, changes: result.changes } };
  }

  if (sub === "merge") {
    const name = args[1];
    if (!name) return { lines: ["[ERROR] git merge <branch>"] };
    const result = Git.mergeBranch(repo, work(), name);
    if (typeof result === "string") return { lines: [`[ERROR] ${result}`] };
    return { lines: [`[SUCCESS] ${result.note}${result.changes.length ? ` (${result.changes.length} file(s) updated)` : ""}`], effect: result.changes.length || result.git !== repo ? { type: "git", git: result.git, changes: result.changes } : undefined };
  }

  if (sub === "remote") {
    const action = args[1];
    if (!action || action === "-v") {
      if (!repo.remote) return { lines: ["[INFO] no remote. git remote add origin owner/name [folder]"] };
      const track = Object.entries(repo.remote.track).map(([local, remote]) => `${local} → ${remote}`).join(", ");
      return { lines: [`origin  https://github.com/${repo.remote.repo}  (folder: project/${repo.remote.dir || ""})${track ? `  ${track}` : ""}`] };
    }
    if (action === "add") {
      if (args[2] !== "origin") return { lines: ["[ERROR] git remote add origin owner/name [folder]   (one remote, called origin)"] };
      if (repo.remote) return { lines: [`[ERROR] origin already points at ${repo.remote.repo}; git remote remove origin first`] };
      const target = parseRepo(args[3] ?? "");
      if (!target) return { lines: ["[ERROR] git remote add origin owner/name [folder]"] };
      const dir = args[4] ? folderPath(args[4], ctx) : "";
      if (dir && !Object.keys(work()).some((path) => path.startsWith(`${dir}/`))) return { lines: [`[ERROR] project/${dir}/ has no files`] };
      return {
        lines: [`[SUCCESS] origin → ${target}, from project/${dir}`, "[INFO] Push sends commits as new history: the GitHub branch must not exist yet (git push creates it). To work on an existing repo, clone it instead."],
        effect: { type: "git", git: Git.setRemote(repo, target, dir) },
      };
    }
    if (action === "remove" || action === "rm") {
      if (!repo.remote) return { lines: ["[INFO] no remote to remove"] };
      return { lines: [`[SUCCESS] removed origin (${repo.remote.repo}); local history is kept`], effect: { type: "git", git: Git.removeRemote(repo) } };
    }
    return { lines: ["[ERROR] git remote [-v] | add origin owner/name [folder] | remove origin"] };
  }

  if (sub === "push") {
    const plan = Git.pushPlan(repo);
    if (typeof plan === "string") return { lines: [plan.startsWith("Everything") ? `[INFO] ${plan}` : `[ERROR] ${plan}`] };
    return { lines: [], effect: { type: "push" } };
  }

  if (sub === "checkout") {
    const dash = args.indexOf("--");
    if (dash !== 2) return { lines: ["[ERROR] git checkout <commit> -- <path>, or git checkout <branch>"] };
    const commit = Git.findCommit(repo, args[1]);
    if (!commit) return { lines: [`[ERROR] unknown commit '${args[1]}'`] };
    if (!commit.tree) return { lines: [`[ERROR] ${commit.id} has no snapshot (made before history was real)`] };
    const tree = commit.tree;
    const paths = args.slice(3).flatMap((arg) => repoPaths(arg, ctx, Object.keys(tree))).flatMap((path) => (path === "." ? Object.keys(tree) : [path]));
    if (paths.length === 0) return { lines: ["[ERROR] git checkout <commit> -- <path>"] };
    const index = { ...(repo.index ?? {}) };
    for (const path of paths) if (path in tree) index[path] = tree[path];
    return writeBack(repo, { ...repo, index }, paths, tree, ctx, `checked out from ${commit.id}`);
  }

  if (sub === "pull" || sub === "fetch" || sub === "rebase") {
    return { lines: [`[INFO] git ${sub} is not available. To pick up changes made on GitHub, clone the repo again.`] };
  }
  return { lines: GIT_HELP };
}

/** Writes the contents `source` holds for `paths` into the project, recreating files that were deleted. */
function writeBack(
  repo: GitState,
  next: GitState,
  paths: string[],
  source: Git.Tree,
  ctx: TermCtx,
  verb: string,
): { lines: string[]; effect?: TermEffect } {
  const changes: Git.FileChange[] = [];
  const lines: string[] = [];
  const existing = new Set(ctx.files.filter((file) => file.type === "file").map((file) => Git.pathOf(file, ctx.files)));
  let recreated = 0;
  for (const path of paths) {
    const content = Git.blob(repo, source[path]);
    if (content === undefined) {
      lines.push(`[ERROR] ${path} is not in that version`);
      continue;
    }
    if (!existing.has(path)) recreated++;
    changes.push({ path, content });
  }
  if (changes.length) lines.unshift(`[SUCCESS] ${changes.length} file(s) ${verb}${recreated ? ` (${recreated} recreated)` : ""}`);
  return { lines, effect: changes.length || next !== repo ? { type: "git", git: next, changes } : undefined };
}
