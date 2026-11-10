/**
 * Export / import of the whole node (browser workspace) as a JSON file.
 * Import is validated with zod so a bad or foreign file cannot corrupt state.
 */
import { z } from "zod";

export const NODE_FORMAT = "toolneuron-node";
export const NODE_VERSION = 1;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

const file = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  type: z.enum(["file", "folder"]),
  parentId: z.string().max(200).nullable(),
  isOpen: z.boolean().optional(),
  language: z.string().max(40).optional(),
  content: z.string().max(2_000_000).optional(),
});

const persona = z.object({
  id: z.number(),
  name: z.string().min(1).max(120),
  instruction: z.string().max(4000),
  active: z.boolean(),
  suggestions: z.array(z.string().max(200)).max(12),
  skills: z.array(z.string().max(80)).max(20).optional(),
});

const chat = z.object({
  role: z.enum(["user", "ai"]),
  text: z.string().max(20_000),
  timestamp: z.number(),
  error: z.boolean().optional(),
  stopped: z.boolean().optional(),
  skills: z.array(z.string().max(80)).max(6).optional(),
  mode: z.string().max(80).optional(),
  intro: z.boolean().optional(),
  cut: z.boolean().optional(),
});

/** Only `files` is required; everything else falls back to the current or default value. */
const node = z
  .object({
    files: z.array(file).min(1).max(2000),
    activeFileId: z.string().optional(),
    draft: z.string().optional(),
    personalities: z.array(persona).max(60).optional(),
    chat: z.array(chat).max(200).optional(),
  })
  .passthrough();

export type ImportedNode = z.infer<typeof node> & Record<string, unknown>;

export function wrapExport(payload: Record<string, unknown>): string {
  return JSON.stringify({ format: NODE_FORMAT, version: NODE_VERSION, exportedAt: new Date().toISOString(), node: payload }, null, 2);
}

export function parseImport(text: string): { ok: true; node: ImportedNode } | { ok: false; error: string } {
  if (text.length > MAX_IMPORT_BYTES) return { ok: false, error: "File is larger than 5 MB." };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "Not a JSON file." };
  }
  // Accept the new wrapped format and the old bare {files, personalities, chat} export.
  const body =
    raw && typeof raw === "object" && (raw as { format?: unknown }).format === NODE_FORMAT
      ? (raw as { node?: unknown }).node
      : raw;
  const parsed = node.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `Not a ToolNeuron node file (${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid"}).` };
  }
  const ids = new Set(parsed.data.files.map((item) => item.id));
  if (ids.size !== parsed.data.files.length) return { ok: false, error: "The file list has duplicate ids." };
  const orphan = parsed.data.files.find((item) => item.parentId !== null && !ids.has(item.parentId));
  if (orphan) return { ok: false, error: `"${orphan.name}" points to a folder that is not in the file.` };
  return { ok: true, node: parsed.data as ImportedNode };
}
