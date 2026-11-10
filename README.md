# ToolNeuron

A mobile-first AI IDE that runs in the browser. Pick one of 12 chat modes,
work on project files in a CodeMirror editor, run JavaScript and Python in a
sandbox, and have a swarm of reviewers check your code. Chat goes through
OpenRouter or OmniRoute (or xAI); keys stay on the server.

Started as a Grok app-builder export and was made functional from there. The
`reviews/` folder holds the reviews from Grok Build, Kimi Code and Antigravity
that shaped the work, plus the design notes for the swarm and the skills.

## What is in it

- **Modes.** Architect, Syntax-Prime, Vanguard, Aegis, HackMentor, Data
  Analyst, Scribe, Quartermaster, Cartographer, Nightwatch, Lattice and
  Oracle. Each has a persona and 3-4 skill cards; each message gets the 1-2
  skills that match it, shown under the reply. Make your own in Persona Forge.
- **Handoff notes.** *Hand off* on any reply saves it as `handoff.md`; every
  later message in any mode gets it until you *Clear* it. Edit it like any file.
- **Chat.** Streams, with Stop. Replies say which mode wrote them, flag a cut
  at the token limit (with *Continue*), and say when a fallback provider
  answered.
- **Code.** Sandboxed JavaScript (iframe + worker, 3 s limit) and Python
  (Pyodide, 10 s limit), a CodeMirror editor and a static analyzer.
- **Terminal.** Built-in commands on the project files (`ls`, `cd`, `cat`,
  `python`, `node`, `ai`, `git`, `gh repo clone`). It is not a shell: other
  commands are refused.
- **Git, for real, in the browser.** `git init/status/add/commit/log/diff/
  show/restore` and `git checkout <commit> -- <path>` work on real snapshots
  (content-addressed blobs, an index, up to 50 commits). One branch, no
  remote: push and pull are not available. The editor's Git tab shows the
  same status and diffs.
- **Clone public GitHub repos.** `gh repo clone owner/name` downloads the
  repo's archive on the server and copies its text files into the project
  (up to 300 files / 1 MB; binaries and `node_modules`-style folders are left
  out). It is a copy with no link back. Private repos need sign-in, which is
  not built.
- **Knowledge packs (Database).** Upload text files (up to 120K characters
  each); each chat message gets the sections that match it (keyword search),
  not just the start of the file.
- **Swarm review.** Three reviewers across providers; findings must quote the
  code; fixes go through a guard and the sandbox before you apply them.
- **Vault.** Encrypted notes: AES-256-GCM, key wrapped by a passphrase
  (PBKDF2, 600k rounds) and optionally a passkey (WebAuthn PRF).

Files, chat and settings stay in the browser (localStorage). Only chat,
review and the terminal's `ai` command call the AI, and only when you send.

## Run it

Node 22 or newer.

```sh
npm install
cp .env.example .env      # then fill in at least one provider key and APP_ACCESS_KEY
npm run dev:vm            # http://127.0.0.1:8095 (local only)
```

`npm run dev` listens on `0.0.0.0:8080` instead. To use a server copy from a
phone, keep it on 127.0.0.1 and tunnel:
`ssh -L 8095:127.0.0.1:8095 you@your-server`, then open
`http://localhost:8095`. Use `localhost`, not `127.0.0.1`: passkeys refuse IP
addresses.

The AI stays locked until you enter `APP_ACCESS_KEY` (header lock button).
Requests are rate limited (`AI_RATE_PER_MIN`, `AI_DAILY_CAP`) and must come
from the same site.

## Providers and models

Set in `.env`; see `.env.example` and the header of
`src/lib/crimson/providers.server.ts` for every option.

