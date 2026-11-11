/**
 * Browser tests for the parts that used to be simulated: git history,
 * cloning, the terminal's help, and knowledge-pack search. /api/chat and
 * /api/clone are faked in the page, so no key or network is needed.
 *
 * Run against a dev server: npm run dev:vm, then npm run test:e2e.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";
import { readGitDb } from "./helpers.mjs";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8095";
let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function openApp({ clone, push, fetch: fetchReply } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const sent = [];
  await page.route("**/api/chat", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/x-ndjson", body: `${JSON.stringify({ t: "delta", v: "OK." })}\n${JSON.stringify({ t: "done", provider: "fake", model: "fake" })}\n` });
  });
  await page.route("**/api/clone", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(clone ?? { ok: false, error: "no fake set" }) });
  });
  const pushes = [];
  await page.route("**/api/git/push", async (route) => {
    pushes.push(route.request().postDataJSON());
    const reply = typeof push === "function" ? push(pushes.at(-1)) : (push ?? { ok: false, error: "no fake set" });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(reply) });
  });
  await page.route("**/api/git/fetch", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fetchReply ?? { ok: false, error: "no fake set" }) });
  });
  await page.addInitScript(() => {
    if (sessionStorage.getItem("e2e-seeded")) return;
    sessionStorage.setItem("e2e-seeded", "1");
    localStorage.clear();
  });
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const term = async (command) => {
    const box = page.getByLabel("Terminal command");
    await box.fill(command);
    await box.press("Enter");
    await page.waitForTimeout(150);
    return page.locator(".os-scroll").filter({ has: page.locator("p") }).first().innerText();
  };
  const saved = async () => {
    await page.waitForTimeout(3500);
    return page.evaluate(() => JSON.parse(localStorage.getItem("crimson_os_v1") || "{}"));
  };
  return { page, sent, pushes, errors, term, saved, close: () => context.close() };
}

