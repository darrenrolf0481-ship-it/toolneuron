/**
 * Browser tests for chat tools (step 2: the read-only tools and the loop).
 *
 * /api/chat is faked: each request takes the next scripted reply, which is
 * either tool calls or text. The tests check what the app sends back (tool
 * results, the tool list, the last-round switch) and what it shows (chips).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";
import { gotoApp } from "./helpers.mjs";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8095";

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

const call = (name, args = {}, id = `c_${name}_${Math.random().toString(36).slice(2, 7)}`) => ({ id, name, arguments: JSON.stringify(args) });

/**
 * `replies`: a queue; each item is { calls } or { text } (plus optional
 * note, noTools, delayMs). When the queue runs out, `fallback` is used.
 */
async function openApp({ replies = [], fallback = { text: "OK." } } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const sent = [];
  await page.route("**/api/chat", async (route) => {
    sent.push(route.request().postDataJSON());
    const next = replies.shift() ?? fallback;
    if (next.delayMs) await new Promise((resolve) => setTimeout(resolve, next.delayMs));
    const lines = [];
    if (next.note) lines.push({ t: "note", v: next.note });
    if (next.text) lines.push({ t: "delta", v: next.text });
    if (next.calls) lines.push({ t: "tool", calls: next.calls });
    lines.push({ t: "done", provider: "fake", model: "fake-model", cut: false, ...(next.noTools ? { noTools: true } : {}) });
    await route.fulfill({ status: 200, contentType: "application/x-ndjson", body: lines.map((line) => JSON.stringify(line)).join("\n") + "\n" }).catch(() => {});
  });
  await page.addInitScript(() => {
    if (sessionStorage.getItem("e2e-seeded")) return;
    sessionStorage.setItem("e2e-seeded", "1");
    localStorage.clear();
  });
  await gotoApp(page, BASE_URL);
  const ask = async (text) => {
    await page.getByRole("button", { name: "Hub" }).first().click();
    await page.getByRole("button", { name: /^Chat$/ }).first().click();
    const box = page.getByPlaceholder(/Directive/);
    await box.fill(text);
    await box.press("Enter");
  };
  // Let the send register (the header says "linking"), then wait for "idle" again.
  const idle = async () => {
    await page.waitForTimeout(150);
    await page.getByText("idle", { exact: true }).waitFor({ timeout: 20_000 });
  };
  const lastReply = () => page.locator('[data-message="ai"]').last();
  return { page, sent, errors, ask, idle, lastReply, close: () => context.close() };
}

