/**
 * Tests for bridge-write-validator.ts -- TS port of vault_write_validator.py
 *
 * Mirrors tests/test_vault_write_validator.py 1:1.
 * One TS-only addition: regression test for the heading-skip f-string bug fix.
 */

import { describe, it, expect } from "vitest";
import {
  ValidationResult,
  countCodeFences,
  extractHeadings,
  extractUrls,
  extractWikilinks,
  hasFrontmatter,
  validateVaultWrite,
} from "../../src/safety/bridge-write-validator";


// ---------- hasFrontmatter ----------

describe("hasFrontmatter", () => {
  it("positive minimal", () => {
    const text = "---\ntitle: Foo\n---\n\nbody\n";
    expect(hasFrontmatter(text)).toBe(true);
  });

  it("positive multi-line", () => {
    const text = "---\ntitle: Foo\ntags: [a, b]\ndate: 2026-04-08\n---\n\ncontent\n";
    expect(hasFrontmatter(text)).toBe(true);
  });

  it("negative no leader", () => {
    const text = "# just a heading\n\nbody\n";
    expect(hasFrontmatter(text)).toBe(false);
  });

  it("negative leader not at start", () => {
    const text = "\n---\ntitle: Foo\n---\n\nbody\n";
    expect(hasFrontmatter(text)).toBe(false);
  });

  it("negative unclosed", () => {
    const text = "---\ntitle: Foo\n\nbody without closer\n";
    expect(hasFrontmatter(text)).toBe(false);
  });

  it("empty string", () => {
    expect(hasFrontmatter("")).toBe(false);
  });
});


// ---------- extractUrls ----------

describe("extractUrls", () => {
  it("single http", () => {
    expect(extractUrls("see http://example.com for details")).toEqual(new Set(["http://example.com"]));
  });

  it("multiple https", () => {
    const text = "refs: https://a.example and https://b.example/path?q=1";
    expect(extractUrls(text)).toEqual(new Set(["https://a.example", "https://b.example/path?q=1"]));
  });

  it("stops at paren", () => {
    const text = "[link](https://example.com/page)";
    expect(extractUrls(text)).toEqual(new Set(["https://example.com/page"]));
  });

  it("none in plain text", () => {
    expect(extractUrls("no links here, just prose.")).toEqual(new Set());
  });
});


// ---------- extractWikilinks ----------

describe("extractWikilinks", () => {
  it("plain target", () => {
    expect(extractWikilinks("see [[FooNote]] please")).toEqual(new Set(["FooNote"]));
  });

  it("with alias", () => {
    expect(extractWikilinks("see [[FooNote|the foo note]]")).toEqual(new Set(["FooNote"]));
  });

  it("multiple mixed", () => {
    const text = "[[A]] and [[B|label]] and [[C]]";
    expect(extractWikilinks(text)).toEqual(new Set(["A", "B", "C"]));
  });

  it("none", () => {
    expect(extractWikilinks("plain text, no links.")).toEqual(new Set());
  });
});


// ---------- countCodeFences ----------

describe("countCodeFences", () => {
  it("zero", () => {
    expect(countCodeFences("no fences here")).toBe(0);
  });

  it("balanced pair", () => {
    const text = "```\nprint('hi')\n```\n";
    expect(countCodeFences(text)).toBe(2);
  });

  it("unbalanced odd", () => {
    const text = "```\nprint('hi')\n";
    expect(countCodeFences(text)).toBe(1);
  });

  it("multiple blocks", () => {
    const text = "```py\nx\n```\n\n```js\ny\n```\n";
    expect(countCodeFences(text)).toBe(4);
  });
});


// ---------- extractHeadings ----------

describe("extractHeadings", () => {
  it("mixed levels", () => {
    const text = "# Top\n\n## Sub\n\n### Deep\n";
    expect(extractHeadings(text)).toEqual([[1, "Top"], [2, "Sub"], [3, "Deep"]]);
  });

  it("trims trailing whitespace", () => {
    const text = "# Foo   \n## Bar\n";
    expect(extractHeadings(text)).toEqual([[1, "Foo"], [2, "Bar"]]);
  });

  it("none", () => {
    expect(extractHeadings("just a paragraph\n")).toEqual([]);
  });
});


