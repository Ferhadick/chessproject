const test = require('node:test');
const assert = require('node:assert/strict');
const { create, isSupportedPage, pieceAt } = require('../autoplay.js');
const initial = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
const moved = '4k3/8/8/8/4P3/8/8/4K3 b - - 0 1';
function harness(overrides = {}) {
  const board = {};
  const current = { url: 'https://www.chess.com/play/computer', board, fen: initial,
    enabled: true, hidden: false, player: 'w', settings: {} };
  const events = [], clicks = [], statuses = [];
  const adapter = {
    read: () => ({ ...current }),
    click: async square => { clicks.push(square); if (clicks.length === 2) current.fen = moved; },
    promote: async () => false,
    wait: async () => {},
    record: async event => { events.push(event); },
    onState: (state, reason) => statuses.push(reason), onReady() {}, onLogError() {},
    ...overrides
  };
  const controller = create(adapter);
  return { controller, current, clicks, events, statuses, adapter };
}

test('auto-play accepts supported chess routes and rejects other origins and pages', () => {
  for (const url of ['https://www.chess.com/play/computer', 'https://www.chess.com/play/online',
    'https://www.chess.com/game/live/1', 'https://www.chess.com/chess/example']) assert.equal(isSupportedPage(url), true);
  for (const url of ['https://www.chess.com/play-fake', 'https://www.chess.com/home',
    'https://evil.test/play/computer']) assert.equal(isSupportedPage(url), false);
});
test('plays and records a confirmed move', async () => {
  const h = harness();
  await h.controller.start();
  await h.controller.suggest(initial, 'e2e4', 100, { depth: 12 });
  assert.deepEqual(h.clicks, ['e2', 'e4']);
  assert.equal(h.events[1].move, 'e2e4');
  assert.equal(h.events[1].elapsedMs, 100);
  assert.equal(h.controller.state().active, true);
});
test('stale positions cause no clicks', async () => {
  const h = harness(); await h.controller.start(); h.current.fen = moved;
  await h.controller.suggest(initial, 'e2e4', 1, {});
  assert.equal(h.clicks.length, 0);
  assert.equal(h.controller.state().active, false);
});
test('stop between source and destination prevents the move', async () => {
  const other = harness({ wait: async () => other.controller.stop() });
  await other.controller.start(); await other.controller.suggest(initial, 'e2e4', 1, {});
  assert.deepEqual(other.clicks, ['e2']);
  assert.equal(other.controller.state().active, false);
});
test('an unaccepted move stops without retrying', async () => {
  const h = harness({ click: async square => h.clicks.push(square) });
  await h.controller.start(); await h.controller.suggest(initial, 'e2e4', 1, {});
  assert.equal(h.controller.state().active, false);
  assert.equal(h.clicks.length, 2);
  assert.match(h.statuses.at(-1), /not confirmed/);
});
test('board replacement and tab hiding stop auto-play', async () => {
  for (const change of [{ board: {} }, { hidden: true }, { url: 'https://www.chess.com/play/online' }]) {
    const h = harness(); await h.controller.start(); Object.assign(h.current, change); h.controller.monitor();
    assert.equal(h.controller.state().active, false);
    assert.equal(h.clicks.length, 0);
  }
});
test('promotion selects and confirms the requested piece', async () => {
  const before = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
  const after = 'N3k3/8/8/8/8/8/8/4K3 b - - 0 1';
  const h = harness({
    click: async square => h.clicks.push(square),
    promote: async (color, piece) => { assert.equal(color, 'w'); assert.equal(piece, 'n'); h.current.fen = after; return true; }
  });
  h.current.fen = before; await h.controller.start(); await h.controller.suggest(before, 'a7a8n', 1, {});
  assert.equal(h.events[1].move, 'a7a8n');
  assert.equal(pieceAt(after, 'a8'), 'N');
});
test('game outcome is recorded and no further moves are played', async () => {
  const h = harness(); await h.controller.start(); h.current.outcome = 'White won'; h.controller.monitor();
  assert.equal(h.events.at(-1).outcome, 'White won');
  assert.equal(h.controller.state().active, false);
});
test('logging failure prevents auto-play from starting', async () => {
  const h = harness({ record: async () => { throw new Error('Storage full'); } });
  await assert.rejects(h.controller.start(), /Storage full/);
  assert.equal(h.controller.state().active, false);
  assert.equal(h.clicks.length, 0);
});


