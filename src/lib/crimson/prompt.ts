/**
 * What the AI is sent: system prompts for chat and the terminal, the chat
 * history, and the save upgrades that decide which skills and welcome line a
 * mode has. Pure functions over plain state, so they are unit-tested
 * (prompt.test.ts) without the store or a browser.
 */
import { findHandoff, HANDOFF_NAME, handoffBlock, labelHistory } from "./handoff.ts";
import { knowledgeBlock, retrieve } from "./knowledge.ts";
import { DEFAULT_SKILLS, pickSkills, skillsBlock } from "./skills/catalog.ts";
import type { ChatMessage, Pack, Personality, ProjectFile } from "./types.ts";

/** The slice of app state the prompts read. */
export type PromptState = {
  personalities: Personality[];
  files: ProjectFile[];
  activeFileId: string;
  /** The last file opened other than handoff.md. */
  workFileId: string;
  /** Live editor text of the active file. */
  draft: string;
  packs: Pack[];
};

/** System prompt budget; the server caps it at 8,000 characters. */
export const PROMPT_BUDGET = 7800;
/** How many past chat messages go to the model. */
export const HISTORY_LIMIT = 8;

export const BASE_RULES =
  "You are inside ToolNeuron, a local neural IDE. Be concrete. Short paragraphs. Fence code with a language tag. Do not claim you executed code or rendered an image. You cannot edit files yourself: the file you are working on is included below when one is open, so answer with the changed code (the whole function or file) for the user to apply. Never start a reply with a [Reply from … mode] tag.";

export const WELCOME = "Neural interface up. Files stay in this browser. Pick a mode in the header, then ask about the open file.";
/** The welcome line saved before it was mode-neutral (it always claimed Architect). */
export const OLD_WELCOME =
  "Neural interface up. I am running as the Architect. Files stay in this browser. Ask about the open file, or switch personalities in the header.";

export function activePersonality(list: Personality[]): Personality {
  return list.find((item) => item.active) ?? list[0];
}

/** Older saves hold a welcome line that claimed Architect mode; make it the neutral intro. */
export function upgradeWelcome(message: ChatMessage): ChatMessage {
  return message.role === "ai" && (message.intro || message.text === OLD_WELCOME) ? { ...message, text: WELCOME, intro: true } : message;
}

/**
 * The file the AI should treat as the work in progress: the saved choice if it
 * still exists, else the open file, else (when the open file is the note) the
 * first other file.
 */
export function pickWorkFile(files: ProjectFile[], saved: string | undefined, activeFileId: string): string {
  const note = findHandoff(files)?.id;
  const usable = (id: string | undefined) => Boolean(id && id !== note && files.some((file) => file.id === id && file.type === "file"));
  if (usable(saved)) return saved!;
  if (usable(activeFileId)) return activeFileId;
  return files.find((file) => file.type === "file" && file.id !== note)?.id ?? "";
}

/** The pinned handoff note's text (the live draft when it is the open file). */
export function handoffText(state: Pick<PromptState, "files" | "activeFileId" | "draft">): string | undefined {
  const note = findHandoff(state.files);
  if (!note) return undefined;
  return note.id === state.activeFileId ? state.draft : note.content;
}

/**
 * System prompt for one chat message: persona, base rules, the skills
 * relevant to this message, the pinned handoff note, the knowledge-pack
 * sections that match this message, then
 * the file being worked on (cut to what is left of the budget).
 */
export function systemPrompt(state: PromptState, message: string): { prompt: string; skills: string[] } {
  const persona = activePersonality(state.personalities);
  const open = state.files.find((item) => item.id === state.activeFileId);
  const note = findHandoff(state.files);
  // While the handoff note is open, the code being worked on is still the last other file.
  const noteOpen = Boolean(open && open.id === note?.id);
  const file = noteOpen ? state.files.find((item) => item.id === state.workFileId && item.type === "file" && item.id !== note?.id) : open;
  // The open file's live draft, even when the user emptied it.
  const fileText = file ? (file.id === state.activeFileId ? state.draft : (file.content ?? "")) : "";
  const knowledge = knowledgeBlock(retrieve(state.packs, message));
  const skills = pickSkills(persona?.skills, message);
  const label = noteOpen ? `Working file ${file?.name} (the user has ${HANDOFF_NAME} open in the editor)` : `Open file ${file?.name}`;
  // Reserve room for the file first, then fit the other sections into what is left.
  const fileWant = file ? label.length + 2 + fileText.length : 0;
  const fileFloor = Math.min(fileWant, FILE_FLOOR);
  const head = fitSections(
    [
      { text: persona?.instruction ?? "", min: 600 },
      { text: BASE_RULES, min: BASE_RULES.length },
      { text: skillsBlock(skills).slice(0, 1600), min: 700 },
      { text: handoffBlock(handoffText(state)), min: 800 },
      { text: knowledge, min: 0 },
    ],
    PROMPT_BUDGET - fileFloor - 4,
  );
  const room = PROMPT_BUDGET - head.length - 4 - label.length - 2;
  const code = file ? `${label}:\n${clipFile(fileText, room)}` : "";
  const prompt = [head, code].filter(Boolean).join("\n\n");
  return { prompt: prompt.slice(0, PROMPT_BUDGET), skills: skills.map((skill) => skill.name) };
}

