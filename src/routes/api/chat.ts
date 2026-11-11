import { createFileRoute } from "@tanstack/react-router";
import { completionBody, NO_PROVIDER_ERROR, normalizeChatInput, upstreamError, type ChatInput } from "@/lib/crimson/chat-input";
import type { ProviderConfig } from "@/lib/crimson/providers.server";

/**
 * POST /api/chat — streams a chat reply as NDJSON lines:
 *   {"t":"delta","v":"text"}   a piece of the reply
 *   {"t":"done","provider":"…","model":"…","cut":true?}   cut = stopped at the token limit
 *   {"t":"note","v":"…"}       a provider failed first and another answered
 *   {"t":"error","v":"message"}
 * Same access key, rate limit and provider selection as askCrimson. If the
 * chosen provider fails before any text arrives, the next configured one is
 * tried (AI_FALLBACK=off disables this).
 * When the browser aborts (Stop button), the upstream request is cancelled
 * too, so the provider stops generating (and billing).
 */
const MAX_BODY_BYTES = 128 * 1024;

const encoder = new TextEncoder();

function line(value: unknown): Uint8Array<ArrayBuffer> {
  return encoder.encode(`${JSON.stringify(value)}\n`) as Uint8Array<ArrayBuffer>;
}

function single(value: unknown, status = 200): Response {
  return new Response(line(value), { status, headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
}

async function handle(request: Request): Promise<Response> {
  const { guardAiCall, isCrossSite } = await import("@/lib/crimson/access.server");
  const { fallbackOrder, resolveProvider, tokenCaps } = await import("@/lib/crimson/providers.server");

  let refused: string | null;
  try {
    refused = guardAiCall();
  } catch (error) {
    if (!isCrossSite(error)) throw error;
    return single({ t: "error", v: "Cross-site request refused." }, 403);
  }
  if (refused) return single({ t: "error", v: refused });

  const raw = await request.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) return single({ t: "error", v: "Request too large." }, 413);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return single({ t: "error", v: "Bad request." }, 400);
  }
  const input = normalizeChatInput(parsed);
  if (input.messages.length === 0) return single({ t: "error", v: "Empty directive." });

  const first = resolveProvider(input.provider);
  if (!first) return single({ t: "error", v: NO_PROVIDER_ERROR });
  const caps = tokenCaps();
  // One budget for all attempts, so a fallback cannot double the wait.
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]);
  const failures: string[] = [];
  for (const provider of fallbackOrder(first)) {
    if (request.signal.aborted) return new Response(null, { status: 204 });
    const attempt = await open(provider, input, signal, caps);
    if (attempt.ok) return respond(attempt, provider, failures, request);
    // Browser already gone (Stop before any provider answered): nothing to send.
    if (request.signal.aborted) return new Response(null, { status: 204 });
    failures.push(attempt.error);
    if (attempt.timedOut) break;
  }
  return single({ t: "error", v: failures.join(" ") });
}

/** One parsed SSE event from an OpenAI-compatible stream. */
type UpstreamEvent = { piece?: string; error?: string; model?: string; finish?: string };

type Attempt =
  | { ok: true; buffered: UpstreamEvent[]; events: AsyncGenerator<UpstreamEvent>; model: string }
  | { ok: false; error: string; timedOut?: boolean };

/**
 * Calls one provider and reads until its first piece of text. Anything that
 * fails before then (no connection, error status, an error event, an empty
 * stream) is a failed attempt, so the caller can try the next provider.
 */
