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

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8095";
let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function openApp({ clone } = {}) {
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
  return { page, sent, errors, term, saved, close: () => context.close() };
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
    assert.match(out, /not available/);
    const state = await app.saved();
    assert.equal(state.git.commits[0].message, "start");
    assert.ok(Object.keys(state.git.commits[0].tree).includes("src/neural_brain.py"));
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
    assert.match(text, /not a linked clone/);
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
