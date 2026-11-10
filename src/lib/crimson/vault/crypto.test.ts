import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addPasskey,
  asVaultBlob,
  changePassphrase,
  createVault,
  passphraseProblem,
  random,
  removePasskey,
  saveEntries,
  toB64,
  unlockWithPassphrase,
  unlockWithPrf,
  WrongKeyError,
  type VaultEntry,
} from "./crypto.ts";

const FAST = 100_000; // keep tests quick; production uses 600k
const PASS = "correct horse battery";
const entry = (title: string, secret: string): VaultEntry => ({ id: title, title, secret, note: "", updatedAt: "2026-11-10" });

describe("vault crypto", () => {
  it("round-trips entries and never stores plaintext", async () => {
    const { blob, dek } = await createVault(PASS, FAST);
    const saved = await saveEntries(blob, dek, [entry("github", "ghp_SECRETVALUE123")]);
    const text = JSON.stringify(saved);
    assert.ok(!text.includes("ghp_SECRETVALUE123") && !text.includes("github") && !text.includes(PASS));
    const opened = await unlockWithPassphrase(saved, PASS);
    assert.equal(opened.entries[0].secret, "ghp_SECRETVALUE123");
  });
  it("rejects a wrong passphrase without decrypting", async () => {
    const { blob } = await createVault(PASS, FAST);
    await assert.rejects(unlockWithPassphrase(blob, "correct horse batterx"), WrongKeyError);
  });
  it("uses fresh IVs and salts every time", async () => {
    const a = await createVault(PASS, FAST);
    const b = await createVault(PASS, FAST);
    assert.notEqual(a.blob.kdf.salt, b.blob.kdf.salt);
    const s1 = await saveEntries(a.blob, a.dek, []);
    const s2 = await saveEntries(a.blob, a.dek, []);
    assert.notEqual(s1.data.iv, s2.data.iv);
  });
  it("detects tampering and swapped boxes", async () => {
    const { blob, dek } = await createVault(PASS, FAST);
    const saved = await saveEntries(blob, dek, [entry("a", "1")]);
    const bytes = Buffer.from(saved.data.ct, "base64");
    bytes[0] ^= 1;
    await assert.rejects(unlockWithPassphrase({ ...saved, data: { ...saved.data, ct: bytes.toString("base64") } }, PASS));
    await assert.rejects(unlockWithPassphrase({ ...saved, data: saved.pass }, PASS)); // AAD binds purpose
  });
  it("changing the passphrase keeps data and locks out the old one", async () => {
    const { blob, dek } = await createVault(PASS, FAST);
    const saved = await saveEntries(blob, dek, [entry("a", "kept")]);
    const changed = await changePassphrase(saved, dek, "a whole new phrase", FAST);
    assert.equal((await unlockWithPassphrase(changed, "a whole new phrase")).entries[0].secret, "kept");
    await assert.rejects(unlockWithPassphrase(changed, PASS), WrongKeyError);
  });
  it("passkey PRF unlock works, wrong PRF fails, removal disables it", async () => {
    const { blob, dek } = await createVault(PASS, FAST);
    const prf = random(32);
    const withKey = await addPasskey(await saveEntries(blob, dek, [entry("a", "via passkey")]), dek, { credId: "cred", prfSalt: toB64(random(32)), prfOutput: prf });
    assert.equal((await unlockWithPrf(withKey, prf)).entries[0].secret, "via passkey");
    await assert.rejects(unlockWithPrf(withKey, random(32)), /does not open/);
    assert.equal((await unlockWithPassphrase(withKey, PASS)).entries[0].secret, "via passkey"); // passphrase still works
    await assert.rejects(unlockWithPrf(removePasskey(withKey), prf), /No passkey/);
  });
  it("enforces passphrase rules", async () => {
    assert.ok(passphraseProblem("short"));
    assert.ok(passphraseProblem("aaaaaaaaaaaa"));
    assert.ok(passphraseProblem("password123456"));
    assert.equal(passphraseProblem(PASS), null);
    await assert.rejects(createVault("short", FAST), /at least/);
  });
  it("validates blob shape", async () => {
    const { blob } = await createVault(PASS, FAST);
    assert.ok(asVaultBlob(JSON.parse(JSON.stringify(blob))));
    assert.equal(asVaultBlob({ ...blob, v: 2 }), null);
    assert.equal(asVaultBlob({ ...blob, kdf: { ...blob.kdf, iterations: 10 } }), null);
    assert.equal(asVaultBlob({ hello: 1 }), null);
  });
});