test('stopping while a session is being saved prevents it from arming', async () => {
  let release;
  const h = harness({ record: event => event.type === 'start'
    ? new Promise(resolve => { release = resolve; }) : Promise.resolve() });
  const starting = h.controller.start();
  h.controller.stop(); release(); await starting;
  assert.equal(h.controller.state().active, false);
  assert.equal(h.clicks.length, 0);
});
test('the same position is not played twice within a session', async () => {
  const h = harness(); await h.controller.start();
  await h.controller.suggest(initial, 'e2e4', 1, {});
  h.current.fen = initial;
  await h.controller.suggest(initial, 'e2e4', 1, {});
  assert.equal(h.clicks.length, 2);
  assert.equal(h.controller.state().active, false);
});
test('a game-ending move is logged before the final outcome', async () => {
  const h = harness({ click: async square => {
    h.clicks.push(square);
    if (h.clicks.length === 2) { h.current.fen = moved; h.current.outcome = 'White won'; }
  } });
  await h.controller.start(); await h.controller.suggest(initial, 'e2e4', 1, {});
  assert.equal(h.events[1].type, 'move');
  assert.equal(h.events[1].afterFen, moved);
  assert.equal(h.events[2].outcome, 'White won');
  assert.equal(h.controller.state().active, false);
});

test('delay sampling stays in range and is recorded separately from analysis time', async () => {
  for (const [random, expected] of [[0, 200], [0.5, 400], [1, 600]]) {
    const waits = [];
    const h = harness({ random: () => random, wait: async ms => { waits.push(ms); } });
    await h.controller.start();
    await h.controller.suggest(initial, 'e2e4', 75, { moveDelayMinMs: 200, moveDelayMaxMs: 600 });
    assert.equal(h.events[1].moveDelayMs, expected);
    assert.equal(h.events[1].elapsedMs, 75);
    assert.equal(waits.slice(0, -2).reduce((a, b) => a + b, 0), expected);
  }
});
test('stop during the random pause prevents all board clicks', async () => {
  const h = harness({ wait: async () => h.controller.stop() });
  await h.controller.start();
  await h.controller.suggest(initial, 'e2e4', 1, { moveDelayMinMs: 500, moveDelayMaxMs: 500 });
  assert.equal(h.clicks.length, 0);
  assert.equal(h.controller.state().active, false);
});
test('position changes during the random pause prevent all board clicks', async () => {
  const h = harness({ wait: async () => { h.current.fen = moved; } });
  await h.controller.start();
  await h.controller.suggest(initial, 'e2e4', 1, { moveDelayMinMs: 500, moveDelayMaxMs: 500 });
  assert.equal(h.clicks.length, 0);
  assert.match(h.statuses.at(-1), /changed during move delay/);
});
test('saved time presets receive delay defaults and invalid ranges are bounded', () => {
  const { delayRange } = require('../autoplay.js');
  assert.deepEqual(delayRange('bullet'), { moveDelayMinMs: 150, moveDelayMaxMs: 600 });
  assert.deepEqual(delayRange('custom', -10, 999999), { moveDelayMinMs: 0, moveDelayMaxMs: 30000 });
  assert.deepEqual(delayRange('custom', 500, 100), { moveDelayMinMs: 500, moveDelayMaxMs: 500 });
});

test('a prepared reply skips the extra pause but retains move confirmation and logging', async () => {
  const waits = [];
  const h = harness({ wait: async ms => waits.push(ms) });
  await h.controller.start();
  await h.controller.suggest(initial, 'e2e4', 0, { preparedReply: true, moveDelayMinMs: 1500, moveDelayMaxMs: 5000 });
  assert.deepEqual(h.clicks, ['e2', 'e4']);
  assert.deepEqual(waits, [100, 100]);
  assert.equal(h.events[1].moveDelayMs, 0);
  assert.equal(h.events[1].delayCategory, 'prepared');
  assert.equal(h.events[1].settings.preparedReply, true);
});
