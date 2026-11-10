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
  excerpt: string;
  status: "indexed" | "cataloged";
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

export type GitState = {
  initialized: boolean;
  branch: string;
  staged: string[];
  commits: { id: string; message: string; time: string }[];
};

export type EditorMode = "code" | "preview" | "git";

export type Finding = {
  severity: "critical" | "high" | "medium";
  rule: string;
  line: number;
  message: string;
  fix: string;
};
