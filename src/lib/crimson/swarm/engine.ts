/**
 * Swarm Review orchestration (browser-only). Design: reviews/swarm-design.md.
 *
 *   Phase 0  Runner (sandbox + analyzer) and Archivist (memory)      free
 *   Phase 1  3 reviewers in parallel, spread across providers        3 calls
 *   Phase 2  quote verification + clustering into F1..F5             free
 *   Phase 3  3 ballots in parallel                                   3 calls
 *   Fix      Patchwright (≤2 calls) → Guardian (1 call) → sandbox    on demand
 *
 * The swarm never edits a file by itself: applyFix runs only on a user tap.
 */
import { listAiProviders } from "../ai.functions";
import { analyzeSource } from "../analyze";
import { runSource } from "../runtime";
import type { OsState } from "../store";
import { streamChat } from "../stream-chat";
import type { SwarmLog } from "../types";
import {
  AGENT_INFO,
  anxiety,
  applyEdits,
  ballotMessage,
  ballotSystem,
  clusterFindings,
  GUARDIAN_SYSTEM,
  guardianMessage,
  parseBallots,
  parseEdits,
  parseFindings,
  parseVerdict,
  PATCHWRIGHT_SYSTEM,
  patchMessage,
  reviewContext,
  reviewerSystem,
  REVIEWERS,
  tally,
  verifyFinding,
  type AgentId,
  type Edit,
  type Finding,
  type RawFinding,
  type ReviewerId,
  type Vote,
} from "./protocol";

const CALL_TIMEOUT_MS = 30_000;
const MEMORY_CAP = 40;

export type AgentState = {
  state: "idle" | "working" | "done" | "silent" | "skipped";
  note: string;
  provider?: string;
};

export type SwarmRun = {
  status: "idle" | "running" | "done" | "clean" | "degraded" | "stopped" | "error";
  phase: string;
  goal: string;
  fileId: string;
  fileName: string;
  language: string;
  /** File content the review was run against. */
  snapshot: string;
  agents: Record<AgentId, AgentState>;
  findings: Finding[];
  message: string;
  calls: number;
  baselineFailed: boolean | null;
  /** True once a fix was applied: line numbers no longer match. */
  stale: boolean;
};

export type SwarmFix = {
  findingId: string;
  status: "working" | "ready" | "vetoed" | "rejected";
  step: string;
  edits: Edit[];
  base: string;
  patched: string;
  verdict: { approve: boolean; reason: string } | null;
  sandbox: "clean" | "breaks" | "still-failing" | "skipped";
  message: string;
};

export type SwarmUndo = { fileId: string; fileName: string; before: string; after: string };
export type SwarmMemory = { file: string; quote: string; claim: string };

type Api = { get: () => OsState; set: (partial: Partial<OsState>) => void };

const idleAgents = (): Record<AgentId, AgentState> =>
  Object.fromEntries((Object.keys(AGENT_INFO) as AgentId[]).map((id) => [id, { state: "idle", note: "" }])) as Record<
    AgentId,
    AgentState
  >;

export const idleRun = (): SwarmRun => ({
  status: "idle",
  phase: "",
  goal: "",
  fileId: "",
  fileName: "",
  language: "",
  snapshot: "",
  agents: idleAgents(),
  findings: [],
  message: "",
  calls: 0,
  baselineFailed: null,
  stale: false,
});

let controller: AbortController | null = null;
let logSeq = 0;

function stamp() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function log(api: Api, type: SwarmLog["type"], message: string) {
  const entry: SwarmLog = { id: Date.now() * 100 + (logSeq++ % 100), type, message, time: stamp() };
  api.set({ swarmLogs: [entry, ...api.get().swarmLogs].slice(0, 30) });
}

function patchRun(api: Api, patch: Partial<SwarmRun>) {
  api.set({ swarmRun: { ...api.get().swarmRun, ...patch } });
}

function patchAgent(api: Api, id: AgentId, patch: Partial<AgentState>) {
  const run = api.get().swarmRun;
  api.set({ swarmRun: { ...run, agents: { ...run.agents, [id]: { ...run.agents[id], ...patch } } } });
}

function patchFix(api: Api, patch: Partial<SwarmFix>) {
  const fix = api.get().swarmFix;
  if (fix) api.set({ swarmFix: { ...fix, ...patch } });
}

type Answer = { ok: true; text: string; /** Provider that answered (may be a fallback). */ provider?: string } | { ok: false; error: string; kind: "rate" | "locked" | "stopped" | "timeout" | "other" };

