import { createFileRoute } from "@tanstack/react-router";
import { completionBody, NO_PROVIDER_ERROR, normalizeChatInput, rejectsTools, upstreamError, withoutTools, type ChatInput } from "@/lib/crimson/chat-input";
import { contentText, messageToolCalls, sseEvents, type UpstreamEvent } from "@/lib/crimson/sse";
import type { ProviderConfig } from "@/lib/crimson/providers.server";

/**
 * POST /api/chat — streams a chat reply as NDJSON lines:
 *   {"t":"delta","v":"text"}   a piece of the reply
 *   {"t":"done","provider":"…","model":"…","cut":true?}   cut = stopped at the token limit
 *   {"t":"tool","calls":[{id,name,arguments}]}   the model asks for tools (the browser runs them
 *                              and sends the results in the next request)
 *   {"t":"note","v":"…"}       a provider failed first and another answered, or refused tools
 * `done` carries noTools:true when the provider refused tools and answered without them.
 *   {"t":"error","v":"message"}
 * Same access key, rate limit and provider selection as askCrimson. If the
 * chosen provider fails before any text arrives, the next configured one is
 * tried (AI_FALLBACK=off disables this).
 * When the browser aborts (Stop button), the upstream request is cancelled
 * too, so the provider stops generating (and billing).
 */
/** Room for a few rounds of tool results on top of the conversation. */
const MAX_BODY_BYTES = 256 * 1024;

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
  let input = normalizeChatInput(parsed);
  if (input.messages.length === 0) return single({ t: "error", v: "Empty directive." });

  const first = resolveProvider(input.provider);
  if (!first) return single({ t: "error", v: NO_PROVIDER_ERROR });
  const caps = tokenCaps();
  // One budget for all attempts, so a fallback cannot double the wait.
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]);
  const failures: string[] = [];
  const notes: string[] = [];
  let noTools = false;
  for (const provider of fallbackOrder(first)) {
    if (request.signal.aborted) return new Response(null, { status: 204 });
    let attempt = await open(provider, input, signal, caps);
    if (!attempt.ok && attempt.toolsRejected) {
      // This model cannot take tools: ask again without them (and keep it that way for any fallback).
      input = withoutTools(input);
      noTools = true;
      notes.push(`${provider.label} cannot use tools, so it answered without them.`);
      attempt = await open(provider, input, signal, caps);
    }
    if (attempt.ok) return respond(attempt, provider, failures, request, notes, noTools);
    // Browser already gone (Stop before any provider answered): nothing to send.
    if (request.signal.aborted) return new Response(null, { status: 204 });
    failures.push(attempt.error);
    if (attempt.timedOut || attempt.final) break;
  }
  return single({ t: "error", v: failures.join(" ") });
}

type Attempt =
  | { ok: true; buffered: UpstreamEvent[]; events: AsyncGenerator<UpstreamEvent>; model: string }
  | {
      ok: false;
      error: string;
      timedOut?: boolean;
      /** The model answered, but spent its whole budget thinking: another provider would only repeat that, so stop. */
      final?: boolean;
      /** The provider refused the request because of its tools field. */
      toolsRejected?: boolean;
    };

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
  if (!upstream.ok || !upstream.body) {
    const error = await upstreamError(provider.label, upstream);
    return { ok: false, error, toolsRejected: rejectsTools(input, upstream.status, error) };
  }

  // Some gateways ignore stream:true and answer with one JSON body.
  if (!(upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const body = (await upstream.json().catch(() => ({}))) as {
      choices?: { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: string }[];
      model?: string;
      error?: { message?: string } | string;
    };
    const text = contentText(body.choices?.[0]?.message?.content).trim();
    const calls = messageToolCalls(body.choices?.[0]?.message?.tool_calls);
    if (!text && calls.length) {
      const only: UpstreamEvent = { calls, model: body.model ?? model, finish: "tool_calls" };
      return { ok: true, buffered: [only], events: (async function* () {})(), model: body.model ?? model };
    }
    if (!text) {
      const detail = typeof body.error === "string" ? body.error : body.error?.message;
      if (detail) return { ok: false, error: `${provider.label}: ${String(detail).slice(0, 200)}` };
      if (body.choices?.[0]?.finish_reason === "length") return { ok: false, error: `${provider.label} (${body.model ?? model}) spent its whole token budget thinking and wrote no answer. Try Precise, or ask again.`, final: true };
      return { ok: false, error: `${provider.label} returned an empty reply.` };
    }
    const only: UpstreamEvent = { piece: text, model: body.model ?? model, finish: body.choices?.[0]?.finish_reason ?? "", ...(calls.length ? { calls } : {}) };
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
        if (finish === "length") {
          return { ok: false, error: `${provider.label} (${servedModel}) spent its whole token budget thinking and wrote no answer. Try Precise, or ask again.`, final: true };
        }
        return { ok: false, error: `${provider.label} returned an empty reply.` };
      }
      const event = next.value;
      if (event.model) servedModel = event.model;
      if (event.error) {
        await events.return(undefined);
        return { ok: false, error: `${provider.label}: ${event.error.slice(0, 200)}` };
      }
      buffered.push(event);
      if (event.piece || event.calls?.length) return { ok: true, buffered, events, model: servedModel };
    }
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    return { ok: false, error: timedOut ? `${provider.label} timed out.` : `${provider.label} stream dropped.`, timedOut };
  }
}

/** Streams a successful attempt to the browser as NDJSON. */
function respond(attempt: Extract<Attempt, { ok: true }>, provider: ProviderConfig, failures: string[], request: Request, notes: string[], noTools: boolean): Response {
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      let servedModel = attempt.model;
      // "length" means the reply hit max_tokens and ends mid-thought.
      let finish = "";
      const emit = (event: UpstreamEvent): boolean => {
        if (event.model) servedModel = event.model;
        if (event.finish) finish = event.finish;
        if (event.error) return safe(() => controller.enqueue(line({ t: "error", v: `${provider.label}: ${event.error!.slice(0, 200)}` })));
        if (event.piece && !safe(() => controller.enqueue(line({ t: "delta", v: event.piece })))) return false;
        if (event.calls?.length) return safe(() => controller.enqueue(line({ t: "tool", calls: event.calls })));
        return true;
      };
      try {
        const note = [...(failures.length > 0 ? [`Answered by ${provider.label}. ${failures.join(" ")}`] : []), ...notes].join(" ");
        if (note) safe(() => controller.enqueue(line({ t: "note", v: note })));
        for (const event of attempt.buffered) if (!emit(event)) return;
        for await (const event of attempt.events) if (!emit(event)) return;
        safe(() => controller.enqueue(line({ t: "done", provider: provider.id, model: servedModel, cut: finish === "length", ...(noTools ? { noTools: true } : {}) })));
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

/** Stream controller calls throw once the browser has disconnected; report instead. */
function safe(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: ({ request }) => handle(request),
    },
  },
});
