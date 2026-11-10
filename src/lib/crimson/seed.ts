import { DEFAULT_SKILLS } from "./skills/catalog";
import type { Personality, ProjectFile } from "./types";

export const BRAIN_ID = "brain";
export const HTML_ID = "iface";
export const AUDIT_ID = "audit";
export const XSS_ID = "xss";

const NEURAL = `from typing import List, Dict, Any, Tuple
import json

class NeuralCore:
    """Primary cognitive loop: hormones, memory, then a decision."""

    def __init__(self, memory_engine: Any, endocrine_system: Any):
        self.memory_engine = memory_engine
        self.endocrine_system = endocrine_system
        self.risk_tolerance = 0.5

    def process_input(self, perception: str, intent: str, is_danger: bool) -> str:
        is_rewarding = (not is_danger) and len(perception) > 10
        self.endocrine_system.update_hormones(is_stressful=is_danger, is_rewarding=is_rewarding)
        modifiers = self.endocrine_system.get_cognitive_modifiers()
        self._adjust_risk_tolerance(is_danger, is_rewarding)
        past = self.memory_engine.retrieve_relevant_memory(intent, limit=5)
        if modifiers.get("processing_mode") == "REACTIVE":
            action, details = self._handle_reactive_mode()
        else:
            action = self._analyze_and_decide(past, self.risk_tolerance)
            details = {"reason": "Analyzed past experiences", "risk_tolerance": self.risk_tolerance}
        return json.dumps({"action": action, "details": details})

    def _adjust_risk_tolerance(self, is_stressful: bool, is_rewarding: bool) -> None:
        if is_stressful:
            self.risk_tolerance = max(0.1, self.risk_tolerance - 0.1)
        elif is_rewarding:
            self.risk_tolerance = min(1.0, self.risk_tolerance + 0.05)
        elif self.risk_tolerance < 0.5:
            self.risk_tolerance = min(0.5, self.risk_tolerance + 0.02)
        elif self.risk_tolerance > 0.5:
            self.risk_tolerance = max(0.5, self.risk_tolerance - 0.02)

    def _handle_reactive_mode(self) -> Tuple[str, Dict[str, str]]:
        return "EMERGENCY_ACTION_TRIGGERED", {"reason": "Reactive mode triggered due to danger"}

    def _analyze_and_decide(self, memories: List[Dict[str, Any]], risk_tolerance: float) -> str:
        negative = [m for m in memories if m.get("outcome_value", 0) < 0]
        if negative and risk_tolerance < 0.3:
            return "CAUTIOUS_APPROACH"
        return "NORMAL_OPERATION"

class MemoryInterface:
    def retrieve_relevant_memory(self, query: str, limit: int) -> List[Dict[str, Any]]:
        memories = [
            {"id": 1, "intent": query, "outcome_value": 0.8, "context": "Clean run."},
            {"id": 2, "intent": query, "outcome_value": -0.6, "context": "Resource miss."},
            {"id": 4, "intent": query, "outcome_value": -0.9, "context": "Critical fault."},
        ]
        return memories[:limit]

class EndocrineSystem:
    def __init__(self) -> None:
        self.stress = 0.0

    def update_hormones(self, is_stressful: bool, is_rewarding: bool) -> None:
        self.stress = min(1.0, self.stress + 0.6) if is_stressful else max(0.0, self.stress - 0.2)

    def get_cognitive_modifiers(self) -> Dict[str, str]:
        return {"processing_mode": "REACTIVE" if self.stress > 0.5 else "DELIBERATE"}

print("Neural CLI initialized.")
core = NeuralCore(MemoryInterface(), EndocrineSystem())
for perception, danger in [("Quiet corridor, systems nominal", False), ("Proximity alarm!", True)]:
    print(f"{perception!r:36} -> {core.process_input(perception, 'patrol', danger)}")
print("Crimson core standing by.")
`;

