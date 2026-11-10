Here is a prioritized review of the **ToolNeuron / Crimson OS** codebase with concrete suggestions and `file:line` citations, followed by a concrete guide for routing AI completions to OpenRouter and OmniRoute.

---

### 1. Security Issues (Critical & High Priority)

1. **Insecure JavaScript Sandbox via `new Function`** (`src/lib/crimson/runtime.ts:25-33`): Shadowing `window`, `document`, and `localStorage` with `undefined` does not prevent sandbox escape. Code can regain global scope via `Function("return this")()` or `(0, eval)("this")`, allowing full read/write access to host cookies, DOM, and `localStorage.getItem("crimson_os_v1")`. Run untrusted JS inside an isolated worker or a sandboxed `iframe` without `allow-same-origin`.
2. **Unauthenticated Public AI Server Function** (`src/lib/crimson/ai.functions.ts:3-18`): `askCrimson` is an unauthenticated, un-rate-limited public endpoint exposed to the internet. Anyone discovering the endpoint can spam requests, draining your upstream LLM quota and budget. Add session authentication or rate-limiting middleware.
3. **Hard-coded Plaintext Vault PIN & Trivial Bypass** (`src/components/crimson/hub.tsx:255-260`, `323`): PIN `8832` is stored in client-side code, and the "Biometric drill" button triggers `unlock()` unconditionally after a 1.6s timeout. Store a hashed secret in `localStorage` or treat it purely as an explicit UI simulation.
4. **Iframe Preview Script Restriction & Origin Isolation** (`src/components/crimson/editor-view.tsx:101`): `sandbox=""` completely disables JavaScript. While secure, it breaks any interactive HTML/JS file (like the default `interface.html` button). If enabling scripts (`sandbox="allow-scripts"`), serve it on a distinct origin/subdomain to prevent same-origin credential theft.

---

### 2. Bugs & Logic Errors

5. **State Inconsistency & Race Condition in File Creation** (`src/lib/crimson/store.ts:368-372`): In `createItem()`, `get().flushDraft()` is called *after* mapping `files` into a local variable, and line 371 redundantly maps and concats `get().files`, leading to draft loss or duplicate items. Call `flushDraft()` first, then update state in a single atomic `set()` transaction.
6. **Fragile Regex Markdown Fence Stripping** (`src/lib/crimson/store.ts:578`): The regex `/^```[a-z]*\n?|```$/g` fails whenever the LLM outputs introductory or concluding conversational prose (e.g., "Here is your file:\n```python..."). Match and extract the first fenced code block `/```[a-z]*\n([\s\S]*?)```/` instead.
7. **Python Print Parser Breaks on Commas and Parentheses** (`src/lib/crimson/runtime.ts:57`, `71`): In `evalPrint()`, splitting on `,` corrupts string literals containing commas (e.g. `print("Hello, world")` outputs `"Hello` and `world"`). Additionally, the non-greedy regex breaks on nested parentheses like `print(len(x))`.
8. **Broken Directory Traversal in Terminal** (`src/lib/crimson/terminal.ts:95-99`): `changeDir` allows endless valid subpaths if `cwd.endsWith("/project")` (e.g. `cd project` repeated creates `~/crimson-node/project/project/project`). Check against the actual child folder IDs in `ctx.files`.
9. **Stale Draft Execution via Debounce Desync** (`src/components/crimson/editor-view.tsx:29-32` vs `src/lib/crimson/terminal.ts:71-73`): `flushDraft()` is debounced by 800ms. If a user edits code and immediately types `python <file>` in the terminal or switches tabs, the terminal executes stale content from `file.content`.
10. **Duplicate Personality Spawn on Boot** (`src/lib/crimson/store.ts:208-216`): In `bootPersistence`, if a user renames a built-in personality, `known.has(item.name)` returns false and re-inserts the default seed personality on reload. Track personalities by stable `id` rather than mutable `name`.
11. **Desynchronized Line Gutter on Text Wrap** (`src/components/crimson/editor-view.tsx:86-96`): The `<textarea>` allows wrapping while the `<pre>` line numbers do not wrap. Long lines cause gutter numbers to misalign vertically with corresponding lines. Add `whitespace-pre overflow-x-auto` to the textarea.
12. **Non-unique Chat Keys Trigger React Reconciliation Warnings** (`src/components/crimson/hub.tsx:100`): `key={message.timestamp + message.role + message.text.slice(0, 12)}` causes collision errors when rapid or identical prompts are sent. Assign an explicit UUID or nanoid to each `ChatMessage`.
13. **Editor Mode Desync on Tree Purge** (`src/lib/crimson/store.ts:403-415`): If all files are deleted, `activeFileId` becomes `""`, but `editorMode` remains unchanged, causing the code editor view to render blank or broken inputs.
14. **Git Commit Message Parsing Flaw** (`src/lib/crimson/terminal.ts:147`): Regex `args.slice(1).join(" ").replace(/^-m\s*/, "")` breaks if additional git flags or non-standard quoting are passed.

