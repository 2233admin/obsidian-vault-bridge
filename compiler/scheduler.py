#!/usr/bin/env python3
"""Agent scheduler state machine for vault-mind Phase 5."""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Callable

from evaluate import (
    ActionResult,
    AgentSettings,
    ScheduledAction,
    VaultState,
    append_log_entry,
    collect_vault_state,
    evaluate_actions,
    execute_action,
    load_settings,
    resolve_operating_mode,
    write_scheduler_state,
)

SchedulerState = str
StateProvider = Callable[[str], VaultState]
ActionEvaluator = Callable[[VaultState, AgentSettings], list[ScheduledAction]]
ActionExecutor = Callable[[ScheduledAction, VaultState, AgentSettings, str], ActionResult]


@dataclass(slots=True)
class TickReport:
    mode: str
    scheduler_state: str
    scheduled: int
    executed: int
    skipped: int
    started_at: str
    completed_at: str
    deferred_actions: list[str] = field(default_factory=list)
    results: list[ActionResult] = field(default_factory=list)


class AgentScheduler:
    def __init__(
        self,
        settings: AgentSettings,
        mode: str = "auto",
        state_provider: StateProvider | None = None,
        evaluator: ActionEvaluator | None = None,
        executor: ActionExecutor | None = None,
        logger: Callable[[str, ActionResult], object] | None = None,
    ) -> None:
        self.settings = settings
        self.mode = mode
        self.state: SchedulerState = "IDLE"
        self._state_provider = state_provider or self._default_state_provider
        self._evaluator = evaluator or evaluate_actions
        self._executor = executor or execute_action
        self._logger = logger or append_log_entry
        self._persist_state()

    def _persist_state(self, mode: str | None = None) -> None:
        write_scheduler_state(self.settings.vault_path, self.state, mode or self.mode)

    def _transition(self, next_state: SchedulerState, mode: str) -> None:
        self.state = next_state
        self._persist_state(mode)

    def _default_state_provider(self, resolved_mode: str) -> VaultState:
        return collect_vault_state(
            self.settings,
            mode=resolved_mode,
            scheduler_state=self.state,
        )

    def run_once(self) -> TickReport:
        started_at = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
        resolved_mode = resolve_operating_mode(self.mode, self.settings)

        self._transition("EVALUATE", resolved_mode)
        vault_state = self._state_provider(resolved_mode)
        actions = self._evaluator(vault_state, self.settings)

        results: list[ActionResult] = []
        deferred_actions: list[str] = []
        skipped = 0

        if resolved_mode == "day":
            deferred_actions = [action.type for action in actions]
            skipped = len(actions)
        elif actions:
            self._transition("ACTION", resolved_mode)
            for action in actions:
                results.append(self._executor(action, vault_state, self.settings, resolved_mode))

        self._transition("REPORT", resolved_mode)
        for result in results:
            self._logger(self.settings.vault_path, result)

        self._transition("IDLE", resolved_mode)
        return TickReport(
            mode=resolved_mode,
            scheduler_state=self.state,
            scheduled=len(actions),
            executed=len(results),
            skipped=skipped,
            started_at=started_at,
            completed_at=datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
            deferred_actions=deferred_actions,
            results=results,
        )

    def serve_forever(self, interval_seconds: int) -> None:
        while True:
            self.run_once()
            time.sleep(interval_seconds)


def main() -> None:
    parser = argparse.ArgumentParser(description="vault-mind agent scheduler")
    parser.add_argument("--config", help="Path to vault-mind.yaml", default=None)
    parser.add_argument("--vault", help="Vault path override", default=None)
    parser.add_argument("--mode", choices=["day", "night", "auto"], default="auto")
    parser.add_argument("--once", action="store_true", help="Run a single scheduler tick")
    parser.add_argument("--interval", type=int, default=300, help="Loop interval in seconds")
    args = parser.parse_args()

    settings = load_settings(config_path=args.config, vault_path_override=args.vault)
    scheduler = AgentScheduler(settings, mode=args.mode)

    if args.once:
        print(json.dumps(asdict(scheduler.run_once()), indent=2, ensure_ascii=False))
        return

    scheduler.serve_forever(args.interval)


if __name__ == "__main__":
    main()
