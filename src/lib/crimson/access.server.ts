/**
 * Access key + rate limiting for the AI endpoints — **server-only**.
 *
 * Keep the `.server` suffix and import it only via `await import()` inside
 * server-function handlers (it pulls in `@tanstack/react-start/server`).
 *
 * Env:
 *   APP_ACCESS_KEY     required for AI calls. Unset = AI disabled (fail closed).
 *   AI_RATE_PER_MIN    per client IP, default 20
 *   AI_DAILY_CAP       whole server, per UTC day, default 500
 *   COOKIE_SECURE      "true" when served over HTTPS (default: false, for the
 *                      ssh-tunnel http://localhost setup)
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { deleteCookie, getCookie, getRequestIP, setCookie } from "@tanstack/react-start/server";
import { assertSameSiteRequest } from "@/lib/auth/isolation.server";
import { env } from "@/lib/env.server";

const COOKIE = "tn_access";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function key(): string | undefined {
  const value = env("APP_ACCESS_KEY");
  return value && value.length >= 8 ? value : undefined;
}

/** Cookie value: HMAC of a fixed label under the access key. Rotating the key logs everyone out. */
function token(accessKey: string): string {
  return createHmac("sha256", accessKey).update("toolneuron-access-v1").digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type AccessState = "unlocked" | "locked" | "unconfigured";

export function accessState(): AccessState {
  const accessKey = key();
  if (!accessKey) return "unconfigured";
  const cookie = getCookie(COOKIE);
  return cookie && safeEqual(cookie, token(accessKey)) ? "unlocked" : "locked";
}

// ---- unlock attempts: slow down guessing (5 tries / 10 min per IP) ----
const attempts = new Map<string, number[]>();

function clientIp(): string {
  try {
    return getRequestIP({ xForwardedFor: true }) ?? "unknown";
  } catch {
    return "unknown";
  }
}

function hit(map: Map<string, number[]>, id: string, windowMs: number, limit: number): boolean {
  const now = Date.now();
  const recent = (map.get(id) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    map.set(id, recent);
    return false;
  }
  recent.push(now);
  map.set(id, recent);
  if (map.size > 5000) map.clear(); // crude bound on memory
  return true;
}

export function unlock(candidate: string): { ok: true } | { ok: false; error: string } {
  assertSameSiteRequest();
  const accessKey = key();
  if (!accessKey) return { ok: false, error: "APP_ACCESS_KEY is not set on the server (min 8 characters)." };
  const ip = clientIp();
  const now = Date.now();
  const failures = (attempts.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
  if (failures.length >= 5) return { ok: false, error: "Too many wrong attempts. Wait 10 minutes." };
  if (!safeEqual(token(candidate), token(accessKey))) {
    hit(attempts, ip, 10 * 60_000, 5); // only wrong keys count toward the lockout
    return { ok: false, error: "Wrong access key." };
  }
  attempts.delete(ip);
  setCookie(COOKIE, token(accessKey), {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: env("COOKIE_SECURE") === "true",
    maxAge: MAX_AGE,
  });
  return { ok: true };
}

export function lock(): void {
  assertSameSiteRequest();
  deleteCookie(COOKIE, { path: "/" });
}

// ---- AI call limits ----
const calls = new Map<string, number[]>();
let day = "";
let dayCount = 0;

function intEnv(name: string, fallback: number): number {
  const n = Number(env(name));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Returns an error string when the call must be refused, else null. */
export function guardAiCall(): string | null {
  assertSameSiteRequest();
  const state = accessState();
  if (state === "unconfigured") return "AI is disabled: set APP_ACCESS_KEY on the server.";
  if (state === "locked") return "Locked. Enter the access key to use AI.";

  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    dayCount = 0;
  }
  if (dayCount >= intEnv("AI_DAILY_CAP", 500)) return "Daily AI limit reached. It resets at 00:00 UTC.";
  if (!hit(calls, clientIp(), 60_000, intEnv("AI_RATE_PER_MIN", 20))) {
    return "Slow down: too many AI requests this minute.";
  }
  dayCount += 1;
  return null;
}

// ---- clone limits ----
const clones = new Map<string, number[]>();

/**
 * Guard for the GitHub endpoints (clone, pull, push): same site, unlocked,
 * and at most CLONE_PER_MIN (default 12) calls a minute per client, shared
 * by the three. Separate from the AI budget.
 */
export function guardCloneCall(): string | null {
  assertSameSiteRequest();
  const state = accessState();
  if (state === "unconfigured") return "Cloning is disabled: set APP_ACCESS_KEY on the server.";
  if (state === "locked") return "Locked. Enter the access key (header lock) to clone.";
  if (!hit(clones, clientIp(), 60_000, intEnv("CLONE_PER_MIN", 12))) return "Slow down: too many clones this minute.";
  return null;
}
