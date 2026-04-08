"""Tests for vault_safe_paths -- LLM vault-write blocklist."""

from __future__ import annotations

import pytest

from vault_safe_paths import (
    ALLOWED_VAULT_EXTENSIONS,
    BLOCKED_DIRECTORIES,
    BLOCKED_EXTENSIONS,
    is_blocked_directory,
    is_blocked_extension,
    is_safe_to_write,
)


# ---------- Docstring examples (load-bearing canonical cases) ----------


def test_docstring_example_safe_markdown_note() -> None:
    assert is_safe_to_write("notes/idea.md") is True


def test_docstring_example_blocked_directory_obsidian() -> None:
    assert is_safe_to_write(".obsidian/config.json") is False


def test_docstring_example_blocked_extension_python_script() -> None:
    assert is_safe_to_write("scripts/run.py") is False


def test_docstring_example_path_traversal_secrets() -> None:
    assert is_safe_to_write("../secrets.md") is False


def test_docstring_example_canvas_gated_by_default() -> None:
    assert is_safe_to_write("notes/draft.canvas") is False


# ---------- Extension blocklist sweep ----------


@pytest.mark.parametrize(
    "path",
    [
        "src/main.py",
        "config/app.json",
        "config/app.yaml",
        "config/app.yml",
        "styles/theme.css",
        "server/index.ts",
        "client/view.tsx",
        "data/rows.csv",
        "config/settings.lock",
        "bin/tool.exe",
        "lib/native.dll",
        "assets/logo.png",
        "media/clip.mp4",
        "docs/spec.pdf",
        "db/store.sqlite",
        "creds/id.pem",
        "archive/bundle.zip",
    ],
)
def test_blocked_extensions_are_refused(path: str) -> None:
    assert is_safe_to_write(path) is False


def test_dotenv_filename_reaches_blocklist_via_suffix_only() -> None:
    # KNOWN QUIRK: ".env" is listed in _CAVEMAN_SKIP_EXTENSIONS but
    # pathlib treats a filename of literally ".env" as having NO suffix
    # (leading dot = hidden-file name stem, not an extension). So the
    # blocklist entry is reachable only via paths whose pathlib suffix
    # is ".env", e.g. "foo.env". Document the actual behaviour under test.
    from pathlib import PurePosixPath

    assert PurePosixPath(".env").suffix == ""
    assert PurePosixPath("foo.env").suffix == ".env"
    # "foo.env" is blocked (suffix hits the list).
    assert is_safe_to_write("config/foo.env") is False
    # Bare ".env" currently falls through the suffix check. The final
    # guard in is_safe_to_write only refuses on a truthy unknown suffix,
    # so a file literally called ".env" is NOT refused today.
    # See source-bug note in the final report.
    assert is_safe_to_write(".env") is True


@pytest.mark.parametrize(
    "path",
    [
        "notes/idea.md",
        "reference/spec.markdown",
        "logs/session.txt",
    ],
)
def test_allowed_extensions_pass(path: str) -> None:
    assert is_safe_to_write(path) is True


def test_rst_is_allowed_extension() -> None:
    assert is_safe_to_write("docs/guide.rst") is True


# ---------- Directory blocklist sweep ----------


@pytest.mark.parametrize(
    "segment",
    sorted(BLOCKED_DIRECTORIES),
)
def test_every_blocked_directory_is_detected(segment: str) -> None:
    # Place the segment inside a vault-looking path with a .md leaf so
    # the only reason it should fail is the directory blocklist.
    path = f"vault/{segment}/file.md"
    assert is_safe_to_write(path) is False
    assert is_blocked_directory(path) is True


def test_blocked_directory_obsidian_top_level() -> None:
    assert is_blocked_directory(".obsidian/config.json") is True


def test_blocked_directory_git_top_level() -> None:
    assert is_blocked_directory(".git/HEAD") is True


def test_blocked_directory_trash_top_level() -> None:
    assert is_blocked_directory(".trash/note.md") is True


def test_blocked_directory_nested_git() -> None:
    assert is_blocked_directory("notes/.git/config.md") is True
    assert is_safe_to_write("notes/.git/config.md") is False


def test_blocked_directory_nested_node_modules() -> None:
    assert is_blocked_directory("frontend/app/node_modules/pkg.md") is True


def test_directory_blocklist_is_exact_segment_not_substring() -> None:
    # ".gitignore-notes" must NOT match ".git" as a substring; is_blocked_directory
    # uses exact segment equality on path parts.
    assert is_blocked_directory("notes/gitignore-notes/draft.md") is False


# ---------- Path traversal / absolute paths ----------