/** One model call with a 30s limit and one retry on network errors only. */
async function ask(
  api: Api,
  opts: { system: string; user: string; fast: boolean; provider?: string },
  attempt = 0,
): Promise<Answer> {
  const run = controller;
  if (!run || run.signal.aborted) return { ok: false, error: "Stopped.", kind: "stopped" };
  const call = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    call.abort();
  }, CALL_TIMEOUT_MS);
  const onStop = () => call.abort();
  run.signal.addEventListener("abort", onStop);
  patchRun(api, { calls: api.get().swarmRun.calls + 1 });
  try {
    const result = await streamChat(
      { system: opts.system, messages: [{ role: "user", content: opts.user }], fast: opts.fast, provider: opts.provider },
      { signal: call.signal, onDelta: () => undefined },
    );
    if (result.ok) return { ok: true, text: result.text, provider: result.provider };
    if (run.signal.aborted) return { ok: false, error: "Stopped.", kind: "stopped" };
    if (timedOut) return { ok: false, error: `No answer in ${CALL_TIMEOUT_MS / 1000}s.`, kind: "timeout" };
    if (/slow down|limit reached/i.test(result.error)) return { ok: false, error: result.error, kind: "rate" };
    if (/locked|disabled/i.test(result.error)) return { ok: false, error: result.error, kind: "locked" };
    if (attempt === 0 && /link dropped/i.test(result.error)) return ask(api, opts, 1);
    return { ok: false, error: result.error, kind: "other" };
  } finally {
    clearTimeout(timer);
    run.signal.removeEventListener("abort", onStop);
  }
}

async function providerOrder(api: Api): Promise<{ id: string; label: string }[]> {
  const listed = await listAiProviders().catch(() => null);
  const all = listed?.providers ?? [];
  if (all.length === 0) return [];
  const preferred = api.get().provider || listed?.defaultId || all[0].id;
  const first = all.findIndex((item) => item.id === preferred);
  return first <= 0 ? all : [...all.slice(first), ...all.slice(0, first)];
}

const runnable = (language: string) => ["python", "py", "javascript", "js"].includes(language);
const failed = (output: string) => /^\[ERROR\]/m.test(output);