---

### 3. OpenRouter & OmniRoute Integration (`src/lib/crimson/ai.functions.ts`)

Currently, `ai.functions.ts` hard-wires `https://api.x.ai/v1/chat/completions`, `XAI_API_KEY`, and `"grok-4.5"` (`src/lib/crimson/ai.functions.ts:19`, `27`, `34`). Both OpenRouter and OmniRoute follow the OpenAI-compatible `/v1/chat/completions` schema, making them drop-in replacements with the following adjustments:

15. **Configurable Base URL (`src/lib/crimson/ai.functions.ts:27`)**:
    Replace the hardcoded endpoint with an environment variable fallback:
    ```typescript
    const AI_BASE_URL = (process.env.AI_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    const endpoint = `${AI_BASE_URL}/chat/completions`;
    ```
    - **OpenRouter**: Set `AI_BASE_URL="https://openrouter.ai/api/v1"`.
    - **OmniRoute**: Set `AI_BASE_URL="http://<omniroute-host>:<port>/v1"`.
16. **Generic API Key Resolution (`src/lib/crimson/ai.functions.ts:19-22`)**:
    Support multiple upstream keys with graceful fallback:
    ```typescript
    const apiKey = process.env.AI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.OMNIROUTE_API_KEY || process.env.XAI_API_KEY || "";
    // Note: OmniRoute deployed locally behind a VPN may not require an Authorization header;
    // only block if neither apiKey nor a local OmniRoute base URL is present.
    ```
17. **Dynamic Model Selection (`src/lib/crimson/ai.functions.ts:34`)**:
    Allow model configuration via environment variable or input validator:
    - Default OpenRouter model: `process.env.AI_MODEL || "anthropic/claude-3.5-sonnet"` or `"meta-llama/llama-3.3-70b-instruct"`.
    - Default OmniRoute model: Whatever model alias or tag is registered in your OmniRoute routing table (e.g. `qwen2.5-coder-32b`).
18. **OpenRouter Required Headers (`src/lib/crimson/ai.functions.ts:29-32`)**:
    OpenRouter recommends app attribution headers for stats and rate-limit separation:
    ```typescript
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      "HTTP-Referer": process.env.APP_URL || "http://localhost:8080",
      "X-Title": "ToolNeuron Crimson OS",
    }
    ```
19. **OmniRoute Parameter Compatibility (`src/lib/crimson/ai.functions.ts:35-36`)**:
    Certain self-hosted OpenAI gateways throw errors on `max_tokens` (expecting `max_completion_tokens`) or strict temperature ranges. Guard or omit parameters if undefined.
20. **Client-Configurable Gateway in UI (`src/components/crimson/settings-view.tsx:14`)**:
    Allow users in `SettingsView` to input their own self-hosted OmniRoute URL and custom Model ID saved into local state, passed via `askCrimson({ data: { ... } })`.

---

### 4. UX & Design Improvements

