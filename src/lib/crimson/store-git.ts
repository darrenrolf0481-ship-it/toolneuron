/** Git actions of the workspace store, including GitHub clone, push and pull. */
import * as Git from "./git";
import { languageFromName } from "./seed";
import type { StoreApi } from "./store-shared";
import type { OsState } from "./store";
import { mergeLines } from "./terminal";
import type { ProjectFile } from "./types";

/** The GitHub operation in flight ("push", "pull" or "clone"), so two cannot interleave. */
let githubBusy: string | null = null;

export function gitActions(
  get: StoreApi["get"],
  set: StoreApi["set"],
): Pick<OsState, "gitInit" | "gitAdd" | "gitCommit" | "applyGit" | "gitPush" | "gitPull" | "cloneRepo"> {
  return {
  gitInit: () => set({ git: Git.init(get().git) }),
  gitAdd: (paths) => {
    get().flushDraft();
    const state = get();
    set({ git: Git.add(Git.normalizeGit(state.git), Git.workingFiles(state.files), paths).git });
  },
  gitCommit: (message) => {
    get().flushDraft();
    const next = Git.commit(Git.normalizeGit(get().git), message, new Date().toLocaleString());
    if (!next) return false;
    set({ git: next });
    return true;
  },
  applyGit: (git, changes = []) => {
    get().flushDraft();
    const state = get();
    if (changes.length === 0) {
      set({ git });
      return true;
    }
    const clashes = Git.pathClashes(state.files, changes);
    if (clashes.length) {
      // Leave git and the files exactly as they were.
      get().pushTerminal([`[ERROR] a file and a folder have the same name, so nothing was changed: ${clashes.slice(0, 5).join(", ")}. Rename one, then try again.`]);
      return false;
    }
    const stampId = Date.now().toString(36);
    const files = Git.applyChanges(state.files, changes, (n) => `git_${stampId}_${n}`, languageFromName);
    const active = files.find((file) => file.id === state.activeFileId && file.type === "file");
    const fallback = active ?? files.find((file) => file.type === "file");
    set({
      git,
      files,
      activeFileId: fallback?.id ?? "",
      draft: fallback?.content ?? "",
      workFileId: files.some((file) => file.id === state.workFileId) ? state.workFileId : (fallback?.id ?? ""),
    });
    return true;
  },
  gitPush: async () => {
    const say = (lines: string[]) => get().pushTerminal(lines);
    const done = (ok: boolean, message: string, extra: string[] = []) => {
      say([`${ok ? (message.startsWith("Everything") ? "[INFO]" : "[SUCCESS]") : "[ERROR]"} ${message}`, ...extra]);
      return { ok, message };
    };
    if (githubBusy) return done(false, `another GitHub operation (${githubBusy}) is still running`);
    if (get().gitStorage === "loading") return done(false, "git history is still loading; try again in a moment");
    get().flushDraft();
    const git = Git.normalizeGit(get().git);
    const plan = Git.pushPlan(git);
    if (typeof plan === "string") return done(plan.startsWith("Everything"), plan);
    githubBusy = "push";
    say([plan.moveTo ? `Moving ${plan.repo} ${plan.branch} to ${plan.moveTo.slice(0, 7)}…` : `Pushing ${plan.commits.length} commit(s) to ${plan.repo} ${plan.branch}…`]);
    let result: { ok: boolean; error?: string; shas?: string[]; tip?: string; url?: string; created?: boolean; warning?: string };
    try {
      const response = await fetch("/api/git/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(plan) });
      result = await response.json();
    } catch {
      githubBusy = null;
      return done(false, "The push request failed (network).");
    }
    githubBusy = null;
    // Record against the branches the plan was made for, not whatever is current now.
    // markPushed ignores the result if the remote was removed or replaced meanwhile.
    if (result.shas?.length || (result.ok && result.tip)) {
      set({ git: Git.markPushed(Git.normalizeGit(get().git), plan, result.shas ?? [], result.ok ? (result.tip ?? null) : null) });
    }
    if (!result.ok) return done(false, result.error ?? "Push failed.");
    const what = plan.moveTo ? `moved to ${plan.moveTo.slice(0, 7)}` : `${plan.commits.length} commit(s), now at ${result.tip?.slice(0, 7)}`;
    return done(true, `${result.created ? "Created" : "Updated"} ${plan.repo} ${plan.branch}: ${what}`, [`[INFO] ${result.url}`, ...(result.warning ? [`[WARN] ${result.warning}`] : [])]);
  },
  gitPull: async () => {
    const say = (lines: string[]) => get().pushTerminal(lines);
    const fail = (message: string) => {
      say([`[ERROR] ${message}`]);
      return { ok: false, message };
    };
    if (githubBusy) return fail(`another GitHub operation (${githubBusy}) is still running`);
    if (get().gitStorage === "loading") return fail("git history is still loading; try again in a moment");
    get().flushDraft();
    const git = Git.normalizeGit(get().git);
    const remote = git.remote;
    if (!remote) return fail("no remote to pull from");
    const branch = Git.remoteBranchOf(git);
    const baseSha = remote.tips?.[branch];
    if (!baseSha) return fail(`GitHub's ${branch} has not been seen by this project yet: push it first, or clone ${remote.repo} again`);
    const baseId = Git.localIdOf(git, baseSha);
    if (!baseId) return fail(`the commit GitHub's ${branch} was last seen at is no longer in local history; clone ${remote.repo} again`);
    const pending = Git.dirty(git, Git.workingFiles(get().files));
    if (pending.length) return fail(`commit or restore your changes first: ${pending.slice(0, 5).join(", ")}`);
    // Pin what the pull started on; a result for a different state is thrown away.
    const started = { repo: remote.repo, branch: git.branch, head: Git.headCommit(git)?.id };
    githubBusy = "pull";
    say([`Pulling ${remote.repo} ${branch}…`]);
    let result: { ok: boolean; error?: string; note?: string; tip?: string; ahead?: number; subjects?: string[]; changes?: Git.PullChange[] };
    try {
      const response = await fetch("/api/git/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: remote.repo, branch, base: baseSha }) });
      result = await response.json();
    } catch {
      githubBusy = null;
      return fail("The pull request failed (network).");
    }
    githubBusy = null;
    if (!result.ok || !result.changes || !result.tip) return fail(result.error ?? "Pull failed.");
    const now = Git.normalizeGit(get().git);
    if (now.remote?.repo !== started.repo || now.branch !== started.branch || Git.headCommit(now)?.id !== started.head || now.merging) {
      return fail("the project changed while pulling (branch, commit or remote); nothing was applied. Run git pull again");
    }
    if (result.tip === baseSha) {
      const message = result.note ?? "Already up to date.";
      say([`[INFO] ${message}`]);
      return { ok: true, message };
    }
    const time = new Date().toLocaleString();
    const subjects = result.subjects ?? [];
    const message = `Pull ${result.ahead ?? "?"} commit(s) from ${remote.repo} ${branch}${subjects.length ? `: ${subjects.slice(0, 3).join("; ")}${subjects.length > 3 ? "; …" : ""}` : ""}`;
    const snapshot = Git.pullSnapshot(now, baseId, result.tip, result.changes, message, time);
    if (typeof snapshot === "string") return fail(snapshot);
    const merged = Git.mergeInto(snapshot.git, Git.workingFiles(get().files), snapshot.tip, `Merge ${remote.repo} ${branch} into ${now.branch}`, time);
    if (typeof merged === "string") return fail(merged);
    // GitHub's branch is now known to be at the fetched tip.
    const withTip = merged.git.remote ? { ...merged.git, remote: { ...merged.git.remote, tips: { ...(merged.git.remote.tips ?? {}), [branch]: result.tip } } } : merged.git;
    const view = mergeLines(now, { ...merged, git: withTip });
    if (!get().applyGit(withTip, merged.changes)) return fail("the pulled files clash with names in this project (a file and a folder share a name); nothing was applied");
    say([
      `[INFO] Fetched ${result.ahead ?? "?"} commit(s) from GitHub${subjects.length ? `: ${subjects.slice(0, 3).join("; ")}${subjects.length > 3 ? "; …" : ""}` : ""}`,
      ...view.lines,
      ...(snapshot.dropped.length ? [`[INFO] Removed here because GitHub's new version cannot be copied (binary or too large); it stays on GitHub: ${snapshot.dropped.slice(0, 5).join(", ")}`] : []),
    ]);
    return { ok: merged.conflicts.length === 0, message: merged.note };
  },
  cloneRepo: async (repo) => {
    const say = (lines: string[]) => get().pushTerminal(lines);
    let result: {
      ok: boolean;
      error?: string;
      files?: { path: string; content: string }[];
      skipped?: Record<string, number>;
      /** Set when the server has a token and the repo is allowed: the copy can be linked for push. */
      linked?: boolean;
      /** The server has a token but the repo is not on GITHUB_REPOS. */
      notAllowed?: boolean;
      sha?: string;
      branch?: string;
      private?: boolean;
    };
    if (githubBusy || get().gitStorage === "loading") {
      say([githubBusy ? `[ERROR] another GitHub operation (${githubBusy}) is still running` : "[ERROR] git history is still loading; try again in a moment"]);
      return;
    }
    githubBusy = "clone";
    try {
      const response = await fetch("/api/clone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo }) });
      result = await response.json();
    } catch {
      say(["[ERROR] The clone request failed (network)."]);
      return;
    } finally {
      githubBusy = null;
    }
    if (!result.ok || !result.files) {
      say([`[ERROR] ${result.error ?? "Clone failed."}`]);
      return;
    }
    const state = get();
    const top = state.files.find((file) => file.parentId === null)?.id ?? "root";
    const base = repo.split("/")[1];
    const taken = new Set(state.files.filter((file) => file.parentId === top).map((file) => file.name));
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    const stampId = Date.now().toString(36);
    const folders = new Map<string, string>();
    const additions: ProjectFile[] = [];
    const rootId = `clone_${stampId}`;
    additions.push({ id: rootId, name, type: "folder", parentId: top, isOpen: true });
    folders.set("", rootId);
    const folderFor = (dir: string): string => {
      const known = folders.get(dir);
      if (known) return known;
      const parts = dir.split("/");
      const parent = folderFor(parts.slice(0, -1).join("/"));
      const id = `${rootId}_d${folders.size}`;
      additions.push({ id, name: parts[parts.length - 1], type: "folder", parentId: parent, isOpen: false });
      folders.set(dir, id);
      return id;
    };
    result.files.forEach((item, index) => {
      const parts = item.path.split("/");
      const fileName = parts.pop()!;
      additions.push({ id: `${rootId}_f${index}`, name: fileName, type: "file", parentId: folderFor(parts.join("/")), language: languageFromName(fileName), content: item.content });
    });
    const files = [...state.files, ...additions];
    set({ files });
    const skipped = Object.entries(result.skipped ?? {})
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${count} ${reason.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`)}`);
    const lines = [
      `[SUCCESS] Copied ${result.files.length} text file(s) from github.com/${repo}${result.private ? " (private)" : ""} into project/${name}/`,
      ...(skipped.length ? [`[INFO] left out: ${skipped.join(", ")}. They stay on GitHub untouched when you push.`] : []),
    ];
    const git = Git.normalizeGit(get().git);
    if (result.linked && result.sha && result.branch && !git.remote && !git.merging) {
      // Record the copy as a commit that is already on GitHub, so later commits push on top of it.
      // Only the cloned paths go into it; anything else the user staged stays staged.
      const dir = Git.pathOf(additions[0], files);
      const cloned = Object.fromEntries(Object.entries(Git.workingFiles(files)).filter(([path]) => path.startsWith(`${dir}/`)));
      const committed = Git.commitFiles(git.initialized ? git : Git.init(git), cloned, `Clone of ${repo} at ${result.sha.slice(0, 7)}`, new Date().toLocaleString());
      if (typeof committed === "string") {
        lines.push(`[INFO] A plain copy: ${committed}.`);
      } else {
        const head = Git.headCommit(committed)!;
        set({ git: Git.setRemote(committed, repo, dir, { [committed.branch]: result.branch }, { [head.id]: result.sha }, { [result.branch]: result.sha }) });
        lines.push(
          `[INFO] Linked: project/${dir}/ pushes to ${repo} (${committed.branch} → ${result.branch}). Commit there, then git push.`,
          "[INFO] git pull brings in changes made on GitHub; git push sends yours.",
        );
      }
    } else if (result.linked && git.merging) {
      lines.push("[INFO] A plain copy: a merge is in progress, so the clone was not linked. Finish or abort the merge and clone again to link it.");
    } else if (result.linked && git.remote) {
      lines.push(`[INFO] A plain copy: this project already pushes to ${git.remote.repo} (one remote per project).`);
    } else if (result.notAllowed) {
      lines.push(`[INFO] A plain copy: ${repo} is not on the server's GITHUB_REPOS list, so the token was not used and the copy is not linked.`);
    } else {
      lines.push("[INFO] A plain copy with no link back. Set GITHUB_TOKEN and GITHUB_REPOS on the server to link clones for push (and to clone private repos).");
    }
    say(lines);
  },
  };
}
