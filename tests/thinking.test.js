const test = require('node:test');
const assert = require('node:assert/strict');
const { difficulty, planDelay, predictedRecapture, createPredictionCache } = require('../autoplay.js');
const opening = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const pv = (move, score, rest = []) => ({ move, score, depth: 12, scoreType: 'cp', pv: [move, ...rest] });
const before = '3r2k1/8/8/8/3B4/8/8/3Q2K1 b - - 0 1';
const after = '6k1/8/8/8/3r4/8/8/3Q2K1 w - - 0 1';
const entries = [pv('d8d4', 200, ['d1d4']), pv('g8f8', 0)];

test('difficulty identifies clear choices, close alternatives, promotions and pawn endings', () => {
  assert.equal(difficulty(opening, 'e2e4', [pv('e2e4', 200), pv('d2d4', 0)]).category, 'easy');
  assert.equal(difficulty(opening, 'e2e4', [pv('e2e4', 25), pv('d2d4', 20), pv('g1f3', 18)]).category, 'complex');
  assert.equal(difficulty(opening, 'a7a8q', []).category, 'complex');
  assert.equal(difficulty('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', 'e2e4', []).category, 'complex');
  assert.equal(difficulty(opening, 'e2e4', []).category, 'normal');
});
test('adaptive timing stays within user bounds and uses different portions of the range', () => {
  const settings = { moveDelayMinMs: 100, moveDelayMaxMs: 1000, adaptiveDelay: true };
  assert.equal(planDelay({ ...settings, difficulty: { category: 'easy' } }, () => 1).ms, 400);
  assert.equal(planDelay({ ...settings, difficulty: { category: 'complex' } }, () => 0).ms, 640);
  assert.equal(planDelay({ ...settings, adaptiveDelay: false, difficulty: { category: 'complex' } }, () => 0).ms, 100);
  assert.equal(planDelay({ ...settings, preparedReply: true }).ms, 0);
  assert.equal(planDelay({ adaptiveDelay: true, difficulty: { category: 'complex' }, moveDelayMinMs: 0, moveDelayMaxMs: 0 }).ms, 0);
});
test('only a clear, deep-enough capture and recapture can be prepared', () => {
  const prediction = predictedRecapture(before, entries, 'd8d4');
  assert.equal(prediction.expectedFen, after);
  assert.equal(prediction.move, 'd1d4');
  assert.equal(prediction.predictedOpponentMove, 'd8d4');
  assert.equal(predictedRecapture(before, [{ ...entries[0], depth: 5 }, entries[1]], 'd8d4'), null);
  assert.equal(predictedRecapture(before, [entries[0], pv('g8f8', 180)], 'd8d4'), null);
  assert.equal(predictedRecapture(before, [entries[0]], 'd8d4'), null);
  assert.equal(predictedRecapture(before, [{ ...entries[0], pv: ['d8d4', 'd1h5'] }, entries[1]], 'd8d4'), null);
  assert.equal(predictedRecapture(before, [{ ...entries[0], scoreType: 'mate' }, entries[1]], 'd8d4'), null);
});
test('predicted captures preserve the exact castling state', () => {
  const fen = 'r3k3/8/8/8/8/8/8/RQ2K3 b Qq - 0 1';
  const result = predictedRecapture(fen, [pv('a8a1', 200, ['b1a1']), pv('e8f8', 0)], 'a8a1');
  assert.equal(result.expectedFen, '4k3/8/8/8/8/8/8/rQ2K3 w - - 0 1');
});
test('prepared replies require exact positions, unchanged settings and expire after ten seconds', () => {
  let time = 0;
  const cache = createPredictionCache(() => time);
  const prediction = predictedRecapture(before, entries, 'd8d4');
  const settings = { depth: 15, humanizationLevel: 2 };
  cache.put(prediction, settings);
  assert.equal(cache.take(after, settings).move, 'd1d4');
  assert.equal(cache.take(after, settings), null);
  cache.put(prediction, settings); assert.equal(cache.take(before, settings), null);
  cache.put(prediction, settings); assert.equal(cache.take(after, { ...settings, depth: 18 }), null);
  cache.put(prediction, settings); time = 10001; assert.equal(cache.take(after, settings), null);
  cache.put(prediction, settings); cache.clear(); assert.equal(cache.take(after, settings), null);
});
