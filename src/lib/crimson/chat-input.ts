/** Shared, pure validation for chat requests (server function and /api/chat). */
import { isToolName, MAX_CALLS_PER_ROUND, MAX_TOOL_ARGS, MAX_TOOL_MESSAGE, toolDefinitions, type ToolCall, type ToolName } from "./tools.ts";

export type ChatMessageIn =
  | { role: "user"; content: string }
  /** `tool_calls`: the model asked for tools in this turn (content may be empty). */
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ChatInput = {
  messages: ChatMessageIn[];
  system: string;
  fast: boolean;
  provider?: string;
  /** Tools the model may call this round (only names on the fixed list). */
  tools?: ToolName[];
  /** "none": tools are listed (the history has tool messages) but the model must answer now. */
  toolChoice?: "auto" | "none";
};

const MESSAGE_CHARS = 6000;
/** Conversation messages kept: user messages and assistant answers. Tool traffic in between rides along. */
const KEEP_TURNS = 10;
/** Hard cap on messages of any kind. */
const MAX_MESSAGES = 60;

const text = (value: unknown, max: number) => String(value ?? "").slice(0, max);

function parseCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_CALLS_PER_ROUND * 2)
    .map((item) => {
      const call = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      // Accept both our shape and the OpenAI wire shape ({function: {name, arguments}}).
      const fn = (call.function && typeof call.function === "object" ? call.function : call) as Record<string, unknown>;
      return { id: text(call.id, 100), name: text(fn.name, 64), arguments: text(fn.arguments, MAX_TOOL_ARGS + 1) };
    })
    .filter((call) => call.id && call.name);
}

function parseMessage(item: unknown): ChatMessageIn | null {
  const message = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
  if (message.role === "tool") {
    const id = text(message.tool_call_id, 100);
    return id ? { role: "tool", tool_call_id: id, content: text(message.content, MAX_TOOL_MESSAGE) || "(no output)" } : null;
  }
  const content = text(message.content, MESSAGE_CHARS);
  if (message.role === "assistant" || message.role === "ai") {
    const calls = parseCalls(message.tool_calls);
    if (calls.length) return { role: "assistant", content, tool_calls: calls };
    return content ? { role: "assistant", content } : null;
  }
  return content ? { role: "user", content } : null;
}

/**
 * Providers refuse a history where a tool call has no result, or a result
 * has no call right before it. Keep only matched pairs.
 */
function pairTools(messages: ChatMessageIn[]): ChatMessageIn[] {
  const out: ChatMessageIn[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "tool") continue; // results are only taken right after their call
    if (message.role !== "assistant" || !message.tool_calls) {
      out.push(message);
      continue;
    }
    const results: Extract<ChatMessageIn, { role: "tool" }>[] = [];
    while (i + 1 < messages.length && messages[i + 1].role === "tool") results.push(messages[++i] as Extract<ChatMessageIn, { role: "tool" }>);
    const answered = new Set(results.map((result) => result.tool_call_id));
    const calls = message.tool_calls.filter((call) => answered.has(call.id));
    const ids = new Set(calls.map((call) => call.id));
    if (calls.length) {
      out.push({ ...message, tool_calls: calls });
      const seen = new Set<string>();
      for (const result of results) {
        if (ids.has(result.tool_call_id) && !seen.has(result.tool_call_id)) {
          seen.add(result.tool_call_id);
          out.push(result);
        }
      }
    } else if (message.content) {
      out.push({ role: "assistant", content: message.content });
    }
  }
  return out;
}

const isTurn = (message: ChatMessageIn) => message.role === "user" || (message.role === "assistant" && !message.tool_calls);

/** Keeps the last KEEP_TURNS conversation messages and the tool traffic after the first of them. */
function keepRecent(messages: ChatMessageIn[]): ChatMessageIn[] {
  let turns = 0;
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isTurn(messages[i]) && ++turns === KEEP_TURNS) {
      start = i;
      break;
    }
  }
  let kept = messages.slice(start);
  if (kept.length > MAX_MESSAGES) {
    kept = kept.slice(-MAX_MESSAGES);
    // Never start in the middle of a tool exchange.
    while (kept.length && !isTurn(kept[0])) kept = kept.slice(1);
  }
  return kept;
}

export function normalizeChatInput(input: unknown): ChatInput {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const list = Array.isArray(raw.messages) ? (raw.messages as unknown[]) : [];
  // Drop empties before windowing, so an empty message never takes a slot.
  const messages = keepRecent(pairTools(list.map(parseMessage).filter((message): message is ChatMessageIn => message !== null)));
  const tools = Array.isArray(raw.tools) ? [...new Set(raw.tools.filter(isToolName))] : [];
  return {
    messages,
    system: String(raw.system ?? "").slice(0, 8000),
    fast: Boolean(raw.fast),
    provider: typeof raw.provider === "string" ? raw.provider.slice(0, 32) : undefined,
    ...(tools.length ? { tools, toolChoice: raw.toolChoice === "none" ? ("none" as const) : ("auto" as const) } : {}),
  };
}

/**
 * The same request for a provider that refuses tools: no tool list, and the
 * tool traffic so far rewritten as plain text so the history still makes sense.
 */
export function withoutTools(input: ChatInput): ChatInput {
  const messages: ChatMessageIn[] = input.messages.map((message) => {
    if (message.role === "tool") return { role: "user", content: `[Tool result for ${message.tool_call_id}]\n${message.content}`.slice(0, MESSAGE_CHARS) };
    if (message.role === "assistant" && message.tool_calls) {
      const asked = message.tool_calls.map((call) => `${call.name}(${call.arguments.slice(0, 200)}) [${call.id}]`).join(", ");
      return { role: "assistant", content: `${message.content ? `${message.content}\n` : ""}[Asked for tools: ${asked}]`.slice(0, MESSAGE_CHARS) };
    }
    return message;
  });
  const plain: ChatInput = { ...input, messages };
  delete plain.tools;
  delete plain.toolChoice;
  return plain;
}

/** True when a provider's error says it refused the request because of the tools field. */
export function rejectsTools(input: ChatInput, status: number, error: string): boolean {
  return Boolean(input.tools?.length) && [400, 404, 422].includes(status) && /tool|function/i.test(error);
}

/** The OpenAI wire form of one message. */
function wire(message: ChatMessageIn) {
  if (message.role === "tool") return { role: "tool", tool_call_id: message.tool_call_id, content: message.content };
  if (message.role === "assistant" && message.tool_calls) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.tool_calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
    };
  }
  return { role: message.role, content: message.content };
}

/** Appended in Flash mode: short answers stream faster and fit the smaller cap. */
export const FLASH_RULE =
  "\n\nFlash mode: answer in under 150 words. Give code only when asked or when the fix needs it, and then only the changed part.";

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
    messages: [{ role: "system", content: (input.system || "You are ToolNeuron.") + (input.fast ? FLASH_RULE : "") }, ...input.messages.map(wire)],
    ...(input.tools?.length ? { tools: toolDefinitions(input.tools), tool_choice: input.toolChoice ?? "auto" } : {}),
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
