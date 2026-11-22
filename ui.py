"""PySide6 UI for the Letter Pair SRS app."""

from __future__ import annotations

import sys
from typing import Any, Dict, Optional

from config import CONFIG, DECK_FILE, HISTORY_FILE, SESSION_FILE, STATE_FILE, SRSConfig
from engine import ReviewEngine
from persistence import (
    append_review_event,
    clear_session_snapshot,
    load_deck,
    load_session_snapshot,
    load_state,
    save_deck,
    save_session_snapshot,
    save_state,
)
from session import SessionController
from schemas import Deck, ReviewResult, SRSState

try:
    from PySide6.QtCore import Qt, QTimer
    from PySide6.QtGui import QKeySequence, QShortcut
    from PySide6.QtWidgets import (
        QApplication,
        QCheckBox,
        QDoubleSpinBox,
        QFormLayout,
        QFrame,
        QHBoxLayout,
        QLabel,
        QLineEdit,
        QMainWindow,
        QMessageBox,
        QPushButton,
        QSpinBox,
        QTabWidget,
        QVBoxLayout,
        QWidget,
    )
except Exception:  # pragma: no cover - allows non-UI tests without PySide6 installed
    class _MessageBoxStub:
        @staticmethod
        def information(*_args, **_kwargs) -> None:
            return None

    QApplication = None
    QMainWindow = object
    QTimer = None
    QShortcut = None
    Qt = None
    QKeySequence = None
    QCheckBox = None
    QDoubleSpinBox = None
    QFormLayout = None
    QFrame = None
    QHBoxLayout = None
    QLabel = None
    QLineEdit = None
    QMessageBox = _MessageBoxStub
    QPushButton = None
    QSpinBox = None
    QTabWidget = None
    QVBoxLayout = None
    QWidget = None


