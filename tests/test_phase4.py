"""
Unit tests for Phase 4: persistence and session recovery.
"""

import tempfile
import unittest
from pathlib import Path

from config import SRSConfig
from engine import ReviewEngine
from persistence import clear_session_snapshot, load_session_snapshot, save_session_snapshot
from schemas import Deck, DeckItem, PairState, ReviewResult, SRSState
from session import SessionController


class TestSessionSnapshotPersistence(unittest.TestCase):
    """Test standalone session snapshot persistence helpers."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)
        self.session_file = self.temp_path / "session.json"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_save_load_and_clear_session_snapshot(self):
        snapshot = {
            "pair_id": "q1",
            "term": "AC",
            "answers": ["apple"],
            "started_at": 123.0,
            "timeout_seconds": 30,
            "revealed": False,
        }

        save_session_snapshot(snapshot, self.session_file)
        loaded = load_session_snapshot(self.session_file)
        self.assertEqual(loaded, snapshot)

        clear_session_snapshot(self.session_file)
        self.assertIsNone(load_session_snapshot(self.session_file))


class TestSessionRecoveryFlow(unittest.TestCase):
    """Test session controller hooks and restart recovery flow."""

    def setUp(self):
        self.config = SRSConfig()
        self.deck = Deck(items=[
            DeckItem(id="q1", term="AC", answers=["apple", "apricot"]),
        ])
        self.state = SRSState(pairs=[
            PairState(pair_id="q1", next_due=10.0, current_interval=60),
        ])
        self.engine = ReviewEngine(self.deck, self.state, self.config)

        self.saved_snapshots = []
        self.cleared_snapshot_count = 0
        self.appended_events = []
        self.saved_states = []

        def clear_snapshot() -> None:
            self.cleared_snapshot_count += 1

        self.session = SessionController(
            self.engine,
            save_state_callback=self.saved_states.append,
            append_event_callback=self.appended_events.append,
            save_active_review_callback=self.saved_snapshots.append,
            clear_active_review_callback=clear_snapshot,
        )

    def test_start_and_reveal_persist_active_snapshot_then_grade_clears(self):
        self.session.start_next_review(now=12.0)
        self.assertEqual(len(self.saved_snapshots), 1)
        self.assertFalse(self.saved_snapshots[-1]["revealed"])

        self.session.reveal_answers(now=13.0)
        self.assertEqual(len(self.saved_snapshots), 2)
        self.assertTrue(self.saved_snapshots[-1]["revealed"])

        event = self.session.grade_pass(user_answer="apple", now=15.0)
        self.assertEqual(event.result, ReviewResult.PASS)
        self.assertIsNone(self.session.active_review)
        self.assertEqual(self.cleared_snapshot_count, 1)
        self.assertEqual(len(self.saved_states), 1)
        self.assertEqual(len(self.appended_events), 1)

    def test_restore_active_review_and_continue_flow(self):
        snapshot = {
            "pair_id": "q1",
            "term": "AC",
            "answers": ["apple", "apricot"],
            "started_at": 12.0,
            "timeout_seconds": self.config.timeout_seconds,
            "revealed": True,
        }

        self.session.restore_active_review(snapshot, now=1000.0)
        self.assertIsNotNone(self.session.active_review)
        self.assertTrue(self.session.active_review.revealed)
        self.assertEqual(self.session.active_review.timer.started_at, 1000.0)

        # Should not auto-timeout based on old snapshot timestamp.
        self.assertIsNone(self.session.check_timeout(now=1000.0 + self.config.timeout_seconds - 1))

        event = self.session.grade_fail(user_answer="wrong", now=1003.0)
        self.assertEqual(event.result, ReviewResult.FAIL)
        self.assertEqual(self.state.pairs[0].response_count, 1)
        self.assertEqual(self.state.pairs[0].fail_count, 1)
        self.assertEqual(self.state.pairs[0].next_due, 1003.0 + self.config.fail_interval_reset)
        self.assertEqual(self.cleared_snapshot_count, 1)

    def test_restore_restarts_full_timeout_window(self):
        snapshot = {
            "pair_id": "q1",
            "term": "AC",
            "answers": ["apple", "apricot"],
            "started_at": 1.0,
            "timeout_seconds": self.config.timeout_seconds,
            "revealed": False,
        }

        restore_now = 5000.0
        self.session.restore_active_review(snapshot, now=restore_now)

        # Full timeout should be available from restore time.
        self.assertEqual(
            self.session.time_remaining(now=restore_now),
            float(self.config.timeout_seconds),
        )

        timeout_event = self.session.check_timeout(
            now=restore_now + self.config.timeout_seconds
        )
        self.assertIsNotNone(timeout_event)
        self.assertEqual(timeout_event.result, ReviewResult.TIMEOUT)

    def test_restore_invalid_snapshot_raises(self):
        with self.assertRaises(ValueError):
            self.session.restore_active_review({"pair_id": "q1"})

    def test_restore_with_no_active_review_snapshot_is_noop(self):
        """Restoring with no snapshot should keep session in idle state."""
        self.session.restore_active_review(None)

        self.assertIsNone(self.session.active_review)
        self.assertEqual(len(self.session.reviewed_events), 0)

        # Normal flow should still work after no-op restore.
        item = self.session.start_next_review(now=12.0)
        self.assertIsNotNone(item)
        self.assertEqual(item.id, "q1")


if __name__ == "__main__":
    unittest.main()
