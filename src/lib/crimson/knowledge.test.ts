import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { knowledgeBlock, retrieve, sections, terms } from "./knowledge.ts";

const manual = [
  "Install. Run npm install, then copy .env.example to .env.",
  "Providers. OpenRouter needs OPENROUTER_API_KEY. OmniRoute needs its base URL.",
  "Vault. The vault encrypts notes with AES-GCM; the passphrase wraps the key with PBKDF2.",
  "Swarm. Three reviewers quote the code; a guard checks every fix before it is applied.",
].map((paragraph, i) => `${paragraph} ${"Filler words for padding only. ".repeat(14)}${i}`).join("\n\n");

describe("sections", () => {
  it("packs paragraphs up to the size and splits long lines", () => {
    assert.deepEqual(sections("a\n\nb\n\nc", 4), ["a\n\nb", "c"]);
    assert.equal(sections("x".repeat(25), 10).length, 3);
    assert.deepEqual(sections("  \n\n  "), []);
  });
  it("terms drop short words and stop words", () => {
    assert.deepEqual(terms("The vault ENCRYPTS notes, and it is ok"), ["vault", "encrypts", "notes"]);
  });
});

describe("retrieve", () => {
  const packs = [
    { id: "m", name: "Manual", excerpt: manual.slice(0, 40), text: manual, armed: true },
    { id: "o", name: "Off", excerpt: "vault vault vault", armed: false },
  ];
  it("finds the matching section deep in the text, not the start", () => {
    const found = retrieve(packs, "How does the vault encrypt my notes?", 200);
    assert.equal(found.matched, true);
    assert.match(found.sections[0].text, /^Vault\./);
    assert.ok(!found.sections.some((s) => s.pack === "Off"), "unarmed packs are ignored");
  });
  it("ranks by relevance and stays within budget", () => {
    const found = retrieve(packs, "swarm reviewers guard fix", 1800);
    assert.match(found.sections[0].text, /Swarm/);
    assert.ok(knowledgeBlock(found).length < 1900);
  });
  it("falls back to the start of each armed pack when nothing matches", () => {
    const found = retrieve(packs, "zebra quantum", 300);
    assert.equal(found.matched, false);
    assert.match(found.sections[0].text, /^Install\./);
    assert.match(knowledgeBlock(found), /^Knowledge \(start of the user's armed packs\):/);
  });
  it("old packs with only an excerpt still work; no armed packs gives nothing", () => {
    assert.equal(retrieve([{ id: "x", name: "Old", excerpt: "Never interpolate SQL.", armed: true }], "sql query").sections[0].text, "Never interpolate SQL.");
    assert.equal(knowledgeBlock(retrieve(packs.map((p) => ({ ...p, armed: false })), "vault")), "");
  });
});