describe("terminal git", () => {
  it("commits real snapshots, shows diffs of the live draft, and restores", async () => {
    const app = await openApp();
    await app.page.getByRole("button", { name: "Term" }).first().click();
    let out = await app.term("help");
    assert.match(out, /This is not a shell/);
    await app.term("git init");
    await app.term("git add .");
    out = await app.term('git commit -m "start"');
    assert.match(out, /\[SUCCESS\] \[main [0-9a-f]{7}\] start/);
    // Edit the open file in the editor without leaving it, then diff from the terminal.
    await app.page.getByRole("button", { name: "Edit" }).first().click();
    await app.page.locator(".cm-content").click();
    await app.page.keyboard.press("Control+Home");
    await app.page.keyboard.type("# e2e edit\n");
    await app.page.getByRole("button", { name: "Term" }).first().click();
    out = await app.term("git status");
    assert.match(out, /Changes not staged[\s\S]*modified\s+src\/neural_brain\.py/);
    out = await app.term("git diff");
    assert.match(out, /\+# e2e edit/);
    out = await app.term("git restore project/src/neural_brain.py");
    assert.match(out, /1 file\(s\) restored/);
    out = await app.term("git status");
    assert.match(out.split("git status").at(-1), /working tree clean/);
    out = await app.term("git push");
    assert.match(out, /no remote/);
    out = await app.term("git pull");
    assert.match(out, /no remote to pull from/);
    const state = await app.saved();
    assert.equal(state.git, undefined, "git history is not in localStorage any more");
    assert.equal(state.gitInIndexedDb, true);
    const { meta } = await readGitDb(app.page);
    assert.equal(meta.commits[0].message, "start");
    assert.ok(Object.keys(meta.commits[0].tree).includes("src/neural_brain.py"));
    assert.ok(!state.files.find((f) => f.name === "neural_brain.py").content.startsWith("# e2e edit"), "restore wrote the file back");
    assert.deepEqual(app.errors, []);
    await app.close();
  });
});

describe("editor git panel", () => {
  it("lists changes with a diff, stages all and commits", async () => {
    const app = await openApp();
    await app.page.getByRole("button", { name: "Edit" }).first().click();
    await app.page.getByRole("button", { name: "git", exact: true }).click();
    await app.page.getByRole("button", { name: "git init" }).click();
    const changes = app.page.getByRole("region", { name: "Changes not staged" });
    assert.match(await changes.innerText(), /untracked/);
    await changes.getByRole("button", { name: /neural_brain\.py/ }).click();
    assert.match(await changes.innerText(), /new file/);
    await app.page.getByRole("button", { name: "Stage all" }).click();
    assert.match(await app.page.getByRole("region", { name: "Staged changes" }).innerText(), /added/);
    await app.page.getByLabel("Commit message").fill("from the panel");
    await app.page.getByRole("button", { name: "Commit" }).click();
    const history = await app.page.getByRole("region", { name: "History" }).innerText();
    assert.match(history, /from the panel/);
    assert.match(history, /\d+ file\(s\)/);
    await app.close();
  });
});

describe("clone", () => {
  it("copies the returned files into a new folder and says it is a copy", async () => {
    const app = await openApp({
      clone: { ok: true, repo: "octo/demo", files: [{ path: "README.md", content: "# demo\n" }, { path: "src/app.py", content: "print('hi')\n" }], skipped: { binary: 2, tooLarge: 0, ignoredFolder: 1, overLimit: 0 } },
    });
    await app.page.getByRole("button", { name: "Term" }).first().click();
    const out = await app.term("gh repo clone octo/demo");
    await app.page.waitForTimeout(400);
    const text = await app.page.locator(".os-scroll").first().innerText();
    assert.match(out + text, /Copied 2 text file\(s\) from github\.com\/octo\/demo into project\/demo\//);
    assert.match(text, /left out: 2 binary, 1 ignored folder/);
    assert.match(text, /plain copy with no link back/);
    assert.match(await app.term("cat project/demo/src/app.py"), /print\('hi'\)/);
    assert.match(await app.term("gh repo clone demo"), /needs a public GitHub repo/);
    await app.close();
  });
  it("shows the server's error", async () => {
    const app = await openApp({ clone: { ok: false, error: "octo/private was not found. It may be private" } });
    await app.page.getByRole("button", { name: "Term" }).first().click();
    await app.term("gh repo clone octo/private");
    await app.page.waitForTimeout(400);
    assert.match(await app.page.locator(".os-scroll").first().innerText(), /\[ERROR\] octo\/private was not found/);
    await app.close();
  });
});

describe("knowledge packs", () => {
  it("sends the matching section of an uploaded file, not just its start", async () => {
    const app = await openApp();
    await app.page.getByRole("button", { name: "Hub" }).first().click();
    await app.page.getByRole("button", { name: /^Database$/ }).first().click();
    const filler = "Unrelated setup text for padding. ".repeat(40);
    const manual = `Intro. ${filler}\n\nBilling. ${filler}\n\nRefunds. Refunds are paid within 14 days to the original card. ${filler}`;
    await app.page.locator('input[type="file"][accept*=".md"]').setInputFiles({ name: "manual.md", mimeType: "text/markdown", buffer: Buffer.from(manual) });
    await app.page.waitForTimeout(300);
    assert.match(await app.page.getByText(/manual\.md/).first().locator("..").innerText(), /section\(s\), searched per message/);
    await app.page.getByRole("button", { name: /^Chat$/ }).first().click();
    const box = app.page.getByPlaceholder(/Directive/);
    await box.fill("How long do refunds take?");
    await box.press("Enter");
    await app.page.waitForFunction(() => !document.querySelector('button[aria-label="Stop reply"]'));
    await app.page.waitForTimeout(200);
    const system = app.sent.at(-1).system;
    assert.match(system, /Knowledge \(sections of the user's packs that match this message\):/);
    assert.match(system, /\[manual\.md §\d+\]\nRefunds\. Refunds are paid within 14 days/);
    await app.close();
  });
});

describe("branches and push", () => {
  const sha = (c) => c.repeat(40);
  it("a linked clone pushes only new commits, as changes inside the repo, then is up to date", async () => {
    let n = 0;
    const app = await openApp({
      clone: { ok: true, repo: "me/site", linked: true, sha: sha("a"), branch: "main", private: true, files: [{ path: "index.html", content: "<h1>v1</h1>\n" }], skipped: { binary: 1, tooLarge: 0, ignoredFolder: 0, overLimit: 0 } },
      push: (plan) => {
        const shas = plan.commits.map(() => sha(String(++n)));
        return { ok: true, shas, tip: shas.at(-1), url: "https://github.com/me/site/tree/main", created: false };
      },
    });
    await app.page.getByRole("button", { name: "Term" }).first().click();
    await app.term("gh repo clone me/site");
    await app.page.waitForTimeout(400);
    let out = await app.term("git remote");
    assert.match(out, /Linked: project\/site\/ pushes to me\/site \(main → main\)/);
    assert.match(out, /origin +https:\/\/github\.com\/me\/site +\(folder: project\/site\)/);
    assert.match(await app.term("git push"), /Everything up-to-date/);
    // Edit the cloned file (and a file outside the repo folder) and commit both.
    await app.term("cat project/site/index.html");
    await app.page.getByRole("button", { name: "Edit" }).first().click();
    await app.page.getByText("index.html", { exact: true }).click();
    await app.page.locator(".cm-content").click();
    await app.page.keyboard.press("Control+End");
    await app.page.keyboard.type("<p>edited</p>");
    await app.page.getByRole("button", { name: "Term" }).first().click();
    await app.term("git add .");
    await app.term('git commit -m "edit the page"');
    out = await app.term("git push");
    await app.page.waitForTimeout(400);
    assert.equal(app.pushes.length, 1);
    const plan = app.pushes[0];
    assert.equal(plan.repo, "me/site");
    assert.equal(plan.branch, "main");
    assert.equal(plan.expectSha, sha("a"));
    assert.deepEqual(plan.commits[0].parents, [{ sha: sha("a") }]);
    assert.equal(plan.commits.length, 1);
    assert.deepEqual(plan.commits[0].changes.map((c) => c.path), ["index.html"], "only paths inside the repo folder, relative to it");
    assert.match(plan.commits[0].changes[0].content, /<p>edited<\/p>/);
    const text = await app.page.locator(".os-scroll").first().innerText();
    assert.match(text, /Updated me\/site main: 1 commit\(s\), now at 1111111/);
    assert.match(await app.term("git push"), /Everything up-to-date/);
    await app.close();
  });

  it("shows a refused push and keeps the commits unpushed", async () => {
    const app = await openApp({
      clone: { ok: true, repo: "me/site", linked: true, sha: sha("a"), branch: "main", files: [{ path: "a.txt", content: "1" }], skipped: {} },
      push: { ok: false, error: "Rejected: me/site 'main' has commits this project does not have (not a fast-forward)." },
    });
    await app.page.getByRole("button", { name: "Term" }).first().click();
    await app.term("gh repo clone me/site");
    await app.page.waitForTimeout(400);
    await app.page.getByRole("button", { name: "Edit" }).first().click();
    await app.page.getByRole("button", { name: "git", exact: true }).click();
    // Make a change through the terminal-free path: new branch, commit from the panel.
    await app.page.getByLabel("New branch name").fill("fix");
    await app.page.getByRole("button", { name: "Create" }).click();
    assert.equal(await app.page.locator("#git-branch").inputValue(), "fix");
    await app.page.getByRole("button", { name: "code", exact: true }).click();
    await app.page.getByText("a.txt", { exact: true }).click();
    await app.page.locator(".cm-content").click();
    await app.page.keyboard.type("2");
    await app.page.getByRole("button", { name: "git", exact: true }).click();
    await app.page.getByRole("button", { name: "Stage all" }).click();
    await app.page.getByLabel("Commit message").fill("fix a");
    await app.page.getByRole("button", { name: "Commit" }).click();
    await app.page.getByRole("button", { name: /Push 1 commit\(s\)/ }).click();
    await app.page.waitForTimeout(400);
    assert.match(await app.page.getByRole("status").last().innerText(), /Rejected: .*not a fast-forward/);
    assert.equal(app.pushes[0].branch, "fix", "a new local branch pushes to the same name");
    assert.ok(await app.page.getByRole("button", { name: /Push 1 commit\(s\)/ }).isVisible(), "still unpushed");
    // Switching back to main restores main's contents.
    await app.page.locator("#git-branch").selectOption("main");
    await app.page.waitForTimeout(200);
    // main's commit (the clone) tracks only site/; fix also committed the starter files,
    // so like real git, switching to main takes them out of the working files.
    assert.match(await app.page.getByRole("status").last().innerText(), /Switched to main: 5 file\(s\) updated/);
    let state = await app.saved();
    assert.equal(state.files.find((f) => f.name === "a.txt").content, "1");
    assert.equal(state.files.some((f) => f.name === "neural_brain.py"), false);
    await app.page.locator("#git-branch").selectOption("fix");
    state = await app.saved();
    assert.equal(state.files.find((f) => f.name === "a.txt").content, "12", "fix keeps its edit");
    assert.ok(state.files.some((f) => f.name === "neural_brain.py"), "back on fix, the committed starter files return");
    await app.close();
  });
});

describe("pull and merge conflicts", () => {
  const sha = (c) => c.repeat(40);
  it("pull brings a conflict; resolving it in the Git tab and pushing sends a merge commit", async () => {
    const app = await openApp({
      clone: { ok: true, repo: "me/site", linked: true, sha: sha("a"), branch: "main", files: [{ path: "page.txt", content: "title\nbody\nfooter" }], skipped: {} },
      fetch: { ok: true, tip: sha("b"), ahead: 1, subjects: ["Edit on GitHub"], changes: [{ path: "page.txt", content: "title\nBODY FROM GITHUB\nfooter" }] },
      push: (plan) => {
        const shas = plan.commits.map((_, i) => String(i + 1).repeat(40));
        return { ok: true, shas, tip: shas.at(-1), url: "https://github.com/me/site/tree/main", created: false };
      },
    });
    await app.page.getByRole("button", { name: "Term" }).first().click();
    await app.term("gh repo clone me/site");
    await app.page.waitForTimeout(400);
    // A local edit to the same line, committed.
    await app.page.getByRole("button", { name: "Edit" }).first().click();
    await app.page.getByText("page.txt", { exact: true }).click();
    await app.page.locator(".cm-content").click();
    await app.page.keyboard.press("Control+a");
    await app.page.keyboard.type("title\nbody edited here\nfooter");
    await app.page.getByRole("button", { name: "Term" }).first().click();
    await app.term("git add .");
    await app.term('git commit -m "local edit"');
    await app.term("git pull");
    await app.page.waitForTimeout(600);
    const text = await app.page.locator(".os-scroll").first().innerText();
    assert.match(text, /Fetched 1 commit\(s\) from GitHub: Edit on GitHub/);
    assert.match(text, /CONFLICT in site\/page\.txt/);
    assert.match(await app.term("cat project/site/page.txt"), /<<<<<<< ours[\s\S]*body edited here[\s\S]*=======[\s\S]*BODY FROM GITHUB[\s\S]*>>>>>>> theirs/);
    // Resolve in the editor, mark fixed and commit from the Git tab.
    await app.page.getByRole("button", { name: "Edit" }).first().click();
    await app.page.getByRole("button", { name: "code", exact: true }).click();
    await app.page.locator(".cm-content").click();
    await app.page.keyboard.press("Control+a");
    await app.page.keyboard.type("title\nbody edited here, plus GitHub's\nfooter");
    await app.page.getByRole("button", { name: "git", exact: true }).click();
    const banner = app.page.getByRole("region", { name: "Merge in progress" });
    assert.match(await banner.innerText(), /site\/page\.txt/);
    await banner.getByRole("button", { name: "Mark fixed" }).click();
    assert.match(await banner.innerText(), /All conflicts are staged/);
    await app.page.getByRole("button", { name: "Commit merge" }).click();
    assert.equal(await banner.count(), 0);
    await app.page.getByRole("button", { name: /Push 2 commit\(s\)/ }).click();
    await app.page.waitForTimeout(500);
    const plan = app.pushes[0];
    assert.equal(plan.expectSha, sha("b"), "fast-forward from what GitHub has now");
    assert.deepEqual(plan.commits.map((c) => c.parents), [[{ sha: sha("a") }], [{ index: 0 }, { sha: sha("b") }]]);
    assert.equal(plan.commits[1].treeParent, 1, "the merge is built on GitHub's side (E1)");
    assert.match(plan.commits[1].changes[0].content, /plus GitHub's/);
    assert.deepEqual(app.errors, []);
    await app.close();
  });
});
