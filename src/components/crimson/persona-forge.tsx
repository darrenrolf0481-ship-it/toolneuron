import { useState } from "react";
import { askCrimson } from "@/lib/crimson/ai.functions";
import { SEED_PERSONALITIES } from "@/lib/crimson/seed";
import { ALL_SKILLS, SKILLS } from "@/lib/crimson/skills/catalog";
import { useOs } from "@/lib/crimson/store";
import type { Personality } from "@/lib/crimson/types";

const VOICES = [
  { id: "cold", label: "Cold", line: "Speak cold and exact. No warmth, no filler." },
  { id: "warm", label: "Warm", line: "Speak plainly and kindly, and stay precise." },
  { id: "terse", label: "Terse", line: "Use as few words as the point allows." },
  { id: "teacher", label: "Teacher", line: "Teach the why before any patch. Refuse exploit-ready payloads." },
  { id: "skeptic", label: "Skeptic", line: "Question the premise. Say what is still unproven." },
  { id: "ritual", label: "Ritual", line: "Speak like a deck officer: short, formal, concrete." },
];

const FOCUSES = [
  { id: "code", label: "Code", line: "You write and review code." },
  { id: "security", label: "Security", line: "You hunt injection, XSS, secrets, and unsafe defaults." },
  { id: "docs", label: "Docs", line: "You write the words the next reader needs." },
  { id: "design", label: "Design", line: "You care about what the operator actually sees." },
  { id: "memory", label: "Memory", line: "You keep names, history, and decisions consistent." },
  { id: "tradeoff", label: "Tradeoffs", line: "You give two options and what each one gives up." },
];

const SEED_IDS = new Set(SEED_PERSONALITIES.map((item) => item.id));

function compose(name: string, voices: string[], focuses: string[]) {
  const who = name.trim() || "this persona";
  const lines = [
    `You are ${who}, a custom ToolNeuron mode.`,
    ...VOICES.filter((item) => voices.includes(item.id)).map((item) => item.line),
    ...FOCUSES.filter((item) => focuses.includes(item.id)).map((item) => item.line),
    "Stay with the open file and the question. Do not claim you executed code or rendered an image.",
  ];
  return lines.join(" ");
}

function suggestionsFor(focuses: string[]) {
  const map: Record<string, string> = {
    code: "Review the open file",
    security: "Where is the risk?",
    docs: "Document this",
    design: "What does the operator see?",
    memory: "What must stay consistent?",
    tradeoff: "What do I give up?",
  };
  const chips = focuses.map((id) => map[id]).filter(Boolean);
  return chips.length > 0 ? chips.slice(0, 3) : ["Review the open file", "What next?"];
}

