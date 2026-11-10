import type { GitState, ProjectFile } from "./types";

export type TermEffect =
  | { type: "clear" }
  | { type: "cwd"; cwd: string }
  | { type: "ai"; prompt: string }
  | { type: "clone"; name: string }
  | { type: "run"; fileId: string; fileName: string }
  | { type: "git-init" }
  | { type: "git-add"; fileId: string; name: string }
  | { type: "git-commit"; message: string };

export type TermCtx = {
  cwd: string;
  files: ProjectFile[];
  git: GitState;
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
        "Deck commands",
        "  help                     this list",
        "  clear                    flush the buffer",
        "  pwd / ls [path] / cd <dir>   walk the node (.. . ~ and a/b paths work)",
        "  cat <file>               read a project file (path, or a unique name)",
        "  status                   node snapshot",
        "  ai <prompt>              ask the active personality",
        "  python <file>            run real Python 3.14 (Pyodide) in the sandbox",
        "  node <file>              run JavaScript in the isolated sandbox",
        "  git init|status|add|commit -m \"msg\"",
        "  gh repo clone <name>     drop a stub repo into the project",
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
  if (head === "git") return git(rest, ctx);
  if (cmd.startsWith("gh repo clone")) {
    const name = cmd.replace(/^gh repo clone\s+/, "").trim();
    if (!name) return { lines: ["[ERROR] clone needs a name, e.g. gh repo clone ToolNeuron"] };
    return {
      lines: [`Cloning into '${name.split("/").pop()}'…`, "[SUCCESS] Stub landed in the project tree."],
      effect: { type: "clone", name },
    };
  }
  return { lines: [`[LOG] '${head}' is not on this deck. Try help.`] };
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

function git(args: string[], ctx: TermCtx): { lines: string[]; effect?: TermEffect } {
  const sub = args[0];
  if (sub === "init") {
    if (ctx.git.initialized) return { lines: ["[WARN] Repository already initialized."] };
    return { lines: ["[SUCCESS] Initialized empty repository on main."], effect: { type: "git-init" } };
  }
  if (!ctx.git.initialized && sub) return { lines: ["[ERROR] Not a repository. Run git init."] };
  if (sub === "status") {
    return {
      lines: [
        `On branch ${ctx.git.branch}`,
        ctx.git.staged.length
          ? `staged: ${ctx.git.staged.map((id) => ctx.files.find((file) => file.id === id)?.name ?? "(deleted file)").join(", ")}`
          : "nothing staged",
        `${ctx.git.commits.length} local commit(s)`,
      ],
    };
  }
  if (sub === "add") {
    const name = args[1];
    if (!name) return { lines: ["[ERROR] git add needs a file name"] };
    const found = findFile(name, ctx);
    if (!found.ok) return { lines: [found.error] };
    return { lines: [`[SUCCESS] staged ${found.file.name}`], effect: { type: "git-add", fileId: found.file.id, name: found.file.name } };
  }
  if (sub === "commit") {
    const message = args.slice(1).join(" ").replace(/^-m\s*/, "").replace(/^"|"$/g, "");
    if (!message) return { lines: ['[ERROR] git commit -m "message"'] };
    if (ctx.git.staged.length === 0) return { lines: ["[WARN] Nothing staged."] };
    return { lines: [`[SUCCESS] ${message}`], effect: { type: "git-commit", message } };
  }
  return { lines: ["[ERROR] git init | status | add <file> | commit -m \"msg\""] };
}
