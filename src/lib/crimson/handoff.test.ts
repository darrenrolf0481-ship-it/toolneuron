import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findHandoff, formatHandoff, HANDOFF_NAME, handoffBlock, handoffFrom, labelHistory, stripModeLabel } from "./handoff.ts";

describe("handoff note", () => {
  const note = formatHandoff("Architect", "  1. Split the parser.\n2. Add tests.  ", new Date(2026, 10, 10, 9, 5));
  it("formats with the mode, time and reply", () => {
    assert.ok(note.startsWith("# Handoff from Architect\n"));
    assert.ok(note.includes("_2026-11-10 09:05."));
    assert.ok(note.endsWith("1. Split the parser.\n2. Add tests.\n"));
    assert.equal(handoffFrom(note), "Architect");
  });
  it("still works when the user edits the heading away", () => {
    assert.equal(handoffFrom("just my notes"), null);
    assert.ok(handoffBlock("just my notes").startsWith("Handoff note (handoff.md)."));
  });
  it("pins nothing for an empty or missing note", () => {
    assert.equal(handoffBlock(""), "");
    assert.equal(handoffBlock("   \n"), "");
    assert.equal(handoffBlock(undefined), "");
  });
  it("names the mode and stays within budget", () => {
    assert.ok(handoffBlock(note).startsWith("Handoff note from Architect mode"));
    const long = handoffBlock(formatHandoff("Oracle", "x".repeat(10000), new Date()), 1000);
    assert.ok(long.length <= 1000, String(long.length));
    assert.ok(long.endsWith("[note cut for length]"));
  });
  it("finds the note only at the project root", () => {
    const files = [
      { id: "root", name: "Project", type: "folder", parentId: null },
      { id: "sub", name: "src", type: "folder", parentId: "root" },
      { id: "a", name: HANDOFF_NAME, type: "file", parentId: "sub" },
    ];
    assert.equal(findHandoff(files), undefined);
    assert.equal(findHandoff([...files, { id: "b", name: HANDOFF_NAME, type: "file", parentId: "root" }])?.id, "b");
  });
});

describe("stripModeLabel", () => {
  it("drops a copied label at the start only", () => {
    assert.equal(stripModeLabel("[Reply from Syntax-Prime mode]\n```python\nx\n```"), "```python\nx\n```");
    assert.equal(stripModeLabel("  [Reply from Architect mode] Plan: a"), "Plan: a");
    assert.equal(stripModeLabel("See [Reply from Architect mode] above"), "See [Reply from Architect mode] above");
    assert.equal(stripModeLabel("[Reply from"), "[Reply from");
  });
});

describe("labelHistory", () => {
  it("labels replies from other modes only", () => {
    const out = labelHistory(
      [
        { role: "user", text: "plan it" },
        { role: "ai", text: "the plan", mode: "Architect" },
        { role: "ai", text: "mine", mode: "Syntax-Prime" },
        { role: "ai", text: "old reply" },
      ],
      "Syntax-Prime",
    );
    assert.deepEqual(out.map((m) => m.content), ["plan it", "[Reply from Architect mode]\nthe plan", "mine", "old reply"]);
    assert.equal(out[1].role, "ai");
  });
});
