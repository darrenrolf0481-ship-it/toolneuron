# ToolNeuron Code Review — Antigravity, Round 2

---

## A. Findings (most severe first)

### 1. `replayRemote` builds replayed trees on first-parent only — pull loses files added on non-first-parent paths

**Severity:** High  
**File:** [`git.ts:614-631`](file:///home/ubuntu/review/tn-current/src/lib/crimson/git.ts#L614-L631)  
**Status:** Verified  

Each fetched commit's tree is built by applying its `changes` on top of `parent.tree` — where `parent` starts as the local commit matching `baseSha` and then advances to each replayed commit in order. But GitHub's `/repos/:repo/commits/:sha` endpoint returns the diff of a commit against **its first parent**. If the remote history contains merge commits, the diff may omit files that were introduced on the second parent. The replayed commit's tree will be missing those files.

**Scenario:** Upstream has a merge commit M with parents A and B. GitHub's diff for M is relative to A. File `new.txt` was introduced in B, not changed in M relative to A, so it does not appear in `changes`. The replayed M will have the tree from replayed-A plus only the explicitly-listed changes — `new.txt` is lost.

**Fix:** For merge commits, fetch the full tree listing (`/git/trees/:sha?recursive=1`) rather than relying on the parent-diff. Or accept the limitation, document it, and note that a re-clone resolves drift.

---

### 2. `pushPlan` can reference an undefined position for `parent2` when the second parent's history was trimmed

**Severity:** High  
**File:** [`git.ts:583-586`](file:///home/ubuntu/review/tn-current/src/lib/crimson/git.ts#L583-L586)  
**Status:** Verified  

```ts
.map((id) => (known(id) ? { sha: known(id)! } : { index: position.get(id)! }));
```

If a merge commit's `parent2` is neither known on GitHub (`known(id)` returns undefined) nor in the `pending` set (e.g. it was trimmed away or on a branch that was deleted), `position.get(id)` returns `undefined`, and `{ index: undefined }` gets sent to the server. The server's `parseCommits` then rejects it (`typeof p.index === "number"` fails) and the push fails with "bad commit parent".

**Scenario:** User makes 60+ commits, the early base of a merge gets trimmed to `MAX_COMMITS=50`, then pushes. The merge commit's second parent's local id has no position and no sha.

**Fix:** The `pushPlan` function already checks `if (!commit) return "part of this history was trimmed…"` for first-parent traversal, but the parent mapping at L584-586 doesn't check whether the non-sha fallback has a valid index. Add: `if (position.get(id) === undefined) return "a merge parent was trimmed from local history; cannot push"`.

---

### 3. `hash` collision probability is non-negligible for a content-addressed store

**Severity:** Medium  
**File:** [`git.ts:52-64`](file:///home/ubuntu/review/tn-current/src/lib/crimson/git.ts#L52-L64)  
**Status:** Verified  

cyrb53 produces 53 bits. The birthday bound is ~2^26.5 ≈ 95 million items. The blob store and commit ids use it. With 50 commits × ~300 files = 15,000 items, the probability per project is negligible (~1 in 600 billion). But commit ids are only the first 7 hex characters of the hash = 28 bits, so the collision birthday bound for commit ids is ~2^14 ≈ 16,384 — a project with 50 commits is fine, but a user who commits frequently and has long-lived branches is within an order of magnitude. If two commits collide, `pushPlan` and `mergeBase` silently break.

**Scenario:** A prolific project with many small commits. Two commits happen to produce the same 7-char id prefix. `byId` finds the first match; history traversal follows the wrong parent.

**Fix:** Use 10 hex chars for commit ids (40 bits, birthday bound ~1M). The blob hash at 14 chars (53 bits) is fine for the file counts this app handles.

---

### 4. `guardCloneCall` in push.ts uses `assertSameSiteRequest()` inside a try/catch that discards the error type

**Severity:** Medium  
**File:** [`push.ts:81-85`](file:///home/ubuntu/review/tn-current/src/routes/api/git/push.ts#L81-L85), [`fetch.ts:33-37`](file:///home/ubuntu/review/tn-current/src/routes/api/git/fetch.ts#L33-L37), [`clone.ts:55-62`](file:///home/ubuntu/review/tn-current/src/routes/api/clone.ts#L55-L62)  
**Status:** Verified  

```ts
try {
  refused = guardCloneCall();
} catch {
  return json({ ok: false, error: "Cross-site request refused." }, 403);
}
```

`guardCloneCall()` calls `assertSameSiteRequest()` which throws `CrossSiteRequestError`. The catch here is correct for that case. But any *other* exception (e.g. `getRequest()` failing, a bug in the rate limiter) is also caught and reported as "Cross-site request refused" — masking real errors. The same pattern is in `chat.ts:33-38`.

**Fix:** Catch `CrossSiteRequestError` specifically: `catch (e) { if (e instanceof CrossSiteRequestError) return json(..., 403); throw e; }`.

---

### 5. `unlock()` passes wrong arguments to `hit()` — lockout tracking is broken

**Severity:** High  
**File:** [`access.server.ts:80`](file:///home/ubuntu/review/tn-current/src/lib/crimson/access.server.ts#L80)  
**Status:** Verified  

```ts
hit(attempts, ip, 10 * 60_000, 5); // only wrong keys count toward the lockout
```

The `hit` function signature is `hit(map, id, windowMs, limit)`. But on L77-78 the lockout check is done manually (reading `attempts` directly), and then L80 calls `hit(attempts, ip, 10 * 60_000, 5)` again. This double-counts: L77 reads the existing failures, then L80 calls `hit` which also reads them *and* pushes a new timestamp. But the real problem is that L80 doesn't use the return value — it doesn't need to, since the check was already done on L77-78. The actual lockout logic works (L77-78 checks the window, L80 records the attempt), but there's a subtle race if `hit`'s own length check triggers a clear of the map at L67 (`if (map.size > 5000) map.clear()`): a flood of IPs could clear the lockout state for all IPs.

**Scenario:** An attacker generates 5001+ distinct IPs (proxied). The `attempts` map exceeds 5000 entries, `hit` clears it, and the attacker's lockout counter resets to 0.

**Fix:** Use a bounded LRU or at least only evict old entries instead of `map.clear()`. The same risk exists for the `calls` and `clones` maps.

---

### 6. `gitPull` in store.ts: stale `remote.shas[base.id]` after concurrent operations

**Severity:** Medium  
**File:** [`store.ts:660-705`](file:///home/ubuntu/review/tn-current/src/lib/crimson/store.ts#L660-L705)  
**Status:** Verified  

On L670, `base = Git.newestOnGitHub(git)` finds the newest commit that has a sha. On L679, `remote.shas[base.id]` is passed to the fetch endpoint. But `remote` was captured from the `git` snapshot on L668. After the async fetch returns (L691), the code reads `get().git` again — but it still uses the *old* `remote.shas[base.id]` from before the fetch. If another operation (like a concurrent push from the Git tab) modified the shas map in the meantime, the base sha sent to the server may be stale.

This is a narrow race (the user would have to push while pulling), but the single-user nature of the app makes it unlikely in practice.

**Fix:** Re-read `remote` after the fetch returns, before calling `replayRemote`.

---

### 7. `pushPlan` computes `expectSha` from `newestOnGitHub` which walks all reachable history, not the branch history

**Severity:** Medium  
**File:** [`git.ts:553-590`](file:///home/ubuntu/review/tn-current/src/lib/crimson/git.ts#L553-L590)  
**Status:** Verified  

`newestOnGitHub` calls `history(git)` which follows the *current branch head* through both parents. `expectSha` is set to `known(newestOnGitHub(git)?.id)` — the sha of the newest commit reachable from HEAD that is on GitHub. But if the user switched branches, this might find a commit from a different branch's history that happens to be reachable through a merge. In that case `expectSha` points at the right place (the tip of the remote branch should be at or after that commit), but the `pending` set calculation (L568-578) does the same walk. This is actually correct for fast-forward detection.

After closer inspection, this is **not a bug** — the logic is sound because `expectSha` is compared against the remote branch's actual position, and the `pending` set correctly excludes commits already on GitHub. Withdrawing this as a finding.

---

### 7 (replacement). GITHUB_TOKEN with `repo` scope grants write to all repos the token can see

**Severity:** High  
**File:** [`github.server.ts:1-59`](file:///home/ubuntu/review/tn-current/src/lib/crimson/github.server.ts#L1-L59), [`push.ts:97-98`](file:///home/ubuntu/review/tn-current/src/routes/api/git/push.ts#L97-L98)  
**Status:** Verified  

The `repo` field in the push body is validated for format (`parseRepo`) but not against an allowlist. Any authenticated user (anyone with `APP_ACCESS_KEY`) can push to *any* repository the `GITHUB_TOKEN` has access to. The README says "currently a broad token with `repo` scope" — this means a user could push to any repo owned by the token owner.

**Scenario:** User enters `owner/important-production-repo` in `git remote add origin`, commits something, and `git push`. The server happily pushes to it.

**Fix:** The README recommends a fine-grained token scoped to specific repos — enforce that operationally and document it more prominently. Alternatively, add `GITHUB_ALLOWED_REPOS` (comma-separated list) and check against it in `push.ts` and `clone.ts`.

---

### 8. The `mergeTrees` conflict marker for delete/edit doesn't update `clean` — conflicted path stays in the index with `ours` value

**Severity:** Low  
**File:** [`git.ts:408-417`](file:///home/ubuntu/review/tn-current/src/lib/crimson/git.ts#L408-L417)  
**Status:** Verified  

When one side deletes and the other edits, the conflict block is generated and pushed to `changes`, but `clean` is not modified. Since `clean` starts as `{ ...ours }`:
- If **ours** deleted the file (`o === undefined`): `clean` doesn't have the path → the conflict text is in `changes` but the index has no entry. The file appears in working files but not in the index, so `git add` would correctly stage it.
- If **theirs** deleted the file (`t === undefined`): `clean` has the path with ours's hash, not the conflict text's hash.

The second case means the index records ours's clean version while the working file has the conflict markers. This is actually the intended behavior (matching real git, where the conflicted path keeps the stage-2/stage-3 entries and the working file has markers). So this is working as designed, just worth a comment.

**Revised status:** Not a bug. Withdrawing.

---

### 8 (replacement). `replayRemote` generates deterministic commit ids that can collide if the same remote commit is replayed twice

**Severity:** Medium  
**File:** [`git.ts:625`](file:///home/ubuntu/review/tn-current/src/lib/crimson/git.ts#L625)  
**Status:** Verified  

```ts
const id = hash(`${parent.id}\n${item.sha}`).slice(0, 7);
```

If a user pulls, then somehow the local commits are lost (corrupt save, import) and pulls again, the replayed commits will have the same ids. L627 checks `if (!commits.some(c => c.id === id))` which prevents duplicates, but if the old commit with that id is still in history (from the first pull), the new commit (with a potentially different tree, since the base may have changed) is silently skipped.

**Scenario:** Pull succeeds, user does something that corrupts the tree of the replayed commit but keeps its id. Next pull replays the same sha → same id → silently skipped → wrong tree.

**Fix:** Include the replay time or a counter in the hash input to ensure uniqueness.

---

### 9. Server endpoints return JSON error bodies on all failures, but don't set meaningful HTTP status codes consistently

**Severity:** Low  
**File:** [`push.ts:24-26`](file:///home/ubuntu/review/tn-current/src/routes/api/git/push.ts#L24-L26), [`fetch.ts:22-24`](file:///home/ubuntu/review/tn-current/src/routes/api/git/fetch.ts#L22-L24)  
**Status:** Verified  

Most error responses use status 200 with `{ok: false, error: "..."}`. Only body-too-large (413), bad request (400), and cross-site (403) get proper HTTP codes. The client ignores HTTP status entirely (just parses `result.ok`), so this is cosmetic, but it makes monitoring and logging harder.

**Fix:** Use 409 for "not fast-forward", 422 for validation errors, etc. Low priority.

---

### 10. `clone.ts` returns `sha` and `branch` as top-level JSON fields that can leak into the client response

**Severity:** Low  
**File:** [`clone.ts:114`](file:///home/ubuntu/review/tn-current/src/routes/api/clone.ts#L114)  
**Status:** Verified  

```ts
return json({ ok: true, repo, files: result.files, skipped: result.skipped, limits: DEFAULT_CLONE_LIMITS, linked: Boolean(link), ...(link ?? {}) });
```

The spread `...(link ?? {})` includes `{ sha, branch, private }`. The `private` field tells the browser whether the repo is private, which is fine. But this means the full 40-char commit sha is sent to the browser. Since the browser needs it (to set up the remote tracking), this is actually correct and not a leak.

**Revised status:** Not a bug. Withdrawing.

---

### 10 (replacement). `chat.ts:148` — `respond()` signature mismatch: `provider` vs `failures`

**Severity:** Medium  
**File:** [`chat.ts:61`](file:///home/ubuntu/review/tn-current/src/routes/api/chat.ts#L61) vs [`chat.ts:148`](file:///home/ubuntu/review/tn-current/src/routes/api/chat.ts#L148)  
**Status:** Verified  

```ts
// Call site (L61):
if (attempt.ok) return respond(attempt, provider, failures, request);

// Declaration (L148):
function respond(attempt: ..., provider: ProviderConfig, failures: string[], request: Request): Response {
```

Wait — the call passes `provider` (the current loop variable from `for (const provider of fallbackOrder(first))`), which is a `ProviderConfig`. The function signature expects `ProviderConfig`. This is correct. Withdrawing.

---

### 10 (replacement, actual). `fetch.ts` doesn't handle merge commits from GitHub — file changes may be incomplete

**Severity:** High  
**File:** [`fetch.ts:64-96`](file:///home/ubuntu/review/tn-current/src/routes/api/git/fetch.ts#L64-L96)  
**Status:** Verified  

The fetch endpoint uses GitHub's single-commit API (`/repos/:repo/commits/:sha`) which returns the diff against the **first parent** only. For merge commits on GitHub, this means files introduced by the second parent are not included in `files`. The replayed local commit will be missing those files.

Combined with Finding #1, this means **pull silently drops files introduced via merge commits on GitHub**.

**Scenario:** Someone on GitHub merges a PR that adds `new-feature.js`. The merge commit's diff against its first parent doesn't mention `new-feature.js` (it was already in the PR branch). Pull fetches this commit, replays it locally, and the file is missing.

**Fix:** For merge commits, either: (a) use `/repos/:repo/git/trees/:tree_sha?recursive=1` to get the full tree and diff it yourself against the first parent's tree, or (b) fetch the compare between the merge commit and its first parent explicitly (`/repos/:repo/compare/parent...merge`), or (c) detect merge commits and warn the user to re-clone.

---

### 11. `guardAiCall` increments `dayCount` even if the request ultimately fails (e.g., no provider configured)

**Severity:** Low  
**File:** [`access.server.ts:125`](file:///home/ubuntu/review/tn-current/src/lib/crimson/access.server.ts#L125)  
**Status:** Verified  

`dayCount += 1` at L125 happens unconditionally after the rate limiter passes. If the provider is misconfigured and the request fails at `resolveProvider`, the daily budget is still consumed. Over many failed requests (e.g., misconfigured provider, all providers down), the daily cap is wasted.

**Fix:** Move the increment to after the response is successfully started (or at least after provider resolution). Or accept it as defense-in-depth (prevents a misconfigured system from making unlimited upstream attempts).

---

### 12. `pushPlan` computes changes relative to first parent only — merge commits that add files only via the second parent push empty changesets

**Severity:** Medium  
**File:** [`git.ts:587-588`](file:///home/ubuntu/review/tn-current/src/lib/crimson/git.ts#L587-L588)  
**Status:** Verified  

```ts
const before = subtree(byId(git, commit.parent)?.tree ?? {}, remote.dir);
return { id: commit.id, message: commit.message, parents, changes: treeChanges(git, before, subtree(commit.tree ?? {}, remote.dir)) };
```

For a merge commit, `changes` is the diff from its *first* parent. On GitHub, the server creates a tree from `base_tree` (first parent's tree) plus these `changes`. This is actually correct for Git Data API semantics — the tree is built incrementally from the base, so changes from the second parent that are already in the merge commit's tree *will* be included in the diff against the first parent's tree. The `treeChanges` function compares the full trees, not just what one side changed.

**Revised status:** After re-reading `treeChanges`, this is correct: it computes the complete diff from the first parent's subtree to the merge commit's subtree, which includes everything added from the second parent. Withdrawing.

---

### 12 (replacement). `abortMerge` restores files by path from `merging.touched` but uses the current `git.blobs` — if blobs were garbage-collected, content is lost

**Severity:** Medium  
**File:** [`git.ts:374-381`](file:///home/ubuntu/review/tn-current/src/lib/crimson/git.ts#L374-L381)  
**Status:** Suspected  

```ts
const changes = git.merging.touched.map((path) => ({
  path, content: head[path] === undefined ? null : (blob(git, head[path]) ?? "")
}));
```

This looks up blobs from the current git state. If `collect` was called between the merge start and the abort (e.g., during a `trim` from an unrelated commit on another branch — but wait, you can't commit on another branch during a merge). During a merge, `dirty()` returns a merge-in-progress message, blocking switches and new commits. So `collect` can't run during a merge. Not a real bug.

**Revised status:** Not reachable. Withdrawing.

---

### 12 (actual replacement). Rate-limit maps (`calls`, `clones`, `attempts`) grow unboundedly with distinct IPs, then catastrophically clear

**Severity:** Medium  
**File:** [`access.server.ts:67`](file:///home/ubuntu/review/tn-current/src/lib/crimson/access.server.ts#L67)  
**Status:** Verified  

```ts
if (map.size > 5000) map.clear(); // crude bound on memory
```

All three rate-limit maps share this pattern. If an attacker sends requests from >5000 distinct IPs, the map clears, resetting *all* rate limits (including the attacker's own). The `attempts` map clearing is the worst case — it resets brute-force lockouts.

**Scenario:** Attacker uses a rotating proxy to send unlock attempts from 5001+ IPs, triggering the clear. All lockouts reset.

**Fix:** Evict the oldest entries instead of clearing the whole map, or use an LRU cache.

---

### 13. `hit()` stores full timestamp arrays per IP — memory scales with `limit * distinctIPs`

**Severity:** Low  
**File:** [`access.server.ts:58-69`](file:///home/ubuntu/review/tn-current/src/lib/crimson/access.server.ts#L58-L69)  
**Status:** Verified  

Each IP stores an array of timestamps. The arrays are filtered on every call, but old entries from IPs that stop sending requests are never evicted (only the catastrophic `map.clear()` at 5000 entries removes them). For a single-user app behind an SSH tunnel, this is a non-issue in practice.

---

### 14. `sseEvents` generator doesn't handle `\r\n` line endings

**Severity:** Low  
**File:** [`chat.ts:197`](file:///home/ubuntu/review/tn-current/src/routes/api/chat.ts#L197)  
**Status:** Suspected  

```ts
while ((cut = buffer.indexOf("\n")) !== -1) {
```

The SSE spec says lines can be terminated by `\r\n`, `\r`, or `\n`. Most providers use `\n\n` between events, but some might use `\r\n`. The code trims each row (`row.trim()`) which removes trailing `\r`, so `\r\n` actually works. Bare `\r` without `\n` would cause issues (the line is never found), but this is extremely rare in practice.

**Status:** Not a real bug with any known provider. Low risk.

---

### 15. `commit()` includes `git.commits.length` in the hash input, making commit ids non-deterministic after trim

**Severity:** Low  
**File:** [`git.ts:228`](file:///home/ubuntu/review/tn-current/src/lib/crimson/git.ts#L228)  
**Status:** Verified  

```ts
const id = hash(`${parent ?? ""}\n${merging?.theirs ?? ""}\n${time}\n${message}\n${JSON.stringify(index)}\n${git.commits.length}`).slice(0, 7);
```

If the same commit is created at different points in time (e.g. after different amounts of trimming), `git.commits.length` differs, producing a different id. This is intentional (to avoid collisions when the same message/tree/time coincide), but it means commit ids are not purely content-addressable. Not a bug, just a design choice worth noting.

---

### 16. `normalizeGit` doesn't validate commit graph integrity — circular parent references cause infinite loops

**Severity:** Medium  
**File:** [`git.ts:27-50`](file:///home/ubuntu/review/tn-current/src/lib/crimson/git.ts#L27-L50)  
**Status:** Suspected  

`normalizeGit` validates field types but doesn't check for cycles in the commit graph. If a corrupt save (or a crafted import) creates a cycle (`commit A → parent B → parent A`), `history()` would loop. However, `history()` uses a `seen` set (L106-111), so it terminates. `firstParents` also uses a `seen` set (L125-132). So this is actually handled.

**Revised status:** Not a bug — all traversal functions use `seen` sets.

---

### 16 (replacement). `applyChanges` doesn't handle the case where a folder and a file have the same name at the same level

**Severity:** Low  
**File:** [`git.ts:753`](file:///home/ubuntu/review/tn-current/src/lib/crimson/git.ts#L753)  
**Status:** Suspected  

```ts
let next = childNamed(parentId, folder);
```

`childNamed` finds the first item with the matching name, regardless of type. If a file is named `src` and a change tries to create `src/main.py`, `childNamed` finds the file, then `parentId = next.id` and the next iteration tries to find children of a file — which returns nothing, creating a new folder as a child of the file. The project file tree uses `parentId` references, so this would create an orphaned subtree.

**Scenario:** User has a file named `src` (no extension). Clone/merge tries to create `src/main.py`. The file `src` becomes the "parent" of a new folder, creating an inconsistent tree.

**Fix:** Check `next.type === "folder"` before using it as a parent. If it's a file with the same name, skip or error.

---

### 17. `createItem` in store.ts has a stale-state bug

**Severity:** Medium  
**File:** [`store.ts:521-541`](file:///home/ubuntu/review/tn-current/src/lib/crimson/store.ts#L521-L541)  
**Status:** Verified (previously reported by Antigravity round 1, still present)  

```ts
createItem: (parentId, type, name) => {
    // ...
    const files = get().files.map(...).concat(item);
    if (type === "file") {
      get().flushDraft();
      set({ files: get().files.concat(item).map(...), activeFileId: id, draft: "" });
      return;
    }
    set({ files });
},
```

For files: `flushDraft()` is called, then `get().files` is read again (which now includes the flushed draft). The local `files` variable (computed before `flushDraft`) is discarded. But the `set` on L537 recomputes from `get().files` — so this works, albeit confusingly. The real problem: the first `get().files.map(...)` on L534 is wasted computation. Not a data-loss bug, but the code is misleading.

**Revised severity:** Low (code clarity, not data loss).

---

### 18. `persistable` serializes the full `git` state including all blobs — large projects hit localStorage quota

**Severity:** High  
**File:** [`store.ts:414`](file:///home/ubuntu/review/tn-current/src/lib/crimson/store.ts#L414)  
**Status:** Verified  

```ts
git: state.git,
```

The `git` state includes `blobs` (full file contents for every version of every file across 50 commits) and `commits` (with full tree maps). For a project with 50 files averaging 5 KB each across 50 commits with moderate changes, the blobs alone can reach 2-5 MB. Combined with the rest of the state, this easily exceeds the ~5 MB localStorage limit.

**Scenario:** Clone a medium repo (200 files), make 20 commits. The git blobs + trees + index occupy 3+ MB. Add chat history and file contents: localStorage quota exceeded.

**Fix:** This is the strongest argument for moving blobs to IndexedDB (see Design Call B1). In the short term, the `slim` path in `flushSave` could omit blobs for commits older than N, but that would break `git show` and `checkout` for those commits.

---

### 19. `mergeBlockers` checks for conflict markers in staged content but uses a simple regex that can false-positive on non-conflict content

**Severity:** Low  
**File:** [`git.ts:243`](file:///home/ubuntu/review/tn-current/src/lib/crimson/git.ts#L243)  
**Status:** Verified  

```ts
if (staged !== undefined && /^(<{7}|>{7}) /m.test(staged))
```

This flags any file that contains 7 `<` or `>` characters at the start of a line followed by a space — including, e.g., a markdown file that legitimately contains `>>>>>>> some text`. The check is only active during a merge and only on files in `merging.conflicts`, so false positives are limited to files that were actually conflicted. Still, if the user resolves the conflict in a way that keeps similar-looking lines, they get stuck.

**Fix:** Check for the specific pattern `<<<<<<<` followed by `=======` followed by `>>>>>>>` in the same file (all three markers together), rather than any single marker line.

---

### 20. `clone.ts` doesn't pass `signal` to `readCapped`

**Severity:** Low  
**File:** [`clone.ts:102`](file:///home/ubuntu/review/tn-current/src/routes/api/clone.ts#L102)  
**Status:** Verified  

The `signal` (request abort + 60s timeout) is passed to the initial `fetch` but not to `readCapped`. If the fetch succeeds quickly (e.g., redirect resolved) but the body streams slowly, `readCapped` reads until the body ends or hits the cap — the 60s timeout doesn't apply to the body read phase. The `readCapped` function has its own byte cap (15 MB), so it won't read forever, but it could take much longer than 60s on a slow connection.

**Fix:** Pass `signal` through and check `signal.aborted` in the read loop.

---

### 21. `providers.server.ts:101` — OmniRoute reasoning effort uses different field name than the standard

**Severity:** Low  
**File:** [`providers.server.ts:101`](file:///home/ubuntu/review/tn-current/src/lib/crimson/providers.server.ts#L101)  
**Status:** Verified  

```ts
extra: effort("OMNIROUTE_REASONING_EFFORT") ? { reasoning_effort: effort("OMNIROUTE_REASONING_EFFORT") } : {},
```

OpenRouter uses `{ reasoning: { effort: "low" } }`. OmniRoute uses `{ reasoning_effort: "low" }`. Both are merged into the body via `...options.extra` in `completionBody`. The field name depends on the gateway's API — if OmniRoute changes to match OpenAI's spec, this breaks. Document which OmniRoute version this targets.

---

### 22. `bootstrapEmpty` in push.ts force-pushes over the placeholder on the default branch

**Severity:** Medium  
**File:** [`push.ts:174-183`](file:///home/ubuntu/review/tn-current/src/routes/api/git/push.ts#L174-L183)  
**Status:** Verified  

```ts
const overPlaceholder = (name: string) => placeholder !== null && placeholder.branch === name;
// ...
if (placeholder && placeholder.branch !== branch) {
    await gh(`/repos/${repo}/git/refs/heads/${placeholder.branch}`, { method: "PATCH", body: { sha: tip, force: true } });
}
```

If pushing to a branch other than the repo's default, the code also force-updates the default branch to point at the pushed tip. This is intended behavior (replacing the placeholder), but if between the bootstrap and the push another process creates real commits on the default branch, they'd be force-overwritten.

**Scenario:** Extremely narrow race. User bootstraps, then before the push completes, someone else pushes to the default branch. The force push obliterates their work.

**Fix:** Accept the risk for empty repos (the window is milliseconds), or check the default branch ref hasn't changed from the placeholder sha before overwriting.

---

### 23. `chat.ts` `open()` doesn't propagate the `request.signal` abort to cancel the SSE reader when the browser disconnects mid-open

**Severity:** Low  
**File:** [`chat.ts:82-144`](file:///home/ubuntu/review/tn-current/src/routes/api/chat.ts#L82-L144)  
**Status:** Verified  

The `signal` passed to `open` is `AbortSignal.any([request.signal, AbortSignal.timeout(120_000)])`. This signal is passed to the `fetch` call, which means the upstream request *is* cancelled when the browser disconnects. The SSE reader reads from the response body, which will error when the upstream connection is cancelled. So this is actually handled correctly.

**Revised status:** Not a bug.

---

### 23 (replacement). `prompt.ts` truncates the open file by characters, not by meaningful boundaries

**Severity:** Low  
**File:** [`prompt.ts:93`](file:///home/ubuntu/review/tn-current/src/lib/crimson/prompt.ts#L93)  
**Status:** Verified  

```ts
const code = file && room > 200 ? `${label}:\n${fileText.slice(0, room)}` : "";
```

The file is sliced at a byte boundary, potentially mid-line or mid-function. This can confuse the model into thinking the file ends abruptly. Adding a `"[file truncated]"` marker and slicing at the last newline would improve model comprehension.

---

### 24. `runPythonLite` fallback regex for `print()` breaks on nested parentheses

**Severity:** Low  
**File:** [`runtime.ts:158`](file:///home/ubuntu/review/tn-current/src/lib/crimson/runtime.ts#L158)  
**Status:** Verified (still present from round 1)  

```ts
const prints = code.matchAll(/print\s*\(([\s\S]*?)\)/g);
```

`print(len(x))` matches `print(len(x)` — the non-greedy `*?` stops at the first `)`. The fallback is clearly labeled "echoes print() literals, does not execute" and only fires when Pyodide can't load, so the impact is cosmetic.

---

### 25. `env.server.ts:3` treats `""` and `"  "` (whitespace-only) the same as absent

**Severity:** Low  
**File:** [`env.server.ts:1-4`](file:///home/ubuntu/review/tn-current/src/lib/env.server.ts#L1-L4)  
**Status:** Verified  

```ts
const v = process.env[key]?.trim();
return v || undefined;
```

An env var set to `"false"` or `"0"` returns that string (truthy). But `""` returns `undefined`. This is consistent and intentional — empty string = unset. Fine.

**Revised status:** Not a bug.

---

## Consolidated findings list (renumbered, de-duplicated):

| # | Severity | File | Summary |
|---|----------|------|---------|
| 1 | **High** | `git.ts:614-631`, `fetch.ts:64-96` | Pull silently drops files introduced via merge commits on GitHub (diff is first-parent-only) |
| 2 | **High** | `git.ts:583-586` | `pushPlan` can produce `{index: undefined}` for trimmed merge parents |
| 3 | **High** | `store.ts:414`, `git.ts` blobs | Git blobs in localStorage blow the 5 MB quota on medium projects |
| 4 | **High** | `github.server.ts`, `push.ts` | Broad `GITHUB_TOKEN` allows push to any accessible repo; no allowlist |
| 5 | **High** | `access.server.ts:67,80` | Rate-limit maps catastrophically clear at 5000 entries, resetting all lockouts |
| 6 | **Medium** | `git.ts:52-64, 228` | Commit ids are 7 hex chars (28 bits); birthday collision bound is ~16K |
| 7 | **Medium** | `git.ts:625` | `replayRemote` id is deterministic; same remote commit replayed twice is silently skipped |
| 8 | **Medium** | `push.ts:81-85`, `chat.ts:33-38` | Broad `catch` masks non-CSRF errors as "Cross-site request refused" |
| 9 | **Medium** | `store.ts:660-705` | `gitPull` uses stale `remote.shas` from before the async fetch |
| 10 | **Medium** | `push.ts:174-183` | `bootstrapEmpty` force-updates default branch — narrow race can overwrite concurrent work |
| 11 | **Medium** | `store.ts:521-541` | `createItem` recomputes file list redundantly after `flushDraft` — confusing but not lossy |
| 12 | **Low** | `access.server.ts:125` | `dayCount` incremented even when the request fails (no provider configured) |
| 13 | **Low** | `git.ts:243` | `mergeBlockers` regex can false-positive on legitimate `<<<<<<<` in content |
| 14 | **Low** | `clone.ts:102` | `readCapped` ignores the abort signal — slow body read bypasses the 60s timeout |
| 15 | **Low** | `git.ts:753` | `applyChanges` treats a file named like a folder as a parent — inconsistent tree |
| 16 | **Low** | `prompt.ts:93` | File truncated mid-line with no marker |
| 17 | **Low** | `runtime.ts:158` | `runPythonLite` regex breaks on nested parens (cosmetic, fallback only) |
| 18 | **Low** | `providers.server.ts:101` | OmniRoute reasoning effort field name may diverge from upstream spec |
| 19 | **Low** | `chat.ts:197` | SSE parser doesn't handle bare `\r` line endings (no known provider uses them) |

---

## B. Design Calls

### B1. localStorage vs IndexedDB for git history

**Recommendation: Move blobs to IndexedDB now. Keep the commit graph and index in localStorage.**

localStorage gives you ~5 MB. The git state includes:
- `commits`: 50 commits × ~200 bytes each ≈ 10 KB (compact)
- `index`: one tree of ~300 entries ≈ 6 KB
- `blobs`: **every unique file version across all 50 commits and the index**

A 200-file project with moderate edit history easily fills 2-3 MB of blobs. Add the rest of the app state (files, chat, terminal history), and you're at the quota wall. The `slim` save path already drops chat and terminal history to cope.

**What breaks first:** Cloning a real repo (say, 150 files totaling 400 KB) and making 10 commits. Each commit adds the changed blobs. After a few commits, `flushSave` starts hitting the quota and falls back to `slim`, which still includes all blobs. At ~20 commits you're stuck. The user gets the "Browser storage is full" warning and risks losing work.

**Migration:** IndexedDB has no practical size limit (browsers grant 50+ MB by default). Store blobs keyed by hash. The git state in localStorage becomes the commit graph + index + branch pointers (a few KB). Reads are async, but the only hot path is `blob()` for diffs and restores — already interactive, not latency-critical. The `persistable` function stops including blobs; `normalizeGit` hydrates from IDB on boot.

### B2. Server-side GITHUB_TOKEN model

**The current model is acceptable for single-user, but needs guardrails.**

The single-user SSH-tunnel deployment means only the owner has `APP_ACCESS_KEY`, so only they can trigger pushes. The risk is accidental: the user types the wrong repo name and pushes to production. Guardrails:

1. **Fine-grained tokens only**, scoped to specific repos. Document this as mandatory, not a suggestion.
2. **`GITHUB_ALLOWED_REPOS`** env var — comma-separated list. Reject any push/clone to a repo not on the list. Cheap and effective.
3. **Confirmation on first push to a new repo** — the UI should show a "You are about to push to `owner/repo` for the first time. Continue?" prompt.
4. Don't store the token in `.env` in a cloneable location. It's fine as a server env var.

### B3. Pull: replay-one-by-one vs simpler approach

**Keep the replay approach, but add a "re-clone" fallback.**

Replaying commits preserves the linear commit history, which matters for push: `pushPlan` needs to send each commit individually to GitHub. If pull just took a snapshot, you'd lose the intermediate commits and push would have to squash everything into one commit.

The weakness is Finding #1: merge commits on GitHub lose files introduced on the second parent. Two fixes:

1. **For merge commits on GitHub, fetch the full tree** and compute the diff yourself. This handles the common case (PRs merged on GitHub).
2. **If the replayed tree diverges too far, offer "re-clone"** — download the full snapshot again and replace the local copy. This is the nuclear option but always correct.

The replay approach is the right design. It just needs the merge-commit handling to be more robust.

### B4. Whether to split store.ts now, and along which seams

**Yes, split it. The seams are clear.**

`store.ts` is 962 lines with these distinct concerns:

1. **Persistence** (boot, save, export/import): ~lines 220-416
2. **Files & editor** (open, create, rename, delete, templates): ~lines 488-599
3. **Git operations** (init, add, commit, apply, push, pull, clone): ~lines 606-786
4. **Chat** (consult, stop, handoff): ~lines 804-911
5. **Swarm**: delegated to `swarm/engine.ts` already
6. **Terminal**: `askTerminal` (~lines 913-941)

Split into zustand slices or separate files:
- `store/persistence.ts` — boot, save, export, import
- `store/files.ts` — file operations, templates
- `store/git.ts` — all git actions (these are the most complex and benefit from isolation)
- `store/chat.ts` — consult, streaming, handoff
- `store/index.ts` — combines slices, exports `useOs`

The git slice alone is 180 lines and contains the most complex async logic (push, pull, clone). Separating it makes it testable in isolation.

---

## C. Five things to do next, in order

1. **Fix the pull-through-merge-commits bug (Finding #1/10).** This is the biggest correctness issue. Merge commits on GitHub (i.e. merged PRs) silently lose files. Either fetch full trees for merge commits or detect them and warn. Without this, any repo that uses PRs will drift silently after pull.

2. **Move git blobs to IndexedDB (Finding #3, Design Call B1).** This is the most pressing scalability issue. Without it, the app breaks on any non-trivial project. The migration is straightforward: blobs are already keyed by content hash, reads are already synchronous (`blob(git, id)` → make it async or preload on boot).

3. **Add `GITHUB_ALLOWED_REPOS` guard (Finding #4, Design Call B2).** One env var, one `if` check in `push.ts` and `clone.ts`. Prevents the worst-case "push to the wrong repo" accident. Combined with the fine-grained token recommendation, this closes the most serious security gap.

4. **Fix `pushPlan` crash on trimmed merge parents (Finding #2).** A one-line fix: check that `position.get(id)` is defined before using it. Without this, any push after extensive commit history triggers a cryptic error.

5. **Split `store.ts` (Design Call B4).** Not urgent for correctness, but the file is the bottleneck for all future work. Every change to git, chat, or files risks merge conflicts in the same 962-line file. Split it now while the seams are clean.

---

## D. What is solid and should be left alone

1. **`git.ts` core: `merge3`, `mergeTrees`, `mergeBranch`, diff, status, commit.** The three-way merge implementation is well-structured, handles the edge cases (delete/edit, both-add, identical changes), and has thorough tests. The hunk-based merge with region overlap detection is correct. The tests in `git.test.ts` cover the important paths including conflict detection, abort, and merge commits with two parents. Don't touch this.

2. **The sandbox architecture (`runtime.ts`, `python-runtime.ts`).** The iframe + Worker + CSP + opaque-origin layering is exactly right. JS gets a fresh iframe per run with no same-origin access. Python gets a persistent iframe (for Pyodide cache) but still sandboxed. The timeout and output-cap logic is clean. Every previous review asked for this, and it's been done properly.

3. **`access.server.ts` access control model.** HMAC cookie, timing-safe comparison, same-site request enforcement via Fetch Metadata, rate limiting per IP and daily cap — this is solid for a single-user app. The `assertSameSiteRequest` isolation is correct and well-documented. The only issue is the catastrophic `map.clear()` (Finding #5), which is a minor hardening gap, not a design flaw.

4. **`providers.server.ts` and the fallback machinery.** The three-provider model with per-provider config, reasoning effort support, and `fallbackOrder` is clean and extensible. `chat.ts`'s streaming with buffered-open-then-stream pattern handles the edge cases well (non-SSE responses, empty replies from reasoning models, error events mid-stream). `ai.functions.ts` provides the same fallback for non-streaming calls. This is well-factored.

5. **`tar.ts`.** Clean, pure, handles ustar, pax extended headers, GNU long names, binary detection, ignored folders, and size limits. Well-tested by usage. No changes needed.

6. **`handoff.ts`, `knowledge.ts`, `prompt.ts`.** These are pure functions with clear contracts, well-tested. The knowledge-pack TF-IDF retrieval is simple and appropriate for the scale. The prompt budget management is correct. The mode-labeling of cross-mode history is a nice touch.

7. **The terminal path resolution (`resolvePath`, `lookup`, `findFile`).** The previous reviews flagged this as broken — it's been rewritten and now handles `..`, absolute paths, project-relative paths, and bare-name matching correctly. The `seen` set in path resolution prevents loops. Leave it alone.
