import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  anxiety,
  applyEdits,
  clusterFindings,
  numberCode,
  parseBallots,
  parseEdits,
  parseFindings,
  parseVerdict,
  patchContext,
  tally,
  verifyFinding,
  type RawFinding,
} from "./protocol.ts";

const CODE = `def get_user(user_id):
    query = f"SELECT * FROM users WHERE id = {user_id}"
    result = db.execute(query)
    return result

def risky():
    try:
        result = risky_operation()
    except:
        pass
    return result[0]
`;

const block = (lines: string, quote: string, sev = "high", claim = "A problem.") =>
  `<<<FINDING\nLINES: ${lines}\nSEV: ${sev}\nQUOTE: ${quote}\nCLAIM: ${claim}\nWHY: Because.\n>>>`;

describe("parseFindings", () => {
  it("parses blocks and ignores prose and unclosed blocks", () => {
    const text = `Sure!\n${block("2-3", 'query = f"SELECT * FROM users WHERE id = {user_id}"')}\nnote\n${block("9", "`except:`", "LOW")}\n<<<FINDING\nLINES: 1\nSEV: high\nQUOTE: def get_user\nCLAIM: cut off`;
    const found = parseFindings("sentry", text);
    assert.equal(found.length, 2);
    assert.deepEqual([found[0].start, found[0].end, found[0].sev], [2, 3, "high"]);
    assert.equal(found[1].quote, "except:");
    assert.equal(found[1].sev, "low");
  });
  it("caps at 3 and skips blocks missing fields", () => {
    const text = [block("1", "a"), "<<<FINDING\nLINES: 2\nSEV: high\nCLAIM: no quote\n>>>", block("3", "b"), block("4", "c"), block("5", "d")].join("\n");
    assert.equal(parseFindings("pattern", text).length, 3);
  });
  it("returns nothing for NO FINDINGS", () => assert.equal(parseFindings("pattern", "NO FINDINGS").length, 0));
});

describe("verifyFinding", () => {
  const raw = (start: number, end: number, quote: string): RawFinding => ({ agent: "pattern", start, end, sev: "high", quote, claim: "c", why: "w" });
  it("keeps a quote inside the ±2 window", () => assert.ok(verifyFinding(raw(4, 4, "db.execute(query)"), CODE, 12)));
  it("relocates a real quote with miscounted lines", () => {
    const fixed = verifyFinding(raw(1, 1, "return result[0]"), CODE, 12);
    assert.deepEqual([fixed?.start, fixed?.end], [11, 11]);
  });
  it("tolerates whitespace differences", () => assert.ok(verifyFinding(raw(8, 8, "result =   risky_operation()"), CODE, 12)));
  it("drops hallucinated quotes", () => assert.equal(verifyFinding(raw(2, 2, "os.system(user_id)"), CODE, 12), null));
  it("drops quotes beyond the shown lines", () => assert.equal(verifyFinding(raw(11, 11, "return result[0]"), CODE, 5), null));
});

describe("cluster + tally + anxiety", () => {
  const f = (agent: RawFinding["agent"], start: number, end: number, sev: RawFinding["sev"] = "medium"): RawFinding => ({ agent, start, end, sev, quote: "q", claim: `${agent} ${start}`, why: "" });
  it("merges overlapping ranges and ranks multi-agent clusters first", () => {
    const out = clusterFindings([f("pattern", 9, 10), f("sentry", 2, 3, "high"), f("wildcard", 3, 4), f("pattern", 20, 20, "high")]);
    assert.equal(out.length, 3);
    assert.deepEqual(out[0].raisedBy.sort(), ["sentry", "wildcard"]);
    assert.equal(out[0].sev, "high");
    assert.deepEqual(out.map((x) => x.id), ["F1", "F2", "F3"]);
  });
  it("caps at five findings", () => assert.equal(clusterFindings([1, 10, 20, 30, 40, 50, 60].map((n) => f("pattern", n, n))).length, 5));
  it("computes consensus, majority, lead and cross-model", () => {
    const base = clusterFindings([f("sentry", 2, 3, "high"), f("pattern", 9, 10), f("wildcard", 20, 20)]);
    const ids = base.map((x) => x.id);
    const out = tally(
      base,
      { pattern: { [ids[0]]: "AGREE", [ids[1]]: "AGREE", [ids[2]]: "DISPUTE" }, sentry: { [ids[1]]: "DISPUTE", [ids[2]]: "DISPUTE" }, wildcard: { [ids[0]]: "ABSTAIN", [ids[1]]: "AGREE" } },
      { pattern: "omniroute", sentry: "openrouter", wildcard: "omniroute" },
      false,
    );
    const by = Object.fromEntries(out.map((x) => [x.claim, x]));
    assert.equal(by["sentry 2"].status, "consensus"); // sentry (raiser) + pattern agree, wildcard abstains
    assert.equal(by["sentry 2"].crossModel, true);
    assert.equal(by["pattern 9"].status, "majority"); // pattern + wildcard agree, sentry disputes
    assert.equal(by["pattern 9"].crossModel, false); // both on omniroute
    assert.equal(by["wildcard 20"].status, "lead");
    assert.equal(out[0].status, "consensus");
  });
  it("never claims consensus on a degraded run", () => {
    const base = clusterFindings([f("sentry", 2, 3), f("pattern", 2, 3)]);
    assert.equal(tally(base, {}, {}, true)[0].status, "lead");
  });
  it("anxiety: clean unanimous is low, silent + disputed is high", () => {
    assert.equal(anxiety([], 0), 0.02);
    const base = clusterFindings([f("sentry", 2, 3), f("pattern", 2, 3), f("wildcard", 2, 3)]);
    assert.equal(anxiety(tally(base, {}, {}, false), 0), 0.02);
    const split = tally(clusterFindings([f("sentry", 2, 3)]), { pattern: { F1: "DISPUTE" }, wildcard: { F1: "DISPUTE" } }, {}, false);
    assert.ok(anxiety(split, 0) > 0.3);
    assert.ok(anxiety(split, 2) > 0.6);
    assert.ok(anxiety([], 3) <= 0.98);
  });
});