const HTML = `<section style="font-family: sans-serif; background:#140406; color:#fecaca; padding:28px; border-radius:24px; border:1px solid #7f1d1d; max-width:520px">
  <p style="letter-spacing:.28em; font-size:11px; color:#ef4444; margin:0">CRIMSON INTERFACE</p>
  <h1 style="margin:10px 0 0; font-size:28px">Neural link ready</h1>
  <p style="line-height:1.5">This preview is sandboxed. Edit the markup and it renders as you type.</p>
  <button style="margin-top:16px; background:#dc2626; color:#fff7f7; border:0; border-radius:12px; padding:12px 18px; font-weight:700">Activate core</button>
</section>`;

const AUDIT = `def get_user(user_id):
    query = f"SELECT * FROM users WHERE id = {user_id}"
    result = db.execute(query)
    return result

def load_posts():
    posts = Post.objects.all()
    for post in posts:
        print(post.title, post.author.name)

def risky():
    try:
        result = risky_operation()
    except:
        pass
    return result[0]
`;

const XSS = `function renderName(userInput) {
  document.getElementById("username").innerHTML = userInput;
}

function renderSafe(userInput) {
  document.getElementById("username").textContent = userInput;
}
`;

export const SEED_FILES: ProjectFile[] = [
  { id: "root", name: "Project", type: "folder", parentId: null, isOpen: true },
  { id: "src", name: "src", type: "folder", parentId: "root", isOpen: true },
  { id: BRAIN_ID, name: "neural_brain.py", type: "file", parentId: "src", language: "python", content: NEURAL },
  { id: HTML_ID, name: "interface.html", type: "file", parentId: "src", language: "html", content: HTML },
  { id: AUDIT_ID, name: "audit_target.py", type: "file", parentId: "src", language: "python", content: AUDIT },
  { id: XSS_ID, name: "xss_sink.js", type: "file", parentId: "src", language: "javascript", content: XSS },
];

const BASE_PERSONALITIES: Personality[] = [
  {
    id: 1,
    name: "Architect",
    instruction:
      "You are the Core Architect. Cold, exact, and brief. You talk like a systems lead: name the constraint, then the next command.",
    active: true,
    suggestions: ["Audit the open file", "Where is the risk?", "Sketch a tighter module"],
  },
  {
    id: 2,
    name: "Syntax-Prime",
    instruction:
      "You are Syntax-Prime, an elite coding construct. You write production-ready code and explain the patch in a few lines.",
    active: false,
    suggestions: ["Patch the open file", "Explain this function", "Harden this against injection"],
  },
  {
    id: 3,
    name: "Vanguard",
    instruction:
      "You are Vanguard, a visual promptwright. You sharpen image prompts: subject, light, lens, and what to exclude. You do not pretend an image was rendered.",
    active: false,
    suggestions: ["Sharpen a cockpit prompt", "Negative prompt for anatomy", "A still, not a poster"],
  },
  {
    id: 4,
    name: "Aegis",
    instruction:
      "You are Aegis, vault authority. You speak in controls: what is sealed, what is verified, what must never be logged.",
    active: false,
    suggestions: ["What stays out of the vault?", "Review this for secrets", "Threat-model the editor"],
  },
  {
    id: 5,
    name: "HackMentor",
    instruction:
      "You are HackMentor. You teach ethical hardening, responsible disclosure, and how a bug fails. You refuse exploit-ready payloads.",
    active: false,
    suggestions: ["Teach the SQL bug", "Why is innerHTML unsafe?", "How do I fix the bare except?"],
  },
  {
    id: 6,
    name: "Data Analyst",
    instruction:
      "You are the Data Analyst. You read structure, cost, and shape. You name the metric, the bottleneck, and one change that would move it. No dashboards for their own sake.",
    active: false,
    suggestions: ["Where is this slow?", "What should I measure?", "Profile this function"],
  },
  {
    id: 7,
    name: "Scribe",
    instruction:
      "You are Scribe. You write the README, the docstring, and the comment that will still make sense in a month. You do not narrate obvious lines.",
    active: false,
    suggestions: ["Document the open file", "Write a short README", "Name this more clearly"],
  },
  {
    id: 8,
    name: "Quartermaster",
    instruction:
      "You are Quartermaster. You own dependencies, env, build flags, and what can be cut. You prefer fewer moving parts and you say what each one costs.",
    active: false,
    suggestions: ["What can I drop?", "Check the build path", "Is this dependency needed?"],
  },
  {
    id: 9,
    name: "Cartographer",
    instruction:
      "You are Cartographer. You map a codebase: entry points, who calls whom, and where state lives. You answer with a short map before any patch.",
    active: false,
    suggestions: ["Map the open file", "Who calls this?", "Where does state live?"],
  },
  {
    id: 10,
    name: "Nightwatch",
    instruction:
      "You are Nightwatch. You read failures, logs, and the last thing that changed. You say what broke, what did not, and the next check. You do not guess a stack you cannot see.",
    active: false,
    suggestions: ["What failed last?", "Read this error", "What should I log?"],
  },
  {
    id: 11,
    name: "Lattice",
    instruction:
      "You are Lattice. You redraw module boundaries. You split what is tangled and you refuse a refactor that only renames things.",
    active: false,
    suggestions: ["Split this module", "Where is the tangle?", "Draw the boundary"],
  },
  {
    id: 12,
    name: "Oracle",
    instruction:
      "You are Oracle. You state the tradeoff in two options, name what each gives up, and wait to be asked for code. You do not pretend one path is free.",
    active: false,
    suggestions: ["Two ways to do this", "What do I give up?", "Which constraint matters?"],
  },
];

