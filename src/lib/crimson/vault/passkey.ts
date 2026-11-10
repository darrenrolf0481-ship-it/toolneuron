/**
 * Passkey unlock via the WebAuthn PRF extension (browser-only).
 *
 * The passkey never leaves the authenticator. On each unlock the authenticator
 * verifies the user (fingerprint, face or device PIN) and returns a 32-byte
 * PRF output for our salt; crypto.ts turns that into the key that seals the
 * vault's data key. Without the passkey and the user's verification, the
 * value cannot be produced. No server is involved.
 */
import { fromB64, random, toB64 } from "./crypto";

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

/** WebAuthn refuses IP addresses as the relying party: passkeys need localhost or a domain name. */
export function onIpAddress(): boolean {
  return typeof location !== "undefined" && (/^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname) || location.hostname.includes(":"));
}

export async function passkeySupport(): Promise<"yes" | "no" | "maybe"> {
  if (typeof window === "undefined" || !window.isSecureContext || !("PublicKeyCredential" in window) || onIpAddress()) return "no";
  const capabilities = (PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> })
    .getClientCapabilities;
  if (!capabilities) return "maybe";
  try {
    const caps = await capabilities();
    if (caps["extension:prf"] === true) return "yes";
    if (caps["extension:prf"] === false) return "no";
  } catch {
    /* fall through */
  }
  return "maybe";
}

function rpId() {
  return location.hostname;
}

async function evaluate(credId: Uint8Array<ArrayBuffer>, prfSalt: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      rpId: rpId(),
      allowCredentials: [{ type: "public-key", id: credId }],
      userVerification: "required",
      timeout: 60_000,
      extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) throw new Error("No passkey was used.");
  const output = (assertion.getClientExtensionResults() as PrfResults).prf?.results?.first;
  if (!output) throw new Error("This passkey or browser does not support the PRF extension, so it cannot unlock the vault.");
  return output;
}

/** Creates a passkey for this vault and returns what is needed to seal the data key with it. */
export async function enrollPasskey(): Promise<{ credId: string; prfSalt: string; prfOutput: ArrayBuffer }> {
  const prfSalt = random(32);
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: random(32),
      rp: { name: "ToolNeuron Vault", id: rpId() },
      user: { id: random(16), name: "toolneuron-vault", displayName: "ToolNeuron vault" },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      timeout: 60_000,
      extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey creation was cancelled.");
  const results = credential.getClientExtensionResults() as PrfResults;
  if (results.prf?.enabled === false) throw new Error("This authenticator does not support the PRF extension.");
  const credId = new Uint8Array(credential.rawId);
  // Some authenticators return the PRF output at creation; most need one assertion.
  const prfOutput = results.prf?.results?.first ?? (await evaluate(credId, prfSalt));
  return { credId: toB64(credId), prfSalt: toB64(prfSalt), prfOutput };
}

export async function passkeyPrf(credId: string, prfSalt: string): Promise<ArrayBuffer> {
  return evaluate(fromB64(credId), fromB64(prfSalt));
}

export function passkeyErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") return "Passkey request was cancelled or timed out.";
    if (error.name === "SecurityError") {
      return onIpAddress()
        ? `Passkeys do not work on an IP address. Open http://localhost:${location.port || "80"} (or a domain) instead.`
        : "Passkeys need a secure page (https or localhost).";
    }
    if (error.name === "InvalidStateError") return "This device already has a passkey for the vault.";
  }
  return error instanceof Error ? error.message : "Passkey failed.";
}
