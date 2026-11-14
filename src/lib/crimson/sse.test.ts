import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { messageToolCalls, parseChunk, sseEvents, ToolCallCollector, type UpstreamEvent } from "./sse.ts";
import { MAX_TOOL_ARGS } from "./tools.ts";

function streamOf(text: string, chunkSize = 37): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + chunkSize));
      at += chunkSize;
    },
  });
}

async function collect(text: string, chunkSize?: number): Promise<UpstreamEvent[]> {
  const out: UpstreamEvent[] = [];
  for await (const event of sseEvents(streamOf(text, chunkSize))) out.push(event);
  return out;
}

const row = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const delta = (d: unknown, finish: string | null = null) => row({ model: "m", choices: [{ delta: d, finish_reason: finish }] });

describe("sseEvents on a recorded OpenRouter stream", () => {
  // Recorded 2026-11-14 from nvidia/nemotron-3-ultra-550b-a55b:free with one read_file tool (reasoning text removed).
  const recorded = readFileSync(new URL("./fixtures/openrouter-tool-stream.txt", import.meta.url), "utf8");
  for (const size of [7, 64, 100_000]) {
    it(`yields the call once, complete, whatever the chunking (${size} bytes)`, async () => {
      const events = await collect(recorded, size);
      const calls = events.flatMap((event) => event.calls ?? []);
      assert.equal(calls.length, 1, "the repeated finish_reason must not repeat the call");
      assert.equal(calls[0].name, "read_file");
      assert.match(calls[0].id, /^call-/);
      assert.deepEqual(JSON.parse(calls[0].arguments), { path: "src/app.py" });
      assert.equal(events.map((event) => event.piece ?? "").join(""), "", "no text, only the call");
    });
  }
});

describe("sseEvents", () => {
  it("passes text through and ignores keep-alives, junk and [DONE]", async () => {
    const events = await collect(`: keep-alive\n\n${delta({ content: "Hel" })}data: {oops\n\n${delta({ content: "lo" }, "stop")}data: [DONE]\n\n`);
    assert.equal(events.map((event) => event.piece ?? "").join(""), "Hello");
    assert.equal(events.at(-1)?.finish, "stop");
  });
  it("collects two calls by index, with text before them", async () => {
    const text =
      delta({ content: "Let me look." }) +
      delta({ tool_calls: [{ index: 0, id: "a", function: { name: "list_files", arguments: "" } }] }) +
      delta({ tool_calls: [{ index: 1, id: "b", function: { name: "read_file", arguments: '{"pa' } }] }) +
      delta({ tool_calls: [{ index: 1, function: { arguments: 'th":"x.py"}' } }] }) +
      delta({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }) +
      delta({}, "tool_calls");
    const events = await collect(text);
    assert.equal(events[0].piece, "Let me look.");
    assert.deepEqual(events.at(-1)?.calls, [
      { id: "a", name: "list_files", arguments: "{}" },
      { id: "b", name: "read_file", arguments: '{"path":"x.py"}' },
    ]);
  });
  it("ends calls on any finish reason, and flushes calls a stream never finished", async () => {
    const stop = await collect(delta({ tool_calls: [{ index: 0, id: "a", function: { name: "list_files", arguments: "{}" } }] }) + delta({}, "stop"));
    assert.equal(stop.flatMap((event) => event.calls ?? []).length, 1);
    const open = await collect(delta({ tool_calls: [{ index: 0, id: "a", function: { name: "list_files", arguments: "{}" } }] }));
    assert.equal(open.at(-1)?.finish, "tool_calls");
    assert.equal(open.at(-1)?.calls?.[0].name, "list_files");
  });
  it("reads a last row with no trailing newline", async () => {
    const events = await collect(`data: ${JSON.stringify({ choices: [{ delta: { content: "end" }, finish_reason: "stop" }] })}`);
    assert.equal(events[0].piece, "end");
  });
  it("reports error events", async () => {
    assert.equal((await collect(row({ error: { message: "rate limited" } })))[0].error, "rate limited");
  });
});

describe("ToolCallCollector", () => {
  it("handles a name split in pieces, a name repeated on every chunk, and missing ids", () => {
    const split = new ToolCallCollector();
    split.add([{ index: 0, function: { name: "read_" } }]);
    split.add([{ index: 0, function: { name: "file", arguments: "{}" } }]);
    assert.deepEqual(split.take(), [{ id: "call_0", name: "read_file", arguments: "{}" }]);
    const repeated = new ToolCallCollector();
    repeated.add([{ index: 0, id: "x", function: { name: "read_file", arguments: '{"a"' } }]);
    repeated.add([{ index: 0, function: { name: "read_file", arguments: ":1}" } }]);
    assert.deepEqual(repeated.take(), [{ id: "x", name: "read_file", arguments: '{"a":1}' }]);
    assert.equal(repeated.size, 0, "take() resets");
  });
  it("caps argument text and drops calls with no name", () => {
    const collector = new ToolCallCollector();
    for (let i = 0; i < 30; i++) collector.add([{ index: 0, id: "x", function: { name: "propose_edit", arguments: "y".repeat(1000) } }]);
    collector.add([{ index: 1, id: "nameless", function: { arguments: "{}" } }]);
    const calls = collector.take();
    assert.equal(calls.length, 1);
    assert.ok(calls[0].arguments.length <= MAX_TOOL_ARGS + 1);
  });
  it("ignores junk", () => {
    const collector = new ToolCallCollector();
    collector.add("nope");
    collector.add([null, 3]);
    assert.equal(collector.take().length, 0);
  });
});

describe("messageToolCalls and parseChunk", () => {
  it("reads a non-streamed message.tool_calls", () => {
    assert.deepEqual(messageToolCalls([{ id: "c1", type: "function", function: { name: "search_files", arguments: '{"query":"TODO"}' } }]), [
      { id: "c1", name: "search_files", arguments: '{"query":"TODO"}' },
    ]);
    assert.deepEqual(messageToolCalls(undefined), []);
  });
  it("returns null for [DONE] and unparseable rows", () => {
    const collector = new ToolCallCollector();
    assert.equal(parseChunk("[DONE]", collector), null);
    assert.equal(parseChunk("{bad", collector), null);
  });
});