export async function runReview(api: Api, goalInput: string): Promise<void> {
  const state = api.get();
  if (state.swarmHot) return;
  const file = state.files.find((item) => item.id === state.activeFileId);
  const code = state.draft;
  if (!file || file.type !== "file" || !code.trim()) {
    patchRun(api, { ...idleRun(), status: "error", message: "Open a non-empty file in the editor first." });
    return;
  }
  const goal = goalInput.trim() || "Find real problems in this file.";
  const language = file.language ?? "";
  controller = new AbortController();
  const signal = controller.signal;
  api.set({
    swarmHot: true,
    swarmFix: null,
    swarmRun: { ...idleRun(), status: "running", phase: "Gathering evidence", goal, fileId: file.id, fileName: file.name, language, snapshot: code },
  });
  log(api, "info", `Review of ${file.name} started. Goal: ${goal}`);

  try {
    // ---- Phase 0: deterministic evidence ----
    patchAgent(api, "runner", { state: "working", note: "running" });
    const analyzerHits = analyzeSource(code, language);
    const analyzerNotes = analyzerHits.slice(0, 6).map((hit) => `line ${hit.line} (${hit.severity}) ${hit.rule}: ${hit.message}`);
    let runnerOutput = "";
    let baselineFailed: boolean | null = null;
    if (runnable(language)) {
      runnerOutput = await runSource(language, code);
      baselineFailed = failed(runnerOutput);
    }
    if (signal.aborted) throw new Stopped();
    patchRun(api, { baselineFailed });
    patchAgent(api, "runner", {
      state: "done",
      note: `${baselineFailed === null ? "not runnable" : baselineFailed ? "run fails" : "run ok"} · ${analyzerHits.length} analyzer hit${analyzerHits.length === 1 ? "" : "s"}`,
    });

    const memory = api.get().swarmMemory.filter((item) => item.file === file.name);
    const stillPresent = memory.filter((item) => code.includes(item.quote));
    patchAgent(api, "archivist", {
      state: "done",
      note: memory.length === 0 ? "no history" : `${stillPresent.length} past finding${stillPresent.length === 1 ? "" : "s"} still present`,
    });

    const providers = await providerOrder(api);
    if (providers.length === 0) {
      finish(api, "error", "No AI provider is configured on the server.");
      return;
    }
    const context = reviewContext({ goal, fileName: file.name, language, code, runnerOutput, analyzerNotes });
    const providerOf: Partial<Record<ReviewerId, string>> = {};
    REVIEWERS.forEach((agent, index) => {
      providerOf[agent] = providers[index % providers.length].id;
    });
    const labelOf = (agent: ReviewerId) => providers.find((item) => item.id === providerOf[agent])?.label ?? "";

    // ---- Phase 1: independent reviews ----
    patchRun(api, { phase: "Reviewing" });
    const failures: Answer[] = [];
    const reviews = await Promise.all(
      REVIEWERS.map(async (agent) => {
        patchAgent(api, agent, { state: "working", note: "reviewing", provider: labelOf(agent) });
        const answer = await ask(api, { system: reviewerSystem(agent), user: context.message, fast: true, provider: providerOf[agent] });
        if (!answer.ok) {
          failures.push(answer);
          patchAgent(api, agent, { state: "silent", note: answer.error.slice(0, 80) });
          return { agent, silent: true, findings: [] as RawFinding[] };
        }
        if (answer.provider && answer.provider !== providerOf[agent]) {
          // The chosen provider failed and /api/chat fell back. Record who really
          // answered: the tally weighs agreement across different providers.
          providerOf[agent] = answer.provider;
          const actual = providers.find((item) => item.id === answer.provider)?.label ?? answer.provider;
          patchAgent(api, agent, { provider: `${actual} (fallback)` });
        }
        const parsed = parseFindings(agent, answer.text);
        const explicitNone = /NO FINDINGS/i.test(answer.text);
        if (parsed.length === 0 && !explicitNone) {
          patchAgent(api, agent, { state: "silent", note: "unreadable answer" });
          return { agent, silent: true, findings: [] as RawFinding[] };
        }
        const verified = parsed
          .map((item) => verifyFinding(item, code, context.shownLines))
          .filter((item): item is RawFinding => item !== null);
        const dropped = parsed.length - verified.length;
        patchAgent(api, agent, {
          state: "done",
          note: `${verified.length} finding${verified.length === 1 ? "" : "s"}${dropped ? ` · ${dropped} unverified dropped` : ""}`,
        });
        if (dropped) log(api, "pain", `${AGENT_INFO[agent].name}: ${dropped} finding${dropped === 1 ? "" : "s"} dropped (quoted code not in the file).`);
        return { agent, silent: false, findings: verified };
      }),
    );
    const silent = reviews.filter((item) => item.silent).length;
    const raw = reviews.flatMap((item) => item.findings);
    if (signal.aborted) {
      stopWith(api, raw, providerOf, silent);
      return;
    }
    if (silent === REVIEWERS.length) {
      const blocker = failures.find((item) => !item.ok && (item.kind === "locked" || item.kind === "rate"));
      api.set({ swarmAnxiety: anxiety([], silent) });
      finish(api, "error", blocker && !blocker.ok ? blocker.error : "No reviewer answered. Try again in a moment.");
      return;
    }
    const degraded = silent >= 2;

    // ---- Phase 2: cluster ----
    let findings = clusterFindings(raw).map((item) => ({
      ...item,
      seenBefore: stillPresent.some((past) => past.quote === item.quote || item.quote.includes(past.quote) || past.quote.includes(item.quote)),
    }));

    // ---- Phase 3: ballots ----
    const ballots: Partial<Record<ReviewerId, Record<string, Vote>>> = {};
    if (findings.length > 0 && !degraded) {
      patchRun(api, { phase: "Voting", findings });
      const ids = findings.map((item) => item.id);
      const message = ballotMessage(context.message, findings);
      await Promise.all(
        REVIEWERS.map(async (agent) => {
          const before = api.get().swarmRun.agents[agent];
          patchAgent(api, agent, { state: "working", note: "voting", provider: labelOf(agent) });
          const answer = await ask(api, { system: ballotSystem(agent), user: message, fast: true, provider: providerOf[agent] });
          const votes = answer.ok ? parseBallots(answer.text, ids) : {};
          if (Object.keys(votes).length > 0) ballots[agent] = votes;
          const cast = Object.keys(votes).length;
          patchAgent(api, agent, {
            state: before.state === "silent" && cast === 0 ? "silent" : "done",
            note: `${before.state === "silent" ? "no review" : before.note.split(" · ")[0]} · ${cast ? `voted on ${cast}` : "no ballot"}`,
          });
        }),
      );
      if (signal.aborted) {
        stopWith(api, raw, providerOf, silent);
        return;
      }
    }

    findings = tally(findings, ballots, providerOf, degraded);
    const level = anxiety(findings, silent);
    const consensus = findings.filter((item) => item.status === "consensus").length;
    const majority = findings.filter((item) => item.status === "majority").length;

    // Archivist remembers verified findings for next time.
    const remembered: SwarmMemory[] = findings.map((item) => ({ file: file.name, quote: item.quote, claim: item.claim }));
    const others = api.get().swarmMemory.filter((item) => !(item.file === file.name && remembered.some((r) => r.quote === item.quote)));
    api.set({ swarmAnxiety: level, swarmMemory: [...remembered, ...others].slice(0, MEMORY_CAP) });

    if (findings.length === 0) {
      if (degraded) finish(api, "degraded", "Only one reviewer answered and it found nothing. Not enough to call this clean.");
      else finish(api, "clean", `No verified problems. ${REVIEWERS.length - silent} of ${REVIEWERS.length} reviewers reported.`, "consensus");
      return;
    }
    patchRun(api, { findings });
    if (degraded) {
      finish(api, "degraded", "Only one reviewer answered. These are single-agent leads, not consensus.", "pain");
    } else {
      const rest = findings.length - consensus - majority;
      finish(
        api,
        "done",
        `${findings.length} finding${findings.length === 1 ? "" : "s"}: ${consensus} consensus, ${majority} majority, ${rest} lead${rest === 1 ? "" : "s"}.${silent ? " One reviewer was silent." : ""}`,
        consensus > 0 ? "consensus" : "info",
      );
    }
  } catch (error) {
    if (error instanceof Stopped || signal.aborted) finish(api, "stopped", "Swarm halted by user.");
    else finish(api, "error", error instanceof Error ? `Swarm failed: ${error.message}` : "Swarm failed.");
  } finally {
    controller = null;
    api.set({ swarmHot: false });
  }
}

