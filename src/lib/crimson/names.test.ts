import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nameProblem } from "./names.ts";
import type { ProjectFile } from "./types.ts";

const files: ProjectFile[] = [
  { id: "root", name: "Project", type: "folder", parentId: null },
  { id: "src", name: "src", type: "folder", parentId: "root" },
  { id: "a", name: "a.ts", type: "file", parentId: "src", content: "" },
];

describe("nameProblem", () => {
  it("accepts ordinary names, including the same name in another folder", () => {
    assert.equal(nameProblem(files, "src", "b.ts"), null);
    assert.equal(nameProblem(files, "root", "a.ts"), null);
    assert.equal(nameProblem(files, "src", "a.ts", "a"), null, "renaming to its own name");
  });
  it("refuses duplicates, slashes, dot names, empty and overlong names", () => {
    assert.match(nameProblem(files, "src", "a.ts")!, /A file named "a.ts" is already here/);
    assert.match(nameProblem(files, "root", "src")!, /A folder named "src"/);
    assert.match(nameProblem(files, "src", "x/y.ts")!, /cannot contain \//);
    assert.match(nameProblem(files, "src", "..")!, /not allowed/);
    assert.match(nameProblem(files, "src", "   ")!, /required/);
    assert.match(nameProblem(files, "src", "x".repeat(121))!, /at most 120/);
  });
});
