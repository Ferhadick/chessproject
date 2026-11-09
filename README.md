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
| 0 | Engine pure | — | — | — | Uncapped (no fixed Elo) |
| 1 | Subtle | 0% | 4% | 18% | ~1500 ELO |
| 2 | Human-like | 3% | 10% | 30% | ~1200 ELO |
| 3 | Casual | 9% | 18% | 35% | ~900 ELO |
| 4 | Expert ~2300 | 0% | 1% | 6% | ~2300 ELO |

The Elo labels are rough profile estimates, not calibrated ratings. Pure engine has no fixed Elo; achieved strength depends on the engine, position, hardware, depth, and search time.

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
2. Choose a **move style** in the popup or on-board panel
3. Set **analysis depth** (18–20 recommended for strong play)
4. The suggested move appears in the popup and is highlighted on the board
5. Use **Refresh** to request a new suggestion for the current position. If you hide the on-board panel, use **Show panel** in the popup to reopen it.

The panel's color badge lets you override automatic player-color detection. The popup reports when the board is incomplete, the side to move cannot be determined, or the engine fails. If the extension first sees a game mid-position, castling and en-passant history is unknown, so it omits those rights rather than inventing legal moves.

## Time control presets

Choose Bullet, Blitz, or Rapid in the popup to apply settings together:

| Preset | Depth cap | Search time limit | Board response delay | Random move pause |
|--------|-----------|-------------------|----------------------|-------------------|
| Bullet | 12 | 0.25s | 80ms | 0.15–0.6s |
| Blitz | 18 | 1s | 150ms | 0.5–1.8s |
| Rapid | 20 | 3s | 250ms | 1.5–5s |

The engine stops at the depth or time limit, whichever comes first. These are starting points, not measured strength guarantees; engine startup and board response time are additional. Engine level is independent: presets preserve your chosen strength, and changing strength keeps the selected preset and its limits. Editing depth or search time switches to Custom and preserves your other settings. Existing installations keep their settings until a preset is selected.

The **Auto-play move delay** fields let you override the minimum and maximum pause in seconds, independently of depth, search time, and engine level. With **Position-aware pauses** enabled (the default), clear engine choices use the lower third of the range and close alternatives, promotions, and king-and-pawn endings use its upper portion. Other positions use the full range. Disable it to sample uniformly from the full range. These are heuristic difficulty estimates, not measured human thinking times. Both values can be zero to disable the pause. The pause is additional to engine search and board response time; it does not read or manage the game clock. Selecting a preset restores its default range. Pending pauses cancel on Stop or a position change, and research logs include the sampled and actual pause duration separately from analysis time.

## Conditional premoves

Enable **Conditional premoves** in the popup to prepare occasional recaptures while the opponent is thinking. This is off by default. The engine must identify a capture with a principal variation containing a recapture on that same square, at depth 8 or deeper, with at least a 150-centipawn gap to another evaluated opponent move. Special moves and mate-score predictions are excluded.

The prepared reply is used only when the exact expected FEN appears within 10 seconds and the engine/timing settings are unchanged. A different position, manual interaction, Stop, navigation or settings changes discard it. It skips the added random pause and new search, but retains board settling, click handling and move confirmation. This is a **conditional prepared reply**, not a native move queued on Chess.com's board. It uses the best engine continuation, including when a weaker engine level or quality target is selected. If preparation is unavailable or late, normal analysis runs instead. No opponent move is guaranteed or predicted with certainty.

Research logs include the timing category and reason, and mark used prepared replies with their predicted opponent move. The preparation logic, stale-position rejection and timing bounds have automated coverage; the complete conditional-reply flow has not been verified on a live game.

## Estimated move-quality target

Enable **Move-quality target** in the popup to use a configurable range (default 75–89). It overrides engine-level move selection while enabled; depth, time limits, and presets remain independent. It is off by default.

This is a custom index, **not Chess.com accuracy or a target for the final game score**: `quality = 100 × exp(−centipawnLoss / 200)`. Each position samples a desired index in the range and selects a suitable MultiPV candidate. It rejects losses above 80 centipawns, alternatives that turn a nonnegative evaluation negative, alternatives that drop a clear lead below +1 pawn, and weaker moves in already bad positions. Forced mates and missing suitable candidates use the engine best move even if quality exceeds the range. These safeguards use the current search evaluation; they cannot guarantee wins or prevent final accuracy above 90. Research move logs include the selected move's estimated quality, centipawn loss, and selection reason.

## Player advantage bars

With the advisor enabled, **Player advantage bars** show an engine evaluation beside the top and bottom player names, or beside their board rows when name elements cannot be found. Both turns are analyzed. “Ahead +1.5” means roughly a 1.5-pawn advantage; the other player sees “Behind −1.5”. Forced mates show mate distance. Bar length is an advantage scale, not a win probability. Scores reflect the best engine line, independently of which humanized move is suggested, and depend on search depth and time. Old scores clear when the pieces change. Disable the bars in the popup if desired.

## Auto-play

Start or continue a game, enable the advisor, then turn **Auto-play** on in the popup or board panel. It uses your current engine level, depth, and time budget. No per-bot configuration is required.

Turn the toggle off, press **Esc** on the page, or interact with the page outside the ChessMind panel to stop. Auto-play also stops when you hide the tab, pause the advisor, navigate away, replace the board, reach a detected game result, encounter an engine error, or cannot confirm a move. It starts off after a reload and does not start another game automatically. It is available on supported Chess.com boards under `/play`, `/game`, and `/chess`; there is no bot-only restriction.

Moves use the board's click-to-move controls, with promotion selection when a promotion menu is available. The extension confirms the resulting piece placement and never automatically retries a failed move. Leave the board visible and uncovered. If the site's auto-queen setting prevents an underpromotion, auto-play stops rather than continuing with the wrong piece.

**Export research logs** in the popup saves all recorded runs as JSON. Logs stay in local extension storage and include starting positions, settings, submitted moves, confirmed positions, analysis times, stop reasons, and detected outcome text. No logs are sent to a server. If saving fails, auto-play stops. Runs remain available across reloads; browser extension storage limits still apply.

After reloading or updating the extension, refresh any open game pages too. If the old page script detects an invalidated extension context, it stops analysis and auto-play and displays a refresh message.

The regular move loop and Escape stop were verified on an active Chess.com bot game. Promotion handling and failure paths have automated coverage; promotion and game-end DOM detection still need live verification against the site's current UI.

## Checks

Run `node --test tests/*.test.js` to check position reconstruction and engine request cancellation.

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
