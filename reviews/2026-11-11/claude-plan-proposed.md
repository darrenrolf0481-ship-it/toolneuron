MY PROPOSED FIXES (rule on each: ACCEPT / REJECT / AMEND, one to three sentences, then say what you would change)

P1. Track where each GitHub branch is. Add remote.tips: { [remoteBranch]: sha }, set by clone, pull and push. remote.shas stays as "local commit id -> GitHub sha" and is used only to map parents. Push: expectSha = tips[target] (null means the branch must not exist yet); refuse locally, before any request, if the local commit for tips[target] is not an ancestor of HEAD ("GitHub has commits you do not have: git pull"). If nothing is unpushed but sha(HEAD) differs from tips[target] and HEAD descends from it, push moves the GitHub branch to that existing commit (no new commits). Pull: base = tips[target].

P2. Pull makes ONE local commit from the tip tree. fetch.ts does: (1) compare base...branch, for status (refuse when GitHub no longer contains base) and for the commit subjects; (2) git/trees/{base}?recursive=1 and git/trees/{tip}?recursive=1, refusing if either is truncated, and diffs them by blob sha on the server; (3) for each changed path: skip WITHOUT downloading when the tree entry's size is over the cap or its mode is a symlink or submodule; otherwise fetch the blob through a streamed byte cap; binary or non-UTF-8 becomes "skipped"; (4) returns { tip, subjects, changes: [{ path, content | null, skipped? }] } under one overall deadline tied to request.signal. The browser writes one commit "Pull N commits from owner/repo branch: <subjects>" whose tree is the local tree of base plus those changes, mapped to the tip sha. This replaces per-commit replay (E3), has no 300-file compare limit, and knows sizes before any download (E16). Kimi suggested compare's aggregate `files`; Grok the tip tree; Antigravity keeping per-commit replay with full trees for merge commits.

P3. Files a pull cannot represent (binary, over 200 KB, non-UTF-8):
   (a) not held locally: ignore; they stay as GitHub has them, which P4 guarantees.
   (b) held locally but the new version cannot be copied: Kimi proposes all-or-nothing (refuse the whole pull). My alternative: remove the path from the pulled snapshot and from the working copy, with a notice ("big.txt is now too large to copy; it stays on GitHub"), which is exactly what a fresh clone would give. If local commits changed that file, the three-way merge reports a modify/delete conflict and the user decides knowingly. A rename whose new path cannot be copied is handled the same way (old path removed, notice names both).
   Which is safer AND still usable on a repo where an image or a lock file changes in most pulls?

P4. Push builds a merge commit's tree from the right parent. For a merge commit with parents X and Y, pick the "tree parent": the parent whose GitHub-known ancestors include all of the other's (for a pull-merge that is the pulled commit). Send changes = diff(local tree of the tree parent -> merge tree); the server uses that parent's GitHub tree as base_tree. Files the browser does not hold are then taken from the newest GitHub side instead of the oldest (fixes E1). If neither parent covers the other (two local branches that each pulled different GitHub commits), refuse the push and say why. Is the covering rule correct? Is there a case where it still drops or reverts something?

P5. Untracked collisions. switch, merge (fast-forward, clean and conflicted) and pull refuse, listing the paths, when a path they would write or delete exists untracked in the working files with different content.

P6. History is never trimmed while reachable. Keep every commit reachable from a branch head, merging.theirs or a remote tip; drop only unreachable ones. A missing merge base becomes an error ("history is incomplete"), never an empty base. Storage moves to IndexedDB (question Q5 below), and until then the app shows usage and refuses a commit that would not fit rather than dropping history.

P7. One GitHub operation at a time, tied to what it started on. Capture { repo, local branch, remote branch, HEAD id } at the start. Push completion records shas and the tip for the ORIGINAL branches (markPushed takes them as arguments); if the remote was removed or replaced meanwhile, the result is dropped. Pull completion is discarded with "the project changed while pulling, run it again" if the branch, HEAD or merge state changed.

P8. GitHub boundary.
   - GITHUB_REPOS allowlist (owner/name, owner/*), enforced in clone, fetch and push. Unset: public clones only, no private clone, no push (fail closed for anything that needs the token).
   - fetch.ts: cap changed files, stop fetching blobs once the byte budget is spent, propagate cancellation.
   - Empty-repo bootstrap: recognise our own placeholder on a retry (a root commit whose tree is exactly .toolneuron-bootstrap) and continue; re-read the ref and require the placeholder sha immediately before the forced update; check the result of the default-branch update.
   - Rate limits: honour X-Forwarded-For only when TRUST_PROXY=true, otherwise use the socket address; add a global failed-unlock cap; evict oldest keys instead of clearing the map.
   - catch only CrossSiteRequestError where the guards are called.
   - push.ts modes: content written by the app is 100644, or 100755 when the existing entry is 100755; never 120000 or 160000 (E17).

P9. Smaller fixes.
   - Commit ids: use the full 14-char hash as the id, display the first 7.
   - merge3: treat touching hunks as overlapping, to match git (E7).
   - prompt.ts: use the draft whenever the file is the active one, even when empty; enforce the budget on the whole prompt with per-section caps (persona, skills, handoff, knowledge) and a floor for the open file; mark truncation.
   - stream-chat.ts: require response.ok and a `done` event; an early end keeps the partial text and shows an error.
   - createItem / renameItem / applyChanges / import: reject duplicate sibling names, "/", "." and "..", and file-versus-folder collisions.
   - normalizeGit and import: validate the whole git shape (merging, branches, parents, trees) and repair or reject.
   - Linked clone: refuse while a merge is in progress; build the clone commit from HEAD's tree plus the cloned paths, not from the whole index.
   - Two tabs: listen for `storage` (or use BroadcastChannel) and stop a stale tab from saving over a newer one.
   - consult(): a generation counter so a reply that lands after a workspace reset cannot create a file in the new workspace.

ORDER I INTEND: P4+P1+P2+P3 together (with a live regression test of E1 and E4), then P5, P7, P6, P8, P9.

QUESTIONS
Q1. P4: correct and complete? If you see a counter-example, give it as a commit graph.
Q2. P3(b): all-or-nothing, or drop-with-notice plus conflict?
Q3. P2: one snapshot commit per pull, or keep per-commit replay and fetch full trees for merge commits?
Q4. P1: anything wrong with tips per remote branch, including the "move the branch to an existing commit" push?
Q5. IndexedDB: blobs only (commit graph stays in localStorage) or everything (files, blobs, commits, refs in separate object stores)? Before or after the correctness fixes above?
Q6. merge3: match git on adjacent-line edits, or keep merging them?
Q7. P8: should push fail closed when GITHUB_REPOS is unset?
Q8. Two smaller calls. (a) Grok: when a model spends its whole token budget thinking and returns no text, chat should show that error and NOT fall through to the next provider (today it falls through and says who answered). (b) Grok: a push whose final ref update fails leaves orphan commits and a retry creates a second set; make the retry reuse them, or accept the orphans as harmless?
Q9. What in this plan is wrong, missing, or in the wrong order?
