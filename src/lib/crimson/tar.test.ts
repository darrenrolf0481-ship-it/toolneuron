import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readTar } from "./tar.ts";

/** Minimal tar writer for tests: one 512-byte header per entry, data padded to 512. */
function entry(name: string, data: string | Uint8Array, type = "0", prefix = ""): Uint8Array {
  const body = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const header = new Uint8Array(512);
  const put = (text: string, at: number) => header.set(new TextEncoder().encode(text), at);
  put(name, 0);
  put("0000644\0", 100);
  put(body.length.toString(8).padStart(11, "0") + "\0", 124);
  header[156] = type.charCodeAt(0);
  put("ustar\0", 257);
  put("00", 263);
  if (prefix) put(prefix, 345);
  const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
  padded.set(body);
  const out = new Uint8Array(512 + padded.length);
  out.set(header);
  out.set(padded, 512);
  return out;
}

function tar(...parts: Uint8Array[]): Uint8Array {
  const end = new Uint8Array(1024);
  const total = parts.reduce((n, p) => n + p.length, 0) + end.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of [...parts, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A pax extended header: records are "<len> key=value\n", where len counts the whole record. */
const pax = (path: string) => {
  const body = ` path=${path}\n`;
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len++;
  return entry("PaxHeader", `${len}${body}`, "x");
};

describe("readTar", () => {
  it("keeps text files, strips the top folder, sorts by path", () => {
    const out = readTar(tar(entry("repo-abc/", "", "5"), entry("repo-abc/src/main.py", "print(1)\n"), entry("repo-abc/README.md", "# hi\n")));
    assert.deepEqual(out.files, [
      { path: "README.md", content: "# hi\n" },
      { path: "src/main.py", content: "print(1)\n" },
    ]);
  });
  it("reads ustar prefixes, pax long paths and GNU long names", () => {
    const deep = "a/".repeat(60) + "deep.txt";
    const out = readTar(tar(entry("x.txt", "p", "0", "repo-abc/pre"), pax(`repo-abc/${deep}`), entry("ignored-short-name", "pax"), entry("././@LongLink", `repo-abc/gnu/${"b".repeat(120)}.md\0`, "L"), entry("cut", "gnu")));
    assert.deepEqual(out.files.map((f) => f.path).sort(), [deep, `gnu/${"b".repeat(120)}.md`, "pre/x.txt"].sort());
  });
  it("skips binaries, invalid UTF-8, vendored folders, links and oversize files", () => {
    const out = readTar(
      tar(
        entry("r/logo.png", "PNG"),
        entry("r/data.bin.txt", new Uint8Array([104, 0, 105])),
        entry("r/latin.txt", new Uint8Array([0xff, 0xfe, 0x41])),
        entry("r/node_modules/x/index.js", "x"),
        entry("r/link", "", "2"),
        entry("r/big.txt", "x".repeat(300)),
        entry("r/ok.js", "ok"),
      ),
      { maxFiles: 10, maxFileBytes: 200, maxTotalBytes: 10_000 },
    );
    assert.deepEqual(out.files.map((f) => f.path), ["ok.js"]);
    assert.deepEqual(out.skipped, { binary: 3, tooLarge: 1, ignoredFolder: 1, overLimit: 0 });
  });
  it("stops at the file and size limits", () => {
    const many = Array.from({ length: 5 }, (_, i) => entry(`r/f${i}.txt`, "1234567890"));
    assert.equal(readTar(tar(...many), { maxFiles: 3, maxFileBytes: 100, maxTotalBytes: 1000 }).files.length, 3);
    const out = readTar(tar(...many), { maxFiles: 10, maxFileBytes: 100, maxTotalBytes: 25 });
    assert.equal(out.files.length, 2);
    assert.equal(out.skipped.overLimit, 3);
  });
  it("refuses paths that climb out", () => {
    assert.deepEqual(readTar(tar(entry("r/../../etc/passwd", "x"), entry("r/a//b.txt", "y"))).files, []);
  });
  it("ignores truncated input", () => {
    assert.deepEqual(readTar(new Uint8Array(100)).files, []);
  });
});
