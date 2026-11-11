/**
 * Saving and loading the workspace: localStorage for everything except git
 * history, which lives in IndexedDB (git-store.ts) when the browser allows.
 * Also export/import of a whole-node backup.
 */
import * as Git from "./git";
import { loadGit, openGitDb, requestPersistentStorage, saveGit } from "./git-store";
import { parseImport, wrapExport } from "./node-file";
import { pickWorkFile, SKILLS_REV, upgradeWelcome, withDefaultSkills } from "./prompt";
import { SEED_PERSONALITIES } from "./seed";
import { BOOT_TERMINAL, cancelWork, fresh, KEY, OLD_BOOT_LINE, TABS } from "./store-shared";
import { useOs, type OsState } from "./store";
import { idleRun } from "./swarm/engine";
import type { GitState, Tab } from "./types";
import { exportVaultBlob, importVaultBlob } from "./vault/vault-store";

/** Set when another tab saved this project: this tab stops saving until reloaded. */
let staleTab = false;

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
  cancelWork();
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

/** Forgets the saved workspace (reset): the next save writes a fresh one. */
export function forgetSave() {
  lastSaved = "";
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
