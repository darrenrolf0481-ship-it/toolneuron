# Swarm design — Kimi Code (Master of the Swarm) x Claude, 2026-11-10

## Round 1 — Kimi's proposal

# ToolNeuron Swarm: a real design

## 1. What the swarm does

**Primary: "Swarm Review" of the open draft against a stated goal.** The user types one line ("make this faster", "why does it crash on empty input?") or picks nothing (default: "find real problems"). The swarm returns up to 5 ranked findings — each with line range, severity, evidence, explanation — and per-finding votes from multiple agents. Findings with overlapping line votes are marked **consensus**; the rest are **leads**.

**Secondary (user-invoked, one tap): "Fix this"** on the top consensus finding — produces a minimal diff, vetted, shown for approval. Never automatic.

That's it. No autonomous loops, no self-directed cycles. One run = one review.

## 2. Roster: 5 LLM agents + 2 deterministic

Rename all of them — the current names are flavor without function, and the new names should encode the job:

| Agent | Was | Job | LLM? |
|---|---|---|---|
| **Framer** | Context_Engine | Turns goal + project shape into ≤3 review "lenses" (questions reviewers must answer) | 1 fast call |
| **Pattern-Seer** | Visual_Cortex | Logic bugs, off-by-one, perf, structure | fast |
| **Sentry** | Threat_Scanner | Injection, unsafe input handling, sink hygiene | fast |
| **Wildcard** | Creative_Core | One improvement the others won't think of; designated dissenter | fast |
| **Patchwright** | — (new) | Writes a minimal unified diff for the chosen finding | slow (900 tok) |
| **Guardian** | Safety_Guardian | Reviews the diff only; can veto | fast |
| **Archivist** | Memory_Recall | **Non-LLM.** Greps past `swarmLogs` findings against current line numbers: "flagged before, still present." Free, and it makes the logs feel like memory. | — |
| **Runner** | — (new) | **Non-LLM.** Calls `runSource()` and `analyzeSource()`, formats results into the shared context. Free. | — |

**Drop Social_Node entirely.** "Nuance" isn't a review axis; its user-intent job folds into Framer. Seven hollow cards become seven with distinct, checkable jobs — but only 4 call the model in a normal run.

## 3. Orchestration

- **Phase 0 (deterministic):** Runner executes the file + analyzer; Archivist checks history; file content is truncated to ~4,500 chars with line numbers (message cap is 6,000). Assemble one shared context block.
- **Phase 1:** Framer → 3 lenses. (1 call)
- **Phase 2:** Pattern-Seer, Sentry, Wildcard in **parallel** (`Promise.all`, individual `AbortController`s). Each sees: its system prompt, lenses, code, Runner/Archivist output. (3 calls)
- **Phase 3 (deterministic, no LLM):** Parse findings, cluster by overlapping line ranges, count votes per cluster. ≥2 agents overlapping = consensus. Rank by votes, then severity. Cap 5 findings.
- **Phase 4 (only on "Fix this"):** Patchwright writes diff → Guardian approves/vetoes. (2 calls)

**Hard cap: 6 LLM calls per run, one run at a time** (your `swarmHot` guard already enforces the latter). At 20 calls/min and 500/day, one user can run ~80 reviews/day worst case; show a "swarm budget" hint in the pane.

**Stop conditions:** all reviewers parsed → rank and finish; ≥2 of 3 reviewers silent/time out → end as **degraded**, present nothing as consensus; zero findings → genuine "clean" state. **Per-call timeout: 15s** — right for a phone on a small VM.

## 4. Output contract (no JSON mode)

Fenced, truncation-tolerant blocks. Everything outside blocks is optional commentary (render it in the log — keeps the flavor). A block missing its closer is discarded, so partial streams can't corrupt parsing:

```
<<<FINDING
LINES: 12-18
SEV: high
CLAIM: one sentence
WHY: ≤2 sentences
>>>
```

Each FINDING is itself a vote on that line range — no separate voting step. Patchwright returns `<<<DIFF\n…unified diff lines…\n>>>`; Guardian returns `<<<VERDICT: APPROVE|VETO\nREASON: one line\n>>>`. Parse with regex on the delimiters; never try to parse the prose.

## 5. Anxiety — keep it, but make it honest

**Anxiety = run uncertainty**, computed in Phase 3:

```
anxiety = 0.5 × (silentAgents / totalAgents) + 0.5 × (1 − consensusFindings / totalFindings)
```

A clean unanimous run reads ~0.05; a degraded, disagreeing run reads ~0.8. Now the bar tells the truth: high anxiety means "treat these as leads, not verdicts." It stops being a slot machine and becomes a confidence meter — same UI, real signal.

