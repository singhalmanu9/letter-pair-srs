"""
Timing helpers for review sessions.
"""

from dataclasses import dataclass


@dataclass
class ReviewTimer:
    """Tracks elapsed and remaining time for a single review prompt."""

    started_at: float
    timeout_seconds: int

    @property
    def deadline(self) -> float:
        return self.started_at + self.timeout_seconds

    def elapsed(self, now: float) -> float:
        return max(0.0, now - self.started_at)

    def remaining(self, now: float) -> float:
        return max(0.0, self.deadline - now)

    def is_timed_out(self, now: float) -> bool:
        return now >= self.deadline
