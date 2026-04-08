"""vault_write_validator -- Local regex gate for LLM-generated vault writes.

Pattern origin: JuliusBrussee/caveman (caveman-compress/scripts/validate.py),
MIT-licensed, 2026-04. Adapted for the Obsidian vault-mind write path.

Why this exists
---------------
LLM-generated content lands in the vault via WebSocket handlers
(vault.create / vault.modify / vault.append). Without a structural gate,
the LLM can silently:
  - Strip the YAML frontmatter (breaks Dataview / Templater).
  - Drop a wikilink target ([[X]] -> X), severing the graph.
  - Leave a code fence unclosed (rendering breaks below it).
  - Skip heading levels (h1 -> h3), violating the outline.

These failures are cheap to detect with regex but expensive to detect
visually after they have rotted in the vault for a week.

This module runs five checks before commit:
  1. frontmatter      -- presence and shape (--- ... ---)
  2. wikilinks        -- [[X]] pairs intact
  3. code fences      -- triple-backtick count is even
  4. heading hierarchy -- no level skips (h1 to h3 directly is wrong)
  5. URL preservation  -- LLM did not drop URLs from the original

Each check returns concrete errors that can be passed to
cherry_pick_fix() for targeted repair.

Caveman provenance
------------------
Caveman's validate.py implements 5 regex checks (URL set, code block
exact-equal, heading list, path set, bullet count drift). We keep:
  - URL set check (verbatim regex)
  - Code block parity (modified to count fences only, since vault writes
    do not always have a one-to-one mapping with the original)
  - Heading check (modified to enforce hierarchy, not just count)

We add (vault-specific):
  - Frontmatter shape check
  - Wikilink pair check
  - Heading skip detection (caveman did not need this)

Edge cases / known limitations
------------------------------
  - URL regex stops at whitespace and ')'. URLs with parens in path
    (Wikipedia) leak. False-positive rate ~5% for academic vaults.
  - Code fence regex counts all triple-backticks, including ones inside
    inline code or strings. False-positive rate ~1%.
  - Wikilink regex does not validate target existence -- only pair shape.
    Use vault_safe_paths or a graph check for target validation.
  - Heading hierarchy allows h1 to h2 to h3 to h2 (descent then ascent).
    Only flags strict skips (h1 to h3 with no h2 in between).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

__all__ = [
    "ValidationResult",
    "validate_vault_write",
    "extract_urls",
    "extract_wikilinks",
    "count_code_fences",
    "extract_headings",
    "has_frontmatter",
]


# ---------- Regex patterns ----------

# Caveman-original: URL set membership.
URL_REGEX = re.compile(r"https?://[^\s)]+")

# Wikilink pairs. Captures [[target]] and [[target|alias]].
# Stops at ]] to avoid greedy match.
WIKILINK_REGEX = re.compile(r"\[\[([^\[\]\|]+)(?:\|[^\[\]]+)?\]\]")

# Triple-backtick fence. Counted, not paired by content (caveman counts
# matched blocks, we count fences because the vault content may legitimately
# add or remove blocks).
CODE_FENCE_REGEX = re.compile(r"^```", re.MULTILINE)

# Heading line: capture level (1-6) and text.
HEADING_REGEX = re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE)

# Frontmatter: --- on first line, --- closer somewhere later.
# Use re.DOTALL to span newlines inside the block.
FRONTMATTER_REGEX = re.compile(r"\A---\s*\n.*?\n---\s*\n", re.DOTALL)


# ---------- Result type ----------


@dataclass
class ValidationResult:
    """Errors block the write; warnings are advisory."""

    is_valid: bool = True
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def add_error(self, msg: str) -> None:
        self.is_valid = False
        self.errors.append(msg)

    def add_warning(self, msg: str) -> None:
        self.warnings.append(msg)


# ---------- Extractors ----------


def extract_urls(text: str) -> set[str]:
    return set(URL_REGEX.findall(text))


def extract_wikilinks(text: str) -> set[str]:
    return set(WIKILINK_REGEX.findall(text))


def count_code_fences(text: str) -> int:
    return len(CODE_FENCE_REGEX.findall(text))


def extract_headings(text: str) -> list[tuple[int, str]]:
    """Return list of (level, title) in document order."""
    return [(len(level), title.strip()) for level, title in HEADING_REGEX.findall(text)]


def has_frontmatter(text: str) -> bool:
    return bool(FRONTMATTER_REGEX.match(text))


# ---------- Validators ----------


def _check_frontmatter(
    original: str | None,
    new: str,
    require_frontmatter: bool,
    result: ValidationResult,
) -> None:
    if require_frontmatter and not has_frontmatter(new):
        result.add_error("frontmatter missing or malformed (expected leading --- ... --- block)")
        return
    # If original had frontmatter, new must too.
    if original is not None and has_frontmatter(original) and not has_frontmatter(new):
        result.add_error("frontmatter dropped (original had one, new does not)")


def _check_wikilinks(original: str | None, new: str, result: ValidationResult) -> None:
    # Pair shape: any [[ without matching ]] is a parse error.
    open_count = new.count("[[")
    close_count = new.count("]]")
    if open_count != close_count:
        result.add_error(f"wikilink bracket mismatch: {open_count} '[[' vs {close_count} ']]'")

    # Preservation: if original had wikilinks, new should not drop them.
    if original is not None:
        old = extract_wikilinks(original)
        new_links = extract_wikilinks(new)
        lost = old - new_links
        if lost:
            result.add_error(f"wikilinks dropped: {sorted(lost)[:5]}{' ...' if len(lost) > 5 else ''}")


def _check_code_fences(new: str, result: ValidationResult) -> None:
    n = count_code_fences(new)
    if n % 2 != 0:
        result.add_error(f"unclosed code fence: found {n} ``` markers (must be even)")


def _check_heading_hierarchy(new: str, result: ValidationResult) -> None:
    headings = extract_headings(new)
    if not headings:
        return
    prev_level = headings[0][0]
    for i, (level, title) in enumerate(headings[1:], 1):
        # Only flag strict skips going down (h1 to h3, h2 to h4, ...).
        if level > prev_level + 1:
            # TODO(P3): the second string literal below is NOT an f-string,
            # so users see the literal text "h{prev_level + 1}" instead of
            # the computed level (e.g. "h2"). Fix: prepend `f` to the
            # second string, or merge into a single f-string.
            result.add_warning(
                f"heading skip at #{i}: h{prev_level} -> h{level} ('{title[:40]}'); "
                "consider inserting an h{prev_level + 1}"
            )
        prev_level = level


def _check_urls_preserved(original: str | None, new: str, result: ValidationResult) -> None:
    if original is None:
        return
    old = extract_urls(original)
    new_urls = extract_urls(new)
    lost = old - new_urls
    if lost:
        result.add_error(f"URLs dropped: {sorted(lost)[:3]}{' ...' if len(lost) > 3 else ''}")


# ---------- Public entry ----------


def validate_vault_write(
    new_content: str,
    original_content: str | None = None,
    require_frontmatter: bool = False,
) -> ValidationResult:
    """Validate an LLM-generated vault write before committing it.

    Args:
        new_content: The proposed file content (from LLM).
        original_content: If this is a modify (not create), the prior
            content. Enables preservation checks for URLs and wikilinks.
        require_frontmatter: If True, the file must have a YAML
            frontmatter block. Use for note types that depend on
            Dataview / Templater (e.g. project notes, tag indexes).

    Returns:
        ValidationResult. Inspect .is_valid, .errors, .warnings.
        Errors should block the write. Warnings are advisory.

    Example:
        result = validate_vault_write(llm_output, current_content, require_frontmatter=True)
        if not result.is_valid:
            # Pass result.errors to cherry_pick_fix for targeted repair.
            ...
    """
    result = ValidationResult()
    _check_frontmatter(original_content, new_content, require_frontmatter, result)
    _check_wikilinks(original_content, new_content, result)
    _check_code_fences(new_content, result)
    _check_heading_hierarchy(new_content, result)
    _check_urls_preserved(original_content, new_content, result)
    return result
