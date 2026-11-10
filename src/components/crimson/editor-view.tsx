import { useEffect, useMemo, useState } from "react";
import { ChevronDown, FileCode, Folder, FolderOpen, Pencil, Play, Plus, Trash2, WrapText } from "lucide-react";
import { runSource } from "@/lib/crimson/runtime";
import { CodeEditor } from "./code-editor";
import { TEMPLATES } from "@/lib/crimson/seed";
import { useOs } from "@/lib/crimson/store";
import type { ProjectFile } from "@/lib/crimson/types";

export function EditorView() {
  const files = useOs((state) => state.files);
  const activeFileId = useOs((state) => state.activeFileId);
  const draft = useOs((state) => state.draft);
  const setDraft = useOs((state) => state.setDraft);
  const flush = useOs((state) => state.flushDraft);
  const mode = useOs((state) => state.editorMode);
  const setMode = useOs((state) => state.setEditorMode);
  const outputs = useOs((state) => state.outputs);
  const setOutput = useOs((state) => state.setOutput);
  const savedAt = useOs((state) => state.savedAt);
  const saveError = useOs((state) => state.saveError);
  const git = useOs((state) => state.git);
  const gitInit = useOs((state) => state.gitInit);
  const gitAdd = useOs((state) => state.gitAdd);
  const gitCommit = useOs((state) => state.gitCommit);
  const [treeOpen, setTreeOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [running, setRunning] = useState(false);
  const [wrap, setWrap] = useState(true);
  const active = files.find((file) => file.id === activeFileId);
  const output = active ? (outputs[active.id] ?? "") : "";

  useEffect(() => {
    const timer = window.setTimeout(() => flush(), 800);
    return () => window.clearTimeout(timer);
  }, [draft, flush]);

  const previewDoc = useMemo(() => wrapHtml(draft), [draft]);

  return (
    <div className="relative flex h-full min-h-0">
      <div className={`absolute inset-0 z-20 bg-bg md:static md:z-0 md:w-64 md:shrink-0 ${treeOpen ? "block" : "hidden md:block"}`}>
        <FileTree onPick={() => setTreeOpen(false)} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
          <button type="button" className="min-h-11 rounded-xl border border-border px-3 text-xs md:hidden" onClick={() => setTreeOpen(true)}>
            Files
          </button>
          <p className="min-w-16 flex-1 truncate text-sm font-semibold">{active?.name ?? "No file"}</p>
          {saveError ? (
            <p className="max-w-56 text-xs font-semibold text-primary" role="alert" title={saveError}>
              ⚠ Not saved
            </p>
          ) : (
            <p className="hidden text-xs text-muted sm:block">{savedAt ? `saved ${savedAt}` : "live"}</p>
          )}
          {(["code", "preview", "git"] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setMode(item)}
              className={`min-h-11 rounded-xl px-3 text-xs font-semibold uppercase ${mode === item ? "bg-primary text-on-primary" : "border border-border text-muted"}`}
            >
              {item}
            </button>
          ))}
          {mode === "code" && (
            <button
              type="button"
              aria-pressed={wrap}
              title="Wrap long lines"
              aria-label="Wrap long lines"
              className={`flex min-h-11 items-center justify-center rounded-xl border px-3 text-xs ${wrap ? "border-primary text-fg" : "border-border text-muted"}`}
              onClick={() => setWrap(!wrap)}
            >
              <WrapText className="h-4 w-4 sm:hidden" />
              <span className="hidden sm:inline">Wrap</span>
            </button>
          )}
          <button type="button" className="min-h-11 rounded-xl border border-border px-3 text-xs" onClick={() => setTemplatesOpen(true)}>
            Templates
          </button>
          <button
            type="button"
            className="flex min-h-11 items-center gap-1 rounded-xl bg-primary px-3 text-xs font-semibold text-on-primary disabled:opacity-60"
            disabled={running}
            onClick={async () => {
              if (!active || active.type !== "file" || running) return;
              setRunning(true);
              setMode("code");
              const runId = active.id;
              setOutput(runId, "[RUNTIME] Running in an isolated sandbox…");
              const status: string[] = [];
              try {
                setOutput(
                  runId,
                  await runSource(active.language ?? "", draft, (line) => {
                    status.push(line);
                    setOutput(runId, ["[RUNTIME] Running in an isolated sandbox…", ...status.slice(-6)].join("\n"));
                  }),
                );
              } finally {
                setRunning(false);
              }
            }}
          >
            <Play className="h-3.5 w-3.5" />
            {running ? "Running…" : "Run"}
          </button>
        </div>

        {mode === "code" && (
          <div className="relative min-h-0 flex-1 overflow-hidden bg-bg">
            {active?.type === "file" ? (
              <CodeEditor fileId={active.id} value={draft} language={active.language ?? ""} wrap={wrap} onChange={setDraft} />
            ) : (
              <p className="p-4 text-sm text-muted">Pick a file to edit.</p>
            )}
          </div>
        )}

        {mode === "preview" && (
          <iframe title="HTML preview" sandbox="" srcDoc={previewDoc} className="min-h-0 flex-1 bg-bg" />
        )}

        {mode === "git" && (
          <div className="os-scroll flex-1 space-y-4 overflow-y-auto p-4">
            <p className="text-sm text-muted">{git.initialized ? `On ${git.branch}` : "No repository yet."}</p>
            {!git.initialized ? (
              <button type="button" onClick={gitInit} className="min-h-11 rounded-2xl bg-primary px-4 text-sm font-semibold text-on-primary">
                git init
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => active && gitAdd(active.id)}
                  className="min-h-11 rounded-2xl border border-border px-4 text-sm"
                >
                  Stage {active?.name}
                </button>
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!commitMsg.trim()) return;
                    gitCommit(commitMsg.trim());
                    setCommitMsg("");
                  }}
                >
                  <input
                    value={commitMsg}
                    onChange={(event) => setCommitMsg(event.target.value)}
                    placeholder="Commit message"
                    className="min-h-11 flex-1 rounded-2xl border border-border bg-bg px-3 text-sm outline-none"
                  />
                  <button type="submit" className="min-h-11 rounded-2xl bg-primary px-4 text-sm font-semibold text-on-primary">
                    Commit
                  </button>
                </form>
                <p className="text-xs text-muted">Staged: {git.staged.length ? git.staged.map((id) => files.find((file) => file.id === id)?.name ?? id).join(", ") : "nothing"}</p>
                <ul className="space-y-2">
                  {git.commits.map((commit) => (
                    <li key={commit.id} className="rounded-2xl border border-border bg-surface px-3 py-2 text-sm">
                      <span className="font-mono text-xs text-primary">{commit.id}</span> {commit.message}
                      <span className="block text-xs text-muted">{commit.time}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {output && mode === "code" && (
          <pre className="os-scroll max-h-40 overflow-auto border-t border-border bg-surface px-4 py-3 font-mono text-xs leading-5 text-muted whitespace-pre-wrap">
            {output}
          </pre>
        )}
      </div>

      {templatesOpen && (
        <div className="absolute inset-0 z-30 flex items-end justify-center bg-bg/80 p-4 md:items-center">
          <div className="w-full max-w-md rounded-3xl border border-border bg-surface p-5">
            <p className="text-lg font-semibold">Load a template</p>
            <p className="mt-1 text-sm text-muted">Replaces the current project.</p>
            <div className="mt-4 space-y-2">
              {Object.entries(TEMPLATES).map(([key, template]) => (
                <button
                  key={key}
                  type="button"
                  className="min-h-11 w-full rounded-2xl border border-border px-3 text-left text-sm"
                  onClick={() => {
                    if (window.confirm(`Replace the project with ${template.name}?`)) {
                      useOs.getState().loadTemplate(key);
                      setTemplatesOpen(false);
                    }
                  }}
                >
                  {template.name}
                </button>
              ))}
            </div>
            <button type="button" className="mt-3 min-h-11 text-sm text-muted" onClick={() => setTemplatesOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FileTree({ onPick }: { onPick: () => void }) {
  const files = useOs((state) => state.files);
  const root = files.find((file) => file.parentId === null);
  return (
    <div className="flex h-full flex-col border-r border-border bg-surface">
      <div className="flex items-center justify-between px-3 py-3">
        <p className="text-xs font-semibold tracking-widest text-muted uppercase">Project</p>
        <button type="button" className="text-xs text-muted md:hidden" onClick={onPick}>
          Close
        </button>
      </div>
      <div className="os-scroll flex-1 overflow-y-auto px-2 pb-4">
        {root && <TreeNode id={root.id} depth={0} onPick={onPick} />}
      </div>
    </div>
  );
}

function TreeNode({ id, depth, onPick }: { id: string; depth: number; onPick: () => void }) {
  const files = useOs((state) => state.files);
  const activeFileId = useOs((state) => state.activeFileId);
  const openFile = useOs((state) => state.openFile);
  const toggle = useOs((state) => state.toggleFolder);
  const createItem = useOs((state) => state.createItem);
  const renameItem = useOs((state) => state.renameItem);
  const deleteItem = useOs((state) => state.deleteItem);
  const node = files.find((file) => file.id === id);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(node?.name ?? "");
  const [creating, setCreating] = useState<"file" | "folder" | null>(null);
  const [draftName, setDraftName] = useState("");
  if (!node) return null;
  const children = files.filter((file) => file.parentId === id);

  return (
    <div>
      <div
        className={`flex min-h-11 items-center gap-1 rounded-xl pr-1 ${activeFileId === id ? "bg-primary text-on-primary" : "text-fg"}`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {renaming ? (
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => {
              renameItem(id, name);
              setRenaming(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                renameItem(id, name);
                setRenaming(false);
              }
            }}
            className="min-h-11 w-full bg-transparent text-sm outline-none"
          />
        ) : (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left text-sm"
            onClick={() => {
              if (node.type === "folder") toggle(id);
              else {
                openFile(id);
                onPick();
              }
            }}
          >
            {node.type === "folder" ? (
              node.isOpen ? <FolderOpen className="h-4 w-4 shrink-0" /> : <Folder className="h-4 w-4 shrink-0" />
            ) : (
              <FileCode className="h-4 w-4 shrink-0" />
            )}
            <span className="truncate">{node.name}</span>
            {node.type === "folder" && <ChevronDown className={`h-3 w-3 ${node.isOpen ? "" : "-rotate-90"}`} />}
          </button>
        )}
        {node.type === "folder" && (
          <button type="button" aria-label="New file" className="flex h-9 w-9 items-center justify-center" onClick={() => setCreating("file")}>
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
        {id !== "root" && (
          <>
            <button type="button" aria-label="Rename" className="flex h-9 w-9 items-center justify-center" onClick={() => setRenaming(true)}>
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-label="Delete"
              className="flex h-9 w-9 items-center justify-center"
              onClick={() => {
                if (window.confirm(`Delete ${node.name}?`)) deleteItem(id);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
      {creating && (
        <form
          className="px-3 py-1"
          style={{ paddingLeft: `${depth * 12 + 28}px` }}
          onSubmit={(event) => {
            event.preventDefault();
            createItem(id, creating, draftName);
            setDraftName("");
            setCreating(null);
          }}
        >
          <input
            autoFocus
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            placeholder={creating === "file" ? "file.py" : "folder"}
            className="min-h-11 w-full rounded-xl border border-border bg-bg px-2 text-sm outline-none"
          />
        </form>
      )}
      {node.type === "folder" && node.isOpen && children.map((child: ProjectFile) => (
        <TreeNode key={child.id} id={child.id} depth={depth + 1} onPick={onPick} />
      ))}
    </div>
  );
}

function wrapHtml(source: string) {
  if (/<html/i.test(source)) return source;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#050102">${source}</body></html>`;
}
