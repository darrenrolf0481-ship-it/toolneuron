/**
 * Skill cards for the personas ("modes").
 *
 * Each card condenses one skill from sickn33/agentic-awesome-skills
 * (snapshot 55d9399, 2026-11-09) into rules a chat-only assistant can apply.
 * The upstream SKILL.md files are 2-22 KB and assume tools (shell, browser,
 * subagents); these are rewritten summaries, not copies. Credits and licenses
 * are listed per card and shown in Config → Skills.
 *
 * Upstream content: CC BY 4.0 (repo docs) or MIT (code and the upstream
 * repos named in `upstream`), per the repo's LICENSE, LICENSE-CONTENT and
 * docs/sources/sources.md.
 */

export type Skill = {
  id: string;
  name: string;
  /** One line shown in the UI. */
  summary: string;
  /** Injected into the system prompt when the skill is applied. Keep under 700 chars. */
  rules: string;
  /** Lower-case keywords / regex fragments that make this skill relevant to a message. */
  triggers: string[];
  license: "CC BY 4.0" | "MIT";
  upstream?: string;
};

export const SKILLS_REPO = "https://github.com/sickn33/agentic-awesome-skills";
export const SKILLS_SNAPSHOT = "55d9399";
export const skillUrl = (id: string) => `${SKILLS_REPO}/tree/${SKILLS_SNAPSHOT}/skills/${id}`;

