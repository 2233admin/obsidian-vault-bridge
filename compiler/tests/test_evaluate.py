from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import evaluate


class EvaluateActionsTest(unittest.TestCase):
    def test_priority_sorting_prefers_compile_then_maintenance(self) -> None:
        settings = evaluate.AgentSettings(vault_path="D:/tmp/vault")
        state = evaluate.VaultState(
            vault_path=settings.vault_path,
            dirty_count=2,
            dirty_topics=["ml-systems"],
            dirty_files_by_topic={"ml-systems": ["raw/a.md", "raw/b.md"]},
            days_since_emerge=21,
            unresolved_contradictions=3,
            orphan_count=15,
            stale_count=5,
            scheduler_state="IDLE",
            mode="night",
        )

        actions = evaluate.evaluate_actions(state, settings)

        self.assertEqual(
            [action.type for action in actions],
            ["compile", "emerge", "reconcile", "prune", "challenge"],
        )
        self.assertTrue(actions[0].priority > actions[1].priority)

    def test_thresholds_filter_non_urgent_actions(self) -> None:
        settings = evaluate.AgentSettings(
            vault_path="D:/tmp/vault",
            days_since_emerge_threshold=30,
            contradiction_threshold=4,
            orphan_threshold=20,
            challenge_stale_threshold=8,
        )
        state = evaluate.VaultState(
            vault_path=settings.vault_path,
            dirty_count=1,
            dirty_topics=["topic-a"],
            dirty_files_by_topic={"topic-a": ["raw/note.md"]},
            days_since_emerge=10,
            unresolved_contradictions=2,
            orphan_count=5,
            stale_count=1,
            scheduler_state="IDLE",
            mode="night",
        )

        actions = evaluate.evaluate_actions(state, settings)

        self.assertEqual([action.type for action in actions], ["compile"])


if __name__ == "__main__":
    unittest.main()
