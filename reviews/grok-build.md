The pasted source cuts off mid-file. I'll read the omitted section so each suggestion can cite a real line.The chat path is already OpenAI-shaped. Point it at OpenRouter or OmniRoute with server env, and fix the sandbox and the localStorage store before adding features.

## OpenRouter and OmniRoute

1. Keep one Chat Completions call. `ai.functions.ts:27-38` already sends `model`, `messages`, `max_tokens`, and `temperature`. Swap the hard-coded `https://api.x.ai/v1/chat/completions`, `XAI_API_KEY`, and `grok-4.5` for server env. Never accept base URL, key, or model from the client. `ai.functions.ts:18` already trusts `data` for the prompt, and a client-supplied URL would be server-side request forgery.

2. Use `AI_PROVIDER=xai|openrouter|omniroute`, plus `*_BASE_URL`, `*_API_KEY`, `*_MODEL`, and `*_MODEL_FAST`. Request `${BASE_URL}/chat/completions`. OpenRouter is `https://openrouter.ai/api/v1` with `Authorization: Bearer`, and `HTTP-Referer` and `X-Title: ToolNeuron`. OmniRoute is your gateway origin plus `/v1/chat/completions`. Its bearer token is the gateway key. Upstream keys stay in OmniRoute. xAI stays `https://api.x.ai/v1`. Do not prefix the key with `VITE_`. Load it through `with-app-env.mjs` (`package.json:10`). The browser should keep calling `askCrimson`. A direct call to OmniRoute leaks the key and fails CORS on HTTPS pages.

3. Model slugs are not portable. `grok-4.5` (`ai.functions.ts:34`) is an xAI id. OpenRouter wants `vendor/model` (such as `x-ai/grok-4-fast`). OmniRoute wants the route name configured on the gateway. The header control (`shell.tsx:148-156`) should pick `*_MODEL_FAST` or `*_MODEL`. Today "Grok flash" only drops `max_tokens` from 900 to 420 (`ai.functions.ts:35`).

4. While you are in that handler, add `AbortSignal.timeout` (about 30s). On `!response.ok`, read `{error:{message}}` and map 401, 402, 429, and 404 to a short provider-neutral string (`ai.functions.ts:41-42`). A 200 that is not JSON throws at `ai.functions.ts:45` and the UI shows "link dropped" (`store.ts:606`). Accept `content` as a string or an array of text parts so reasoning models do not hit the empty-reply branch (`ai.functions.ts:48-49`). Send OpenRouter-only fields (`models` fallbacks, `provider.allow_fallbacks`) only when that provider is selected. Add a `getAiStatus` server function that returns `{provider, model, fastModel}` and correct the copy at `settings-view.tsx:15` and `ai.functions.ts:21`.

5. Leave streaming off until the UI can consume it. `consult` (`store.ts:571-605`) and `Rich` (`rich.tsx:1`) expect one finished string. Both gateways support `stream: true` later.

## Security

6. `new Function` does not isolate anything (`runtime.ts:25-33`). Naming parameters `document`, `fetch`, and `localStorage` only shadows those identifiers. The script can still reach `globalThis` and read `localStorage["crimson_os_v1"]` (`store.ts:18,259`). Run JavaScript in a worker with a timeout. This becomes serious once chat writes a file and the user hits Run (`store.ts:574-586`, `editor-view.tsx:62-72`).

7. `askCrimson` is an open billing endpoint. There is no session check and no rate limit, and the client supplies the system prompt (`ai.functions.ts:3-18`). The index route is public (`index.tsx:4-6`). `AuthProvider` wraps the tree (`__root.tsx:39`) and the handler never reads a user. Require a session and cap calls per minute before this is deployed.

8. The vault is a demo, and the demo shows the code. The PIN is `8832` (`hub.tsx:255`) and the guide prints it (`hub.tsx:432`). "Biometric drill" unlocks after 1.6s with no check (`hub.tsx:319-324`). Lockout is component state. `vaultUnlocked` is forced off on load (`store.ts:224`). Label it as a drill, or stop presenting it as access control.

9. Pack text and the open file are concatenated into the system prompt (`store.ts:175-188`). A knowledge file (`hub.tsx:199-207`) can override the persona. Keep the persona in `system` and pass file and pack text as a delimited user message. Refuse `file.text()` above a size cap.

