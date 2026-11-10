/**
 * GitHub API access for clone and push — **server-only**.
 *
 * Env:
 *   GITHUB_TOKEN   a GitHub token. Needed to push and to clone private repos;
 *                  without it, clone copies public repos only and push is off.
 *                  Use a fine-grained token limited to the repos you want,
 *                  with "Contents: Read and write" (and "Metadata: Read").
 *                  It stays on the server: the browser never sees it.
 */
import { env } from "@/lib/env.server";

const API = "https://api.github.com";

export function githubToken(): string | undefined {
  const token = env("GITHUB_TOKEN")?.trim();
  return token ? token : undefined;
}

export type GitHubError = { ok: false; status: number; error: string };

/** Calls the GitHub REST API with the server's token. */
export async function gh<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<{ ok: true; status: number; data: T } | GitHubError> {
  const token = githubToken();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ToolNeuron",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, status: 0, error: "Could not reach GitHub." };
  }
  const data = (await response.json().catch(() => ({}))) as T & { message?: string };
  if (!response.ok) {
    const message = typeof data?.message === "string" ? data.message : `HTTP ${response.status}`;
    return { ok: false, status: response.status, error: explain(response.status, message, path) };
  }
  return { ok: true, status: response.status, data };
}

function explain(status: number, message: string, path: string): string {
  if (status === 401) return "GitHub refused the token (401). Check GITHUB_TOKEN on the server.";
  if (status === 403 && /rate limit/i.test(message)) return "GitHub's API rate limit was reached. Try again later.";
  if (status === 403) return `GitHub refused (403): ${message}. The token may lack "Contents: Read and write" for this repo.`;
  if (status === 404) return `Not found on GitHub (${path.split("/").slice(2, 4).join("/")}). It is misspelled, or private and the token cannot see it.`;
  if (status === 409 && /empty/i.test(message)) return "The GitHub repo is empty. Create it with a README (or push one commit some other way) first.";
  if (status === 422) return `GitHub rejected the request (422): ${message}.`;
  return `GitHub returned ${status}: ${message}.`;
}
