# ♟ ChessMind — Humanized Move Advisor

A Chrome extension that runs Stockfish locally and suggests moves with **human-like accuracy** — tuned to your actual ELO so suggestions never look engine-perfect.

---

## Features

- 🤖 **Stockfish engine** runs entirely in-browser (no server, no API key)
- 🎭 **Centipawn-loss humanizer** — picks moves that match realistic human error rates, not just "2nd best move"
- 🎚️ **5 humanization levels** from Engine Pure → Casual → Expert ~2300
- 🟩 **Board highlighting** — marks the suggested move square on chess.com
- ⚡ Configurable analysis depth (10–20)

---

## Humanization Levels

| Level | Profile | Blunder | Mistake | Inaccuracy | Feel |
|-------|---------|---------|---------|------------|------|
| 0 | Engine pure | — | — | — | 3200+ |
| 1 | Subtle | 0% | 4% | 18% | ~1500 ELO |
| 2 | Human-like | 3% | 10% | 30% | ~1200 ELO |
| 3 | Casual | 9% | 18% | 35% | ~900 ELO |
| 4 | Expert ~2300 | 0% | 1% | 6% | ~2300 ELO |

The humanizer fetches **MultiPV 10** with centipawn scores and picks the candidate move whose cp-loss is closest to the target for that level — so it actually plays like a human, not just a slightly worse engine.

---

## Installation

> Chrome Web Store listing coming soon. For now, load it manually:

1. Clone or download this repo
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the repo folder
5. Navigate to [chess.com](https://chess.com) and open the extension popup

---

## Usage

1. Toggle **Advisor active** on
2. Set your desired **humanization level** on the slider
3. Set **analysis depth** (18–20 recommended for strong play)
4. The suggested move appears in the popup and is highlighted on the board

---

## Tech Stack

- Chrome Extension Manifest V3
- [Stockfish.js](https://github.com/nmrugg/stockfish.js) — WebAssembly chess engine
- Offscreen Document API for running the engine in a dedicated Worker
- Vanilla JS — no build step, no dependencies

---

## Files

```
chess extension/
├── manifest.json       # Extension config (MV3)
├── background.js       # Service worker — routes messages, manages offscreen doc
├── content.js          # Injected into chess.com — reads board, highlights moves
├── offscreen.js        # Runs Stockfish Worker, humanizer logic
├── offscreen.html      # Host page for the offscreen document
├── popup.html          # Extension popup UI
├── popup.js            # Popup logic
└── stockfish.js        # Stockfish WebAssembly engine
```

---

## License

MIT
