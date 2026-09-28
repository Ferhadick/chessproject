// offscreen.js — Runs Stockfish in an isolated Web Worker within extension context

let stockfish = null;
let isReady = false;
let readyResolvers = [];
let currentAnalysisReject = null;

function initStockfish() {
  if (stockfish) {
    if (isReady) return Promise.resolve();
    return new Promise((resolve) => readyResolvers.push(resolve));
  }

  return new Promise((resolve, reject) => {
    readyResolvers.push(resolve);
    try {
      stockfish = new Worker('stockfish.js');

      stockfish.onmessage = (e) => {
        const line = typeof e.data === 'string' ? e.data.trim() : '';

        if (line === 'uciok') {
          stockfish.postMessage('isready');
        } else if (line === 'readyok') {
          isReady = true;
          while (readyResolvers.length > 0) {
            const r = readyResolvers.shift();
            r();
          }
        }
      };

      stockfish.onerror = (err) => {
        console.error('[ChessMind Offscreen] Worker error:', err);
        reject(err);
      };

      stockfish.postMessage('uci');
    } catch (err) {
      console.error('[ChessMind Offscreen] Failed to create worker:', err);
      reject(err);
    }
  });
}

function evaluatePosition(fen, depth, multiPV = 1) {
  return new Promise((resolve, reject) => {
    if (currentAnalysisReject) {
      currentAnalysisReject(new Error('Cancelled by new position'));
      currentAnalysisReject = null;
    }
    currentAnalysisReject = reject;

    // pvEntries: array of { move, score } indexed by multipv rank
    const pvEntries = [];
    let bestMove = null;

    const messageHandler = (e) => {
      const line = typeof e.data === 'string' ? e.data.trim() : '';

      // Extract moves AND scores from multipv info lines
      if (line.includes('multipv') && line.includes(' pv ')) {
        const pvIdx = line.match(/multipv\s+(\d+)/);
        const pvMove = line.match(/\bpv\s+(\S+)/);
        // Score: can be "score cp <n>" or "score mate <n>"
        const cpMatch = line.match(/score cp (-?\d+)/);
        const mateMatch = line.match(/score mate (-?\d+)/);

        if (pvIdx && pvMove) {
          const index = parseInt(pvIdx[1], 10) - 1;
          let score = null;
          if (cpMatch) {
            score = parseInt(cpMatch[1], 10);
          } else if (mateMatch) {
            // Treat mate as a very large cp value
            score = parseInt(mateMatch[1], 10) > 0 ? 30000 : -30000;
          }
          pvEntries[index] = { move: pvMove[1], score };
        }
      }

      if (line.startsWith('bestmove')) {
        stockfish.removeEventListener('message', messageHandler);
        currentAnalysisReject = null;

        const parts = line.split(/\s+/);
        bestMove = parts[1] && parts[1] !== '(none)' ? parts[1] : null;

        const pvMoves = pvEntries.map(e => e ? e.move : null).filter(Boolean);

        if (multiPV > 1 && pvEntries.length > 0) {
          resolve({ bestMove, pvMoves, pvEntries });
        } else {
          resolve({ bestMove, pvMoves: bestMove ? [bestMove] : [], pvEntries: [] });
        }
      }
    };

    stockfish.addEventListener('message', messageHandler);

    stockfish.postMessage('stop');
    stockfish.postMessage(`setoption name MultiPV value ${multiPV}`);
    stockfish.postMessage(`position fen ${fen}`);
    stockfish.postMessage(`go depth ${depth}`);
  });
}

/**
 * Humanization levels → realistic cp-loss profiles
 *
 * Level 0 – Engine pure:  always best move
 * Level 1 – Subtle:       ~1400-1600 elo feel, occasional inaccuracies (20-50 cp loss)
 * Level 2 – Human-like:  ~1100-1300 elo feel, frequent inaccuracies, rare mistakes (50-150 cp)
 * Level 3 – Casual:      ~700-1000 elo feel, blunders allowed (100-300 cp loss)
 * Level 4 – Expert:      ~2200-2400 elo feel, near-perfect with tiny natural drift (5-20 cp loss)
 */
