const test = require('node:test');
const assert = require('node:assert/strict');
const { choose } = require('../quality.js');
const target = { min: 75, max: 89 };
const entry = (move, score, scoreType = 'cp') => ({ move, score, scoreType });
test('chooses an alternative within the configured internal quality range', () => {
  const result = choose([entry('e2e4', 200), entry('d2d4', 160), entry('g1f3', 100)], 'e2e4', target, () => 0.5);
  assert.equal(result.move, 'd2d4');
  assert.equal(result.lossCp, 40);
  assert.ok(result.estimated >= 75 && result.estimated <= 89);
});
test('does not turn an advantage into a losing evaluation', () => {
  const result = choose([entry('e2e4', 20), entry('d2d4', -20)], 'e2e4', target);
  assert.equal(result.move, 'e2e4');
});
test('keeps a clear advantage and avoids further loss in bad positions', () => {
  assert.equal(choose([entry('e2e4', 150), entry('d2d4', 95)], 'e2e4', target).move, 'e2e4');
  assert.equal(choose([entry('e2e4', -200), entry('d2d4', -240)], 'e2e4', target).move, 'e2e4');
});
test('preserves mates, rejects distant blunders and handles forced moves', () => {
  assert.equal(choose([entry('e2e4', 30000, 'mate'), entry('d2d4', 500)], 'e2e4', target).move, 'e2e4');
  assert.equal(choose([entry('e2e4', 500), entry('d2d4', 200)], 'e2e4', { min: 0, max: 50 }).move, 'e2e4');
  assert.equal(choose([entry('e2e4', 200)], 'e2e4', target).estimated, 100);
});
test('invalid targets or inconsistent search data use the engine best move', () => {
  for (const invalid of [{ min: NaN, max: 90 }, { min: 90, max: 75 }, { min: -1, max: 110 }]) {
    assert.equal(choose([entry('e2e4', 200)], 'e2e4', invalid).move, 'e2e4');
  }
  assert.equal(choose([entry('d2d4', 200)], 'e2e4', target).move, 'e2e4');
});
