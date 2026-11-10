/**
 * Browser tests for chat modes, skills, handoff notes and cut-off replies.
 *
 * The AI is faked: /api/chat is intercepted in the browser and answered with
 * a scripted NDJSON stream, so these tests need no access key, cost nothing
 * and give the same result every run. They check what the app sends and how
 * it shows the reply, not what a model would say.
 *
 * Run against a dev server:  npm run dev:vm   then   npm run test:e2e
 * BASE_URL defaults to http://localhost:8095 (passkeys need localhost, not 127.0.0.1).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8095";
const OLD_WELCOME =
  "Neural interface up. I am running as the Architect. Files stay in this browser. Ask about the open file, or switch personalities in the header.";

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

/**
 * A page with a fresh (or given) save and a fake AI. `replies` is a queue of
 * { text, cut?, error?, note? }; each /api/chat call takes the next one. Requests
 * are recorded in `sent`.
 */
async function openApp({ save = null, replies = [], width = 1280 } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const sent = [];
  await page.route("**/api/chat", async (route) => {
    sent.push(route.request().postDataJSON());
    const next = replies.shift() ?? { text: "OK." };
    const lines = [];
    if (next.note) lines.push({ t: "note", v: next.note });
    if (next.text) lines.push({ t: "delta", v: next.text });
    if (next.error) lines.push({ t: "error", v: next.error });
    lines.push({ t: "done", provider: "fake", model: "fake-model", cut: Boolean(next.cut) });
    await route.fulfill({ status: 200, contentType: "application/x-ndjson", body: lines.map((line) => JSON.stringify(line)).join("\n") + "\n" });
  });
  await page.addInitScript((initial) => {
    if (sessionStorage.getItem("e2e-seeded")) return;
    sessionStorage.setItem("e2e-seeded", "1");
    localStorage.clear();
    if (initial) localStorage.setItem("crimson_os_v1", JSON.stringify(initial));
  }, save);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const app = {
    page,
    sent,
    errors,
    saved: () => page.evaluate(() => JSON.parse(localStorage.getItem("crimson_os_v1") || "{}")),
    mode: (name) => page.getByLabel("Personality").selectOption({ label: name }),
    chat: async () => {
      await page.getByRole("button", { name: "Hub" }).first().click();
      await page.getByRole("button", { name: /^Chat$/ }).first().click();
    },
    /** Sends a message and waits for the reply to finish. */
    ask: async (text) => {
      const before = sent.length;
      const box = page.getByPlaceholder(/Directive/);
      await box.fill(text);
      await box.press("Enter");
      await waitIdle(page, () => sent.length > before);
      return sent.at(-1);
    },
    banner: () => page.getByRole("status", { name: "Pinned handoff" }),
    close: () => context.close(),
  };
  return app;
}

async function waitIdle(page, sentCheck) {
  for (let i = 0; i < 100 && !sentCheck(); i++) await page.waitForTimeout(50);
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Stop reply"]'));
  await page.waitForTimeout(150);
}

describe("boot and skills", () => {
  it("shows a mode-neutral welcome with no Hand off button, and credits for all 12 modes", async () => {
    const app = await openApp({ width: 390 });
    await app.chat();
    const log = app.page.getByRole("log", { name: "Chat" });
    assert.match(await log.innerText(), /Pick a mode in the header/);
    assert.equal(await app.page.getByRole("button", { name: "Hand off" }).count(), 0);
    await app.page.getByRole("button", { name: "Config" }).first().click();
    await app.page.getByText("Skills by mode").click();
    const modes = await app.page.evaluate(() => {
      const section = [...document.querySelectorAll("section")].find((s) => s.textContent.includes("Skills by mode"));
      return [...section.querySelectorAll("ul:first-of-type > li")].map((li) => [li.children[0].textContent, li.children[1].textContent]);
    });
    assert.equal(modes.length, 12);
    assert.deepEqual(modes.filter(([, skills]) => /No skills/.test(skills)), []);
    assert.equal(await app.page.locator('a[href*="agentic-awesome-skills/tree/"]').count(), 38);
    assert.equal(await app.page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, "no sideways scroll at phone width");
    assert.deepEqual(app.errors, []);
    await app.close();
  });

  it("upgrades an old save: neutral welcome, defaults for empty built-in modes, custom skills kept", async () => {
    const mode = (id, name, skills, active = false) => ({ id, name, instruction: `You are ${name}.`, active, suggestions: [], skills });
    const app = await openApp({
      save: {
        tab: "toolneuron",
        module: "chat",
        chat: [{ role: "ai", text: OLD_WELCOME, timestamp: 1 }],
        personalities: [mode(1, "Architect", ["codebase-design"], true), mode(10, "Nightwatch", [])],
      },
    });
    const saved = async () => {
      await app.mode("Nightwatch"); // any change triggers a save
      await app.page.waitForTimeout(3500);
      return app.saved();
    };
    const state = await saved();
    assert.equal(state.chat[0].intro, true);
    assert.doesNotMatch(state.chat[0].text, /Architect/);
    assert.equal(state.personalities.find((p) => p.name === "Nightwatch").skills[0], "error-detective");
    assert.deepEqual(state.personalities.find((p) => p.name === "Architect").skills, ["codebase-design"]);
    await app.close();
  });
});

