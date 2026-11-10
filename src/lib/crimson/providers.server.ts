/**
 * OpenAI-compatible chat providers. Server-only: reads API keys from env.
 *
 * Env (all optional except a key for at least one provider):
 *   AI_PROVIDER            default provider id: openrouter | omniroute | xai
 *
 *   OPENROUTER_API_KEY     https://openrouter.ai/keys
 *   OPENROUTER_MODEL       default "openrouter/auto"
 *   OPENROUTER_MODEL_FAST  defaults to OPENROUTER_MODEL
 *   OPENROUTER_BASE_URL    default https://openrouter.ai/api/v1
 *
 *   OMNIROUTE_BASE_URL     default http://127.0.0.1:20128/v1
 *   OMNIROUTE_API_KEY      key from the OmniRoute dashboard (if auth is on)
 *   OMNIROUTE_MODEL        default "auto" (OmniRoute's auto-combo)
 *   OMNIROUTE_MODEL_FAST   defaults to OMNIROUTE_MODEL
 *   OMNIROUTE_ENABLED      "true" to enable OmniRoute with no API key
 *
 *   XAI_API_KEY / XAI_MODEL / XAI_MODEL_FAST   direct xAI (original behaviour)
 *
 *   AI_MAX_TOKENS_FAST     reply token cap in Flash mode (default 420)
 *   AI_MAX_TOKENS          reply token cap in Precise mode (default 900)
 *                          Free "reasoning" models spend part of this thinking,
 *                          so raise both when using them.
 *   OPENROUTER_REASONING_EFFORT   low | medium | high: sent as OpenRouter's
 *                          `reasoning.effort`, so thinking leaves room for the answer
 *   OMNIROUTE_REASONING_EFFORT    the same, sent as `reasoning_effort`
 *   AI_FALLBACK            "off" to stop chat trying the other providers when
 *                          the chosen one fails before answering
 */
import { env } from "@/lib/env.server";

export const PROVIDER_IDS = ["openrouter", "omniroute", "xai"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ProviderConfig = {
  id: ProviderId;
  label: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  fastModel: string;
  headers: Record<string, string>;
  /** Provider-specific request fields (e.g. reasoning effort). */
  extra: Record<string, unknown>;
};

const EFFORTS = new Set(["minimal", "low", "medium", "high"]);

function effort(name: string): string | undefined {
  const value = env(name)?.trim().toLowerCase();
  return value && EFFORTS.has(value) ? value : undefined;
}

/** Reply token caps from env, clamped to a sane range. */
export function tokenCaps(): { fast: number; precise: number } {
  const read = (name: string, fallback: number) => {
    const value = Number.parseInt(env(name) ?? "", 10);
    return Number.isFinite(value) ? Math.min(8000, Math.max(64, value)) : fallback;
  };
  return { fast: read("AI_MAX_TOKENS_FAST", 420), precise: read("AI_MAX_TOKENS", 900) };
}

function trimSlash(url: string) {
  return url.replace(/\/+$/, "");
}

function build(id: ProviderId): ProviderConfig | null {
  switch (id) {
    case "openrouter": {
      const apiKey = env("OPENROUTER_API_KEY");
      if (!apiKey) return null;
      const model = env("OPENROUTER_MODEL") ?? "openrouter/auto";
      return {
        id,
        label: "OpenRouter",
        baseUrl: trimSlash(env("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1"),
        apiKey,
        model,
        fastModel: env("OPENROUTER_MODEL_FAST") ?? model,
        // Optional attribution headers OpenRouter uses for its app rankings.
        headers: {
          "HTTP-Referer": env("OPENROUTER_SITE_URL") ?? "https://toolneuron.local",
          "X-Title": "ToolNeuron",
        },
        extra: effort("OPENROUTER_REASONING_EFFORT") ? { reasoning: { effort: effort("OPENROUTER_REASONING_EFFORT") } } : {},
      };
    }
    case "omniroute": {
      const apiKey = env("OMNIROUTE_API_KEY");
      const baseUrl = env("OMNIROUTE_BASE_URL");
      if (!apiKey && !baseUrl && env("OMNIROUTE_ENABLED") !== "true") return null;
      const model = env("OMNIROUTE_MODEL") ?? "auto";
      return {
        id,
        label: "OmniRoute",
        baseUrl: trimSlash(baseUrl ?? "http://127.0.0.1:20128/v1"),
        apiKey,
        model,
        fastModel: env("OMNIROUTE_MODEL_FAST") ?? model,
        headers: {},
        extra: effort("OMNIROUTE_REASONING_EFFORT") ? { reasoning_effort: effort("OMNIROUTE_REASONING_EFFORT") } : {},
      };
    }
    case "xai": {
      const apiKey = env("XAI_API_KEY");
      if (!apiKey) return null;
      const model = env("XAI_MODEL") ?? "grok-4.5";
      return {
        id,
        label: "Grok (xAI)",
        baseUrl: "https://api.x.ai/v1",
        apiKey,
        model,
        fastModel: env("XAI_MODEL_FAST") ?? model,
        headers: {},
        extra: {},
      };
    }
  }
}

export function configuredProviders(): ProviderConfig[] {
  return PROVIDER_IDS.map(build).filter((p): p is ProviderConfig => p !== null);
}

/**
 * Providers to try for one chat request: the chosen one, then the other
 * configured ones in PROVIDER_IDS order. AI_FALLBACK=off keeps it to one.
 */
export function fallbackOrder(first: ProviderConfig): ProviderConfig[] {
  if ((env("AI_FALLBACK") ?? "").trim().toLowerCase() === "off") return [first];
  return [first, ...configuredProviders().filter((provider) => provider.id !== first.id)];
}

/** Requested provider if configured, else AI_PROVIDER, else the first configured one. */
export function resolveProvider(requested?: string): ProviderConfig | null {
  const all = configuredProviders();
  const pick = (id?: string) => all.find((p) => p.id === id);
  return pick(requested) ?? pick(env("AI_PROVIDER")) ?? all[0] ?? null;
}
