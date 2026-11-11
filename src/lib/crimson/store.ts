import { create } from "zustand";
import { askCrimson } from "./ai.functions";
import { parseImport, wrapExport } from "./node-file";
import { streamChat } from "./stream-chat";
import { exportVaultBlob, importVaultBlob } from "./vault/vault-store";
import { findHandoff, formatHandoff, HANDOFF_NAME, stripModeLabel } from "./handoff";
import * as Git from "./git";
import { nameProblem } from "./names";
import { loadGit, openGitDb, requestPersistentStorage, saveGit } from "./git-store";
import { mergeLines } from "./terminal";
import {
  activePersonality,
  historyForModel,
  pickWorkFile,
  SKILLS_REV,
  systemPrompt,
  terminalPrompt,
  upgradeWelcome,
  WELCOME,
  withDefaultSkills,
} from "./prompt";
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
import { languageFromName, SEED_FILES, SEED_PERSONALITIES, TEMPLATES } from "./seed";
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

const KEY = "crimson_os_v1";

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

const BOOT_TERMINAL = ["ToolNeuron terminal: built-in commands on the project files (not a shell).", "Type help."];
/** The first line older saves start their terminal with. */
const OLD_BOOT_LINE = "CRIMSON OS  v4.2  KORE";

function fresh(): Pick<
  OsState,
  | "tab"
  | "theme"
  | "module"
  | "personalities"
  | "fast"
  | "provider"
  | "files"
  | "activeFileId"
  | "workFileId"
  | "draft"
  | "chat"
  | "packs"
  | "swarmAnxiety"
  | "swarmLogs"
  | "swarmMemory"
  | "terminal"
  | "cwd"
  | "termHistory"
  | "storage"
  | "git"
  | "editorMode"
  | "outputs"
  | "savedAt"
> {
  const brain = SEED_FILES.find((file) => file.id === "brain");
  return {
    tab: "toolneuron",
    theme: "night",
    module: "chat",
    personalities: SEED_PERSONALITIES,
    fast: true,
    provider: "",
    files: SEED_FILES,
    activeFileId: "brain",
    workFileId: "brain",
    draft: brain?.content ?? "",
    chat: [
      { role: "ai", text: WELCOME, timestamp: Date.now(), intro: true },
    ],
    packs: [
      {
        id: "doctrine",
        name: "Review_Doctrine",
        size: "6 rules",
        excerpt:
          "Never interpolate SQL. Never assign untrusted HTML to innerHTML. Do not query inside a loop when a join would do. No bare except. Name things for the next reader. Add type hints on public functions.",
        status: "searchable",
        armed: true,
      },
    ],
    swarmAnxiety: 0.02,
    swarmLogs: [{ id: 1, type: "info", message: "Swarm idle. Open a file and run a review.", time: "boot" }],
    swarmMemory: [],
    terminal: BOOT_TERMINAL,
    cwd: "~/crimson-node",
    termHistory: [],
    storage: [
      { id: "s1", name: "Neural_Architecture_v4.pdf", size: "2.4 MB", type: "pdf", date: "2026-03-20" },
      { id: "s2", name: "System_Directives.md", size: "12 KB", type: "md", date: "2026-04-02" },
    ],
    git: { ...Git.EMPTY_GIT },
    editorMode: "code",
    outputs: {},
    savedAt: "",
  };
}

function stamp() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

let wired = false;

