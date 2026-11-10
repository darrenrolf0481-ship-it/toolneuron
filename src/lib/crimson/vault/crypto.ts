/**
 * Vault encryption (Web Crypto only; runs in browsers and Node 22).
 *
 * Envelope design:
 *   DEK   random 256-bit data key. Encrypts the entries (AES-256-GCM).
 *   pass  DEK sealed with a key derived from the passphrase
 *         (PBKDF2-SHA256, 600k iterations, random 16-byte salt).
 *   passkey (optional) DEK sealed with a key derived (HKDF-SHA256) from a
 *         WebAuthn PRF output, which only that passkey + user verification
 *         can produce.
 * Every box has a fresh 12-byte IV and purpose-bound AAD, so boxes cannot be
 * swapped. A wrong passphrase fails the GCM tag check; nothing is decrypted.
 * The blob is safe to store or export: it contains no key material in clear.
 */

export const VAULT_VERSION = 1;
export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSPHRASE = 10;

export type Box = { iv: string; ct: string };
export type VaultBlob = {
  v: number;
  kdf: { name: "PBKDF2-SHA256"; iterations: number; salt: string };
  pass: Box;
  passkey?: { credId: string; prfSalt: string; hkdfSalt: string; box: Box };
  data: Box;
  updatedAt: string;
};
export type VaultEntry = { id: string; title: string; secret: string; note: string; updatedAt: string };

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
const AAD = {
  pass: enc.encode("toolneuron-vault-v1:dek:passphrase"),
  passkey: enc.encode("toolneuron-vault-v1:dek:passkey"),
  data: enc.encode("toolneuron-vault-v1:data"),
};

export function random(bytes: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(bytes));
}

export function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = "";
  for (let i = 0; i < view.length; i++) text += String.fromCharCode(view[i]);
  return btoa(text);
}

export function fromB64(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function seal(key: CryptoKey, plain: Uint8Array<ArrayBuffer>, aad: Uint8Array<ArrayBuffer>): Promise<Box> {
  const iv = random(12);
  const ct = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, plain);
  return { iv: toB64(iv), ct: toB64(ct) };
}

async function openBox(key: CryptoKey, box: Box, aad: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const plain = await subtle().decrypt({ name: "AES-GCM", iv: fromB64(box.iv), additionalData: aad }, key, fromB64(box.ct));
  return new Uint8Array(plain);
}

