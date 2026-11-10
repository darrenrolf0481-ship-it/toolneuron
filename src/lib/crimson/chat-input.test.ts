import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completionBody, FLASH_RULE, normalizeChatInput } from "./chat-input.ts";

describe("normalizeChatInput", () => {
  it("maps roles, drops empty messages, keeps the last 10 and caps sizes", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? "ai" : "user", content: `m${i}` }));
    const input = normalizeChatInput({ messages: [...many, { role: "user", content: "" }], system: "s".repeat(9000), fast: 1, provider: "openrouter" });
    assert.equal(input.messages.length, 10);
    assert.equal(input.messages[0].content, "m4");
    assert.equal(input.messages[1].role, "assistant");
    assert.equal(input.system.length, 8000);
    assert.equal(input.fast, true);
  });
  it("survives junk", () => {
    assert.deepEqual(normalizeChatInput(null), { messages: [], system: "", fast: false, provider: undefined });
  });
});

describe("completionBody", () => {
  const input = normalizeChatInput({ messages: [{ role: "user", content: "hi" }], system: "You are X." });
  it("uses the caps for the mode and adds the Flash rule only in Flash", () => {
    const precise = completionBody(input, "m", true, { caps: { fast: 1500, precise: 3000 } });
    assert.equal(precise.max_tokens, 3000);
    assert.equal(precise.messages[0].content, "You are X.");
    const flash = completionBody({ ...input, fast: true }, "m", true, { caps: { fast: 1500, precise: 3000 } });
    assert.equal(flash.max_tokens, 1500);
    assert.equal(flash.messages[0].content, "You are X." + FLASH_RULE);
  });
  it("merges provider extras without letting them override core fields", () => {
    const body = completionBody(input, "real-model", false, { extra: { reasoning: { effort: "low" }, model: "evil", stream: true } }) as Record<string, unknown>;
    assert.deepEqual(body.reasoning, { effort: "low" });
    assert.equal(body.model, "real-model");
    assert.equal(body.stream, false);
  });
  it("defaults to 420 / 900 without caps", () => {
    assert.equal(completionBody({ ...input, fast: true }, "m", true).max_tokens, 420);
    assert.equal(completionBody(input, "m", true).max_tokens, 900);
  });
});
