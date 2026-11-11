import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findFile, interpret, parseRepo, resolvePath, type TermCtx, type TermEffect } from "./terminal.ts";
import { applyChanges, EMPTY_GIT } from "./git.ts";
import type { GitState } from "./types.ts";
import type { ProjectFile } from "./types.ts";

const files: ProjectFile[] = [
  { id: "root", name: "Project", type: "folder", parentId: null },
  { id: "src", name: "src", type: "folder", parentId: "root" },
  { id: "lib", name: "lib", type: "folder", parentId: "src" },
  { id: "a", name: "main.py", type: "file", parentId: "src", language: "python", content: "print(1)" },
  { id: "b", name: "util.py", type: "file", parentId: "lib", language: "python", content: "x = 2" },
  { id: "c", name: "util.py", type: "file", parentId: "root", language: "python", content: "y = 3" },
  { id: "d", name: "README.md", type: "file", parentId: "root", content: "# hi" },
];
const ROOT = "~/crimson-node";
const ctx = (cwd = ROOT): TermCtx => ({ cwd, files, git: { initialized: true, branch: "main", staged: ["a", "gone"], commits: [] } as TermCtx["git"] });

describe("resolvePath", () => {
  it("handles relative, .., ., ~ and absolute", () => {
    assert.deepEqual(resolvePath(`${ROOT}/project/src`, "lib"), ["project", "src", "lib"]);
    assert.deepEqual(resolvePath(`${ROOT}/project/src`, "../src/./lib/"), ["project", "src", "lib"]);
    assert.deepEqual(resolvePath(`${ROOT}/project/src`, "~"), []);
    assert.deepEqual(resolvePath(`${ROOT}/project/src`, "~/project"), ["project"]);
    assert.deepEqual(resolvePath(`${ROOT}/project`, "/vault"), ["vault"]);
    assert.equal(resolvePath(ROOT, ".."), null);
  });
});

describe("cd / ls / cat", () => {
  it("walks into real folders and refuses files and unknown dirs", () => {
    assert.deepEqual(interpret("cd project/src/lib", ctx()).effect, { type: "cwd", cwd: `${ROOT}/project/src/lib` });
    assert.match(interpret("cd nope", ctx()).lines[0], /No such directory/);
    assert.match(interpret("cd project/README.md", ctx()).lines[0], /Not a directory/);
    assert.match(interpret("cd project/src/x/y", ctx()).lines[0], /No such directory/);
    assert.deepEqual(interpret("cd ..", ctx(`${ROOT}/project/src`)).effect, { type: "cwd", cwd: `${ROOT}/project` });
  });
  it("lists the real tree, folders first, and ls <path>", () => {
    assert.deepEqual(interpret("ls", ctx()).lines, ["project/", "vault/"]);
    assert.deepEqual(interpret("ls", ctx(`${ROOT}/project`)).lines, ["src/", "README.md", "util.py"]);
    assert.deepEqual(interpret("ls src", ctx(`${ROOT}/project`)).lines, ["lib/", "main.py"]);
    assert.deepEqual(interpret("ls project/src/lib", ctx()).lines, ["util.py"]);
    assert.match(interpret("ls", ctx(`${ROOT}/project/deleted`)).lines[0], /no longer exists/);
  });
  it("cat by path, unique bare name, and ambiguity error", () => {
    assert.deepEqual(interpret("cat lib/util.py", ctx(`${ROOT}/project/src`)).lines, ["x = 2"]);
    assert.deepEqual(interpret("cat util.py", ctx(`${ROOT}/project`)).lines, ["y = 3"]); // in cwd wins
    assert.deepEqual(interpret("cat main.py", ctx()).lines, ["print(1)"]); // unique anywhere
    assert.match(interpret("cat util.py", ctx())!.lines[0], /2 files are named util.py/);
  });
});

describe("run", () => {
  it("python resolves to a file id", () => {
    assert.deepEqual(interpret("python lib/util.py", ctx(`${ROOT}/project/src`)).effect, { type: "run", fileId: "b", fileName: "util.py" });
    assert.match(interpret("python src", ctx(`${ROOT}/project`)).lines[0], /is a directory/);
  });
  it("findFile reports missing files", () => assert.equal(findFile("nope.py", ctx()).ok, false));
  it("is honest about not being a shell", () => {
    assert.match(interpret("help", ctx()).lines[0], /not a shell/);
    assert.match(interpret("rm -rf /", ctx()).lines[0], /not a built-in command/);
  });
});

