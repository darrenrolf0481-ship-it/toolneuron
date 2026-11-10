export type Tab =
  | "toolneuron"
  | "terminal"
  | "editor"
  | "analysis"
  | "storage"
  | "settings";

export type Module = "chat" | "vision" | "knowledge" | "vault" | "swarm" | "debug" | "help";

export type ProjectFile = {
  id: string;
  name: string;
  type: "file" | "folder";
  parentId: string | null;
  isOpen?: boolean;
  language?: string;
  content?: string;
};

export type Personality = {
  id: number;
  name: string;
  instruction: string;
  active: boolean;
  suggestions: string[];
  /** Skill ids from skills/catalog.ts applied in this mode. */
  skills?: string[];
};

export type ChatMessage = {
  role: "user" | "ai";
  text: string;
  timestamp: number;
  /** A system/error notice shown in chat. Never sent back to the model as history. */
  error?: boolean;
  /** Reply still streaming in. */
  pending?: boolean;
  /** Reply was cut short by the Stop button. */
  stopped?: boolean;
  /** Skill names applied to this reply. */
  skills?: string[];
  /** The mode (persona name) that wrote this reply. */
  mode?: string;
  /** e.g. "Answered by OpenRouter. OmniRoute: rate limit …" (a fallback happened). */
  note?: string;
  /** Reply ended at the token limit, mid-thought. */
  cut?: boolean;
  /** The app's welcome line: shown, but never sent to the model or handed off. */
  intro?: boolean;
};

export type Pack = {
  id: string;
  name: string;
  size: string;
  /** First lines, for the card. */
  excerpt: string;
  /** Full text (up to MAX_PACK_CHARS), searched per message; older packs have only the excerpt. */
  text?: string;
  /** Legacy labels; packs are searched, not indexed. */
  status: "indexed" | "cataloged" | "searchable";
  armed: boolean;
};

export type SwarmLog = {
  id: number;
  type: "consensus" | "pain" | "info";
  message: string;
  time: string;
};

export type StorageItem = {
  id: string;
  name: string;
  size: string;
  type: string;
  date: string;
  note?: string;
};

/** Project path ("src/main.py") → blob hash. See git.ts. */
export type GitTree = Record<string, string>;

export type GitCommit = {
  id: string;
  message: string;
  time: string;
  /** The commit before this one. */
  parent?: string;
  /** Missing on commits made before history was real (they recorded only a message). */
  tree?: GitTree;
};

export type GitState = {
  initialized: boolean;
  branch: string;
  /** Legacy (file ids staged before history was real); ignored now. */
  staged: string[];
  /** Newest first. */
  commits: GitCommit[];
  /** What the next commit records. */
  index?: GitTree;
  /** Hash → contents, for every blob a commit or the index refers to. */
  blobs?: Record<string, string>;
  /** Branch name → its head commit id (undefined before the first commit). */
  branches?: Record<string, string | undefined>;
  /** The GitHub repository this project pushes to, if linked. */
  remote?: GitRemote;
};

export type GitRemote = {
  /** owner/name on GitHub. */
  repo: string;
  /** Project folder that maps to the repo root ("" = the whole project). */
  dir: string;
  /** Local branch → remote branch it pushes to (default: same name). */
  track: Record<string, string>;
  /** Local commit id → GitHub commit sha, for every commit known to be on GitHub. */
  shas: Record<string, string>;
};

export type EditorMode = "code" | "preview" | "git";

export type Finding = {
  severity: "critical" | "high" | "medium";
  rule: string;
  line: number;
  message: string;
  fix: string;
};
