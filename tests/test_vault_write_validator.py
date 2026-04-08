"""Tests for vault_write_validator -- regex gate for LLM vault writes."""

from __future__ import annotations

import pytest

from vault_write_validator import (
    ValidationResult,
    count_code_fences,
    extract_headings,
    extract_urls,
    extract_wikilinks,
    has_frontmatter,
    validate_vault_write,
)


# ---------- has_frontmatter ----------


def test_has_frontmatter_positive_minimal() -> None:
    text = "---\ntitle: Foo\n---\n\nbody\n"
    assert has_frontmatter(text) is True


def test_has_frontmatter_positive_multi_line() -> None:
    text = "---\ntitle: Foo\ntags: [a, b]\ndate: 2026-04-08\n---\n\ncontent\n"
    assert has_frontmatter(text) is True


def test_has_frontmatter_negative_no_leader() -> None:
    text = "# just a heading\n\nbody\n"
    assert has_frontmatter(text) is False


def test_has_frontmatter_negative_leader_not_at_start() -> None:
    text = "\n---\ntitle: Foo\n---\n\nbody\n"
    assert has_frontmatter(text) is False


def test_has_frontmatter_negative_unclosed() -> None:
    text = "---\ntitle: Foo\n\nbody without closer\n"
    assert has_frontmatter(text) is False


def test_has_frontmatter_empty_string() -> None:
    assert has_frontmatter("") is False


# ---------- extract_urls ----------


def test_extract_urls_single_http() -> None:
    assert extract_urls("see http://example.com for details") == {"http://example.com"}


def test_extract_urls_multiple_https() -> None:
    text = "refs: https://a.example and https://b.example/path?q=1"
    assert extract_urls(text) == {"https://a.example", "https://b.example/path?q=1"}


def test_extract_urls_stops_at_paren() -> None:
    # Regex stops at ')' per source (documented limitation).
    text = "[link](https://example.com/page)"
    assert extract_urls(text) == {"https://example.com/page"}


def test_extract_urls_none_in_plain_text() -> None:
    assert extract_urls("no links here, just prose.") == set()


# ---------- extract_wikilinks ----------


def test_extract_wikilinks_plain_target() -> None:
    assert extract_wikilinks("see [[FooNote]] please") == {"FooNote"}


def test_extract_wikilinks_with_alias() -> None:
    assert extract_wikilinks("see [[FooNote|the foo note]]") == {"FooNote"}


def test_extract_wikilinks_multiple_mixed() -> None:
    text = "[[A]] and [[B|label]] and [[C]]"
    assert extract_wikilinks(text) == {"A", "B", "C"}


def test_extract_wikilinks_none() -> None:
    assert extract_wikilinks("plain text, no links.") == set()


# ---------- count_code_fences ----------


def test_count_code_fences_zero() -> None:
    assert count_code_fences("no fences here") == 0


def test_count_code_fences_balanced_pair() -> None:
    text = "```\nprint('hi')\n```\n"
    assert count_code_fences(text) == 2


def test_count_code_fences_unbalanced_odd() -> None:
    text = "```\nprint('hi')\n"  # missing closer
    assert count_code_fences(text) == 1


def test_count_code_fences_multiple_blocks() -> None:
    text = "```py\nx\n```\n\n```js\ny\n```\n"
    assert count_code_fences(text) == 4


# ---------- extract_headings ----------


def test_extract_headings_mixed_levels() -> None:
    text = "# Top\n\n## Sub\n\n### Deep\n"
    assert extract_headings(text) == [(1, "Top"), (2, "Sub"), (3, "Deep")]


def test_extract_headings_trims_trailing_whitespace() -> None:
    text = "# Foo   \n## Bar\n"
    assert extract_headings(text) == [(1, "Foo"), (2, "Bar")]


def test_extract_headings_none() -> None:
    assert extract_headings("just a paragraph\n") == []


# ---------- validate_vault_write: frontmatter ----------


