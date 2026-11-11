/**
 * Rules for file and folder names in the project tree. Git paths are built
 * from these names with "/", so a name containing "/" or equal to "." or
 * "..", or two siblings with the same name, would make two files collapse
 * into one path (only one of them would be committed or pushed).
 */
import type { ProjectFile } from "./types.ts";

export const MAX_NAME = 120;

/** Why `name` cannot be used under `parentId`, or null if it can. `exceptId` is the item being renamed. */
export function nameProblem(files: ProjectFile[], parentId: string | null, name: string, exceptId?: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "A name is required.";
  if (trimmed.length > MAX_NAME) return `Names can be at most ${MAX_NAME} characters.`;
  if (/[/\\]/.test(trimmed)) return "Names cannot contain / or \\ (make a folder instead).";
  if (trimmed === "." || trimmed === "..") return `"${trimmed}" is not allowed as a name.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(trimmed)) return "Names cannot contain control characters.";
  const clash = files.find((file) => file.parentId === parentId && file.id !== exceptId && file.name === trimmed);
  if (clash) return `${clash.type === "folder" ? "A folder" : "A file"} named "${trimmed}" is already here.`;
  return null;
}