/** Runs commands in sequence, applying git effects and file writes like the app does. */
function session(commands: string[], start: ProjectFile[] = files, cwd = `${ROOT}/project`) {
  let state: GitState = { ...EMPTY_GIT };
  let current = start.map((file) => ({ ...file }));
  const out: string[][] = [];
  for (const command of commands) {
    const result = interpret(command, { cwd, files: current, git: state });
    out.push(result.lines);
    const effect = result.effect as TermEffect | undefined;
    if (effect?.type === "git") {
      state = effect.git;
      current = applyChanges(current, effect.changes ?? [], (n) => `new${n}`, () => "text");
    }
  }
  return { out, state, files: current, edit: (id: string, content: string) => (current = current.map((file) => (file.id === id ? { ...file, content } : file))) };
}

describe("git (real history)", () => {
  it("init, add ., commit, then a clean status and a log entry", () => {
    const { out, state } = session(["git status", "git init", "git add .", 'git commit -m "first commit"', "git status", "git log"]);
    assert.match(out[0][0], /Not a repository/);
    assert.match(out[2].at(-1)!, /staged 4 path/);
    assert.match(out[3][0], /^\[SUCCESS\] \[main [0-9a-f]{7}\] first commit$/);
    assert.match(out[4].join("\n"), /working tree clean/);
    assert.match(out[5][0], /first commit$/);
    assert.equal(Object.keys(state.commits[0].tree!).length, 4);
  });

  it("sees edits (including the live draft), diffs them, and restores them", () => {
    const s = session(["git init", "git add .", 'git commit -m "one"']);
    const edited = s.files.map((file) => (file.id === "a" ? { ...file, content: "print(2)" } : file));
    const status = interpret("git status", { cwd: `${ROOT}/project`, files: edited, git: s.state });
    assert.match(status.lines.join("\n"), /Changes not staged[\s\S]*modified\s+src\/main\.py/);
    const live = interpret("git diff", { cwd: `${ROOT}/project`, files: s.files, git: s.state, live: { id: "a", content: "print(3)" } });
    assert.ok(live.lines.includes("-print(1)") && live.lines.includes("+print(3)"), live.lines.join("|"));
    const restored = interpret("git restore src/main.py", { cwd: `${ROOT}/project`, files: edited, git: s.state });
    assert.deepEqual((restored.effect as Extract<TermEffect, { type: "git" }>).changes, [{ path: "src/main.py", content: "print(1)" }]);
  });

  it("checkout <commit> -- <path> brings back an older version; show prints the commit's diff", () => {
    const s = session(["git init", "git add .", 'git commit -m "v1"']);
    const first = s.state.commits[0].id;
    const edited = s.edit("d", "# changed");
    const after = interpret("git add README.md", { cwd: `${ROOT}/project`, files: edited, git: s.state });
    const s2 = (after.effect as Extract<TermEffect, { type: "git" }>).git;
    const committed = interpret('git commit -m "v2"', { cwd: `${ROOT}/project`, files: edited, git: s2 });
    const s3 = (committed.effect as Extract<TermEffect, { type: "git" }>).git;
    const shown = interpret("git show", { cwd: `${ROOT}/project`, files: edited, git: s3 }).lines;
    assert.ok(shown.includes("-# hi") && shown.includes("+# changed"), shown.join("|"));
    const back = interpret(`git checkout ${first} -- README.md`, { cwd: `${ROOT}/project`, files: edited, git: s3 });
    assert.deepEqual((back.effect as Extract<TermEffect, { type: "git" }>).changes, [{ path: "README.md", content: "# hi" }]);
  });

  it("paths are relative to the cwd, and folders expand", () => {
    const s = session(["git init", "git add src"], files, `${ROOT}/project`);
    assert.deepEqual(Object.keys(s.state.index!).sort(), ["src/lib/util.py", "src/main.py"]);
    const fromSrc = session(["git init", "git add lib/util.py"], files, `${ROOT}/project/src`);
    assert.deepEqual(Object.keys(fromSrc.state.index!), ["src/lib/util.py"]);
  });

  it("nothing to commit, unknown paths and remote commands are reported plainly", () => {
    const { out } = session(["git init", 'git commit -m "empty"', "git add nope.py", "git push", "git pull", "git checkout main"]);
    assert.match(out[1][0], /Nothing staged/);
    assert.match(out[2][0], /did not match any files/);
    assert.match(out[3][0], /no remote/);
    assert.match(out[4][0], /no remote to pull from/);
    assert.match(out[5][0], /already on 'main'/);
  });
});

