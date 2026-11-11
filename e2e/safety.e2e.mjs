/**
 * Step 5 safety checks in the browser: file names, two tabs, and a chat
 * reply that is cut off. The AI is faked in the page.
 * Run against a dev server: npm run dev:vm, then npm run test:e2e.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";
import { gotoApp, reloadApp } from "./helpers.mjs";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8095";
let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function fresh(context) {
  const page = await context.newPage();
  await gotoApp(page, BASE_URL);
  await page.waitForTimeout(600);
  return page;
}

describe("file names", () => {
  it("refuses a duplicate name and a name with a slash, and says why", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 844 } });
    const page = await fresh(context);
    await page.evaluate(() => localStorage.clear());
    await reloadApp(page);
    await page.getByRole("button", { name: "Edit" }).first().click();
    await page.getByRole("button", { name: "New file" }).first().click();
    const input = page.getByLabel("New file name");
    await input.fill("src");
    await input.press("Enter");
    assert.match(await page.getByRole("alert").filter({ hasText: "already here" }).innerText(), /A folder named "src" is already here/);
    await input.fill("a/b.py");
    await input.press("Enter");
    assert.match(await page.getByRole("alert").filter({ hasText: "cannot contain" }).innerText(), /cannot contain \//);
    await input.fill("fine.py");
    await input.press("Enter");
    await page.waitForTimeout(200);
    assert.equal(await page.getByLabel("New file name").count(), 0, "a valid name closes the form");
    await context.close();
  });
});

describe("two tabs", () => {
  it("a tab whose project was saved by another tab stops saving and says so", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 844 } });
    const a = await fresh(context);
    await a.evaluate(() => localStorage.clear());
    await reloadApp(a);
    await a.waitForTimeout(600);
    const b = await fresh(context);
    // Tab B changes the project (switch to the terminal, run a command) and saves.
    await b.getByRole("button", { name: "Term" }).first().click();
    await b.getByLabel("Terminal command").fill("echo from tab B");
    await b.getByLabel("Terminal command").press("Enter");
    await b.waitForTimeout(3800);
    const fromB = await b.evaluate(() => localStorage.getItem("crimson_os_v1"));
    assert.match(fromB, /from tab B/);
    // Tab A is told, and its own later changes do not overwrite B's save.
    const banner = a.getByRole("alert", { name: "Save problem" });
    await banner.waitFor({ timeout: 5000 });
    assert.match(await banner.innerText(), /changed in another tab/);
    await a.getByRole("button", { name: "Term" }).first().click();
    await a.getByLabel("Terminal command").fill("echo from tab A");
    await a.getByLabel("Terminal command").press("Enter");
    await a.waitForTimeout(3800);
    const after = await a.evaluate(() => localStorage.getItem("crimson_os_v1"));
    assert.match(after, /from tab B/);
    assert.doesNotMatch(after, /from tab A/);
    await context.close();
  });
});

describe("chat stream", () => {
  it("a reply that stops before the end keeps its text and shows an error", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 844 } });
    const page = await context.newPage();
    await page.route("**/api/chat", (route) =>
      // A delta, then the connection ends: no "done" event.
      route.fulfill({ status: 200, contentType: "application/x-ndjson", body: `${JSON.stringify({ t: "delta", v: "Half an ans" })}\n` }),
    );
    await gotoApp(page, BASE_URL);
    await page.evaluate(() => localStorage.clear());
    await reloadApp(page);
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "Hub" }).first().click();
    await page.getByRole("button", { name: /^Chat$/ }).first().click();
    const box = page.getByPlaceholder(/Directive/);
    await box.fill("Explain something.");
    await box.press("Enter");
    await page.waitForFunction(() => !document.querySelector('button[aria-label="Stop reply"]'));
    await page.waitForTimeout(300);
    const log = await page.getByRole("log", { name: "Chat" }).innerText();
    assert.match(log, /Half an ans/);
    assert.match(log, /ended before it finished/);
    await context.close();
  });
});
