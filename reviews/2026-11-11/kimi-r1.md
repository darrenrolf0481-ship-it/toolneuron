• ## A. Findings

  “Verified” means traced through the code; I did not execute anything.

  1. **Critical — verified — A divergent pull with skipped files can later revert those files on GitHub.**  
     `src/routes/api/git/fetch.ts:80-96`, `src/lib/crimson/git.ts:615-630`, `src/lib/crimson/git.ts:587-590`, `src/routes/api/git/push.ts:157-168`  
     Fetch omits binary/oversized changes but `replayRemote` still records the resulting incomplete commit as representing the real GitHub SHA.  
     **Scenario:** base has `asset.bin=v1`. GitHub changes it to `v2`, which pull skips. Meanwhile, local `main` changes `README`. Pull creates a clean merge whose local tree still implies `asset.bin=v1`. Push builds the merge tree from the local first parent and sends only first-parent changes. The merge has the real remote commit as second parent, so the fast-forward succeeds—but its tree restores `asset.bin=v1`, silently undoing GitHub’s `v2`. The same applies to oversized text.  
     **Fix:** never mark an incomplete replay as a complete, pushable representation of a remote commit. Prefer all-or-nothing pulls: if any changed file cannot be represented, refuse before modifying local state. Add an end-to-end regression test for divergent pull → merge → push with binary and oversized files.

  2. **High — verified — Branch switching, merging, and pull overwrite untracked files without warning.**  
     `src/lib/crimson/git.ts:288-292`, `src/lib/crimson/git.ts:316-324`, `src/lib/crimson/git.ts:341-367`, `src/lib/crimson/git.ts:765-773`  
     `dirty()` includes staged and tracked unstaged changes but excludes `status.untracked`.  
     **Scenario:** on `main`, create uncommitted `notes.txt`. Switch to a branch containing a tracked `notes.txt`. The switch is allowed and `applyChanges` replaces the untracked contents. A merge/pull does the same; aborting that merge deletes the file because HEAD has no copy.  
     **Fix:** before returning changes, reject any target path that is untracked in the working tree and would be created, modified, or deleted. Cover switch, fast-forward, clean/conflicted merge, pull, and abort.

  3. **High — verified — In-flight Git operations update whichever branch/remote is current when the response arrives.**  
     `src/lib/crimson/store.ts:644-657`, `src/lib/crimson/store.ts:690-698`, `src/lib/crimson/git.ts:635-641`  
     `markPushed` uses `get().git.branch` at completion rather than the branch that produced the plan. Pull similarly captures the request’s branch but merges into `now.branch`.  
     **Scenario:** push `main`, then switch to `feature` before the response. Success records `track["feature"]="main"`. The next feature push targets GitHub `main`. Likewise, switching branches during pull can merge the old branch’s remote commits into the newly selected branch. Removing/replacing the remote during push can also stamp old SHAs onto the new remote.  
     **Fix:** capture `{repo, localBranch, remoteBranch, head}` at operation start and compare-and-swap on completion. Record pushed SHAs independently of current branch, and pass the originating branch explicitly to `markPushed`. Reject stale pull results rather than applying them elsewhere. Serialize Git mutations or use an operation generation counter.

  4. **High — verified — The access key authorizes every repository reachable by the broad server token.**  
     `src/lib/crimson/access.server.ts:137-143`, `src/routes/api/clone.ts:73-89`, `src/routes/api/git/push.ts:97-106`  
     The client chooses `repo`; there is no server-side repository allowlist or read/write distinction.  
     **Scenario:** anyone holding `APP_ACCESS_KEY` can unlock, request `private-victim/secrets` as a clone, and receive its text files. With the current broad `repo` token, they can also push arbitrary commits to unrelated repositories the token can access. Same-site checks do not restrict a non-browser client possessing the key.  
     **Fix:** replace the token with a fine-grained token restricted to intended repositories, and enforce a server-side allowlist such as `GITHUB_READ_REPOS` and `GITHUB_WRITE_REPOS`. If the access-key holder is not meant to have full GitHub-owner authority, require separate push authorization or confirmation.

  5. **High — verified — Remote base selection is repository-wide, not specific to the target branch.**  
     `src/lib/crimson/git.ts:552-555`, `src/lib/crimson/git.ts:590`, `src/lib/crimson/store.ts:670-679`  
     `newestOnGitHub` finds any reachable commit known anywhere on GitHub. That is valid for “object exists,” but not for “current tip of this remote branch.”  
     **Scenario:** clone `main` at M; push feature commit F to `feature`; merge F into local `main`. GitHub `main` is still M, but `pushPlan` can choose F as `expectSha`, so the valid main push is rejected. Pull can compare F against main, report “GitHub is behind,” or demand a clone when histories diverge.  
     **Fix:** store the last confirmed remote tip per local/remote branch pair. Use that for `expectSha` and pull’s `base`; keep the SHA map solely as an object-existence/parent-mapping cache.

  6. **High — verified — Trimming breaks the ancestry of retained branch heads.**  
     `src/lib/crimson/git.ts:102-119`, `src/lib/crimson/git.ts:248-260`, `src/lib/crimson/git.ts:356-357`  
     Keeping the newest 50 array entries plus branch heads does not preserve the ancestors of those heads. `history` silently skips missing parents, and `collect` drops their blobs.  
     **Scenario:** create two diverged branches, then make more than 50 commits on one. The other branch head survives but its ancestors and the merge base can disappear. A later merge treats `{}` as the base, producing bogus conflicts or incorrect merges; push/pull can also fail because the known remote base disappeared.  
     **Fix:** until storage is moved off localStorage, do not trim reachable ancestry. Longer term, retain every commit reachable from branch heads and remote-tracking tips, with explicit garbage collection only for unreachable objects. Missing ancestry must be an error, never an empty merge base.

  7. **Medium — suspected — Client-supplied forwarding headers may bypass all per-IP limits.**  
     `src/lib/crimson/access.server.ts:50-53`, `src/lib/crimson/access.server.ts:75-80`, `src/lib/crimson/access.server.ts:122-125`  
     The code explicitly requests `xForwardedFor: true`, although the documented SSH-tunnel deployment has no trusted reverse proxy.  
     **Scenario:** if TanStack’s helper directly honors the header, a script can send a different `X-Forwarded-For` per request, resetting the five-attempt unlock budget and per-minute AI/GitHub limits.  
     **Fix:** verify the helper’s behavior in the actual runtime. Trust forwarding headers only behind a configured proxy; otherwise use the socket address. Add a global unlock-attempt limit as backup.

  8. **Medium — verified — Linked clone can consume unrelated staged state or an in-progress merge.**  
     `src/lib/crimson/store.ts:767-776`, `src/lib/crimson/git.ts:223-233`  
     Clone adds the copied paths to the existing index and then calls ordinary `commit`, which commits the entire index and honors `git.merging`.  
     **Scenario:** stage an unrelated edit, then perform a linked clone. The “Clone of owner/repo” commit also contains that edit. If a merge is in progress, the clone commit unexpectedly gains a second parent instead of being a plain snapshot of the cloned GitHub tip.  
     **Fix:** refuse linked clone unless no merge is active and the index equals HEAD. Construct the synthetic clone commit from exactly the intended previous HEAD plus copied subtree, not from the user’s pending index.

  9. **Medium — verified — Empty-repository bootstrap is neither recoverable nor safely forced.**  
     `src/routes/api/git/push.ts:109-123`, `src/routes/api/git/push.ts:174-184`  
     A failure after placeholder creation but before moving the requested default branch leaves the placeholder behind. The next push sees an existing branch with `expectSha=null` and rejects it as unrelated. Additionally, the forced updates do not verify that the ref still points to the placeholder, and failure of the secondary default-branch update is ignored.  
     **Scenario:** GitHub tree creation times out after bootstrap. Every retry to the default branch is now blocked. Or a collaborator commits after bootstrap and the forced update overwrites that new commit.  
     **Fix:** recognize and resume only an exact ToolNeuron-owned placeholder, re-read the ref immediately before replacement, clean up on failure where possible, and check every update’s result. Add failure-at-each-step tests.

  10. **Medium — verified — A skipped rename deletes the old local file anyway.**  
      `src/routes/api/git/fetch.ts:71-95`, `src/lib/crimson/store.ts:699-704`  
      The previous path is deleted before the replacement blob is fetched; if the new blob is binary or oversized, only the new path is reported skipped.  
      **Scenario:** GitHub renames `notes.txt` to `notes-large.txt` and expands it beyond 200 KB. Pull deletes local `notes.txt`, skips the replacement, then says skipped files were “left as they are here.”  
      **Fix:** treat rename as atomic: apply deletion only when the replacement is applied. Better, make the whole commit/pull all-or-nothing as in finding 1.

  11. **Medium — verified — A malicious repository can amplify one pull into nearly 15,000 GitHub requests.**  
      `src/routes/api/git/fetch.ts:64-95`, `src/lib/crimson/github.server.ts:34-39`  
      Fifty commits may each contain 299 files, with a separate blob request per file. There is no total changed-file cap or overall request deadline. Even after the byte budget is exhausted, the loop continues fetching blobs merely to classify them as skipped. Browser cancellation is not propagated.  
      **Scenario:** pull a repository with 50 commits × 299 changed files: up to 14,950 blob calls plus commit-detail calls, holding server work and exhausting GitHub rate limits.  
      **Fix:** cap total changed files, stop fetching once the response budget is exhausted, pass an overall `AbortSignal.any([request.signal, timeout])`, and replace per-commit reconstruction with an aggregate snapshot.

  12. **Medium — verified — The virtual filesystem permits ambiguous paths that Git silently collapses.**  
      `src/lib/crimson/store.ts:521-552`, `src/lib/crimson/git.ts:66-88`, `src/lib/crimson/git.ts:746-773`  
      Create/rename do not reject duplicate sibling names, slashes, `.`/`..`, or file/folder collisions. `workingFiles` writes paths into an object, so later duplicates silently overwrite earlier entries.  
      **Scenario:** create two `src/a.ts` files under the same folder and give them different contents. The editor shows both, but commits and pushes contain only the last array entry. A file literally named `src/a.ts` can collide with the nested path as well.  
      **Fix:** centralize path validation and enforce unique sibling names, valid single-segment names, correct parent types, and no cycles on create, rename, import, clone, and `applyChanges`.

  13. **Medium — verified — Imported and persisted Git state remains effectively unvalidated.**  
      `src/lib/crimson/node-file.ts:44-52`, `src/lib/crimson/store.ts:245-258`, `src/lib/crimson/store.ts:366`, `src/lib/crimson/git.ts:27-49`  
      The import schema is `.passthrough()`, and `normalizeGit` performs only shallow checks. Boot still spreads parsed localStorage directly over fresh state.  
      **Scenario:** a syntactically valid backup supplies `git.merging={theirs:"abc",unresolved:null}`. Import replaces and saves the workspace; opening the merge UI then dereferences `unresolved.length` and crashes. Invalid trees, branch heads, and parent references similarly enter the graph.  
      **Fix:** define a full versioned schema for Git, packs, chat, and the filesystem; validate parent/branch/blob references and tree invariants before replacing current state. Use the same migration/validation path for localStorage and imports. This earlier persistence concern is still open.

  14. **Medium — verified — Clearing the editor sends stale saved contents to the model.**  
      `src/lib/crimson/prompt.ts:74-80`  
      `state.draft || file.content || ""` treats an intentionally empty draft as absent.  
      **Scenario:** select all in `app.py`, delete everything, then ask “what remains in this file?” Before autosave, the model receives the old nonempty `file.content`.  
      **Fix:** use nullish selection: `file.id === state.activeFileId ? state.draft : (file.content ?? "")`. Add an explicit empty-draft test.

  15. **Medium — verified — The system-prompt budget is not actually enforced.**  
      `src/lib/crimson/prompt.ts:82-94`, `src/lib/crimson/chat-input.ts:23-26`  
      Only the open-file section is reduced to fit. Persona, skills, handoff, and knowledge are concatenated first and may already exceed 7,800 characters; the server then blindly slices at 8,000.  
      **Scenario:** a 4,000-character custom persona plus 1,600 characters of skills, a long handoff, and retrieved knowledge pushes the head beyond budget. The pinned handoff or later sections can be truncated by the server, despite the caller appearing to guarantee ordering and preservation.  
      **Fix:** allocate budgets by priority and enforce a final length invariant before sending. Reserve space for handoff/knowledge, clip persona/skills deterministically, and test worst-case combined sections.

  16. **Medium — verified — The streaming client accepts missing or incomplete responses as successful replies.**  
      `src/lib/crimson/stream-chat.ts:19-26`, `src/lib/crimson/stream-chat.ts:30-66`  
      It checks neither HTTP success/content type nor receipt of a terminal `done` event. Leftover unterminated NDJSON is ignored.  
      **Scenario:** a proxy returns a 502 HTML page with a body: every line fails JSON parsing, and `streamChat` returns `{ok:true,text:""}`. A clean EOF before `done` similarly turns a partial reply into success.  
      **Fix:** require `response.ok` and the expected content type, process the final buffer, and require `done` unless an explicit error/stop occurred. Treat premature EOF as a partial reply with an error notice.

  ## B. Design calls

  ### 1. localStorage versus IndexedDB

  **Move files and Git objects to IndexedDB now.** Keep only small preferences in localStorage.

  What breaks first is quota: files, the active draft, and up to 50 versions of blobs coexist in one JSON document. Repeated edits to a few 200 KB files can exceed normal browser limits quickly. Next are synchronous full-document serialization/writes on the UI thread and silent multi-tab last-writer-wins behavior.

  Do not merely move the same giant JSON string into IndexedDB. Use separate stores for workspace metadata, files, blobs by hash, commits by ID, and branch/remote refs, with transactions and a schema version. Add `navigator.storage.estimate()`, optional persistence, and a `BroadcastChannel`/Web Locks single-writer policy. Keep whole-node export as the recovery mechanism.

  ### 2. Server-side `GITHUB_TOKEN`

  The model is reasonable **only if the access-key holder is intentionally equivalent to the repository owner**. Binding to localhost protects network reachability, not authorization after unlock.

  Required guardrails:

  - Fine-grained token limited to named repositories; avoid the current broad `repo` token.
  - Server-enforced read and write repository allowlists.
  - Preserve fast-forward-only updates and branch protection.
  - A push confirmation showing repository, branch, and diff summary.
  - Request/file/time budgets and cancellation.
  - An audit log of repository, branch, old/new SHA, and result.
  - Consider blocking `.github/workflows` changes unless explicitly enabled.

  A read-only token by default, with a separate write credential or second unlock for push, would materially reduce the blast radius.

  ### 3. Pull replay

  **Stop replaying commits one by one.** It gives neither faithful local Git history nor a simple snapshot, while creating the N+1 request and incomplete-history problems above.

  Fetch the remote tip and the aggregate tree difference from the known base to that tip. Build one synthetic remote snapshot commit and map it to the actual GitHub tip SHA. Fast-forward when possible; otherwise three-way merge base/ours/remote-tip trees. The real GitHub ancestry remains available through the SHA parent mapping when a later merge is pushed. Commit-by-commit metadata can be fetched separately for display.

  Most importantly, unsupported content must make the operation all-or-nothing rather than producing a partially truthful remote snapshot.

  ### 4. Splitting `store.ts`

  **Yes, split it now, but by responsibility rather than making many tightly coupled stores.**

  Recommended seams:

  1. Workspace/files/draft and path invariants.
  2. Git repository operations and remote-operation state.
  3. Chat/streaming/cancellation.
  4. Terminal and runtime execution.
  5. Persistence/import/export.
  6. Swarm and settings.

  A single Zustand store composed from slice creators is fine. Extract async Git and AI work into controllers with operation IDs instead of allowing every async continuation to mutate current global state. The earlier monolithic-store and shared-`busy` concerns are still present.

  ## C. The next five things

  1. **Make pull data-safe:** all-or-nothing unsupported content, atomic renames, and the divergent skipped-file pull→merge→push regression test.
  2. **Protect local work and branch identity:** untracked collision checks, async compare-and-swap, and per-branch remote tips.
  3. **Harden the GitHub boundary:** replace/scope the token, add repository allowlists, repair empty-repo bootstrap recovery, and cap pull work.
  4. **Replace fragile persistence:** IndexedDB object stores, complete schemas, path invariants, multi-tab coordination, and removal of lossy history trimming.
  5. **Split the store and finish AI correctness:** operation-scoped async state, then empty-draft, prompt-budget, and premature-EOF tests/fixes.

  ## D. What is solid

  - The opaque-origin sandboxed iframe plus worker, timeouts, CSP, and script-free HTML preview are a major improvement. Keep that architecture.
  - Provider keys and GitHub credentials stay server-side; clients cannot select arbitrary models or provider URLs.
  - HMAC HttpOnly Strict cookies, same-site request checks, and baseline rate limiting are sensible foundations.
  - Push validates paths/body sizes and ordinarily refuses non-fast-forwards. Preserving existing file modes is a good detail.
  - Streaming fallback only before the first text, upstream cancellation on Stop, and partial-reply preservation are good decisions.
  - The pure Git tree/index/blob functions and existing unit tests are a useful base. The problem is lifecycle/metadata handling, not a need to rewrite everything.
  - Knowledge retrieval, pinned handoff formatting, and the current import/export presence are worthwhile features; tighten their boundaries rather than removing them.

