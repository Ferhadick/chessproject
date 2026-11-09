const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8');

test('new analysis supersedes an in-flight search', async () => {
  let listener;
  const commands = [];
  let bestMove = 'e2e4';
  let scoreLine = 'info depth 10 score cp 125 pv e2e4';
  class FakeWorker {
    constructor() { this.listeners = new Set(); this.searchTimer = null; }
    addEventListener(type, callback) { if (type === 'message') this.listeners.add(callback); }
    removeEventListener(type, callback) { if (type === 'message') this.listeners.delete(callback); }
    emit(line) {
      const event = { data: line };
      this.onmessage?.(event);
      for (const callback of this.listeners) callback(event);
    }
    postMessage(command) {
      commands.push(command);
      if (command === 'uci') queueMicrotask(() => this.emit('uciok'));
      if (command === 'isready') queueMicrotask(() => this.emit('readyok'));
      if (command === 'stop' && this.searchTimer) {
        clearTimeout(this.searchTimer);
        this.searchTimer = null;
        queueMicrotask(() => this.emit(`bestmove ${bestMove}`));
      }
      if (command.startsWith('go depth')) {
        this.searchTimer = setTimeout(() => {
          this.searchTimer = null;
          scoreLine.split('\n').forEach(line => this.emit(line));
          this.emit(`bestmove ${bestMove}`);
        }, 25);
      }
    }
    terminate() { clearTimeout(this.searchTimer); }
  }
  vm.runInNewContext(source, {
    Worker: FakeWorker,
    ChessMindQuality: require('../quality.js'),
    ChessMindAutoPlay: require('../autoplay.js'),
    chrome: { runtime: { onMessage: { addListener: fn => { listener = fn; } } } },
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask
  });

  const request = (turn = 'w', qualityTarget = null, hints = {}, position = null) => new Promise(resolve => {
    listener({
      type: 'RUN_STOCKFISH',
      fen: position || `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR ${turn} KQkq - 0 1`,
      depth: 10,
      timeBudgetMs: 250,
      humanizationLevel: 0,
      qualityTarget, hints
    }, {}, resolve);
  });

  const first = request();
  await new Promise(resolve => setTimeout(resolve, 0));
  const second = request();
  const [oldResult, newResult] = await Promise.all([first, second]);
  assert.equal(oldResult.success, false);
  assert.equal(oldResult.error, 'Superseded');
  assert.equal(newResult.success, true);
  assert.equal(newResult.move, 'e2e4');
  assert.ok(commands.includes('go depth 10 movetime 250'));
  assert.equal(newResult.evaluation.value, 125);
  assert.equal(newResult.evaluation.type, 'cp');
  const black = await request('b');
  assert.equal(black.evaluation.value, -125);
  scoreLine = 'info depth 10 score mate -3 pv e2e4';
  const mate = await request('b');
  assert.equal(mate.evaluation.type, 'mate');
  assert.equal(mate.evaluation.value, 3);
  assert.equal(mate.evaluation.winningColor, 'w');
  scoreLine = 'info depth 10 score cp 900 lowerbound pv e2e4';
  const bound = await request();
  assert.equal(bound.evaluation, null);
  scoreLine = 'info depth 10 multipv 1 score cp 200 pv e2e4\ninfo depth 10 multipv 2 score cp 160 pv d2d4';
  const quality = await request('w', { enabled: true, min: 75, max: 89 });
  assert.equal(quality.move, 'd2d4');
  assert.equal(quality.moveQuality.lossCp, 40);
  assert.equal(quality.difficulty.category, 'complex');
  assert.equal(quality.evaluation.value, 200);
  assert.ok(commands.includes('setoption name MultiPV value 10'));
  assert.ok(commands.includes('go depth 10 movetime 250'));
  bestMove = 'd8d4';
  scoreLine = 'info depth 12 multipv 1 score cp 200 pv d8d4 d1d4\ninfo depth 12 multipv 2 score cp 0 pv g8f8';
  const prediction = await request('b', null, { wantPrediction: true }, '3r2k1/8/8/8/3B4/8/8/3Q2K1 b - - 0 1');
  assert.equal(prediction.prediction.move, 'd1d4');
  assert.equal(prediction.prediction.expectedFen, '6k1/8/8/8/3r4/8/8/3Q2K1 w - - 0 1');
  assert.ok(commands.includes('setoption name MultiPV value 3'));

});