/** Room always kept for the open file (when it is that long). */
export const FILE_FLOOR = 2000;
const CUT = "\n[…cut to fit]";

/**
 * Joins sections with blank lines within `budget` characters. When they do
 * not fit, sections are shortened from the LAST one backwards (knowledge,
 * then the handoff note, then skills, then the persona), never below their
 * `min`, each cut marked; the result is then hard-capped.
 */
export function fitSections(sections: { text: string; min: number }[], budget: number): string {
  const parts = sections.map((section) => ({ ...section, text: section.text.trim() })).filter((section) => section.text);
  const total = () => parts.reduce((sum, part) => sum + part.text.length, 0) + Math.max(0, parts.length - 1) * 2;
  for (let index = parts.length - 1; index >= 0 && total() > budget; index--) {
    const part = parts[index];
    const over = total() - budget;
    const target = Math.max(part.min, part.text.length - over - CUT.length);
    if (target < part.text.length) part.text = target <= 0 ? "" : part.text.slice(0, target) + CUT;
  }
  return parts
    .filter((part) => part.text)
    .map((part) => part.text)
    .join("\n\n")
    .slice(0, Math.max(0, budget));
}

/** The file text within `room` characters, cut at a line end with a note saying how much was left out. */
export function clipFile(text: string, room: number): string {
  if (text.length <= room) return text;
  const lines = text.split("\n").length;
  const keep = Math.max(0, room - 80);
  const cutAt = text.lastIndexOf("\n", keep);
  const shown = text.slice(0, cutAt > 0 ? cutAt : keep);
  const shownLines = shown.split("\n").length;
  return `${shown}\n[file cut to fit: first ${shownLines} of ${lines} lines shown]`;
}

/** System prompt for the terminal's `ai` command: one skill, a short note, a short answer. */
export function terminalPrompt(state: PromptState, question: string, cwd: string): { prompt: string; skills: string[] } {
  const persona = activePersonality(state.personalities);
  const skills = pickSkills(persona?.skills, question, 1);
  const tail = `Reply as a terminal specialist in under 80 words. Current directory ${cwd}.`;
  // The instruction goes last and must survive, so the rest is fitted around it.
  const head = fitSections(
    [
      { text: persona?.instruction ?? "", min: 600 },
      { text: skillsBlock(skills), min: 400 },
      { text: handoffBlock(handoffText(state), 1200), min: 0 },
    ],
    PROMPT_BUDGET - tail.length - 2,
  );
  return { prompt: [head, tail].filter(Boolean).join("\n"), skills: skills.map((skill) => skill.name) };
}

/**
 * Chat history as sent to the model: no error notices, no user turns that
 * only produced an error (so a refused request is never answered later), no
 * welcome line; the last HISTORY_LIMIT messages, with other modes' replies
 * labelled.
 */
export function historyForModel(history: ChatMessage[], currentMode: string) {
  const kept = history
    .filter((message, index) => !message.error && !message.intro && !(message.role === "user" && history[index + 1]?.error))
    .slice(-HISTORY_LIMIT);
  return labelHistory(kept, currentMode);
}

/**
 * Bumped when built-in modes gain default skills. Rev 1 covered 9 modes;
 * rev 2 added Nightwatch, Lattice and Oracle.
 */
export const SKILLS_REV = 2;

/**
 * Fills in default skills for built-in modes. A save with no skills list
 * (from before skills existed) always gets defaults; an empty list on a
 * built-in mode is refilled only once, when the save predates SKILLS_REV,
 * so a mode the user cleared on purpose stays empty. Custom personas
 * (no defaults) are left as they are.
 */
export function withDefaultSkills(list: Personality[], savedRev: number): Personality[] {
  return list.map((item) => {
    const defaults = DEFAULT_SKILLS[item.name];
    if (!Array.isArray(item.skills)) return { ...item, skills: defaults ?? [] };
    if (defaults && item.skills.length === 0 && savedRev < SKILLS_REV) return { ...item, skills: defaults };
    return item;
  });
}
