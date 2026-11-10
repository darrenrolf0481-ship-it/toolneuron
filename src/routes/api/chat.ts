import { createFileRoute } from "@tanstack/react-router";
import { completionBody, NO_PROVIDER_ERROR, normalizeChatInput, upstreamError } from "@/lib/crimson/chat-input";

/**
 * POST /api/chat — streams a chat reply as NDJSON lines:
 *   {"t":"delta","v":"text"}   a piece of the reply
 *   {"t":"done","provider":"…","model":"…","cut":true?}   cut = stopped at the token limit
 *   {"t":"error","v":"message"}
 * Same access key, rate limit and provider selection as askCrimson.
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
  const { guardAiCall } = await import("@/lib/crimson/access.server");
  const { resolveProvider, tokenCaps } = await import("@/lib/crimson/providers.server");

  let refused: string | null;
  try {
    refused = guardAiCall();
  } catch {
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

  const provider = resolveProvider(input.provider);
  if (!provider) return single({ t: "error", v: NO_PROVIDER_ERROR });

  const headers: Record<string, string> = { "Content-Type": "application/json", ...provider.headers };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]);
  const model = input.fast ? provider.fastModel : provider.model;

  let upstream: Response;
  try {
    upstream = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify(completionBody(input, model, true, { caps: tokenCaps(), extra: provider.extra })),
    });
  } catch (error) {
    // Browser already gone (Stop before the provider answered): nothing to send.
    if (request.signal.aborted) return new Response(null, { status: 204 });
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    return single({ t: "error", v: timedOut ? `${provider.label} timed out.` : `Could not reach ${provider.label}.` });
  }
  if (!upstream.ok || !upstream.body) return single({ t: "error", v: await upstreamError(provider.label, upstream) });

  // Some gateways ignore stream:true and answer with one JSON body.
  if (!(upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const body = (await upstream.json().catch(() => ({}))) as {
      choices?: { message?: { content?: unknown }; finish_reason?: string }[];
      model?: string;
    };
    const text = contentText(body.choices?.[0]?.message?.content).trim();
    if (!text) return single({ t: "error", v: `${provider.label} returned an empty reply.` });
    return new Response(
      new Blob([line({ t: "delta", v: text }), line({ t: "done", provider: provider.id, model: body.model ?? model, cut: body.choices?.[0]?.finish_reason === "length" })]),
      { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } },
    );
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let servedModel = model;
  let sent = 0;
  // "length" means the reply hit max_tokens and ends mid-thought.
  let finish = "";

  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
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
            const data = row.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const chunk = JSON.parse(data) as {
                model?: string;
                error?: { message?: string } | string;
                choices?: { delta?: { content?: unknown }; finish_reason?: string | null }[];
              };
              if (chunk.error) {
                const message = typeof chunk.error === "string" ? chunk.error : chunk.error.message;
                safe(() => controller.enqueue(line({ t: "error", v: `${provider.label}: ${String(message ?? "stream error").slice(0, 200)}` })));
                continue;
              }
              if (chunk.model) servedModel = chunk.model;
              const reason = chunk.choices?.[0]?.finish_reason;
              if (typeof reason === "string" && reason) finish = reason;
              const piece = contentText(chunk.choices?.[0]?.delta?.content);
              if (piece) {
                sent += piece.length;
                if (!safe(() => controller.enqueue(line({ t: "delta", v: piece })))) return;
              }
            } catch {
              /* ignore keep-alive or malformed rows */
            }
          }
        }
        if (sent === 0) {
          const why =
            finish === "length"
              ? `${provider.label} (${servedModel}) spent its whole token budget thinking and wrote no answer. Try Precise, or ask again.`
              : `${provider.label} returned an empty reply.`;
          safe(() => controller.enqueue(line({ t: "error", v: why })));
        }
        safe(() => controller.enqueue(line({ t: "done", provider: provider.id, model: servedModel, cut: finish === "length" })));
      } catch {
        if (!request.signal.aborted) safe(() => controller.enqueue(line({ t: "error", v: `${provider.label} stream dropped.` })));
      } finally {
        safe(() => controller.close());
      }
    },
    // Browser went away (Stop, reload): the aborted request.signal already
    // cancels the upstream fetch, which ends reader.read() above.
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
