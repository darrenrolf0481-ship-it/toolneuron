import { useState } from "react";
import { Check, Loader2, Square, Undo2, Wrench, X } from "lucide-react";
import { useOs } from "@/lib/crimson/store";
import type { AgentState, SwarmFix } from "@/lib/crimson/swarm/engine";
import { AGENT_INFO, REVIEWERS, type AgentId, type Finding } from "@/lib/crimson/swarm/protocol";

const AGENT_ORDER: AgentId[] = ["runner", "archivist", "pattern", "sentry", "wildcard", "patchwright", "guardian"];

const STATUS_LABEL: Record<Finding["status"], string> = { consensus: "Consensus", majority: "Majority", lead: "Lead" };
const VOTE_MARK = { AGREE: "✓", DISPUTE: "✗", ABSTAIN: "–" } as const;

export function SwarmPane() {
  const run = useOs((state) => state.swarmRun);
  const fix = useOs((state) => state.swarmFix);
  const undo = useOs((state) => state.swarmUndo);
  const hot = useOs((state) => state.swarmHot);
  const anxiety = useOs((state) => state.swarmAnxiety);
  const logs = useOs((state) => state.swarmLogs);
  const files = useOs((state) => state.files);
  const activeFileId = useOs((state) => state.activeFileId);
  const runSwarm = useOs((state) => state.runSwarm);
  const stopSwarm = useOs((state) => state.stopSwarm);
  const undoSwarmFix = useOs((state) => state.undoSwarmFix);
  const [goal, setGoal] = useState("");
  const active = files.find((file) => file.id === activeFileId);
  const canRun = active?.type === "file";
  const percent = Math.round(anxiety * 100);

  return (
    <div className="os-scroll flex-1 space-y-4 overflow-y-auto p-4 md:p-5">
      <div>
        <h2 className="text-xl font-semibold">Swarm review</h2>
        <p className="mt-1 text-sm text-muted">
          Three independent reviewers examine <span className="text-fg">{canRun ? active.name : "the open file"}</span>, their
          findings are checked against the real code, then they vote.
        </p>
      </div>

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!hot && canRun) void runSwarm(goal);
        }}
      >
        <label htmlFor="swarm-goal" className="sr-only">
          Review goal
        </label>
        <input
          id="swarm-goal"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          disabled={hot}
          maxLength={300}
          placeholder="Goal (optional): why does this crash on empty input?"
          className="min-h-11 min-w-0 flex-1 basis-60 rounded-2xl border border-border bg-bg px-4 text-sm text-fg outline-none focus:border-primary disabled:opacity-60"
        />
        {hot ? (
          <button
            type="button"
            onClick={stopSwarm}
            className="flex min-h-11 items-center gap-2 rounded-2xl border border-primary px-4 text-sm font-semibold text-primary"
          >
            <Square className="h-3.5 w-3.5 fill-current" />
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canRun}
            className="min-h-11 rounded-2xl bg-primary px-4 text-sm font-semibold text-on-primary disabled:opacity-40"
          >
            Run review
          </button>
        )}
      </form>
      <p className="text-xs text-muted">A review uses 6 AI calls; a fix uses up to 3 more. Nothing is changed without your approval.</p>

      <div>
        <div className="mb-1 flex items-center justify-between text-xs text-muted">
          <span title="Half: reviewers that went silent. Half: disagreement on the findings.">Anxiety (run uncertainty)</span>
          <span className="text-fg">{percent}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-bg" role="meter" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Run uncertainty">
          <div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${percent}%` }} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {AGENT_ORDER.map((id) => (
          <AgentCard key={id} id={id} agent={run.agents[id]} />
        ))}
      </div>

      {(run.phase || run.message) && (
        <p
          role="status"
          className={`rounded-2xl border px-4 py-3 text-sm ${run.status === "error" || run.status === "degraded" ? "border-dashed border-primary/60 text-fg" : "border-border bg-surface-2 text-fg"}`}
        >
          {run.status === "running" ? `${run.phase}…` : run.message}
        </p>
      )}

      {undo && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-surface-2 px-4 py-3 text-sm">
          <span>Fix applied to {undo.fileName}.</span>
          <button type="button" onClick={undoSwarmFix} disabled={hot} className="flex min-h-11 items-center gap-2 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-40">
            <Undo2 className="h-3.5 w-3.5" />
            Undo fix
          </button>
        </div>
      )}

      {run.findings.length > 0 && (
        <ul className="space-y-3" aria-label="Findings">
          {run.findings.map((finding) => (
            <FindingCard key={finding.id} finding={finding} fix={fix?.findingId === finding.id ? fix : null} locked={hot || run.stale || run.status === "running"} stale={run.stale} />
          ))}
        </ul>
      )}

      <details className="rounded-2xl border border-border bg-bg px-4 py-3" open={run.status === "idle"}>
        <summary className="cursor-pointer text-xs font-semibold tracking-widest text-muted uppercase">Swarm log</summary>
        <ul className="mt-3 space-y-2">
          {logs.map((log) => (
            <li key={log.id} className="text-sm">
              <span className={`mr-2 text-[11px] tracking-widest uppercase ${log.type === "pain" ? "text-primary" : "text-muted"}`}>
                {log.time} · {log.type}
              </span>
              {log.message}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function AgentCard({ id, agent }: { id: AgentId; agent: AgentState }) {
  const info = AGENT_INFO[id];
  const working = agent.state === "working";
  const tone =
    working ? "border-primary bg-surface-2" : agent.state === "silent" ? "border-dashed border-primary/60 bg-bg" : "border-border bg-bg";
  return (
    <div className={`rounded-2xl border px-3 py-3 ${tone}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-semibold">{info.name}</p>
        {working ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" aria-label="working" />
        ) : agent.state === "done" ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-muted" aria-label="done" />
        ) : agent.state === "silent" ? (
          <span className="shrink-0 text-[10px] font-semibold tracking-widest text-primary uppercase">Silent</span>
        ) : null}
      </div>
      <p className="text-[11px] tracking-wide text-muted uppercase">
        {info.job}
        {!info.llm && " · no AI"}
      </p>
      <p className="mt-1 min-h-4 truncate text-xs text-fg" title={agent.note}>
        {agent.note}
        {agent.provider && agent.note ? <span className="text-muted"> · {agent.provider}</span> : null}
      </p>
    </div>
  );
}

