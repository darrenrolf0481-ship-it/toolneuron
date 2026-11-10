import type { ChatInput } from "./chat-input";

export type StreamResult =
  | { ok: true; text: string; model?: string; /** Hit the token limit mid-reply. */ cut?: boolean; /** Another provider answered after the chosen one failed. */ note?: string }
  | { ok: false; text: string; error: string; stopped?: boolean };

/** Streams a reply from /api/chat, calling onDelta with the text so far. Abort the signal to stop. */
export async function streamChat(
  input: Omit<ChatInput, "messages"> & { messages: { role: string; content: string }[] },
  { signal, onDelta, onNote }: { signal: AbortSignal; onDelta: (textSoFar: string) => void; onNote?: (note: string) => void },
): Promise<StreamResult> {
  let text = "";
  let error: string | null = null;
  let model: string | undefined;
  let truncated = false;
  let note: string | undefined;
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(input),
      signal,
    });
    if (!response.body) return { ok: false, text, error: `Chat link returned ${response.status}.` };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n")) !== -1) {
        const row = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 1);
        if (!row.trim()) continue;
        let event: { t?: string; v?: unknown; model?: unknown; cut?: unknown };
        try {
          event = JSON.parse(row);
        } catch {
          continue;
        }
        if (event.t === "delta" && typeof event.v === "string") {
          text += event.v;
          onDelta(text);
        } else if (event.t === "note" && typeof event.v === "string") {
          note = event.v;
          onNote?.(event.v);
        } else if (event.t === "error" && typeof event.v === "string") {
          error = event.v;
        } else if (event.t === "done") {
          if (typeof event.model === "string") model = event.model;
          if (event.cut === true) truncated = true;
        }
      }
    }
  } catch (caught) {
    if (signal.aborted) return { ok: false, text, error: "Stopped.", stopped: true };
    return { ok: false, text, error: caught instanceof Error ? `The link dropped: ${caught.message}` : "The link dropped." };
  }
  if (signal.aborted) return { ok: false, text, error: "Stopped.", stopped: true };
  if (error) return { ok: false, text, error };
  return { ok: true, text, model, cut: truncated, note };
}
