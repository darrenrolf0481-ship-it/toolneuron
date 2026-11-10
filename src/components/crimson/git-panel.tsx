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

  return (
    <div className="os-scroll flex-1 space-y-4 overflow-y-auto p-4">
      <p className="text-sm text-muted">
        On {git.branch}
        {head ? `, last commit ${head.id}` : ", no commits yet"}. History stays in this browser; there is no remote.
      </p>

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
            if (!message.trim()) return;
            const ok = gitCommit(message.trim());
            setNotice(ok ? "" : "Nothing staged to commit.");
            if (ok) setMessage("");
          }}
        >
          <input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Commit message"
            aria-label="Commit message"
            className="min-h-11 min-w-0 flex-1 rounded-2xl border border-border bg-bg px-3 text-sm outline-none"
          />
          <button type="submit" disabled={!message.trim() || state.staged.length === 0} className="min-h-11 rounded-2xl bg-primary px-4 text-sm font-semibold text-on-primary disabled:opacity-40">
            Commit
          </button>
        </form>
        {notice && <p className="text-xs text-muted" role="status">{notice}</p>}
      </section>

      <section aria-label="History" className="space-y-2">
        <h3 className="text-xs font-semibold tracking-widest text-primary uppercase">History ({git.commits.length})</h3>
        <ul className="space-y-2">
          {git.commits.map((commit, i) => {
            const parent = git.commits[i + 1]?.tree ?? {};
            const changed = commit.tree ? Git.compareTrees(commit.parent ? parent : {}, commit.tree).length : null;
            return (
              <li key={commit.id} className="rounded-2xl border border-border bg-surface px-3 py-2 text-sm">
                <span className="font-mono text-xs text-primary">{commit.id}</span> {commit.message}
                <span className="block text-xs text-muted">
                  {commit.time}
                  {changed === null ? " · no snapshot (made before history was real)" : ` · ${changed} file(s)`}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-muted">Restore from the terminal: git restore &lt;path&gt; or git checkout &lt;commit&gt; -- &lt;path&gt;.</p>
      </section>
    </div>
  );
}
