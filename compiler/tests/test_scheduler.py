from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import evaluate
import scheduler


class SchedulerDayModeTest(unittest.TestCase):
    def test_day_mode_does_not_execute_compile(self) -> None:
        settings = evaluate.AgentSettings(vault_path="D:/tmp/vault")
        state = evaluate.VaultState(
            vault_path=settings.vault_path,
            dirty_count=1,
            dirty_topics=["topic-a"],
            dirty_files_by_topic={"topic-a": ["raw/note.md"]},
            days_since_emerge=0,
            unresolved_contradictions=0,
            orphan_count=0,
            stale_count=0,
            scheduler_state="IDLE",
            mode="day",
        )
        action = evaluate.ScheduledAction(
            type="compile",
            target="topic-a",
            reason="1 dirty file",
            priority=1001,
            topics=["topic-a"],
        )
        executed: list[str] = []

        def fake_executor(
            scheduled_action: evaluate.ScheduledAction,
            vault_state: evaluate.VaultState,
            agent_settings: evaluate.AgentSettings,
            mode: str,
        ) -> evaluate.ActionResult:
            executed.append(scheduled_action.type)
            return evaluate.ActionResult(
                action=scheduled_action.type,
                status="ok",
                target=scheduled_action.target,
                reason=scheduled_action.reason,
                priority=scheduled_action.priority,
                mode=mode,
                scheduler_state="REPORT",
                started_at="2026-04-07T00:00:00Z",
                completed_at="2026-04-07T00:00:01Z",
            )

        agent_scheduler = scheduler.AgentScheduler(
            settings,
            mode="day",
            state_provider=lambda resolved_mode: state,
            evaluator=lambda vault_state, agent_settings: [action],
            executor=fake_executor,
            logger=lambda vault_path, result: None,
        )

        report = agent_scheduler.run_once()

        self.assertEqual(executed, [])
        self.assertEqual(report.mode, "day")
        self.assertEqual(report.scheduled, 1)
        self.assertEqual(report.executed, 0)
        self.assertEqual(report.skipped, 1)
        self.assertEqual(report.deferred_actions, ["compile"])
        self.assertEqual(agent_scheduler.state, "IDLE")


if __name__ == "__main__":
    unittest.main()
