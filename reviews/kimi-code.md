• Reviewed the full source. Prioritized list, highest impact first.

  ## Bugs / correctness

  - **Duplicate findings for one line** — `analyze.ts:12-14`: a line like `query = f"SELECT ..."` matches both the f-string regex (line 12) and the `query = f"..."` regex (line 14), producing two identical "SQL injection" findings. Dedupe by line+rule before returning.
  - **"Python" sandbox is escapable and can hang the tab** — `runtime.ts:25-33`: shadowing `document/window/fetch/localStorage` as params is cosmetic; user code reaches the real globals via `globalThis` or `Function("return this")()`. An infinite loop freezes the whole app (sync `new Function`). Run it in a Web Worker with a timeout, and drop the pretense of sandboxing or label it honestly.
  - **Fake Python output special-case** — `runtime.ts:53-56`: any file containing `class NeuralCore` gets a hard-coded `[SYSTEM] NeuralCore constructed` + canned JSON. The seed demo depends on fabricated output; at minimum gate it behind the seed file id, not a regex over user code.
  - **`print()` regex breaks on nested parens/strings** — `runtime.ts:57`: `print(func(a))` or `print(")")` mis-parses. Toy parser, but it prints wrong output with total confidence.
  - **Privacy contradiction** — `store.ts:133` tells the user "Files stay in this browser," but `systemPrompt()` (`store.ts:184`) pastes up to 3,500 chars of the open file into *every* chat request, and the Analysis view (`analysis-view.tsx:31-33`) sends another 4,000. Fix the copy or make file inclusion opt-in per message.
  - **localStorage write on every keystroke** — `store.ts:235-260`: the subscribe handler stringifies the entire files array + chat + terminal on every state change (each `setDraft`). Debounce 500–1000ms and/or write only `draft` during editing.
  - **Export without import** — `settings-view.tsx:40-47` downloads a node JSON but there's no way to restore it. Half a feature; add an import path or don't ship export.
  - **`cd`/`ls` disagree past one level** — `terminal.ts:95-99` lets you `cd` into arbitrary subpaths under `/project`, but `listDir` (`terminal.ts:102-112`) only special-cases exact suffixes, so `ls` in `~/crimson-node/project/src` lists root files. Also `catFile` (`terminal.ts:118`) ignores `cwd` entirely.
  - **SQLi fix advice is Python-only** — `analyze.ts:21`: the suggested fix uses `db.execute(..., (user_id,))` even for JS/TS files. Pick the fix per language.
  - **SQLi regex false positives** — `analyze.ts:12`: `f"SELECT * FROM users"` with no interpolation still flags critical. Require `${`/`{`/`+`/`%` interpolation before flagging.
  - **N+1 heuristic is opaque** — `analyze.ts:57-66`: requires `.objects.all(` *and* `.author.` *and* any `for` loop, then reports the first `for` line even if unrelated. Either name it Django-specific in the rule text or drop the line number.
  - **NAV[6] magic index** — `shell.tsx:57`: settings tab referenced by position; reordering NAV silently breaks the desktop rail. Find by id.
  - **Duplicate personality-merge logic** — `store.ts:208-216` and `store.ts:643-648` do the same seed-merge in two places; the module-level one (`store.ts:643`) also runs at import time before boot state exists. Keep one.
  - **`removePack` condition is confusing** — `store.ts:493`: `pack.id !== id || pack.id === "doctrine"` works but reads like a bug; write `if (id === "doctrine") return`.
  - **Unused computed variable** — `store.ts:368`: `files` is built but the file-creation path at line 371 recomputes from `get().files` after the flush. Split the two branches cleanly.
  - **`Pack.status: "cataloged"` never set** — `types.ts:41` vs `hub.tsx:200-207`; dead union member.

  ## Security

  - **No rate limiting / auth on the AI endpoint** — `ai.functions.ts:3-18`: the server function is world-callable; anyone can script POSTs and burn the owner's XAI/OpenRouter quota (cost DoS). Add per-IP rate limiting (e.g. upstash Ratelimit or an in-memory token bucket) and a daily cap.
  - **No fetch timeout** — `ai.functions.ts:27`: a hung upstream holds the serverless function until the platform kills it. `fetch(url, { ..., signal: AbortSignal.timeout(30_000) })`.
  - **Unhandled non-JSON success body** — `ai.functions.ts:45`: `await response.json()` on a 200 with an empty/HTML body throws and 500s. Wrap in try/catch.
  - **Vault is security theater** — `hub.tsx:255` hard-codes PIN `8832` client-side, the help pane publishes it (`hub.tsx:432`), the "biometric" button just waits 1.6s and unlocks (`hub.tsx:319-325`), and the 3-strike lockout is component state that resets on remount. It's honest in the Guide, but either rename it "demo locker" or move the check server-side; as-is it teaches users a false pattern.
  - **Client-controlled system prompt** — `ai.functions.ts:4,37`: persona instructions and pack text are client input by design; fine for a toy, but cap `system` (already done, 4000) and never let the client pick the *model* (see provider notes below — model must stay server-side).
  - **Preview iframe is properly sandboxed** — `editor-view.tsx:101` `sandbox=""` is correct; keep it that way. Note `runtime.ts` should get the same treatment (worker) rather than the param-shadowing.
  - **Google Fonts third-party request** — `__root.tsx:25-28`: leaks visitor IPs to Google and blocks render. Self-host the two families or use system fonts; if you keep it, add `crossorigin` on the preconnect (currently useless without it).

  ## UX / design

  - **No `aria-live` on chat or terminal** — `hub.tsx:98`, `terminal-view.tsx:63`: new AI replies and command output are invisible to screen readers. Add `role="log" aria-live="polite"`.
  - **Silent send failure while busy** — `store.ts:555`: `consult` returns silently if `busy`; the user types a message, hits send, input clears, nothing happens. Disable the input or queue.
  - **No cancel for in-flight AI** — `hub.tsx:106`: "Holding the link…" with no abort. An AbortController per request, wired to a Stop button, is the single biggest chat UX win.
  - **Chat input uses placeholder as label** — `hub.tsx:130-135`: add `aria-label`. Same for the commit input (`editor-view.tsx:129-133`) and note input (`storage-view.tsx:57-62`).
  - **File-picker `<label>` buttons aren't keyboard-focusable** — `bridge-view.tsx:29`, `hub.tsx:189`, `storage-view.tsx:17`: the styled labels can't be reached by keyboard. Use a real `<button>` triggering a hidden input via ref.
  - **Modal lacks focus management** — `editor-view.tsx:160-187`: no Escape-to-close, no focus trap, native `window.confirm` for destructive template load. Escape + initial focus is enough.
  - **Message keys can collide** — `hub.tsx:100`: `timestamp + role + text.slice(0,12)` collides for same-ms messages; give `ChatMessage` a real id in `types.ts:30-34`.
  - **Error states vanish** — `store.ts:606-610`, `persona-forge.tsx:134-136`: network failures append a generic line; keep the failed prompt in the input for retry.
  - **Theme-color static** — `__root.tsx:14` is crimson even in `dayglass`; update it in the theme effect (`shell.tsx:42-44`).
  - **Analysis view double-sends code** — `analysis-view.tsx:31-33` + `store.ts:184`: the deep-review prompt includes the file *and* the system prompt includes the draft. Send once.

  ## Missing features

  - **Streaming responses** — all three providers support SSE; for a chat-centric app this is the most felt absence (see provider notes).
  - **Import for the node JSON export** (pairs with the bug above).
  - **Per-file export/download** from the editor tree.
  - **Chat editing/regenerate**: no way to resend or branch a message.
  - **`busy` is shared** between chat, terminal `ai`, and persona "Hear them" (`store.ts:45`, `persona-forge.tsx:65`): running one blocks the others with only a warning. Separate flags.
  - **Terminal `run` uses stale content** — `terminal-view.tsx:51-52` reads `file.content`, but unsaved edits live in `draft` (debounce is 800ms at `editor-view.tsx:29-32`); `python file.py` can run the previous version. Flush before running.

  ## Code quality

  - **`consult` is a 60-line god function** — `store.ts:553-612`: split message-building, file-creation, and append-into-store into helpers; the fileMatch rewrite of the last user message (`store.ts:566-569`) deserves a comment.
  - **Regex-driven command parsing** — `store.ts:560` file-creation intent via regex will surprise users ("please create a file named x.md" works; "make me an x.md" doesn't). Either use a structured command or send intent to the model with a tool-call.
  - **Duplicated finding-card markup** — `analysis-view.tsx:68-77` and `hub.tsx:409-419`: extract one `<FindingCard>`.
  - **`stamp()` locale-dependent** — `store.ts:191-193`: commit times differ per locale; use ISO or `toLocaleTimeString` with a fixed locale.
  - **Persisted-state spread is unvalidated** — `store.ts:217-228`: `...parsed` over `base` imports any stale key shape; validate with the zod you already have, or whitelist fields like the payload at line 237 does.
  - **No tests**: `analyze.ts` and `terminal.ts` are pure functions — the easiest, highest-value test targets in the repo.

  ## Running the chat on OpenRouter and OmniRoute

  All three (xAI, OpenRouter, OmniRoute) speak the OpenAI chat-completions shape, so `ai.functions.ts:27-39` barely changes — only base URL, auth header, and model id. Recommended refactor:

  - **Extract a provider resolver** (new `src/lib/crimson/provider.ts`), reading env server-side only:
    - `AI_PROVIDER` = `xai` (default) | `openrouter` | `omniroute`
    - `XAI_API_KEY` / `OPENROUTER_API_KEY` / `OMNIROUTE_API_KEY` + `OMNIROUTE_BASE_URL` (e.g. `http://localhost:20128` or your tunnel; strip trailing slash) + `OMNIROUTE_MODEL`
    - Return `{ baseUrl, apiKey, model, extraHeaders }`. Fail closed with the existing `ok:false` pattern (`ai.functions.ts:20-22`) when the selected provider's key is missing — never fall back silently to another provider, that's how keys leak across trust boundaries.
  - **OpenRouter**: base `https://openrouter.ai/api/v1/chat/completions`, `Authorization: Bearer ${OPENROUTER_API_KEY}`, model ids like `x-ai/grok-4.5` or `anthropic/claude-sonnet-4.5`. Optionally send `HTTP-Referer` + `X-Title` headers (app name) — OpenRouter uses them for rankings. Their error bodies are `{error:{message}}`; parse that for the `response.status` message at `ai.functions.ts:42` instead of the bare status.
  - **OmniRoute**: it's OpenAI-compatible at `${OMNIROUTE_BASE_URL}/v1/chat/completions` — same body you already build (`model`, `max_tokens`, `temperature`, `messages` at `ai.functions.ts:33-38`). OmniRoute does provider routing/failover, so: (a) use a longer timeout (60s) since fallback can cold-start; (b) let the *gateway* own model selection — set `model` to an OmniRoute-exposed name from `OMNIROUTE_MODEL` and don't hardcode `grok-4.5` (`ai.functions.ts:34`) for it; (c) if your OmniRoute instance is HTTP-only on a LAN, remember the *deployed* Vercel function must reach it — use a TLS tunnel or accept that OmniRoute only works in local dev, and detect that case with a clear error message.
  - **Keep the model server-side** (`ai.functions.ts:33-38` already builds the body server-side — keep it that way): never accept `model` or `baseUrl` from the client validator (`ai.functions.ts:4-16`), or users can point your key at arbitrary hosts/models (SSRF + cost abuse).
  - **Per-provider defaults for `fast`**: the `fast ? 420 : 900` `max_tokens` (`ai.functions.ts:35`) is fine everywhere, but map `fast` to different models per provider (e.g. cheap model for fast, flagship for precise) via a small lookup — that's where cost control actually lives.
  - **Suggested shape**:

  ```ts
  const PROVIDERS = {
    xai:        { baseUrl: "https://api.x.ai/v1",          key: process.env.XAI_API_KEY,        model: "grok-4.5", headers: {} },
    openrouter: { baseUrl: "https://openrouter.ai/api/v1", key: process.env.OPENROUTER_API_KEY, model: "x-ai/grok-4.5",
                  headers: { "HTTP-Referer": "https://your-app.example", "X-Title": "Crimson OS" } },
    omniroute:  { baseUrl: (process.env.OMNIROUTE_BASE_URL ?? "").replace(/\/$/, ""), key: process.env.OMNIROUTE_API_KEY, model: process.env.OMNIROUTE_MODEL ?? "default", headers: {} },
  } as const;
  ```

  then in the handler: resolve provider, 503-style `ok:false` if key/baseUrl missing, `fetch(\`${baseUrl}/chat/completions\`, { signal: AbortSignal.timeout(45_000), ... })`.

  - **Later**: streaming is identical on all three (SSE); if you add it, TanStack server functions can return a `ReadableStream`, so design `askCrimson` to return a stream now and the UI change later is small. And log `usage` from the response body per provider — with three possible backends, you need per-provider cost visibility.