class SRSAppWindow(QMainWindow):
    """Desktop UI shell for review flow, settings, and session summary."""

    def __init__(self):
        if QApplication is None:
            raise RuntimeError("PySide6 is not installed. Run: python3 -m pip install PySide6")

        super().__init__()
        self.setWindowTitle("Letter Pair SRS")
        self.resize(980, 680)
        self.setMinimumSize(860, 560)

        self.deck: Deck = load_deck(DECK_FILE)
        self.state: SRSState = load_state(self.deck, STATE_FILE)

        self.runtime_config = SRSConfig(**vars(CONFIG))
        self.auto_start_enabled = False
        self.engine = ReviewEngine(self.deck, self.state, self.runtime_config)
        self.session = SessionController(
            self.engine,
            save_state_callback=lambda s: save_state(s, STATE_FILE),
            append_event_callback=lambda e: append_review_event(e, HISTORY_FILE),
            save_active_review_callback=lambda snapshot: save_session_snapshot(snapshot, SESSION_FILE),
            clear_active_review_callback=lambda: clear_session_snapshot(SESSION_FILE),
        )

        self._last_timeout_answers: list[str] = []

        self._build_ui()
        self._bind_shortcuts()
        self._restore_session_if_present()
        self._ensure_active_or_wait()
        self._refresh_all()

        self.tick_timer = QTimer(self)
        self.tick_timer.timeout.connect(self._tick)
        self.tick_timer.start(200)

    def _build_ui(self) -> None:
        root = QWidget(self)
        self.setCentralWidget(root)

        root_layout = QVBoxLayout(root)
        root_layout.setContentsMargins(14, 14, 14, 14)
        root_layout.setSpacing(10)

        self.tabs = QTabWidget()
        self.tabs.setDocumentMode(True)
        root_layout.addWidget(self.tabs)

        self.review_tab = QWidget()
        self.settings_tab = QWidget()
        self.summary_tab = QWidget()

        self.tabs.addTab(self.review_tab, "Review")
        self.tabs.addTab(self.settings_tab, "Settings")
        self.tabs.addTab(self.summary_tab, "Session Summary")

        self._build_review_tab()
        self._build_settings_tab()
        self._build_summary_tab()

        self.setStyleSheet(
            """
            QMainWindow, QWidget { background: #f4f6f8; color: #101820; }
            QTabWidget::pane { border: 1px solid #d9dee5; background: #ffffff; }
            QTabBar::tab { background: #e9edf2; border: 1px solid #d2d8e0; padding: 8px 14px; }
            QTabBar::tab:selected { background: #ffffff; }
            QLabel#termLabel { font-size: 34px; font-weight: 700; color: #14213d; }
            QLabel#sectionTitle { font-size: 20px; font-weight: 650; color: #1f2937; }
            QFrame#cardPanel { border: 1px solid #d9dee5; border-radius: 8px; background: #ffffff; }
            QLineEdit { border: 2px solid #8aa1bd; border-radius: 6px; padding: 8px; background: #ffffff; color: #111111; }
            QLineEdit:focus { border: 2px solid #2f6db3; }
            QPushButton { background: #edf1f5; border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px 12px; }
            QPushButton:disabled { color: #8b97a8; background: #f5f7fa; }
            """
        )

    def _build_review_tab(self) -> None:
        layout = QVBoxLayout(self.review_tab)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(12)

        panel = QFrame()
        panel.setObjectName("cardPanel")
        panel_layout = QVBoxLayout(panel)
        panel_layout.setContentsMargins(18, 18, 18, 18)
        panel_layout.setSpacing(12)
        layout.addWidget(panel)

        title = QLabel("Current Pair")
        title.setObjectName("sectionTitle")
        panel_layout.addWidget(title)

        self.term_label = QLabel("-")
        self.term_label.setObjectName("termLabel")
        panel_layout.addWidget(self.term_label)

        status_row = QHBoxLayout()
        self.timer_label = QLabel("Timer: -")
        self.status_label = QLabel("Status: Loading...")
        status_row.addWidget(self.timer_label)
        status_row.addSpacing(20)
        status_row.addWidget(self.status_label)
        status_row.addStretch(1)
        panel_layout.addLayout(status_row)

        answers_title = QLabel("Accepted Answers")
        answers_title.setObjectName("sectionTitle")
        panel_layout.addWidget(answers_title)

        self.answers_label = QLabel("Answers hidden")
        self.answers_label.setWordWrap(True)
        panel_layout.addWidget(self.answers_label)

        input_row = QHBoxLayout()
        input_row.addWidget(QLabel("Your Answer (optional):"))
        self.answer_input = QLineEdit()
        self.answer_input.setPlaceholderText("Type what you recalled...")
        input_row.addWidget(self.answer_input, 1)

        self.add_answer_btn = QPushButton("Add As Accepted")
        self.add_answer_btn.clicked.connect(self._on_add_answer)
        input_row.addWidget(self.add_answer_btn)
        panel_layout.addLayout(input_row)

        button_row = QHBoxLayout()
        self.next_btn = QPushButton("Next (N)")
        self.reveal_btn = QPushButton("Reveal (R)")
        self.pass_btn = QPushButton("Pass (P)")
        self.fail_btn = QPushButton("Fail (F)")

        self.next_btn.clicked.connect(self._on_next)
        self.reveal_btn.clicked.connect(self._on_reveal)
        self.pass_btn.clicked.connect(self._on_pass)
        self.fail_btn.clicked.connect(self._on_fail)

        button_row.addWidget(self.next_btn)
        button_row.addWidget(self.reveal_btn)
        button_row.addWidget(self.pass_btn)
        button_row.addWidget(self.fail_btn)
        button_row.addStretch(1)
        panel_layout.addLayout(button_row)

        self.wait_label = QLabel("")
        self.wait_label.setWordWrap(True)
        panel_layout.addWidget(self.wait_label)

    def _build_settings_tab(self) -> None:
        layout = QVBoxLayout(self.settings_tab)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(12)

        panel = QFrame()
        panel.setObjectName("cardPanel")
        panel_layout = QVBoxLayout(panel)
        panel_layout.setContentsMargins(18, 18, 18, 18)
        panel_layout.setSpacing(12)
        layout.addWidget(panel)

        title = QLabel("Session Settings")
        title.setObjectName("sectionTitle")
        panel_layout.addWidget(title)

        form = QFormLayout()
        form.setHorizontalSpacing(18)
        form.setVerticalSpacing(10)

        self.timeout_spin = QSpinBox()
        self.timeout_spin.setRange(1, 3600)
        self.timeout_spin.setValue(self.runtime_config.timeout_seconds)

        self.pass_multiplier_spin = QDoubleSpinBox()
        self.pass_multiplier_spin.setRange(0.1, 20.0)
        self.pass_multiplier_spin.setDecimals(2)
        self.pass_multiplier_spin.setSingleStep(0.1)
        self.pass_multiplier_spin.setValue(self.runtime_config.pass_interval_multiplier)

        self.fail_reset_spin = QSpinBox()
        self.fail_reset_spin.setRange(1, 3600)
        self.fail_reset_spin.setValue(self.runtime_config.fail_interval_reset)

        form.addRow("Timeout Seconds", self.timeout_spin)
        form.addRow("Pass Multiplier", self.pass_multiplier_spin)
        form.addRow("Fail Reset Seconds", self.fail_reset_spin)
        panel_layout.addLayout(form)

        self.auto_start_check = QCheckBox("Auto-start next due pair (otherwise manual Next)")
        self.auto_start_check.setChecked(self.auto_start_enabled)
        panel_layout.addWidget(self.auto_start_check)

        self.apply_settings_btn = QPushButton("Apply Session Settings")
        self.apply_settings_btn.clicked.connect(self._on_apply_settings)
        panel_layout.addWidget(self.apply_settings_btn)

        self.settings_status_label = QLabel("")
        self.settings_status_label.setWordWrap(True)
        panel_layout.addWidget(self.settings_status_label)

        panel_layout.addStretch(1)

    def _build_summary_tab(self) -> None:
        layout = QVBoxLayout(self.summary_tab)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(12)

        panel = QFrame()
        panel.setObjectName("cardPanel")
        panel_layout = QFormLayout(panel)
        panel_layout.setContentsMargins(18, 18, 18, 18)
        panel_layout.setSpacing(12)
        layout.addWidget(panel)

        self.total_value = QLabel("0")
        self.passed_value = QLabel("0")
        self.failed_value = QLabel("0")
        self.timeout_value = QLabel("0")
        self.responses_value = QLabel("0")
        self.pass_rate_value = QLabel("0.0%")

        panel_layout.addRow("Total Reviews", self.total_value)
        panel_layout.addRow("Passed", self.passed_value)
        panel_layout.addRow("Failed", self.failed_value)
        panel_layout.addRow("Timed Out", self.timeout_value)
        panel_layout.addRow("Responses", self.responses_value)
        panel_layout.addRow("Pass Rate", self.pass_rate_value)

        layout.addStretch(1)

    def _bind_shortcuts(self) -> None:
        QShortcut(QKeySequence(self.runtime_config.keyboard_shortcut_next.upper()), self, activated=self._on_next)
        QShortcut(QKeySequence(self.runtime_config.keyboard_shortcut_reveal.upper()), self, activated=self._on_reveal)
        QShortcut(QKeySequence(self.runtime_config.keyboard_shortcut_pass.upper()), self, activated=self._on_pass)
        QShortcut(QKeySequence(self.runtime_config.keyboard_shortcut_fail.upper()), self, activated=self._on_fail)

    def _restore_session_if_present(self) -> None:
        snapshot = load_session_snapshot(SESSION_FILE)
        self.session.restore_active_review(snapshot)

    def _ensure_active_or_wait(self) -> None:
        if self.session.active_review is None:
            self.session.start_next_review()

    def _tick(self) -> None:
        active = self.session.active_review
        if active is not None:
            timeout_event = self.session.check_timeout()
            if timeout_event is not None and timeout_event.result == ReviewResult.TIMEOUT:
                self._last_timeout_answers = list(active.answers)
                self.answer_input.clear()

        self._attempt_auto_start_next_due()
        self._refresh_all()

    def _attempt_auto_start_next_due(self) -> None:
        if not self.auto_start_enabled or self.session.active_review is not None:
            return

        item = self.session.start_next_review()
        if item is not None:
            self.answer_input.clear()

    def _refresh_all(self) -> None:
        self._refresh_review_view()
        self._refresh_summary()

    def _refresh_review_view(self) -> None:
        active = self.session.active_review

        if active is None:
            self.term_label.setText("No active review")
            self.timer_label.setText("Timer: -")
            self.answers_label.setText(", ".join(self._last_timeout_answers) if self._last_timeout_answers else "Answers hidden")

            seconds_until = self.engine.seconds_until_next_due()
            if seconds_until is None:
                self.status_label.setText("Status: No pairs available")
                self.wait_label.setText("Deck appears empty or unavailable.")
            elif seconds_until > 0:
                self.status_label.setText("Status: Waiting for next due pair")
                self.wait_label.setText(f"Next pair due in {seconds_until:.1f}s. Press Next to check again.")
            else:
                self.status_label.setText("Status: Pair due now")
                self.wait_label.setText("A pair is due. Press Next to start.")

            self.next_btn.setEnabled(True)
            self.reveal_btn.setEnabled(False)
            self.pass_btn.setEnabled(False)
            self.fail_btn.setEnabled(False)
            self.add_answer_btn.setEnabled(False)
            return

        self.term_label.setText(active.term)
        remaining = self.session.time_remaining()
        timer_text = f"{remaining:.1f}s" if remaining is not None else "-"
        self.timer_label.setText(f"Timer: {timer_text}")
        self.status_label.setText("Status: Revealed" if active.revealed else "Status: Recall in progress")
        self.answers_label.setText(", ".join(active.answers) if active.revealed else "Answers hidden")
        self.wait_label.setText("")

        self.next_btn.setEnabled(False)
        self.reveal_btn.setEnabled(not active.revealed)
        self.pass_btn.setEnabled(active.revealed)
        self.fail_btn.setEnabled(active.revealed)
        self.add_answer_btn.setEnabled(True)

    def _refresh_summary(self) -> None:
        stats = self.session.get_session_stats()
        self.total_value.setText(str(stats.total))
        self.passed_value.setText(str(stats.passed))
        self.failed_value.setText(str(stats.failed))
        self.timeout_value.setText(str(stats.timed_out))
        self.responses_value.setText(str(stats.responses))
        self.pass_rate_value.setText(f"{stats.pass_rate * 100:.1f}%")

    def _on_next(self) -> None:
        if self.session.active_review is not None:
            return

        item = self.session.start_next_review()
        if item is None:
            self.status_label.setText("Status: No due pairs yet")
        self.answer_input.clear()
        self._refresh_all()

    def _on_reveal(self) -> None:
        try:
            answers = self.session.reveal_answers()
            self.answers_label.setText(", ".join(answers) if answers else "No accepted answers")
        except ValueError as exc:
            self.status_label.setText(f"Status: {exc}")
        self._refresh_all()

    def _on_pass(self) -> None:
        self._grade(is_pass=True)

    def _on_fail(self) -> None:
        self._grade(is_pass=False)

    def _grade(self, is_pass: bool) -> None:
        answer_text = self.answer_input.text().strip() or None
        try:
            if is_pass:
                self.session.grade_pass(user_answer=answer_text)
            else:
                self.session.grade_fail(user_answer=answer_text)
            self.answer_input.clear()
            self._last_timeout_answers = []
            self._attempt_auto_start_next_due()
        except ValueError as exc:
            self.status_label.setText(f"Status: {exc}")

        self._refresh_all()

    def _on_add_answer(self) -> None:
        active = self.session.active_review
        if active is None:
            return

        new_answer = self.answer_input.text().strip()
        if not new_answer:
            QMessageBox.information(self, "Add Answer", "Type an answer first.")
            return

        added = self.deck.add_answer_to_pair(active.pair_id, new_answer)
        if not added:
            QMessageBox.information(self, "Add Answer", "Answer already exists for this pair.")
            return

        if new_answer not in active.answers:
            active.answers.append(new_answer)
            save_session_snapshot(self.session.active_review_snapshot(), SESSION_FILE)

        save_deck(self.deck, DECK_FILE)
        self.status_label.setText("Status: Added new accepted answer")
        if active.revealed:
            self.answers_label.setText(", ".join(active.answers) if active.answers else "No accepted answers")

    def _on_apply_settings(self) -> None:
        timeout_seconds = int(self.timeout_spin.value())
        pass_multiplier = float(self.pass_multiplier_spin.value())
        fail_reset = int(self.fail_reset_spin.value())

        self.runtime_config.timeout_seconds = timeout_seconds
        self.runtime_config.pass_interval_multiplier = pass_multiplier
        self.runtime_config.fail_interval_reset = fail_reset
        self.auto_start_enabled = self.auto_start_check.isChecked()

        if self.session.active_review is not None:
            self.settings_status_label.setText(
                "Applied. New timeout applies to next review. "
                f"Mode: {'auto-start' if self.auto_start_enabled else 'manual next'}."
            )
        else:
            self.settings_status_label.setText(
                f"Applied to current session. Mode: {'auto-start' if self.auto_start_enabled else 'manual next'}."
            )


def run_app() -> int:
    """Run the Qt event loop for the desktop app."""
    if QApplication is None:
        raise RuntimeError("PySide6 is not installed. Run: source lp-venv/bin/activate && python3 -m pip install PySide6")

    app = QApplication.instance() or QApplication(sys.argv)
    window = SRSAppWindow()
    window.show()
    return app.exec()


__all__ = ["SRSAppWindow", "run_app"]
