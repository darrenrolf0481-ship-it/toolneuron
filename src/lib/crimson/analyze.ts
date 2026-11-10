import type { Finding } from "./types";

/**
 * Local, regex-level doctrine checks. Cheap and offline, so they favour
 * precision: a rule fires only when the risky pattern is really there.
 * The swarm and Review panes use these as evidence, not verdicts.
 */

const SQL = /\b(?:SELECT\s+(?:\*|\w)|INSERT\s+INTO\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b)/i;

function isComment(trimmed: string): boolean {
  return /^(#|\/\/|\/\*|\*|--)/.test(trimmed);
}

/** A string literal containing SQL with a value spliced in. */
function sqlInterpolated(line: string): boolean {
  if (!SQL.test(line)) return false;
  return (
    /\bf(["'])[^"']*\{[^}]+\}/i.test(line) || // python f-string
    /`[^`]*\$\{[^}]+\}/.test(line) || // js template literal
    /(["'])[^"']*\1\s*\+\s*[\w.[\]()]+/.test(line) || // "..." + value
    /[\w.)\]]\s*\+\s*(["'])/.test(line) || // value + "..."
    /(["'])[^"']*\{\d*\}[^"']*\1\s*\.format\s*\(/.test(line) || // "...{}".format(x)
    /(["'])[^"']*%[sd][^"']*\1\s*%\s*[\w(]/.test(line) // "...%s" % x
  );
}

const SECRET_ASSIGN = /\b(api[_-]?key|secret|token|passw(or)?d|private[_-]?key|access[_-]?key)\w*\s*[:=]\s*(["'])([^"'\s]{8,})\3/i;
const SECRET_SHAPES = /\b(sk-[A-Za-z0-9_-]{20,}|sk-or-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})\b/;
const PLACEHOLDER = /^(x+|\*+|your[_-]|changeme|placeholder|example|dummy|test|<.*>|\$\{)/i;

/** Splits a parameter list on top-level commas only (not inside Dict[str, Any] or defaults like (1, 2)). */
function splitParams(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

export function analyzeSource(code: string, language = ""): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const lines = code.split("\n");
  const python = /^(python|py)$/.test(language) || (!language && /^\s*(def|import|from)\s/m.test(code));
  const add = (finding: Finding) => {
    const key = `${finding.line}:${finding.rule}`;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push(finding);
    }
  };

  lines.forEach((line, index) => {
    const n = index + 1;
    const trimmed = line.trim();
    if (!trimmed || isComment(trimmed)) return;

    if (sqlInterpolated(line)) {
      add({
        severity: "critical",
        rule: "SQL injection",
        line: n,
        message: "A value is spliced into SQL text. If it can come from a user, it can rewrite the query.",
        fix: python
          ? 'Pass it as a parameter: db.execute("SELECT * FROM users WHERE id = ?", (user_id,))'
          : 'Pass it as a parameter: db.query("SELECT * FROM users WHERE id = $1", [userId])',
      });
    }

    const htmlSink =
      line.match(/\.(innerHTML|outerHTML)\s*(\+?=)(?!=)\s*(.*)$/) ??
      line.match(/\b(insertAdjacentHTML|document\.write(?:ln)?)\s*\((.*)$/) ??
      line.match(/\b(dangerouslySetInnerHTML)\s*=\s*\{(.*)$/);
    if (htmlSink && !/DOMPurify\.sanitize|sanitizeHtml|escapeHtml/.test(line)) {
      const value = (htmlSink[htmlSink.length - 1] ?? "").trim().replace(/[;)]+$/, "").trim();
      const insertArgs = htmlSink[1] === "insertAdjacentHTML" ? value.replace(/^(["'])\w+\1\s*,\s*/, "") : value;
      const literalOnly = /^(["'`])[^"'`$]*\1$/.test(insertArgs) || insertArgs === "";
      if (!literalOnly) {
        add({
          severity: "critical",
          rule: "XSS",
          line: n,
          message: `${htmlSink[1]} parses its value as HTML. If any part of it is user-controlled, that is script injection.`,
          fix: "Use textContent (or createElement + textContent), or sanitize with DOMPurify.sanitize() first.",
        });
      }
    }

    if (/^except\s*:/.test(trimmed)) {
      add({
        severity: "high",
        rule: "Error handling",
        line: n,
        message: "A bare except catches everything, including KeyboardInterrupt and real bugs you meant to see.",
        fix: "Catch the specific exception, log it, and choose a fallback on purpose.",
      });
    } else if (/^except\s+(Exception|BaseException)\b.*:\s*(pass)?$/.test(trimmed) && (/pass$/.test(trimmed) || lines[index + 1]?.trim() === "pass")) {
      add({
        severity: "high",
        rule: "Error handling",
        line: n,
        message: "This handler swallows every error silently.",
        fix: "Log the error or re-raise it; only ignore the specific exception you expect.",
      });
    }

    if (python && /^def\s+\w+\s*\(/.test(trimmed)) {
      // Signature may span several lines: collect up to the closing "):".
      let signature = trimmed;
      for (let next = index + 1; !/\)\s*(->[^:]*)?:\s*(#.*)?$/.test(signature) && next < lines.length && next < index + 15; next++) {
        signature += ` ${lines[next].trim()}`;
      }
      const match = signature.match(/^def\s+(\w+)\s*\(([\s\S]*)\)\s*(->[^:]*)?:/);
      if (match) {
        const [, fnName, rawParams, returns] = match;
        const params = splitParams(rawParams)
          .map((param) => param.trim())
          .filter((param) => param && param !== "self" && param !== "cls" && param !== "*" && param !== "/");
        const untyped = params.filter((param) => !param.split("=")[0].includes(":"));
        // __init__ returns None by definition; type checkers do not require "-> None" there.
        const needsReturn = !returns && params.length > 0 && fnName !== "__init__";
        if (untyped.length > 0 || needsReturn) {
          add({
            severity: "medium",
            rule: "Type hints",
            line: n,
            message: untyped.length
              ? `Untyped parameter${untyped.length === 1 ? "" : "s"}: ${untyped.map((param) => param.split(/[=:]/)[0].trim()).join(", ")}.`
              : "The parameters are typed but there is no return type.",
            fix: "Annotate each argument and the return type so the next reader can trust the shape.",
          });
        }
      }
    }

    const secret = line.match(SECRET_ASSIGN);
    const shaped = line.match(SECRET_SHAPES);
    if ((secret && !PLACEHOLDER.test(secret[4])) || shaped) {
      add({
        severity: "critical",
        rule: "Hard-coded secret",
        line: n,
        message: "This looks like a real key or password in the source. It will leak with the file (and is sent along when you ask the AI about it).",
        fix: python ? 'Read it from the environment: os.environ["API_KEY"]' : "Read it from the environment (process.env.API_KEY) on the server only.",
      });
    }
  });

  // N+1: loop over a queryset, then follow a relation on the loop variable inside the loop body.
  const querysets = new Map<string, boolean>(); // name -> prefetched?
  lines.forEach((line) => {
    const assign = line.match(/^\s*(\w+)\s*=\s*\w+\.objects\.(all|filter|exclude)\(/);
    if (assign) querysets.set(assign[1], /select_related|prefetch_related/.test(line));
  });
  lines.forEach((line, index) => {
    const loop = line.match(/^(\s*)for\s+(\w+)\s+in\s+([\w.]+(?:\([^)]*\))?)\s*:/);
    if (!loop) return;
    const [, indent, item, source] = loop;
    const direct = /\.objects\.(all|filter|exclude)\(/.test(source);
    const named = querysets.get(source);
    if (!direct && named === undefined) return;
    if (named === true || /select_related|prefetch_related/.test(source)) return;
    for (let next = index + 1; next < lines.length; next++) {
      const body = lines[next];
      if (body.trim() && body.match(/^\s*/)![0].length <= indent.length) break;
      if (new RegExp(`\\b${item}\\.\\w+\\.\\w+`).test(body)) {
        add({
          severity: "high",
          rule: "N+1 queries",
          line: index + 1,
          message: `Each pass of this loop follows a relation on "${item}" (line ${next + 1}), which costs one extra query per row.`,
          fix: "Fetch the relation up front: .select_related('author') for a foreign key, .prefetch_related() for many.",
        });
        break;
      }
    }
  });

  return findings.sort((a, b) => a.line - b.line);
}