10. Every keystroke writes the whole workspace to `localStorage` (`store.ts:235-259`), including chat and anything pasted into a file. `setItem` has no `try/catch`, so a quota error breaks the subscriber. Debounce, skip unchanged payloads, catch `QuotaExceededError`, and listen for `storage` so two tabs do not silently overwrite each other. Hydration spreads the parsed blob onto state (`store.ts:217-228`). Validate it (zod is already a dependency) and delete the key on failure. Today the bad key is kept (`store.ts:229`).

11. The preview iframe is appropriately locked: `sandbox=""` (`editor-view.tsx:101`) blocks scripts. Do not combine `allow-scripts` with `allow-same-origin`. Google Fonts (`__root.tsx:25-29`) also contradict "nothing calls out" (`terminal.ts:54`) and the homescreen story (`hub.tsx:439-440`). Self-host the fonts.

## Bugs

12. Late replies survive a reset. Swarm and bridge timeouts (`store.ts:499-517`, `store.ts:523`) and `consult` / `askTerminal` (`store.ts:599-633`) call `set` when they finish. `resetNode` (`store.ts:637`) does not bump a generation counter, so an old reply is appended to the fresh chat.

13. `consult` forces the Hub chat (`store.ts:558`). Review (`analysis-view.tsx:29`), Debug (`hub.tsx:392`), and Vision (`hub.tsx:167`) all navigate away from the pane the user clicked. Return the text to the caller, or add a way to stay put.

14. One multi-file ingest shares a single id. `Date.now()` inside the map (`storage-view.tsx:25`) is the same for the whole selection, so one Drop (`store.ts:551`) removes every file from that batch. Bridge rows are keyed only by `file.name` (`bridge-view.tsx:59`).

15. The terminal does not walk the project tree. `ls` lists the project root's children whenever you are outside the fake directories (`terminal.ts:102-111`). After `cwd` ends with `/project`, `cd` accepts any name and does not normalize `..` (`terminal.ts:93-99`). `cat` and `python` match on the basename (`terminal.ts:118`, `terminal-view.tsx:51`), and `python` runs `file.content`, not the editor draft, so edits newer than the 800ms flush (`editor-view.tsx:29-32`) are skipped. `git status` prints staged ids (`terminal.ts:134`).

16. Deleting a file leaves its id in `git.staged` (`store.ts:389-414`). Commit ids come from `Math.random()` (`store.ts:456`). Clone writes the repo name into Python source with no escaping (`store.ts:480`).

17. The analyzer over-claims. N+1 fires when a `for`, `.objects.all(`, and `.author.` appear anywhere, and the reported line is the first loop (`analyze.ts:57-65`). SQL misses string concatenation and `.format` (`analyze.ts:11-14`). XSS misses `insertAdjacentHTML`, `outerHTML`, and `document.write` (`analyze.ts:25`). The type-hint rule only matches a one-line `def` (`analyze.ts:45-46`). Debug (`hub.tsx:373`) and Review (`analysis-view.tsx:14`) duplicate it.

18. The Python runner always exits 0. It regex-scans `print` (`runtime.ts:57-65`), splits on commas inside strings (`runtime.ts:71`), and if the text contains `class NeuralCore` it prints canned JSON (`runtime.ts:53-56`) that is not a run of `process_input`. JavaScript has no time limit (`runtime.ts:25`), so `while (true)` freezes the tab. Output is global and is not cleared in `openFile` (`editor-view.tsx:153`, `store.ts:331`), so the last program's stdout sits under the next file.

19. Chat keys are `timestamp + role + 12 characters` (`hub.tsx:100`). The create-file regex (`store.ts:560`) writes the model reply, after a single fence strip (`store.ts:578`), onto the project root (`store.ts:577`), not `src`. A closing fence followed by a newline is left in the file.

20. Only the first two armed packs are injected, by array order (`store.ts:178`). New packs are prepended (`store.ts:491`), so two armed notes silently drop `Review_Doctrine`. The pane never says which packs were actually sent (`hub.tsx:187`).

21. New built-in personas will hydration-mismatch. The client merges them at import time (`store.ts:643-647`). The server does not. `bootPersistence` then spreads saved state (`store.ts:217`).

