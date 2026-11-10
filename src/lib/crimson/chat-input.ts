/** Shared, pure validation for chat requests (server function and /api/chat). */
export type ChatInput = {
  messages: { role: "user" | "assistant"; content: string }[];
  system: string;
  fast: boolean;
  provider?: string;
};

export function normalizeChatInput(input: unknown): ChatInput {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const list = Array.isArray(raw.messages) ? (raw.messages as unknown[]) : [];
  const messages = list
    .slice(-10)
    .map((item) => {
      const message = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      return {
        role: message.role === "assistant" || message.role === "ai" ? ("assistant" as const) : ("user" as const),
        content: String(message.content ?? "").slice(0, 6000),
      };
    })
    .filter((message) => message.content.length > 0);
  return {
    messages,
    system: String(raw.system ?? "").slice(0, 8000),
    fast: Boolean(raw.fast),
    provider: typeof raw.provider === "string" ? raw.provider.slice(0, 32) : undefined,
  };
}

export const NO_PROVIDER_ERROR =
  "No AI provider is configured. Set OPENROUTER_API_KEY, OMNIROUTE_BASE_URL/OMNIROUTE_API_KEY or XAI_API_KEY.";

export type BodyOptions = {
  /** Token caps per mode; defaults 420 (Flash) / 900 (Precise). */
  caps?: { fast: number; precise: number };
  /** Provider-specific fields merged into the body (never overriding the core ones). */
  extra?: Record<string, unknown>;
};

/** Builds the OpenAI-compatible request body. */
export function completionBody(input: ChatInput, model: string, stream: boolean, options: BodyOptions = {}) {
  const caps = options.caps ?? { fast: 420, precise: 900 };
  return {
    ...options.extra,
    model,
    max_tokens: input.fast ? caps.fast : caps.precise,
    temperature: 0.5,
    stream,
    messages: [{ role: "system", content: input.system || "You are Crimson OS." }, ...input.messages],
  };
}

/** Pulls `error.message` (or a string error) out of an upstream error body. */
export async function upstreamError(label: string, response: Response): Promise<string> {
  const detail = await response
    .json()
    .then((b: { error?: { message?: string } | string }) => (typeof b.error === "string" ? b.error : b.error?.message))
    .catch(() => undefined);
  return `${label} returned ${response.status}${detail ? `: ${String(detail).slice(0, 200)}` : ""}.`;
}