function FindingCard({ finding, fix, locked, stale }: { finding: Finding; fix: SwarmFix | null; locked: boolean; stale: boolean }) {
  const fixFinding = useOs((state) => state.fixFinding);
  const strong = finding.status !== "lead";
  return (
    <li className="rounded-2xl border border-border bg-bg p-4">
      <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold tracking-widest uppercase">
        <span className={`rounded-full px-2 py-1 ${strong ? "bg-primary text-on-primary" : "border border-border text-muted"}`}>{STATUS_LABEL[finding.status]}</span>
        {finding.crossModel && <span className="rounded-full border border-primary px-2 py-1 text-primary">Cross-model</span>}
        <span className="text-muted">{finding.sev}</span>
        <span className="text-muted">
          {finding.start === finding.end ? `line ${finding.start}` : `lines ${finding.start}-${finding.end}`}
        </span>
        {finding.seenBefore && <span className="text-muted">· flagged before</span>}
      </div>
      <p className="mt-2 text-sm font-semibold">
        {finding.id}. {finding.claim}
      </p>
      {finding.why && <p className="mt-1 text-sm text-muted">{finding.why}</p>}
      <pre className="mt-2 overflow-x-auto rounded-xl bg-surface-2 px-3 py-2 font-mono text-xs text-fg">{finding.quote}</pre>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted" aria-label="Votes">
          {REVIEWERS.map((agent) => {
            const vote = finding.ballots[agent];
            return (
              <span key={agent} className={vote === "AGREE" ? "text-fg" : ""}>
                {AGENT_INFO[agent].name} {vote ? VOTE_MARK[vote] : "·"}
                <span className="sr-only"> {vote ? vote.toLowerCase() : "no vote"}</span>
              </span>
            );
          })}
        </p>
        {!fix && (
          <button
            type="button"
            disabled={locked}
            title={stale ? "Run the swarm again first: the file changed." : "Ask Patchwright for a minimal fix"}
            onClick={() => void fixFinding(finding.id)}
            className="flex min-h-11 items-center gap-2 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-40"
          >
            <Wrench className="h-3.5 w-3.5" />
            Fix this
          </button>
        )}
      </div>
      {fix && <FixPanel fix={fix} />}
    </li>
  );
}

