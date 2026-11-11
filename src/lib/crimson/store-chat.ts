/** Chat, handoff and terminal-AI actions of the workspace store. */
import { askCrimson } from "./ai.functions";
import { findHandoff, formatHandoff, HANDOFF_NAME, stripModeLabel } from "./handoff";
import { activePersonality, historyForModel, systemPrompt, terminalPrompt } from "./prompt";
import { languageFromName } from "./seed";
import { session, type StoreApi } from "./store-shared";
import type { OsState } from "./store";
import { streamChat } from "./stream-chat";
import type { ChatMessage, ProjectFile } from "./types";

export function chatActions(
  get: StoreApi["get"],
  set: StoreApi["set"],
): Pick<OsState, "consult" | "stopChat" | "handOff" | "clearHandoff" | "askTerminal"> {
  return {
  consult: async (prompt) => {
    const text = prompt.trim();
    if (!text || get().busy) return;
    const user: ChatMessage = { role: "user", text, timestamp: Date.now() };
    const history = [...get().chat, user];
    set({ chat: history, busy: true, tab: "toolneuron", module: "chat" });
    try {
      const fileMatch = text.match(/(?:create|generate) (?:a )?(?:new )?file named ([A-Za-z0-9_.-]+)/i);
      const startedIn = session.generation;
      // See historyForModel: refused turns, notices and the welcome line are left out.
      const messages = historyForModel(history, activePersonality(get().personalities).name);
      if (fileMatch) {
        messages[messages.length - 1] = {
          role: "user",
          content: `Write only the raw file contents for ${fileMatch[1]}. Request: ${text}`,
        };
      }
      const startedAt = Date.now();
      const controller = new AbortController();
      session.chatAbort = controller;
      const system = systemPrompt(get(), text);
      set({ chat: [...get().chat, { role: "ai", text: "", timestamp: startedAt, pending: true, skills: system.skills, mode: activePersonality(get().personalities).name }] });
      // Replace the streaming placeholder (always the message stamped startedAt).
      const patchReply = (patch: Partial<ChatMessage> | null, extra: ChatMessage[] = []) => {
        const chat = get().chat.flatMap((message) =>
          message.timestamp === startedAt && message.role === "ai"
            ? patch
              ? [{ ...message, ...patch, ...(typeof patch.text === "string" ? { text: stripModeLabel(patch.text) } : {}) }]
              : []
            : [message],
        );
        set({ chat: [...chat, ...extra] });
      };
      const result = await streamChat(
        { messages, system: system.prompt, fast: get().fast && !fileMatch, provider: get().provider },
        { signal: controller.signal, onDelta: (textSoFar) => patchReply({ text: textSoFar }), onNote: (note) => patchReply({ note }) },
      );
      if (session.chatAbort === controller) session.chatAbort = null;

      if (startedIn !== session.generation) return; // the workspace was reset or replaced while the reply streamed
      if (fileMatch && result.ok) {
        const name = fileMatch[1];
        const id = `gen_${Date.now()}`;
        const parent = get().files.find((file) => file.parentId === null)?.id ?? "root";
        const fenced = result.text.match(/```[^\n]*\n([\s\S]*?)```/);
        const content = (fenced ? fenced[1] : result.text).trim();
        const item: ProjectFile = {
          id,
          name,
          type: "file",
          parentId: parent,
          language: languageFromName(name),
          content,
        };
        patchReply({ text: `Wrote ${name} into the project and opened it in the editor.`, pending: false });
        set({ files: [...get().files, item], activeFileId: id, draft: content, busy: false });
        return;
      }
      if (result.ok) {
        patchReply({ text: result.text, pending: false, ...(result.cut ? { cut: true } : {}) });
      } else if (result.text.trim()) {
        // Keep what arrived; flag the cut or add the error as a separate notice.
        patchReply(
          { text: result.text, pending: false, stopped: result.stopped === true },
          result.stopped ? [] : [{ role: "ai", text: result.error, timestamp: Date.now(), error: true }],
        );
      } else {
        patchReply({ text: result.error, pending: false, error: true });
      }
      set({ busy: false });
    } catch {
      session.chatAbort = null;
      set({
        chat: [
          ...get().chat.filter((message) => !message.pending),
          { role: "ai", text: "The link dropped before a reply landed.", timestamp: Date.now(), error: true },
        ],
        busy: false,
      });
    }
  },

  stopChat: () => {
    session.chatAbort?.abort();
  },

  handOff: (timestamp) => {
    const state = get();
    const reply = state.chat.find((message) => message.timestamp === timestamp && message.role === "ai" && !message.error && !message.pending && !message.intro);
    if (!reply || !reply.text.trim()) return;
    // Replies from before mode labels (and the welcome message) have no mode.
    const content = formatHandoff(reply.mode ?? "", reply.cut ? `${reply.text}\n\n[This reply was cut off at the length limit.]` : reply.text, new Date());
    const existing = findHandoff(state.files);
    if (existing) {
      set({
        files: state.files.map((file) => (file.id === existing.id ? { ...file, content } : file)),
        // Keep the editor in step when the note is open.
        ...(state.activeFileId === existing.id ? { draft: content } : {}),
      });
      return;
    }
    const parent = state.files.find((file) => file.parentId === null)?.id ?? "root";
    const item: ProjectFile = { id: `handoff_${Date.now()}`, name: HANDOFF_NAME, type: "file", parentId: parent, language: "markdown", content };
    set({ files: [...state.files, item] });
  },

  clearHandoff: () => {
    const note = findHandoff(get().files);
    if (note) get().deleteItem(note.id);
  },

  askTerminal: async (prompt) => {
    if (get().busy) {
      get().pushTerminal(["[WARN] Link is already busy."]);
      return;
    }
    set({ busy: true });
    const persona = activePersonality(get().personalities);
    try {
      const system = terminalPrompt(get(), prompt, get().cwd);
      if (system.skills.length) get().pushTerminal([`[SKILL] ${system.skills.join(", ")}`]);
      const result = await askCrimson({
        data: {
          messages: [{ role: "user", content: prompt }],
          system: system.prompt,
          fast: true,
          provider: get().provider,
        },
      });
      get().pushTerminal(
        result.ok
          ? [...(result.note ? [`[INFO] ${result.note.slice(0, 200)}`] : []), `CORE (${persona.name.toUpperCase()}): ${result.text}`]
          : [`[ERROR] ${result.error}`],
      );
    } catch {
      get().pushTerminal(["[ERROR] The AI link dropped."]);
    } finally {
      set({ busy: false });
    }
  },
  };
}
