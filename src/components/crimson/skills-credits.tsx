import { DEFAULT_SKILLS, SKILLS, SKILLS_REPO, SKILLS_SNAPSHOT, skillUrl } from "@/lib/crimson/skills/catalog";
import { useOs } from "@/lib/crimson/store";

/** Config → Skills: which skills each mode applies, with attribution. */
export function SkillsCredits() {
  const personalities = useOs((state) => state.personalities);
  return (
    <section className="mt-4 rounded-3xl border border-border bg-surface p-4">
      <details>
        <summary className="cursor-pointer text-sm font-semibold">Skills by mode</summary>
        <p className="mt-2 text-sm text-muted">
          Each mode applies up to two matching skills per message (its first skill when nothing matches); the reply shows which. Change them in Persona forge.
        </p>
        <ul className="mt-3 space-y-3">
          {personalities.map((persona) => (
            <li key={persona.id} className="text-sm">
              <p className="font-semibold">{persona.name}</p>
              <p className="text-muted">
                {(persona.skills ?? []).length === 0
                  ? "No skills."
                  : (persona.skills ?? [])
                      .map((id) => SKILLS[id]?.name)
                      .filter(Boolean)
                      .join(" · ")}
              </p>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs font-semibold tracking-widest text-muted uppercase">Credits</p>
        <p className="mt-1 text-xs text-muted">
          Condensed and adapted from{" "}
          <a className="underline" href={SKILLS_REPO} target="_blank" rel="noreferrer">
            sickn33/agentic-awesome-skills
          </a>{" "}
          (snapshot {SKILLS_SNAPSHOT}). Content under CC BY 4.0 unless marked MIT; changes: rewritten as short rules for a chat assistant.
        </p>
        <ul className="mt-2 space-y-1 text-xs text-muted">
          {[...new Set(Object.values(DEFAULT_SKILLS).flat())].map((id) => {
            const skill = SKILLS[id];
            return (
              <li key={id}>
                <a className="underline" href={skillUrl(id)} target="_blank" rel="noreferrer">
                  {id}
                </a>{" "}
                · {skill.license}
                {skill.upstream ? ` · from ${skill.upstream}` : ""}
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}