/** Pick the skills this mode applies. The first picked is the default when no skill matches a message. */
function SkillPicker({ selected, onChange }: { selected: string[]; onChange: (next: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const picked = selected.map((id) => SKILLS[id]).filter(Boolean);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs tracking-widest text-muted uppercase">Skills ({picked.length})</p>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="min-h-11 rounded-xl border border-border px-3 text-xs">
          {open ? "Done" : "Choose skills"}
        </button>
      </div>
      {picked.length === 0 ? (
        <p className="text-xs text-muted">No skills. This mode uses only its instruction.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {picked.map((skill, index) => (
            <span key={skill.id} title={skill.summary} className={`rounded-full border px-3 py-1.5 text-xs ${index === 0 ? "border-primary text-fg" : "border-border text-muted"}`}>
              {skill.name}
              {index === 0 ? " · default" : ""}
            </span>
          ))}
        </div>
      )}
      {open && (
        <ul className="os-scroll max-h-72 space-y-1 overflow-y-auto rounded-2xl border border-border bg-bg p-2" aria-label="Available skills">
          {ALL_SKILLS.map((skill) => {
            const on = selected.includes(skill.id);
            return (
              <li key={skill.id}>
                <label className="flex cursor-pointer items-start gap-3 rounded-xl px-2 py-2 hover:bg-surface-2">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => onChange(on ? selected.filter((id) => id !== skill.id) : [...selected, skill.id].slice(0, 6))}
                    className="mt-1 accent-[var(--color-primary)]"
                  />
                  <span>
                    <span className="block text-sm text-fg">{skill.name}</span>
                    <span className="block text-xs text-muted">{skill.summary}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function PersonaForge() {
  const personalities = useOs((state) => state.personalities);
  const activate = useOs((state) => state.activatePersonality);
  const addPersonality = useOs((state) => state.addPersonality);
  const updatePersonality = useOs((state) => state.updatePersonality);
  const removePersonality = useOs((state) => state.removePersonality);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [voices, setVoices] = useState<string[]>(["terse"]);
  const [focuses, setFocuses] = useState<string[]>(["code"]);
  const [chips, setChips] = useState<string[]>(["Review the open file", "What next?", ""]);
  const [skills, setSkills] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [reply, setReply] = useState("");
  const [hearing, setHearing] = useState(false);

  const editing = personalities.find((item) => item.id === editingId) ?? null;
  const locked = editing ? SEED_IDS.has(editing.id) : false;

  const load = (item: Personality) => {
    setEditingId(item.id);
    setName(item.name);
    setInstruction(item.instruction);
    setChips([item.suggestions[0] ?? "", item.suggestions[1] ?? "", item.suggestions[2] ?? ""]);
    setSkills(item.skills ?? []);
    setNote("");
    setReply("");
    activate(item.id);
  };

  const blank = () => {
    setEditingId(null);
    setName("");
    setInstruction("");
    setVoices(["terse"]);
    setFocuses(["code"]);
    setChips(["Review the open file", "What next?", ""]);
    setSkills([]);
    setNote("");
    setReply("");
  };

  const toggle = (list: string[], id: string, setList: (next: string[]) => void) => {
    setList(list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);
  };

  const seal = () => {
    const trimmed = name.trim();
    const brief = instruction.trim();
    if (!trimmed || !brief) {
      setNote("A persona needs a name and a line to follow.");
      return;
    }
    const suggestions = chips.map((item) => item.trim()).filter(Boolean);
    if (editing) {
      updatePersonality(editing.id, { name: trimmed, instruction: brief, suggestions, skills });
      setNote(locked ? `${trimmed} rewritten. The built-in cannot be removed.` : `${trimmed} rewritten.`);
      return;
    }
    addPersonality(trimmed, brief, suggestions, skills);
    setNote(`${trimmed} is active. Their chips show in chat.`);
    setName("");
    setInstruction("");
  };

  const hear = async () => {
    const brief = instruction.trim();
    if (!brief || hearing) return;
    setHearing(true);
    setReply("");
    setNote("");
    try {
      const result = await askCrimson({
        data: {
          fast: true,
          provider: useOs.getState().provider,
          system: brief,
          messages: [
            {
              role: "user",
              content: "In two sentences, say who you are and how you will help with the open file. Do not write code.",
            },
          ],
        },
      });
      setReply(result.ok ? result.text : result.error);
    } catch {
      setReply("The link dropped before they answered.");
    } finally {
      setHearing(false);
    }
  };

  return (
    <section className="mt-4 rounded-3xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Persona forge</p>
          <p className="mt-1 max-w-xl text-sm text-muted">
            Pick a voice and a focus, compose the line they follow, then hear them once. Built-ins can be rewritten. Only customs can be removed.
          </p>
        </div>
        <button type="button" onClick={blank} className="min-h-11 rounded-2xl border border-border px-4 text-sm">
          Blank persona
        </button>
      </div>

      <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
        {personalities.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => load(item)}
            className={`min-h-11 shrink-0 rounded-full border px-3 text-xs ${item.id === editingId ? "border-primary bg-primary text-on-primary" : "border-border text-muted"}`}
          >
            {item.name}
            {SEED_IDS.has(item.id) ? "" : " · yours"}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          <label className="block text-xs tracking-widest text-muted uppercase">
            Name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Night clerk"
              className="mt-2 min-h-11 w-full rounded-2xl border border-border bg-bg px-3 text-sm text-fg outline-none"
            />
          </label>
          <div>
            <p className="text-xs tracking-widest text-muted uppercase">Voice</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {VOICES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => toggle(voices, item.id, setVoices)}
                  className={`min-h-11 rounded-full border px-3 text-xs ${voices.includes(item.id) ? "border-primary bg-bg text-fg" : "border-border text-muted"}`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs tracking-widest text-muted uppercase">Focus</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {FOCUSES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => toggle(focuses, item.id, setFocuses)}
                  className={`min-h-11 rounded-full border px-3 text-xs ${focuses.includes(item.id) ? "border-primary bg-bg text-fg" : "border-border text-muted"}`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            className="min-h-11 rounded-2xl border border-border px-4 text-sm"
            onClick={() => {
              setInstruction(compose(name, voices, focuses));
              setChips([...suggestionsFor(focuses), "", ""].slice(0, 3));
            }}
          >
            Compose the line
          </button>
          <label className="block text-xs tracking-widest text-muted uppercase">
            Line they follow
            <textarea
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="Compose from the chips, or write this yourself."
              className="mt-2 min-h-32 w-full rounded-2xl border border-border bg-bg p-3 text-sm text-fg outline-none"
            />
          </label>
          <div className="space-y-2">
            <p className="text-xs tracking-widest text-muted uppercase">Chat chips</p>
            {chips.map((chip, index) => (
              <input
                key={index}
                value={chip}
                onChange={(event) => setChips(chips.map((item, itemIndex) => (itemIndex === index ? event.target.value : item)))}
                placeholder={`Suggestion ${index + 1}`}
                className="min-h-11 w-full rounded-2xl border border-border bg-bg px-3 text-sm text-fg outline-none"
              />
            ))}
          </div>
          <SkillPicker selected={skills} onChange={setSkills} />
        </div>

        <div className="flex flex-col gap-3 rounded-3xl border border-border bg-bg p-4">
          <p className="text-xs tracking-widest text-muted uppercase">{editing ? (locked ? "Built-in" : "Yours") : "Unsealed"}</p>
          <p className="text-lg font-semibold">{name.trim() || "Unnamed"}</p>
          <p className="text-sm leading-6 text-muted">{instruction.trim() || "No line yet. Compose one, or write it."}</p>
          <div className="flex flex-wrap gap-2">
            {chips.filter((item) => item.trim()).map((item, index) => (
              <span key={`${item}-${index}`} className="rounded-full border border-border px-3 py-2 text-xs text-muted">
                {item}
              </span>
            ))}
          </div>
          <div className="mt-auto flex flex-wrap gap-2 pt-2">
            <button type="button" onClick={seal} className="min-h-11 rounded-2xl bg-primary px-4 text-sm font-semibold text-on-primary">
              {editing ? "Rewrite" : "Seal persona"}
            </button>
            <button
              type="button"
              onClick={() => void hear()}
              disabled={hearing || !instruction.trim()}
              className="min-h-11 rounded-2xl border border-border px-4 text-sm disabled:opacity-40"
            >
              {hearing ? "Listening…" : "Hear them"}
            </button>
            {editing && !locked && (
              <button
                type="button"
                className="min-h-11 rounded-2xl border border-border px-4 text-sm text-primary"
                onClick={() => {
                  if (!window.confirm(`Remove ${editing.name}?`)) return;
                  removePersonality(editing.id);
                  blank();
                  setNote("Removed.");
                }}
              >
                Remove
              </button>
            )}
          </div>
          {note && <p className="text-sm text-primary">{note}</p>}
          {reply && <p className="rounded-2xl border border-border p-3 text-sm leading-6">{reply}</p>}
        </div>
      </div>
    </section>
  );
}