async function open(provider: ProviderConfig, input: ChatInput, signal: AbortSignal, caps: { fast: number; precise: number }): Promise<Attempt> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...provider.headers };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  const model = input.fast ? provider.fastModel : provider.model;
  let upstream: Response;
  try {
    upstream = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify(completionBody(input, model, true, { caps, extra: provider.extra })),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    return { ok: false, error: timedOut ? `${provider.label} timed out.` : `Could not reach ${provider.label}.`, timedOut };
  }
  if (!upstream.ok || !upstream.body) return { ok: false, error: await upstreamError(provider.label, upstream) };

  // Some gateways ignore stream:true and answer with one JSON body.
  if (!(upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const body = (await upstream.json().catch(() => ({}))) as {
      choices?: { message?: { content?: unknown }; finish_reason?: string }[];
      model?: string;
      error?: { message?: string } | string;
    };
    const text = contentText(body.choices?.[0]?.message?.content).trim();
    if (!text) {
      const detail = typeof body.error === "string" ? body.error : body.error?.message;
      return { ok: false, error: detail ? `${provider.label}: ${String(detail).slice(0, 200)}` : `${provider.label} returned an empty reply.` };
    }
    const only: UpstreamEvent = { piece: text, model: body.model ?? model, finish: body.choices?.[0]?.finish_reason ?? "" };
    return { ok: true, buffered: [only], events: (async function* () {})(), model: body.model ?? model };
  }

  const events = sseEvents(upstream.body);
  const buffered: UpstreamEvent[] = [];
  let servedModel = model;
  try {
    for (;;) {
      const next = await events.next();
      if (next.done) {
        const finish = [...buffered].reverse().find((event) => event.finish)?.finish;
        return {
          ok: false,
          error:
            finish === "length"
              ? `${provider.label} (${servedModel}) spent its whole token budget thinking and wrote no answer.`
              : `${provider.label} returned an empty reply.`,
        };
      }
      const event = next.value;
      if (event.model) servedModel = event.model;
      if (event.error) {
        await events.return(undefined);
        return { ok: false, error: `${provider.label}: ${event.error.slice(0, 200)}` };
      }
      buffered.push(event);
      if (event.piece) return { ok: true, buffered, events, model: servedModel };
    }
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    return { ok: false, error: timedOut ? `${provider.label} timed out.` : `${provider.label} stream dropped.`, timedOut };
  }
}

/** Streams a successful attempt to the browser as NDJSON. */
function respond(attempt: Extract<Attempt, { ok: true }>, provider: ProviderConfig, failures: string[], request: Request): Response {
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      let servedModel = attempt.model;
      // "length" means the reply hit max_tokens and ends mid-thought.
      let finish = "";
      const emit = (event: UpstreamEvent): boolean => {
        if (event.model) servedModel = event.model;
        if (event.finish) finish = event.finish;
        if (event.error) return safe(() => controller.enqueue(line({ t: "error", v: `${provider.label}: ${event.error!.slice(0, 200)}` })));
        if (event.piece) return safe(() => controller.enqueue(line({ t: "delta", v: event.piece })));
        return true;
      };
      try {
        if (failures.length > 0) {
          safe(() => controller.enqueue(line({ t: "note", v: `Answered by ${provider.label}. ${failures.join(" ")}` })));
        }
        for (const event of attempt.buffered) if (!emit(event)) return;
        for await (const event of attempt.events) if (!emit(event)) return;
        safe(() => controller.enqueue(line({ t: "done", provider: provider.id, model: servedModel, cut: finish === "length" })));
      } catch {
        if (!request.signal.aborted) safe(() => controller.enqueue(line({ t: "error", v: `${provider.label} stream dropped.` })));
      } finally {
        safe(() => controller.close());
      }
    },
    // Browser went away (Stop, reload): the aborted request.signal already
    // cancels the upstream fetch, which ends the event reader.
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

/** Parses an OpenAI-compatible SSE body into events; cancels the body if the consumer stops early. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<UpstreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n")) !== -1) {
        const row = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (!row.startsWith("data:")) continue;
        const data = row.slice(5).trim();
        if (data === "[DONE]") continue;
        let chunk: {
          model?: string;
          error?: { message?: string } | string;
          choices?: { delta?: { content?: unknown }; finish_reason?: string | null }[];
        };
        try {
          chunk = JSON.parse(data);
        } catch {
          continue; // keep-alive or malformed row
        }
        if (chunk.error) {
          const message = typeof chunk.error === "string" ? chunk.error : chunk.error.message;
          yield { error: String(message ?? "stream error") };
          continue;
        }
        const reason = chunk.choices?.[0]?.finish_reason;
        yield {
          model: chunk.model,
          finish: typeof reason === "string" && reason ? reason : undefined,
          piece: contentText(chunk.choices?.[0]?.delta?.content) || undefined,
        };
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Stream controller calls throw once the browser has disconnected; report instead. */
function safe(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: string }).text ?? "") : ""))
      .join("");
  }
  return "";
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: ({ request }) => handle(request),
    },
  },
});