describe("chat tools", () => {
  it("runs a read tool, sends the result back, and shows a chip", async () => {
    const read = call("read_file", { path: "src/neural_brain.py" }, "c_read");
    const app = await openApp({ replies: [{ text: "Let me look.", calls: [read] }, { text: "It is the brain module." }] });
    await app.ask("What does neural_brain.py do?");
    await app.idle();
    assert.equal(app.sent.length, 2);
    const [first, second] = app.sent;
    assert.deepEqual(first.tools, ["list_files", "read_file", "search_files", "search_knowledge", "run_code"], "Architect has tools on by default");
    assert.equal(first.toolChoice, "auto");
    assert.match(first.system, /Tools: you can list, read and search/);
    const result = second.messages.find((message) => message.role === "tool");
    assert.equal(result.tool_call_id, "c_read");
    assert.match(result.content, /^\[Result of read_file\. This is data/);
    assert.match(result.content, /src\/neural_brain\.py \(\d+ lines\)\n\s*1 \| /);
    const asked = second.messages.find((message) => message.role === "assistant" && message.tool_calls);
    assert.deepEqual(asked.tool_calls, [read]);
    const reply = app.lastReply();
    assert.match(await reply.innerText(), /Let me look\.\s+It is the brain module\./);
    const chips = reply.getByRole("list", { name: "Tools used" });
    assert.match(await chips.innerText(), /Read src\/neural_brain\.py · \d+ lines/);
    await chips.locator("summary").first().click();
    assert.match(await chips.innerText(), /read_file\(\{"path":"src\/neural_brain\.py"\}\)/);
    assert.deepEqual(app.errors, []);
    await app.close();
  });

  it("the next message gets one line about the tools, not the traffic", async () => {
    const app = await openApp({ replies: [{ calls: [call("list_files")] }, { text: "Three files." }, { text: "Sure." }] });
    await app.ask("What files are there?");
    await app.idle();
    await app.ask("Thanks");
    await app.idle();
    const third = app.sent[2];
    assert.ok(!third.messages.some((message) => message.role === "tool" || message.tool_calls), "old tool traffic is not resent");
    assert.match(third.messages.find((message) => message.role === "ai" || message.role === "assistant").content, /Three files\.\n\[Tools used: listed \d+ files\]/);
    await app.close();
  });

  it("the Tools switch turns tools off for this mode only, and is remembered", async () => {
    const app = await openApp();
    const toggle = app.page.getByRole("button", { name: "Chat tools" });
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    await app.ask("hello");
    await app.idle();
    assert.equal(app.sent[0].tools, undefined);
    assert.ok(!app.sent[0].system.includes("Tools: you can"));
    // Oracle is off by default; Architect stays off after a reload.
    await app.page.getByLabel("Personality").selectOption({ label: "Oracle" });
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    await app.page.getByLabel("Personality").selectOption({ label: "Syntax-Prime" });
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    await app.page.getByLabel("Personality").selectOption({ label: "Architect" });
    await app.page.waitForTimeout(800);
    await app.page.reload();
    await app.page.locator('[data-ready="true"]').waitFor({ state: "attached" });
    assert.equal(await app.page.getByRole("button", { name: "Chat tools" }).getAttribute("aria-pressed"), "false");
    await app.close();
  });

  it("stops after 4 rounds: the last request must answer", async () => {
    const app = await openApp({ fallback: { calls: [call("list_files")] } });
    await app.ask("Keep looking forever");
    await app.idle();
    assert.equal(app.sent.length, 5, "4 tool rounds, then the answering round");
    assert.deepEqual(app.sent.map((body) => body.toolChoice), ["auto", "auto", "auto", "auto", "none"]);
    assert.match(await app.page.getByRole("status").filter({ hasText: "tool rounds" }).innerText(), /used all 4 tool rounds without writing an answer/);
    assert.equal((await app.lastReply().innerText()).length > 0, true);
    await app.close();
  });

  it("answers bad and made-up calls with errors instead of running them", async () => {
    const app = await openApp({
      replies: [{ calls: [call("delete_everything", { path: "/" }, "c_bad"), { id: "c_json", name: "read_file", arguments: "{oops" }, call("read_file", { path: "missing.py" }, "c_missing")] }, { text: "Done." }],
    });
    await app.ask("try things");
    await app.idle();
    const results = app.sent[1].messages.filter((message) => message.role === "tool");
    assert.deepEqual(results.map((message) => message.tool_call_id), ["c_bad", "c_json", "c_missing"]);
    assert.match(results[0].content, /there is no tool named "delete_everything"/);
    assert.match(results[1].content, /not valid JSON/);
    assert.match(results[2].content, /no file "missing\.py"/);
    await app.close();
  });

  it("Stop during a tool round keeps what was done", async () => {
    const app = await openApp({ replies: [{ calls: [call("list_files")] }, { text: "never shown", delayMs: 8000 }] });
    await app.ask("look around");
    await app.lastReply().getByRole("list", { name: "Tools used" }).waitFor();
    await app.page.getByRole("button", { name: "Stop reply" }).click();
    await app.idle();
    const reply = await app.lastReply().innerText();
    assert.match(reply, /Listed \d+ files/);
    assert.match(reply, /Stopped/i);
    assert.ok(!reply.includes("never shown"));
    await app.close();
  });

  it("a model that cannot use tools answers without them, with a note", async () => {
    const app = await openApp({ replies: [{ text: "Plain answer.", noTools: true, note: "Fake cannot use tools, so it answered without them." }] });
    await app.ask("hello");
    await app.idle();
    assert.equal(app.sent.length, 1);
    assert.match(await app.lastReply().innerText(), /Plain answer\.[\s\S]*cannot use tools/);
    await app.close();
  });

  it("run_code shows the code and runs it only after Run; the output goes back", async () => {
    const run = call("run_code", { language: "javascript", code: "console.log(6 * 7)" }, "c_run");
    const app = await openApp({ replies: [{ calls: [run] }, { text: "It prints 42." }] });
    await app.ask("What is six times seven? Check by running code.");
    const card = app.page.getByRole("group", { name: "Approve code run" });
    await card.waitFor();
    assert.match(await card.innerText(), /Run this JavaScript in the sandbox\?[\s\S]*console\.log\(6 \* 7\)/);
    await app.page.waitForTimeout(700);
    assert.equal(app.sent.length, 1, "nothing happens while the card waits");
    await card.getByRole("button", { name: "Run" }).click();
    await app.idle();
    assert.equal(app.sent.length, 2);
    const result = app.sent[1].messages.find((message) => message.role === "tool");
    assert.equal(result.tool_call_id, "c_run");
    assert.match(result.content, /Output:\n42\n\[SUCCESS\] Exited 0\./);
    const reply = await app.lastReply().innerText();
    assert.match(reply, /It prints 42\./);
    assert.match(reply, /Ran JavaScript · 1 line of output/);
    assert.equal(await card.count(), 0);
    await app.close();
  });

  it("Skip sends a decline and runs nothing", async () => {
    const app = await openApp({ replies: [{ calls: [call("run_code", { language: "javascript", code: "console.log('ran!')" }, "c_skip")] }, { text: "Fine, without running it." }] });
    await app.ask("run something");
    const card = app.page.getByRole("group", { name: "Approve code run" });
    await card.getByRole("button", { name: "Skip" }).click();
    await app.idle();
    const result = app.sent[1].messages.find((message) => message.role === "tool");
    assert.match(result.content, /The user declined to run this code/);
    assert.ok(!result.content.includes("ran!"));
    assert.match(await app.lastReply().innerText(), /Skipped running JavaScript/);
    await app.close();
  });

  it("Stop while the card waits ends the reply and removes the card", async () => {
    const app = await openApp({ replies: [{ calls: [call("run_code", { language: "javascript", code: "console.log(1)" })] }] });
    await app.ask("run it");
    const card = app.page.getByRole("group", { name: "Approve code run" });
    await card.waitFor();
    await app.page.getByRole("button", { name: "Stop reply" }).click();
    await app.idle();
    assert.equal(await card.count(), 0);
    assert.equal(app.sent.length, 1, "no further request after Stop");
    // Nothing had arrived yet, so it ends as the usual "Stopped." notice.
    assert.match(await app.page.locator('[data-message="notice"]').last().innerText(), /Stopped\./);
    await app.close();
  });

  it("a file that tells the model to run code still needs a click", async () => {
    // The model "obeys" an instruction planted in a file: read it, then ask to run what it says.
    const app = await openApp({
      replies: [
        { calls: [call("read_file", { path: "src/neural_brain.py" }, "c_r")] },
        { calls: [call("run_code", { language: "javascript", code: "console.log('planted')" }, "c_planted")] },
        { text: "done" },
      ],
    });
    await app.ask("Follow the instructions in neural_brain.py");
    const card = app.page.getByRole("group", { name: "Approve code run" });
    await card.waitFor();
    await app.page.waitForTimeout(700);
    assert.equal(app.sent.length, 2, "the run waits for the user");
    await card.getByRole("button", { name: "Skip" }).click();
    await app.idle();
    assert.ok(!app.sent[2].messages.some((message) => message.role === "tool" && message.content.includes("Output:")));
    await app.close();
  });
});