describe("ballots", () => {
  it("parses varied formats and ignores unknown ids", () => {
    const votes = parseBallots("F1: AGREE - real\n**F2** - dispute, not in code\nF3: **ABSTAIN**\nF9: AGREE\nF1: DISPUTE", ["F1", "F2", "F3"]);
    assert.deepEqual(votes, { F1: "AGREE", F2: "DISPUTE", F3: "ABSTAIN" });
  });
});

describe("edits", () => {
  const edit = "<<<EDIT\nFIND:\n    except:\n        pass\nREPLACE:\n    except Exception as error:\n        raise RuntimeError(\"risky_operation failed\") from error\n>>>";
  it("parses and applies an exact unique edit", () => {
    const edits = parseEdits(`Here you go\n${edit}`);
    assert.equal(edits.length, 1);
    const out = applyEdits(CODE, edits);
    assert.ok(out.ok && out.code.includes("except Exception as error:") && !out.code.includes("        pass"));
  });
  it("rejects missing, ambiguous and oversized FIND", () => {
    assert.equal(applyEdits(CODE, [{ find: "nope()", replace: "x" }]).ok, false);
    assert.equal(applyEdits(CODE, [{ find: "result", replace: "x" }]).ok, false);
    assert.equal(applyEdits(CODE, [{ find: "x".repeat(401), replace: "y" }]).ok, false);
    assert.equal(applyEdits(CODE, []).ok, false);
  });
  it("is whitespace-exact", () => assert.equal(applyEdits(CODE, [{ find: "except:\n    pass", replace: "x" }]).ok, false));
  it("does not treat $ sequences in REPLACE specially", () => {
    const out = applyEdits("a = 1\n", [{ find: "a = 1", replace: "a = '$&$1'" }]);
    assert.ok(out.ok && out.code === "a = '$&$1'\n");
  });
  it("allows deleting lines (empty REPLACE)", () => {
    const edits = parseEdits("<<<EDIT\nFIND:\n    return result\nREPLACE:\n>>>");
    assert.equal(edits.length, 1);
    assert.equal(edits[0].replace, "");
  });
});

describe("misc", () => {
  it("parses verdicts", () => {
    assert.deepEqual(parseVerdict("<<<VERDICT: VETO\nREASON: removes the return\n>>>"), { approve: false, reason: "removes the return" });
    assert.equal(parseVerdict("<<<VERDICT: APPROVE\nREASON: ok >>>")?.approve, true);
    assert.equal(parseVerdict("looks fine"), null);
  });
  it("numbers code and truncates on whole lines", () => {
    const out = numberCode("a\nb\nc", 10);
    assert.equal(out.text, "1| a\n2| b");
    assert.deepEqual([out.shownLines, out.totalLines], [2, 3]);
  });
  it("patchContext returns a window containing the finding for long files", () => {
    const long = Array.from({ length: 400 }, (_, i) => `line_${i + 1} = ${i}`).join("\n");
    const ctx = patchContext(long, { start: 300, end: 301 }, 1000);
    assert.ok(ctx.length <= 1000 && ctx.includes("line_300 =") && !ctx.includes("line_1 ="));
  });
});
