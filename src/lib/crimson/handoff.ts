/**
 * Handoff notes: one mode's reply saved as `handoff.md` at the project root,
 * pinned into every later chat prompt until the file is cleared or deleted.
 * The file is an ordinary project file, so it can be edited in the editor.
 */

export const HANDOFF_NAME = "handoff.md";
/** Most of the pinned note that goes into the system prompt. */
export const HANDOFF_PROMPT_MAX = 2400;

type FileLike = { id: string; name: string; type: string; parentId: string | null; content?: string };

const HEADING = /^# Handoff from (.+)$/m;

/** The note file: a heading naming the mode, the time, then the reply. */
export function formatHandoff(mode: string, text: string, when: Date): string {
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
  return `# Handoff from ${mode.trim() || "an earlier mode"}\n\n_${stamp}. Edit freely: the next mode reads this note until you clear it._\n\n${text.trim()}\n`;
}

/** Which mode wrote the note, if the heading is still there. */
export function handoffFrom(content: string): string | null {
  return content.match(HEADING)?.[1].trim() || null;
}

/** The handoff file at the project root, if any. */
export function findHandoff<T extends FileLike>(files: T[]): T | undefined {
  const root = files.find((file) => file.parentId === null);
  return files.find((file) => file.type === "file" && file.name === HANDOFF_NAME && file.parentId === (root?.id ?? null));
}

/**
 * The block pinned into the system prompt, or "" when there is no note.
 * Long notes keep their start and say they were cut.
 */
export function handoffBlock(content: string | undefined, max = HANDOFF_PROMPT_MAX): string {
  const body = (content ?? "").trim();
  if (!body) return "";
  const from = handoffFrom(body);
  const head = `Handoff note${from ? ` from ${from} mode` : ""} (${HANDOFF_NAME}). Treat it as the plan to continue from; if you disagree with it, say so before acting:`;
  const room = Math.max(0, max - head.length - 40);
  const clipped = body.length > room ? `${body.slice(0, room)}\n[note cut for length]` : body;
  return `${head}\n${clipped}`;
}

type HistoryMessage = { role: "user" | "ai"; text: string; mode?: string };

/**
 * Chat history as sent to the model. Replies written by a different mode
 * than the current one are labelled, so the model knows whose plan it is.
 */
export function labelHistory(history: HistoryMessage[], currentMode: string) {
  return history.map((message) => ({
    role: message.role,
    content: message.role === "ai" && message.mode && message.mode !== currentMode ? `[Reply from ${message.mode} mode]\n${message.text}` : message.text,
  }));
}

const COPIED_LABEL = /^\s*\[Reply from [^\]\n]{1,80} mode\]\s*\n?/;

/** Models sometimes copy the history label into their own reply; drop it. */
export function stripModeLabel(text: string): string {
  return text.replace(COPIED_LABEL, "");
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}
