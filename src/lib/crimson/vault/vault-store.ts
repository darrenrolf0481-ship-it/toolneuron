/**
 * Vault state (browser-only). The encrypted blob lives in its own
 * localStorage key; the data key and decrypted entries live in memory only,
 * and are dropped on lock, auto-lock (5 idle minutes) or page close.
 */
import { create } from "zustand";
import {
  addPasskey as sealWithPasskey,
  asVaultBlob,
  changePassphrase as rewrap,
  createVault,
  removePasskey as dropPasskey,
  saveEntries,
  unlockWithPassphrase,
  unlockWithPrf,
  WrongKeyError,
  type VaultBlob,
  type VaultEntry,
} from "./crypto";
import { enrollPasskey, passkeyErrorMessage, passkeyPrf } from "./passkey";

export const VAULT_KEY = "toolneuron_vault_v1";
const THROTTLE_KEY = "toolneuron_vault_throttle";
export const AUTO_LOCK_MS = 5 * 60_000;

type Status = "loading" | "none" | "locked" | "unlocked";

type VaultState = {
  status: Status;
  hasPasskey: boolean;
  entries: VaultEntry[];
  working: string;
  error: string;
  notice: string;
  /** ms timestamp until which passphrase attempts are refused */
  retryAt: number;
  init: () => void;
  create: (passphrase: string) => Promise<boolean>;
  unlock: (passphrase: string) => Promise<boolean>;
  unlockPasskey: () => Promise<boolean>;
  lock: (reason?: string) => void;
  upsert: (entry: Omit<VaultEntry, "updatedAt">) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
  setupPasskey: () => Promise<void>;
  forgetPasskey: () => Promise<void>;
  changePassphrase: (current: string, next: string) => Promise<boolean>;
  destroy: () => void;
  touch: () => void;
  clearMessages: () => void;
};

