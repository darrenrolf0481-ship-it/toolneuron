import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { add, collect, commit, diffText, EMPTY_GIT, findCommit, hash, init, MAX_COMMITS, normalizeGit, pathOf, status, unstage, workingFiles } from "./git.ts";
import type { ProjectFile } from "./types.ts";

const files: ProjectFile[] = [
  { id: "root", name: "Project", type: "folder", parentId: null },
  { id: "src", name: "src", type: "folder", parentId: "root" },
  { id: "a", name: "main.py", type: "file", parentId: "src", content: "print(1)\n" },
  { id: "b", name: "README.md", type: "file", parentId: "root", content: "# hi\n" },
];

describe("paths and working files", () => {
  it("paths are relative to the project folder", () => {
    assert.equal(pathOf(files[2], files), "src/main.py");
    assert.equal(pathOf(files[3], files), "README.md");
  });
  it("the live draft overrides the saved content", () => {
    assert.deepEqual(workingFiles(files, { id: "a", content: "print(2)\n" }), { "src/main.py": "print(2)\n", "README.md": "# hi\n" });
  });
  it("hash is stable and content-sensitive", () => {
    assert.equal(hash("abc"), hash("abc"));
    assert.notEqual(hash("abc"), hash("abd"));
    assert.equal(hash("").length, 14);
  });
});

describe("add, commit, status", () => {
  const work = workingFiles(files);
  const g0 = init(EMPTY_GIT);
  it("everything starts untracked; add . stages it; commit records it", () => {
    assert.deepEqual(status(g0, work).untracked, ["README.md", "src/main.py"]);
    const { git: g1, added } = add(g0, work, ["."]);
    assert.deepEqual(added.sort(), ["README.md", "src/main.py"]);
    assert.deepEqual(status(g1, work).staged.map((c) => c.kind), ["added", "added"]);
    const g2 = commit(g1, "first", "10:00:00")!;
    assert.equal(g2.commits.length, 1);
    assert.equal(g2.commits[0].id.length, 7);
    assert.deepEqual(status(g2, work), { staged: [], unstaged: [], untracked: [] });
    assert.equal(commit(g2, "again", "10:01:00"), null, "nothing to commit");
  });
  it("tracks edits, deletions and unstaging", () => {
    const g1 = commit(add(g0, work, ["."]).git, "first", "t1")!;
    const edited = { ...work, "src/main.py": "print(3)\n" };
    assert.deepEqual(status(g1, edited).unstaged, [{ path: "src/main.py", kind: "modified" }]);
    const staged = add(g1, edited, ["src/main.py"]).git;
    assert.deepEqual(status(staged, edited).staged, [{ path: "src/main.py", kind: "modified" }]);
    assert.deepEqual(status(unstage(staged, "src/main.py"), edited).staged, []);
    const gone = { "src/main.py": "print(1)\n" };
    assert.deepEqual(status(g1, gone).unstaged, [{ path: "README.md", kind: "deleted" }]);
    const g2 = commit(add(g1, gone, ["README.md"]).git, "remove readme", "t2")!;
    assert.deepEqual(Object.keys(g2.commits[0].tree!), ["src/main.py"]);
    assert.equal(g2.commits[0].parent, g1.commits[0].id);
  });
  it("reports paths that do not exist anywhere", () => {
    assert.deepEqual(add(g0, work, ["nope.py"]).missing, ["nope.py"]);
  });
});

describe("history", () => {
  it("finds commits by HEAD~n and prefix, keeps MAX_COMMITS, and drops unused blobs", () => {
    let git = init(EMPTY_GIT);
    for (let i = 0; i < MAX_COMMITS + 5; i++) {
      git = commit(add(git, { "f.txt": `v${i}\n` }, ["."]).git, `c${i}`, `t${i}`)!;
    }
    assert.equal(git.commits.length, MAX_COMMITS);
    assert.equal(findCommit(git, "HEAD")?.message, `c${MAX_COMMITS + 4}`);
    assert.equal(findCommit(git, "HEAD~1")?.message, `c${MAX_COMMITS + 3}`);
    assert.equal(findCommit(git, git.commits[3].id.slice(0, 5))?.message, git.commits[3].message);
    assert.equal(findCommit(git, "abc"), undefined, "too short");
    assert.equal(Object.keys(git.blobs!).length, MAX_COMMITS, "one blob per surviving version");
    assert.equal(Object.keys(collect(git).blobs!).length, MAX_COMMITS);
  });
  it("normalizeGit upgrades old saves without inventing history", () => {
    const old = normalizeGit({ initialized: true, branch: "main", staged: ["a"], commits: [{ id: "abc1234", message: "old", time: "t" }] });
    assert.deepEqual(old.index, {});
    assert.deepEqual(old.staged, []);
    assert.equal(old.commits[0].tree, undefined);
    assert.equal(normalizeGit(null).initialized, false);
  });
});

describe("diffText", () => {
  it("shows changed lines with context and correct hunk headers", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
    const after = ["a", "b", "c", "D", "e", "f", "g", "h", "i", "j", "k"].join("\n");
    const out = diffText("x.txt", before, after);
    assert.deepEqual(out.slice(0, 2), ["diff --git a/x.txt b/x.txt", "--- a/x.txt"]);
    assert.deepEqual(out.slice(3), ["@@ -2,5 +2,5 @@", " b", " c", "-d", "+D", " e", " f", "@@ -9,2 +9,3 @@", " i", " j", "+k"]);
  });
  it("handles new and deleted files, and identical ones", () => {
    assert.deepEqual(diffText("n.py", undefined, "x = 1"), ["diff --git a/n.py b/n.py", "new file", "--- /dev/null", "+++ b/n.py", "@@ -0,0 +1,1 @@", "+x = 1"]);
    assert.ok(diffText("d.py", "x", undefined).includes("deleted file"));
    assert.deepEqual(diffText("s.py", "same", "same"), []);
  });
  it("refuses to line-diff huge files", () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
    assert.match(diffText("big.txt", big, big + "\nmore").at(-1)!, /too large to diff/);
  });
});