class Stopped extends Error {}

function finish(api: Api, status: SwarmRun["status"], message: string, type: SwarmLog["type"] = status === "error" ? "pain" : "info") {
  const run = api.get().swarmRun;
  const agents = { ...run.agents };
  for (const id of Object.keys(agents) as AgentId[]) {
    if (agents[id].state === "working") agents[id] = { ...agents[id], state: "skipped", note: "halted" };
  }
  api.set({ swarmRun: { ...run, agents, status, phase: "", message } });
  log(api, type, message);
}

/** Stop pressed: keep whatever was already verified, as leads. */
function stopWith(api: Api, raw: RawFinding[], providerOf: Partial<Record<ReviewerId, string>>, silent: number) {
  const partial = tally(clusterFindings(raw), {}, providerOf, true);
  patchRun(api, { findings: partial });
  api.set({ swarmAnxiety: anxiety(partial, Math.max(silent, 2)) });
  finish(api, "stopped", partial.length ? "Swarm halted by user. Partial findings kept as leads." : "Swarm halted by user.");
}

export function stopSwarm() {
  controller?.abort();
}

// ---------- Fix ----------

export async function runFix(api: Api, findingId: string): Promise<void> {
  const state = api.get();
  const run = state.swarmRun;
  const finding = run.findings.find((item) => item.id === findingId);
  if (state.swarmHot || !finding) return;
  const base = state.draft;
  const blank: SwarmFix = { findingId, status: "working", step: "Patchwright is writing a fix", edits: [], base, patched: "", verdict: null, sandbox: "skipped", message: "" };
  if (run.stale || state.activeFileId !== run.fileId || base !== run.snapshot) {
    api.set({ swarmFix: { ...blank, status: "rejected", step: "", message: "The file changed since this review. Run the swarm again before fixing." } });
    return;
  }
  controller = new AbortController();
  const signal = controller.signal;
  api.set({ swarmHot: true, swarmFix: blank });
  patchAgent(api, "patchwright", { state: "working", note: "writing fix" });
  patchAgent(api, "guardian", { state: "idle", note: "" });

  const reject = (message: string) => {
    patchFix(api, { status: "rejected", step: "", message });
    log(api, "pain", `Fix for ${findingId} rejected: ${message}`);
  };

  try {
    const providers = await providerOrder(api);
    if (providers.length === 0) return reject("No AI provider is configured on the server.");
    patchAgent(api, "patchwright", { provider: providers[0].label });

    // Patchwright: up to two attempts, the second with the matcher's feedback.
    let edits: Edit[] = [];
    let patched = "";
    let feedback: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = await ask(api, {
        system: PATCHWRIGHT_SYSTEM,
        user: patchMessage({ fileName: run.fileName, finding, code: base, feedback }),
        fast: false,
        provider: providers[0].id,
      });
      if (signal.aborted) throw new Stopped();
      if (!answer.ok) {
        patchAgent(api, "patchwright", { state: "silent", note: answer.error.slice(0, 80) });
        return reject(answer.error);
      }
      edits = parseEdits(answer.text);
      const applied = applyEdits(base, edits);
      if (applied.ok) {
        patched = applied.code;
        break;
      }
      feedback = applied.error;
      patchAgent(api, "patchwright", { note: attempt === 0 ? "retrying" : "patch did not apply" });
    }
    if (!patched) {
      patchAgent(api, "patchwright", { state: "silent", note: "patch did not apply" });
      return reject(feedback ?? "The patch could not be applied.");
    }
    patchAgent(api, "patchwright", { state: "done", note: `${edits.length} edit${edits.length === 1 ? "" : "s"}` });
    patchFix(api, { edits, patched, step: "Guardian is reviewing the fix" });

    // Guardian: a different provider when there is one.
    const guard = providers[providers.length > 1 ? 1 : 0];
    patchAgent(api, "guardian", { state: "working", note: "reviewing fix", provider: guard.label });
    const review = await ask(api, { system: GUARDIAN_SYSTEM, user: guardianMessage(finding, edits), fast: true, provider: guard.id });
    if (signal.aborted) throw new Stopped();
    const verdict = review.ok ? parseVerdict(review.text) : null;
    patchAgent(api, "guardian", {
      state: verdict ? "done" : "silent",
      note: verdict ? (verdict.approve ? "approved" : "vetoed") : review.ok ? "unreadable verdict" : review.error.slice(0, 80),
    });

    // Sandbox gate: only python/js, "new error where there was none"; advisory if it already failed.
    let sandbox: SwarmFix["sandbox"] = "skipped";
    if (runnable(run.language) && run.baselineFailed !== null) {
      patchFix(api, { verdict, step: "Runner is testing the patched file" });
      patchAgent(api, "runner", { state: "working", note: "testing patch" });
      const after = failed(await runSource(run.language, patched));
      sandbox = !after ? "clean" : run.baselineFailed ? "still-failing" : "breaks";
      patchAgent(api, "runner", { state: "done", note: `patched run: ${sandbox === "clean" ? "ok" : sandbox === "breaks" ? "NEW error" : "still fails"}` });
    }
    if (signal.aborted) throw new Stopped();

    const vetoed = verdict !== null && !verdict.approve;
    patchFix(api, { verdict, sandbox, status: vetoed ? "vetoed" : "ready", step: "" });
    log(
      api,
      vetoed ? "pain" : "consensus",
      vetoed ? `Guardian vetoed the fix for ${findingId}: ${verdict?.reason || "no reason given"}` : `Fix for ${findingId} is ready for your approval.`,
    );
  } catch (error) {
    if (error instanceof Stopped || signal.aborted) {
      api.set({ swarmFix: null });
      log(api, "info", "Fix halted by user.");
    } else {
      reject(error instanceof Error ? error.message : "Fix failed.");
    }
  } finally {
    for (const id of ["patchwright", "guardian", "runner"] as AgentId[]) {
      if (api.get().swarmRun.agents[id].state === "working") patchAgent(api, id, { state: "skipped", note: "halted" });
    }
    controller = null;
    api.set({ swarmHot: false });
  }
}

