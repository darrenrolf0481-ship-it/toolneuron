/**
 * Reads text files out of a (decompressed) tar archive, the format GitHub
 * serves repository snapshots in. Pure: bytes in, files out. Used by
 * /api/clone; limits keep a clone small enough for browser storage.
 *
 * Handles ustar names (prefix + name), pax extended headers (path=) and GNU
 * long names. Skips folders, links, binaries, anything not valid UTF-8, and
 * vendored or generated folders.
 */

export type CloneLimits = {
  /** Most files kept. */
  maxFiles: number;
  /** Largest single file kept, in bytes. */
  maxFileBytes: number;
  /** Total bytes of all kept files. */
  maxTotalBytes: number;
};

/** Sized for browser storage (about 5 MB), leaving room for a git snapshot of the same files. */
export const DEFAULT_CLONE_LIMITS: CloneLimits = { maxFiles: 300, maxFileBytes: 200_000, maxTotalBytes: 1_000_000 };

export type ClonedFile = { path: string; content: string };

export type CloneResult = {
  files: ClonedFile[];
  /** Counts of what was left out, by reason. */
  skipped: { binary: number; tooLarge: number; ignoredFolder: number; overLimit: number };
};

const IGNORED_SEGMENTS = new Set(["node_modules", ".git", "dist", "build", ".next", ".output", "__pycache__", ".venv", "venv", "target", "coverage"]);
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tiff", "psd", "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar",
  "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "mov", "wav", "ogg", "webm", "avi", "so", "dylib", "dll", "exe", "bin",
  "class", "pyc", "o", "a", "wasm", "lock", "sqlite", "db",
]);

const decoder = new TextDecoder("utf-8", { fatal: true });
const latin = new TextDecoder("latin1");

function field(block: Uint8Array, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return latin.decode(end === -1 ? slice : slice.subarray(0, end));
}

function octal(block: Uint8Array, start: number, length: number): number {
  const text = field(block, start, length).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function paxPath(data: Uint8Array): string | undefined {
  // Records: "<len> key=value\n"
  const text = new TextDecoder().decode(data);
  for (const record of text.split("\n")) {
    const match = record.match(/^\d+ path=(.*)$/);
    if (match) return match[1];
  }
  return undefined;
}

function isIgnored(path: string): boolean {
  return path.split("/").some((segment) => IGNORED_SEGMENTS.has(segment));
}

function looksBinary(path: string, data: Uint8Array): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (path.includes(".") && BINARY_EXTENSIONS.has(ext)) return true;
  return data.subarray(0, 8000).includes(0);
}

/**
 * Text files from a tar archive. `stripFirst` drops the first path segment
 * (GitHub archives put everything under "owner-repo-sha/").
 */
export function readTar(bytes: Uint8Array, limits: CloneLimits = DEFAULT_CLONE_LIMITS, stripFirst = true): CloneResult {
  const files: ClonedFile[] = [];
  const skipped = { binary: 0, tooLarge: 0, ignoredFolder: 0, overLimit: 0 };
  let total = 0;
  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break; // end of archive
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48); // "0"
    const dataStart = offset + 512;
    const data = bytes.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === "x") {
      longName = paxPath(data) ?? longName;
      continue;
    }
    if (type === "L") {
      longName = latin.decode(data).replace(/\0+$/, "");
      continue;
    }
    if (type === "g") continue; // global pax header (GitHub puts the commit id here)

    const magic = field(header, 257, 6);
    const prefix = magic.startsWith("ustar") ? field(header, 345, 155) : "";
    let path = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = undefined;
    if (type !== "0" && type !== "\0") continue; // folders, links, devices
    if (stripFirst) path = path.split("/").slice(1).join("/");
    path = path.replace(/^\.\/+/, "");
    if (!path || path.split("/").some((segment) => segment === ".." || segment === "")) continue;

    if (isIgnored(path)) {
      skipped.ignoredFolder++;
      continue;
    }
    if (size > limits.maxFileBytes) {
      skipped.tooLarge++;
      continue;
    }
    if (looksBinary(path, data)) {
      skipped.binary++;
      continue;
    }
    let content: string;
    try {
      content = decoder.decode(data);
    } catch {
      skipped.binary++;
      continue;
    }
    if (files.length >= limits.maxFiles || total + size > limits.maxTotalBytes) {
      skipped.overLimit++;
      continue;
    }
    total += size;
    files.push({ path, content });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, skipped };
}
