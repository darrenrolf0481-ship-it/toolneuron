import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatHandoff, HANDOFF_NAME } from "./handoff.ts";
import {
  BASE_RULES,
  historyForModel,
  OLD_WELCOME,
  pickWorkFile,
  PROMPT_BUDGET,
  systemPrompt,
  terminalPrompt,
  upgradeWelcome,
  WELCOME,
  withDefaultSkills,
  type PromptState,
} from "./prompt.ts";
import type { ChatMessage, ProjectFile } from "./types.ts";

const root: ProjectFile = { id: "root", name: "Project", type: "folder", parentId: null };
const code: ProjectFile = { id: "code", name: "app.py", type: "file", parentId: "root", language: "python", content: "def avg(xs):\n    return sum(xs) / len(xs)\n" };
const other: ProjectFile = { id: "other", name: "util.js", type: "file", parentId: "root", language: "javascript", content: "export const x = 1;\n" };
const note: ProjectFile = { id: "note", name: HANDOFF_NAME, type: "file", parentId: "root", language: "markdown", content: formatHandoff("Architect", "1. Guard empty lists.", new Date(2026, 10, 10)) };

const syntax = { id: 2, name: "Syntax-Prime", instruction: "You are Syntax-Prime.", active: true, suggestions: [], skills: ["systematic-debugging", "tdd"] };
const state = (patch: Partial<PromptState> = {}): PromptState => ({
  personalities: [{ id: 1, name: "Architect", instruction: "You are Architect.", active: false, suggestions: [], skills: ["architecture"] }, syntax],
  files: [root, code, other],
  activeFileId: "code",
  workFileId: "code",
  draft: code.content!,
  packs: [],
  ...patch,
});

describe("systemPrompt", () => {
  it("orders persona, rules, skills, then the open file", () => {
    const { prompt, skills } = systemPrompt(state(), "I get a ZeroDivisionError traceback");
    assert.ok(prompt.startsWith("You are Syntax-Prime.\n\n" + BASE_RULES));
    assert.deepEqual(skills, ["Systematic debugging"]);
    assert.ok(prompt.indexOf("Systematic debugging") < prompt.indexOf("Open file app.py:"));
    assert.ok(prompt.endsWith(code.content!));
  });
  it("sends the live draft of the open file, not the saved copy", () => {
    assert.ok(systemPrompt(state({ draft: "def avg(xs): pass  # edited" }), "x").prompt.includes("# edited"));
  });
  it("pins the handoff note before the file", () => {
    const { prompt } = systemPrompt(state({ files: [root, code, note] }), "do step 1");
    assert.ok(prompt.includes("Handoff note from Architect mode"));
    assert.ok(prompt.indexOf("Guard empty lists") < prompt.indexOf("Open file app.py:"));
  });
  it("with the note open, still sends the work file (saved copy) and the note once", () => {
    const { prompt } = systemPrompt(state({ files: [root, code, note], activeFileId: "note", workFileId: "code", draft: note.content! + "\n2. Add a test." }), "go");
    assert.ok(prompt.includes(`Working file app.py (the user has ${HANDOFF_NAME} open in the editor):\n${code.content}`));
    assert.ok(prompt.includes("2. Add a test."), "the note's live draft is pinned");
    assert.equal(prompt.split("Guard empty lists").length - 1, 1);
  });
  it("keeps a huge file within budget", () => {
    const big = { ...code, content: "x = 1\n".repeat(5000) };
    const { prompt } = systemPrompt(state({ files: [root, big, note], draft: big.content }), "review");
    assert.ok(prompt.length <= PROMPT_BUDGET, String(prompt.length));
    assert.ok(prompt.includes("Open file app.py:"));
  });
  it("works with no open file", () => {
    const { prompt } = systemPrompt(state({ activeFileId: "", workFileId: "" }), "hi");
    assert.ok(!prompt.includes("Open file"));
  });
});

describe("terminalPrompt", () => {
  it("uses one skill, a shorter note and the cwd", () => {
    const { prompt, skills } = terminalPrompt(state({ files: [root, code, { ...note, content: formatHandoff("Oracle", "y".repeat(5000), new Date()) }] }), "write a unit test", "~/project");
    assert.equal(skills.length, 1);
    assert.ok(prompt.includes("Handoff note from Oracle mode"));
    assert.ok(prompt.length < 2600, String(prompt.length));
    assert.ok(prompt.endsWith("Current directory ~/project."));
  });
});

describe("historyForModel", () => {
  const msg = (role: "user" | "ai", text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role, text, timestamp: 0, ...extra });
  it("drops notices, refused turns and the welcome line; labels other modes", () => {
    const out = historyForModel(
      [
        msg("ai", WELCOME, { intro: true }),
        msg("user", "plan it"),
        msg("ai", "1. guard", { mode: "Architect" }),
        msg("user", "while locked"),
        msg("ai", "AI is locked", { error: true }),
        msg("user", "do step 1"),
      ],
      "Syntax-Prime",
    );
    assert.deepEqual(out.map((m) => m.content), ["plan it", "[Reply from Architect mode]\n1. guard", "do step 1"]);
  });
  it("keeps only the last 8", () => {
    const many = Array.from({ length: 20 }, (_, i) => msg(i % 2 ? "ai" : "user", `m${i}`));
    assert.deepEqual(historyForModel(many, "x").map((m) => m.content)[0], "m12");
  });
});

describe("save upgrades", () => {
  it("pickWorkFile: saved, else open, else first non-note file", () => {
    const files = [root, code, other, note];
    assert.equal(pickWorkFile(files, "other", "code"), "other");
    assert.equal(pickWorkFile(files, "gone", "code"), "code");
    assert.equal(pickWorkFile(files, undefined, "note"), "code");
    assert.equal(pickWorkFile([root, note], undefined, "note"), "");
  });
  it("withDefaultSkills fills built-in modes once and leaves custom ones", () => {
    const list = [
      { id: 10, name: "Nightwatch", instruction: "", active: false, suggestions: [], skills: [] as string[] },
      { id: 99, name: "Mine", instruction: "", active: false, suggestions: [] },
    ];
    const old = withDefaultSkills(list, 0);
    assert.equal(old[0].skills?.[0], "error-detective");
    assert.deepEqual(old[1].skills, []);
    assert.deepEqual(withDefaultSkills(list, 2)[0].skills, [], "a mode cleared after rev 2 stays empty");
  });
  it("upgradeWelcome rewrites the old Architect welcome only", () => {
    assert.deepEqual(upgradeWelcome({ role: "ai", text: OLD_WELCOME, timestamp: 1 }), { role: "ai", text: WELCOME, timestamp: 1, intro: true });
    const reply: ChatMessage = { role: "ai", text: "I am running tests", timestamp: 2 };
    assert.equal(upgradeWelcome(reply), reply);
  });
});