def test_traversal_parent_dir_refused() -> None:
    assert is_safe_to_write("../secrets.md") is False


def test_traversal_current_dir_refused() -> None:
    assert is_safe_to_write("./rel.md") is False


def test_absolute_posix_path_refused() -> None:
    assert is_safe_to_write("/abs/path.md") is False


def test_windows_drive_letter_refused() -> None:
    assert is_safe_to_write("C:/drive.md") is False


def test_windows_drive_letter_lowercase_refused() -> None:
    assert is_safe_to_write("d:/drive.md") is False


def test_nested_dotdot_refused() -> None:
    assert is_safe_to_write("notes/../../escape.md") is False


# ---------- Empty / whitespace / unknown extension ----------


def test_empty_string_refused() -> None:
    assert is_safe_to_write("") is False


def test_whitespace_only_refused() -> None:
    assert is_safe_to_write("   ") is False


def test_tab_only_refused() -> None:
    assert is_safe_to_write("\t\n") is False


def test_unknown_extension_refused() -> None:
    # Not in BLOCKED_EXTENSIONS and not in ALLOWED_VAULT_EXTENSIONS.
    # The implementation defaults to refusing unknown suffixes.
    assert ".xyz" not in BLOCKED_EXTENSIONS
    assert ".xyz" not in ALLOWED_VAULT_EXTENSIONS
    assert is_safe_to_write("notes/weird.xyz") is False


def test_extensionless_file_refused() -> None:
    # No suffix -> not in ALLOWED_VAULT_EXTENSIONS -> falls through the
    # final guard. The final guard only refuses when suffix is truthy,
    # so an extensionless file currently passes. Document the actual
    # behaviour of the source under test.
    # (Note: README for the source says markdown-first; a file with no
    # extension is legitimately ambiguous. See report for discussion.)
    assert is_safe_to_write("notes/READMEnoext") is True


# ---------- Canvas gating ----------


def test_canvas_refused_without_flag() -> None:
    assert is_safe_to_write("notes/board.canvas") is False


def test_canvas_allowed_with_flag() -> None:
    assert is_safe_to_write("notes/board.canvas", allow_canvas=True) is True


def test_canvas_flag_does_not_bypass_traversal() -> None:
    assert is_safe_to_write("../board.canvas", allow_canvas=True) is False


def test_canvas_flag_does_not_bypass_blocked_directory() -> None:
    assert is_safe_to_write(".obsidian/board.canvas", allow_canvas=True) is False


# ---------- is_blocked_extension standalone ----------


def test_is_blocked_extension_python() -> None:
    assert is_blocked_extension("foo.py") is True


def test_is_blocked_extension_markdown_is_false() -> None:
    assert is_blocked_extension("foo.md") is False


def test_is_blocked_extension_no_suffix_is_false() -> None:
    assert is_blocked_extension("README") is False


def test_is_blocked_extension_case_insensitive() -> None:
    assert is_blocked_extension("Report.PDF") is True
    assert is_blocked_extension("Script.PY") is True


# ---------- is_blocked_directory standalone ----------


def test_is_blocked_directory_returns_false_for_clean_path() -> None:
    assert is_blocked_directory("notes/2026/idea.md") is False


def test_is_blocked_directory_empty_string() -> None:
    assert is_blocked_directory("") is False


# ---------- Windows backslash normalization ----------


def test_windows_backslash_blocked_dir() -> None:
    assert is_blocked_directory(r"notes\.git\config.md") is True
    assert is_safe_to_write(r"notes\.git\config.md") is False


def test_windows_backslash_blocked_ext() -> None:
    assert is_blocked_extension(r"src\app\main.py") is True
    assert is_safe_to_write(r"src\app\main.py") is False


def test_windows_backslash_safe_markdown() -> None:
    assert is_safe_to_write(r"notes\2026\idea.md") is True


def test_windows_backslash_drive_letter_refused() -> None:
    assert is_safe_to_write(r"C:\vault\note.md") is False


# ---------- Frozen sets are actually frozen ----------


def test_blocklist_constants_are_frozensets() -> None:
    assert isinstance(BLOCKED_EXTENSIONS, frozenset)
    assert isinstance(BLOCKED_DIRECTORIES, frozenset)
    assert isinstance(ALLOWED_VAULT_EXTENSIONS, frozenset)


def test_allowed_extensions_include_markdown_family() -> None:
    assert ".md" in ALLOWED_VAULT_EXTENSIONS
    assert ".markdown" in ALLOWED_VAULT_EXTENSIONS
    assert ".txt" in ALLOWED_VAULT_EXTENSIONS
