import { create } from "zustand";
import { askCrimson } from "./ai.functions";
import { parseImport, wrapExport } from "./node-file";
import { streamChat } from "./stream-chat";
import { exportVaultBlob, importVaultBlob } from "./vault/vault-store";
import { findHandoff, formatHandoff, HANDOFF_NAME, stripModeLabel } from "./handoff";
import * as Git from "./git";
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
  createItem: (parentId: string, type: "file" | "folder", name: string) => void;
  renameItem: (id: string, name: string) => void;
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
  applyGit: (git: GitState, changes?: Git.FileChange[]) => void;
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
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    /* storage blocked (private mode): run in memory */
  }
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<OsState>;
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
  useOs.subscribe((state) => {
    if (state.booted) scheduleSave();
  });
  // Never lose the last edits when the tab closes or goes to the background.
  window.addEventListener("pagehide", flushSave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave();
  });
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
  if (!state.booted) return;
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
  return wrapExport({ ...persistable(useOs.getState(), false), ...(vault ? { vaultBlob: vault } : {}) });
}

/** Replaces the node with a validated backup. Returns a summary or an error. */
export function importNode(text: string): { ok: true; summary: string } | { ok: false; error: string } {
  const parsed = parseImport(text);
  if (!parsed.ok) return parsed;
  const data = parsed.node;
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

function persistable(state: OsState, slim: boolean) {
  return {
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
      git: state.git,
      editorMode: state.editorMode,
  };
}

/** The in-flight chat request, so Stop (and reset) can cancel it. */
let chatAbort: AbortController | null = null;

export const useOs = create<OsState>((set, get) => ({
  booted: false,
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
    if (!trimmed) return;
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
      return;
    }
    set({ files });
  },

  renameItem: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed || id === "root") return;
    set({
      files: get().files.map((file) =>
        file.id === id
          ? { ...file, name: trimmed, language: file.type === "file" ? languageFromName(trimmed) : file.language }
          : file,
      ),
    });
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
      return;
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
  },
  gitPush: async () => {
    const say = (lines: string[]) => get().pushTerminal(lines);
    const done = (ok: boolean, message: string, extra: string[] = []) => {
      say([`${ok ? (message.startsWith("Everything") ? "[INFO]" : "[SUCCESS]") : "[ERROR]"} ${message}`, ...extra]);
      return { ok, message };
    };
    const git = Git.normalizeGit(get().git);
    const plan = Git.pushPlan(git);
    if (typeof plan === "string") return done(plan.startsWith("Everything"), plan);
    say([`Pushing ${plan.commits.length} commit(s) to ${plan.repo} ${plan.branch}…`]);
    let result: { ok: boolean; error?: string; shas?: string[]; url?: string; created?: boolean };
    try {
      const response = await fetch("/api/git/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(plan) });
      result = await response.json();
    } catch {
      return done(false, "The push request failed (network).");
    }
    if (!result.ok || !result.shas) return done(false, result.error ?? "Push failed.");
    // Record against the state as it is now (the user may have kept working).
    set({ git: Git.markPushed(Git.normalizeGit(get().git), plan.commits.map((commit) => commit.id), result.shas, plan.branch) });
    return done(true, `${result.created ? "Created" : "Updated"} ${plan.repo} ${plan.branch}: ${plan.commits.length} commit(s), now at ${result.shas.at(-1)?.slice(0, 7)}`, [`[INFO] ${result.url}`]);
  },
  gitPull: async () => {
    const say = (lines: string[]) => get().pushTerminal(lines);
    const fail = (message: string) => {
      say([`[ERROR] ${message}`]);
      return { ok: false, message };
    };
    get().flushDraft();
    const git = Git.normalizeGit(get().git);
    const remote = git.remote;
    if (!remote) return fail("no remote to pull from");
    const base = Git.newestOnGitHub(git);
    if (!base) return fail(`nothing on this branch is known to be on GitHub yet; push it first, or clone ${remote.repo} again`);
    const work = Git.workingFiles(get().files);
    const pending = Git.dirty(git, work);
    if (pending.length) return fail(`commit or restore your changes first: ${pending.slice(0, 5).join(", ")}`);
    const branch = remote.track[git.branch] ?? git.branch;
    say([`Pulling ${remote.repo} ${branch}…`]);
    let result: { ok: boolean; error?: string; note?: string; commits?: (Git.RemoteCommit & { skipped: string[] })[] };
    try {
      const response = await fetch("/api/git/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: remote.repo, branch, base: remote.shas[base.id] }) });
      result = await response.json();
    } catch {
      return fail("The pull request failed (network).");
    }
    if (!result.ok || !result.commits) return fail(result.error ?? "Pull failed.");
    if (result.commits.length === 0) {
      const message = result.note ?? "Already up to date.";
      say([`[INFO] ${message}`]);
      return { ok: true, message };
    }
    // The user may have kept working while the request ran.
    const now = Git.normalizeGit(get().git);
    const time = new Date().toLocaleString();
    const replayed = Git.replayRemote(now, remote.shas[base.id], result.commits, time);
    if (typeof replayed === "string") return fail(replayed);
    const merged = Git.mergeInto(replayed.git, Git.workingFiles(get().files), replayed.tip, `Merge ${remote.repo} ${branch} into ${now.branch}`, time);
    if (typeof merged === "string") return fail(merged);
    const view = mergeLines(now, merged);
    if (view.effect?.type === "git") get().applyGit(view.effect.git, view.effect.changes);
    const skipped = result.commits.flatMap((item) => item.skipped);
    say([
      `[INFO] Fetched ${result.commits.length} commit(s): ${result.commits.map((item) => item.message.split("\n")[0]).slice(0, 3).join("; ")}${result.commits.length > 3 ? "; …" : ""}`,
      ...view.lines,
      ...(skipped.length ? [`[INFO] Not copied (binary or too large; left as they are here): ${[...new Set(skipped)].slice(0, 5).join(", ")}`] : []),
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
      /** Set when the server has a token: the copy can be linked for push. */
      linked?: boolean;
      sha?: string;
      branch?: string;
      private?: boolean;
    };
    try {
      const response = await fetch("/api/clone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo }) });
      result = await response.json();
    } catch {
      say(["[ERROR] The clone request failed (network)."]);
      return;
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
    if (result.linked && result.sha && result.branch && !git.remote) {
      // Record the copy as a commit that is already on GitHub, so later commits push on top of it.
      const dir = Git.pathOf(additions[0], files);
      const paths = Object.keys(Git.workingFiles(files)).filter((path) => path.startsWith(`${dir}/`));
      const staged = Git.add(git.initialized ? git : Git.init(git), Git.workingFiles(files), paths).git;
      const committed = Git.commit(staged, `Clone of ${repo} at ${result.sha.slice(0, 7)}`, new Date().toLocaleString()) ?? staged;
      const head = Git.headCommit(committed);
      const linked = Git.setRemote(committed, repo, dir, { [committed.branch]: result.branch }, head ? { [head.id]: result.sha } : {});
      set({ git: linked });
      lines.push(
        `[INFO] Linked: project/${dir}/ pushes to ${repo} (${committed.branch} → ${result.branch}). Commit there, then git push.`,
        "[INFO] git pull brings in changes made on GitHub; git push sends yours.",
      );
    } else if (result.linked && git.remote) {
      lines.push(`[INFO] A plain copy: this project already pushes to ${git.remote.repo} (one remote per project).`);
    } else {
      lines.push("[INFO] A plain copy with no link back. Set GITHUB_TOKEN on the server to link clones for push (and to clone private repos).");
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
