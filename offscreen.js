// offscreen.js — Runs Stockfish in an isolated Web Worker within extension context

let stockfish = null;
let isReady = false;
let readyResolvers = [];
let searchQueue = Promise.resolve();
let latestRequest = 0;
let activeSearchFailure = null;
let readyTimer = null;

function failWorker(error) {
  clearTimeout(readyTimer);
  stockfish?.terminate();
  stockfish = null;
  isReady = false;
  for (const waiter of readyResolvers.splice(0)) waiter.reject(error);
  activeSearchFailure?.(error);
}

function initStockfish() {
  if (stockfish) {
    if (isReady) return Promise.resolve();
    return new Promise((resolve, reject) => readyResolvers.push({ resolve, reject }));
  }

  return new Promise((resolve, reject) => {
    readyResolvers.push({ resolve, reject });
    try {
      stockfish = new Worker('stockfish.js');
      readyTimer = setTimeout(() => failWorker(new Error('Engine failed to start')), 15000);

      stockfish.onmessage = (e) => {
        const line = typeof e.data === 'string' ? e.data.trim() : '';

        if (line === 'uciok') {
          stockfish.postMessage('isready');
        } else if (line === 'readyok') {
          clearTimeout(readyTimer);
          isReady = true;
          while (readyResolvers.length > 0) {
            readyResolvers.shift().resolve();
          }
        }
      };

      stockfish.onerror = (err) => {
        console.error('[ChessMind Offscreen] Worker error:', err);
        failWorker(new Error('Engine worker failed'));
      };

      stockfish.postMessage('uci');
    } catch (err) {
      console.error('[ChessMind Offscreen] Failed to create worker:', err);
      failWorker(err);
    }
  });
}

function whiteEvaluation(type, value, turn, depth) {
  if (type === 'mate') {
    const winningColor = value > 0 ? turn : (turn === 'w' ? 'b' : 'w');
    return { type, value: Math.abs(value), winningColor, depth };
  }
  return { type: 'cp', value: turn === 'b' ? -value : value, depth };
}

