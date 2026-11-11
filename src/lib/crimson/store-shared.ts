/**
 * Pieces of the workspace store shared by its slices (store-git, store-chat,
 * store-persist): the fresh workspace, and the in-flight work that a reset or
 * import must cancel. Nothing here imports the store itself.
 */
import * as Git from "./git";
import { WELCOME } from "./prompt";
import { SEED_FILES, SEED_PERSONALITIES } from "./seed";
import { stopSwarm } from "./swarm/engine";
import type { OsState } from "./store";
import type { Tab } from "./types";

/** localStorage key for the saved workspace. */
export const KEY = "crimson_os_v1";

/** What a slice gets from zustand. */
export type StoreApi = { get: () => OsState; set: (partial: Partial<OsState>) => void };

export const TABS: Tab[] = ["toolneuron", "terminal", "editor", "analysis", "storage", "settings"];

export const session = {
  /** The in-flight chat request, so Stop (and reset) can cancel it. */
  chatAbort: null as AbortController | null,
  /** Bumped when the workspace is replaced (reset, import), so late replies cannot write into the new one. */
  generation: 0,
};

/** Cancels chat and swarm work and makes any reply still on its way stale. */
export function cancelWork() {
  session.generation++;
  session.chatAbort?.abort();
  session.chatAbort = null;
  stopSwarm();
}

export const BOOT_TERMINAL = ["ToolNeuron terminal: built-in commands on the project files (not a shell).", "Type help."];
/** The first line older saves start their terminal with. */
export const OLD_BOOT_LINE = "CRIMSON OS  v4.2  KORE";

export function fresh(): Pick<
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

export function stamp() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
