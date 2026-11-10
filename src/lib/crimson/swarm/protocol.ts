/**
 * Swarm Review protocol: prompts, plain-text parsing, quote verification,
 * clustering, ballots, the anxiety metric and search/replace edits.
 * Pure functions only (no DOM, no network) so they can be unit-tested.
 * Design: reviews/swarm-design.md.
 */

export type Severity = "high" | "medium" | "low";
export type Vote = "AGREE" | "DISPUTE" | "ABSTAIN";
export type ReviewerId = "pattern" | "sentry" | "wildcard";
export type AgentId = ReviewerId | "patchwright" | "guardian" | "runner" | "archivist";

export const REVIEWERS: ReviewerId[] = ["pattern", "sentry", "wildcard"];

export const AGENT_INFO: Record<AgentId, { name: string; job: string; llm: boolean }> = {
  runner: { name: "Runner", job: "Sandbox + analyzer", llm: false },
  archivist: { name: "Archivist", job: "Past findings", llm: false },
  pattern: { name: "Pattern-Seer", job: "Logic & performance", llm: true },
  sentry: { name: "Sentry", job: "Security", llm: true },
  wildcard: { name: "Wildcard", job: "Dissent & blind spots", llm: true },
  patchwright: { name: "Patchwright", job: "Writes the fix", llm: true },
  guardian: { name: "Guardian", job: "Vetoes bad fixes", llm: true },
};

const FOCUS: Record<ReviewerId, string> = {
  pattern:
    "logic bugs, off-by-one errors, wrong conditions, unhandled cases, crashes, performance problems and structural mistakes",
  sentry:
    "security: injection, unsafe handling of untrusted input, dangerous sinks, secrets in code, missing validation, unsafe defaults",
  wildcard:
    "what a logic reviewer and a security reviewer are likely to miss: edge cases, wrong assumptions, misleading names, silent failures, missing error handling. Be skeptical and independent",
};

export const MAX_CODE_CHARS = 4300;
export const MAX_FINDINGS_PER_AGENT = 3;
export const MAX_FINDINGS = 5;
const LINE_TOLERANCE = 2;

export type RawFinding = {
  agent: ReviewerId;
  start: number;
  end: number;
  sev: Severity;
  quote: string;
  claim: string;
  why: string;
};

export type Finding = {
  id: string;
  start: number;
  end: number;
  sev: Severity;
  quote: string;
  claim: string;
  why: string;
  raisedBy: ReviewerId[];
  ballots: Partial<Record<ReviewerId, Vote>>;
  status: "consensus" | "majority" | "lead";
  crossModel: boolean;
  seenBefore: boolean;
};

// ---------- code context ----------

