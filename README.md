# Letter Pair SRS – Local Desktop App

A lightweight spaced repetition system for memorizing letter pairs. Self-grade reveals, auto-fail on timeout, and local JSON persistence. Designed for blindfolded speedcubing.

## Quick Start

```bash
source lp-venv/bin/activate
python main.py
```

## Project Structure

- `config.py` – Configuration defaults (timeout, intervals, etc.)
- `schemas.py` – Data structures (DeckItem, PairState, ReviewEvent, etc.)
- `persistence.py` – JSON load/save for deck, pair state, and review history
- `engine.py` – Review engine (due selection, scheduling)
- `timer.py` – Session timer and timeout management
- `ui.py` – Tkinter UI views
- `main.py` – App entry point
- `tests/` – Unit tests
- `data/` – Letter pair deck, scheduling state, and review history files

## Architecture

1. **Review Engine** (engine.py) – Pair scheduling logic
2. **Persistence** (persistence.py) – JSON storage and recovery
3. **Timer/Session** (timer.py) – Countdown and timeout handling
4. **UI** (ui.py) – Tkinter display layer (thin wrapper over engine)

## Workflow

1. App loads deck and pair state from JSON
2. Selects earliest-due pair
3. Shows letter pair, starts timer
4. On timeout: auto-fail, reveal memorized answers, record event
5. On manual reveal: user self-grades pass/fail based on their answer, record event
6. Track frequency of given answers for visualization
7. Persist state and history after each review
8. Show session summary

## Features

- **Answer Tracking**: Tracks frequency of each answer you provide
- **Dynamic Deck Updates**: Add new acceptable answers as you discover them
- **Spaced Repetition**: Simple pass/fail scheduling with configurable intervals
- **Auto-Timeout**: Automatically fails cards if you don't respond in time
- **Local Storage**: Everything stays on your computer; no cloud or sync
