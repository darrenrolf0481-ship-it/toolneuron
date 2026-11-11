/**
 * Git history storage: it lives in IndexedDB, survives reloads, migrates
 * from saves that kept it in localStorage, and is no longer capped at 50
 * commits. Run against a dev server: npm run dev:vm, then npm run test:e2e.
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

async function open(seed) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((initial) => {
    if (sessionStorage.getItem("e2e-seeded")) return;
    sessionStorage.setItem("e2e-seeded", "1");
    localStorage.clear();
    if (initial) localStorage.setItem("crimson_os_v1", JSON.stringify(initial));
  }, seed ?? null);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const term = async (command) => {
    const box = page.getByLabel("Terminal command");
    await box.fill(command);
    await box.press("Enter");
    await page.waitForTimeout(60);
  };
  const terminal = () => page.locator(".os-scroll").first().innerText();
  const saved = async () => {
    await page.waitForTimeout(3500);
    return page.evaluate(() => JSON.parse(localStorage.getItem("crimson_os_v1") || "{}"));
  };
  return { page, errors, term, terminal, saved, close: () => context.close() };
}

describe("git history storage", () => {
  it("migrates a save that kept git in localStorage, then serves it from IndexedDB after a reload", async () => {
    const files = [
      { id: "root", name: "Project", type: "folder", parentId: null },
      { id: "a", name: "a.txt", type: "file", parentId: "root", content: "two" },
    ];
    // An old-format save: git (commits, blobs) inside localStorage.
    const blobOne = "one";
    const blobTwo = "two";
    const h1 = "00000000000aa1";
    const h2 = "00000000000aa2";
    const git = {
      initialized: true,
      branch: "main",
      staged: [],
      index: { "a.txt": h2 },
      blobs: { [h1]: blobOne, [h2]: blobTwo },
      branches: { main: "c000002" },
      commits: [
        { id: "c000002", message: "second (old save)", time: "t2", parent: "c000001", tree: { "a.txt": h2 } },
        { id: "c000001", message: "first (old save)", time: "t1", tree: { "a.txt": h1 } },
      ],
    };
    const app = await open({ tab: "terminal", files, activeFileId: "a", draft: "two", git });
    const state = await app.saved();
    assert.equal(state.git, undefined, "migrated out of localStorage");
    assert.equal(state.gitInIndexedDb, true);
    const db = await readGitDb(app.page);
    assert.deepEqual(db.meta.commits.map((c) => c.message), ["second (old save)", "first (old save)"]);
    assert.equal(db.blobs, 2);
    await app.page.reload({ waitUntil: "networkidle" });
    await app.page.waitForTimeout(600);
    await app.page.getByRole("button", { name: "Term" }).first().click();
    await app.term("git log");
    await app.term("git show HEAD~1");
    const text = await app.terminal();
    assert.match(text, /second \(old save\)[\s\S]*first \(old save\)/);
    assert.match(text, /\+one/, "blob contents come back from IndexedDB");
    assert.deepEqual(app.errors, []);
    await app.close();
  });

  it("keeps more than the old 50-commit cap across a reload, with localStorage staying small", async () => {
    const app = await open();
    await app.page.getByRole("button", { name: "Edit" }).first().click();
    await app.page.getByRole("button", { name: "Term" }).first().click();
    await app.term("git init");
    // Type into the open file and commit, 55 times.
    const N = 55;
    for (let i = 0; i < N; i++) {
      await app.page.getByRole("button", { name: "Edit" }).first().click();
      await app.page.locator(".cm-content").click();
      await app.page.keyboard.press("Control+End");
      await app.page.keyboard.type(`\n# ${i}`);
      await app.page.getByRole("button", { name: "Term" }).first().click();
      await app.term("git add .");
      await app.term(`git commit -m "commit ${i}"`);
    }
    const state = await app.saved();
    const db = await readGitDb(app.page);
    assert.equal(db.meta.commits.length, N);
    assert.ok(JSON.stringify(state).length < 60_000, `localStorage holds ${JSON.stringify(state).length} chars`);
    await app.page.reload({ waitUntil: "networkidle" });
    await app.page.waitForTimeout(600);
    await app.page.getByRole("button", { name: "Term" }).first().click();
    await app.term("git log -n 100");
    const text = await app.terminal();
    assert.match(text, new RegExp(`commit ${N - 1}`));
    assert.match(text, /commit 0\b/, "the oldest commit is still there");
    assert.deepEqual(app.errors, []);
    await app.close();
  });
  it("a commit made right before a reload is not lost (the IndexedDB write can be cut off)", async () => {
    const app = await open();
    await app.page.getByRole("button", { name: "Term" }).first().click();
    await app.term("git init");
    await app.term("git add .");
    await app.term('git commit -m "just before reload"');
    // No waiting for the debounce or the IndexedDB write.
    await app.page.reload({ waitUntil: "networkidle" });
    await app.page.waitForTimeout(800);
    await app.page.getByRole("button", { name: "Term" }).first().click();
    await app.term("git log");
    assert.match(await app.terminal(), /just before reload/);
    const pending = await app.page.evaluate(() => localStorage.getItem("crimson_os_v1_git_pending"));
    assert.equal(pending, null, "the emergency copy is cleared once IndexedDB has it");
    await app.close();
  });
});