let dek: CryptoKey | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function readBlob(): VaultBlob | null {
  try {
    const raw = localStorage.getItem(VAULT_KEY);
    return raw ? asVaultBlob(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeBlob(blob: VaultBlob): boolean {
  try {
    localStorage.setItem(VAULT_KEY, JSON.stringify(blob));
    return true;
  } catch {
    return false;
  }
}

/** Raw stored blob for Export (still encrypted). */
export function exportVaultBlob(): VaultBlob | null {
  return readBlob();
}

/** Import: replace the stored vault with a validated encrypted blob. */
export function importVaultBlob(value: unknown): boolean {
  const blob = asVaultBlob(value);
  if (!blob || !writeBlob(blob)) return false;
  useVault.getState().lock();
  useVault.setState({ status: "locked", hasPasskey: !!blob.passkey });
  return true;
}

type Throttle = { fails: number; until: number };
function throttle(): Throttle {
  try {
    const value = JSON.parse(localStorage.getItem(THROTTLE_KEY) ?? "null") as Throttle | null;
    return value && typeof value.fails === "number" ? value : { fails: 0, until: 0 };
  } catch {
    return { fails: 0, until: 0 };
  }
}
function saveThrottle(value: Throttle) {
  try {
    if (value.fails === 0) localStorage.removeItem(THROTTLE_KEY);
    else localStorage.setItem(THROTTLE_KEY, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export const useVault = create<VaultState>((set, get) => {
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => get().lock("Locked after 5 idle minutes."), AUTO_LOCK_MS);
  };

  const opened = (entries: VaultEntry[], key: CryptoKey, blob: VaultBlob) => {
    dek = key;
    saveThrottle({ fails: 0, until: 0 });
    set({ status: "unlocked", entries, hasPasskey: !!blob.passkey, working: "", error: "", retryAt: 0 });
    armIdle();
  };

  const persist = async (entries: VaultEntry[]): Promise<boolean> => {
    const blob = readBlob();
    if (!blob || !dek) {
      get().lock("Vault changed in another tab. Unlock again.");
      return false;
    }
    const next = await saveEntries(blob, dek, entries);
    if (!writeBlob(next)) {
      set({ error: "Browser storage is full. The change was NOT saved." });
      return false;
    }
    set({ entries });
    return true;
  };

  return {
    status: "loading",
    hasPasskey: false,
    entries: [],
    working: "",
    error: "",
    notice: "",
    retryAt: 0,

    init: () => {
      if (get().status !== "loading") return;
      const blob = readBlob();
      set({ status: blob ? "locked" : "none", hasPasskey: !!blob?.passkey, retryAt: throttle().until });
      window.addEventListener("pagehide", () => get().lock());
      // Another tab changed or deleted the vault: re-read and lock.
      window.addEventListener("storage", (event) => {
        if (event.key !== VAULT_KEY) return;
        const next = readBlob();
        get().lock(next ? "Vault changed in another tab. Unlock again." : undefined);
        set({ status: next ? "locked" : "none", hasPasskey: !!next?.passkey });
      });
    },

    create: async (passphrase) => {
      set({ working: "Deriving your key…", error: "" });
      try {
        const { blob, dek: key } = await createVault(passphrase);
        if (!writeBlob(blob)) throw new Error("Browser storage is full.");
        opened([], key, blob);
        set({ notice: "Vault created. Only your passphrase can open it: there is no recovery." });
        return true;
      } catch (error) {
        set({ working: "", error: error instanceof Error ? error.message : "Could not create the vault." });
        return false;
      }
    },

    unlock: async (passphrase) => {
      const blob = readBlob();
      if (!blob) {
        set({ status: "none" });
        return false;
      }
      const limit = throttle();
      if (Date.now() < limit.until) {
        set({ retryAt: limit.until, error: "Too many wrong passphrases. Wait for the countdown." });
        return false;
      }
      set({ working: "Checking passphrase…", error: "" });
      try {
        const { dek: key, entries } = await unlockWithPassphrase(blob, passphrase);
        opened(entries, key, blob);
        return true;
      } catch (error) {
        if (error instanceof WrongKeyError) {
          const fails = limit.fails + 1;
          // After 5 misses: 30s, then doubling, capped at 15 minutes.
          const until = fails >= 5 ? Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (fails - 5)) : 0;
          saveThrottle({ fails, until });
          set({ working: "", retryAt: until, error: until ? "Wrong passphrase. Too many misses: wait for the countdown." : "Wrong passphrase." });
        } else {
          set({ working: "", error: error instanceof Error ? error.message : "Could not open the vault." });
        }
        return false;
      }
    },

    unlockPasskey: async () => {
      const blob = readBlob();
      if (!blob?.passkey) return false;
      set({ working: "Waiting for your passkey…", error: "" });
      try {
        const prf = await passkeyPrf(blob.passkey.credId, blob.passkey.prfSalt);
        const { dek: key, entries } = await unlockWithPrf(blob, prf);
        opened(entries, key, blob);
        return true;
      } catch (error) {
        set({ working: "", error: passkeyErrorMessage(error) });
        return false;
      }
    },

    lock: (reason) => {
      dek = null;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      const blob = readBlob();
      set({
        status: blob ? "locked" : "none",
        entries: [],
        working: "",
        notice: reason ?? "",
        error: "",
        hasPasskey: !!blob?.passkey,
      });
    },

    upsert: async (entry) => {
      if (!dek) return false;
      armIdle();
      const now = new Date().toISOString();
      const entries = get().entries.some((item) => item.id === entry.id)
        ? get().entries.map((item) => (item.id === entry.id ? { ...entry, updatedAt: now } : item))
        : [{ ...entry, updatedAt: now }, ...get().entries];
      return persist(entries);
    },

    remove: async (id) => {
      if (!dek) return;
      armIdle();
      await persist(get().entries.filter((item) => item.id !== id));
    },

    setupPasskey: async () => {
      const blob = readBlob();
      if (!blob || !dek) return;
      armIdle();
      set({ working: "Creating a passkey…", error: "", notice: "" });
      try {
        const passkey = await enrollPasskey();
        const next = await sealWithPasskey(blob, dek, passkey);
        if (!writeBlob(next)) throw new Error("Browser storage is full.");
        set({ working: "", hasPasskey: true, notice: "Passkey added. You can now unlock with it; the passphrase still works too." });
      } catch (error) {
        set({ working: "", error: passkeyErrorMessage(error) });
      }
    },

    forgetPasskey: async () => {
      const blob = readBlob();
      if (!blob || !dek) return;
      if (writeBlob(dropPasskey(blob))) {
        set({ hasPasskey: false, notice: "Passkey unlock removed. You can also delete the passkey from your device's password manager." });
      }
    },

    changePassphrase: async (current, next) => {
      const blob = readBlob();
      if (!blob || !dek) return false;
      armIdle();
      set({ working: "Re-sealing with the new passphrase…", error: "", notice: "" });
      try {
        await unlockWithPassphrase(blob, current); // proves the current passphrase
        const updated = await rewrap(blob, dek, next);
        if (!writeBlob(updated)) throw new Error("Browser storage is full.");
        set({ working: "", notice: "Passphrase changed." });
        return true;
      } catch (error) {
        set({ working: "", error: error instanceof WrongKeyError ? "Current passphrase is wrong." : error instanceof Error ? error.message : "Could not change it." });
        return false;
      }
    },

    destroy: () => {
      try {
        localStorage.removeItem(VAULT_KEY);
        localStorage.removeItem(THROTTLE_KEY);
      } catch {
        /* ignore */
      }
      get().lock();
      set({ status: "none", hasPasskey: false, notice: "Vault deleted." });
    },

    touch: () => {
      if (get().status === "unlocked") armIdle();
    },

    clearMessages: () => set({ error: "", notice: "" }),
  };
});