describe("git branches", () => {
  it("branch, switch, commit, switch back (files follow), fast-forward merge, delete", () => {
    const s = session(["git init", "git add .", 'git commit -m "base"', "git switch -c feature", "git branch"]);
    assert.match(s.out[3][0], /Switched to a new branch 'feature'/);
    assert.deepEqual(s.out[4], ["* feature  " + s.state.branches!.feature, "  main  " + s.state.branches!.main]);
    // Commit a change on feature, including a new file.
    let state = s.state;
    let current = applyChanges(s.files, [{ path: "src/main.py", content: "print('feature')" }, { path: "NEW.md", content: "new" }], (n) => `n${n}`, () => "text");
    const run = (command: string) => {
      const result = interpret(command, { cwd: `${ROOT}/project`, files: current, git: state });
      if (result.effect?.type === "git") {
        state = result.effect.git;
        current = applyChanges(current, result.effect.changes ?? [], (n) => `m${n}${Math.random()}`, () => "text");
      }
      return result.lines;
    };
    run("git add .");
    run('git commit -m "feature work"');
    assert.match(run("git switch main")[0], /Switched to branch 'main' \(2 file\(s\) updated\)/);
    assert.equal(current.find((f) => f.id === "a")!.content, "print(1)");
    assert.equal(current.some((f) => f.name === "NEW.md"), false, "new file removed on main");
    assert.match(run("git merge feature")[0], /Fast-forward/);
    assert.equal(current.find((f) => f.id === "a")!.content, "print('feature')");
    assert.ok(current.some((f) => f.name === "NEW.md"));
    assert.match(run("git merge feature")[0], /Already up to date/);
    assert.match(run("git branch -d feature")[0], /Deleted branch feature/);
  });
  it("refuses to switch with uncommitted changes, and diverged merges", () => {
    const s = session(["git init", "git add .", 'git commit -m "base"', "git branch other"]);
    const edited = s.files.map((f) => (f.id === "a" ? { ...f, content: "dirty" } : f));
    assert.match(interpret("git switch other", { cwd: `${ROOT}/project`, files: edited, git: s.state }).lines[0], /commit or restore your changes first: src\/main\.py/);
    assert.match(interpret("git branch bad..name", { cwd: ROOT, files, git: s.state }).lines[0], /not a valid branch name/);
  });
});

