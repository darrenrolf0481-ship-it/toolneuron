import { useEffect, useRef, useState } from "react";
import { runSource } from "@/lib/crimson/runtime";
import { useOs } from "@/lib/crimson/store";
import { interpret } from "@/lib/crimson/terminal";

export function TerminalView() {
  const terminal = useOs((state) => state.terminal);
  const cwd = useOs((state) => state.cwd);
  const busy = useOs((state) => state.busy);
  const push = useOs((state) => state.pushTerminal);
  const clear = useOs((state) => state.clearTerminal);
  const setCwd = useOs((state) => state.setCwd);
  const remember = useOs((state) => state.rememberCommand);
  const history = useOs((state) => state.termHistory);
  const applyGit = useOs((state) => state.applyGit);
  const cloneRepo = useOs((state) => state.cloneRepo);
  const askTerminal = useOs((state) => state.askTerminal);
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(-1);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [terminal, busy]);

  const submit = () => {
    const cmd = input.trim();
    if (!cmd) return;
    remember(cmd);
    setCursor(-1);
    setInput("");
    push([`${cwd} $ ${cmd}`]);
    // The open draft is newer than its saved file; git and cat should see it.
    const now = useOs.getState();
    const result = interpret(cmd, { cwd, files: now.files, git: now.git, live: now.activeFileId ? { id: now.activeFileId, content: now.draft } : undefined });
    if (result.effect?.type === "clear") {
      clear();
      return;
    }
    if (result.lines.length) push(result.lines);
    const effect = result.effect;
    if (!effect) return;
    if (effect.type === "cwd") setCwd(effect.cwd);
    if (effect.type === "git") applyGit(effect.git, effect.writes);
    if (effect.type === "clone") void cloneRepo(effect.repo);
    if (effect.type === "run") {
      // Save the open editor draft first so the run sees the latest edits.
      useOs.getState().flushDraft();
      const latest = useOs.getState().files;
      const file = latest.find((item) => item.id === effect.fileId);
      if (!file) push([`[ERROR] ${effect.fileName} is not in the project`]);
      else void runSource(file.language ?? "", file.content ?? "", (line) => push([line])).then((out) => push(out.split("\n")));
    }
    if (effect.type === "ai") void askTerminal(effect.prompt);
  };

  return (
    <div className="flex h-full min-h-0 flex-col p-3 md:p-5">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl border border-border bg-surface">
        <header className="border-b border-border px-4 py-3 text-xs font-semibold tracking-widest text-primary uppercase">
          {cwd}
        </header>
        <div className="os-scroll flex-1 overflow-y-auto px-4 py-3 font-mono text-xs leading-5 md:text-sm">
          {terminal.map((line, index) => (
            <p key={`${index}-${line.slice(0, 24)}`} className={line.startsWith("$") || line.includes(" $ ") ? "text-fg" : "text-muted"}>
              {paint(line)}
            </p>
          ))}
          {busy && <p className="text-primary">NEURAL_LINK: working…</p>}
          <div ref={endRef} />
        </div>
        <form
          className="flex items-center gap-2 border-t border-border px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <span className="font-mono text-xs text-primary">$</span>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault();
              if (history.length === 0) return;
              const next = event.key === "ArrowUp" ? Math.min(history.length - 1, cursor + 1) : Math.max(-1, cursor - 1);
              setCursor(next);
              setInput(next === -1 ? "" : history[next]);
            }}
            className="min-h-11 flex-1 bg-transparent font-mono text-sm text-fg outline-none"
            placeholder="help"
            aria-label="Terminal command"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </form>
      </div>
    </div>
  );
}

function paint(line: string) {
  if (line.startsWith("[ERROR]") || line.startsWith("[WARN]") || line.startsWith("[SUCCESS]") || line.startsWith("[INFO]") || line.startsWith("[SYSTEM]") || line.startsWith("[RUNTIME]") || line.startsWith("NEURAL_LINK") || line.startsWith("CORE")) {
    return <span className="text-primary">{line}</span>;
  }
  return line;
}
