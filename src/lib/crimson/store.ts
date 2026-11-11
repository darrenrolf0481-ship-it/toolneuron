import { create } from "zustand";
import { findHandoff } from "./handoff";
import * as Git from "./git";
import { nameProblem } from "./names";
import { languageFromName, SEED_PERSONALITIES, TEMPLATES } from "./seed";
import { chatActions } from "./store-chat";
import { gitActions } from "./store-git";
import { forgetSave } from "./store-persist";
import { cancelWork, fresh, stamp } from "./store-shared";
import {
  applyFix,
  idleRun,
  runFix,
  runReview,
  stopSwarm,
  undoFix,
  type SwarmFix,
  type SwarmMemory,
  type SwarmRun,
  type SwarmUndo,
} from "./swarm/engine";
import type {
  ChatMessage,
  EditorMode,
  GitState,
  Module,
  Pack,
  Personality,
  ProjectFile,
  StorageItem,
  SwarmLog,
  Tab,
} from "./types";

/*
 * The workspace store. Its larger parts live in slices:
 *   store-git.ts      git, GitHub clone / push / pull
 *   store-chat.ts     chat, handoff, terminal AI
 *   store-persist.ts  localStorage + IndexedDB saving, export / import
 *   store-shared.ts   the fresh workspace and cancellable in-flight work
 */
export { bootPersistence, exportNode, flushSave, importNode } from "./store-persist";

export type OsState = {
  booted: boolean;
  /** Where git history lives: IndexedDB, localStorage (fallback), or still loading. */
  gitStorage: "loading" | "indexeddb" | "local";
  tab: Tab;
  theme: "night" | "dayglass";
  module: Module;
  personalities: Personality[];
  fast: boolean;
  provider: string;
  files: ProjectFile[];
  activeFileId: string;
  /** The last file opened other than handoff.md; still sent to the AI while the note is open. */
  workFileId: string;
  draft: string;
  chat: ChatMessage[];
  packs: Pack[];
  swarmAnxiety: number;
  swarmLogs: SwarmLog[];
  swarmHot: boolean;
  swarmRun: SwarmRun;
  swarmFix: SwarmFix | null;
  swarmUndo: SwarmUndo | null;
  /** Archivist memory: verified findings from past runs. */
  swarmMemory: SwarmMemory[];
  terminal: string[];
  cwd: string;
  termHistory: string[];
  storage: StorageItem[];
  git: GitState;
  editorMode: EditorMode;
  /** Last run output per file id (session only). */
  outputs: Record<string, string>;
  busy: boolean;
  savedAt: string;
  /** Set when localStorage refuses a save (quota). */
  saveError: string | null;
  setTab: (tab: Tab) => void;
  setModule: (module: Module) => void;
  setTheme: (theme: "night" | "dayglass") => void;
  setFast: (fast: boolean) => void;
  setProvider: (provider: string) => void;
  setDraft: (draft: string) => void;
  setEditorMode: (mode: EditorMode) => void;
  setOutput: (fileId: string, output: string) => void;
  activatePersonality: (id: number) => void;
  addPersonality: (name: string, instruction: string, suggestions?: string[], skills?: string[]) => void;
  updatePersonality: (id: number, patch: { name: string; instruction: string; suggestions: string[]; skills?: string[] }) => void;
  removePersonality: (id: number) => void;
  openFile: (id: string) => void;
  toggleFolder: (id: string) => void;
  flushDraft: () => void;
  /** Returns why the name was refused, or null when the item was created. */
  createItem: (parentId: string, type: "file" | "folder", name: string) => string | null;
  /** Returns why the name was refused, or null when the item was renamed. */
  renameItem: (id: string, name: string) => string | null;
  deleteItem: (id: string) => void;
  loadTemplate: (key: string) => void;
  pushTerminal: (lines: string[]) => void;
  clearTerminal: () => void;
  setCwd: (cwd: string) => void;
  rememberCommand: (cmd: string) => void;
  gitInit: () => void;
  /** Stages repo paths ("." for everything). */
  gitAdd: (paths: string[]) => void;
  /** Commits the index; false when nothing is staged. */
  gitCommit: (message: string) => boolean;
  /** Sets git state and writes restored contents into existing files. */
  /** Sets git state and applies file changes (restore, checkout, switch, merge). */
  applyGit: (git: GitState, changes?: Git.FileChange[]) => boolean;
  /** Pushes the current branch's unpushed commits to the linked GitHub repo. */
  gitPush: () => Promise<{ ok: boolean; message: string }>;
  /** Fetches new GitHub commits for the current branch and merges them in. */
  gitPull: () => Promise<{ ok: boolean; message: string }>;
  /** Copies a public GitHub repo's text files into the project (owner/name). */
  cloneRepo: (repo: string) => Promise<void>;
  addPack: (pack: Pack) => void;
  togglePack: (id: string) => void;
  removePack: (id: string) => void;
  runSwarm: (goal: string) => Promise<void>;
  stopSwarm: () => void;
  fixFinding: (findingId: string) => Promise<void>;
  applySwarmFix: () => void;
  discardSwarmFix: () => void;
  undoSwarmFix: () => void;
  addStorage: (items: StorageItem[]) => void;
  removeStorage: (id: string) => void;
  consult: (prompt: string) => Promise<void>;
  stopChat: () => void;
  /** Saves an AI reply as handoff.md, pinned into later prompts. */
  handOff: (timestamp: number) => void;
  /** Deletes handoff.md, unpinning it. */
  clearHandoff: () => void;
  askTerminal: (prompt: string) => Promise<void>;
  resetNode: () => void;
};

