"""
Core review engine for due selection and scheduling transitions.
"""

from dataclasses import dataclass
from datetime import datetime
from time import time
from typing import Dict, List, Optional

from config import CONFIG, SRSConfig
from schemas import Deck, DeckItem, PairState, ReviewEvent, ReviewResult, SRSState, validate_state


@dataclass
class SessionStats:
    """Aggregate stats for a set of review events."""

    total: int
    passed: int
    failed: int
    timed_out: int
    responses: int
    pass_rate: float


class ReviewEngine:
    """Pure scheduling and review-state update logic."""

    def __init__(self, deck: Deck, state: SRSState, config: SRSConfig = CONFIG):
        validate_state(deck, state)
        self.deck = deck
        self.state = state
        self.config = config

        self._item_by_id: Dict[str, DeckItem] = {item.id: item for item in deck.items}
        self._pair_by_id: Dict[str, PairState] = {pair.pair_id: pair for pair in state.pairs}

    def get_due_pair_state(self, now: Optional[float] = None) -> Optional[PairState]:
        """Return earliest-due pair state among currently due pairs."""
        current_time = time() if now is None else now
        due_pairs = [pair for pair in self.state.pairs if pair.next_due <= current_time]
        if not due_pairs:
            return None
        return min(due_pairs, key=lambda pair: pair.next_due)

    def get_due_pair(self, now: Optional[float] = None) -> Optional[DeckItem]:
        """Return deck item for the earliest due pair, or None if none due."""
        due_state = self.get_due_pair_state(now=now)
        if due_state is None:
            return None
        return self._item_by_id.get(due_state.pair_id)

    def seconds_until_next_due(self, now: Optional[float] = None) -> Optional[float]:
        """Return seconds until next pair is due, or None if there are no pairs."""
        if not self.state.pairs:
            return None

        current_time = time() if now is None else now
        next_due = min(pair.next_due for pair in self.state.pairs)
        return max(0.0, next_due - current_time)

    def record_pass(
        self,
        pair_id: str,
        elapsed_seconds: float,
        user_answer: Optional[str] = None,
        now: Optional[float] = None,
    ) -> ReviewEvent:
        """Apply pass transition and return the corresponding review event."""
        pair = self._get_pair(pair_id)
        current_time = time() if now is None else now

        pair.response_count += 1
        pair.pass_count += 1
        if user_answer:
            pair.record_answer(user_answer)

        grown_interval = int(round(pair.current_interval * self.config.pass_interval_multiplier))
        pair.current_interval = max(1, grown_interval)
        pair.next_due = current_time + pair.current_interval
        pair.validate_consistency()

        return self._build_event(
            pair_id=pair_id,
            result=ReviewResult.PASS,
            elapsed_seconds=elapsed_seconds,
            current_time=current_time,
            user_answer=user_answer,
            reason=None,
        )

    def record_fail(
        self,
        pair_id: str,
        elapsed_seconds: float,
        user_answer: Optional[str] = None,
        now: Optional[float] = None,
        reason: Optional[str] = None,
    ) -> ReviewEvent:
        """Apply fail transition and return the corresponding review event."""
        pair = self._get_pair(pair_id)
        current_time = time() if now is None else now

        pair.response_count += 1
        pair.fail_count += 1
        if user_answer:
            pair.record_answer(user_answer)

        pair.current_interval = self.config.fail_interval_reset
        pair.next_due = current_time + pair.current_interval
        pair.validate_consistency()

        return self._build_event(
            pair_id=pair_id,
            result=ReviewResult.FAIL,
            elapsed_seconds=elapsed_seconds,
            current_time=current_time,
            user_answer=user_answer,
            reason=reason,
        )

    def record_timeout(
        self,
        pair_id: str,
        elapsed_seconds: float,
        now: Optional[float] = None,
    ) -> ReviewEvent:
        """Apply timeout transition (same schedule effect as fail)."""
        pair = self._get_pair(pair_id)
        current_time = time() if now is None else now

        pair.timeout_count += 1
        pair.current_interval = self.config.fail_interval_reset
        pair.next_due = current_time + pair.current_interval
        pair.validate_consistency()

        return self._build_event(
            pair_id=pair_id,
            result=ReviewResult.TIMEOUT,
            elapsed_seconds=elapsed_seconds,
            current_time=current_time,
            user_answer=None,
            reason="timeout",
        )

    @staticmethod
    def get_session_stats(events: List[ReviewEvent]) -> SessionStats:
        """Compute aggregate stats from review events."""
        total = len(events)
        passed = sum(1 for event in events if event.result == ReviewResult.PASS)
        failed = sum(1 for event in events if event.result == ReviewResult.FAIL)
        timed_out = sum(1 for event in events if event.result == ReviewResult.TIMEOUT)
        responses = passed + failed

        if total - timed_out != responses:
            raise ValueError(
                "Session consistency error: total responses - timed_out must equal responses"
            )

        pass_rate = (passed / total) if total else 0.0

        return SessionStats(
            total=total,
            passed=passed,
            failed=failed,
            timed_out=timed_out,
            responses=responses,
            pass_rate=pass_rate,
        )

    def _get_pair(self, pair_id: str) -> PairState:
        pair = self._pair_by_id.get(pair_id)
        if pair is None:
            raise ValueError(f"Unknown pair_id: {pair_id}")
        pair.validate_consistency()
        return pair

    def _build_event(
        self,
        pair_id: str,
        result: ReviewResult,
        elapsed_seconds: float,
        current_time: float,
        user_answer: Optional[str],
        reason: Optional[str],
    ) -> ReviewEvent:
        item = self._item_by_id.get(pair_id)
        if item is None:
            raise ValueError(f"Unknown pair_id in deck: {pair_id}")

        return ReviewEvent(
            pair_id=pair_id,
            term=item.term,
            result=result,
            elapsed_seconds=elapsed_seconds,
            timestamp=datetime.utcfromtimestamp(current_time).isoformat(),
            timeout_seconds=self.config.timeout_seconds,
            user_answer=user_answer,
            reason=reason,
        )