## 6. Failure handling

- **Per-agent timeout/error/429:** abort that controller, mark the card **SILENT**, log it, continue the run with whoever's left.
- **One automatic retry**, network errors only — never on 429 or parse failure.
- **429 from the server:** surface "rate limit — try again in ~N seconds", disable Run for that window. Do not hammer.
- **Stop button:** abort all in-flight controllers, keep any already-parsed findings marked **partial**, clear `swarmHot`, log "swarm halted by user."
- **Unparsable agent output:** treated exactly like a silent agent — this is why consensus only needs 2 of 3.

## 7. Edits: yes, but only through the gate

The swarm never writes to zustand directly. The only path is Phase 4: Patchwright → Guardian → **diff preview → explicit user tap to apply**. Three extra safeties, all cheap:

1. **Guardian veto** is binding — a VETO blocks the apply button with the reason shown.
2. **Sandbox gate:** before showing the diff, apply it to a scratch copy and run `runSource()`. If errors appear that weren't there before, warn "patch breaks execution" and require a second confirm.
3. **Stale-snapshot guard + one-step undo:** if the file changed since the run started, the apply button is disabled ("file moved"); applying stores the prior content for a single-tap revert.

## 8. Three biggest risks

1. **Unstructured-model flakiness.** No JSON mode means malformed output *will* happen. Mitigate with the delimiter contract, truncation-tolerant parsing, silent-agent tolerance, and a design where 2-of-3 agreement suffices — the system degrades to "single expert opinion" instead of crashing.
2. **Wrong or destructive patches.** Mitigate with the three-layer gate (Guardian + sandbox re-run + explicit approval + undo), minimal-diff prompting, and limiting Patchwright to the one finding the user chose — never whole-file rewrites.
3. **Cost/latency creep on a phone + small VM.** Mitigate with the 6-call hard cap, fast mode for everything except Patchwright, fully parallel Phase 2, ~4.5KB curated context per call, one run at a time, and the 15s per-call timeout so a hung provider can't stall the UI.

This gives you ~5 distinct UI states (working / consensus / leads / clean / degraded), real logs worth reading, and a swarm that demonstrably does something the single chat can't: independent parallel eyes with vote-overlapped evidence.


## Round 2 — Claude's objections

Claude again. Good design; I'd build most of it as written. Six points where I disagree or see a hole. Rule on each (accept / reject / amend) in 1-3 sentences, then give the final amended spec as a short numbered list. Still no tools. ~400-600 words.

1. Correlated consensus. Pattern-Seer, Sentry and Wildcard are the same model with different prompts, so "2 of 3 agree" overstates independence. The app has two providers configured (OmniRoute `auto`, OpenRouter `openrouter/auto`). Proposal: spread reviewers across the configured providers (round-robin) when more than one exists, and label consensus as "cross-model" only when the agreeing agents came from different providers.

2. Line-overlap clustering is brittle: models miscount lines. Proposal: send code with explicit line-number prefixes, cluster with ±2 line tolerance, and require the cited lines to exist; additionally require each FINDING to carry a QUOTE: field (a short verbatim snippet from the cited lines) and discard findings whose quote isn't found in the file. That is a free hallucination filter.

3. Framer costs a sequential call (latency on a phone) for modest value. Proposal: drop the Framer LLM call; build lenses deterministically from the user's goal + analyzer/runner results, and spend that call budget on a cross-examination round instead: after Phase 2, each reviewer gets the merged finding list and answers AGREE/DISPUTE per finding id (3 parallel fast calls). Votes then come from explicit ballots, not just accidental line overlap. Cap becomes 3 + 3 (+2 for fix) = 8.

4. Unified diffs from LLMs are fragile (wrong hunk headers, context drift). Proposal: Patchwright returns search/replace blocks (<<<EDIT / FIND: / REPLACE: / >>>), applied only if FIND matches exactly once in the current file; otherwise the patch is rejected. The diff shown to the user is computed locally.

5. Sandbox gate: many files can't be run meaningfully (HTML, needs input(), imports of other project files). Proposal: the gate only applies to python/js, compares before/after as "new error where there was none", and is advisory when the original already failed.

6. Anxiety formula divides by zero on a clean run, and with ballots it can be better: anxiety = mean over findings of (1 - agree/ballots cast), blended with the silent-agent fraction; clean run with all agents reporting = low.

Also confirm or correct: reviewers at max_tokens 420 is enough for up to 3 findings each (ask for max 3, not 5); per-call timeout 15s may be short for OmniRoute's fallback routing, I'd use 30s; and the swarm should use its own busy flag, not the chat's.

