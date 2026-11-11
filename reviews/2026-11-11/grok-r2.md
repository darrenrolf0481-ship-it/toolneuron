The date-order claim and the new findings need a pass through the push, clone, and guard code before I rule on the fixes.## 1. Disputes

None of E1–E17 or K-1, K-6–K-12, K-14, K-15, A-a, A-b, or A-d. E9 matches `pushPlan` (`git.ts:573`): a missing parent returns the trimmed-history string before `position.get`. E10 matches `clone.ts` passing one signal into `readCapped`.

Correction of my finding 5 only. [GitHub’s compare docs](https://docs.github.com/en/rest/commits/commits#compare-two-commits) say the list is chronological, like `git log` (committer date, not `--topo-order`), and that on an unpaginated response the last entry is the most recent commit. A skewed committer date can place a parent after the merge. E3 does not need that: with the tip last, replaying first-parent file lists still leaves `f="base"`.

E1 is the hole I understated. `push.ts:148` always uses `parents[0]` as `base_tree`. On a pull merge that parent is the local commit, whose tree still carries the skipped blob from the older GitHub commit, so an unnamed path is reverted. The HMAC cookie and same-site check stay; calling the access control fail-closed was wrong. `clientIp()` trusts `X-Forwarded-For` (`access.server.ts:51`), and `hit` (`:67`) wipes the map at 5,000 keys.

## 2. Rulings

**P1. AMEND.** Per-branch tips are the right source for `expectSha` and for the pull base, and the ancestor check fixes E4. The zero-commit ref move needs its own server path: empty commit list is rejected today (`push.ts:33`), and the update must stay `force: false` with GitHub’s fast-forward check. Do not reuse the placeholder force flag.

**P2. ACCEPT.** One tip-tree snapshot. Per-commit replay is how E3 happens. Fetching full trees only for merge commits still applies ordinary commits onto the wrong parent and still does one blob request per file.

**P3. AMEND.** (a) Accept. (b) Drop-with-notice only when this branch has not modified the path since the sync base. If it has, refuse the pull and name the path. Do not offer modify/delete “keep ours”: that publishes the stale bytes over the skipped blob.

**P4. AMEND.** The covering rule is right for a pull merge: the pulled commit’s known set contains the local commit’s known set, so `base_tree` is the new GitHub tree and an omitted path stays at v2. If both sides cover each other (two local commits off the same synced sha), either parent works; prefer one already on GitHub. If neither covers, refuse. The wire format must name the tree parent. `push.ts:148` must not assume `parents[0]`. This is safe only if an unreadable path is absent from the local snapshot. If the pulled tree still holds v1 and the local side has v1b, `merge3` cleans to v1b and the push overwrites v2.

**P5. ACCEPT.**

**P6. AMEND.** Stop trimming reachable history now, and make a missing merge base an error. IndexedDB is the next change, not a blocker for P1–P5. Until it lands, refuse a commit that will not fit.

**P7. ACCEPT.** Record shas against the branch captured at start. Drop the result if the remote was removed or replaced.

**P8. ACCEPT.** Unset `GITHUB_REPOS`: public clone with no token stays; anything that would send the token fails closed. Modes as you wrote them.

**P9. ACCEPT.** Match git on adjacent hunks (E7: those 846 are the only clean-vs-conflict gap, and they are the loose direction). The rest of the list is the right small set.

## 3. Questions

**Q1.** No counter-example when the snapshot does not contain stale bytes and the server uses the named tree parent. The failure mode is above: stale v1 left in the pulled tree, local edit v1b, clean merge, push writes v1b onto GitHub’s v2.

**Q2.** Split, as in P3. All-or-nothing makes an image or lockfile change fail every pull. A conflict that keeps the local file is how E1 comes back.

**Q3.** One snapshot commit. Keep the subjects in the message.

**Q4.** Nothing else, once the empty-commit ref update is a real request and cannot set `force`.

**Q5.** After P1–P5. One IndexedDB database for blobs, commits, branches, and tips, in one transaction. Not blobs only: a graph left in `localStorage` can diverge from its blobs. Working-file documents can stay as they are for now.

**Q6.** Match git. E7 shows we do not invent a clean result git would reject except on adjacent lines, and those are the merges worth showing the user.

**Q7.** Yes. Fail closed for every call that uses the token.

**Q8.** (a) Stop. `finish_reason: "length"` with no text is that model’s answer, not a dead provider. Show the error. Do not call the next one. (b) Return the shas even when the ref update fails, and let the client store them without moving `tips`. The next push then fast-forwards. If the response never arrives, a second orphan set is acceptable. Do not search GitHub for a matching tree.

**Q9.** P4 without P2 and P3 still reverts blobs. P2 without P4 still uses the first parent. P7 belongs in that same batch: a branch switch during the live E1 run records the tip on the wrong branch. The allowlist and the mode rule belong there too while the token is `repo` scope. The rest of P8 and P9 can follow. IndexedDB immediately after, with P6’s “refuse, do not drop” already in.

## 4. Order

Ship together: P4, P1, P2, P3, P7, P6’s no-empty-base rule, and from P8 the allowlist plus `100644`/`100755` modes. Then P5, then IndexedDB with the rest of P6, then the rest of P8 and P9.

I would not ship without a live repeat of E1: pull, merge, push, and the skipped blob on GitHub must still be v2.
