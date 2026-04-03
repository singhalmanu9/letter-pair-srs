"""
Persistence layer for loading/saving deck, state, and history.
"""

import json
from pathlib import Path
from typing import List, Optional
import logging

from schemas import Deck, SRSState, ReviewEvent, validate_deck, validate_state
from config import DECK_FILE, STATE_FILE, HISTORY_FILE

logger = logging.getLogger(__name__)


def load_deck(path: Path = DECK_FILE) -> Deck:
    """Load deck from JSON file. Initialize empty if not found."""
    if not path.exists():
        logger.info(f"Deck file not found at {path}, creating empty deck")
        deck = Deck(items=[])
        save_deck(deck, path)
        return deck

    try:
        with open(path, "r") as f:
            data = json.load(f)
        deck = Deck.from_dict(data)
        validate_deck(deck)
        logger.info(f"Loaded deck with {len(deck.items)} items from {path}")
        return deck
    except Exception as e:
        logger.error(f"Failed to load deck from {path}: {e}")
        raise


def save_deck(deck: Deck, path: Path = DECK_FILE) -> None:
    """Save deck to JSON file."""
    validate_deck(deck)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(path, "w") as f:
            json.dump(deck.to_dict(), f, indent=2)
        logger.info(f"Saved deck with {len(deck.items)} items to {path}")
    except Exception as e:
        logger.error(f"Failed to save deck to {path}: {e}")
        raise


def load_state(deck: Deck, path: Path = STATE_FILE) -> SRSState:
    """Load state from JSON file. Initialize with deck defaults if not found."""
    if not path.exists():
        logger.info(f"State file not found at {path}, initializing for deck")
        state = initialize_state_for_deck(deck)
        save_state(state, path)
        return state

    try:
        with open(path, "r") as f:
            data = json.load(f)
        state = SRSState.from_dict(data)
        validate_state(deck, state)
        logger.info(f"Loaded state with {len(state.pairs)} pairs from {path}")
        return state
    except Exception as e:
        logger.error(f"Failed to load state from {path}: {e}")
        raise


def save_state(state: SRSState, path: Path = STATE_FILE) -> None:
    """Save state to JSON file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(path, "w") as f:
            json.dump(state.to_dict(), f, indent=2)
        logger.debug(f"Saved state with {len(state.pairs)} pairs to {path}")
    except Exception as e:
        logger.error(f"Failed to save state to {path}: {e}")
        raise


def append_review_event(event: ReviewEvent, path: Path = HISTORY_FILE) -> None:
    """Append review event to history file (JSONL format)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(path, "a") as f:
            f.write(json.dumps(event.to_dict()) + "\n")
        logger.debug(f"Appended review event for {event.pair_id} to {path}")
    except Exception as e:
        logger.error(f"Failed to append event to history {path}: {e}")
        raise


def load_history(path: Path = HISTORY_FILE) -> List[ReviewEvent]:
    """Load all review events from history file (JSONL format)."""
    if not path.exists():
        logger.info(f"History file not found at {path}")
        return []

    events = []
    try:
        with open(path, "r") as f:
            for line in f:
                if line.strip():
                    data = json.loads(line)
                    event = ReviewEvent.from_dict(data)
                    events.append(event)
        logger.info(f"Loaded {len(events)} review events from {path}")
        return events
    except Exception as e:
        logger.error(f"Failed to load history from {path}: {e}")
        raise


def initialize_state_for_deck(deck: Deck, initial_interval: int = 60) -> SRSState:
    """Initialize state with all deck items due immediately."""
    from time import time
    from schemas import PairState

    pairs = []
    for item in deck.items:
        pair = PairState(
            pair_id=item.id,
            next_due=time(),  # Due immediately
            current_interval=initial_interval,
        )
        pairs.append(pair)

    return SRSState(pairs=pairs)
