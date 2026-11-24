# BLD Letter Pairs SRS

Spaced repetition for blindfolded cubing letter pairs, like WaniKani for your memo images. Mobile-first, installable, works offline, and everything is stored locally in your browser.

Live at https://singhalmanu9.github.io/letter-pair-srs/

## How it works

1. **Set up your letters:** your memo orientation, the letter on every sticker (Speffz by default, editable on a cube net), and your buffers. The app generates every letter pair that can come up in memo.
2. **Fill in the images you already have.** Pairs without one still come up in reviews, and you come up with an image on the spot.
3. **Review:** recall your image, reveal, then tap the answer you thought of. "Something else" saves a new answer without moving the pair up a level. Running out of time counts as a fail.

## How reviews are scheduled

Scheduling uses WaniKani's fixed intervals as Levels 1-9. A pass moves a pair
up one level; a fail or timeout drops it one level (two from Level 5 up), never
below Level 1. New pairs that are failed stay New and come back in the same session.

| Level | Next review after |
|---|---|
| New | due immediately |
| 1 / 2 / 3 / 4 | 4 hours / 8 hours / 1 day / 2 days |
| 5 / 6 | 1 week / 2 weeks |
| 7 | 1 month |
| 8 | 4 months |
| 9 | never reviewed again (burned) |

Recall time is either fixed (10 seconds by default) or shorter at higher levels.

## Data storage

Everything is stored in the browser's `localStorage`, per device. It survives
refreshes, restarts and clearing the browser cache, but not clearing site data,
so export a backup from Settings now and then. Stored data is versioned, and
unreadable data is reported rather than overwritten.

## Future improvements

- **Pieces card:** show the pieces themselves (in your orientation) instead of letters, to train translating pieces to letters as well as letters to images.
- **Stats page:** including how your images for each pair change over time.
- Separate pair lists for corners and edges.
- Final app icon (the current one is a placeholder).

## Development

Requires Node 18+.

```bash
npm install
npm run dev        # local dev server
npm test           # run the test suite
npm run build      # type-check and build to dist/
```

Pushing to `main` deploys to GitHub Pages.

## Project structure

- `src/lib/`: app logic, no UI
  - `config.ts`: settings and defaults (recall time, SRS levels)
  - `srs.ts`: level transition rules
  - `engine.ts`, `session.ts`, `timer.ts`: picking due pairs, the review flow, the countdown
  - `cube.ts`, `scheme.ts`: cube model, letter schemes, orientation, pair generation
  - `schemas.ts`, `progress.ts`: data types, validation, syncing progress with the deck
  - `storage.ts`, `repository.ts`: versioned storage on top of `localStorage`
  - `backup.ts`: export, import, and updating a deck from a file
- `src/app/`: startup and browser file helpers
- `src/ui/`: Preact screens (review, home, deck, settings, onboarding)
- `tests/`: Vitest unit tests
