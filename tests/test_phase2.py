"""
Unit tests for Phase 2: core review engine.
"""

import unittest

from config import SRSConfig
from engine import ReviewEngine
from schemas import Deck, DeckItem, PairState, ReviewEvent, ReviewResult, SRSState


class TestReviewEngine(unittest.TestCase):
    """Test scheduler and transition behavior."""

    def setUp(self):
        # Use current defaults so tests remain valid when config.py values change.
        self.config = SRSConfig()

    def _expected_pass_interval(self, current_interval: int) -> int:
        """Compute expected grown interval using the active config."""
        return max(1, int(round(current_interval * self.config.pass_interval_multiplier)))

    def test_get_due_pair_returns_earliest_due(self):
        deck = Deck(items=[
            DeckItem(id="q1", term="AC", answers=["apple"]),
            DeckItem(id="q2", term="BD", answers=["boat"]),
        ])
        state = SRSState(pairs=[
            PairState(pair_id="q1", next_due=90.0, current_interval=60),
            PairState(pair_id="q2", next_due=95.0, current_interval=60),
        ])
        engine = ReviewEngine(deck, state, self.config)

        due = engine.get_due_pair(now=100.0)
        self.assertIsNotNone(due)
        self.assertEqual(due.id, "q1")

    def test_get_due_pair_none_when_nothing_due(self):
        deck = Deck(items=[DeckItem(id="q1", term="AC", answers=["apple"])])
        state = SRSState(pairs=[PairState(pair_id="q1", next_due=200.0, current_interval=60)])
        engine = ReviewEngine(deck, state, self.config)

        due = engine.get_due_pair(now=100.0)
        self.assertIsNone(due)
        self.assertEqual(engine.seconds_until_next_due(now=100.0), 100.0)

    def test_record_pass_updates_counts_schedule_and_history(self):
        deck = Deck(items=[DeckItem(id="q1", term="AC", answers=["apple"])])
        state = SRSState(pairs=[
            PairState(
                pair_id="q1",
                next_due=100.0,
                current_interval=100,
                attempt_count=2,
                pass_count=1,
                fail_count=1,
            )
        ])
        engine = ReviewEngine(deck, state, self.config)

        event = engine.record_pass(
            pair_id="q1",
            elapsed_seconds=7.25,
            user_answer="apple",
            now=200.0,
        )

        pair = state.pairs[0]
        expected_interval = self._expected_pass_interval(100)
        self.assertEqual(pair.attempt_count, 3)
        self.assertEqual(pair.pass_count, 2)
        self.assertEqual(pair.fail_count, 1)
        self.assertEqual(pair.timeout_count, 0)
        self.assertEqual(pair.current_interval, expected_interval)
        self.assertEqual(pair.next_due, 200.0 + expected_interval)
        self.assertEqual(pair.answer_history, {"apple": 1})
        self.assertTrue(pair.validate_consistency())

        self.assertEqual(event.pair_id, "q1")
        self.assertEqual(event.term, "AC")
        self.assertEqual(event.result, ReviewResult.PASS)
        self.assertEqual(event.elapsed_seconds, 7.25)
        self.assertEqual(event.timeout_seconds, self.config.timeout_seconds)
        self.assertEqual(event.user_answer, "apple")
        self.assertIsNone(event.reason)
        self.assertEqual(event.timestamp, "1970-01-01T00:03:20")

    def test_record_fail_resets_interval_and_returns_fail_event(self):
        deck = Deck(items=[DeckItem(id="q1", term="AC", answers=["apple"])])
        state = SRSState(pairs=[
            PairState(
                pair_id="q1",
                next_due=100.0,
                current_interval=300,
                attempt_count=0,
                pass_count=0,
                fail_count=0,
            )
        ])
        engine = ReviewEngine(deck, state, self.config)

        event = engine.record_fail(
            pair_id="q1",
            elapsed_seconds=8.0,
            user_answer="apples",
            now=250.0,
        )

        pair = state.pairs[0]
        self.assertEqual(pair.attempt_count, 1)
        self.assertEqual(pair.pass_count, 0)
        self.assertEqual(pair.fail_count, 1)
        self.assertEqual(pair.timeout_count, 0)
        self.assertEqual(pair.current_interval, self.config.fail_interval_reset)
        self.assertEqual(pair.next_due, 250.0 + self.config.fail_interval_reset)
        self.assertEqual(pair.answer_history, {"apples": 1})
        self.assertTrue(pair.validate_consistency())

        self.assertEqual(event.result, ReviewResult.FAIL)
        self.assertEqual(event.user_answer, "apples")
        self.assertIsNone(event.reason)

    def test_record_timeout_treated_as_fail_for_state(self):
        deck = Deck(items=[DeckItem(id="q1", term="AC", answers=["apple"])])
        state = SRSState(pairs=[
            PairState(
                pair_id="q1",
                next_due=100.0,
                current_interval=300,
                attempt_count=5,
                pass_count=3,
                fail_count=2,
            )
        ])
        engine = ReviewEngine(deck, state, self.config)

        event = engine.record_timeout(
            pair_id="q1",
            elapsed_seconds=float(self.config.timeout_seconds),
            now=400.0,
        )

        pair = state.pairs[0]
        self.assertEqual(pair.attempt_count, 5)
        self.assertEqual(pair.pass_count, 3)
        self.assertEqual(pair.fail_count, 2)
        self.assertEqual(pair.timeout_count, 1)
        self.assertEqual(pair.current_interval, self.config.fail_interval_reset)
        self.assertEqual(pair.next_due, 400.0 + self.config.fail_interval_reset)
        self.assertEqual(pair.answer_history, {})
        self.assertTrue(pair.validate_consistency())

        self.assertEqual(event.result, ReviewResult.TIMEOUT)
        self.assertIsNone(event.user_answer)
        self.assertEqual(event.reason, "timeout")

    def test_session_stats(self):
        events = [
            ReviewEvent(
                pair_id="q1",
                term="AC",
                result=ReviewResult.PASS,
                elapsed_seconds=3.0,
                timestamp="2026-03-31T10:00:00",
                timeout_seconds=self.config.timeout_seconds,
            ),
            ReviewEvent(
                pair_id="q2",
                term="BD",
                result=ReviewResult.FAIL,
                elapsed_seconds=6.0,
                timestamp="2026-03-31T10:01:00",
                timeout_seconds=self.config.timeout_seconds,
            ),
            ReviewEvent(
                pair_id="q3",
                term="CE",
                result=ReviewResult.TIMEOUT,
                elapsed_seconds=float(self.config.timeout_seconds),
                timestamp="2026-03-31T10:02:00",
                timeout_seconds=self.config.timeout_seconds,
                reason="timeout",
            ),
        ]

        stats = ReviewEngine.get_session_stats(events)
        self.assertEqual(stats.total, 3)
        self.assertEqual(stats.passed, 1)
        self.assertEqual(stats.failed, 1)
        self.assertEqual(stats.timed_out, 1)
        self.assertEqual(stats.attempts, 2)
        self.assertEqual(stats.total - stats.timed_out, stats.attempts)
        self.assertEqual(stats.attempts, stats.passed + stats.failed)
        self.assertAlmostEqual(stats.pass_rate, 1 / 3)


if __name__ == "__main__":
    unittest.main()
