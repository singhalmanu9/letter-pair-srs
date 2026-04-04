"""
Data structure definitions and validation for the SRS application.
"""

from dataclasses import dataclass, asdict, field
from typing import List, Optional, Dict, Any
from enum import Enum
import json
from datetime import datetime


class ReviewResult(Enum):
    """Result of a review: pass, fail, or timeout."""
    PASS = "pass"
    FAIL = "fail"
    TIMEOUT = "timeout"


@dataclass
class DeckItem:
    """A single term with multiple accepted answers."""
    id: str  # Unique identifier
    term: str  # The term/prompt
    answers: List[str]  # List of accepted answers

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "DeckItem":
        return cls(**data)

    def add_answer(self, answer: str) -> bool:
        """
        Add a new acceptable answer if not already present.
        Returns True if added, False if already exists.
        """
        if answer not in self.answers:
            self.answers.append(answer)
            return True
        return False


@dataclass
class PairState:
    """Mutable state for a letter pair (one per deck item)."""
    pair_id: str  # Reference to DeckItem.id
    next_due: float  # Unix timestamp when pair is next due
    current_interval: int  # Current interval in seconds
    response_count: int = 0  # Total non-timeout responses (pass/fail with response)
    pass_count: int = 0  # Successful passes
    fail_count: int = 0  # Non-timeout failures
    timeout_count: int = 0  # Timeout outcomes
    answer_history: Dict[str, int] = field(default_factory=dict)  # {answer: count}

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PairState":
        data_copy = data.copy()
        # Backward compatibility for earlier state files.
        if "response_count" not in data_copy and "attempt_count" in data_copy:
            data_copy["response_count"] = data_copy.pop("attempt_count")
        return cls(**data_copy)

    def record_answer(self, answer: str) -> None:
        """Record that the user gave this answer."""
        self.answer_history[answer] = self.answer_history.get(answer, 0) + 1

    def get_answer_stats(self) -> Dict[str, int]:
        """Get frequency of each answer given by user."""
        return dict(self.answer_history)

    def most_common_answer(self) -> Optional[str]:
        """Return the most frequently given answer, or None if no history."""
        if not self.answer_history:
            return None
        return max(self.answer_history, key=self.answer_history.get)

    def total_responses(self) -> int:
        """Return total outcomes recorded for this pair."""
        return self.response_count + self.timeout_count

    def validate_consistency(self) -> bool:
        """Validate internal response/pass/fail/timeout bookkeeping invariants."""
        if min(self.response_count, self.pass_count, self.fail_count, self.timeout_count) < 0:
            raise ValueError(f"Negative counters are not allowed for pair {self.pair_id}")

        if self.total_responses() - self.timeout_count != self.response_count:
            raise ValueError(
                f"Consistency error for pair {self.pair_id}: "
                "total_responses - timeout_count must equal response_count"
            )

        if self.response_count != self.pass_count + self.fail_count:
            raise ValueError(
                f"Consistency error for pair {self.pair_id}: "
                "response_count must equal pass_count + fail_count"
            )

        return True


@dataclass
class ReviewEvent:
    """A single review outcome event."""
    pair_id: str
    term: str
    result: ReviewResult  # pass, fail, or timeout
    elapsed_seconds: float  # Time from term shown to grading/timeout
    timestamp: str  # ISO 8601 datetime
    timeout_seconds: int  # Configured timeout threshold
    user_answer: Optional[str] = None  # The answer the user provided (or None if timeout/fail without reveal)
    reason: Optional[str] = None  # "timeout" or None

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["result"] = self.result.value
        return data

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ReviewEvent":
        data_copy = data.copy()
        data_copy["result"] = ReviewResult(data_copy["result"])
        return cls(**data_copy)


@dataclass
class Deck:
    """Complete deck definition."""
    items: List[DeckItem] = field(default_factory=list)
    version: str = "1.0"  # Schema version for migrations

    def to_dict(self) -> Dict[str, Any]:
        return {
            "version": self.version,
            "items": [item.to_dict() for item in self.items],
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Deck":
        items = [DeckItem.from_dict(item) for item in data.get("items", [])]
        version = data.get("version", "1.0")
        return cls(items=items, version=version)

    def get_item_by_id(self, pair_id: str) -> Optional[DeckItem]:
        """Find a deck item by ID."""
        for item in self.items:
            if item.id == pair_id:
                return item
        return None

    def add_answer_to_pair(self, pair_id: str, answer: str) -> bool:
        """
        Add a new answer to a pair if not already present.
        Returns True if added, False if already exists or pair not found.
        """
        item = self.get_item_by_id(pair_id)
        if item:
            return item.add_answer(answer)
        return False


@dataclass
class SRSState:
    """Complete app state."""
    pairs: List[PairState] = field(default_factory=list)
    version: str = "1.0"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "version": self.version,
            "pairs": [pair.to_dict() for pair in self.pairs],
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SRSState":
        pairs = [PairState.from_dict(pair) for pair in data.get("pairs", [])]
        version = data.get("version", "1.0")
        return cls(pairs=pairs, version=version)


# Validation helpers
def validate_deck(deck: Deck) -> bool:
    """Validate deck structure."""
    if not deck.items:
        raise ValueError("Deck must contain at least one item")
    for item in deck.items:
        if not item.id or not item.term or not item.answers:
            raise ValueError(f"Invalid deck item: {item}")
        if not isinstance(item.answers, list) or len(item.answers) == 0:
            raise ValueError(f"Answers must be non-empty list: {item.id}")
    return True


def validate_state(deck: Deck, state: SRSState) -> bool:
    """Validate state matches deck (all pair_ids exist in deck)."""
    deck_ids = {item.id for item in deck.items}
    for pair in state.pairs:
        if pair.pair_id not in deck_ids:
            raise ValueError(f"Pair {pair.pair_id} not found in deck")
        pair.validate_consistency()
    return True
