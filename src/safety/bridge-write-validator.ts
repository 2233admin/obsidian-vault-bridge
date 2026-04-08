/**
 * bridge-write-validator.ts -- Local regex gate for LLM-generated vault writes.
 *
 * Mirror of vault_write_validator.py (Python reference implementation).
 * Five checks: frontmatter, wikilinks, code fences, heading hierarchy, URLs.
 *
 * One intentional divergence from Python: the heading-skip warning at
 * Python vault_write_validator.py:185 has an f-string bug -- the second
 * string literal is NOT an f-string, so it emits literal text
 * "h{prev_level + 1}" instead of the computed level. The TS port uses
 * a proper template literal (fixed). Python fix is tracked as a TODO
 * in vault_write_validator.py (out of scope for W7, separate commit).
 *
 * Pattern origin: JuliusBrussee/caveman (MIT, 2026-04).
 */

// ---------- Result type ----------

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

function makeResult(): ValidationResult {
  return { isValid: true, errors: [], warnings: [] };
}

function addError(r: ValidationResult, msg: string): void {
  r.isValid = false;
  r.errors.push(msg);
}

function addWarning(r: ValidationResult, msg: string): void {
  r.warnings.push(msg);
}


// ---------- Regex patterns ----------
// Must be IDENTICAL to vault_write_validator.py regexes.

// Caveman-original: URL set membership.
const URL_REGEX = /https?:\/\/[^\s)]+/g;

// Wikilink pairs. Captures [[target]] and [[target|alias]].
const WIKILINK_REGEX = /\[\[([^\[\]\|]+)(?:\|[^\[\]]+)?\]\]/g;

// Triple-backtick fence. Counted, not paired by content.
// Python: re.compile(r"^```", re.MULTILINE)
const CODE_FENCE_REGEX = /^```/gm;

// Heading line: capture level (1-6) and text.
// Python: re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE)
const HEADING_REGEX = /^(#{1,6})\s+(.+)$/gm;

// Frontmatter: --- on first line, --- closer somewhere later.
// Python: re.compile(r"\A---\s*\n.*?\n---\s*\n", re.DOTALL)
// \A = start of string (JS: /^---/). Use [\s\S] for DOTALL.
const FRONTMATTER_REGEX = /^---\s*\n[\s\S]*?\n---\s*\n/;


// ---------- Extractors (exported to match Python __all__) ----------

export function extractUrls(text: string): Set<string> {
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  // Reset lastIndex to avoid statefulness bug with /g flag
  const re = new RegExp(URL_REGEX.source, URL_REGEX.flags);
  while ((m = re.exec(text)) !== null) {
    matches.push(m[0]);
  }
  return new Set(matches);
}

export function extractWikilinks(text: string): Set<string> {
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(WIKILINK_REGEX.source, WIKILINK_REGEX.flags);
  while ((m = re.exec(text)) !== null) {
    matches.push(m[1]);
  }
  return new Set(matches);
}

export function countCodeFences(text: string): number {
  const re = new RegExp(CODE_FENCE_REGEX.source, CODE_FENCE_REGEX.flags);
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

export function extractHeadings(text: string): Array<[number, string]> {
  const result: Array<[number, string]> = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(HEADING_REGEX.source, HEADING_REGEX.flags);
  while ((m = re.exec(text)) !== null) {
    const level = m[1].length;
    const title = m[2].trim();
    result.push([level, title]);
  }
  return result;
}

export function hasFrontmatter(text: string): boolean {
  return FRONTMATTER_REGEX.test(text);
}


// ---------- Validators ----------

function _checkFrontmatter(
  original: string | null,
  newContent: string,
  requireFrontmatter: boolean,
  result: ValidationResult,
): void {
  if (requireFrontmatter && !hasFrontmatter(newContent)) {
    addError(result, "frontmatter missing or malformed (expected leading --- ... --- block)");
    return;
  }
  // If original had frontmatter, new must too.
  if (original !== null && hasFrontmatter(original) && !hasFrontmatter(newContent)) {
    addError(result, "frontmatter dropped (original had one, new does not)");
  }
}

function _checkWikilinks(
  original: string | null,
  newContent: string,
  result: ValidationResult,
): void {
  // Pair shape: any [[ without matching ]] is a parse error.
  const openCount = (newContent.match(/\[\[/g) ?? []).length;
  const closeCount = (newContent.match(/\]\]/g) ?? []).length;
  if (openCount !== closeCount) {
    addError(result, `wikilink bracket mismatch: ${openCount} '[[' vs ${closeCount} ']]'`);
  }

  // Preservation: if original had wikilinks, new should not drop them.
  if (original !== null) {
    const oldLinks = extractWikilinks(original);
    const newLinks = extractWikilinks(newContent);
    const lost = [...oldLinks].filter((l) => !newLinks.has(l));
    if (lost.length > 0) {
      const display = lost.sort().slice(0, 5);
      const suffix = lost.length > 5 ? " ..." : "";
      addError(result, `wikilinks dropped: ${JSON.stringify(display)}${suffix}`);
    }
  }
}

function _checkCodeFences(newContent: string, result: ValidationResult): void {
  const n = countCodeFences(newContent);
  if (n % 2 !== 0) {
    addError(result, `unclosed code fence: found ${n} \`\`\` markers (must be even)`);
  }
}