/** Line-numbered view of the file, cut at whole lines to fit the message cap. */
export function numberCode(code: string, maxChars = MAX_CODE_CHARS): { text: string; shownLines: number; totalLines: number } {
  const lines = code.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    const row = `${i + 1}| ${lines[i]}`;
    if (size + row.length + 1 > maxChars) break;
    out.push(row);
    size += row.length + 1;
  }
  return { text: out.join("\n"), shownLines: out.length, totalLines: lines.length };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function reviewContext(input: {
  goal: string;
  fileName: string;
  language: string;
  code: string;
  runnerOutput: string;
  analyzerNotes: string[];
}): { message: string; shownLines: number; totalLines: number } {
  const numbered = numberCode(input.code);
  const evidence: string[] = [];
  if (input.runnerOutput) evidence.push(`Sandbox run output:\n${clip(input.runnerOutput, 500)}`);
  if (input.analyzerNotes.length) evidence.push(`Static analyzer notes:\n${clip(input.analyzerNotes.join("\n"), 400)}`);
  const truncated =
    numbered.shownLines < numbered.totalLines
      ? `\n(Only lines 1-${numbered.shownLines} of ${numbered.totalLines} are shown. Review only what is shown.)`
      : "";
  const message = [
    `GOAL: ${clip(input.goal, 300)}`,
    `FILE: ${input.fileName} (${input.language || "text"})`,
    evidence.length ? evidence.join("\n\n") : "",
    `CODE (each line is prefixed with its number and "| "):${truncated}\n${numbered.text}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { message, shownLines: numbered.shownLines, totalLines: numbered.totalLines };
}

// ---------- prompts ----------

export function reviewerSystem(agent: ReviewerId): string {
  return `You are ${AGENT_INFO[agent].name}, one of three independent code reviewers in a review swarm.
Your focus: ${FOCUS[agent]}.
Report at most ${MAX_FINDINGS_PER_AGENT} REAL problems in the code that matter for the GOAL. Do not invent problems. Do not report style nitpicks.
Output ONLY finding blocks in exactly this format, with no other text before, between or after them:

<<<FINDING
LINES: 12-14
SEV: high
QUOTE: a short exact snippet copied from those lines, on one line, without the line-number prefix
CLAIM: one sentence stating the problem
WHY: at most two sentences of evidence
>>>

SEV is one of: high, medium, low. LINES is a single number or a range.
If there is no real problem, output exactly: NO FINDINGS`;
}

export function ballotSystem(agent: ReviewerId): string {
  return `You are ${AGENT_INFO[agent].name}, a code reviewer in a review swarm. Your focus: ${FOCUS[agent]}.
You are given findings (F1, F2, ...) raised about the code. Judge each one independently against the code itself.
Vote AGREE if it is a real problem as stated, DISPUTE if it is wrong, not actually in the code, or not a real problem, ABSTAIN if you cannot tell.
Output ONLY one line per finding, in exactly this format, and nothing else:
F1: AGREE - reason in at most 12 words`;
}

export function ballotMessage(context: string, findings: Finding[]): string {
  const list = findings
    .map((f) => `${f.id} (lines ${f.start}-${f.end}, ${f.sev}): ${clip(f.claim, 200)}\n   quoted code: ${clip(f.quote, 120)}`)
    .join("\n");
  return clip(`FINDINGS TO JUDGE:\n${list}\n\n${context}`, 5900);
}

export const PATCHWRIGHT_SYSTEM = `You are Patchwright. You write the smallest possible fix for ONE reported problem in a file.
Output ONLY edit blocks in exactly this format, with no other text:

<<<EDIT
FIND:
the exact existing lines to replace, copied character-for-character including indentation
REPLACE:
the new lines
>>>

Rules: FIND must appear exactly once in the file, so include enough surrounding lines to be unique, but keep it short (under 400 characters). Never include line-number prefixes. Change only what the fix needs. Use at most 3 edit blocks. Do not rewrite the whole file.`;

export const GUARDIAN_SYSTEM = `You are Guardian. You review a proposed code edit before the user sees it.
VETO if the edit does not fix the stated problem, introduces a bug, removes unrelated behaviour, or adds anything unsafe. Otherwise APPROVE.
Output ONLY this block and nothing else:

<<<VERDICT: APPROVE
REASON: one line
>>>

(Use VETO instead of APPROVE to block it.)`;

/** Raw (un-numbered) code around the finding for Patchwright. FIND must match this text. */
export function patchContext(code: string, finding: Pick<Finding, "start" | "end">, maxChars = 4200): string {
  if (code.length <= maxChars) return code;
  const lines = code.split("\n");
  let from = Math.max(0, finding.start - 1);
  let to = Math.min(lines.length, finding.end);
  let size = lines.slice(from, to).join("\n").length;
  for (;;) {
    let grew = false;
    if (from > 0 && size + lines[from - 1].length + 1 <= maxChars) {
      from--;
      size += lines[from].length + 1;
      grew = true;
    }
    if (to < lines.length && size + lines[to].length + 1 <= maxChars) {
      size += lines[to].length + 1;
      to++;
      grew = true;
    }
    if (!grew) break;
  }
  return lines.slice(from, to).join("\n");
}

export function patchMessage(input: {
  fileName: string;
  finding: Finding;
  code: string;
  feedback?: string;
}): string {
  const body = patchContext(input.code, input.finding);
  const partial = body.length < input.code.length ? " (an excerpt around the problem)" : "";
  return [
    `PROBLEM (${input.finding.sev}, around lines ${input.finding.start}-${input.finding.end}): ${input.finding.claim}`,
    `EVIDENCE: ${clip(input.finding.why, 300)}`,
    input.feedback ? `YOUR PREVIOUS ATTEMPT WAS REJECTED: ${input.feedback}` : "",
    `FILE ${input.fileName}${partial}:\n${body}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function guardianMessage(finding: Finding, edits: Edit[]): string {
  const shown = edits
    .map((edit, index) => `EDIT ${index + 1}\n--- before\n${clip(edit.find, 900)}\n+++ after\n${clip(edit.replace, 900)}`)
    .join("\n\n");
  return clip(`PROBLEM TO FIX (lines ${finding.start}-${finding.end}): ${finding.claim}\n\nPROPOSED EDIT:\n${shown}`, 5900);
}

// ---------- parsing ----------

function field(block: string, name: string): string {
  const match = block.match(new RegExp(`^\\s*${name}\\s*:\\s*(.*)$`, "im"));
  return match ? match[1].trim() : "";
}

function cleanQuote(raw: string): string {
  let q = raw.trim();
  q = q.replace(/^\d+\|\s?/, ""); // stray line-number prefix
  const wrapped = q.match(/^(`+|"|')([\s\S]*)\1$/);
  if (wrapped) q = wrapped[2].trim();
  return q;
}

/** Parses complete <<<FINDING … >>> blocks. A block without its closer is ignored. */
export function parseFindings(agent: ReviewerId, text: string): RawFinding[] {
  const out: RawFinding[] = [];
  const blocks = text.matchAll(/<<<\s*FINDING\s*\n([\s\S]*?)\n?\s*>>>/g);
  for (const match of blocks) {
    const body = match[1];
    const lines = field(body, "LINES").match(/(\d+)(?:\s*[-–—to]+\s*(\d+))?/);
    const claim = field(body, "CLAIM");
    const quote = cleanQuote(field(body, "QUOTE"));
    if (!lines || !claim || !quote) continue;
    const a = Number(lines[1]);
    const b = lines[2] ? Number(lines[2]) : a;
    const sevRaw = field(body, "SEV").toLowerCase();
    const sev: Severity = sevRaw.startsWith("h") || sevRaw.startsWith("crit") ? "high" : sevRaw.startsWith("l") ? "low" : "medium";
    out.push({
      agent,
      start: Math.min(a, b),
      end: Math.max(a, b),
      sev,
      quote: quote.slice(0, 300),
      claim: claim.slice(0, 400),
      why: field(body, "WHY").slice(0, 600),
    });
    if (out.length >= MAX_FINDINGS_PER_AGENT) break;
  }
  return out;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Hallucination filter. Keeps a finding only if its QUOTE really appears in
 * the file: first within ±2 lines of the cited range, otherwise anywhere in
 * the shown code (then the line range is corrected to where it was found).
 */
export function verifyFinding(finding: RawFinding, code: string, shownLines: number): RawFinding | null {
  const lines = code.replace(/\r\n?/g, "\n").split("\n").slice(0, shownLines);
  const needle = squash(finding.quote);
  if (needle.length < 3) return null;
  const from = Math.max(1, finding.start - LINE_TOLERANCE);
  const to = Math.min(lines.length, finding.end + LINE_TOLERANCE);
  if (from <= to && squash(lines.slice(from - 1, to).join("\n")).includes(needle)) {
    return { ...finding, start: Math.max(1, Math.min(finding.start, lines.length)), end: Math.min(finding.end, lines.length) };
  }
  // Miscounted lines: relocate to the first single line (or 3-line window) containing the quote.
  for (let span = 1; span <= 3; span++) {
    for (let i = 0; i + span <= lines.length; i++) {
      if (squash(lines.slice(i, i + span).join("\n")).includes(needle)) {
        return { ...finding, start: i + 1, end: i + span };
      }
    }
  }
  return null;
}

const SEV_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

/** Merges findings whose line ranges overlap (±2), then keeps the top MAX_FINDINGS as F1..Fn. */
export function clusterFindings(raw: RawFinding[]): Finding[] {
  const sorted = [...raw].sort((a, b) => a.start - b.start || a.end - b.end);
  const clusters: { start: number; end: number; items: RawFinding[] }[] = [];
  for (const item of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && item.start <= last.end + LINE_TOLERANCE) {
      last.end = Math.max(last.end, item.end);
      last.items.push(item);
    } else {
      clusters.push({ start: item.start, end: item.end, items: [item] });
    }
  }
  const merged = clusters.map((cluster) => {
    const lead = [...cluster.items].sort((a, b) => SEV_RANK[b.sev] - SEV_RANK[a.sev])[0];
    const raisedBy = [...new Set(cluster.items.map((item) => item.agent))];
    return { lead, raisedBy, start: cluster.start, end: cluster.end };
  });
  merged.sort((a, b) => b.raisedBy.length - a.raisedBy.length || SEV_RANK[b.lead.sev] - SEV_RANK[a.lead.sev] || a.start - b.start);
  return merged.slice(0, MAX_FINDINGS).map((item, index) => ({
    id: `F${index + 1}`,
    start: item.start,
    end: item.end,
    sev: item.lead.sev,
    quote: item.lead.quote,
    claim: item.lead.claim,
    why: item.lead.why,
    raisedBy: item.raisedBy,
    ballots: {},
    status: "lead",
    crossModel: false,
    seenBefore: false,
  }));
}

export function parseBallots(text: string, ids: string[]): Record<string, Vote> {
  const out: Record<string, Vote> = {};
  for (const match of text.matchAll(/\b(F\d+)\b[\s:*\-–—]*(AGREE|DISPUTE|ABSTAIN)/gi)) {
    const id = match[1].toUpperCase();
    if (ids.includes(id) && !(id in out)) out[id] = match[2].toUpperCase() as Vote;
  }
  return out;
}

/**
 * Final votes per finding. An agent that raised a finding but cast no ballot
 * for it counts as AGREE. `degraded` (≥2 reviewers silent) forbids consensus claims.
 */
export function tally(
  findings: Finding[],
  ballots: Partial<Record<ReviewerId, Record<string, Vote>>>,
  providerOf: Partial<Record<ReviewerId, string>>,
  degraded: boolean,
): Finding[] {
  const ranked = findings.map((finding) => {
    const votes: Partial<Record<ReviewerId, Vote>> = {};
    for (const agent of REVIEWERS) {
      const cast = ballots[agent]?.[finding.id];
      if (cast) votes[agent] = cast;
      else if (finding.raisedBy.includes(agent)) votes[agent] = "AGREE";
    }
    const agreeing = REVIEWERS.filter((agent) => votes[agent] === "AGREE");
    const disputes = REVIEWERS.filter((agent) => votes[agent] === "DISPUTE").length;
    const status: Finding["status"] =
      degraded || agreeing.length < 2 ? "lead" : disputes === 0 ? "consensus" : "majority";
    const providers = new Set(agreeing.map((agent) => providerOf[agent]).filter(Boolean));
    return { ...finding, ballots: votes, status, crossModel: status !== "lead" && providers.size >= 2 };
  });
  const order = { consensus: 0, majority: 1, lead: 2 };
  return ranked.sort(
    (a, b) => order[a.status] - order[b.status] || SEV_RANK[b.sev] - SEV_RANK[a.sev] || a.start - b.start,
  );
}

/** Run uncertainty: half silent reviewers, half disagreement on the findings. 0.02..0.98. */
export function anxiety(findings: Finding[], silentReviewers: number): number {
  const disagreement =
    findings.length === 0
      ? 0
      : findings.reduce((sum, finding) => {
          const cast = Object.values(finding.ballots);
          if (cast.length === 0) return sum + 1;
          return sum + (1 - cast.filter((vote) => vote === "AGREE").length / cast.length);
        }, 0) / findings.length;
  const value = 0.5 * (silentReviewers / REVIEWERS.length) + 0.5 * disagreement;
  return Math.min(0.98, Math.max(0.02, Number(value.toFixed(3))));
}

// ---------- edits ----------

export type Edit = { find: string; replace: string };

export function parseEdits(text: string): Edit[] {
  const out: Edit[] = [];
  for (const match of text.matchAll(/<<<\s*EDIT\s*\n\s*FIND:[ \t]*\n([\s\S]*?)\n[ \t]*REPLACE:[ \t]*\n?([\s\S]*?)\n?[ \t]*>>>/g)) {
    const find = match[1].replace(/\r\n?/g, "\n");
    const replace = match[2].replace(/\r\n?/g, "\n");
    if (find.trim()) out.push({ find, replace });
    if (out.length >= 3) break;
  }
  return out;
}

function count(haystack: string, needle: string): number {
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) n++;
  return n;
}

/** Applies edits whitespace-exact. Every FIND must match exactly once, or the whole patch is rejected. */
export function applyEdits(code: string, edits: Edit[]): { ok: true; code: string } | { ok: false; error: string } {
  if (edits.length === 0) return { ok: false, error: "No edit block was returned." };
  let next = code;
  for (let i = 0; i < edits.length; i++) {
    const { find, replace } = edits[i];
    if (find.length > 400) return { ok: false, error: `Edit ${i + 1}: FIND is longer than 400 characters.` };
    if (find === replace) return { ok: false, error: `Edit ${i + 1}: REPLACE is identical to FIND.` };
    const hits = count(next, find);
    if (hits === 0) return { ok: false, error: `Edit ${i + 1}: FIND text was not found in the file (it must match exactly, including indentation).` };
    if (hits > 1) return { ok: false, error: `Edit ${i + 1}: FIND text matches ${hits} places; include more surrounding lines so it is unique.` };
    next = next.replace(find, () => replace);
  }
  return { ok: true, code: next };
}

export function parseVerdict(text: string): { approve: boolean; reason: string } | null {
  const match = text.match(/VERDICT\s*:\s*\**\s*(APPROVE|VETO)/i);
  if (!match) return null;
  const reason = text.match(/REASON\s*:\s*(.*)/i);
  return { approve: match[1].toUpperCase() === "APPROVE", reason: (reason ? reason[1] : "").replace(/>>>\s*$/, "").trim().slice(0, 300) };
}
