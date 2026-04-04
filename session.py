"""
Session orchestration for review flow and timeout handling.
"""

from dataclasses import dataclass
from time import time
from typing import Callable, List, Optional

from engine import ReviewEngine, SessionStats
from schemas import DeckItem, ReviewEvent
from timer import ReviewTimer


@dataclass
class ActiveReview:
    """In-flight review state for one currently shown pair."""

    pair_id: str
    term: str
    answers: List[str]
    timer: ReviewTimer
    revealed: bool = False


class SessionController:
    """Coordinates term display, reveal, grading, timeout, and persistence hooks."""

    def __init__(
        self,
        engine: ReviewEngine,
        save_state_callback: Optional[Callable] = None,
        append_event_callback: Optional[Callable[[ReviewEvent], None]] = None,
    ):
        self.engine = engine
        self._save_state = save_state_callback
        self._append_event = append_event_callback

        self.active_review: Optional[ActiveReview] = None
        self.reviewed_events: List[ReviewEvent] = []

    def start_next_review(self, now: Optional[float] = None) -> Optional[DeckItem]:
        """Start next due review, or return None when no pair is due."""
        if self.active_review is not None:
            raise ValueError("Cannot start a new review while another review is active")

        current_time = time() if now is None else now
        due_item = self.engine.get_due_pair(now=current_time)
        if due_item is None:
            return None

        self.active_review = ActiveReview(
            pair_id=due_item.id,
            term=due_item.term,
            answers=list(due_item.answers),
            timer=ReviewTimer(
                started_at=current_time,
                timeout_seconds=self.engine.config.timeout_seconds,
            ),
        )
        return due_item

    def time_remaining(self, now: Optional[float] = None) -> Optional[float]:
        """Return remaining seconds for active review, otherwise None."""
        if self.active_review is None:
            return None
        current_time = time() if now is None else now
        return self.active_review.timer.remaining(current_time)

    def reveal_answers(self, now: Optional[float] = None) -> List[str]:
        """Reveal accepted answers for the active review."""
        self._ensure_active()
        self._enforce_not_timed_out(now=now)

        self.active_review.revealed = True
        return list(self.active_review.answers)

    def grade_pass(self, user_answer: Optional[str] = None, now: Optional[float] = None) -> ReviewEvent:
        """Grade active review as pass after reveal."""
        self._ensure_ready_for_grading(now=now)
        current_time = time() if now is None else now

        event = self.engine.record_pass(
            pair_id=self.active_review.pair_id,
            elapsed_seconds=self.active_review.timer.elapsed(current_time),
            user_answer=user_answer,
            now=current_time,
        )
        self._finalize_event(event)
        return event

    def grade_fail(self, user_answer: Optional[str] = None, now: Optional[float] = None) -> ReviewEvent:
        """Grade active review as fail after reveal."""
        self._ensure_ready_for_grading(now=now)
        current_time = time() if now is None else now

        event = self.engine.record_fail(
            pair_id=self.active_review.pair_id,
            elapsed_seconds=self.active_review.timer.elapsed(current_time),
            user_answer=user_answer,
            now=current_time,
        )
        self._finalize_event(event)
        return event

    def check_timeout(self, now: Optional[float] = None) -> Optional[ReviewEvent]:
        """Auto-fail and finalize if active review has timed out."""
        if self.active_review is None:
            return None

        current_time = time() if now is None else now
        if not self.active_review.timer.is_timed_out(current_time):
            return None

        event = self.engine.record_timeout(
            pair_id=self.active_review.pair_id,
            elapsed_seconds=float(self.engine.config.timeout_seconds),
            now=current_time,
        )
        self._finalize_event(event)
        return event

    def get_session_stats(self) -> SessionStats:
        """Return aggregate stats from events recorded this session."""
        return ReviewEngine.get_session_stats(self.reviewed_events)

    def _ensure_active(self) -> None:
        if self.active_review is None:
            raise ValueError("No active review")

    def _enforce_not_timed_out(self, now: Optional[float]) -> None:
        timeout_event = self.check_timeout(now=now)
        if timeout_event is not None:
            raise ValueError("Active review already timed out")

    def _ensure_ready_for_grading(self, now: Optional[float]) -> None:
        self._ensure_active()
        if not self.active_review.revealed:
            raise ValueError("Must reveal answers before grading")
        self._enforce_not_timed_out(now=now)

    def _finalize_event(self, event: ReviewEvent) -> None:
        self.reviewed_events.append(event)

        if self._append_event is not None:
            self._append_event(event)

        if self._save_state is not None:
            self._save_state(self.engine.state)

        self.active_review = None