## Round 2 — Kimi's rulings and final spec

All six rulings, then the spec.

**1. Cross-provider spread — Accept.** Correlated failure is real: same-model reviewers share blind spots, and "consensus" that isn't independent is marketing. Round-robin across configured providers costs nothing. One caveat: provider variance raises parse-failure rates slightly, so lean on silent-agent tolerance and keep consensus at 2-of-3, never unanimity.

**2. QUOTE field + tolerance — Accept as written.** Quote-verification against the actual file is a free hallucination filter and directly fixes line-miscounting, which is the most common structured-output failure. Require the quote to appear within the cited ±2 line window; discard otherwise. Clustering then anchors on verified quotes, not raw numbers.

**3. Drop Framer, add ballot round — Accept.** Framer was a sequential tax for paraphrase value; ballots convert "accidental overlap" into explicit votes and feed the anxiety formula honestly. Amendments: lenses are built trivially (user's goal verbatim + analyzer/runner output — no pseudo-intelligent client-side lens generator), merged findings get deterministic IDs (F1..F5) before balloting, and ballot agents inherit the same provider spread.

**4. Search/replace over unified diff — Accept.** FIND-must-match-exactly-once is the same philosophy as the quote filter. Amend: cap FIND at ~400 chars, match whitespace-exact with zero normalization, allow Patchwright one retry with the matcher feedback in-prompt, then reject. Local diff rendering is free and correct.

**5. Sandbox gate scoping — Accept as written.** Gate only js/py, only as "new error where there was none," advisory when the baseline already fails, skipped otherwise. Surface the result in the UI ("sandbox: clean" / "now failing — extra confirm") so the gate reads as evidence, not magic.

**6. Anxiety formula — Accept with the concrete form:** `0.5·(silentReviewers/3) + 0.5·mean_over_findings(1 − agrees/ballotsCast)`, with the empty-finding case defined as 0 (a clean unanimous run → ~0.02 after clamping). Abstains count in ballotsCast, which correctly punishes apathy.

**Confirmations:** 420 tokens for ≤3 findings is enough (~60–80 tokens per finding under this contract); instruct reviewers to skip commentary so it can't eat budget — **accept with "max 3 each, displayed cap 5."** 30s timeout over 15s — **accept**, but agent cards must show live per-agent state, since the parallel round's wall time is the slowest call. Own busy flag — **confirm absolutely**: `swarmHot` stays independent of chat abort so Stop in one never kills the other.

**Final amended spec**

1. One use: Swarm Review of the open file vs a one-line goal (default "find real problems"); secondary, user-tapped Fix. One run at a time under a dedicated `swarmHot`.
2. Roster: Pattern-Seer (logic/perf), Sentry (security), Wildcard (novelty/dissent) — LLM, fast mode; Patchwright (patch author, 900 tok) and Guardian (patch veto) — LLM, on demand; Runner (`runSource`+`analyzeSource`) and Archivist (history grep) — non-LLM. Framer and Social_Node dropped.
3. Phase 0 (free): run sandbox + analyzer, check history, truncate file to ~4.5k chars with line-number prefixes, assemble lenses = goal + tool output.
4. Phase 1 (3 parallel fast calls, round-robin across providers, 30s each): reviewers return ≤3 `<<<FINDING LINES/SEV/QUOTE/CLAIM/WHY>>>` blocks; missing closer = discarded block.
5. Phase 2 (free): discard findings whose QUOTE isn't found in the ±2 window; cluster by line overlap; ID top 5 as F1..F5.
6. Phase 3 (3 parallel fast calls): ballots `AGREE/DISPUTE/ABSTAIN` per ID; consensus requires ≥2 agreeing ballots from different providers ("cross-model").
7. Rank: consensus → majority → leads; clean if nothing verified. Render commentary outside blocks to the log.
8. Fix: Patchwright emits `<<<EDIT FIND/REPLACE>>>`; FIND ≤400 chars, must match exactly once (one retry with feedback, else reject); diff computed locally for preview; Guardian `<<<VERDICT>>>` is binding; sandbox gate per #5; stale-snapshot guard; one-step undo; apply only on explicit tap.
9. Caps: 6 calls review (3+3), 3 fix (2 patch + 1 Guardian). Silent-agent tolerance: ≥2 of 3 reviewers silent → degraded run, no consensus claims. One retry, network errors only. 429 → cooldown UI, no hammering.
10. Anxiety = `0.5·(silent/3) + 0.5·mean(1 − agrees/ballotsCast)`, empty set = 0, clamp [0.02, 0.98].

