import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findFile, interpret, resolvePath, type TermCtx } from "./terminal.ts";
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

describe("run and git", () => {
  it("python resolves to a file id", () => {
    assert.deepEqual(interpret("python lib/util.py", ctx(`${ROOT}/project/src`)).effect, { type: "run", fileId: "b", fileName: "util.py" });
    assert.match(interpret("python src", ctx(`${ROOT}/project`)).lines[0], /is a directory/);
  });
  it("git add by path, status shows names not ids", () => {
    assert.deepEqual(interpret("git add src/main.py", ctx(`${ROOT}/project`)).effect, { type: "git-add", fileId: "a", name: "main.py" });
    assert.match(interpret("git status", ctx()).lines[1], /staged: main.py, \(deleted file\)/);
  });
  it("findFile reports missing files", () => assert.equal(findFile("nope.py", ctx()).ok, false));
});
