# Review round, 2026-11-11: consensus

Reviewers: Grok Build (grok-4.7, xhigh), Kimi Code (K3.1 Pro), Antigravity (Claude Opus 4.6 Thinking for round 1; Gemini 3.8 Flash High for round 2 after the Opus quota ran out). Two rounds, read-only, on commit 6288cf8. Claude verified findings by reproduction (claude-evidence.md) and proposed the fix plan (claude-plan-proposed.md).

## Agreed by all three
- **E1 is the ship blocker.** Pull, merge, then push reverted a file on GitHub that the browser never held (reproduced live). Gate: a live repeat of E1 must leave GitHub's version intact.
- **Pull = one snapshot commit** from the tip tree (diff base and tip trees on the server; sizes known before download; streamed caps; one deadline tied to cancellation). Per-commit replay goes.
- **Push names the tree parent** of a merge commit; the server stops assuming `parents[0]` for `base_tree`. Pick the parent whose GitHub-known history covers the other's. If both cover each other, prefer one already on GitHub, otherwise the first. If neither covers, refuse.
- **Per-branch remote tips** (`remote.tips`) for `expectSha` and the pull base. Moving a GitHub branch to an existing commit needs its own server path, a non-forced ref update (today an empty push is rejected).
- **Untracked files** block switch, merge and pull when they would be written or deleted.
- **Pin GitHub operations** to the repo, branch and HEAD they started on; drop stale results.
- **Repo allowlist** (`GITHUB_REPOS`), failing closed for anything that uses the token; token modes only `100644`/`100755`; `X-Forwarded-For` only behind a trusted proxy; evict instead of clearing rate-limit maps; real errors instead of "cross-site".
- **Match git on adjacent-line edits** (report a conflict).
- **IndexedDB for blobs and the commit graph together**, not blobs alone.
- Full 14-char commit ids; empty-draft fix; whole-prompt budget with a truncation marker; stream reader requires `ok` and `done`; path validation; import validation; clone refuses during a merge and commits only the cloned paths.

## Settled by majority or by the safest rule
- **Unrepresentable remote file (binary, >200 KB) that the browser holds:** if this branch has not changed it since the sync base, drop it locally with a notice. If it has, refuse the pull and name the file (Grok). Do not offer "keep ours" (Kimi and Grok: that brings E1 back). Kimi's tombstone idea becomes unnecessary under this rule, because a dropped file can't be part of a local merge.
- **Trimming:** stop now. A missing merge base is an error, never an empty base, and a commit that will not fit is refused (Grok). Full retention comes with the IndexedDB move (Antigravity's ordering concern is handled by "refuse, do not drop").
- **A model that thinks its whole budget away:** show the error and do not fall back (Grok, Antigravity; Kimi dissents).
- **Failed final ref update:** return the created shas anyway, store them without moving `tips`; accept orphans if the reply is lost (Grok; the others say "orphans are harmless").
- **Conflict-marker check:** accept both formats the app emits (the three-marker block and the two-marker delete/edit notice) (Kimi's caveat on Antigravity's fix).

## Order
1. Allowlist with fail-closed token use, plus modes (while the token has `repo` scope).
2. P4 + P1 + P2 + P3 + P7 + "no empty merge base", as one change, with the live E1, E3 and E4 regression tests.
3. Untracked-file guard (P5).
4. IndexedDB for graph and blobs, then full history retention (P6).
5. The rest of P8 and P9.