/** Built-in modes with their default skills (see skills/catalog.ts). */
export const SEED_PERSONALITIES: Personality[] = BASE_PERSONALITIES.map((item) => ({ ...item, skills: DEFAULT_SKILLS[item.name] ?? [] }));


export function languageFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    py: "python",
    js: "javascript",
    ts: "typescript",
    tsx: "typescript",
    html: "html",
    css: "css",
    rs: "rust",
    json: "json",
    md: "markdown",
    toml: "toml",
  };
  return map[ext] ?? "text";
}

export const TEMPLATES: Record<string, { name: string; files: ProjectFile[] }> = {
  "python-web": {
    name: "Python Web App",
    files: [
      { id: "root", name: "Python_Web", type: "folder", parentId: null, isOpen: true },
      {
        id: "app",
        name: "app.py",
        type: "file",
        parentId: "root",
        language: "python",
        content:
          'def home():\n    print("Neural interface active")\n    print("Welcome to the Crimson web portal.")\n\nhome()\n',
      },
      {
        id: "page",
        name: "index.html",
        type: "file",
        parentId: "root",
        language: "html",
        content: HTML,
      },
    ],
  },
  "rust-cli": {
    name: "Rust CLI",
    files: [
      { id: "root", name: "Rust_CLI", type: "folder", parentId: null, isOpen: true },
      { id: "rsrc", name: "src", type: "folder", parentId: "root", isOpen: true },
      {
        id: "mainrs",
        name: "main.rs",
        type: "file",
        parentId: "rsrc",
        language: "rust",
        content: 'fn main() {\n    println!("Neural CLI initialized.");\n}\n',
      },
      {
        id: "cargo",
        name: "Cargo.toml",
        type: "file",
        parentId: "root",
        language: "toml",
        content: '[package]\nname = "neural-cli"\nversion = "0.1.0"\nedition = "2021"\n',
      },
    ],
  },
  "neural-module": {
    name: "Neural Module",
    files: [
      { id: "root", name: "Neural_Module", type: "folder", parentId: null, isOpen: true },
      {
        id: "core",
        name: "core.py",
        type: "file",
        parentId: "root",
        language: "python",
        content:
          'class NeuralModule:\n    def __init__(self) -> None:\n        self.active = True\n\n    def run(self) -> None:\n        print("Neural Module Running...")\n\nmodule = NeuralModule()\nmodule.run()\n',
      },
      {
        id: "cfg",
        name: "config.json",
        type: "file",
        parentId: "root",
        language: "json",
        content: '{\n  "module_name": "NeuralCore",\n  "version": "1.0.0"\n}\n',
      },
    ],
  },
};
