import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completionBody, FLASH_RULE, normalizeChatInput, rejectsTools, withoutTools } from "./chat-input.ts";
import { MAX_TOOL_MESSAGE } from "./tools.ts";

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

describe("tool messages", () => {
  const call = (id: string, name = "read_file", args = '{"path":"a.py"}') => ({ id, name, arguments: args });
  const ask = (...calls: ReturnType<typeof call>[]) => ({ role: "assistant", content: "", tool_calls: calls });
  const result = (id: string, content = "1 | x = 1") => ({ role: "tool", tool_call_id: id, content });

  it("keeps a call and its result, and only known tool names in tools", () => {
    const input = normalizeChatInput({ messages: [{ role: "user", content: "read a.py" }, ask(call("c1")), result("c1")], tools: ["read_file", "rm_rf", "read_file"] });
    assert.deepEqual(input.tools, ["read_file"]);
    assert.equal(input.toolChoice, "auto");
    assert.deepEqual(input.messages.map((m) => m.role), ["user", "assistant", "tool"]);
  });
  it("accepts the OpenAI wire shape for calls", () => {
    const wire = { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_files", arguments: "{}" } }] };
    const input = normalizeChatInput({ messages: [{ role: "user", content: "go" }, wire, result("c1")] });
    assert.deepEqual(input.messages[1], { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "list_files", arguments: "{}" }] });
  });
  it("drops calls with no result, results with no call, and duplicate results", () => {
    const input = normalizeChatInput({
      messages: [{ role: "user", content: "go" }, result("stray"), ask(call("c1"), call("c2")), result("c1"), result("c1", "again"), result("zz"), { role: "user", content: "next" }],
    });
    assert.deepEqual(
      input.messages.map((m) => (m.role === "tool" ? `tool:${m.tool_call_id}` : m.role === "assistant" ? `ask:${m.tool_calls?.map((c) => c.id).join(",")}` : m.role)),
      ["user", "ask:c1", "tool:c1", "user"],
    );
  });
  it("an assistant turn whose calls all lost their results keeps its text, or goes", () => {
    const withText = normalizeChatInput({ messages: [{ role: "user", content: "go" }, { ...ask(call("c1")), content: "Looking." }] });
    assert.deepEqual(withText.messages[1], { role: "assistant", content: "Looking." });
    assert.equal(normalizeChatInput({ messages: [{ role: "user", content: "go" }, ask(call("c1"))] }).messages.length, 1);
  });
  it("caps a result and gives an empty one a placeholder", () => {
    const input = normalizeChatInput({ messages: [{ role: "user", content: "go" }, ask(call("a"), call("b")), result("a", "z".repeat(20_000)), result("b", "")] });
    const [, , a, b] = input.messages;
    assert.equal(a.content.length, MAX_TOOL_MESSAGE);
    assert.equal(b.content, "(no output)");
  });
  it("tool traffic does not use up the 10 conversation messages", () => {
    const turns = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `t${i}` }));
    const rounds = [ask(call("r1")), result("r1"), ask(call("r2")), result("r2")];
    const input = normalizeChatInput({ messages: [...turns, ...rounds] });
    assert.equal(input.messages.filter((m) => m.role !== "tool" && !(m.role === "assistant" && m.tool_calls)).length, 10);
    assert.equal(input.messages.filter((m) => m.role === "tool").length, 2);
    assert.equal(input.messages[0].content, "t2");
  });
  it("never starts the history inside a tool exchange when the hard cap cuts", () => {
    const many = Array.from({ length: 40 }, (_, i) => [ask(call(`c${i}`)), result(`c${i}`)]).flat();
    const input = normalizeChatInput({ messages: [{ role: "user", content: "go" }, ...many] });
    assert.ok(input.messages.length <= 60);
    assert.ok(input.messages.length === 0 || input.messages[0].role === "user");
  });
  it("toolChoice none is kept only with tools", () => {
    assert.equal(normalizeChatInput({ messages: [{ role: "user", content: "x" }], tools: ["list_files"], toolChoice: "none" }).toolChoice, "none");
    assert.equal(normalizeChatInput({ messages: [{ role: "user", content: "x" }], toolChoice: "none" }).toolChoice, undefined);
  });
});

describe("completionBody with tools", () => {
  const input = normalizeChatInput({
    messages: [{ role: "user", content: "read a.py" }, { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "read_file", arguments: '{"path":"a.py"}' }] }, { role: "tool", tool_call_id: "c1", content: "1 | x" }],
    tools: ["read_file", "list_files"],
  });
  it("sends the schemas and the wire form of calls and results", () => {
    const body = completionBody(input, "m", true, { extra: { tools: "evil", tool_choice: "required" } }) as Record<string, unknown> & { messages: Record<string, unknown>[]; tools: { function: { name: string } }[] };
    assert.deepEqual(body.tools.map((tool) => tool.function.name), ["read_file", "list_files"]);
    assert.equal(body.tool_choice, "auto", "extras cannot change the tool choice");
    assert.deepEqual(body.messages[2], { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.py"}' } }] });
    assert.deepEqual(body.messages[3], { role: "tool", tool_call_id: "c1", content: "1 | x" });
  });
  it("leaves tools out when none are asked for", () => {
    const body = completionBody(normalizeChatInput({ messages: [{ role: "user", content: "hi" }] }), "m", true) as Record<string, unknown>;
    assert.equal("tools" in body, false);
    assert.equal("tool_choice" in body, false);
  });
  it("withoutTools drops the list and turns tool traffic into plain text", () => {
    const plain = withoutTools(input);
    assert.equal(plain.tools, undefined);
    assert.equal(plain.toolChoice, undefined);
    assert.deepEqual(plain.messages.map((m) => m.role), ["user", "assistant", "user"]);
    assert.match(plain.messages[1].content, /Asked for tools: read_file\(\{"path":"a.py"\}\) \[c1\]/);
    assert.match(plain.messages[2].content, /^\[Tool result for c1\]\n1 \| x$/);
    assert.equal("tools" in completionBody(plain, "m", true), false);
  });
});

describe("rejectsTools", () => {
  const withTools = normalizeChatInput({ messages: [{ role: "user", content: "x" }], tools: ["list_files"] });
  const plain = normalizeChatInput({ messages: [{ role: "user", content: "x" }] });
  it("spots a provider refusing the tools field", () => {
    assert.equal(rejectsTools(withTools, 400, "OmniRoute returned 400: tools are not supported for this model."), true);
    assert.equal(rejectsTools(withTools, 404, "OpenRouter returned 404: No endpoints found that support tool use."), true);
    assert.equal(rejectsTools(withTools, 422, "function calling unavailable"), true);
  });
  it("leaves other failures, and requests without tools, to the normal fallback", () => {
    assert.equal(rejectsTools(withTools, 429, "tool quota"), false);
    assert.equal(rejectsTools(withTools, 400, "context length exceeded"), false);
    assert.equal(rejectsTools(plain, 400, "tools are not supported"), false);
  });
});