export const useOs = create<OsState>((set, get) => ({
  booted: false,
  gitStorage: "loading",
  swarmHot: false,
  swarmRun: idleRun(),
  swarmFix: null,
  swarmUndo: null,
  busy: false,
  saveError: null,
  ...fresh(),
  ...gitActions(get, set),
  ...chatActions(get, set),

  setTab: (tab) => set({ tab }),
  setModule: (module) => set({ module }),
  setTheme: (theme) => set({ theme }),
  setFast: (fast) => set({ fast }),
  setProvider: (provider) => set({ provider }),
  setDraft: (draft) => set({ draft }),
  setEditorMode: (mode) => set({ editorMode: mode }),
  setOutput: (fileId, output) => set({ outputs: { ...get().outputs, [fileId]: output } }),

  activatePersonality: (id) =>
    set({
      personalities: get().personalities.map((item) => ({ ...item, active: item.id === id })),
    }),

  addPersonality: (name: string, instruction: string, suggestions?: string[], skills?: string[]) => {
    const id = Date.now();
    const chips = (suggestions ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 4);
    set({
      personalities: [
        ...get().personalities.map((item) => ({ ...item, active: false })),
        {
          id,
          name,
          instruction,
          active: true,
          suggestions: chips.length > 0 ? chips : ["Review the open file", "What next?"],
          skills: skills ?? [],
        },
      ],
    });
  },

  updatePersonality: (id, patch) => {
    const chips = patch.suggestions.map((item) => item.trim()).filter(Boolean).slice(0, 4);
    set({
      personalities: get().personalities.map((item) =>
        item.id === id
          ? {
              ...item,
              name: patch.name.trim() || item.name,
              instruction: patch.instruction.trim() || item.instruction,
              suggestions: chips.length > 0 ? chips : item.suggestions,
              skills: patch.skills ?? item.skills,
            }
          : item,
      ),
    });
  },

  removePersonality: (id) => {
    const next = get().personalities.filter((item) => item.id !== id);
    if (next.length === 0) return;
    if (!next.some((item) => item.active)) next[0] = { ...next[0], active: true };
    set({ personalities: next });
  },

  flushDraft: () => {
    const { files, activeFileId, draft } = get();
    set({
      files: files.map((file) => (file.id === activeFileId && file.type === "file" ? { ...file, content: draft } : file)),
      savedAt: stamp(),
    });
  },

  openFile: (id) => {
    const state = get();
    const files = state.files.map((file) =>
      file.id === state.activeFileId && file.type === "file" ? { ...file, content: state.draft } : file,
    );
    const next = files.find((file) => file.id === id);
    if (!next || next.type !== "file") {
      set({ files });
      return;
    }
    set({
      files,
      activeFileId: id,
      ...(next.id === findHandoff(files)?.id ? {} : { workFileId: id }),
      draft: next.content ?? "",
      editorMode: next.language === "html" ? state.editorMode : "code",
      savedAt: stamp(),
    });
  },

  toggleFolder: (id) =>
    set({
      files: get().files.map((file) => (file.id === id ? { ...file, isOpen: !file.isOpen } : file)),
    }),

  createItem: (parentId, type, name) => {
    const trimmed = name.trim();
    const problem = nameProblem(get().files, parentId, trimmed);
    if (problem) return problem;
    const id = `f_${Date.now()}`;
    const item: ProjectFile = {
      id,
      name: trimmed,
      type,
      parentId,
      isOpen: type === "folder",
      language: type === "file" ? languageFromName(trimmed) : undefined,
      content: type === "file" ? "" : undefined,
    };
    const files = get().files.map((file) => (file.id === parentId ? { ...file, isOpen: true } : file)).concat(item);
    if (type === "file") {
      get().flushDraft();
      set({ files: get().files.concat(item).map((file) => (file.id === parentId ? { ...file, isOpen: true } : file)), activeFileId: id, draft: "" });
      return null;
    }
    set({ files });
    return null;
  },

  renameItem: (id, name) => {
    const trimmed = name.trim();
    const item = get().files.find((file) => file.id === id);
    if (!item || id === "root") return null;
    if (trimmed === item.name) return null;
    const problem = nameProblem(get().files, item.parentId, trimmed, id);
    if (problem) return problem;
    set({
      files: get().files.map((file) =>
        file.id === id
          ? { ...file, name: trimmed, language: file.type === "file" ? languageFromName(trimmed) : file.language }
          : file,
      ),
    });
    return null;
  },

  deleteItem: (id) => {
    if (id === "root") return;
    const drop = new Set<string>([id]);
    let grew = true;
    const files = get().files;
    while (grew) {
      grew = false;
      for (const file of files) {
        if (file.parentId && drop.has(file.parentId) && !drop.has(file.id)) {
          drop.add(file.id);
          grew = true;
        }
      }
    }
    const next = files.filter((file) => !drop.has(file.id));
    const state = get();
    const git = { ...state.git, staged: state.git.staged.filter((staged) => !drop.has(staged)) };
    const outputs = Object.fromEntries(Object.entries(state.outputs).filter(([fileId]) => !drop.has(fileId)));
    if (!drop.has(state.activeFileId)) {
      set({ files: next, git, outputs });
      return;
    }
    const fallback = next.find((file) => file.type === "file");
    set({
      files: next,
      git,
      outputs,
      activeFileId: fallback?.id ?? "",
      draft: fallback?.content ?? "",
    });
  },

  loadTemplate: (key) => {
    const template = TEMPLATES[key];
    if (!template) return;
    const first = template.files.find((file) => file.type === "file");
    set({
      files: template.files,
      activeFileId: first?.id ?? "",
      draft: first?.content ?? "",
      git: { ...Git.EMPTY_GIT },
      editorMode: first?.language === "html" ? "preview" : "code",
      savedAt: stamp(),
    });
  },

  pushTerminal: (lines) => set({ terminal: [...get().terminal, ...lines].slice(-200) }),
  clearTerminal: () => set({ terminal: ["Buffer flushed."] }),
  setCwd: (cwd) => set({ cwd }),
  rememberCommand: (cmd) => set({ termHistory: [cmd, ...get().termHistory].slice(0, 40) }),

  addPack: (pack) => set({ packs: [pack, ...get().packs] }),
  togglePack: (id) => set({ packs: get().packs.map((pack) => (pack.id === id ? { ...pack, armed: !pack.armed } : pack)) }),
  removePack: (id) => set({ packs: get().packs.filter((pack) => pack.id !== id || pack.id === "doctrine") }),

  runSwarm: (goal) => runReview({ get, set }, goal),
  stopSwarm: () => stopSwarm(),
  fixFinding: (findingId) => runFix({ get, set }, findingId),
  applySwarmFix: () => applyFix({ get, set }),
  discardSwarmFix: () => {
    if (!get().swarmHot) set({ swarmFix: null });
  },
  undoSwarmFix: () => undoFix({ get, set }),

  addStorage: (items) => set({ storage: [...items, ...get().storage] }),
  removeStorage: (id) => set({ storage: get().storage.filter((item) => item.id !== id) }),

  resetNode: () => {
    cancelWork();
    forgetSave();
    set({ ...fresh(), busy: false, swarmHot: false, swarmRun: idleRun(), swarmFix: null, swarmUndo: null, booted: true });
  },
}));

if (typeof window !== "undefined") {
  const current = useOs.getState().personalities;
  const known = new Set(current.map((item) => item.name));
  const extras = SEED_PERSONALITIES.filter((item) => !known.has(item.name)).map((item) => ({ ...item, active: false }));
  if (extras.length > 0) useOs.setState({ personalities: [...current, ...extras] });
}
