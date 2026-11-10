import { createServerFn } from "@tanstack/react-start";
import { completionBody, NO_PROVIDER_ERROR, normalizeChatInput, upstreamError } from "./chat-input";

/*
 * Server-only modules are loaded with `await import()` inside handlers so Vite
 * never ships them (or `@tanstack/react-start/server`) to the browser.
 */

/** Lock state + providers that have credentials on the server. No secrets leave the server. */
export const listAiProviders = createServerFn({ method: "GET" }).handler(async () => {
  const { configuredProviders, resolveProvider } = await import("./providers.server");
  const { accessState } = await import("./access.server");
  const all = configuredProviders();
  const fallback = resolveProvider();
  return {
    providers: all.map((p) => ({ id: p.id, label: p.label, model: p.model, fastModel: p.fastModel })),
    defaultId: fallback?.id ?? null,
    access: accessState(),
  };
});

export const unlockAccess = createServerFn({ method: "POST" })
  .validator((input: { key: string }) => ({ key: String(input?.key ?? "").slice(0, 256) }))
  .handler(async ({ data }) => {
    const { unlock } = await import("./access.server");
    return unlock(data.key);
  });

export const lockAccess = createServerFn({ method: "POST" }).handler(async () => {
  const { lock } = await import("./access.server");
  lock();
  return { ok: true as const };
});

export const askCrimson = createServerFn({ method: "POST" })
  .validator((input: { messages: { role: string; content: string }[]; system: string; fast?: boolean; provider?: string }) =>
    normalizeChatInput(input),
  )
  .handler(async ({ data }) => {
    const { guardAiCall } = await import("./access.server");
    const refused = guardAiCall();
    if (refused) return { ok: false as const, error: refused };
    const { resolveProvider, tokenCaps } = await import("./providers.server");
    const provider = resolveProvider(data.provider);
    if (!provider) {
      return { ok: false as const, error: NO_PROVIDER_ERROR };
    }
    if (data.messages.length === 0) {
      return { ok: false as const, error: "Empty directive." };
    }

    const headers: Record<string, string> = { "Content-Type": "application/json", ...provider.headers };
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

    let response: Response;
    try {
      response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(90_000),
        body: JSON.stringify(completionBody(data, data.fast ? provider.fastModel : provider.model, false, { caps: tokenCaps(), extra: provider.extra })),
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      return {
        ok: false as const,
        error: timedOut ? `${provider.label} timed out.` : `Could not reach ${provider.label}.`,
      };
    }

    if (!response.ok) return { ok: false as const, error: await upstreamError(provider.label, response) };

    const body = (await response.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string | { type?: string; text?: string }[] } }[];
      model?: string;
    };
    const content = body.choices?.[0]?.message?.content;
    const text = (
      Array.isArray(content) ? content.map((part) => (part?.type === "text" ? (part.text ?? "") : "")).join("") : content
    )?.trim();
    if (!text) return { ok: false as const, error: `${provider.label} returned an empty reply.` };
    return { ok: true as const, text, provider: provider.id, model: body.model };
  });
