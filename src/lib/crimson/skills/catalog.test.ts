import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { ALL_SKILLS, DEFAULT_SKILLS, pickSkills, SKILLS, skillsBlock } from "./catalog.ts";

// Built-in modes, read from seed.ts as text (its extensionless imports do not load under node --test).
const seedText = readFileSync(new URL("../seed.ts", import.meta.url), "utf8");
const BASE_PERSONALITIES = [...seedText.matchAll(/name: "([^"]+)",\n\s+instruction:[\s\S]*?suggestions: \[([^\]]*)\]/g)].map((m) => ({
  name: m[1],
  suggestions: [...m[2].matchAll(/"([^"]+)"/g)].map((s) => s[1]),
}));

describe("skill catalog", () => {
  it("every mode's skills exist, ids are unique, cards fit the prompt budget", () => {
    assert.equal(new Set(ALL_SKILLS.map((s) => s.id)).size, ALL_SKILLS.length);
    for (const [mode, ids] of Object.entries(DEFAULT_SKILLS)) {
      assert.ok(ids.length >= 3, `${mode} has ${ids.length} skills`);
      for (const id of ids) assert.ok(SKILLS[id], `${mode}: unknown skill ${id}`);
    }
    for (const skill of ALL_SKILLS) {
      assert.ok(skill.rules.length <= 700, `${skill.id} rules ${skill.rules.length} chars`);
      assert.ok(skill.triggers.length >= 3, `${skill.id} needs triggers`);
      assert.ok(skill.triggers.every((t) => t === t.toLowerCase()), `${skill.id} triggers must be lower-case`);
    }
    const used = new Set(Object.values(DEFAULT_SKILLS).flat());
    assert.deepEqual(ALL_SKILLS.filter((s) => !used.has(s.id)).map((s) => s.id), []);
  });
  it("every built-in mode has skills", () => {
    assert.equal(BASE_PERSONALITIES.length, 12);
    assert.deepEqual(BASE_PERSONALITIES.map((p) => p.name).filter((name) => !DEFAULT_SKILLS[name]), []);
  });
  it("each mode's suggestion chips pick one of its skills", () => {
    for (const persona of BASE_PERSONALITIES)
      for (const chip of persona.suggestions ?? []) assert.ok(pickSkills(DEFAULT_SKILLS[persona.name], chip).length > 0, `${persona.name}: ${chip}`);
  });
  it("two worst-case skills stay under the 1600-char block budget", () => {
    const longest = [...ALL_SKILLS].sort((a, b) => b.rules.length - a.rules.length).slice(0, 2);
    assert.ok(skillsBlock(longest).length <= 1600, `${skillsBlock(longest).length}`);
  });
});

describe("pickSkills", () => {
  const hack = DEFAULT_SKILLS.HackMentor;
  it("matches the message", () => {
    assert.deepEqual(pickSkills(hack, "Why is innerHTML unsafe?").map((s) => s.id)[0], "frontend-mobile-security-xss-scan");
    assert.ok(pickSkills(DEFAULT_SKILLS["Syntax-Prime"], "I get a TypeError traceback when it runs").some((s) => s.id === "systematic-debugging"));
    assert.equal(pickSkills(DEFAULT_SKILLS.Cartographer, "draw a mermaid diagram of the flow")[0].id, "mermaid-expert");
  });
  it("routes the new modes' chips", () => {
    const top = (mode: string, text: string) => pickSkills(DEFAULT_SKILLS[mode], text)[0].id;
    assert.equal(top("Nightwatch", "What should I log?"), "observability-and-instrumentation");
    assert.equal(top("Nightwatch", "write the postmortem for last night's outage"), "postmortem-writing");
    assert.equal(top("Lattice", "Split this module"), "ddd-strategic-design");
    assert.equal(top("Lattice", "Draw the boundary"), "ddd-context-mapping");
    assert.equal(top("Oracle", "What do I give up?"), "architecture-decision-records");
    assert.equal(top("Oracle", "I'm stuck and don't know where to start"), "decision-navigator");
  });
  it("caps at two and falls back to the first skill", () => {
    assert.ok(pickSkills(hack, "threat model this llm agent for xss and sql injection").length <= 2);
    assert.deepEqual(pickSkills(DEFAULT_SKILLS.Scribe, "hello").map((s) => s.id), ["documentation-templates"]);
  });
  it("ignores unknown ids and empty lists", () => {
    assert.deepEqual(pickSkills(["nope"], "anything"), []);
    assert.deepEqual(pickSkills(undefined, "anything"), []);
  });
});