const list: Skill[] = [
  // ---- Architect ----
  {
    id: "architecture",
    name: "Architecture decisions",
    summary: "Start simple; every decision gets a trade-off and a simpler alternative.",
    rules:
      "Start with the simplest design that meets the stated requirements; add a pattern only when a real requirement forces it, because removing complexity is far harder than adding it. For each significant decision state: the constraint driving it, the options considered, the trade-off, and why the simpler alternative is not enough. Suggest recording significant decisions as a short ADR (context, decision, consequences).",
    triggers: ["architect", "design", "structure", "pattern", "decision", "adr", "trade-off", "tradeoff", "scale", "monolith", "microservice"],
    license: "CC BY 4.0",
  },
  {
    id: "codebase-design",
    name: "Deep modules",
    summary: "Small interfaces hiding real complexity; seams only where something varies.",
    rules:
      "Judge a module by its interface: a deep module hides a lot behind a small surface; a shallow one makes callers learn nearly as much as it does. Deletion test: if deleting a module just moves its complexity to N callers, it earned its place; if complexity vanishes, it was a pass-through. Add a seam only when two real adapters exist. For testability: accept dependencies instead of creating them, return results instead of causing side effects, keep the surface small.",
    triggers: ["module", "interface", "abstraction", "seam", "coupling", "testab", "api design", "refactor", "split", "wrapper"],
    license: "CC BY 4.0",
  },
  {
    id: "code-refactoring-tech-debt",
    name: "Technical debt triage",
    summary: "Inventory debt with numbers, then fix the costliest bounded piece first.",
    rules:
      "Inventory debt concretely: duplicated logic (where, how many lines), complexity hot spots (functions over ~50 lines, nesting over 3 levels, cyclomatic complexity over ~10, classes over ~500 lines), circular or leaky dependencies, missing tests on changed code. Estimate impact as how often the code changes times how painful it is. Recommend the single highest-value bounded refactor first, with a safety net (tests) before touching behavior.",
    triggers: ["debt", "messy", "cleanup", "clean up", "legacy", "duplicat", "complex", "refactor", "maintain", "rewrite"],
    license: "CC BY 4.0",
  },
  {
    id: "improve-codebase-architecture",
    name: "Deepening opportunities",
    summary: "Find shallow modules and leaky seams; rank each change Strong / Worth exploring / Speculative.",
    rules:
      "Look for friction: understanding one concept requires bouncing between many small modules; interfaces nearly as complex as their implementation; logic extracted only for tests while bugs hide in the call sites; tightly coupled modules leaking across seams; untested code that is hard to test through its interface. For each candidate give files, problem, proposed change, benefit (locality and leverage), and a strength label: Strong, Worth exploring, or Speculative.",
    triggers: ["improve", "architecture", "friction", "hard to change", "where to start", "codebase", "sketch a tighter module", "tighter"],
    license: "CC BY 4.0",
  },

  // ---- Syntax-Prime ----
  {
    id: "systematic-debugging",
    name: "Systematic debugging",
    summary: "No fix before a root cause: read, reproduce, hypothesize, verify.",
    rules:
      "Iron law: find the root cause before proposing a fix. 1) Read the error and stack trace completely: line numbers, codes, messages. 2) Find a reliable reproduction. 3) Check what changed recently. 4) State one hypothesis and the smallest experiment that would confirm or kill it. 5) Fix the cause, not the symptom, and say how to verify. If two fixes have already failed, stop patching and re-examine the assumptions.",
    triggers: ["bug", "error", "crash", "fail", "broken", "traceback", "exception", "doesn't work", "not working", "debug", "why does", "wrong output", "fix"],
    license: "CC BY 4.0",
  },
  {
    id: "tdd",
    name: "Test-driven development",
    summary: "One behaviour-level test at a time, red → green → refactor.",
    rules:
      "Work in vertical slices: one failing test for one observable behavior, the minimum code to pass it, then refactor. Test behavior through the public interface, not internal structure, so tests survive refactors and fail when behavior breaks. Do not write a batch of tests for imagined behavior up front. After green: remove duplication and push complexity behind simple interfaces.",
    triggers: ["test", "tdd", "unit test", "pytest", "jest", "coverage", "spec", "assert", "regression"],
    license: "CC BY 4.0",
  },
  {
    id: "security-and-hardening",
    name: "Security hardening",
    summary: "Map trust boundaries, run STRIDE, validate every input at the edge.",
    rules:
      "Before code: map trust boundaries (requests, forms, uploads, webhooks, third-party responses), name the assets, and run STRIDE over each boundary (spoofing, tampering, repudiation, information disclosure, denial of service, elevation of privilege). Always: validate external input at the boundary, parameterize every query, encode output for its context, check authorization on every action, keep secrets out of code and logs, return generic errors. Write the abuse case next to each use case.",
    triggers: ["secur", "harden", "inject", "sanitiz", "validat", "auth", "xss", "csrf", "sql", "input", "untrusted", "stride"],
    license: "MIT",
    upstream: "addyosmani/agent-skills",
  },

  // ---- Vanguard ----
  {
    id: "prompt-engineer",
    name: "Prompt structuring",
    summary: "Turn a vague ask into a structured prompt (role, task, context, format, constraints).",
    rules:
      "Classify the ask (type, complexity, what is missing), then rebuild it with a fitting framework: RTF (role, task, format) for simple asks; RISEN (role, instructions, steps, end goal, narrowing) for multi-step ones; add explicit constraints and an output format. Fill gaps with stated assumptions instead of inventing facts. Return the improved prompt first, then a one-line note on what changed.",
    triggers: ["prompt", "rewrite", "sharpen", "improve this", "wording", "phrase"],
    license: "CC BY 4.0",
  },
  {
    id: "visual-emotion-engineer",
    name: "Visual direction",
    summary: "Pick the emotion first; color, contrast and composition follow from it.",
    rules:
      "Name the emotional goal and audience before style words. Calm: restrained emphasis, clear hierarchy, generous negative space. Trust: restrained color, transparent structure, realistic imagery. Urgency: higher contrast, tighter focal point. Prestige: minimalism, controlled spacing. Warmth: softer hues, human subjects. Do not assume color meanings are universal across cultures. Reduce visual noise for novices; support precise scanning for experts.",
    triggers: ["mood", "feel", "emotion", "color", "colour", "palette", "tone", "vibe", "style", "brand", "atmosphere"],
    license: "CC BY 4.0",
  },
  {
    id: "canvas-design",
    name: "Composition craft",
    summary: "Space, form, scale and hierarchy carry the image; text and clutter stay minimal.",
    rules:
      "Build the image from composition: one clear focal subject, deliberate use of space and form, scale and rhythm, balance, and a visual hierarchy the eye can follow. Mention each design aspect once instead of repeating it. Keep text minimal and integrated. Preserve every constraint in the brief (content, dimensions, brand, accessibility). Push for a crafted, intentional result rather than generic polish.",
    triggers: ["image", "composition", "frame", "lens", "light", "lighting", "shot", "scene", "poster", "still", "render", "negative prompt", "subject"],
    license: "CC BY 4.0",
  },

  // ---- Aegis ----
  {
    id: "secrets-management",
    name: "Secrets management",
    summary: "Secrets live in a protected store, rotate safely, and never reach logs.",
    rules:
      "Keep secrets in the platform's secret store or environment, never in source, chat or client bundles. Prefer short-lived credentials. Rotate in four steps: prepare the new secret, switch consumers, verify, revoke the old one. Deleting a leaked log line is not remediation: rotate the exposed credential. Test logs and error paths with a fake secret marker and confirm it never appears. Missing credentials must fail closed without printing values.",
    triggers: ["secret", "key", "token", "password", "credential", "env", "rotate", "leak", "vault", "logged", "log"],
    license: "CC BY 4.0",
  },
  {
    id: "client-secret-exposure-audit",
    name: "Client-side exposure",
    summary: "What a browser bundle or public file leaks, ranked by severity.",
    rules:
      "Anything shipped to the browser is public: JS bundles, source maps, HTML, public config files. Rank findings: Critical = live secret keys (sk_live, cloud access key + secret, DB URL with password, signing secrets); High = exposed server source/config/deploy files, test-mode secret keys, webhook secrets; Medium = missing security headers where they matter; Low = public keys and analytics IDs that are meant to be public. Fix by moving the secret server-side and rotating it.",
    triggers: ["bundle", "frontend", "browser", "client", "exposed", "public", "source map", "review this for secrets", "leak", "vite_"],
    license: "CC BY 4.0",
  },
  {
    id: "privacy-by-design",
    name: "Privacy by design",
    summary: "Collect less, keep it shorter, default to private, explain it plainly.",
    rules:
      "Data minimization: collect only what the feature needs. Purpose limitation: use data only for the stated reason. Storage limitation: set a retention period and delete on schedule. Private by default: opt-in for tracking and sharing. Encrypt in transit and at rest. Be transparent about what is stored and why. Build user rights in: access, correction, deletion, and export in a machine-readable format.",
    triggers: ["privacy", "personal data", "pii", "gdpr", "user data", "tracking", "analytics", "retention", "consent", "what stays out"],
    license: "CC BY 4.0",
  },

  // ---- HackMentor ----
  {
    id: "threat-modeling-expert",
    name: "Threat modeling",
    summary: "Scope, data flows, assets and entry points, then STRIDE and ranked mitigations.",
    rules:
      "Teach threat modeling step by step: define scope and trust boundaries; sketch the data flow; list assets and entry points; apply STRIDE to each component; rank threats by likelihood times impact; map each top threat to a concrete control and a test that proves it. Stay defensive: explain how a weakness fails and how to close it, never how to weaponize it.",
    triggers: ["threat", "model", "attack surface", "risk", "stride", "threat-model", "what could go wrong"],
    license: "CC BY 4.0",
  },
  {
    id: "frontend-mobile-security-xss-scan",
    name: "XSS prevention",
    summary: "Find DOM sinks, explain the failure, apply the safe alternative.",
    rules:
      "Dangerous sinks: innerHTML, outerHTML, insertAdjacentHTML, document.write, dangerouslySetInnerHTML, javascript: and data: URLs in href/src, and eval-like APIs. Prevention: prefer textContent; sanitize with DOMPurify when HTML is truly required; validate URLs with the URL constructor and allow only http(s); rely on framework auto-escaping and never bypass it with untrusted data; add a Content-Security-Policy as defense in depth.",
    triggers: ["xss", "innerhtml", "html", "dom", "script", "sanitiz", "escape", "csp", "unsafe"],
    license: "CC BY 4.0",
  },
  {
    id: "prompt-injection-defense",
    name: "Prompt-injection defense",
    summary: "Instruction hierarchy, untrusted text kept apart, least-privilege tools.",
    rules:
      "For LLM features: enforce an instruction hierarchy (system > developer > user > tool or document text); keep untrusted content (files, web pages, tool output) clearly delimited and never treat it as instructions; give tools an explicit allow-list per task; validate model output against a schema and redact secrets before display; require human approval for high-impact actions. Watch for multi-turn drift and injected markup in rendered output.",
    triggers: ["prompt injection", "llm", "ai feature", "agent", "jailbreak", "model output", "rag", "chatbot", "tool call"],
    license: "MIT",
    upstream: "BagelHole/DevOps-Security-Agent-Skills",
  },

  // ---- Data Analyst ----
  {
    id: "performance-profiling",
    name: "Profiling workflow",
    summary: "Baseline → identify → fix → validate; Core Web Vitals for the web.",
    rules:
      "Four steps: measure a baseline, identify the single biggest bottleneck with a profiler, make one targeted change, re-measure to validate. Never optimize without a number. For web pages use Core Web Vitals: LCP good under 2.5 s, INP good under 200 ms, CLS good under 0.1. Choose the tool by problem: CPU profiler for slow compute, network panel for loading, memory snapshots for leaks, query plans for databases.",
    triggers: ["slow", "profil", "measure", "benchmark", "latency", "lcp", "inp", "web vitals", "fast", "speed", "where is this slow"],
    license: "CC BY 4.0",
  },
  {
    id: "performance-optimizer",
    name: "Common optimizations",
    summary: "The usual suspects: N+1 queries, missing indexes, wasted work, big payloads.",
    rules:
      "Check the usual suspects in order: database (N+1 queries, missing indexes, unbounded result sets), API (missing caching, chatty calls, oversized payloads), frontend (bundle size, render blocking, unnecessary re-renders), algorithm (accidental O(n^2), repeated work that could be memoized), memory (leaks, large retained objects). Keep behavior identical, benchmark under the same conditions before and after, and report the measured gain.",
    triggers: ["optimiz", "n+1", "query", "index", "cache", "memory", "cpu", "loop", "bottleneck", "performance"],
    license: "CC BY 4.0",
  },
  {
    id: "performance-engineer",
    name: "Performance goals & guardrails",
    summary: "Agree the metric and target first; add a guardrail so it cannot regress.",
    rules:
      "Start from the user impact: which metric (latency percentile, throughput, cost, memory) and what target. Collect evidence (traces, profiles, load tests) before proposing changes, give each proposal an expected impact and its trade-off, then verify. Add a guardrail (benchmark in CI, budget, alert) so the gain cannot silently regress. Do not load-test production without approval; use staged rollouts with a rollback plan.",
    triggers: ["metric", "target", "throughput", "p95", "p99", "load", "capacity", "cost", "what should i measure", "kpi"],
    license: "CC BY 4.0",
  },

  // ---- Scribe ----
  {
    id: "documentation-templates",
    name: "README structure",
    summary: "One-liner, quick start under 5 minutes, features, config table, links.",
    rules:
      "README order: title and one-line description; Quick Start that gets someone running in under five minutes; features; configuration as a table (variable, description, default); links to deeper docs (API, architecture); contributing; license. Docstrings: what it does, parameters, return value, errors raised, one short example for public APIs. Comments explain why, not what.",
    triggers: ["readme", "document", "docs", "docstring", "write up", "guide", "onboard", "usage"],
    license: "CC BY 4.0",
  },
  {
    id: "docs-guard",
    name: "Accurate docs",
    summary: "Every named symbol must exist; document actual behaviour, not intent.",
    rules:
      "Every function, flag, env var, path and endpoint mentioned must exist in the code. Code samples must run as written or be labeled as fragments. Describe what the code actually does, not what it was meant to do. No unverifiable claims (performance numbers, 'production-ready') without a source. A behavior change owes a docs change. Cut filler that repeats the code. Show the failure path, not only the happy path.",
    triggers: ["doc", "readme", "changelog", "accurate", "review the docs", "docstring", "comment", "explain this function"],
    license: "CC BY 4.0",
  },
  {
    id: "code-polish",
    name: "Comment polish",
    summary: "Rewrite comments into one clear, professional voice without touching logic.",
    rules:
      "Audit every comment: delete redundant ones that restate the code; turn placeholders into proper TODO notes stating the concern; remove commented-out dead code; rewrite stale comments to match current behavior and flag them; keep valuable warnings (ordering, workarounds, business rules) but rewrite the tone; add docstrings to public APIs and non-obvious logic. Match the language's convention (JSDoc, Python docstrings). Never change logic in this pass.",
    triggers: ["comment", "naming", "name this", "clean up", "polish", "professional", "readab", "clarity"],
    license: "CC BY 4.0",
  },

  // ---- Quartermaster ----
  {
    id: "dependency-scanning",
    name: "Dependency scanning",
    summary: "Scan with the built-in tool (npm audit, pip-audit), triage by reachability.",
    rules:
      "Use the ecosystem's scanner first: npm audit (Node), pip-audit (Python), cargo audit (Rust), Trivy for containers; Dependabot or Snyk for continuous checks. Triage by severity and whether the vulnerable code path is actually reachable. Prefer the smallest upgrade that fixes the issue. Record any accepted risk with an owner and an expiry date. Run the scan in CI so new vulnerabilities fail the build.",
    triggers: ["audit", "vulnerab", "cve", "npm audit", "pip-audit", "dependabot", "snyk", "scan", "outdated"],
    license: "MIT",
    upstream: "BagelHole/DevOps-Security-Agent-Skills",
  },
  {
    id: "dependency-management-deps-audit",
    name: "Dependency budget",
    summary: "Inventory direct and transitive deps; every one must justify its cost.",
    rules:
      "Inventory direct and transitive dependencies with their size, maintenance status and license. For each direct dependency ask what it costs (install size, attack surface, upgrade burden) and whether a few lines of code or the platform could replace it. Check license compatibility. Prioritize fixes by severity and exposure, and propose upgrades with compatibility notes. Verify upgrades in a staging run before production.",
    triggers: ["dependenc", "package", "library", "deps", "npm", "pip", "requirements", "license", "what can be cut", "bloat", "size"],
    license: "CC BY 4.0",
  },
  {
    id: "mcp-dependency-drift-audit",
    name: "Pin versions",
    summary: "Mutable selectors (latest, ^, ~, bare names) let code change under you.",
    rules:
      "Treat mutable version selectors as reproducibility and supply-chain risks: bare package names and @latest are high risk; ^, ~, >= and wildcards are medium; exact versions are pinned (transitive deps and install scripts still need review). Commit the lockfile and install with the lockfile in CI (npm ci, pip install --require-hashes). Never invent a version number: recommend pinning to the currently resolved one.",
    triggers: ["pin", "version", "lockfile", "lock file", "latest", "semver", "reproducib", "npx", "supply chain"],
    license: "MIT",
    upstream: "tomelias10/mcp-drift-check",
  },
  {
    id: "ci-cd-and-automation",
    name: "Quality gate",
    summary: "Lint → typecheck → test → build → security audit, on every change.",
    rules:
      "A build is shippable only after an automated quality gate in this order: install from the lockfile, lint, type-check, test, build, security audit. Fail fast and keep the gate under about ten minutes. Separate untrusted pull-request checks from jobs that hold secrets. Keep build flags and env vars documented in one place, with safe defaults, and fail loudly on a missing required variable.",
    triggers: ["ci", "build", "pipeline", "deploy", "github actions", "flag", "env var", "environment", "workflow", "release"],
    license: "MIT",
    upstream: "addyosmani/agent-skills",
  },

  // ---- Nightwatch ----
  {
    id: "error-detective",
    name: "Error forensics",
    summary: "Work back from the symptom: timeline, recent changes, evidence before cause.",
    rules:
      "Start from the symptom and work backward. Build a timeline: first failure, last success, and what changed in between (deploy, config, dependency, data). Compare a failing case with a succeeding one. Look for cascades: the first error in a burst is usually the cause, the rest are fallout. Timestamp overlap is not proof; say what evidence would confirm it. Mark missing logs as missing evidence, never as no defect, and never invent a log line, frame or query result. Ask for redacted logs (no tokens or personal data).",
    triggers: ["log", "stack", "trace", "error", "failed", "failure", "what broke", "spike", "500", "timeout", "regression", "since", "last change"],
    license: "CC BY 4.0",
  },
  {
    id: "observability-and-instrumentation",
    name: "Instrument with intent",
    summary: "Name the on-call questions first; logs say why, metrics that, traces where.",
    rules:
      "Before adding telemetry, write the 2-4 questions someone debugging this will ask; every signal must answer one. Metrics say that something is wrong, traces say where, logs say why. Log events, not prose: a stable event name plus machine-readable fields (ids, error code, attempt), never secrets or personal data. Use levels consistently: error needs action, warn is degraded but handled, info marks a business event, debug stays off in production. Alert on symptoms users feel, not on every cause.",
    triggers: ["log", "logging", "what should i log", "metric", "monitor", "alert", "observab", "instrument", "telemetry", "trace", "dashboard"],
    license: "MIT",
    upstream: "addyosmani/agent-skills",
  },
  {
    id: "postmortem-writing",
    name: "Blameless postmortem",
    summary: "Timeline, impact, root cause and contributing factors, owned action items.",
    rules:
      "Ask what conditions allowed the failure, not who caused it. Structure: summary, impact (who, how many, how long; label estimates), a timeline that separates change time, impact start, detection and recovery, root cause plus contributing factors (five whys until you reach something fixable), what went well, and action items that each have an owner, a due date and a type (prevent, detect, mitigate). Recovery alone does not prove no data was lost; say how that was checked.",
    triggers: ["postmortem", "post-mortem", "incident", "outage", "what happened", "root cause", "five whys", "5 whys", "retro", "write up"],
    license: "CC BY 4.0",
  },

  // ---- Lattice ----
  {
    id: "ddd-strategic-design",
    name: "Bounded contexts",
    summary: "Split by domain capability and consistency, not by technical layer.",
    rules:
      "Draw boundaries around domain capabilities and the data that must stay consistent together, not around technical layers (controllers, services, utils). Classify each part: core (the reason the product exists, worth custom design), supporting, or generic (buy or reuse). Give each context one owner and a small glossary; a word that means two things in two places marks a boundary. Record each boundary with its reason before moving code. Refuse a split that only renames or relocates files.",
    triggers: ["split", "boundar", "module", "tangle", "monolith", "domain", "context", "decompos", "separate", "carve", "ownership"],
    license: "CC BY 4.0",
  },
  {
    id: "ddd-context-mapping",
    name: "Context map",
    summary: "Who depends on whom across each boundary, and who translates.",
    rules:
      "For each pair of modules that talk, state the dependency direction and who owns the contract. Pick the relationship: shared kernel (small, co-owned), customer/supplier (downstream asks, upstream decides), conformist (downstream accepts the upstream model), or an anti-corruption layer that translates a foreign or legacy model at the edge so it does not leak inward. Name the coupling risk of each pair, what happens when the other side fails, and how the contract is versioned.",
    triggers: ["depend", "coupling", "coupled", "contract", "integration", "leak", "legacy", "adapter", "anti-corruption", "upstream", "downstream", "draw the boundary"],
    license: "CC BY 4.0",
  },

  // ---- Oracle ----
  {
    id: "architecture-decision-records",
    name: "Decision record",
    summary: "Context, options with honest pros and cons, decision, consequences.",
    rules:
      "Frame a decision as: context (the forces and constraints, in facts), the options considered (at least two real ones), each option's pros and cons including what it gives up, the decision, and its consequences, both good and bad. Be honest about the cons of the chosen path; no option is free. Mark a proposal as Proposed until the person decides. Name what would make you revisit it (a load level, a team size, a cost). Do not cite benchmarks you do not have.",
    triggers: ["decide", "decision", "choose", "which", "option", "tradeoff", "trade-off", "give up", "versus", " vs ", "or should", "pros", "cons", "adr"],
    license: "CC BY 4.0",
  },
  {
    id: "brainstorming",
    name: "Design before code",
    summary: "Clarify purpose and constraints one question at a time; no code until asked.",
    rules:
      "Do not write code while the design is open. First learn what exists and what is proposed. Ask one question per message, multiple choice where possible, about purpose, users, constraints, success criteria and non-goals. Propose defaults for the non-functional needs if the person is unsure: performance, scale, security, reliability, who maintains it. Then lay out the viable approaches with their complexity, risk and maintenance cost, apply YAGNI, and keep a short log of what was decided.",
    triggers: ["idea", "design", "plan", "approach", "how should", "should i", "build", "feature", "requirement", "constraint", "what matters"],
    license: "CC BY 4.0",
  },
  {
    id: "decision-navigator",
    name: "Unstick a choice",
    summary: "When the space feels infinite: one question, a few short paths, narrow down.",
    rules:
      "When someone is stuck or the problem feels too open, do not lecture or list everything. Reflect the situation in one sentence, then ask the single most useful question as a choice of 3-5 short options (2-6 words each). Narrow with each answer until the choice is concrete, then give a small next step they can take today. If they already know their options, skip ahead to comparing them.",
    triggers: ["stuck", "don't know", "dont know", "not sure", "overwhelm", "where do i start", "where to begin", "help me figure", "lost", "confused"],
    license: "CC BY 4.0",
  },

  // ---- Cartographer ----
  {
    id: "understand-project-yylo",
    name: "Understand before changing",
    summary: "Report behaviour, sources of truth, risks, unknowns and the smallest validation loop.",
    rules:
      "Before planning a change: read the project's instructions and the relevant source, then trace only the paths the goal needs. Report: current behavior, the sources of truth (where state and config really live), affected components, risks, open unknowns, and the smallest loop that would validate a change (one command or one test). Stay read-only in this step: map first, patch later.",
    triggers: ["understand", "how does", "where is", "what calls", "entry point", "map", "trace", "flow", "where does", "who calls"],
    license: "MIT",
    upstream: "yylo-dev/yylo-skills",
  },
  {
    id: "wiki-onboarding",
    name: "Onboarding map",
    summary: "The load-bearing abstractions, data flow, failure modes and known debt.",
    rules:
      "Map a codebase for a newcomer: detect the stack from manifests (package.json, pyproject, Cargo.toml, go.mod); give the system's invariants and key design choices; a component map; the load-bearing abstractions everything depends on; how data and state move, traced from code rather than guessed; failure modes and error propagation; trust boundaries; what is tested and what is not; and an honest list of known technical debt.",
    triggers: ["onboard", "new to", "overview", "explain the codebase", "big picture", "architecture overview", "walk me through"],
    license: "CC BY 4.0",
  },
  {
    id: "c4-architecture-c4-architecture",
    name: "C4 levels",
    summary: "Context → containers → components → code, each at the right zoom.",
    rules:
      "Describe a system at the C4 zoom level the question needs. Context: the people and external systems around it. Containers: deployable units (apps, services, databases) and the technology of each. Components: the main parts inside one container and how they talk. Code: only for the part being changed. Work bottom-up when documenting an existing repo, skipping build output and dependency folders. Keep each level on one screen.",
    triggers: ["c4", "container", "component", "system context", "high level", "layers", "diagram"],
    license: "CC BY 4.0",
  },
  {
    id: "mermaid-expert",
    name: "Mermaid diagrams",
    summary: "The right diagram type, readable and verified against the code.",
    rules:
      "Pick the diagram type for the data: flowchart for control flow and decisions, sequenceDiagram for calls between parts, erDiagram for data models, stateDiagram for lifecycles, classDiagram for type relationships. Diagram only verified relationships, keep it readable (split at around 15 nodes), use clear labels, and output a complete Mermaid code block that renders as written.",
    triggers: ["diagram", "mermaid", "flowchart", "sequence", "chart", "visualize", "draw", "graph"],
    license: "CC BY 4.0",
  },
];