def test_require_frontmatter_missing_errors() -> None:
    result = validate_vault_write("# title\n\nbody\n", require_frontmatter=True)
    assert result.is_valid is False
    assert any("frontmatter" in e.lower() for e in result.errors)


def test_require_frontmatter_present_passes() -> None:
    text = "---\ntitle: Foo\n---\n\n# body\n"
    result = validate_vault_write(text, require_frontmatter=True)
    assert result.is_valid is True
    assert result.errors == []


def test_frontmatter_drop_detection() -> None:
    original = "---\ntitle: Foo\n---\n\noriginal body\n"
    new = "# rewritten body without frontmatter\n"
    result = validate_vault_write(new, original_content=original)
    assert result.is_valid is False
    assert any("dropped" in e.lower() for e in result.errors)


def test_frontmatter_preserved_no_error() -> None:
    original = "---\ntitle: Foo\n---\n\nbody\n"
    new = "---\ntitle: Foo\ntags: [x]\n---\n\nnew body\n"
    result = validate_vault_write(new, original_content=original)
    assert result.is_valid is True


# ---------- validate_vault_write: wikilinks ----------


def test_wikilink_bracket_mismatch_open_without_close() -> None:
    result = validate_vault_write("see [[foo and more text\n")
    assert result.is_valid is False
    assert any("bracket mismatch" in e.lower() for e in result.errors)


def test_wikilink_bracket_mismatch_close_without_open() -> None:
    result = validate_vault_write("see foo]] and more\n")
    assert result.is_valid is False
    assert any("bracket mismatch" in e.lower() for e in result.errors)


def test_wikilink_balanced_passes() -> None:
    result = validate_vault_write("see [[Foo]] and [[Bar]]\n")
    assert result.is_valid is True


def test_wikilink_drop_detection() -> None:
    original = "refs [[Alpha]] and [[Beta]]\n"
    new = "refs [[Alpha]] only\n"
    result = validate_vault_write(new, original_content=original)
    assert result.is_valid is False
    assert any("dropped" in e.lower() for e in result.errors)


def test_wikilink_drop_reports_up_to_five_lost() -> None:
    original = "[[A]] [[B]] [[C]] [[D]] [[E]] [[F]] [[G]]\n"
    new = "nothing left\n"
    result = validate_vault_write(new, original_content=original)
    assert result.is_valid is False
    assert any("..." in e for e in result.errors if "wikilinks dropped" in e)


# ---------- validate_vault_write: code fences ----------


def test_unclosed_code_fence_errors() -> None:
    text = "intro\n\n```python\nprint('hi')\n"  # no closing fence
    result = validate_vault_write(text)
    assert result.is_valid is False
    assert any("code fence" in e.lower() for e in result.errors)


def test_balanced_code_fences_pass() -> None:
    text = "intro\n\n```python\nprint('hi')\n```\n"
    result = validate_vault_write(text)
    assert result.is_valid is True


def test_multiple_balanced_code_fences_pass() -> None:
    text = "```py\na\n```\n\ntext\n\n```js\nb\n```\n"
    result = validate_vault_write(text)
    assert result.is_valid is True


# ---------- validate_vault_write: heading hierarchy ----------


def test_heading_skip_h1_to_h3_is_warning_not_error() -> None:
    # Source comment: "h1 -> h3 should produce a WARNING, not error".
    text = "# Top\n\n### Deep (skipped h2)\n"
    result = validate_vault_write(text)
    assert result.is_valid is True  # warnings never flip is_valid
    assert result.errors == []
    assert any("heading skip" in w.lower() for w in result.warnings)


def test_heading_hierarchy_h1_h2_h3_passes_clean() -> None:
    text = "# Top\n\n## Mid\n\n### Deep\n"
    result = validate_vault_write(text)
    assert result.is_valid is True
    assert result.warnings == []


def test_heading_hierarchy_descent_then_ascent_ok() -> None:
    # "h1 -> h2 -> h3 -> h2" is NOT a skip.
    text = "# A\n\n## B\n\n### C\n\n## D\n"
    result = validate_vault_write(text)
    assert result.is_valid is True
    assert result.warnings == []


