import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { abortMerge, blob, add, untrackedCollisions, commitFiles, historyComplete, localIdOf, pullSnapshot, treeParentOf, applyChanges, collect, commit, createBranch, diffText, EMPTY_GIT, findCommit, hash, history, init, markPushed, MAX_COMMITS, merge3, mergeBlockers, mergeBranch, mergeTrees, normalizeGit, pathOf, pushPlan, setRemote, status, subtree, switchBranch, unstage, workingFiles } from "./git.ts";
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
    const merged = mergeBranch(back.git, { "a.txt": "1" }, "topic", "t2");
    assert.ok(typeof merged !== "string");
    assert.equal(merged.git.branches!.main, merged.git.branches!.topic, "fast-forward");
  });
  it("old saves get one branch at the newest commit", () => {
    const old = normalizeGit({ initialized: true, branch: "main", commits: [{ id: "abc1234", message: "m", time: "t", tree: {} }] });
    assert.deepEqual(old.branches, { main: "abc1234" });
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

describe("merge3", () => {
  const base = "a\nb\nc\nd\ne";
  it("applies changes to different lines from both sides", () => {
    assert.deepEqual(merge3(base, "A\nb\nc\nd\ne", "a\nb\nc\nd\nE"), { text: "A\nb\nc\nd\nE", conflict: false });
    assert.deepEqual(merge3(base, "a\nb\nX\nc\nd\ne", "a\nb\nc\nd\ne\nf"), { text: "a\nb\nX\nc\nd\ne\nf", conflict: false });
  });
  it("takes identical changes once, and one-sided changes whole", () => {
    assert.equal(merge3(base, "a\nB\nc\nd\ne", "a\nB\nc\nd\ne").text, "a\nB\nc\nd\ne");
    assert.equal(merge3(base, base, "z").text, "z");
  });
  it("marks overlapping different changes as a conflict", () => {
    const out = merge3(base, "a\nOURS\nc\nd\ne", "a\nTHEIRS\nc\nd\ne");
    assert.equal(out.conflict, true);
    assert.equal(out.text, "a\n<<<<<<< ours\nOURS\n=======\nTHEIRS\n>>>>>>> theirs\nc\nd\ne");
  });
  it("both adding a file with different contents conflicts", () => {
    assert.equal(merge3(undefined, "x", "y").conflict, true);
  });
});

describe("three-way merge of branches", () => {
  const start = commit(add(init(EMPTY_GIT), { "a.txt": "1\n2\n3", "b.txt": "b" }, ["."]).git, "base", "t0")!;
  const topic = { ...(createBranch(start, "topic") as typeof start), branch: "topic" };
  const theirs = commit(add(topic, { "a.txt": "1\n2\nTHREE", "b.txt": "b", "c.txt": "new" }, ["."]).git, "topic work", "t1")!;
  const back = switchBranch(theirs, { "a.txt": "1\n2\nTHREE", "b.txt": "b", "c.txt": "new" }, "main") as { git: typeof start };

  it("clean: makes a merge commit with both parents", () => {
    const ours = commit(add(back.git, { "a.txt": "ONE\n2\n3", "b.txt": "b" }, ["."]).git, "main work", "t2")!;
    const merged = mergeBranch(ours, { "a.txt": "ONE\n2\n3", "b.txt": "b" }, "topic", "t3");
    assert.ok(typeof merged !== "string");
    assert.deepEqual(merged.conflicts, []);
    const made = merged.git.commits[0];
    assert.equal(made.parent, ours.branches!.main);
    assert.equal(made.parent2, ours.branches!.topic);
    assert.deepEqual(merged.changes, [{ path: "a.txt", content: "ONE\n2\nTHREE" }, { path: "c.txt", content: "new" }]);
    assert.equal(history(merged.git).length, 4, "log reaches both sides");
    assert.equal(findCommit(merged.git, "HEAD~1")?.message, "main work", "~ follows the first parent");
  });

  it("conflict: merge in progress until fixed, staged and committed; abort puts files back", () => {
    const ours = commit(add(back.git, { "a.txt": "1\n2\nthree!", "b.txt": "b" }, ["."]).git, "main work", "t2")!;
    const merged = mergeBranch(ours, { "a.txt": "1\n2\nthree!", "b.txt": "b" }, "topic", "t3");
    assert.ok(typeof merged !== "string");
    assert.deepEqual(merged.conflicts, ["a.txt"]);
    const work = { "a.txt": merged.changes.find((c) => c.path === "a.txt")!.content!, "b.txt": "b", "c.txt": "new" };
    assert.match(work["a.txt"], /<<<<<<< ours\nthree!\n=======\nTHREE\n>>>>>>> theirs/);
    assert.deepEqual(mergeBlockers(merged.git), ["a.txt: still conflicted (fix it, then git add a.txt)"]);
    assert.match(pushPlan(setRemote(merged.git, "me/r", "")) as string, /merge is in progress/);
    assert.match(switchBranch(merged.git, work, "topic") as string, /merge is in progress/);
    // Staging the markers is caught too.
    const markers = add(merged.git, work, ["a.txt"]).git;
    assert.match(mergeBlockers(markers)[0], /still has conflict markers/);
    const fixed = add(merged.git, { ...work, "a.txt": "1\n2\nTHREE!" }, ["a.txt", "c.txt"]).git;
    assert.deepEqual(mergeBlockers(fixed), []);
    const done = commit(fixed, merged.git.merging!.message, "t4")!;
    assert.equal(done.merging, undefined);
    assert.equal(done.commits[0].parent2, ours.branches!.topic);
    const aborted = abortMerge(merged.git);
    assert.ok(typeof aborted !== "string");
    assert.deepEqual(aborted.changes, [{ path: "a.txt", content: "1\n2\nthree!" }, { path: "c.txt", content: null }]);
    assert.equal(aborted.git.merging, undefined);
  });

  it("delete on one side, edit on the other is a conflict that keeps the edit", () => {
    const g = init(EMPTY_GIT);
    const blobs = { [hash("x")]: "x", [hash("y")]: "y" };
    const out = mergeTrees({ ...g, blobs }, { "f.txt": hash("x") }, {}, { "f.txt": hash("y") });
    assert.deepEqual(out.conflicts, ["f.txt"]);
    assert.match(out.changes[0].content!, /CONFLICT: deleted here, changed on the other side[\s\S]*\ny$/);
  });
});

const sha = (c: string) => c.repeat(40);
/** A linked repo: one commit A on GitHub (sha aaaa…), GitHub's main last seen at A. */
function linked(files: Record<string, string> = { "r/a.txt": "1\n2\n3" }, dir = "r") {
  const g = commit(add(init(EMPTY_GIT), files, ["."]).git, "clone", "t0")!;
  return setRemote(g, "me/r", dir, { main: "main" }, { [g.branches!.main!]: sha("a") }, { main: sha("a") });
}

describe("push plan", () => {
  it("sends commits after GitHub's tip, relative to the remote folder, then is up to date", () => {
    let git = linked({ "site/index.html": "v1", "notes.txt": "x" }, "site");
    assert.match(pushPlan(git) as string, /Everything up-to-date/);
    git = commit(add(git, { "site/index.html": "v2", "notes.txt": "y" }, ["."]).git, "edit", "t1")!;
    git = commit(add(git, { "site/about.html": "a", "notes.txt": "y" }, ["."]).git, "about, remove index", "t2")!;
    const plan = pushPlan(git);
    assert.ok(typeof plan !== "string");
    assert.equal(plan.expectSha, sha("a"));
    assert.equal(plan.localBranch, "main");
    assert.deepEqual(plan.commits.map((c) => [c.message, c.parents, c.treeParent, c.changes]), [
      ["edit", [{ sha: sha("a") }], 0, [{ path: "index.html", content: "v2" }]],
      ["about, remove index", [{ index: 0 }], 0, [{ path: "about.html", content: "a" }, { path: "index.html", content: null }]],
    ]);
    const pushed = markPushed(git, plan, [sha("2"), sha("3")], sha("3"));
    assert.deepEqual(pushed.remote!.tips, { main: sha("3") });
    assert.match(pushPlan(pushed) as string, /Everything up-to-date/);
  });
  it("a new branch pushes from where it left; GitHub's main tip is untouched (E4)", () => {
    let git = linked();
    git = { ...(createBranch(git, "feature") as typeof git), branch: "feature" };
    git = commit(add(git, { "r/a.txt": "F" }, ["."]).git, "F", "t1")!;
    const plan = pushPlan(git);
    assert.ok(typeof plan !== "string");
    assert.equal(plan.branch, "feature");
    assert.equal(plan.expectSha, null, "feature is not on GitHub yet");
    git = markPushed(git, plan, [sha("f")], sha("f"));
    assert.deepEqual(git.remote!.tips, { main: sha("a"), feature: sha("f") });
    // Fast-forward main to F: nothing new to create, but GitHub main must move.
    const onMain = switchBranch(git, { "r/a.txt": "F" }, "main") as { git: typeof git };
    git = (mergeBranch(onMain.git, { "r/a.txt": "1\n2\n3" }, "feature", "t2") as { git: typeof git }).git;
    const move = pushPlan(git);
    assert.ok(typeof move !== "string");
    assert.equal(move.moveTo, sha("f"));
    assert.equal(move.expectSha, sha("a"));
    assert.deepEqual(move.commits, []);
  });
  it("refuses locally when GitHub's branch is ahead of this branch", () => {
    let git = linked();
    git = commit(add(git, { "r/a.txt": "local" }, ["."]).git, "local", "t1")!;
    const ahead = { ...git, remote: { ...git.remote!, tips: { main: sha("z") } } };
    assert.match(pushPlan(ahead) as string, /this project does not have: git pull first/);
  });
  it("needs a remote and a commit, and no merge in progress", () => {
    assert.match(pushPlan(init(EMPTY_GIT)) as string, /no remote/);
    assert.match(pushPlan(setRemote(init(EMPTY_GIT), "me/r", "")) as string, /no commits/);
  });
  it("subtree keeps only the folder, relative to it", () => {
    assert.deepEqual(subtree({ "a/x": "1", "ab/y": "2", "a/b/z": "3" }, "a"), { x: "1", "b/z": "3" });
  });
});

describe("pull snapshot and merge-commit pushes (E1)", () => {
  it("one commit from the net change, mapped to GitHub's tip; the push builds the merge on the pulled side", () => {
    let git = linked();
    git = commit(add(git, { "r/a.txt": "ONE\n2\n3" }, ["."]).git, "local", "t1")!;
    const snap = pullSnapshot(git, localIdOf(git, sha("a"))!, sha("b"), [{ path: "a.txt", content: "1\n2\nTHREE" }, { path: "new.txt", content: "n" }, { path: "asset.bin", content: null, unsupported: true }], "Pull", "t2");
    assert.ok(typeof snap !== "string");
    const tip = snap.git.commits.find((c) => c.id === snap.tip)!;
    assert.deepEqual(Object.keys(tip.tree!).sort(), ["r/a.txt", "r/new.txt"], "unheld unsupported files stay out of local trees");
    assert.deepEqual(snap.dropped, []);
    const merged = mergeBranch({ ...snap.git, branches: { ...snap.git.branches, upstream: snap.tip }, remote: { ...snap.git.remote!, tips: { main: sha("b") } } }, { "r/a.txt": "ONE\n2\n3" }, "upstream", "t3");
    assert.ok(typeof merged !== "string" && merged.conflicts.length === 0);
    const plan = pushPlan(merged.git);
    assert.ok(typeof plan !== "string");
    assert.equal(plan.expectSha, sha("b"));
    const merge = plan.commits[1];
    assert.deepEqual(merge.parents, [{ index: 0 }, { sha: sha("b") }]);
    assert.equal(merge.treeParent, 1, "built on GitHub's new tree, so files this browser lacks keep GitHub's version");
    assert.deepEqual(merge.changes, [{ path: "a.txt", content: "ONE\n2\nTHREE" }], "only our side's change, relative to the pulled tree");
  });
  it("drops a held file GitHub made unsupported, unless this branch changed it", () => {
    const git = linked({ "r/a.txt": "1", "r/big.txt": "small" });
    const base = localIdOf(git, sha("a"))!;
    const ok = pullSnapshot(git, base, sha("b"), [{ path: "big.txt", content: null, unsupported: true }], "Pull", "t1");
    assert.ok(typeof ok !== "string");
    assert.deepEqual(ok.dropped, ["r/big.txt"]);
    assert.equal("r/big.txt" in ok.git.commits.find((c) => c.id === ok.tip)!.tree!, false);
    const changed = commit(add(git, { "r/a.txt": "1", "r/big.txt": "edited" }, ["."]).git, "edit big", "t1")!;
    assert.match(pullSnapshot(changed, base, sha("b"), [{ path: "big.txt", content: null, unsupported: true }], "Pull", "t2") as string, /this branch changed it too/);
  });
  it("tree parent: covering side wins; both cover prefers one on GitHub; neither refuses", () => {
    const git = linked();
    const a = git.branches!.main!;
    const x = commit(add(git, { "r/a.txt": "x" }, ["."]).git, "x", "t1")!;
    assert.equal(treeParentOf(x, [x.branches!.main!, a]), 1, "both reach only aaaa: prefer the one on GitHub");
    const twoSides = { ...x, remote: { ...x.remote!, shas: { ...x.remote!.shas, [x.branches!.main!]: sha("c") } } };
    const y = { ...twoSides, commits: [{ id: "yyyyyyy", message: "y", time: "t", parent: a, tree: {} }, ...twoSides.commits], remote: { ...twoSides.remote!, shas: { ...twoSides.remote!.shas, yyyyyyy: sha("d") } } };
    assert.equal(treeParentOf(y, [y.branches!.main!, "yyyyyyy"]), null);
  });
});

describe("history safety", () => {
  it("a missing merge base is an error, never an empty base (E5b)", () => {
    let g = commit(add(init(EMPTY_GIT), { "a.txt": "keep", "b.txt": "b0" }, ["."]).git, "A", "t0")!;
    g = createBranch(g, "feature") as typeof g;
    g = commit(add(g, { "b.txt": "b0" }, ["."]).git, "delete a", "t1")!;
    for (let i = 0; i < 55; i++) g = commit(add(g, { "b.txt": `b${i + 1}` }, ["."]).git, `m${i}`, `t${i + 2}`)!;
    assert.equal(historyComplete(g, g.branches!.main), false);
    assert.match(mergeBranch(g, { "b.txt": "b55" }, "feature", "t99") as string, /no longer stored/);
  });
  it("trim keeps the commit GitHub's branch was last seen at", () => {
    let g = linked({ "r/a.txt": "0" });
    const cloneId = g.branches!.main!;
    for (let i = 0; i < 55; i++) g = commit(add(g, { "r/a.txt": `${i + 1}` }, ["."]).git, `m${i}`, `t${i}`)!;
    assert.ok(g.commits.some((c) => c.id === cloneId));
  });
  it("commitFiles commits only the given paths and keeps other staged work staged", () => {
    let g = commit(add(init(EMPTY_GIT), { "a.txt": "1" }, ["."]).git, "base", "t0")!;
    g = add(g, { "a.txt": "staged edit" }, ["a.txt"]).git;
    const done = commitFiles(g, { "repo/x.txt": "x" }, "Clone", "t1") as typeof g;
    assert.deepEqual(Object.keys(done.commits[0].tree!).sort(), ["a.txt", "repo/x.txt"]);
    assert.equal(blob(done, done.commits[0].tree!["a.txt"]), "1", "the staged edit is not in the clone commit");
    assert.equal(blob(done, done.index!["a.txt"]), "staged edit", "and stays staged");
  });
});

describe("untracked files are never overwritten (E2)", () => {
  // main: a.txt. feature adds notes.txt. On main the user writes an untracked notes.txt.
  const base = commit(add(init(EMPTY_GIT), { "a.txt": "1" }, ["."]).git, "base", "t0")!;
  const onFeature = commit(add({ ...(createBranch(base, "feature") as typeof base), branch: "feature" }, { "a.txt": "1", "notes.txt": "feature's notes" }, ["."]).git, "notes", "t1")!;
  const main = (switchBranch(onFeature, { "a.txt": "1", "notes.txt": "feature's notes" }, "main") as { git: typeof base }).git;
  const mine = { "a.txt": "1", "notes.txt": "MY NOTES" };
  it("switch refuses and names the file", () => {
    assert.match(switchBranch(main, mine, "feature") as string, /untracked file\(s\) would be overwritten: notes\.txt/);
  });
  it("fast-forward merge refuses", () => {
    assert.match(mergeBranch(main, mine, "feature", "t2") as string, /would be overwritten: notes\.txt/);
  });
  it("three-way merge (and so pull) refuses", () => {
    const diverged = commit(add(main, { "a.txt": "2" }, ["a.txt"]).git, "main work", "t2")!;
    assert.match(mergeBranch(diverged, { "a.txt": "2", "notes.txt": "MY NOTES" }, "feature", "t3") as string, /would be overwritten: notes\.txt/);
  });
  it("identical untracked contents are adopted, and unrelated untracked files are fine", () => {
    assert.ok(typeof switchBranch(main, { "a.txt": "1", "notes.txt": "feature's notes" }, "feature") !== "string");
    assert.ok(typeof switchBranch(main, { "a.txt": "1", "scratch.txt": "mine" }, "feature") !== "string");
    assert.deepEqual(untrackedCollisions(main, mine, [{ path: "notes.txt", content: null }]), ["notes.txt"]);
  });
});