| Setting | What it does |
|---|---|
| `AI_PROVIDER` | Default provider: `openrouter`, `omniroute` or `xai` (the header picker overrides it) |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_MODEL_FAST` | OpenRouter key and models |
| `OMNIROUTE_BASE_URL`, `OMNIROUTE_API_KEY`, `OMNIROUTE_MODEL` | OmniRoute gateway and model (e.g. `auto/coding:free`) |
| `AI_MAX_TOKENS_FAST`, `AI_MAX_TOKENS` | Reply caps for Flash / Precise (default 420 / 900) |
| `OPENROUTER_REASONING_EFFORT`, `OMNIROUTE_REASONING_EFFORT` | `low` / `medium` / `high`: keeps a reasoning model's thinking short |
| `AI_FALLBACK` | `off` stops chat from trying the other providers when the chosen one fails before answering |
| `CLONE_PER_MIN` | Clones allowed per client per minute (default 4) |

**Free models.** Most free models are reasoning models: they think before
answering, and the thinking counts against the reply cap. With the default
caps they often return nothing. What worked in testing (November 2026):

```sh
OPENROUTER_MODEL=nvidia/nemotron-3-ultra-550b-a55b:free
OPENROUTER_REASONING_EFFORT=low
AI_MAX_TOKENS_FAST=1500
AI_MAX_TOKENS=3000
```

`openrouter/free` picks a random free model per request, and some of those
spend a 3,000-token budget thinking; `cohere/north-mini-code:free` came back
empty about half the time. Free tiers also hit daily limits; fallback covers
that when a second provider is configured.

## Tests

```sh
npm test             # everything below except the browser tests
npm run test:app     # app unit tests (node --test, TypeScript via strip-types)
npm run test:scripts  # the Grok build-script tests
npm run test:e2e     # browser tests: needs `npm run dev:vm` running and
                     # `npx playwright install chromium` once
```

The browser tests fake the AI by answering `/api/chat` inside the page, so
they need no key and cost nothing. They check what the app sends (system
prompt, history, handoff note, files) and how it shows replies. They do not
check what a real model says. `BASE_URL` overrides the default
`http://localhost:8095`.

## Layout

| Path | What |
|---|---|
| `src/lib/crimson/store.ts` | App state (zustand): chat, files, swarm, terminal, saving |
| `src/lib/crimson/prompt.ts` | What the AI is sent: system prompts, history, save upgrades (pure, tested) |
| `src/lib/crimson/handoff.ts` | Handoff note format, pinning, history labels (pure, tested) |
| `src/lib/crimson/skills/catalog.ts` | The 38 skill cards and which modes use them |
| `src/lib/crimson/chat-input.ts` | Request validation and the provider request body |
| `src/routes/api/chat.ts` | Streaming chat endpoint, provider fallback |
| `src/lib/crimson/providers.server.ts` | Provider config from env |
| `src/lib/crimson/access.server.ts` | Access key, cookie, rate limits |
| `src/lib/crimson/runtime.ts`, `python-runtime.ts` | JavaScript and Pyodide sandboxes |
| `src/lib/crimson/git.ts` | Version history: blobs, index, commits, status, diff (pure, tested) |
| `src/lib/crimson/knowledge.ts` | Knowledge-pack sections and search (pure, tested) |
| `src/lib/crimson/tar.ts`, `src/routes/api/clone.ts` | Reading GitHub archives; the clone endpoint |
| `src/lib/crimson/swarm/` | Swarm review protocol and engine |
| `src/lib/crimson/vault/` | Vault crypto, passkeys, storage |
| `src/components/crimson/` | The UI |
| `e2e/` | Browser tests |
| `.grok/`, `scripts/grok-*` | Grok app-builder files from the original export |

## Credits

Skill cards condense skills from
[sickn33/agentic-awesome-skills](https://github.com/sickn33/agentic-awesome-skills)
(content CC BY 4.0; skills from other repos MIT, named per card). They are
rewritten summaries, not copies; each mode's skills and their sources are
listed in the app under Config, Skills by mode, and the mapping is explained
in `reviews/skills-by-mode.md`.