def test_heading_skip_h2_to_h4_is_warning() -> None:
    text = "## Mid\n\n#### WayDown\n"
    result = validate_vault_write(text)
    assert result.is_valid is True
    assert any("heading skip" in w.lower() for w in result.warnings)


# ---------- validate_vault_write: URL preservation ----------


def test_url_drop_detection() -> None:
    original = "see https://a.example and https://b.example\n"
    new = "see https://a.example only\n"
    result = validate_vault_write(new, original_content=original)
    assert result.is_valid is False
    assert any("url" in e.lower() for e in result.errors)


def test_url_preserved_passes() -> None:
    original = "see https://a.example\n"
    new = "updated: see https://a.example for more\n"
    result = validate_vault_write(new, original_content=original)
    assert result.is_valid is True


def test_url_added_is_fine() -> None:
    # Preservation is one-way: dropping old URLs is an error, adding new
    # ones is not.
    original = "baseline\n"
    new = "baseline with https://new.example link\n"
    result = validate_vault_write(new, original_content=original)
    assert result.is_valid is True


# ---------- validate_vault_write: clean pass ----------


def test_clean_create_passes() -> None:
    text = "# Title\n\n## Section\n\nBody paragraph with [[Link]] and https://ex.example.\n"
    result = validate_vault_write(text)
    assert result.is_valid is True
    assert result.errors == []


def test_clean_modify_passes() -> None:
    # Note: URL regex is greedy to whitespace/')'. Avoid a trailing '.'
    # on the URL in the fixture because '.' would be captured and then
    # a space-terminated URL in the new content would differ.
    original = (
        "---\ntitle: Foo\n---\n\n# Top\n\n## Mid\n\n"
        "See [[Target]] and https://a.example/page\n\n```py\nprint(1)\n```\n"
    )
    new = (
        "---\ntitle: Foo\ntags: [updated]\n---\n\n# Top\n\n## Mid\n\n"
        "See [[Target]] and https://a.example/page plus more context.\n\n```py\nprint(1)\nprint(2)\n```\n"
    )
    result = validate_vault_write(new, original_content=original)
    assert result.is_valid is True
    assert result.errors == []


def test_create_mode_has_no_preservation_checks() -> None:
    # original_content=None means no URL or wikilink preservation pass.
    text = "a fresh note with no prior state\n"
    result = validate_vault_write(text, original_content=None)
    assert result.is_valid is True


# ---------- ValidationResult dataclass behaviour ----------


def test_validation_result_defaults() -> None:
    r = ValidationResult()
    assert r.is_valid is True
    assert r.errors == []
    assert r.warnings == []


def test_validation_result_add_error_flips_valid() -> None:
    r = ValidationResult()
    r.add_error("boom")
    assert r.is_valid is False
    assert r.errors == ["boom"]


def test_validation_result_add_warning_preserves_valid() -> None:
    r = ValidationResult()
    r.add_warning("careful")
    assert r.is_valid is True
    assert r.warnings == ["careful"]


# ---------- Combined failure surfaces all errors ----------


def test_multiple_failures_collected() -> None:
    # The code fence regex uses ^``` with MULTILINE, so the fence must
    # sit at a line start to count. Put it on its own line.
    original = "---\ntitle: Foo\n---\n\nsee [[A]] and https://x.example\n"
    new = "no frontmatter, no links, no urls\n```\nunclosed fence\n"
    result = validate_vault_write(new, original_content=original, require_frontmatter=True)
    assert result.is_valid is False
    # Expect at least: frontmatter drop/missing, wikilinks dropped, URLs dropped,
    # code fence unclosed. All surfaced in a single pass.
    joined = " | ".join(result.errors).lower()
    assert "frontmatter" in joined
    assert "wikilink" in joined
    assert "url" in joined
    assert "code fence" in joined
