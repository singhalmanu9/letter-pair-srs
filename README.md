# Letter Pair SRS

A lightweight spaced repetition system for memorizing letter pairs, built for blindfolded speedcubing. Self-graded reveals, auto-fail on timeout, and everything stored locally in your browser.

Being ported from a Python desktop app to a static web app hosted on GitHub Pages.

## Development

Requires Node 18+.

```bash
npm install
npm run dev        # local dev server
npm test           # run the test suite
npm run build      # type-check and build to dist/
```

## Project structure

- `src/lib/config.ts`: SRS settings and defaults (timeout, intervals, shortcuts)
- `src/lib/schemas.ts`: data types (deck items, pair state, review events) and validation
- `src/lib/engine.ts`: picking the next due pair and scheduling
- `src/lib/session.ts`: review flow: start, reveal, grade, timeout, recovery
- `src/lib/timer.ts`: per-review countdown
- `src/lib/persistence.ts`: storage via a key-value interface (`localStorage` in the browser)
- `src/data/deck.json`: sample deck
- `src/main.ts`: app entry point
- `tests/`: Vitest unit tests

## How a review works

1. The earliest-due pair is shown and the countdown starts.
2. On reveal, you self-grade pass or fail. On timeout, it auto-fails.
3. Pass multiplies the pair's interval; fail or timeout resets it.
4. State and history are saved after every review.
