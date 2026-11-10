import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { add, applyChanges, collect, commit, createBranch, diffText, EMPTY_GIT, findCommit, hash, history, init, markPushed, MAX_COMMITS, mergeBranch, normalizeGit, pathOf, pushPlan, setRemote, status, subtree, switchBranch, unstage, workingFiles } from "./git.ts";
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

describe("branches", () => {
  const base = commit(add(init(EMPTY_GIT), { "a.txt": "1" }, ["."]).git, "base", "t0")!;
  it("history follows the current branch only", () => {
    const branched = createBranch(base, "topic");
    assert.ok(typeof branched !== "string");
    const onTopic = commit(add({ ...branched, branch: "topic" }, { "a.txt": "2" }, ["."]).git, "topic work", "t1")!;
    assert.deepEqual(history(onTopic).map((c) => c.message), ["topic work", "base"]);
    assert.deepEqual(history({ ...onTopic, branch: "main" }).map((c) => c.message), ["base"]);
    assert.equal(findCommit(onTopic, "main")?.message, "base");
    assert.equal(findCommit(onTopic, "topic~1")?.message, "base");
  });
  it("switch returns the file changes; merge fast-forwards or refuses divergence", () => {
    const topic = createBranch(base, "topic") as typeof base;
    const ahead = commit(add({ ...topic, branch: "topic" }, { "a.txt": "2", "b.txt": "new" }, ["."]).git, "ahead", "t1")!;
    const back = switchBranch(ahead, { "a.txt": "2", "b.txt": "new" }, "main");
    assert.ok(typeof back !== "string");
    assert.deepEqual(back.changes, [{ path: "a.txt", content: "1" }, { path: "b.txt", content: null }]);
    const merged = mergeBranch(back.git, { "a.txt": "1" }, "topic");
    assert.ok(typeof merged !== "string");
    assert.equal(merged.git.branches!.main, merged.git.branches!.topic);
    const diverged = commit(add(back.git, { "a.txt": "3" }, ["."]).git, "main work", "t2")!;
    assert.match(mergeBranch(diverged, { "a.txt": "3" }, "topic") as string, /diverged/);
  });
  it("old saves get one branch at the newest commit", () => {
    const old = normalizeGit({ initialized: true, branch: "main", commits: [{ id: "abc1234", message: "m", time: "t", tree: {} }] });
    assert.deepEqual(old.branches, { main: "abc1234" });
  });
});

describe("push plan", () => {
  const sha = (n: number) => String(n).repeat(40).slice(0, 40);
  it("sends commits after the newest one already on GitHub, as changes under the remote folder", () => {
    let git = commit(add(init(EMPTY_GIT), { "site/index.html": "v1", "notes.txt": "x" }, ["."]).git, "clone", "t0")!;
    git = setRemote(git, "me/site", "site", { main: "main" }, { [git.branches!.main!]: sha(1) });
    assert.match(pushPlan(git) as string, /Everything up-to-date/);
    git = commit(add(git, { "site/index.html": "v2", "notes.txt": "y" }, ["."]).git, "edit", "t1")!;
    git = commit(add(git, { "site/about.html": "a", "notes.txt": "y" }, ["."]).git, "about, remove index", "t2")!;
    const plan = pushPlan(git);
    assert.ok(typeof plan !== "string");
    assert.equal(plan.parentSha, sha(1));
    assert.deepEqual(plan.commits.map((c) => [c.message, c.changes]), [
      ["edit", [{ path: "index.html", content: "v2" }]],
      ["about, remove index", [{ path: "about.html", content: "a" }, { path: "index.html", content: null }]],
    ]);
    const pushed = markPushed(git, plan.commits.map((c) => c.id), [sha(2), sha(3)], "main");
    assert.match(pushPlan(pushed) as string, /Everything up-to-date/);
  });
  it("a new branch pushes from where it left the pushed history", () => {
    let git = commit(add(init(EMPTY_GIT), { "f.txt": "1" }, ["."]).git, "base", "t0")!;
    git = setRemote(git, "me/r", "", {}, { [git.branches!.main!]: sha(4) });
    git = { ...(createBranch(git, "fix") as typeof git), branch: "fix" };
    git = commit(add(git, { "f.txt": "2" }, ["."]).git, "fix it", "t1")!;
    const plan = pushPlan(git);
    assert.ok(typeof plan !== "string");
    assert.equal(plan.branch, "fix");
    assert.equal(plan.parentSha, sha(4));
    assert.equal(plan.commits.length, 1);
  });
  it("needs a remote and a commit", () => {
    assert.match(pushPlan(init(EMPTY_GIT)) as string, /no remote/);
    assert.match(pushPlan(setRemote(init(EMPTY_GIT), "me/r", "")) as string, /no commits/);
  });
  it("subtree keeps only the folder, relative to it", () => {
    assert.deepEqual(subtree({ "a/x": "1", "ab/y": "2", "a/b/z": "3" }, "a"), { x: "1", "b/z": "3" });
  });
});

describe("applyChanges", () => {
  it("updates, creates (with folders) and deletes by path", () => {
    const out = applyChanges(
      files,
      [{ path: "src/main.py", content: "print(9)" }, { path: "docs/guide/intro.md", content: "# intro" }, { path: "README.md", content: null }, { path: "gone/x.txt", content: null }],
      (n) => `id${n}`,
      (name) => (name.endsWith(".md") ? "markdown" : "text"),
    );
    assert.equal(out.find((f) => f.id === "a")!.content, "print(9)");
    assert.equal(out.some((f) => f.id === "b"), false);
    const intro = out.find((f) => f.name === "intro.md")!;
    assert.equal(pathOf(intro, out), "docs/guide/intro.md");
    assert.equal(intro.language, "markdown");
  });
});
