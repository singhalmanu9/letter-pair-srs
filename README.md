# Letter Pair SRS

A lightweight spaced repetition system for memorizing letter pairs, built for blindfolded speedcubing. Self-graded reveals, auto-fail on timeout, and everything stored locally in your browser.

Ported from a Python desktop app to a static web app for GitHub Pages; the review UI is still to come.

## Development

Requires Node 18+.

```bash
npm install
npm run dev        # local dev server
npm test           # run the test suite
npm run build      # type-check and build to dist/
```

## Project structure

- `src/lib/config.ts`: settings and defaults (timeout, SRS stages, shortcuts)
- `src/lib/srs.ts`: stage transition rules
- `src/lib/schemas.ts`: data types, parsing/validation of stored data, deck helpers
- `src/lib/progress.ts`: creating pair progress and syncing it with the deck
- `src/lib/engine.ts`: picking the next due pair and applying review results
- `src/lib/session.ts`: review flow: start, reveal, grade, timeout, resume
- `src/lib/timer.ts`: per-review countdown
- `src/lib/storage.ts`: async key-value storage (`localStorage`, in-memory fallback)
- `src/lib/repository.ts`: typed, versioned storage of decks, progress, history
- `src/lib/templates.ts`: creating user decks from templates
- `src/app/bootstrap.ts`: app startup and wiring the session to storage
- `src/data/templates/`: bundled starter decks
- `src/main.ts`: app entry point (placeholder UI for now)
- `tests/`: Vitest unit tests

## How reviews are scheduled

Scheduling uses WaniKani's fixed stages. A pass moves a pair up one stage; a
fail or timeout drops it one stage (two from Guru up), never below Apprentice 1.

| Stage | Next review after |
|---|---|
| New | due immediately |
| Apprentice 1 / 2 / 3 / 4 | 4 hours / 8 hours / 1 day / 2 days |
| Guru 1 / 2 | 1 week / 2 weeks |
| Master | 1 month |
| Enlightened | 4 months |
| Burned | never reviewed again |

## Data storage

Everything is stored in the browser's `localStorage`, per device. It survives
refreshes, restarts and clearing the browser cache, but not clearing site data.
Decks start as copies of a template and are then fully the user's own.
Stored data is versioned, and unreadable data is reported rather than overwritten.