22. The template sheet is `z-30` (`editor-view.tsx:161`) and the mobile tab bar is `z-40` (`shell.tsx:73`), so the bar covers the sheet.

## UX

23. Mark the simulations as simulations in the UI, not only in a log line. Bridge connect is an 800ms timeout (`store.ts:520-524`). Swarm is a coin flip (`store.ts:498`) while seven agent cards imply a real system (`hub.tsx:353-358`). Vision states that it does not render (`hub.tsx:154`), then sends the result to another pane. Git stores commit messages, not file contents (`store.ts:452-457`). The app title is "Crimson OS" (`__root.tsx:6`) and the hub title is "ToolNeuron" (`hub.tsx:46`).

24. The editor is a textarea. Tab does not indent. There is no highlighting, find, or per-file output. Preview treats every language as HTML (`editor-view.tsx:100`, `editor-view.tsx:320-322`). The gutter and the textarea share `leading-6`, and the gutter does not wrap, so long lines desync the numbers (`editor-view.tsx:78-95`).

25. Chat has no stop, no retry, and no abort signal. Errors are rendered as persona prose (`store.ts:602`, `hub.tsx:102`). Suggestion chips send on click (`hub.tsx:115`). `Rich` only handles fences and `**bold**` (`rich.tsx:2-26`), so one unmatched fence swallows the rest of the answer. "Hear them" asks about the open file and never sends it (`persona-forge.tsx:121-131`).

26. The flash/precise control is shorter than the 44px targets used elsewhere (`shell.tsx:151`). Tree icon buttons are `h-9 w-9` (`editor-view.tsx:271`). The chat field has no `<label>` (`hub.tsx:130`). The template dialog has no focus trap (`editor-view.tsx:160`). Rename saves on blur and ignores Escape (`editor-view.tsx:237-246`).

27. Theme is `documentElement.dataset.theme` (`shell.tsx:43`). Dayglass needs real tokens and a contrast pass. `theme-color` stays crimson (`__root.tsx:14`).

## Missing features

28. Export writes `{files, personalities, chat}` only (`settings-view.tsx:40`), and there is no import. Include packs, notes, and git, or label the file partial.

29. `createItem` supports folders (`store.ts:355`). The tree only offers a new file (`editor-view.tsx:270-273`). Nothing uploads bytes into the project. Core ingest stores names only (`storage-view.tsx:15-27`).

30. One `draft` (`store.ts:29`) means one open file. Review cannot diff against a commit because commits do not snapshot content.

31. Aegis promises a secret check (`seed.ts:138`). Nothing flags keys before `systemPrompt` uploads the draft (`store.ts:184`).

32. The header dot is the fake bridge (`shell.tsx:159-162`), not whether a key is configured. A failed chat is the first sign the key is missing (`ai.functions.ts:20-21`).

33. `package.json:19` does not test `analyze.ts`, `runtime.ts`, or `terminal.ts`. Those three are pure functions and hold most of the bugs above.

## Code quality

34. `OsState` (`store.ts:20-87`) mixes the persisted document with session fields (`busy`, `swarmHot`, `vaultUnlocked`, `output`) and runs side effects at import (`store.ts:643`). Split those.

35. `fresh()` is both the initial state and the reset payload (`store.ts:95`, `store.ts:268`, `store.ts:639`), and persona merge exists twice (`store.ts:208-216` and `store.ts:643-647`). Use one `hydrate`.

36. A non-array `messages` throws inside the server function (`ai.functions.ts:5`) instead of returning `{ok:false}`.

37. The doctrine pack (`store.ts:142-143`) and `analyzeSource` (`analyze.ts:11-54`) can drift. The suggested SQL fix is SQLite-style (`analyze.ts:21`) while the sample calls `db.execute` (`seed.ts:73`).

38. The `termux` tab is the bridge (`types.ts:6`, `shell.tsx:28`). Pick one user-facing name before it becomes the OpenRouter `X-Title`.

39. Opening a file sets `savedAt` (`store.ts:346`), so "saved" (`editor-view.tsx:48`) does not mean the draft changed. The 800ms autosave (`editor-view.tsx:29-32`) is the real write.