describe("git merge with conflicts", () => {
  it("merge → CONFLICT → status → blocked commit → fix, add, commit; and --abort", () => {
    let state: GitState = { ...EMPTY_GIT };
    let current = files.map((file) => ({ ...file }));
    const run = (command: string) => {
      const result = interpret(command, { cwd: `${ROOT}/project`, files: current, git: state });
      if (result.effect?.type === "git") {
        state = result.effect.git;
        current = applyChanges(current, result.effect.changes ?? [], (n) => `x${n}${Math.random()}`, () => "text");
      }
      return result.lines.join("\n");
    };
    const edit = (id: string, content: string) => (current = current.map((f) => (f.id === id ? { ...f, content } : f)));
    run("git init");
    run("git add .");
    run('git commit -m "base"');
    run("git switch -c other");
    edit("d", "# other");
    run("git add .");
    run('git commit -m "other readme"');
    run("git switch main");
    edit("d", "# main");
    run("git add .");
    run('git commit -m "main readme"');
    const merged = run("git merge other");
    assert.match(merged, /\[WARN\] Automatic merge failed in 1 file/);
    assert.match(merged, /CONFLICT in README\.md/);
    assert.match(current.find((f) => f.id === "d")!.content!, /<<<<<<< ours\n# main\n=======\n# other\n>>>>>>> theirs/);
    assert.match(run("git status"), /Unmerged paths[\s\S]*both modified: README\.md/);
    assert.match(run("git commit"), /cannot commit the merge yet[\s\S]*README\.md: still conflicted/);
    assert.match(run("git switch other"), /merge is in progress/);
    edit("d", "# main and other");
    run("git add README.md");
    assert.match(run("git commit"), /\[SUCCESS\] \[main [0-9a-f]{7}\] Merge branch 'other' into main/);
    assert.match(run("git log"), /Merge branch 'other' into main {2}\(merge\)/);
    // Abort path.
    run("git switch -c again");
    edit("d", "# again");
    run("git add .");
    run('git commit -m "again"');
    run("git switch main");
    edit("d", "# main 2");
    run("git add .");
    run('git commit -m "main 2"');
    run("git merge again");
    assert.match(run("git merge --abort"), /Merge aborted; 1 file\(s\) put back/);
    assert.equal(current.find((f) => f.id === "d")!.content, "# main 2");
    assert.match(run("git status"), /working tree clean/);
  });
});

describe("untracked files in the terminal", () => {
  it("git switch refuses to overwrite an untracked file and leaves it as it was", () => {
    const s = session(["git init", "git add .", 'git commit -m "base"', "git switch -c other"]);
    const withNew = applyChanges(s.files, [{ path: "notes.txt", content: "other's notes" }], (n) => `n${n}`, () => "text");
    let state = (interpret("git add notes.txt", { cwd: `${ROOT}/project`, files: withNew, git: s.state }).effect as Extract<TermEffect, { type: "git" }>).git;
    state = (interpret('git commit -m "notes"', { cwd: `${ROOT}/project`, files: withNew, git: state }).effect as Extract<TermEffect, { type: "git" }>).git;
    const back = interpret("git switch main", { cwd: `${ROOT}/project`, files: withNew, git: state });
    state = (back.effect as Extract<TermEffect, { type: "git" }>).git;
    const onMain = applyChanges(withNew, (back.effect as Extract<TermEffect, { type: "git" }>).changes ?? [], (n) => `m${n}`, () => "text");
    const mine = onMain.concat({ id: "mine", name: "notes.txt", type: "file", parentId: "root", content: "MY NOTES" });
    const refused = interpret("git switch other", { cwd: `${ROOT}/project`, files: mine, git: state });
    assert.match(refused.lines[0], /untracked file\(s\) would be overwritten: notes\.txt/);
    assert.equal(refused.effect, undefined);
  });
});

describe("git remote and push", () => {
  it("adds a remote for a folder and plans a push", () => {
    const s = session(["git init", "git remote add origin me/site src", "git add .", 'git commit -m "first"', "git remote", "git push"]);
    assert.match(s.out[1][0], /origin → me\/site, from project\/src/);
    assert.match(s.out[4][0], /github\.com\/me\/site/);
    assert.deepEqual(interpret("git push", { cwd: ROOT, files, git: s.state }).effect, { type: "push" });
    assert.match(interpret("git remote add origin me/x nowhere", { cwd: `${ROOT}/project`, files, git: { ...s.state, remote: undefined } }).lines[0], /has no files/);
  });
});

describe("clone", () => {
  it("parses owner/name and GitHub URLs, refuses the rest", () => {
    assert.equal(parseRepo("sickn33/agentic-awesome-skills"), "sickn33/agentic-awesome-skills");
    assert.equal(parseRepo("https://github.com/owner/repo.git"), "owner/repo");
    assert.equal(parseRepo("ToolNeuron"), null);
    assert.equal(parseRepo("owner/repo/extra"), null);
    assert.equal(parseRepo("../etc/passwd"), null);
    assert.deepEqual(interpret("gh repo clone owner/repo", ctx()).effect, { type: "clone", repo: "owner/repo" });
    assert.deepEqual(interpret("git clone https://github.com/a/b", ctx()).effect, { type: "clone", repo: "a/b" });
    assert.match(interpret("gh repo clone ToolNeuron", ctx()).lines[0], /public GitHub repo/);
  });
});
