import { useMemo, useState } from "react";
import * as Git from "@/lib/crimson/git";
import { useOs } from "@/lib/crimson/store";

/** The editor's Git tab: real status, diffs, staging, commits and history (kept in this browser). */
export function GitPanel() {
  const files = useOs((state) => state.files);
  const activeFileId = useOs((state) => state.activeFileId);
  const draft = useOs((state) => state.draft);
  const raw = useOs((state) => state.git);
  const gitInit = useOs((state) => state.gitInit);
  const gitAdd = useOs((state) => state.gitAdd);
  const gitCommit = useOs((state) => state.gitCommit);
  const applyGit = useOs((state) => state.applyGit);
  const gitPush = useOs((state) => state.gitPush);
  const gitPull = useOs((state) => state.gitPull);
  const [branchName, setBranchName] = useState("");
  const [pushing, setPushing] = useState(false);
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const git = useMemo(() => Git.normalizeGit(raw), [raw]);
  const work = useMemo(() => Git.workingFiles(files, activeFileId ? { id: activeFileId, content: draft } : undefined), [files, activeFileId, draft]);
  const state = useMemo(() => Git.status(git, work), [git, work]);

  if (!git.initialized) {
    return (
      <div className="os-scroll flex-1 space-y-3 overflow-y-auto p-4">
        <p className="text-sm text-muted">No repository yet. History is kept in this browser, on one branch, with no remote.</p>
        <button type="button" onClick={gitInit} className="min-h-11 rounded-2xl bg-primary px-4 text-sm font-semibold text-on-primary">
          git init
        </button>
      </div>
    );
  }

  const index = git.index ?? {};
  const diffFor = (path: string, staged: boolean) =>
    staged ? Git.diffText(path, Git.blob(git, Git.headTree(git)[path]), Git.blob(git, index[path])) : Git.diffText(path, Git.blob(git, index[path]), work[path]);
  const unstaged = [...state.unstaged, ...state.untracked.map((path) => ({ path, kind: "untracked" as const }))];
  const head = Git.headCommit(git);

  const row = (key: string, path: string, kind: string, staged: boolean) => (
    <li key={key} className="rounded-2xl border border-border bg-surface">
      <button type="button" onClick={() => setOpen(open === key ? null : key)} className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm" aria-expanded={open === key}>
        <span className="w-20 shrink-0 text-xs text-muted">{kind}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{path}</span>
      </button>
      {open === key && (
        <pre className="os-scroll max-h-72 overflow-auto border-t border-border px-3 py-2 font-mono text-[11px] leading-4 whitespace-pre">
          {diffFor(path, staged).map((line, i) => (
            <span key={i} className={`block ${line.startsWith("+") && !line.startsWith("+++") ? "text-primary" : line.startsWith("-") && !line.startsWith("---") ? "text-muted line-through" : "text-muted"}`}>
              {line || " "}
            </span>
          ))}
        </pre>
      )}
    </li>
  );

  const branches = Object.keys(git.branches ?? { [git.branch]: undefined }).sort();
  const plan = Git.pushPlan(git);
  const toPush = typeof plan === "string" ? 0 : plan.moveTo ? 1 : plan.commits.length;
  const pushLabel = typeof plan !== "string" && plan.moveTo ? `Move GitHub ${plan.branch} to ${plan.moveTo.slice(0, 7)}` : `Push ${toPush} commit(s)`;

  return (
    <div className="os-scroll flex-1 space-y-4 overflow-y-auto p-4">
      <section aria-label="Branches" className="flex flex-wrap items-center gap-2 text-sm">
        <label className="text-muted" htmlFor="git-branch">
          Branch
        </label>
        <select
          id="git-branch"
          value={git.branch}
          onChange={(event) => {
            const result = Git.switchBranch(git, work, event.target.value);
            if (typeof result === "string") setNotice(result);
            else {
              applyGit(result.git, result.changes);
              setNotice(`Switched to ${event.target.value}${result.changes.length ? `: ${result.changes.length} file(s) updated` : ""}.`);
            }
          }}
          className="min-h-11 rounded-2xl border border-border bg-bg px-3 text-sm"
        >
          {branches.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <form
          className="flex min-w-0 flex-1 gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const name = branchName.trim();
            if (!name) return;
            const made = Git.createBranch(git, name);
            if (typeof made === "string") setNotice(made);
            else {
              applyGit({ ...made, branch: name });
              setBranchName("");
              setNotice(`Created and switched to ${name}.`);
            }
          }}
        >
          <input value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder="new branch" aria-label="New branch name" className="min-h-11 min-w-0 flex-1 rounded-2xl border border-border bg-bg px-3 text-sm outline-none" />
          <button type="submit" disabled={!branchName.trim()} className="min-h-11 rounded-2xl border border-border px-3 text-sm disabled:opacity-40">
            Create
          </button>
        </form>
      </section>
      <p className="text-sm text-muted">
        {head ? `Last commit ${head.id}` : "No commits yet"}. History stays in this browser.{" "}
        {git.remote ? `Pushes project/${git.remote.dir ? `${git.remote.dir}/` : ""} to ${git.remote.repo}.` : "No remote: clone a repo with GITHUB_TOKEN set, or git remote add origin owner/name in the terminal."}
      </p>
      {git.remote && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pushing || Boolean(git.merging)}
            onClick={async () => {
              setPushing(true);
              const result = await gitPull();
              setPushing(false);
              setNotice(result.message);
            }}
            className="min-h-11 rounded-2xl border border-border px-4 text-sm disabled:opacity-40"
          >
            Pull from {git.remote.repo}
          </button>
          <button
            type="button"
            disabled={pushing || toPush === 0 || Boolean(git.merging)}
            onClick={async () => {
              setPushing(true);
              const result = await gitPush();
              setPushing(false);
              setNotice(result.message);
            }}
            className="min-h-11 rounded-2xl bg-primary px-4 text-sm font-semibold text-on-primary disabled:opacity-40"
          >
            {pushing ? "Working…" : toPush ? pushLabel : "Nothing to push"}
          </button>
        </div>
      )}
      {git.merging && (
        <section aria-label="Merge in progress" className="space-y-2 rounded-2xl border border-primary/60 p-3 text-sm">
          <p className="font-semibold text-fg">Merge in progress: {git.merging.message}</p>
          {git.merging.unresolved.length > 0 ? (
            <>
              <p className="text-xs text-muted">
                Conflicts are marked in the files with &lt;&lt;&lt;&lt;&lt;&lt;&lt; ours / ======= / &gt;&gt;&gt;&gt;&gt;&gt;&gt; theirs. Edit each file to the version you want, remove the markers, then stage it.
              </p>
              <ul className="space-y-1">
                {git.merging.unresolved.map((path) => (
                  <li key={path} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-mono text-xs">{path}</span>
                    <button type="button" onClick={() => gitAdd([path])} className="min-h-9 shrink-0 rounded-full border border-border px-3 text-xs">
                      Mark fixed
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-xs text-muted">All conflicts are staged. Commit to finish the merge.</p>
          )}
          <button
            type="button"
            onClick={() => {
              const result = Git.abortMerge(git);
              if (typeof result === "string") setNotice(result);
              else {
                applyGit(result.git, result.changes);
                setNotice("Merge aborted.");
              }
            }}
            className="min-h-9 rounded-full border border-border px-3 text-xs"
          >
            Abort merge
          </button>
        </section>
      )}

      <section aria-label="Changes not staged" className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold tracking-widest text-primary uppercase">Changes ({unstaged.length})</h3>
          {unstaged.length > 0 && (
            <button type="button" onClick={() => gitAdd(["."])} className="min-h-9 rounded-full border border-border px-3 text-xs">
              Stage all
            </button>
          )}
        </div>
        {unstaged.length === 0 ? <p className="text-xs text-muted">Working files match the index.</p> : <ul className="space-y-2">{unstaged.map((change) => row(`u:${change.path}`, change.path, change.kind, false))}</ul>}
      </section>

      <section aria-label="Staged changes" className="space-y-2">
        <h3 className="text-xs font-semibold tracking-widest text-primary uppercase">Staged ({state.staged.length})</h3>
        {state.staged.length === 0 ? <p className="text-xs text-muted">Nothing staged.</p> : <ul className="space-y-2">{state.staged.map((change) => row(`s:${change.path}`, change.path, change.kind, true))}</ul>}
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const text = message.trim() || git.merging?.message || "";
            if (!text) return;
            const blockers = Git.mergeBlockers(git);
            if (blockers.length) {
              setNotice(blockers.join(" · "));
              return;
            }
            const ok = gitCommit(text);
            setNotice(ok ? (git.merging ? "Merge committed." : "") : "Nothing staged to commit.");
            if (ok) setMessage("");
          }}
        >
          <input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={git.merging ? git.merging.message : "Commit message"}
            aria-label="Commit message"
            className="min-h-11 min-w-0 flex-1 rounded-2xl border border-border bg-bg px-3 text-sm outline-none"
          />
          <button
            type="submit"
            disabled={git.merging ? git.merging.unresolved.length > 0 : !message.trim() || state.staged.length === 0}
            className="min-h-11 rounded-2xl bg-primary px-4 text-sm font-semibold text-on-primary disabled:opacity-40"
          >
            {git.merging ? "Commit merge" : "Commit"}
          </button>
        </form>
      </section>
      {notice && (
        <p className="text-xs text-muted" role="status">
          {notice}
        </p>
      )}

      <section aria-label="History" className="space-y-2">
        <h3 className="text-xs font-semibold tracking-widest text-primary uppercase">History of {git.branch} ({Git.history(git).length})</h3>
        <ul className="space-y-2">
          {Git.history(git).map((commit) => {
            const parent = git.commits.find((item) => item.id === commit.parent)?.tree ?? {};
            const changed = commit.tree ? Git.compareTrees(parent, commit.tree).length : null;
            const onGitHub = git.remote?.shas[commit.id];
            return (
              <li key={commit.id} className="rounded-2xl border border-border bg-surface px-3 py-2 text-sm">
                <span className="font-mono text-xs text-primary">{commit.id}</span> {commit.message}
                <span className="block text-xs text-muted">
                  {commit.time}
                  {changed === null ? " · no snapshot (made before history was real)" : ` · ${changed} file(s)`}
                  {onGitHub ? ` · on GitHub ${onGitHub.slice(0, 7)}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-muted">In the terminal: git restore &lt;path&gt;, git checkout &lt;commit&gt; -- &lt;path&gt;, git merge &lt;branch&gt;, git merge --abort, git branch -d &lt;branch&gt;.</p>
      </section>
    </div>
  );
}
