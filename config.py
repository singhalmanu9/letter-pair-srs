"""
Configuration and defaults for the SRS application.
"""

from dataclasses import dataclass
from pathlib import Path

# App data directory
APP_DATA_DIR = Path(__file__).parent / "data"
APP_DATA_DIR.mkdir(exist_ok=True)

# File paths
DECK_FILE = APP_DATA_DIR / "deck.json"
STATE_FILE = APP_DATA_DIR / "state.json"
HISTORY_FILE = APP_DATA_DIR / "history.jsonl"


@dataclass
class SRSConfig:
    """Configurable SRS parameters."""

    # Timer settings (in seconds)
    timeout_seconds: int = 30

    # Interval settings (in seconds; will grow based on passes)
    initial_interval: int = 60  # 1 minute
    pass_interval_multiplier: float = 1.5  # 1.5x growth on pass
    fail_interval_reset: int = 60  # 1 minute retry on fail

    # UI/UX settings
    keyboard_shortcut_reveal: str = "r"  # Press 'r' to reveal
    keyboard_shortcut_pass: str = "p"  # Press 'p' for pass
    keyboard_shortcut_fail: str = "f"  # Press 'f' for fail
    keyboard_shortcut_next: str = "n"  # Press 'n' for next


# Global config instance
CONFIG = SRSConfig()
