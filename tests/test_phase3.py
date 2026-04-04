"""
Unit tests for Phase 3: timing and interaction flow.
"""

import unittest

from config import SRSConfig
from engine import ReviewEngine
from schemas import Deck, DeckItem, PairState, ReviewResult, SRSState
from session import SessionController


class TestSessionController(unittest.TestCase):
    """Test review flow, timeout handling, and persistence hooks."""

    def setUp(self):
        self.config = SRSConfig()
        self.deck = Deck(items=[
            DeckItem(id="q1", term="AC", answers=["apple", "apricot"]),
            DeckItem(id="q2", term="BD", answers=["boat"]),
        ])
        self.state = SRSState(pairs=[
            PairState(pair_id="q1", next_due=10.0, current_interval=60),
            PairState(pair_id="q2", next_due=20.0, current_interval=60),
        ])
        self.engine = ReviewEngine(self.deck, self.state, self.config)

        self.saved_states = []
        self.appended_events = []
        self.session = SessionController(
            self.engine,
            save_state_callback=self.saved_states.append,
            append_event_callback=self.appended_events.append,
        )

    def _pair_state(self, pair_id: str) -> PairState:
        for pair in self.state.pairs:
            if pair.pair_id == pair_id:
                return pair
        self.fail(f"Missing pair state for {pair_id}")

    def test_start_next_review_selects_due_pair_and_sets_timer(self):
        item = self.session.start_next_review(now=12.0)

        self.assertIsNotNone(item)
        self.assertEqual(item.id, "q1")
        self.assertIsNotNone(self.session.active_review)
        self.assertEqual(self.session.active_review.pair_id, "q1")
        self.assertEqual(self.session.time_remaining(now=12.0), float(self.config.timeout_seconds))

    def test_start_next_review_raises_when_active_review_exists(self):
        self.session.start_next_review(now=12.0)

        with self.assertRaises(ValueError):
            self.session.start_next_review(now=13.0)

    def test_reveal_then_pass_records_event_and_persists(self):
        self.session.start_next_review(now=12.0)
        answers = self.session.reveal_answers(now=13.0)

        self.assertEqual(answers, ["apple", "apricot"])

        event = self.session.grade_pass(user_answer="apple", now=15.0)

        self.assertEqual(event.result, ReviewResult.PASS)
        self.assertEqual(event.user_answer, "apple")
        self.assertEqual(event.timeout_seconds, self.config.timeout_seconds)
        self.assertAlmostEqual(event.elapsed_seconds, 3.0)

        self.assertIsNone(self.session.active_review)
        self.assertEqual(len(self.session.reviewed_events), 1)
        self.assertEqual(len(self.appended_events), 1)
        self.assertEqual(len(self.saved_states), 1)

    def test_grade_pass_updates_pair_schedule_and_counters(self):
        pair_before = self._pair_state("q1")
        initial_interval = pair_before.current_interval

        self.session.start_next_review(now=12.0)
        self.session.reveal_answers(now=13.0)
        self.session.grade_pass(user_answer="apple", now=15.0)

        pair_after = self._pair_state("q1")
        expected_interval = max(
            1,
            int(round(initial_interval * self.config.pass_interval_multiplier)),
        )

        self.assertEqual(pair_after.pass_count, 1)
        self.assertEqual(pair_after.fail_count, 0)
        self.assertEqual(pair_after.timeout_count, 0)
        self.assertEqual(pair_after.response_count, 1)
        self.assertEqual(pair_after.current_interval, expected_interval)
        self.assertEqual(pair_after.next_due, 15.0 + expected_interval)
        self.assertEqual(pair_after.answer_history, {"apple": 1})

    def test_grade_fail_updates_pair_schedule_and_counters(self):
        self.session.start_next_review(now=12.0)
        self.session.reveal_answers(now=13.0)
        self.session.grade_fail(user_answer="wrong", now=16.0)

        pair_after = self._pair_state("q1")
        self.assertEqual(pair_after.pass_count, 0)
        self.assertEqual(pair_after.fail_count, 1)
        self.assertEqual(pair_after.timeout_count, 0)
        self.assertEqual(pair_after.response_count, 1)
        self.assertEqual(pair_after.current_interval, self.config.fail_interval_reset)
        self.assertEqual(pair_after.next_due, 16.0 + self.config.fail_interval_reset)
        self.assertEqual(pair_after.answer_history, {"wrong": 1})

    def test_timeout_updates_pair_schedule_without_response_increment(self):
        self.session.start_next_review(now=12.0)
        timeout_at = 12.0 + self.config.timeout_seconds
        self.session.check_timeout(now=timeout_at)

        pair_after = self._pair_state("q1")
        self.assertEqual(pair_after.pass_count, 0)
        self.assertEqual(pair_after.fail_count, 0)
        self.assertEqual(pair_after.timeout_count, 1)
        self.assertEqual(pair_after.response_count, 0)
        self.assertEqual(pair_after.current_interval, self.config.fail_interval_reset)
        self.assertEqual(pair_after.next_due, timeout_at + self.config.fail_interval_reset)
        self.assertEqual(pair_after.answer_history, {})

    def test_grade_without_reveal_raises(self):
        self.session.start_next_review(now=12.0)

        with self.assertRaises(ValueError):
            self.session.grade_fail(user_answer="wrong", now=13.0)

    def test_timeout_auto_records_once_and_blocks_grading(self):
        self.session.start_next_review(now=12.0)

        timeout_at = 12.0 + self.config.timeout_seconds
        event = self.session.check_timeout(now=timeout_at)

        self.assertIsNotNone(event)
        self.assertEqual(event.result, ReviewResult.TIMEOUT)
        self.assertEqual(event.reason, "timeout")
        self.assertEqual(event.elapsed_seconds, float(self.config.timeout_seconds))

        # No duplicate recording after finalize.
        second_timeout = self.session.check_timeout(now=timeout_at + 5)
        self.assertIsNone(second_timeout)

        self.assertEqual(len(self.session.reviewed_events), 1)
        self.assertEqual(len(self.appended_events), 1)
        self.assertEqual(len(self.saved_states), 1)

        with self.assertRaises(ValueError):
            self.session.grade_pass(user_answer="apple", now=timeout_at + 5)

    def test_reveal_after_timeout_raises(self):
        self.session.start_next_review(now=12.0)

        timeout_at = 12.0 + self.config.timeout_seconds
        self.session.check_timeout(now=timeout_at)

        with self.assertRaises(ValueError):
            self.session.reveal_answers(now=timeout_at + 1)

    def test_no_due_pair_returns_none(self):
        # Nothing due yet.
        item = self.session.start_next_review(now=5.0)
        self.assertIsNone(item)
        self.assertIsNone(self.session.active_review)

    def test_session_stats_match_recorded_events(self):
        self.session.start_next_review(now=12.0)
        self.session.reveal_answers(now=13.0)
        self.session.grade_pass(user_answer="apple", now=15.0)

        self.session.start_next_review(now=22.0)
        self.session.reveal_answers(now=23.0)
        self.session.grade_fail(user_answer="wrong", now=24.0)

        stats = self.session.get_session_stats()

        self.assertEqual(stats.total, 2)
        self.assertEqual(stats.passed, 1)
        self.assertEqual(stats.failed, 1)
        self.assertEqual(stats.timed_out, 0)
        self.assertEqual(stats.responses, 2)


if __name__ == "__main__":
    unittest.main()