export function bootPersistence() {
  if (typeof window === "undefined" || wired) return;
  wired = true;
  let raw: string | null = null;
  // True when this save still carries git history (older versions, or IndexedDB was unavailable).
  let localHasGit = false;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    /* storage blocked (private mode): run in memory */
  }
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<OsState> & { gitInIndexedDb?: boolean };
      bootGitInIdb = parsed.gitInIndexedDb === true;
      // History the last session could not confirm in IndexedDB before it closed is the newest copy.
      try {
        const pending = localStorage.getItem(PENDING_GIT_KEY);
        if (pending) parsed.git = JSON.parse(pending);
      } catch {
        /* unreadable: ignore */
      }
      localHasGit = Boolean(parsed.git && typeof parsed.git === "object");
      delete parsed.gitInIndexedDb;
      const base = fresh();
      const files = Array.isArray(parsed.files) && parsed.files.length > 0 ? parsed.files : base.files;
      const activeFileId = files.some((file) => file.id === parsed.activeFileId) ? parsed.activeFileId! : base.activeFileId;
      const active = files.find((file) => file.id === activeFileId);
      const savedPersonalities = Array.isArray(parsed.personalities) ? parsed.personalities : [];
      const known = new Set(savedPersonalities.map((item) => item.name));
      const personalities =
        savedPersonalities.length === 0
          ? base.personalities
          : [
              ...withDefaultSkills(savedPersonalities, (parsed as { skillsRev?: number }).skillsRev ?? 0),
              ...SEED_PERSONALITIES.filter((item) => !known.has(item.name)).map((item) => ({ ...item, active: false })),
            ];
      useOs.setState({
        ...base,
        ...parsed,
        files,
        activeFileId,
        personalities,
        draft: typeof parsed.draft === "string" ? parsed.draft : (active?.content ?? ""),
        workFileId: pickWorkFile(files, parsed.workFileId, activeFileId),
        // A tab that no longer exists (e.g. the removed Bridge) falls back to the hub.
        tab: TABS.includes(parsed.tab as Tab) ? (parsed.tab as Tab) : base.tab,
        terminal:
          Array.isArray(parsed.terminal) && parsed.terminal[0] === OLD_BOOT_LINE ? [...BOOT_TERMINAL, ...parsed.terminal.slice(3)] : (parsed.terminal ?? base.terminal),
        // Saves from before history was real have commits with no snapshot and no index.
        git: Git.normalizeGit(parsed.git ?? base.git),
        // A reply that was streaming when the page closed is finished as-is.
        chat: (Array.isArray(parsed.chat) ? parsed.chat : base.chat)
          .filter((message) => !(message.pending && !message.text))
          .map((message) => (message.pending ? { ...message, pending: false, stopped: true } : message))
          // Older saves hold the welcome line that claimed Architect mode.
          .map(upgradeWelcome),
        busy: false,
        swarmHot: false,
        booted: true,
      });
    } catch {
      // Corrupt save: keep a copy for recovery, then start clean.
      try {
        localStorage.setItem(`${KEY}_corrupt`, raw);
        localStorage.removeItem(KEY);
      } catch {
        /* ignore */
      }
      useOs.setState({ booted: true });
    }
  } else {
    useOs.setState({ booted: true });
  }
  useOs.subscribe((state, previous) => {
    if (state.booted) scheduleSave();
    if (state.gitStorage === "indexeddb" && state.git !== previous.git) saveGitNow(state.git);
  });
  void initGitStorage(localHasGit);
  // Never lose the last edits when the tab closes or goes to the background.
  // Another tab saved this project: stop saving here so neither overwrites the other.
  window.addEventListener("storage", (event) => {
    if (event.key !== KEY || event.newValue === null || event.newValue === lastSaved || staleTab) return;
    staleTab = true;
    setSaveError("This project was changed in another tab. This tab has stopped saving so it cannot overwrite that work: reload it to continue here.");
  });
  window.addEventListener("pagehide", () => {
    flushSave();
    stashPendingGit();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushSave();
      stashPendingGit();
    }
  });
}

/**
 * Moves git history into IndexedDB (or loads it from there). Saves that
 * still carry git in localStorage are migrated: that copy is the newest.
 * Without IndexedDB, git stays in localStorage as before.
 */
async function initGitStorage(localHasGit: boolean) {
  const db = await openGitDb();
  if (!db) {
    useOs.setState({ gitStorage: "local" });
    return;
  }
  requestPersistentStorage();
  let stored: Awaited<ReturnType<typeof loadGit>> = null;
  try {
    stored = await loadGit();
  } catch {
    stored = null;
  }
  if (localHasGit) {
    try {
      const git = useOs.getState().git;
      await saveGit(git);
      gitConfirmed = git;
      localStorage.removeItem(PENDING_GIT_KEY);
    } catch {
      useOs.setState({ gitStorage: "local" });
      setSaveError("Git history could not be moved to the browser database; it stays in local storage for now.");
      return;
    }
  } else if (stored) {
    const git = Git.normalizeGit(stored);
    gitConfirmed = git;
    useOs.setState({ git });
  } else if (bootGitInIdb) {
    setSaveError("Git history was not found in browser storage (site data may have been cleared). Import a backup from Config if you have one.");
  }
  useOs.setState({ gitStorage: "indexeddb" });
  // Rewrite localStorage without the git history.
  flushSave();
}

