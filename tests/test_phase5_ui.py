"""Unit tests for Phase 5: non-visual UI interaction behavior."""

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from ui import SRSAppWindow


class DummyInput:
    def __init__(self, value=""):
        self._value = value

    def text(self):
        return self._value

    def clear(self):
        self._value = ""

    def set(self, value):
        self._value = value


class DummyLabel:
    def __init__(self):
        self.value = ""

    def setText(self, text):
        self.value = text


class DummyCheck:
    def __init__(self, checked=False):
        self._checked = checked

    def isChecked(self):
        return self._checked


class DummySpin:
    def __init__(self, value):
        self._value = value

    def value(self):
        return self._value


class TestPhase5UILogic(unittest.TestCase):
    """Test UI control flow without creating real Qt widgets."""

    def _build_window_stub(self):
        win = SRSAppWindow.__new__(SRSAppWindow)
        win.auto_start_enabled = False
        win.answer_input = DummyInput("")
        win.status_label = DummyLabel()
        win.answers_label = DummyLabel()
        win.settings_status_label = DummyLabel()

        win.timeout_spin = DummySpin(30)
        win.pass_multiplier_spin = DummySpin(1.5)
        win.fail_reset_spin = DummySpin(60)
        win.auto_start_check = DummyCheck(False)

        win.runtime_config = SimpleNamespace(
            timeout_seconds=30,
            pass_interval_multiplier=1.5,
            fail_interval_reset=60,
        )

        win._last_timeout_answers = []
        win._refresh_all = MagicMock()
        win._attempt_auto_start_next_due = MagicMock()

        win.deck = MagicMock()
        win.session = MagicMock()
        win.session.active_review = None
        return win

    def test_grade_pass_manual_mode_does_not_auto_start(self):
        win = self._build_window_stub()
        win.auto_start_enabled = False
        win.answer_input.set("apple")

        win.session.grade_pass = MagicMock()

        win._grade(is_pass=True)

        win.session.grade_pass.assert_called_once_with(user_answer="apple")
        win._attempt_auto_start_next_due.assert_called_once()
        self.assertEqual(win.answer_input.text(), "")

    def test_grade_fail_auto_mode(self):
        win = self._build_window_stub()
        win.auto_start_enabled = True
        win.answer_input.set("wrong")

        win.session.grade_fail = MagicMock()

        win._grade(is_pass=False)

        win.session.grade_fail.assert_called_once_with(user_answer="wrong")
        self.assertEqual(win.answer_input.text(), "")

    @patch("ui.save_deck")
    @patch("ui.save_session_snapshot")
    def test_on_add_answer_persists_deck_and_snapshot(self, mock_save_snapshot, mock_save_deck):
        win = self._build_window_stub()
        active = SimpleNamespace(pair_id="q1", answers=["apple"], revealed=True)
        win.session.active_review = active
        win.session.active_review_snapshot = MagicMock(return_value={"pair_id": "q1"})

        win.answer_input.set("apricot")
        win.deck.add_answer_to_pair.return_value = True

        win._on_add_answer()

        win.deck.add_answer_to_pair.assert_called_once_with("q1", "apricot")
        self.assertIn("apricot", active.answers)
        mock_save_snapshot.assert_called_once()
        mock_save_deck.assert_called_once()
        self.assertIn("Added new accepted answer", win.status_label.value)

    @patch("ui.QMessageBox.information")
    @patch("ui.save_deck")
    @patch("ui.save_session_snapshot")
    def test_on_add_answer_duplicate_shows_message(self, _mock_save_snapshot, _mock_save_deck, mock_info):
        win = self._build_window_stub()
        active = SimpleNamespace(pair_id="q1", answers=["apple"], revealed=False)
        win.session.active_review = active

        win.answer_input.set("apple")
        win.deck.add_answer_to_pair.return_value = False

        win._on_add_answer()

        mock_info.assert_called_once()

    def test_apply_settings_updates_runtime_and_auto_start_mode(self):
        win = self._build_window_stub()
        win.timeout_spin = DummySpin(45)
        win.pass_multiplier_spin = DummySpin(2.0)
        win.fail_reset_spin = DummySpin(90)
        win.auto_start_check = DummyCheck(True)
        win.session.active_review = None

        win._on_apply_settings()

        self.assertEqual(win.runtime_config.timeout_seconds, 45)
        self.assertEqual(win.runtime_config.pass_interval_multiplier, 2.0)
        self.assertEqual(win.runtime_config.fail_interval_reset, 90)
        self.assertTrue(win.auto_start_enabled)
        self.assertIn("auto-start", win.settings_status_label.value)


if __name__ == "__main__":
    unittest.main()