function FixPanel({ fix }: { fix: SwarmFix }) {
  const apply = useOs((state) => state.applySwarmFix);
  const discard = useOs((state) => state.discardSwarmFix);
  const hot = useOs((state) => state.swarmHot);
  const [confirmBreak, setConfirmBreak] = useState(false);
  const needsConfirm = fix.sandbox === "breaks" && !confirmBreak;

  return (
    <div className="mt-3 space-y-3 rounded-2xl border border-border bg-surface-2 p-3">
      {fix.status === "working" && (
        <p className="flex items-center gap-2 text-sm" role="status">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          {fix.step}…
        </p>
      )}
      {fix.message && (
        <p className="text-sm text-fg" role="alert">
          ⚠ {fix.message}
        </p>
      )}
      {fix.edits.length > 0 &&
        fix.edits.map((edit, index) => (
          <div key={index} className="overflow-x-auto rounded-xl bg-bg font-mono text-xs leading-5">
            {edit.find.split("\n").map((line, row) => (
              <div key={`a${row}`} className="px-3 whitespace-pre text-muted line-through decoration-primary/60">
                <span className="mr-2 text-primary no-underline select-none">-</span>
                {line || " "}
              </div>
            ))}
            {edit.replace.split("\n").map((line, row) => (
              <div key={`b${row}`} className="bg-primary/10 px-3 whitespace-pre text-fg">
                <span className="mr-2 select-none">+</span>
                {line || " "}
              </div>
            ))}
          </div>
        ))}
      {fix.status !== "working" && fix.edits.length > 0 && (
        <ul className="space-y-1 text-xs">
          <li>
            <span className="font-semibold">Guardian:</span>{" "}
            {fix.verdict ? `${fix.verdict.approve ? "approved" : "VETOED"}${fix.verdict.reason ? ` — ${fix.verdict.reason}` : ""}` : "did not answer; this fix is unreviewed"}
          </li>
          <li>
            <span className="font-semibold">Sandbox:</span>{" "}
            {fix.sandbox === "clean"
              ? "patched file runs clean"
              : fix.sandbox === "breaks"
                ? "the patched file now FAILS to run (it ran before)"
                : fix.sandbox === "still-failing"
                  ? "the file failed before and still fails (advisory)"
                  : "not run for this file type"}
          </li>
        </ul>
      )}
      {fix.status !== "working" && (
        <div className="flex flex-wrap gap-2">
          {fix.status === "ready" &&
            (needsConfirm ? (
              <button type="button" onClick={() => setConfirmBreak(true)} className="min-h-11 rounded-xl border border-primary px-3 text-xs font-semibold text-primary">
                I understand it breaks the run
              </button>
            ) : (
              <button type="button" disabled={hot} onClick={apply} className="flex min-h-11 items-center gap-2 rounded-xl bg-primary px-3 text-xs font-semibold text-on-primary disabled:opacity-40">
                <Check className="h-3.5 w-3.5" />
                Apply fix
              </button>
            ))}
          <button type="button" disabled={hot} onClick={discard} className="flex min-h-11 items-center gap-2 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-40">
            <X className="h-3.5 w-3.5" />
            {fix.status === "ready" ? "Discard" : "Dismiss"}
          </button>
        </div>
      )}
    </div>
  );
}