// ---- Debounced persistence ----
const SAVE_DELAY_MS = 600;
const SAVE_MAX_WAIT_MS = 3000;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let firstPendingAt = 0;
let lastSaved = "";

function scheduleSave() {
  const now = Date.now();
  if (!saveTimer) firstPendingAt = now;
  if (saveTimer) clearTimeout(saveTimer);
  // Debounce while typing, but never hold changes longer than SAVE_MAX_WAIT_MS.
  const wait = Math.max(0, Math.min(SAVE_DELAY_MS, firstPendingAt + SAVE_MAX_WAIT_MS - now));
  saveTimer = setTimeout(flushSave, wait);
}

export function flushSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const state = useOs.getState();
  if (!state.booted || staleTab) return;
  const json = JSON.stringify(persistable(state, false));
  if (json === lastSaved) return;
  try {
    localStorage.setItem(KEY, json);
    lastSaved = json;
    if (state.saveError) useOs.setState({ saveError: null });
  } catch {
    // Quota hit: retry without bulky history before giving up.
    try {
      const slim = JSON.stringify(persistable(state, true));
      localStorage.setItem(KEY, slim);
      lastSaved = json;
      setSaveError("Browser storage is nearly full: older chat and terminal history was not saved.");
    } catch {
      setSaveError("Browser storage is full: recent changes are NOT saved. Export your node from Config.");
    }
  }
}

const TABS: Tab[] = ["toolneuron", "terminal", "editor", "analysis", "storage", "settings"];

/** Whole-node backup as a JSON string (Config → Export). The vault is included still encrypted. */
export function exportNode(): string {
  const vault = exportVaultBlob();
  return wrapExport({ ...persistable(useOs.getState(), false, true), ...(vault ? { vaultBlob: vault } : {}) });
}

/** Replaces the node with a validated backup. Returns a summary or an error. */
export function importNode(text: string): { ok: true; summary: string } | { ok: false; error: string } {
  const parsed = parseImport(text);
  if (!parsed.ok) return parsed;
  const data = parsed.node;
  generation++;
  chatAbort?.abort();
  chatAbort = null;
  stopSwarm();
  const base = fresh();
  const files = data.files;
  const firstFile = files.find((item) => item.type === "file");
  const activeFileId = files.some((item) => item.id === data.activeFileId && item.type === "file")
    ? data.activeFileId!
    : (firstFile?.id ?? "");
  const active = files.find((item) => item.id === activeFileId);
  const pick = <T,>(value: unknown, fallback: T): T =>
    Array.isArray(fallback) ? (Array.isArray(value) ? (value as T) : fallback) : value !== undefined && typeof value === typeof fallback ? (value as T) : fallback;
  useOs.setState({
    ...base,
    files,
    activeFileId,
    draft: typeof data.draft === "string" && data.activeFileId === activeFileId ? data.draft : (active?.content ?? ""),
    workFileId: pickWorkFile(files, undefined, activeFileId),
    personalities: data.personalities && data.personalities.length > 0 ? withDefaultSkills(data.personalities, 0) : base.personalities,
    chat: data.chat ?? base.chat,
    packs: pick(data.packs, base.packs),
    git: Git.normalizeGit(pick(data.git, base.git)),
    storage: pick(data.storage, base.storage),
    swarmMemory: pick(data.swarmMemory, base.swarmMemory),
    theme: data.theme === "dayglass" ? "dayglass" : base.theme,
    fast: pick(data.fast, base.fast),
    provider: pick(data.provider, base.provider),
    tab: "settings",
    outputs: {},
    busy: false,
    swarmHot: false,
    swarmRun: idleRun(),
    swarmFix: null,
    swarmUndo: null,
    booted: true,
  });
  flushSave();
  // The backup's vault (still encrypted) replaces this browser's vault only if it has one.
  const vaultRestored = data.vaultBlob !== undefined && importVaultBlob(data.vaultBlob);
  const fileCount = files.filter((item) => item.type === "file").length;
  return { ok: true, summary: `Imported ${fileCount} file${fileCount === 1 ? "" : "s"}${data.chat && data.chat.length ? ` and ${data.chat.length} chat message${data.chat.length === 1 ? "" : "s"}` : ""}.${vaultRestored ? " The encrypted vault was restored; unlock it with its passphrase." : ""}` };
}

