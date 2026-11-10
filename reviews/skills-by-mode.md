# Skills by mode

Source: https://github.com/sickn33/agentic-awesome-skills (snapshot 55d9399, 2026-11-09), 2,955 indexed skills.
Selection: searched the index per mode, excluded `offensive`/`unknown` risk ratings, read each finalist's SKILL.md,
skipped thin wrappers (readme, python-performance-optimization, varlock, debugging-strategies) and tool/vendor-specific
ones (Azure/AWS SDKs, Stitch, Gemini image tools). Each pick is condensed into rules in
`src/lib/crimson/skills/catalog.ts`; the first skill per mode is its default.

| Mode | Skills |
|---|---|
| Architect | architecture · codebase-design · code-refactoring-tech-debt · improve-codebase-architecture |
| Syntax-Prime | systematic-debugging · tdd · security-and-hardening |
| Vanguard | canvas-design · prompt-engineer · visual-emotion-engineer |
| Aegis | secrets-management · client-secret-exposure-audit · privacy-by-design |
| HackMentor | security-and-hardening · threat-modeling-expert · frontend-mobile-security-xss-scan · prompt-injection-defense |
| Data Analyst | performance-profiling · performance-optimizer · performance-engineer |
| Scribe | documentation-templates · docs-guard · code-polish |
| Quartermaster | dependency-management-deps-audit · dependency-scanning · mcp-dependency-drift-audit · ci-cd-and-automation |
| Cartographer | understand-project-yylo · wiki-onboarding · c4-architecture-c4-architecture · mermaid-expert |
| Nightwatch | error-detective · systematic-debugging · observability-and-instrumentation · postmortem-writing |
| Lattice | improve-codebase-architecture · ddd-strategic-design · ddd-context-mapping · codebase-design |
| Oracle | architecture-decision-records · brainstorming · decision-navigator · architecture |

Gap: the repo has no skill specific to image-generation prompts (subject/light/lens/negative prompt). Vanguard uses
general composition, prompt-structuring and visual-direction skills; its own instruction covers the image specifics.

Licenses: repo content CC BY 4.0; code and the upstream repos addyosmani/agent-skills, BagelHole/DevOps-Security-Agent-Skills,
tomelias10/mcp-drift-check and yylo-dev/yylo-skills are MIT (per docs/sources/sources.md). Credited in Config → Skills by mode.

## Added 2026-11-10: Nightwatch, Lattice, Oracle

The first pass missed these three modes (12 built-in modes, not 9). 8 new cards (38 total):

- **Nightwatch** (failures, logs, last change): `error-detective` for timeline and evidence, `observability-and-instrumentation` (MIT, addyosmani/agent-skills) for "What should I log?", `postmortem-writing`, plus the shared `systematic-debugging`. Skipped `logbrew-debug-production` (tied to one product).
- **Lattice** (module boundaries, refuses rename-only refactors): `ddd-strategic-design` and `ddd-context-mapping`, plus the shared `improve-codebase-architecture` and `codebase-design`.
- **Oracle** (two options, what each gives up, code only when asked): `architecture-decision-records`, `brainstorming` (no code while the design is open), `decision-navigator`, plus the shared `architecture`. Skipped `product-decision-agent` (Chinese-language product management).

Saves from the first pass stored empty lists for these modes; the app refills empty built-in modes once (`SKILLS_REV = 2` in store.ts), so a mode cleared on purpose afterwards stays empty. A test now fails if any built-in mode in seed.ts lacks skills, or if a suggestion chip matches none of its mode's skills.