// ---------- validateVaultWrite: frontmatter ----------

describe("frontmatter validation", () => {
  it("require_frontmatter missing errors", () => {
    const result = validateVaultWrite("# title\n\nbody\n", null, { requireFrontmatter: true });
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("frontmatter"))).toBe(true);
  });

  it("require_frontmatter present passes", () => {
    const text = "---\ntitle: Foo\n---\n\n# body\n";
    const result = validateVaultWrite(text, null, { requireFrontmatter: true });
    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("frontmatter drop detection", () => {
    const original = "---\ntitle: Foo\n---\n\noriginal body\n";
    const newContent = "# rewritten body without frontmatter\n";
    const result = validateVaultWrite(newContent, original);
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("dropped"))).toBe(true);
  });

  it("frontmatter preserved no error", () => {
    const original = "---\ntitle: Foo\n---\n\nbody\n";
    const newContent = "---\ntitle: Foo\ntags: [x]\n---\n\nnew body\n";
    const result = validateVaultWrite(newContent, original);
    expect(result.isValid).toBe(true);
  });
});


// ---------- validateVaultWrite: wikilinks ----------

describe("wikilink validation", () => {
  it("bracket mismatch open without close", () => {
    const result = validateVaultWrite("see [[foo and more text\n");
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("bracket mismatch"))).toBe(true);
  });

  it("bracket mismatch close without open", () => {
    const result = validateVaultWrite("see foo]] and more\n");
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("bracket mismatch"))).toBe(true);
  });

  it("balanced passes", () => {
    const result = validateVaultWrite("see [[Foo]] and [[Bar]]\n");
    expect(result.isValid).toBe(true);
  });

  it("drop detection", () => {
    const original = "refs [[Alpha]] and [[Beta]]\n";
    const newContent = "refs [[Alpha]] only\n";
    const result = validateVaultWrite(newContent, original);
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("dropped"))).toBe(true);
  });

  it("drop reports up to five lost with ellipsis", () => {
    const original = "[[A]] [[B]] [[C]] [[D]] [[E]] [[F]] [[G]]\n";
    const newContent = "nothing left\n";
    const result = validateVaultWrite(newContent, original);
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes("...") && e.includes("wikilinks dropped"))).toBe(true);
  });
});


// ---------- validateVaultWrite: code fences ----------

describe("code fence validation", () => {
  it("unclosed code fence errors", () => {
    const text = "intro\n\n```python\nprint('hi')\n";
    const result = validateVaultWrite(text);
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("code fence"))).toBe(true);
  });

  it("balanced code fences pass", () => {
    const text = "intro\n\n```python\nprint('hi')\n```\n";
    const result = validateVaultWrite(text);
    expect(result.isValid).toBe(true);
  });

  it("multiple balanced code fences pass", () => {
    const text = "```py\na\n```\n\ntext\n\n```js\nb\n```\n";
    const result = validateVaultWrite(text);
    expect(result.isValid).toBe(true);
  });
});


// ---------- validateVaultWrite: heading hierarchy ----------

