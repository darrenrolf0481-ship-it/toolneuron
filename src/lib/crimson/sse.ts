/**
 * Reading an OpenAI-compatible chat completion: the streamed (SSE) form and
 * the single-JSON form some gateways send instead. Pure apart from reading
 * the stream, so it is tested on recorded provider output.
 */
import { MAX_TOOL_ARGS, type ToolCall } from "./tools.ts";

/** One parsed event. `calls` is set once, complete, when the model finishes asking for tools. */
export type UpstreamEvent = { piece?: string; error?: string; model?: string; finish?: string; calls?: ToolCall[] };

type ToolDelta = { index?: number; id?: string; function?: { name?: string; arguments?: string } };

/**
 * Collects tool calls streamed in pieces: the id and name come first, the
 * argument text arrives over many chunks, keyed by `index`.
 */
export class ToolCallCollector {
  private calls = new Map<number, { id: string; name: string; args: string }>();

  add(deltas: unknown): void {
    if (!Array.isArray(deltas)) return;
    for (const raw of deltas as ToolDelta[]) {
      if (!raw || typeof raw !== "object") continue;
      const index = typeof raw.index === "number" ? raw.index : this.calls.size;
      const entry = this.calls.get(index) ?? { id: "", name: "", args: "" };
      if (typeof raw.id === "string" && raw.id) entry.id = raw.id;
      const name = raw.function?.name;
      // Some gateways repeat the full name on every chunk; others split it.
      if (typeof name === "string" && name && name !== entry.name) entry.name = entry.name && !name.startsWith(entry.name) ? entry.name + name : name;
      const args = raw.function?.arguments;
      if (typeof args === "string" && entry.args.length <= MAX_TOOL_ARGS) entry.args += args;
      this.calls.set(index, entry);
    }
  }

  get size(): number {
    return this.calls.size;
  }

  /** The finished calls (ids filled in where the provider sent none), and a reset. */
  take(): ToolCall[] {
    const out = [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, call]) => call.name)
      .map(([index, call]) => ({ id: (call.id || `call_${index}`).slice(0, 100), name: call.name.slice(0, 64), arguments: call.args.slice(0, MAX_TOOL_ARGS + 1) }));
    this.calls.clear();
    return out;
  }
}

/** Tool calls from a non-streamed `message.tool_calls`. */
export function messageToolCalls(raw: unknown): ToolCall[] {
  const collector = new ToolCallCollector();
  if (Array.isArray(raw)) collector.add(raw.map((call, index) => ({ index, ...(call as object) })));
  return collector.take();
}

/** Parses one SSE `data:` payload into an event (null for keep-alives and junk). Tool-call pieces go to `collector`. */
export function parseChunk(data: string, collector: ToolCallCollector): UpstreamEvent | null {
  if (data === "[DONE]") return null;
  let chunk: {
    model?: string;
    error?: { message?: string } | string;
    choices?: { delta?: { content?: unknown; tool_calls?: unknown }; finish_reason?: string | null }[];
  };
  try {
    chunk = JSON.parse(data);
  } catch {
    return null;
  }
  if (chunk.error) {
    const message = typeof chunk.error === "string" ? chunk.error : chunk.error.message;
    return { error: String(message ?? "stream error") };
  }
  const choice = chunk.choices?.[0];
  collector.add(choice?.delta?.tool_calls);
  const reason = choice?.finish_reason;
  const finish = typeof reason === "string" && reason ? reason : undefined;
  const event: UpstreamEvent = { model: chunk.model, finish, piece: contentText(choice?.delta?.content) || undefined };
  // Any finish ends the calls (some providers say "stop" rather than "tool_calls").
  if (finish && collector.size > 0) event.calls = collector.take();
  return event;
}

/** Parses an OpenAI-compatible SSE body into events; cancels the body if the consumer stops early. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<UpstreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const collector = new ToolCallCollector();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n")) !== -1) {
        const row = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (!row.startsWith("data:")) continue;
        const event = parseChunk(row.slice(5).trim(), collector);
        if (event) yield event;
      }
    }
    const last = buffer.trim();
    if (last.startsWith("data:")) {
      const event = parseChunk(last.slice(5).trim(), collector);
      if (event) yield event;
    }
    // Calls the stream never closed with a finish reason.
    if (collector.size > 0) yield { calls: collector.take(), finish: "tool_calls" };
  } finally {
    reader.cancel().catch(() => {});
  }
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: string }).text ?? "") : ""))
      .join("");
  }
  return "";
}
