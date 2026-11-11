/**
 * Git history in IndexedDB (browser only).
 *
 * localStorage holds about 5 MB and every save rewrites the whole string,
 * so keeping every version of every file there runs out fast. Here:
 *   - store "blobs": one record per file version, keyed by its content hash.
 *     A save writes only versions it has not written before and deletes the
 *     ones nothing refers to any more.
 *   - store "meta", key "git": everything else (commits with their trees,
 *     branches, index, remote, merge state).
 * Both are written in ONE transaction, so the graph and its blobs cannot
 * disagree after a crash.
 *
 * If IndexedDB cannot be opened (some private modes, blocked storage), the
 * caller keeps git in localStorage as before.
 */
import type { GitState } from "./types";

const DB_NAME = "toolneuron";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase | null> | null = null;
/** Blob ids known to be in the database (so a save only writes new ones). */
let storedBlobs: Set<string> | null = null;
/** The git object last written, to skip saves when nothing changed. */
let lastWritten: GitState | null = null;
let writing: Promise<void> = Promise.resolve();

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("transaction failed"));
  });
}

/** Opens the database, or resolves null when IndexedDB is unavailable. */
export function openGitDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
      open.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** Reads the saved history, or null when none is saved yet. */
export async function loadGit(): Promise<GitState | null> {
  const db = await openGitDb();
  if (!db) return null;
  const tx = db.transaction(["meta", "blobs"], "readonly");
  const meta = (await request(tx.objectStore("meta").get("git"))) as Omit<GitState, "blobs"> | undefined;
  const store = tx.objectStore("blobs");
  const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
  storedBlobs = new Set(keys as string[]);
  if (!meta) return null;
  const blobs: Record<string, string> = {};
  (keys as string[]).forEach((key, index) => {
    blobs[key] = values[index] as string;
  });
  const git = { ...meta, blobs } as GitState;
  lastWritten = git;
  return git;
}

/**
 * Saves the history if it changed since the last save. Writes are queued so
 * two saves never interleave. Rejects with the database error (for example
 * QuotaExceededError) so the caller can warn that history is not saved.
 */
export function saveGit(git: GitState): Promise<void> {
  if (git === lastWritten) return writing;
  lastWritten = git;
  writing = writing
    .catch(() => undefined)
    .then(async () => {
      const db = await openGitDb();
      if (!db) throw new Error("IndexedDB is not available");
      const known = storedBlobs ?? new Set<string>();
      const blobs = git.blobs ?? {};
      const tx = db.transaction(["meta", "blobs"], "readwrite");
      const store = tx.objectStore("blobs");
      const added: string[] = [];
      for (const [id, content] of Object.entries(blobs)) {
        if (!known.has(id)) {
          store.put(content, id);
          added.push(id);
        }
      }
      const removed = [...known].filter((id) => !(id in blobs));
      for (const id of removed) store.delete(id);
      const meta: Partial<GitState> = { ...git };
      delete meta.blobs;
      tx.objectStore("meta").put(meta, "git");
      try {
        await done(tx);
      } catch (error) {
        // Nothing in the transaction was written: allow the next save to retry.
        lastWritten = null;
        throw error;
      }
      for (const id of added) known.add(id);
      for (const id of removed) known.delete(id);
      storedBlobs = known;
    });
  return writing;
}

/** Bytes used and available for this site, when the browser reports them. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate || estimate.usage === undefined || estimate.quota === undefined) return null;
    return { usage: estimate.usage, quota: estimate.quota };
  } catch {
    return null;
  }
}

/** Asks the browser not to evict this site's storage under pressure (best effort, no prompt in most browsers). */
export function requestPersistentStorage(): void {
  try {
    void navigator.storage?.persist?.();
  } catch {
    /* not supported */
  }
}
