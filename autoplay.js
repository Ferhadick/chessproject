// Session-scoped auto-play. The DOM adapter supplies observations and clicks.
(function (root) {
  function isSupportedPage(url) {
    try {
      const parsed = new URL(url);
      return parsed.origin === 'https://www.chess.com' &&
        /^\/(?:play|game|chess)(?:\/|$)/.test(parsed.pathname);
    } catch { return false; }
  }

  function pieceAt(fen, square) {
    const rows = fen?.split(' ')[0]?.split('/');
    if (!rows || rows.length !== 8 || !/^[a-h][1-8]$/.test(square)) return null;
    const row = rows[8 - Number(square[1])];
    const expanded = row.replace(/[1-8]/g, count => '.'.repeat(Number(count)));
    return expanded[square.charCodeAt(0) - 97] || null;
  }

  const PRESET_DELAYS = {
    bullet: { moveDelayMinMs: 150, moveDelayMaxMs: 600 },
    blitz: { moveDelayMinMs: 500, moveDelayMaxMs: 1800 },
    rapid: { moveDelayMinMs: 1500, moveDelayMaxMs: 5000 }
  };
  function delayRange(preset, min, max) {
    const defaults = PRESET_DELAYS[preset] || { moveDelayMinMs: 0, moveDelayMaxMs: 0 };
    const lower = Number.isFinite(min) ? Math.max(0, Math.min(30000, Math.round(min))) : defaults.moveDelayMinMs;
    const upper = Number.isFinite(max) ? Math.max(0, Math.min(30000, Math.round(max))) : defaults.moveDelayMaxMs;
    return { moveDelayMinMs: lower, moveDelayMaxMs: Math.max(lower, upper) };
  }

  function difficulty(fen, move, entries) {
    const pieces = (fen?.split(' ')[0] || '').replace(/[^a-z]/gi, '');
    const best = entries?.[0], second = entries?.[1];
    const comparable = best?.move === move && best.scoreType === 'cp' && second?.scoreType === 'cp' &&
      Number.isFinite(best.score) && Number.isFinite(second.score);
    const gap = comparable ? best.score - second.score : null;
    if (move?.length === 5) return { category: 'complex', reason: 'Promotion decision' };
    if (pieces.length <= 8 && /^[kp]*$/i.test(pieces)) return { category: 'complex', reason: 'King and pawn ending' };
    if (best && best.move !== move) return { category: 'complex', reason: 'Alternative to engine best move' };
    if (gap !== null && gap >= 150 && best.depth >= 8 && pieceAt(fen, move.slice(0, 2))?.toLowerCase() !== 'k') {
      return { category: 'easy', reason: 'Clear engine preference' };
    }
    if (gap !== null && gap <= 30 && entries.filter(Boolean).length >= 3) return { category: 'complex', reason: 'Several close alternatives' };
    if (move && /[qr]/i.test(pieceAt(fen, move.slice(2, 4)) || '.')) return { category: 'complex', reason: 'Major-piece capture' };
    return { category: 'normal', reason: 'No clear difficulty signal' };
  }
  function planDelay(settings, random = Math.random) {
    if (settings?.preparedReply) return { ms: 0, category: 'prepared', reason: 'Exact predicted position matched' };
    const range = delayRange(null, settings?.moveDelayMinMs, settings?.moveDelayMaxMs);
    let low = range.moveDelayMinMs, high = range.moveDelayMaxMs;
    const hint = settings?.adaptiveDelay ? settings.difficulty : null;
    if (hint?.category === 'easy') high = low + (high - low) / 3;
    if (hint?.category === 'complex') low += (high - low) * 0.6;
    return { ms: Math.round(low + random() * (high - low)), category: hint?.category || 'normal', reason: hint?.reason || 'Uniform pause' };
  }
  function predictedRecapture(fen, entries, bestMove) {
    const first = entries?.[0], second = entries?.[1];
    if (!first || first.move !== bestMove || first.depth < 8 || first.scoreType !== 'cp' || second?.scoreType !== 'cp' ||
        !Number.isFinite(first.score) || !Number.isFinite(second.score) || first.score - second.score < 150) return null;
    const move = first.pv?.[0], reply = first.pv?.[1];
    if (move !== bestMove || !/^[a-h][1-8][a-h][1-8]$/.test(move || '') || !/^[a-h][1-8][a-h][1-8]$/.test(reply || '')) return null;
    const from = move.slice(0, 2), to = move.slice(2, 4), replyFrom = reply.slice(0, 2);
    const color = fen.split(' ')[1], next = color === 'w' ? 'b' : 'w';
    const pieceColor = piece => !piece || piece === '.' ? null : (piece === piece.toUpperCase() ? 'w' : 'b');
    const mover = pieceAt(fen, from), captured = pieceAt(fen, to), recapturer = pieceAt(fen, replyFrom);
    // Only an actual capture followed by a recapture on the same square. Skip
    // promotions, en passant and castling rather than guessing special states.
    if (reply.slice(2, 4) !== to || replyFrom === to || pieceColor(mover) !== color ||
        pieceColor(captured) !== next || pieceColor(recapturer) !== next || captured.toLowerCase() === 'k' ||
        (/[p]/i.test(mover) && /[18]/.test(to[1])) || (/[p]/i.test(recapturer) && /[18]/.test(to[1]))) return null;
    const fields = fen.split(' ');
    const grid = fields[0].split('/').map(row => row.replace(/[1-8]/g, n => '.'.repeat(Number(n))).split(''));
    grid[8 - Number(from[1])][from.charCodeAt(0) - 97] = '.';
    grid[8 - Number(to[1])][to.charCodeAt(0) - 97] = mover;
    const placement = grid.map(row => row.join('').replace(/\.+/g, empty => String(empty.length))).join('/');
    let rights = fields[2];
    for (const square of [from, to]) {
      const remove = { a1: 'Q', h1: 'K', e1: 'KQ', a8: 'q', h8: 'k', e8: 'kq' }[square] || '';
      rights = rights.split('').filter(right => !remove.includes(right)).join('');
    }
    const expectedFen = `${placement} ${next} ${rights || '-'} - 0 1`;
    return { expectedFen, move: reply, predictedOpponentMove: move };
  }
  function createPredictionCache(now = Date.now) {
    let value = null;
    return {
      put(prediction, settings) { value = prediction ? { ...prediction, settings: JSON.stringify(settings), expires: now() + 10000 } : null; },
      take(fen, settings) {
        const cached = value; value = null;
        return cached && cached.expires > now() && cached.expectedFen === fen && cached.settings === JSON.stringify(settings) ? cached : null;
      },
      clear() { value = null; }
    };
  }

  function create(adapter) {
    let active = false;
    let busy = false;
    let generation = 0;
    let board = null;
    let url = null;
    const attempted = new Set();
    const wait = adapter.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const state = () => ({ active, busy });
    const valid = token => active && token === generation;
    function stop(reason = 'Stopped by user', outcome = null) {
      if (!active && !busy) return;
      active = false;
      generation++;
      adapter.onState(state(), reason);
      adapter.record({ type: 'stop', reason, outcome, at: Date.now() }).catch(adapter.onLogError);
    }
    function check(allowOutcome = false) {
      const current = adapter.read();
      if (!isSupportedPage(current.url) || current.url !== url || current.board !== board || !current.enabled || current.hidden) {
        throw new Error('Auto-play stopped: page or board changed');
      }
      if (current.outcome && !allowOutcome) {
        stop('Game ended', current.outcome);
        throw new Error('Game ended');
      }
      return current;
    }
    async function start() {
      if (active || busy) throw new Error('Auto-play is already running or stopping');
      const current = adapter.read();
      if (!isSupportedPage(current.url)) throw new Error('Open a supported chess board to start auto-play');
      if (!current.board || !current.fen || !current.enabled || current.hidden || current.outcome) {
        throw new Error('Enable the advisor on an active, visible chess board first');
      }
      board = current.board;
      url = current.url;
      const run = { type: 'start', at: Date.now(), fen: current.fen, settings: current.settings };
      attempted.clear();
      const token = ++generation;
      busy = true;
      try {
        await adapter.record(run);
        if (token !== generation) return;
        active = true;
        adapter.onState(state(), 'Auto-play active');
      } finally { busy = false; }
    }
    async function suggest(fen, move, elapsedMs, settings) {
      if (!active || busy) return;
      const token = generation;
      busy = true;
      try {
        const current = check();
        if (current.fen !== fen) throw new Error('Position changed before move');
        if (!move) { stop('No legal move'); return; }
        if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) throw new Error('Invalid engine move');
        const from = move.slice(0, 2), to = move.slice(2, 4);
        if (from === to) throw new Error('Invalid engine move');
        const piece = pieceAt(fen, from);
        const color = fen.split(' ')[1];
        if (!piece || piece === '.' || (piece === piece.toUpperCase() ? 'w' : 'b') !== color || color !== current.player) {
          throw new Error('Move does not match the player to move');
        }
        const pause = planDelay(settings, adapter.random || Math.random);
        const moveDelayMs = pause.ms;
        const delayStarted = Date.now();
        if (moveDelayMs > 0) adapter.onState(state(), `Waiting ${(moveDelayMs / 1000).toFixed(2)}s before move`);
        // Small slices allow Stop and board changes to cancel a long pause promptly.
        for (let remaining = moveDelayMs; remaining > 0; remaining -= 100) {
          await wait(Math.min(remaining, 100));
          if (!valid(token)) return;
          const pending = check();
          if (pending.fen !== fen || pending.player !== color) throw new Error('Position changed during move delay');
        }
        const actualMoveDelayMs = Date.now() - delayStarted;
        // Never retry an attempted position, including after a timeout.
        if (attempted.has(fen)) throw new Error('Position was already attempted');
        attempted.add(fen);
        if (attempted.size > 2000) throw new Error('Research session move limit reached');
        await adapter.click(from);
        await wait(100);
        if (!valid(token)) return;
        const selected = check();
        if (selected.fen?.split(' ')[0] !== fen.split(' ')[0] || selected.player !== color) throw new Error('Position changed while selecting a piece');
        await adapter.click(to);
        const expected = move[4] ? (color === 'w' ? move[4].toUpperCase() : move[4]) : piece;
        let promoted = false;
        let accepted = false;
        let outcome = null;
        let afterFen = null;
        for (let i = 0; i < 30; i++) {
          await wait(100);
          if (!valid(token)) return;
          const next = check(true);
          if (pieceAt(next.fen, from) === '.' && pieceAt(next.fen, to) === expected) {
            outcome = next.outcome;
            afterFen = next.fen;
            accepted = true;
            break;
          }
          if (move[4] && !promoted) promoted = await adapter.promote(color, move[4]);
          if (next.fen && next.fen.split(' ')[0] !== fen.split(' ')[0] && !move[4]) throw new Error('Unexpected move result');
        }
        if (!accepted) throw new Error('Move was not confirmed — stopped without retrying');
        await adapter.record({ type: 'move', at: Date.now(), fen, afterFen, move, elapsedMs, moveDelayMs, actualMoveDelayMs, settings, delayCategory: pause.category, delayReason: pause.reason });
        if (valid(token) && outcome) stop('Game ended', outcome);
        else if (valid(token)) adapter.onState(state(), 'Move played; waiting for bot');
      } catch (error) {
        if (valid(token)) stop(error.message);
      } finally {
        busy = false;
        if (valid(token)) adapter.onReady();
      }
    }
    function monitor() {
      if (!active) return;
      try { check(busy); } catch (error) { if (active) stop(error.message); }
    }
    return { start, stop, suggest, monitor, state };
  }
  const api = { create, isSupportedPage, pieceAt, PRESET_DELAYS, delayRange, difficulty, planDelay, predictedRecapture, createPredictionCache };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChessMindAutoPlay = api;
})(globalThis);
