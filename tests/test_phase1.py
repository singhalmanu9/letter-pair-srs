"""
Unit tests for Phase 1: persistence and schemas.
"""

import unittest
import json
import tempfile
from pathlib import Path
from time import time

from schemas import Deck, DeckItem, SRSState, PairState, ReviewEvent, ReviewResult, validate_state
from persistence import (
    load_deck,
    save_deck,
    load_state,
    save_state,
    append_review_event,
    load_history,
    initialize_state_for_deck,
)


class TestSchemas(unittest.TestCase):
    """Test schema dataclasses."""

    def test_deck_item_roundtrip(self):
        """Test DeckItem to_dict and from_dict."""
        item = DeckItem(id="q1", term="Apple", answers=["apple", "APPLE"])
        data = item.to_dict()
        restored = DeckItem.from_dict(data)
        self.assertEqual(restored.id, "q1")
        self.assertEqual(restored.term, "Apple")
        self.assertEqual(restored.answers, ["apple", "APPLE"])

    def test_deck_item_add_answer(self):
        """Test adding a new answer to a deck item."""
        item = DeckItem(id="q1", term="Apple", answers=["apple"])
        
        # Add new answer
        added = item.add_answer("pomme")
        self.assertTrue(added)
        self.assertIn("pomme", item.answers)
        
        # Try to add duplicate
        added_again = item.add_answer("pomme")
        self.assertFalse(added_again)
        self.assertEqual(len(item.answers), 2)

    def test_pair_state_roundtrip(self):
        """Test PairState to_dict and from_dict."""
        due = time() + 123.45
        pair = PairState(
            pair_id="q1",
            next_due=due,
            current_interval=120,
            response_count=7,
            pass_count=5,
            fail_count=2,
            timeout_count=3,
            answer_history={"apple": 3, "pomme": 1},
        )
        data = pair.to_dict()
        restored = PairState.from_dict(data)
        self.assertEqual(restored.pair_id, "q1")
        self.assertEqual(restored.next_due, due)
        self.assertEqual(restored.current_interval, 120)
        self.assertEqual(restored.response_count, 7)
        self.assertEqual(restored.pass_count, 5)
        self.assertEqual(restored.fail_count, 2)
        self.assertEqual(restored.timeout_count, 3)
        self.assertEqual(restored.answer_history, {"apple": 3, "pomme": 1})
        self.assertEqual(restored.total_responses(), 10)
        self.assertTrue(restored.validate_consistency())

    def test_pair_state_answer_tracking(self):
        """Test tracking user's answer history."""
        pair = PairState(pair_id="q1", next_due=time(), current_interval=120)
        
        # Record some answers
        pair.record_answer("apple")
        pair.record_answer("pomme")
        pair.record_answer("apple")
        pair.record_answer("apple")
        
        # Check history
        stats = pair.get_answer_stats()
        self.assertEqual(stats["apple"], 3)
        self.assertEqual(stats["pomme"], 1)
        
        # Check most common
        most_common = pair.most_common_answer()
        self.assertEqual(most_common, "apple")

    def test_pair_state_answer_history_persistence(self):
        """Test that answer history persists through serialization."""
        pair = PairState(pair_id="q1", next_due=time(), current_interval=120)
        pair.record_answer("alpha")
        pair.record_answer("alpha")
        pair.record_answer("beta")
        
        # Serialize and deserialize
        data = pair.to_dict()
        restored = PairState.from_dict(data)
        
        # Verify history is preserved
        self.assertEqual(restored.answer_history["alpha"], 2)
        self.assertEqual(restored.answer_history["beta"], 1)

    def test_pair_state_consistency_validation(self):
        """Test PairState consistency checks."""
        consistent_pair = PairState(
            pair_id="q1",
            next_due=time(),
            current_interval=120,
            response_count=4,
            pass_count=3,
            fail_count=1,
            timeout_count=2,
        )
        self.assertTrue(consistent_pair.validate_consistency())

        inconsistent_pair = PairState(
            pair_id="q2",
            next_due=time(),
            current_interval=120,
            response_count=4,
            pass_count=1,
            fail_count=1,
            timeout_count=0,
        )
        with self.assertRaises(ValueError):
            inconsistent_pair.validate_consistency()

    def test_review_event_roundtrip(self):
        """Test ReviewEvent to_dict and from_dict."""
        event = ReviewEvent(
            pair_id="q1",
            term="Test",
            result=ReviewResult.PASS,
            elapsed_seconds=5.5,
            timestamp="2026-03-31T10:00:00",
            timeout_seconds=30,
            user_answer="apple"
        )
        data = event.to_dict()
        restored = ReviewEvent.from_dict(data)
        self.assertEqual(restored.pair_id, "q1")
        self.assertEqual(restored.result, ReviewResult.PASS)
        self.assertEqual(restored.user_answer, "apple")

    def test_pair_state_from_dict_backwards_compat_attempt_count(self):
        """Test legacy attempt_count is accepted and mapped to response_count."""
        data = {
            "pair_id": "q1",
            "next_due": 100.0,
            "current_interval": 120,
            "attempt_count": 3,
            "pass_count": 2,
            "fail_count": 1,
            "timeout_count": 1,
            "answer_history": {"apple": 2},
        }

        pair = PairState.from_dict(data)
        self.assertEqual(pair.response_count, 3)
        self.assertEqual(pair.pass_count, 2)
        self.assertEqual(pair.fail_count, 1)
        self.assertEqual(pair.timeout_count, 1)