function _checkHeadingHierarchy(newContent: string, result: ValidationResult): void {
  const headings = extractHeadings(newContent);
  if (headings.length === 0) return;
  let prevLevel = headings[0][0];
  for (let i = 1; i < headings.length; i++) {
    const [level, title] = headings[i];
    if (level > prevLevel + 1) {
      // TS port fixes the Python f-string bug at vault_write_validator.py:185.
      // Python emits literal "h{prev_level + 1}" due to missing f-prefix.
      // Here we use a proper template literal with the computed level.
      // TODO(Python upstream): vault_write_validator.py:185 has f-string bug --
      // the second string literal is "consider inserting an h{prev_level + 1}"
      // but is NOT an f-string. Fix: add `f` prefix. Out of scope for W7.
      addWarning(
        result,
        `heading skip at #${i}: h${prevLevel} -> h${level} ('${title.slice(0, 40)}'); ` +
          `consider inserting an h${prevLevel + 1}`,
      );
    }
    prevLevel = level;
  }
}

function _checkUrlsPreserved(
  original: string | null,
  newContent: string,
  result: ValidationResult,
): void {
  if (original === null) return;
  const oldUrls = extractUrls(original);
  const newUrls = extractUrls(newContent);
  const lost = [...oldUrls].filter((u) => !newUrls.has(u));
  if (lost.length > 0) {
    const display = lost.sort().slice(0, 3);
    const suffix = lost.length > 3 ? " ..." : "";
    addError(result, `URLs dropped: ${JSON.stringify(display)}${suffix}`);
  }
}


// ---------- Public entry ----------

/**
 * Validate an LLM-generated vault write before committing it.
 *
 * @param newContent - The proposed file content (from LLM).
 * @param originalContent - If this is a modify (not create), the prior content.
 * @param opts.requireFrontmatter - If true, the file must have a YAML frontmatter block.
 */
export function validateVaultWrite(
  newContent: string,
  originalContent: string | null = null,
  opts?: { requireFrontmatter?: boolean },
): ValidationResult {
  const requireFrontmatter = opts?.requireFrontmatter ?? false;
  const result = makeResult();
  _checkFrontmatter(originalContent, newContent, requireFrontmatter, result);
  _checkWikilinks(originalContent, newContent, result);
  _checkCodeFences(newContent, result);
  _checkHeadingHierarchy(newContent, result);
  _checkUrlsPreserved(originalContent, newContent, result);
  return result;
}