describe("heading hierarchy validation", () => {
  it("heading skip h1->h3 is warning not error", () => {
    const text = "# Top\n\n### Deep (skipped h2)\n";
    const result = validateVaultWrite(text);
    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.toLowerCase().includes("heading skip"))).toBe(true);
  });

  it("h1 h2 h3 passes clean", () => {
    const text = "# Top\n\n## Mid\n\n### Deep\n";
    const result = validateVaultWrite(text);
    expect(result.isValid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("descent then ascent is not a skip", () => {
    const text = "# A\n\n## B\n\n### C\n\n## D\n";
    const result = validateVaultWrite(text);
    expect(result.isValid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("heading skip h2->h4 is warning", () => {
    const text = "## Mid\n\n#### WayDown\n";
    const result = validateVaultWrite(text);
    expect(result.isValid).toBe(true);
    expect(result.warnings.some((w) => w.toLowerCase().includes("heading skip"))).toBe(true);
  });
});


// ---------- TS-only regression: heading skip uses computed level (f-string fix) ----------

describe("heading skip warning uses computed level (TS f-string bug fix)", () => {
  it("h1->h3 skip warning mentions h2 not literal text", () => {
    // Python vault_write_validator.py:185 emits literal "h{prev_level + 1}"
    // due to missing f-prefix. TS port fixes this.
    const text = "# Top\n\n### Deep (skipped h2)\n";
    const result = validateVaultWrite(text);
    expect(result.warnings.length).toBeGreaterThan(0);
    const w = result.warnings[0];
    // Should contain "h2" (computed), NOT literal "{prev_level + 1}"
    expect(w).toContain("h2");
    expect(w).not.toContain("{prev_level");
    expect(w).not.toContain("{prev_level + 1}");
  });

  it("h2->h4 skip warning mentions h3 not literal text", () => {
    const text = "## Section\n\n#### Deep\n";
    const result = validateVaultWrite(text);
    expect(result.warnings.length).toBeGreaterThan(0);
    const w = result.warnings[0];
    expect(w).toContain("h3");
    expect(w).not.toContain("{prev_level");
  });
});


// ---------- validateVaultWrite: URL preservation ----------

describe("URL preservation", () => {
  it("url drop detection", () => {
    const original = "see https://a.example and https://b.example\n";
    const newContent = "see https://a.example only\n";
    const result = validateVaultWrite(newContent, original);
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("url"))).toBe(true);
  });

  it("url preserved passes", () => {
    const original = "see https://a.example\n";
    const newContent = "updated: see https://a.example for more\n";
    const result = validateVaultWrite(newContent, original);
    expect(result.isValid).toBe(true);
  });

  it("url added is fine", () => {
    const original = "baseline\n";
    const newContent = "baseline with https://new.example link\n";
    const result = validateVaultWrite(newContent, original);
    expect(result.isValid).toBe(true);
  });
});


// ---------- validateVaultWrite: clean passes ----------

describe("clean passes", () => {
  it("clean create passes", () => {
    const text = "# Title\n\n## Section\n\nBody paragraph with [[Link]] and https://ex.example.\n";
    const result = validateVaultWrite(text);
    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("clean modify passes", () => {
    const original = (
      "---\ntitle: Foo\n---\n\n# Top\n\n## Mid\n\n" +
      "See [[Target]] and https://a.example/page\n\n```py\nprint(1)\n```\n"
    );
    const newContent = (
      "---\ntitle: Foo\ntags: [updated]\n---\n\n# Top\n\n## Mid\n\n" +
      "See [[Target]] and https://a.example/page plus more context.\n\n```py\nprint(1)\nprint(2)\n```\n"
    );
    const result = validateVaultWrite(newContent, original);
    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("create mode has no preservation checks", () => {
    const text = "a fresh note with no prior state\n";
    const result = validateVaultWrite(text, null);
    expect(result.isValid).toBe(true);
  });
});


// ---------- ValidationResult shape ----------

describe("ValidationResult shape", () => {
  it("defaults", () => {
    // Since TS uses a factory function (not a class), test the shape directly
    const result = validateVaultWrite("plain text\n");
    expect(result.isValid).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});


// ---------- Combined failure surfaces all errors ----------

describe("combined failure surfaces all errors", () => {
  it("multiple failures collected in single pass", () => {
    const original = "---\ntitle: Foo\n---\n\nsee [[A]] and https://x.example\n";
    const newContent = "no frontmatter, no links, no urls\n```\nunclosed fence\n";
    const result = validateVaultWrite(newContent, original, { requireFrontmatter: true });
    expect(result.isValid).toBe(false);
    const joined = result.errors.join(" | ").toLowerCase();
    expect(joined).toContain("frontmatter");
    expect(joined).toContain("wikilink");
    expect(joined).toContain("url");
    expect(joined).toContain("code fence");
  });
});