class TestPersistence(unittest.TestCase):
    """Test persistence layer."""

    def setUp(self):
        """Create temp directory for test files."""
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)

    def tearDown(self):
        """Clean up temp directory."""
        self.temp_dir.cleanup()

    def test_deck_roundtrip(self):
        """Test deck save and load."""
        deck = Deck(items=[
            DeckItem(id="q1", term="A", answers=["answer1", "answer2"]),
            DeckItem(id="q2", term="B", answers=["answer3"]),
        ])
        deck_file = self.temp_path / "deck.json"

        save_deck(deck, deck_file)
        loaded = load_deck(deck_file)

        self.assertEqual(len(loaded.items), 2)
        self.assertEqual(loaded.items[0].id, "q1")
        self.assertEqual(loaded.items[0].answers, ["answer1", "answer2"])

    def test_deck_add_answer_and_persist(self):
        """Test adding new answers to deck and persisting."""
        deck = Deck(items=[
            DeckItem(id="q1", term="Apple", answers=["apple"]),
        ])
        deck_file = self.temp_path / "deck.json"
        save_deck(deck, deck_file)

        # Load and add answer
        loaded = load_deck(deck_file)
        added = loaded.add_answer_to_pair("q1", "pomme")
        self.assertTrue(added)

        # Save and reload
        save_deck(loaded, deck_file)
        reloaded = load_deck(deck_file)

        # Verify new answer persisted
        item = reloaded.get_item_by_id("q1")
        self.assertIsNotNone(item)
        self.assertIn("pomme", item.answers)

    def test_deck_get_item_by_id(self):
        """Test retrieving item from deck by ID."""
        deck = Deck(items=[
            DeckItem(id="q1", term="A", answers=["a"]),
            DeckItem(id="q2", term="B", answers=["b"]),
        ])
        
        item1 = deck.get_item_by_id("q1")
        self.assertIsNotNone(item1)
        self.assertEqual(item1.term, "A")
        
        item_missing = deck.get_item_by_id("q999")
        self.assertIsNone(item_missing)

    def test_state_roundtrip(self):
        """Test state save and load."""
        state = SRSState(pairs=[
            PairState(
                pair_id="q1",
                next_due=time(),
                current_interval=60,
                response_count=1,
                pass_count=1,
                fail_count=0,
                timeout_count=2,
                answer_history={"a": 1},
            ),
            PairState(
                pair_id="q2",
                next_due=time() + 120,
                current_interval=90,
                response_count=4,
                pass_count=2,
                fail_count=2,
                timeout_count=1,
                answer_history={"b": 2, "bee": 1},
            ),
        ])
        state_file = self.temp_path / "state.json"

        save_state(state, state_file)
        loaded = load_state(Deck(items=[
            DeckItem(id="q1", term="A", answers=["a"]),
            DeckItem(id="q2", term="B", answers=["b"]),
        ]), state_file)

        self.assertEqual(len(loaded.pairs), 2)
        self.assertEqual(loaded.pairs[0].pair_id, "q1")
        self.assertEqual(loaded.pairs[0].response_count, 1)
        self.assertEqual(loaded.pairs[0].pass_count, 1)
        self.assertEqual(loaded.pairs[0].fail_count, 0)
        self.assertEqual(loaded.pairs[0].timeout_count, 2)
        self.assertEqual(loaded.pairs[0].answer_history, {"a": 1})
        self.assertEqual(loaded.pairs[1].pair_id, "q2")
        self.assertEqual(loaded.pairs[1].current_interval, 90)
        self.assertEqual(loaded.pairs[1].response_count, 4)
        self.assertEqual(loaded.pairs[1].pass_count, 2)
        self.assertEqual(loaded.pairs[1].fail_count, 2)
        self.assertEqual(loaded.pairs[1].timeout_count, 1)
        self.assertEqual(loaded.pairs[1].answer_history, {"b": 2, "bee": 1})
        self.assertTrue(validate_state(Deck(items=[
            DeckItem(id="q1", term="A", answers=["a"]),
            DeckItem(id="q2", term="B", answers=["b"]),
        ]), loaded))

    def test_history_append(self):
        """Test appending and loading review events."""
        history_file = self.temp_path / "history.jsonl"

        event1 = ReviewEvent(
            pair_id="q1", term="A", result=ReviewResult.PASS,
            elapsed_seconds=5.5, timestamp="2026-01-01T10:00:00",
            timeout_seconds=30
        )
        event2 = ReviewEvent(
            pair_id="q2", term="B", result=ReviewResult.TIMEOUT,
            elapsed_seconds=30.0, timestamp="2026-01-01T10:01:00",
            timeout_seconds=30, reason="timeout"
        )

        append_review_event(event1, history_file)
        append_review_event(event2, history_file)

        events = load_history(history_file)
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0].pair_id, "q1")
        self.assertEqual(events[0].result, ReviewResult.PASS)
        self.assertEqual(events[1].reason, "timeout")

    def test_initialize_state(self):
        """Test initializing state for a deck."""
        deck = Deck(items=[
            DeckItem(id="q1", term="A", answers=["a"]),
            DeckItem(id="q2", term="B", answers=["b"]),
            DeckItem(id="q3", term="C", answers=["c"]),
        ])
        state = initialize_state_for_deck(deck, initial_interval=60)

        self.assertEqual(len(state.pairs), 3)
        self.assertTrue(all(pair.response_count == 0 for pair in state.pairs))
        self.assertTrue(all(pair.current_interval == 60 for pair in state.pairs))


if __name__ == "__main__":
    unittest.main()