21. **Upgrade Code Editor from `<textarea>`** (`src/components/crimson/editor-view.tsx:86-96`): Replace the bare HTML textarea with CodeMirror 6 or Monaco. Current editor cannot handle `Tab` indentation, code folding, syntax highlighting, or bracket matching.
22. **Multiline Chat Input** (`src/components/crimson/hub.tsx:131-135`): Change single-line `<input>` to an auto-resizing `<textarea>` that submits on `Enter` and adds newline on `Shift+Enter`.
23. **Streaming & Cancellation UI** (`src/components/crimson/hub.tsx:106`, `src/lib/crimson/store.ts:553`): Replace the static `busy: boolean` wait with token-by-token streaming and an `AbortController` cancellation button.
24. **Markdown Rendering Enhancements** (`src/components/crimson/rich.tsx:1-23`): The custom markdown renderer only handles triple backticks and bold text. Replace with `react-markdown` + `rehype-highlight` to render tables, inline backticks, lists, and syntax-colored snippets.
25. **Direct Navigation from Analysis Findings to Editor** (`src/components/crimson/analysis-view.tsx:68-77`): Clicking a finding should navigate to the `editor` tab, open the relevant file, and scroll/highlight the target line.
26. **Mobile Safe Area & Tab Bar Spacing** (`src/components/crimson/shell.tsx:73-90`): The bottom fixed nav lacks `pb-[env(safe-area-inset-bottom)]`, causing navigation buttons to collide with the home bar on iOS devices.
27. **Terminal Autocompletion** (`src/components/crimson/terminal-view.tsx:80-97`): Add `Tab` key handling to autocomplete commands (`cat`, `python`, `cd`) and project file names.
28. **Import/Restore for Workspace State** (`src/components/crimson/settings-view.tsx:40-50`): You provide "Export node" to download JSON, but there is no corresponding "Import JSON" button to restore state on a new device.

---

### 5. Missing Features

29. **True AI Response Streaming (SSE)** (`src/lib/crimson/ai.functions.ts:27-50`): Stream chunks over SSE instead of waiting for `await response.json()`, eliminating high time-to-first-token latency.
30. **Project ZIP / File Download** (`src/components/crimson/editor-view.tsx:43-74`): Add a button to export individual source files or download the full virtual workspace as a `.zip` archive.
31. **Visual Git Diff** (`src/components/crimson/editor-view.tsx:104-151`): Git mode allows staging and committing, but cannot display unified diffs between unstaged, staged, and HEAD versions.
32. **Persist Storage File Blobs** (`src/components/crimson/storage-view.tsx:23-35`): Storage ingest discards file contents and keeps only metadata. Store text/blobs in IndexedDB so uploaded files can actually be opened or inspected.
33. **Wasm-Based Python Runtime** (`src/lib/crimson/runtime.ts:51-66`): Replace the simulated print regex runner with Pyodide (WebAssembly) to execute real Python code directly inside the browser.
34. **Functional Model Bridge** (`src/components/crimson/bridge-view.tsx:36-45`): The node bridge only generates empty `.py` stubs. Connect it to a real local WebUI/ComfyUI API or WebLLM runner.

---

### 6. Code Quality & Architecture

35. **Decompose Giant Zustand Store** (`src/lib/crimson/store.ts:20-87`, `263-641`): A single 640-line store controls files, terminal, git, AI chat, swarm simulation, and settings. Split it into focused slice creators (`createFileSlice`, `createTerminalSlice`, `createChatSlice`).
36. **Replace Fragile Regex Linter with AST Parser** (`src/lib/crimson/analyze.ts:11-55`): Single-line regex checks produce false positives (e.g. valid multiline parametrized SQL or legitimate `innerHTML` usage). Use a lightweight JS/Python AST parser or tree-sitter.
37. **Clean Up Builder Scaffolding Cruft** (`src/routes/__root.tsx:23-24`, `38`): Remove builder-specific residue like `PreviewHostBridge`, `/ __grok/manifest.webmanifest`, and hardcoded `Crimson OS` strings if re-branding to ToolNeuron.
38. **Extract Hardcoded Magic Constants** (`src/lib/crimson/store.ts:431`, `456`, `515`): Extract magic numbers (history limits `200`, `40`, `30`, token thresholds `420`/`900`, timeouts `800ms`) into a centralized `constants.ts` file.