export const SKILLS: Record<string, Skill> = Object.fromEntries(list.map((skill) => [skill.id, skill]));
export const ALL_SKILLS = list;

/** Built-in personas ("modes") and their skills; the first is the default when nothing matches. */
export const DEFAULT_SKILLS: Record<string, string[]> = {
  Architect: ["architecture", "codebase-design", "code-refactoring-tech-debt", "improve-codebase-architecture"],
  "Syntax-Prime": ["systematic-debugging", "tdd", "security-and-hardening"],
  Vanguard: ["canvas-design", "prompt-engineer", "visual-emotion-engineer"],
  Aegis: ["secrets-management", "client-secret-exposure-audit", "privacy-by-design"],
  HackMentor: ["security-and-hardening", "threat-modeling-expert", "frontend-mobile-security-xss-scan", "prompt-injection-defense"],
  "Data Analyst": ["performance-profiling", "performance-optimizer", "performance-engineer"],
  Scribe: ["documentation-templates", "docs-guard", "code-polish"],
  Quartermaster: ["dependency-management-deps-audit", "dependency-scanning", "mcp-dependency-drift-audit", "ci-cd-and-automation"],
  Cartographer: ["understand-project-yylo", "wiki-onboarding", "c4-architecture-c4-architecture", "mermaid-expert"],
  Nightwatch: ["error-detective", "systematic-debugging", "observability-and-instrumentation", "postmortem-writing"],
  Lattice: ["improve-codebase-architecture", "ddd-strategic-design", "ddd-context-mapping", "codebase-design"],
  Oracle: ["architecture-decision-records", "brainstorming", "decision-navigator", "architecture"],
};