function setSaveError(message: string) {
  if (useOs.getState().saveError !== message) useOs.setState({ saveError: message });
}

/** localStorage key for git history not yet confirmed in IndexedDB when the page was hidden or closed. */
const PENDING_GIT_KEY = `${KEY}_git_pending`;
/** The git object IndexedDB has confirmed writing. */
let gitConfirmed: unknown = null;

/** Writes git history to IndexedDB right away (not debounced: an async write can be lost if the page closes first). */
function saveGitNow(git: GitState) {
  if (staleTab) return;
  saveGit(git)
    .then(() => {
      if (useOs.getState().git !== git) return;
      gitConfirmed = git;
      // A newer copy is safely in IndexedDB; the emergency copy (if any) is stale now.
      try {
        localStorage.removeItem(PENDING_GIT_KEY);
      } catch {
        /* ignore */
      }
    })
    .catch((error: unknown) => {
      const quota = error instanceof DOMException && error.name === "QuotaExceededError";
      setSaveError(
        quota
          ? "Browser storage is full: the latest git history is NOT saved. Export your node from Config, then free space."
          : "Git history could not be saved to browser storage. Export your node from Config.",
      );
    });
}

/** On hide or close: if IndexedDB has not confirmed the latest history, keep a synchronous copy in localStorage. */
function stashPendingGit() {
  const state = useOs.getState();
  if (staleTab || state.gitStorage !== "indexeddb" || gitConfirmed === state.git) return;
  try {
    localStorage.setItem(PENDING_GIT_KEY, JSON.stringify(state.git));
  } catch {
    /* quota: the IndexedDB write may still finish */
  }
}

/** True when localStorage at boot said git lives in IndexedDB (so an empty in-memory git must not be saved over it). */
let bootGitInIdb = false;

/**
 * What goes into localStorage. Git history is left out once it lives in
 * IndexedDB (see git-store.ts); `full` (for export) always includes it.
 */
function persistable(state: OsState, slim: boolean, full = false) {
  const gitElsewhere = !full && (state.gitStorage === "indexeddb" || (state.gitStorage === "loading" && bootGitInIdb));
  return {
      ...(gitElsewhere ? { gitInIndexedDb: true } : {}),
      skillsRev: SKILLS_REV,
      tab: state.tab,
      theme: state.theme,
      module: state.module,
      personalities: state.personalities,
      fast: state.fast,
      provider: state.provider,
      files: state.files,
      activeFileId: state.activeFileId,
      workFileId: state.workFileId,
      draft: state.draft,
      chat: state.chat.slice(slim ? -6 : -40),
      packs: state.packs,
      swarmAnxiety: state.swarmAnxiety,
      swarmLogs: state.swarmLogs.slice(0, slim ? 5 : 30),
      swarmMemory: state.swarmMemory.slice(0, slim ? 10 : 40),
      terminal: state.terminal.slice(slim ? -10 : -80),
      cwd: state.cwd,
      termHistory: state.termHistory.slice(0, 30),
      storage: state.storage,
      git: gitElsewhere ? undefined : state.git,
      editorMode: state.editorMode,
  };
}

/** The in-flight chat request, so Stop (and reset) can cancel it. */
let chatAbort: AbortController | null = null;
/** Bumped when the workspace is replaced (reset, import), so late replies cannot write into the new one. */
let generation = 0;
/** Set when another tab saved this project: this tab stops saving until reloaded. */
let staleTab = false;

