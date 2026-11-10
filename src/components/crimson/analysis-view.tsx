import { analyzeSource } from "@/lib/crimson/analyze";
import { useOs } from "@/lib/crimson/store";

export function AnalysisView() {
  const files = useOs((state) => state.files);
  const activeFileId = useOs((state) => state.activeFileId);
  const draft = useOs((state) => state.draft);
  const openFile = useOs((state) => state.openFile);
  const setTab = useOs((state) => state.setTab);
  const consult = useOs((state) => state.consult);
  const busy = useOs((state) => state.busy);
  const file = files.find((item) => item.id === activeFileId);
  const code = file?.type === "file" ? draft : "";
  const findings = analyzeSource(code, file?.language ?? "");
  const samples = files.filter((item) => item.type === "file");

  return (
    <div className="os-scroll h-full overflow-y-auto p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">Code analysis</h2>
          <p className="mt-1 max-w-xl text-sm text-muted">
            Local, offline rules: SQL injection, XSS, hard-coded secrets, N+1 queries, swallowed errors, missing type hints. The AI review is optional and only runs when you ask.
          </p>
        </div>
        <button
          type="button"
          disabled={busy || !code}
          onClick={() =>
            void consult(
              `Review ${file?.name} against security, performance, and correctness. Be specific.\n\nLocal hits:\n${
                findings.map((hit) => `- ${hit.rule} @ ${hit.line}: ${hit.message} Fix: ${hit.fix}`).join("\n") || "none"
              }\n\nCode:\n${code.slice(0, 4000)}`,
            )
          }
          className="min-h-11 rounded-2xl bg-primary px-4 text-sm font-semibold text-on-primary disabled:opacity-40"
        >
          Deep review with AI
        </button>
      </div>

      <div className="mt-4 flex gap-2 overflow-x-auto pb-2">
        {samples.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              openFile(item.id);
              setTab("analysis");
            }}
            className={`min-h-11 shrink-0 rounded-full border px-3 text-xs ${item.id === activeFileId ? "border-primary bg-primary text-on-primary" : "border-border text-muted"}`}
          >
            {item.name}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <pre className="os-scroll max-h-[50vh] overflow-auto rounded-3xl border border-border bg-surface p-4 font-mono text-xs leading-5 whitespace-pre-wrap">
          {code || "Open a file."}
        </pre>
        <div className="space-y-3">
          {findings.length === 0 ? (
            <p className="rounded-3xl border border-border bg-surface p-4 text-sm text-muted">
              No doctrine hits in {file?.name ?? "this buffer"}.
            </p>
          ) : (
            findings.map((hit) => (
              <article key={`${hit.rule}-${hit.line}-${hit.message}`} className="rounded-3xl border border-border bg-surface p-4">
                <p className="text-xs font-semibold tracking-widest text-primary uppercase">
                  {hit.severity} · {hit.rule} · line {hit.line}
                </p>
                <p className="mt-2 text-sm">{hit.message}</p>
                <p className="mt-2 text-sm text-muted">{hit.fix}</p>
              </article>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