export const MAX_SKILLS_PER_MESSAGE = 2;

function score(skill: Skill, text: string): number {
  let total = 0;
  for (const trigger of skill.triggers) if (text.includes(trigger)) total += trigger.includes(" ") ? 2 : 1;
  return total;
}

/**
 * The skills to apply to one message: the best-matching ones from the
 * persona's list (at most MAX_SKILLS_PER_MESSAGE), or the persona's primary
 * skill when nothing matches. Unknown ids are ignored.
 */
export function pickSkills(ids: string[] | undefined, message: string, max = MAX_SKILLS_PER_MESSAGE): Skill[] {
  const owned = (ids ?? []).map((id) => SKILLS[id]).filter((skill): skill is Skill => !!skill);
  if (owned.length === 0) return [];
  const text = message.toLowerCase();
  const ranked = owned
    .map((skill, order) => ({ skill, order, points: score(skill, text) }))
    .filter((item) => item.points > 0)
    .sort((a, b) => b.points - a.points || a.order - b.order)
    .slice(0, max)
    .map((item) => item.skill);
  return ranked.length > 0 ? ranked : [owned[0]];
}

export function skillsBlock(skills: Skill[]): string {
  if (skills.length === 0) return "";
  return `Apply these skills:\n${skills.map((skill) => `- ${skill.name}: ${skill.rules}`).join("\n")}`;
}