/** The GitHub operation in flight ("push", "pull" or "clone"), so two cannot interleave. */
let githubBusy: string | null = null;

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

  gitInit: () => set({ git: Git.init(get().git) }),
  gitAdd: (paths) => {
    get().flushDraft();
    const state = get();
    set({ git: Git.add(Git.normalizeGit(state.git), Git.workingFiles(state.files), paths).git });
  },
  gitCommit: (message) => {
    get().flushDraft();
    const next = Git.commit(Git.normalizeGit(get().git), message, new Date().toLocaleString());
    if (!next) return false;
    set({ git: next });
    return true;
  },
  applyGit: (git, changes = []) => {
    get().flushDraft();
    const state = get();
    if (changes.length === 0) {
      set({ git });
      return true;
    }
    const clashes = Git.pathClashes(state.files, changes);
    if (clashes.length) {
      // Leave git and the files exactly as they were.
      get().pushTerminal([`[ERROR] a file and a folder have the same name, so nothing was changed: ${clashes.slice(0, 5).join(", ")}. Rename one, then try again.`]);
      return false;
    }
    const stampId = Date.now().toString(36);
    const files = Git.applyChanges(state.files, changes, (n) => `git_${stampId}_${n}`, languageFromName);
    const active = files.find((file) => file.id === state.activeFileId && file.type === "file");
    const fallback = active ?? files.find((file) => file.type === "file");
    set({
      git,
      files,
      activeFileId: fallback?.id ?? "",
      draft: fallback?.content ?? "",
      workFileId: files.some((file) => file.id === state.workFileId) ? state.workFileId : (fallback?.id ?? ""),
    });
    return true;
  },
  gitPush: async () => {
    const say = (lines: string[]) => get().pushTerminal(lines);
    const done = (ok: boolean, message: string, extra: string[] = []) => {
      say([`${ok ? (message.startsWith("Everything") ? "[INFO]" : "[SUCCESS]") : "[ERROR]"} ${message}`, ...extra]);
      return { ok, message };
    };
    if (githubBusy) return done(false, `another GitHub operation (${githubBusy}) is still running`);
    if (get().gitStorage === "loading") return done(false, "git history is still loading; try again in a moment");
    get().flushDraft();
    const git = Git.normalizeGit(get().git);
    const plan = Git.pushPlan(git);
    if (typeof plan === "string") return done(plan.startsWith("Everything"), plan);
    githubBusy = "push";
    say([plan.moveTo ? `Moving ${plan.repo} ${plan.branch} to ${plan.moveTo.slice(0, 7)}…` : `Pushing ${plan.commits.length} commit(s) to ${plan.repo} ${plan.branch}…`]);
    let result: { ok: boolean; error?: string; shas?: string[]; tip?: string; url?: string; created?: boolean; warning?: string };
    try {
      const response = await fetch("/api/git/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(plan) });
      result = await response.json();
    } catch {
      githubBusy = null;
      return done(false, "The push request failed (network).");
    }
    githubBusy = null;
    // Record against the branches the plan was made for, not whatever is current now.
    // markPushed ignores the result if the remote was removed or replaced meanwhile.
    if (result.shas?.length || (result.ok && result.tip)) {
      set({ git: Git.markPushed(Git.normalizeGit(get().git), plan, result.shas ?? [], result.ok ? (result.tip ?? null) : null) });
    }
    if (!result.ok) return done(false, result.error ?? "Push failed.");
    const what = plan.moveTo ? `moved to ${plan.moveTo.slice(0, 7)}` : `${plan.commits.length} commit(s), now at ${result.tip?.slice(0, 7)}`;
    return done(true, `${result.created ? "Created" : "Updated"} ${plan.repo} ${plan.branch}: ${what}`, [`[INFO] ${result.url}`, ...(result.warning ? [`[WARN] ${result.warning}`] : [])]);
  },
  gitPull: async () => {
    const say = (lines: string[]) => get().pushTerminal(lines);
    const fail = (message: string) => {
      say([`[ERROR] ${message}`]);
      return { ok: false, message };
    };
    if (githubBusy) return fail(`another GitHub operation (${githubBusy}) is still running`);
    if (get().gitStorage === "loading") return fail("git history is still loading; try again in a moment");
    get().flushDraft();
    const git = Git.normalizeGit(get().git);
    const remote = git.remote;
    if (!remote) return fail("no remote to pull from");
    const branch = Git.remoteBranchOf(git);
    const baseSha = remote.tips?.[branch];
    if (!baseSha) return fail(`GitHub's ${branch} has not been seen by this project yet: push it first, or clone ${remote.repo} again`);
    const baseId = Git.localIdOf(git, baseSha);
    if (!baseId) return fail(`the commit GitHub's ${branch} was last seen at is no longer in local history; clone ${remote.repo} again`);
    const pending = Git.dirty(git, Git.workingFiles(get().files));
    if (pending.length) return fail(`commit or restore your changes first: ${pending.slice(0, 5).join(", ")}`);
    // Pin what the pull started on; a result for a different state is thrown away.
    const started = { repo: remote.repo, branch: git.branch, head: Git.headCommit(git)?.id };
    githubBusy = "pull";
    say([`Pulling ${remote.repo} ${branch}…`]);
    let result: { ok: boolean; error?: string; note?: string; tip?: string; ahead?: number; subjects?: string[]; changes?: Git.PullChange[] };
    try {
      const response = await fetch("/api/git/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: remote.repo, branch, base: baseSha }) });
      result = await response.json();
    } catch {
      githubBusy = null;
      return fail("The pull request failed (network).");
    }
    githubBusy = null;
    if (!result.ok || !result.changes || !result.tip) return fail(result.error ?? "Pull failed.");
    const now = Git.normalizeGit(get().git);
    if (now.remote?.repo !== started.repo || now.branch !== started.branch || Git.headCommit(now)?.id !== started.head || now.merging) {
      return fail("the project changed while pulling (branch, commit or remote); nothing was applied. Run git pull again");
    }
    if (result.tip === baseSha) {
      const message = result.note ?? "Already up to date.";
      say([`[INFO] ${message}`]);
      return { ok: true, message };
    }
    const time = new Date().toLocaleString();
    const subjects = result.subjects ?? [];
    const message = `Pull ${result.ahead ?? "?"} commit(s) from ${remote.repo} ${branch}${subjects.length ? `: ${subjects.slice(0, 3).join("; ")}${subjects.length > 3 ? "; …" : ""}` : ""}`;
    const snapshot = Git.pullSnapshot(now, baseId, result.tip, result.changes, message, time);
    if (typeof snapshot === "string") return fail(snapshot);
    const merged = Git.mergeInto(snapshot.git, Git.workingFiles(get().files), snapshot.tip, `Merge ${remote.repo} ${branch} into ${now.branch}`, time);
    if (typeof merged === "string") return fail(merged);
    // GitHub's branch is now known to be at the fetched tip.
    const withTip = merged.git.remote ? { ...merged.git, remote: { ...merged.git.remote, tips: { ...(merged.git.remote.tips ?? {}), [branch]: result.tip } } } : merged.git;
    const view = mergeLines(now, { ...merged, git: withTip });
    if (!get().applyGit(withTip, merged.changes)) return fail("the pulled files clash with names in this project (a file and a folder share a name); nothing was applied");
    say([
      `[INFO] Fetched ${result.ahead ?? "?"} commit(s) from GitHub${subjects.length ? `: ${subjects.slice(0, 3).join("; ")}${subjects.length > 3 ? "; …" : ""}` : ""}`,
      ...view.lines,
      ...(snapshot.dropped.length ? [`[INFO] Removed here because GitHub's new version cannot be copied (binary or too large); it stays on GitHub: ${snapshot.dropped.slice(0, 5).join(", ")}`] : []),
    ]);
    return { ok: merged.conflicts.length === 0, message: merged.note };
  },
  cloneRepo: async (repo) => {
    const say = (lines: string[]) => get().pushTerminal(lines);
    let result: {
      ok: boolean;
      error?: string;
      files?: { path: string; content: string }[];
      skipped?: Record<string, number>;
      /** Set when the server has a token and the repo is allowed: the copy can be linked for push. */
      linked?: boolean;
      /** The server has a token but the repo is not on GITHUB_REPOS. */
      notAllowed?: boolean;
      sha?: string;
      branch?: string;
      private?: boolean;
    };
    if (githubBusy || get().gitStorage === "loading") {
      say([githubBusy ? `[ERROR] another GitHub operation (${githubBusy}) is still running` : "[ERROR] git history is still loading; try again in a moment"]);
      return;
    }
    githubBusy = "clone";
    try {
      const response = await fetch("/api/clone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo }) });
      result = await response.json();
    } catch {
      say(["[ERROR] The clone request failed (network)."]);
      return;
    } finally {
      githubBusy = null;
    }
    if (!result.ok || !result.files) {
      say([`[ERROR] ${result.error ?? "Clone failed."}`]);
      return;
    }
    const state = get();
    const top = state.files.find((file) => file.parentId === null)?.id ?? "root";
    const base = repo.split("/")[1];
    const taken = new Set(state.files.filter((file) => file.parentId === top).map((file) => file.name));
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    const stampId = Date.now().toString(36);
    const folders = new Map<string, string>();
    const additions: ProjectFile[] = [];
    const rootId = `clone_${stampId}`;
    additions.push({ id: rootId, name, type: "folder", parentId: top, isOpen: true });
    folders.set("", rootId);
    const folderFor = (dir: string): string => {
      const known = folders.get(dir);
      if (known) return known;
      const parts = dir.split("/");
      const parent = folderFor(parts.slice(0, -1).join("/"));
      const id = `${rootId}_d${folders.size}`;
      additions.push({ id, name: parts[parts.length - 1], type: "folder", parentId: parent, isOpen: false });
      folders.set(dir, id);
      return id;
    };
    result.files.forEach((item, index) => {
      const parts = item.path.split("/");
      const fileName = parts.pop()!;
      additions.push({ id: `${rootId}_f${index}`, name: fileName, type: "file", parentId: folderFor(parts.join("/")), language: languageFromName(fileName), content: item.content });
    });
    const files = [...state.files, ...additions];
    set({ files });
    const skipped = Object.entries(result.skipped ?? {})
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${count} ${reason.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`)}`);
    const lines = [
      `[SUCCESS] Copied ${result.files.length} text file(s) from github.com/${repo}${result.private ? " (private)" : ""} into project/${name}/`,
      ...(skipped.length ? [`[INFO] left out: ${skipped.join(", ")}. They stay on GitHub untouched when you push.`] : []),
    ];
    const git = Git.normalizeGit(get().git);
    if (result.linked && result.sha && result.branch && !git.remote && !git.merging) {
      // Record the copy as a commit that is already on GitHub, so later commits push on top of it.
      // Only the cloned paths go into it; anything else the user staged stays staged.
      const dir = Git.pathOf(additions[0], files);
      const cloned = Object.fromEntries(Object.entries(Git.workingFiles(files)).filter(([path]) => path.startsWith(`${dir}/`)));
      const committed = Git.commitFiles(git.initialized ? git : Git.init(git), cloned, `Clone of ${repo} at ${result.sha.slice(0, 7)}`, new Date().toLocaleString());
      if (typeof committed === "string") {
        lines.push(`[INFO] A plain copy: ${committed}.`);
      } else {
        const head = Git.headCommit(committed)!;
        set({ git: Git.setRemote(committed, repo, dir, { [committed.branch]: result.branch }, { [head.id]: result.sha }, { [result.branch]: result.sha }) });
        lines.push(
          `[INFO] Linked: project/${dir}/ pushes to ${repo} (${committed.branch} → ${result.branch}). Commit there, then git push.`,
          "[INFO] git pull brings in changes made on GitHub; git push sends yours.",
        );
      }
    } else if (result.linked && git.merging) {
      lines.push("[INFO] A plain copy: a merge is in progress, so the clone was not linked. Finish or abort the merge and clone again to link it.");
    } else if (result.linked && git.remote) {
      lines.push(`[INFO] A plain copy: this project already pushes to ${git.remote.repo} (one remote per project).`);
    } else if (result.notAllowed) {
      lines.push(`[INFO] A plain copy: ${repo} is not on the server's GITHUB_REPOS list, so the token was not used and the copy is not linked.`);
    } else {
      lines.push("[INFO] A plain copy with no link back. Set GITHUB_TOKEN and GITHUB_REPOS on the server to link clones for push (and to clone private repos).");
    }
    say(lines);
  },
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

  consult: async (prompt) => {
    const text = prompt.trim();
    if (!text || get().busy) return;
    const user: ChatMessage = { role: "user", text, timestamp: Date.now() };
    const history = [...get().chat, user];
    set({ chat: history, busy: true, tab: "toolneuron", module: "chat" });
    try {
      const fileMatch = text.match(/(?:create|generate) (?:a )?(?:new )?file named ([A-Za-z0-9_.-]+)/i);
      const startedIn = generation;
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
      chatAbort = controller;
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
      if (chatAbort === controller) chatAbort = null;

      if (startedIn !== generation) return; // the workspace was reset or replaced while the reply streamed
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
      chatAbort = null;
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
    chatAbort?.abort();
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

  resetNode: () => {
    generation++;
    chatAbort?.abort();
    chatAbort = null;
    stopSwarm();
    lastSaved = "";
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    set({ ...fresh(), busy: false, swarmHot: false, swarmRun: idleRun(), swarmFix: null, swarmUndo: null, booted: true });
  },
}));

if (typeof window !== "undefined") {
  const current = useOs.getState().personalities;
  const known = new Set(current.map((item) => item.name));
  const extras = SEED_PERSONALITIES.filter((item) => !known.has(item.name)).map((item) => ({ ...item, active: false }));
  if (extras.length > 0) useOs.setState({ personalities: [...current, ...extras] });
}