describe("handoff notes", () => {
  it("pins a reply for the next mode, labels it, and strips a copied label", async () => {
    const app = await openApp({
      replies: [{ text: "1. Guard empty lists.\nNext command: add the guard." }, { text: "[Reply from Syntax-Prime mode]\n```python\nif not xs: return 0\n```" }, { text: "Noted." }, { text: "OK." }],
    });
    await app.mode("Architect");
    await app.chat();
    await app.ask("Plan the fix.");
    assert.equal(await app.page.getByText(/^From Architect$/).count(), 1);
    await app.page.getByRole("button", { name: "Hand off" }).last().click();
    assert.match(await app.banner().innerText(), /Handoff from Architect pinned/);

    await app.mode("Syntax-Prime");
    await app.chat();
    assert.match(await app.banner().innerText(), /Syntax-Prime reads it/);
    const request = await app.ask("Do the next command from the handoff.");
    assert.match(request.system, /Handoff note from Architect mode \(handoff\.md\)/);
    assert.match(request.system, /Open file neural_brain\.py:/);
    assert.ok(request.messages.some((m) => m.content.startsWith("[Reply from Architect mode]\n1. Guard")));
    const shown = await app.page.getByRole("log", { name: "Chat" }).innerText();
    assert.doesNotMatch(shown, /\[Reply from Syntax-Prime mode\]/, "copied label is stripped");
    assert.equal(await app.page.getByText(/^From Syntax-Prime$/).count(), 1);

    // Edit opens the note; the code file is still sent alongside it.
    await app.banner().getByRole("button", { name: "Edit" }).click();
    await app.chat();
    const withNoteOpen = await app.ask("Next?");
    assert.match(withNoteOpen.system, /Working file neural_brain\.py \(the user has handoff\.md open in the editor\):/);
    assert.equal(withNoteOpen.system.split("Guard empty lists").length - 1, 1, "note sent once");

    await app.banner().getByRole("button", { name: "Clear" }).click();
    assert.equal(await app.banner().count(), 0);
    const cleared = await app.ask("Anything pinned?");
    assert.doesNotMatch(cleared.system, /Handoff note/);
    await app.page.waitForTimeout(3500);
    assert.equal((await app.saved()).files.some((f) => f.name === "handoff.md"), false);
    assert.deepEqual(app.errors, []);
    await app.close();
  });
});

describe("cut-off replies", () => {
  it("flags a reply that hit the token limit, offers Continue, and marks the handoff", async () => {
    const app = await openApp({ replies: [{ text: "1. one\n2. two\n3. th", cut: true }, { text: "ree\n4. four" }] });
    await app.chat();
    await app.ask("List many things.");
    assert.equal(await app.page.getByText(/^Cut off at the length limit/).count(), 1);
    await app.page.getByRole("button", { name: "Hand off" }).last().click();
    await app.page.waitForTimeout(3500);
    assert.match((await app.saved()).files.find((f) => f.name === "handoff.md").content, /\[This reply was cut off at the length limit\.\]/);
    const before = app.sent.length;
    await app.page.getByRole("button", { name: "Continue" }).click();
    await waitIdle(app.page, () => app.sent.length > before);
    assert.match(app.sent.at(-1).messages.at(-1).content, /^Continue exactly where your last reply stopped/);
    assert.equal(await app.page.getByRole("button", { name: "Continue" }).count(), 0, "Continue only on the latest reply");
    await app.close();
  });

  it("shows which provider answered when the chosen one failed first", async () => {
    const app = await openApp({ replies: [{ note: "Answered by OpenRouter. OmniRoute: rate limit (HTTP 429).", text: "200 OK means success." }] });
    await app.chat();
    await app.ask("Name a status code.");
    assert.match(await app.page.getByRole("log", { name: "Chat" }).innerText(), /Answered by OpenRouter\. OmniRoute: rate limit/);
    await app.close();
  });

  it("shows a provider error as a notice that is never sent back as history", async () => {
    const app = await openApp({ replies: [{ error: "Fake spent its whole token budget thinking and wrote no answer." }, { text: "OK." }] });
    await app.chat();
    await app.ask("Hello?");
    assert.match(await app.page.getByRole("log", { name: "Chat" }).innerText(), /whole token budget thinking/);
    const next = await app.ask("Second try.");
    assert.ok(!next.messages.some((m) => /token budget|Hello\?/.test(m.content)), "the notice and the refused turn are left out");
    await app.close();
  });
});