async function passphraseKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", enc.encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function prfKey(prfOutput: ArrayBuffer | Uint8Array<ArrayBuffer>, hkdfSalt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", prfOutput, "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: hkdfSalt, info: enc.encode("toolneuron-vault-v1:passkey-kek") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** The DEK is extractable only so a passkey can be added while unlocked. It lives in memory only. */
async function importDek(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return subtle().importKey("raw", raw, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

async function sealEntries(dek: CryptoKey, entries: VaultEntry[]): Promise<Box> {
  return seal(dek, enc.encode(JSON.stringify(entries)), AAD.data);
}

async function openEntries(dek: CryptoKey, blob: VaultBlob): Promise<VaultEntry[]> {
  const parsed: unknown = JSON.parse(dec.decode(await openBox(dek, blob.data, AAD.data)));
  if (!Array.isArray(parsed)) throw new Error("Vault data is malformed.");
  return parsed as VaultEntry[];
}

export function passphraseProblem(passphrase: string): string | null {
  if (passphrase.length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters.`;
  if (/^(.)\1+$/.test(passphrase)) return "Do not repeat a single character.";
  if (/^(0123456789|1234567890|password|qwertyuiop)/i.test(passphrase)) return "That passphrase is too easy to guess.";
  return null;
}

export async function createVault(passphrase: string, iterations = PBKDF2_ITERATIONS): Promise<{ blob: VaultBlob; dek: CryptoKey }> {
  const problem = passphraseProblem(passphrase);
  if (problem) throw new Error(problem);
  const raw = random(32);
  const salt = random(16);
  const kek = await passphraseKey(passphrase, salt, iterations);
  const dek = await importDek(raw);
  raw.fill(0);
  const blob: VaultBlob = {
    v: VAULT_VERSION,
    kdf: { name: "PBKDF2-SHA256", iterations, salt: toB64(salt) },
    pass: await seal(kek, new Uint8Array(await subtle().exportKey("raw", dek)), AAD.pass),
    data: await sealEntries(dek, []),
    updatedAt: new Date().toISOString(),
  };
  return { blob, dek };
}

export class WrongKeyError extends Error {
  constructor() {
    super("Wrong passphrase.");
  }
}

export async function unlockWithPassphrase(blob: VaultBlob, passphrase: string): Promise<{ dek: CryptoKey; entries: VaultEntry[] }> {
  const kek = await passphraseKey(passphrase, fromB64(blob.kdf.salt), blob.kdf.iterations);
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = await openBox(kek, blob.pass, AAD.pass);
  } catch {
    throw new WrongKeyError();
  }
  const dek = await importDek(raw);
  raw.fill(0);
  return { dek, entries: await openEntries(dek, blob) };
}

export async function unlockWithPrf(blob: VaultBlob, prfOutput: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<{ dek: CryptoKey; entries: VaultEntry[] }> {
  if (!blob.passkey) throw new Error("No passkey is set up for this vault.");
  const kek = await prfKey(prfOutput, fromB64(blob.passkey.hkdfSalt));
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = await openBox(kek, blob.passkey.box, AAD.passkey);
  } catch {
    throw new Error("That passkey does not open this vault.");
  }
  const dek = await importDek(raw);
  raw.fill(0);
  return { dek, entries: await openEntries(dek, blob) };
}

export async function saveEntries(blob: VaultBlob, dek: CryptoKey, entries: VaultEntry[]): Promise<VaultBlob> {
  return { ...blob, data: await sealEntries(dek, entries), updatedAt: new Date().toISOString() };
}

export async function changePassphrase(blob: VaultBlob, dek: CryptoKey, next: string, iterations = PBKDF2_ITERATIONS): Promise<VaultBlob> {
  const problem = passphraseProblem(next);
  if (problem) throw new Error(problem);
  const salt = random(16);
  const kek = await passphraseKey(next, salt, iterations);
  const raw = new Uint8Array(await subtle().exportKey("raw", dek));
  const pass = await seal(kek, raw, AAD.pass);
  raw.fill(0);
  return { ...blob, kdf: { name: "PBKDF2-SHA256", iterations, salt: toB64(salt) }, pass, updatedAt: new Date().toISOString() };
}

export async function addPasskey(
  blob: VaultBlob,
  dek: CryptoKey,
  passkey: { credId: string; prfSalt: string; prfOutput: ArrayBuffer | Uint8Array<ArrayBuffer> },
): Promise<VaultBlob> {
  const hkdfSalt = random(16);
  const kek = await prfKey(passkey.prfOutput, hkdfSalt);
  const raw = new Uint8Array(await subtle().exportKey("raw", dek));
  const box = await seal(kek, raw, AAD.passkey);
  raw.fill(0);
  return {
    ...blob,
    passkey: { credId: passkey.credId, prfSalt: passkey.prfSalt, hkdfSalt: toB64(hkdfSalt), box },
    updatedAt: new Date().toISOString(),
  };
}

export function removePasskey(blob: VaultBlob): VaultBlob {
  const { passkey: _removed, ...rest } = blob;
  return { ...rest, updatedAt: new Date().toISOString() };
}

const isBox = (value: unknown): value is Box =>
  !!value && typeof value === "object" && typeof (value as Box).iv === "string" && typeof (value as Box).ct === "string";

/** Shape check for a stored or imported blob (no decryption). */
export function asVaultBlob(value: unknown): VaultBlob | null {
  if (!value || typeof value !== "object") return null;
  const blob = value as VaultBlob;
  if (blob.v !== VAULT_VERSION || !isBox(blob.pass) || !isBox(blob.data)) return null;
  if (blob.kdf?.name !== "PBKDF2-SHA256" || typeof blob.kdf.salt !== "string") return null;
  if (!Number.isInteger(blob.kdf.iterations) || blob.kdf.iterations < 100_000 || blob.kdf.iterations > 10_000_000) return null;
  if (blob.passkey && (!isBox(blob.passkey.box) || typeof blob.passkey.credId !== "string" || typeof blob.passkey.prfSalt !== "string" || typeof blob.passkey.hkdfSalt !== "string")) {
    return null;
  }
  return blob;
}
