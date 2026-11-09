// Internal move-quality index. This is not a site's post-game accuracy metric.
(function (root) {
  function choose(entries, bestMove, target, random = Math.random) {
    const min = Number(target?.min), max = Number(target?.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max > 100 || min > max) return { move: bestMove, reason: 'Invalid target' };
    const best = entries?.[0];
    if (!best || !Number.isFinite(best.score) || best.move !== bestMove || best.scoreType === 'mate' || Math.abs(best.score) >= 29000) {
      return { move: bestMove, reason: 'Keep best move: incomplete or mate evaluation' };
    }
    const desired = min + random() * (max - min);
    let chosen = null;
    for (const entry of entries) {
      if (!entry || !Number.isFinite(entry.score) || entry.scoreType === 'mate' || Math.abs(entry.score) >= 29000) continue;
      const lossCp = best.score - entry.score;
      // Hard limits prevent a sparse MultiPV list from choosing a distant blunder.
      if (lossCp < 0 || lossCp > 80 || (best.score >= 0 && entry.score < 0) ||
          (best.score >= 150 && entry.score < 100) || (best.score < -100 && lossCp > 0)) continue;
      const estimated = 100 * Math.exp(-lossCp / 200);
      if (estimated < min || estimated > max) continue;
      if (!chosen || Math.abs(estimated - desired) < Math.abs(chosen.estimated - desired)) {
        chosen = { move: entry.move, estimated, lossCp, reason: 'Within estimated target' };
      }
    }
    return chosen || { move: bestMove, estimated: 100, lossCp: 0, reason: 'Keep best move: no suitable alternative' };
  }
  const api = { choose };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChessMindQuality = api;
})(globalThis);