const HUMANIZE_PROFILES = [
  // level 0 – pure engine
  null,
  // level 1 – Subtle (~1500 elo)
  { blunderProb: 0.00, mistakeProb: 0.04, inaccuracyProb: 0.18, targetCpLoss: [15, 40],  maxCpLoss: 60  },
  // level 2 – Human-like (~1200 elo)
  { blunderProb: 0.03, mistakeProb: 0.10, inaccuracyProb: 0.30, targetCpLoss: [40, 120], maxCpLoss: 200 },
  // level 3 – Casual (~900 elo)
  { blunderProb: 0.09, mistakeProb: 0.18, inaccuracyProb: 0.35, targetCpLoss: [80, 250], maxCpLoss: 400 },
  // level 4 – Expert (~2300 elo)
  { blunderProb: 0.00, mistakeProb: 0.01, inaccuracyProb: 0.06, targetCpLoss: [5, 20],   maxCpLoss: 35  },
];

function pickHumanMove(pvEntries, profile) {
  if (!pvEntries || pvEntries.length === 0) return null;

  const bestScore = pvEntries[0]?.score;
  if (bestScore === null || bestScore === undefined) return pvEntries[0]?.move ?? null;

  const roll = Math.random();
  let cpLossTarget;

  if (roll < profile.blunderProb) {
    // Blunder: 200–400+ cp loss
    cpLossTarget = 200 + Math.random() * 250;
  } else if (roll < profile.blunderProb + profile.mistakeProb) {
    // Mistake: 100–200 cp loss
    cpLossTarget = 100 + Math.random() * 100;
  } else if (roll < profile.blunderProb + profile.mistakeProb + profile.inaccuracyProb) {
    // Inaccuracy: targetCpLoss range
    const [lo, hi] = profile.targetCpLoss;
    cpLossTarget = lo + Math.random() * (hi - lo);
  } else {
    // Best move
    return pvEntries[0].move;
  }

  // Find the candidate move whose cp loss is closest to cpLossTarget
  // (but don't exceed maxCpLoss too aggressively — cap it)
  const effectiveLoss = Math.min(cpLossTarget, profile.maxCpLoss);

  let bestCandidate = pvEntries[0].move;
  let bestDiff = Infinity;

  for (const entry of pvEntries) {
    if (!entry || entry.score === null || entry.score === undefined) continue;
    const cpLoss = bestScore - entry.score;
    if (cpLoss < 0) continue; // skip moves scored better (shouldn't happen in ordered MultiPV)
    const diff = Math.abs(cpLoss - effectiveLoss);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestCandidate = entry.move;
    }
  }

  return bestCandidate;
}

async function computeHumanizedMove(fen, depth = 15, level = 2) {
  await initStockfish();

  const levelLabels = ['Pure engine', 'Subtle', 'Human-like', 'Casual'];
  const label = levelLabels[level] || 'Human-like';

  // Level 0: Pure best move — no humanization
  if (level === 0) {
    const res = await evaluatePosition(fen, depth, 1);
    return { move: res.bestMove, meta: label };
  }

  const profile = HUMANIZE_PROFILES[level];
  if (!profile) {
    const res = await evaluatePosition(fen, depth, 1);
    return { move: res.bestMove, meta: label };
  }

  // Use MultiPV 10 so we have plenty of candidate moves to choose from.
  // Slightly reduce depth for speed (the humanizer doesn't need perfect eval).
  const searchDepth = Math.max(8, depth - 3);
  const res = await evaluatePosition(fen, searchDepth, 10);

  if (!res.pvEntries || res.pvEntries.length === 0) {
    return { move: res.bestMove, meta: label };
  }

  const chosenMove = pickHumanMove(res.pvEntries, profile);
  return { move: chosenMove || res.bestMove, meta: label };
}

// Listen for messages from background.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'RUN_STOCKFISH') {
    computeHumanizedMove(message.fen, message.depth, message.humanizationLevel)
      .then((result) => {
        sendResponse({ success: true, move: result.move, meta: result.meta });
      })
      .catch((err) => {
        console.error('[ChessMind Offscreen] Analysis error:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep channel open for async response
  }
});

// Pre-initialize engine on document load
initStockfish().catch((err) => console.error('[ChessMind Offscreen] Pre-init error:', err));