/** The only place the swarm writes to a file. Called from the user's Apply tap. */
export function applyFix(api: Api): void {
  const state = api.get();
  const fix = state.swarmFix;
  const run = state.swarmRun;
  if (!fix || fix.status !== "ready" || state.swarmHot) return;
  if (state.activeFileId !== run.fileId || state.draft !== fix.base) {
    patchFix(api, { status: "rejected", message: "The file changed after this fix was written. Nothing was applied." });
    return;
  }
  state.setDraft(fix.patched);
  state.flushDraft();
  api.set({
    swarmFix: null,
    swarmUndo: { fileId: run.fileId, fileName: run.fileName, before: fix.base, after: fix.patched },
    swarmRun: { ...api.get().swarmRun, stale: true, snapshot: fix.patched, message: `Applied the fix for ${fix.findingId}. Run the swarm again to re-check the file.` },
  });
  log(api, "consensus", `You applied the fix for ${fix.findingId} to ${run.fileName}.`);
}

export function undoFix(api: Api): void {
  const state = api.get();
  const undo = state.swarmUndo;
  if (!undo || state.swarmHot) return;
  if (state.activeFileId !== undo.fileId || state.draft !== undo.after) {
    api.set({ swarmUndo: null });
    patchRun(api, { message: `Undo is no longer possible: ${undo.fileName} was edited or closed after the fix.` });
    return;
  }
  state.setDraft(undo.before);
  state.flushDraft();
  api.set({ swarmUndo: null });
  patchRun(api, { message: "Fix undone. The file is back to how it was." });
  log(api, "info", `Fix on ${undo.fileName} undone.`);
}
