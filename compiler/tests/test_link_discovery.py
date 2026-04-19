from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import link_discovery as ld


class ParseFrontmatterTest(unittest.TestCase):
    def test_bracket_list_aliases(self) -> None:
        text = "---\naliases: [Foo, 'Bar Baz']\n---\nbody\n"
        self.assertEqual(ld.parse_frontmatter(text)["aliases"], ["Foo", "Bar Baz"])

    def test_bullet_list_aliases(self) -> None:
        text = "---\ntitle: x\naliases:\n  - Foo\n  - Bar Baz\n---\nbody\n"
        self.assertEqual(ld.parse_frontmatter(text)["aliases"], ["Foo", "Bar Baz"])

    def test_no_frontmatter(self) -> None:
        self.assertEqual(ld.parse_frontmatter("# just a heading\n"), {})


class BuildIndexTest(unittest.TestCase):
    def _vault(self, files: dict[str, str]) -> Path:
        root = Path(tempfile.mkdtemp(prefix="ld-test-"))
        for name, body in files.items():
            p = root / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(body, encoding="utf-8")
        return root

    def test_title_and_alias_indexed(self) -> None:
        vault = self._vault({
            "Sprachwelt.md": "---\naliases: [AWG, 'Language World']\n---\n# Sprachwelt\n",
            "Other.md": "# Other Note\n",
        })
        idx = ld.build_index(vault, ld.DEFAULT_SKIP | ld.ARCHIVE_DIRS)
        self.assertIn("sprachwelt", idx)
        self.assertIn("language world", idx)
        self.assertIn("other note", idx)

    def test_cjk_min_length_enforced(self) -> None:
        vault = self._vault({
            "历史.md": "# 历史\n",
            "历史唯物主义.md": "# 历史唯物主义\n",
        })
        idx = ld.build_index(vault, ld.DEFAULT_SKIP | ld.ARCHIVE_DIRS)
        self.assertNotIn("历史", idx)
        self.assertIn("历史唯物主义", idx)

    def test_skip_dirs_excluded(self) -> None:
        vault = self._vault({
            "Active.md": "# Active\n",
            "09-Archive/Old.md": "# Old\n",
        })
        idx = ld.build_index(vault, ld.DEFAULT_SKIP | ld.ARCHIVE_DIRS)
        self.assertIn("active", idx)
        self.assertNotIn("old", idx)


class ScanFileTest(unittest.TestCase):
    def _mkindex(self, entries: list[tuple[str, str]]) -> dict[str, ld.NoteEntry]:
        return {
            alias.lower(): ld.NoteEntry(path=Path(path), title=alias)
            for alias, path in entries
        }

    def test_bare_mention_suggested(self) -> None:
        idx = self._mkindex([("Sprachwelt", "D:/vault/Sprachwelt.md")])
        out = ld.scan_file(Path("D:/vault/Other.md"), "I talked about Sprachwelt today.\n", idx)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].match, "sprachwelt")

    def test_existing_wikilink_skipped(self) -> None:
        idx = self._mkindex([("Sprachwelt", "D:/vault/Sprachwelt.md")])
        out = ld.scan_file(Path("D:/vault/Other.md"), "See [[Sprachwelt]] for context.\n", idx)
        self.assertEqual(out, [])

    def test_code_fence_skipped(self) -> None:
        idx = self._mkindex([("Sprachwelt", "D:/vault/Sprachwelt.md")])
        body = "```\nimport Sprachwelt\n```\n"
        out = ld.scan_file(Path("D:/vault/Other.md"), body, idx)
        self.assertEqual(out, [])

    def test_self_reference_skipped(self) -> None:
        idx = self._mkindex([("Sprachwelt", "D:/vault/Sprachwelt.md")])
        out = ld.scan_file(Path("D:/vault/Sprachwelt.md"), "self-mention of Sprachwelt\n", idx)
        self.assertEqual(out, [])

    def test_ascii_word_boundary(self) -> None:
        idx = self._mkindex([("CTX", "D:/vault/CTX.md")])
        out = ld.scan_file(Path("D:/vault/Other.md"), "the contextual ctxish variant\n", idx)
        self.assertEqual(out, [])

    def test_cjk_substring_match(self) -> None:
        idx = self._mkindex([("历史唯物主义", "D:/vault/HMC.md")])
        out = ld.scan_file(Path("D:/vault/Other.md"), "这段讨论历史唯物主义的现代意义。\n", idx)
        self.assertEqual(len(out), 1)


class EndToEndTest(unittest.TestCase):
    def test_run_produces_report(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="ld-e2e-"))
        (root / "Sprachwelt.md").write_text("# Sprachwelt\nterrain theory.\n", encoding="utf-8")
        (root / "Other.md").write_text("I referenced Sprachwelt yesterday.\n", encoding="utf-8")
        out = root / ".compile" / "link_suggestions.md"
        stats = ld.run(root, out, ld.DEFAULT_SKIP | ld.ARCHIVE_DIRS)
        self.assertTrue(out.exists())
        self.assertEqual(stats["suggestions"], 1)
        body = out.read_text(encoding="utf-8")
        self.assertIn("Other.md", body)
        self.assertIn("[[Sprachwelt]]", body)


if __name__ == "__main__":
    unittest.main()
