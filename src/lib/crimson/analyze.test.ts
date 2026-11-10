import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeSource } from "./analyze.ts";

const rules = (code: string, language = "") => analyzeSource(code, language).map((f) => `${f.line}:${f.rule}`);

describe("SQL injection", () => {
  it("flags real interpolation in all common forms", () => {
    const code = [
      'q = f"SELECT * FROM users WHERE id = {uid}"',
      'q = "SELECT * FROM users WHERE id = " + uid',
      'q = "DELETE FROM t WHERE id = {}".format(uid)',
      'q = "UPDATE t SET a = %s" % val',
      "const q = `SELECT * FROM users WHERE id = ${id}`;",
    ].join("\n");
    assert.deepEqual(rules(code), ["1:SQL injection", "2:SQL injection", "3:SQL injection", "4:SQL injection", "5:SQL injection"]);
  });
  it("ignores safe and non-SQL text", () => {
    const code = [
      'q = f"SELECT * FROM users"',
      'db.execute("SELECT * FROM users WHERE id = ?", (uid,))',
      '# q = f"SELECT * FROM users WHERE id = {uid}"',
      'msg = f"Please select {item}"',
      'label = "Select " + name',
    ].join("\n");
    assert.deepEqual(rules(code), []);
  });
  it("one finding per line and language-aware fix", () => {
    const out = analyzeSource('query = f"SELECT * FROM t WHERE a = {a}" + b', "python");
    assert.equal(out.length, 1);
    assert.match(out[0].fix, /\(user_id,\)/);
    assert.match(analyzeSource("const q = `SELECT a FROM t WHERE b = ${b}`", "javascript")[0].fix, /\$1/);
  });
});

describe("XSS", () => {
  it("flags all HTML sinks with dynamic values", () => {
    const code = [
      "el.innerHTML = userInput;",
      "el.outerHTML += row;",
      "el.insertAdjacentHTML('beforeend', html);",
      "document.write(data);",
      "<div dangerouslySetInnerHTML={{ __html: body }} />",
    ].join("\n");
    assert.deepEqual(rules(code), ["1:XSS", "2:XSS", "3:XSS", "4:XSS", "5:XSS"]);
  });
  it("ignores literals, sanitized values, comparisons and textContent", () => {
    const code = [
      'el.innerHTML = "";',
      "el.innerHTML = '<b>static</b>';",
      "el.insertAdjacentHTML('beforeend', '<hr>');",
      "el.innerHTML = DOMPurify.sanitize(input);",
      "if (el.innerHTML === old) {}",
      "el.textContent = input;",
    ].join("\n");
    assert.deepEqual(rules(code), []);
  });
});

describe("error handling + type hints", () => {
  it("bare except and swallowed broad except", () => {
    const code = "try:\n    a()\nexcept:\n    pass\ntry:\n    b()\nexcept Exception:\n    pass\ntry:\n    c()\nexcept ValueError:\n    pass";
    assert.deepEqual(rules(code, "python"), ["3:Error handling", "7:Error handling"]);
  });
  it("multi-line signatures, self/cls, defaults and return types", () => {
    const code = [
      "def a(x, y=1):",
      "def b(self, x: int) -> int:",
      "def c(",
      "    self,",
      "    name: str,",
      "    age,",
      ") -> None:",
      "def d(x: int):",
      "def e() -> None:",
      "def f(cls) -> None:",
    ].join("\n");
    const out = analyzeSource(code, "python");
    assert.deepEqual(out.map((f) => f.line), [1, 3, 8]);
    assert.match(out[0].message, /x, y/);
    assert.match(out[1].message, /age/);
    assert.match(out[2].message, /no return type/);
  });
  it("respects nested generics, defaults with commas, and __init__", () => {
    const code = [
      "def a(self, m: List[Dict[str, Any]], r: float) -> str:",
      "def b(x: Tuple[int, int] = (1, 2), s: str = 'a,b') -> None:",
      "    def __init__(self, engine: Any, system: Any):",
      "def c(x: Dict[str, Any], y):",
    ].join("\n");
    const out = analyzeSource(code, "python");
    assert.deepEqual(out.map((f) => f.line), [4]);
    assert.match(out[0].message, /Untyped parameter: y\./);
  });
  it("does not run python rules on javascript", () => assert.deepEqual(rules("def a(x):\n  pass", "javascript"), []));
});

describe("secrets", () => {
  it("flags real-looking keys, not placeholders or env reads", () => {
    const code = [
      'API_KEY = "sk-or-v1-0123456789abcdef0123456789abcdef"',
      'password = "hunter2hunter2"',
      'token = "your-token-here"',
      'api_key = os.environ["API_KEY"]',
      "const key = process.env.OPENROUTER_API_KEY;",
      'aws = "AKIAIOSFODNN7EXAMPLE"',
    ].join("\n");
    assert.deepEqual(rules(code), ["1:Hard-coded secret", "2:Hard-coded secret", "6:Hard-coded secret"]);
  });
});

describe("N+1", () => {
  it("follows the loop variable into the body", () => {
    const code = "posts = Post.objects.all()\nfor post in posts:\n    print(post.title, post.author.name)";
    const out = analyzeSource(code, "python").filter((f) => f.rule === "N+1 queries");
    assert.equal(out.length, 1);
    assert.equal(out[0].line, 2);
    assert.match(out[0].message, /line 3/);
  });
  it("ignores prefetched querysets, unrelated loops and attribute access outside the loop", () => {
    const prefetched = "posts = Post.objects.select_related('author').all()\nfor post in posts:\n    print(post.author.name)";
    const unrelated = "posts = Post.objects.all()\nfor i in range(3):\n    print(i)\nx = other.author.name";
    const outside = "posts = Post.objects.all()\nfor post in posts:\n    print(post.title)\nprint(post.author.name)";
    for (const code of [prefetched, unrelated, outside]) assert.deepEqual(rules(code, "python").filter((r) => r.includes("N+1")), []);
  });
});

describe("seed files", () => {
  it("audit_target.py hits the intended rules", () => {
    const audit = `def get_user(user_id):\n    query = f"SELECT * FROM users WHERE id = {user_id}"\n    result = db.execute(query)\n    return result\n\ndef load_posts():\n    posts = Post.objects.all()\n    for post in posts:\n        print(post.title, post.author.name)\n\ndef risky():\n    try:\n        result = risky_operation()\n    except:\n        pass\n    return result[0]\n`;
    assert.deepEqual(rules(audit, "python"), ["1:Type hints", "2:SQL injection", "8:N+1 queries", "14:Error handling"]);
  });
});