function evaluatePosition(fen, depth, multiPV = 1, timeBudgetMs = 0) {
  return new Promise((resolve, reject) => {
    // Keep scores from the same depth together. A stopped search can end halfway
    // through its final MultiPV pass, leaving ranks from different depths.
    const pvByDepth = new Map();
    let bestMove = null;
    let evaluation = null;
    let evaluationDepth = -1;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stockfish?.removeEventListener('message', messageHandler);
      activeSearchFailure = null;
      if (error) reject(error);
      else resolve(result);
    };
    const timeout = setTimeout(() => {
      failWorker(new Error('Engine timed out'));
    }, 30000);

    const messageHandler = (e) => {
      const line = typeof e.data === 'string' ? e.data.trim() : '';

      const rank = line.match(/\bmultipv\s+(\d+)/);
      const score = line.match(/\bscore\s+(cp|mate)\s+(-?\d+)/);
      const infoDepth = line.match(/\bdepth\s+(\d+)/);
      if (line.startsWith('info ') && score && infoDepth && (!rank || rank[1] === '1') &&
          !/\b(?:lowerbound|upperbound)\b/.test(line) && Number(infoDepth[1]) >= evaluationDepth) {
        evaluationDepth = Number(infoDepth[1]);
        evaluation = whiteEvaluation(score[1], Number(score[2]), fen.split(' ')[1], evaluationDepth);
      }

      // Extract moves AND scores from multipv info lines
      if (line.includes('multipv') && line.includes(' pv ') && !/\b(?:lowerbound|upperbound)\b/.test(line)) {
        const depthMatch = line.match(/\bdepth\s+(\d+)/);
        const pvIdx = line.match(/multipv\s+(\d+)/);
        const pvMove = line.match(/\bpv\s+(\S+)/);
        // Score: can be "score cp <n>" or "score mate <n>"
        const cpMatch = line.match(/score cp (-?\d+)/);
        const mateMatch = line.match(/score mate (-?\d+)/);

        if (depthMatch && pvIdx && pvMove) {
          const searchDepth = parseInt(depthMatch[1], 10);
          const index = parseInt(pvIdx[1], 10) - 1;
          let score = null;
          if (cpMatch) {
            score = parseInt(cpMatch[1], 10);
          } else if (mateMatch) {
            // Treat mate as a very large cp value
            score = parseInt(mateMatch[1], 10) > 0 ? 30000 : -30000;
          }
          if (!pvByDepth.has(searchDepth)) pvByDepth.set(searchDepth, []);
          pvByDepth.get(searchDepth)[index] = { move: pvMove[1], score, scoreType: mateMatch ? 'mate' : 'cp', depth: searchDepth, pv: line.split(' pv ')[1].trim().split(/\s+/) };
        }
      }

      if (line.startsWith('bestmove')) {
        const parts = line.split(/\s+/);
        bestMove = parts[1] && parts[1] !== '(none)' ? parts[1] : null;

        const pvEntries = [...pvByDepth.entries()]
          .sort((a, b) => b[1].filter(Boolean).length - a[1].filter(Boolean).length || b[0] - a[0])[0]?.[1] || [];
        const pvMoves = pvEntries.map(e => e ? e.move : null).filter(Boolean);

        if (multiPV > 1 && pvEntries.length > 0) {
          finish(null, { bestMove, pvMoves, pvEntries, evaluation });
        } else {
          finish(null, { bestMove, pvMoves: bestMove ? [bestMove] : [], pvEntries: [], evaluation });
        }
      }
    };

    stockfish.addEventListener('message', messageHandler);
    activeSearchFailure = (error) => finish(error);

    stockfish.postMessage(`setoption name MultiPV value ${multiPV}`);
    stockfish.postMessage(`position fen ${fen}`);
    const budget = Number.isFinite(timeBudgetMs) ? Math.max(0, Math.min(10000, Math.round(timeBudgetMs))) : 0;
    stockfish.postMessage(`go depth ${depth}${budget > 0 ? ` movetime ${budget}` : ''}`);
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

async function computeHumanizedMove(fen, depth = 15, level = 2, requestId, timeBudgetMs = 0, qualityTarget = null, hints = {}) {
  await initStockfish();
  if (requestId !== latestRequest) throw new Error('Superseded');
  const labels = ['Pure engine · uncapped', 'Subtle · ~1500 Elo', 'Human-like · ~1200 Elo', 'Casual · ~900 Elo', 'Expert · ~2300 Elo'];
  let meta = labels[level] || 'Human-like';
  const multiPV = qualityTarget?.enabled || HUMANIZE_PROFILES[level] ? 10 : (hints.adaptiveDelay || hints.wantPrediction ? 3 : 1);
  const res = await evaluatePosition(fen, depth, multiPV, timeBudgetMs);
  let move = res.bestMove, moveQuality;
  if (qualityTarget?.enabled) {
    moveQuality = ChessMindQuality.choose(res.pvEntries, res.bestMove, qualityTarget);
    move = moveQuality.move;
    meta = `Quality ${moveQuality.estimated == null ? 'unavailable' : Math.round(moveQuality.estimated)} (estimate)`;
  } else if (HUMANIZE_PROFILES[level] && res.pvEntries[0]?.move === res.bestMove) {
    move = pickHumanMove(res.pvEntries, HUMANIZE_PROFILES[level]) || res.bestMove;
  }
  return { move, meta, evaluation: res.evaluation, moveQuality,
    difficulty: ChessMindAutoPlay.difficulty(fen, move, res.pvEntries),
    prediction: hints.wantPrediction ? ChessMindAutoPlay.predictedRecapture(fen, res.pvEntries, res.bestMove) : null };
}

// Listen for messages from background.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'RUN_STOCKFISH') {
    const requestId = ++latestRequest;
    if (activeSearchFailure) stockfish?.postMessage('stop');
    searchQueue = searchQueue.catch(() => {}).then(() =>
      computeHumanizedMove(message.fen, message.depth, message.humanizationLevel, requestId, message.timeBudgetMs, message.qualityTarget, message.hints)
    );
    searchQueue
      .then((result) => {
        sendResponse(requestId === latestRequest
          ? { success: true, move: result.move, meta: result.meta, evaluation: result.evaluation, moveQuality: result.moveQuality, difficulty: result.difficulty, prediction: result.prediction }
          : { success: false, error: 'Superseded' });
      })
      .catch((err) => {
        if (err.message !== 'Superseded') console.error('[ChessMind Offscreen] Analysis error:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep channel open for async response
  }
});

// Pre-initialize engine on document load
initStockfish().catch((err) => console.error('[ChessMind Offscreen] Pre-init error:', err));
