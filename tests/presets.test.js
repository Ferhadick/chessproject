const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('time presets preserve engine level and only search edits select Custom', () => {
  const elements = new Map();
  const writes = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', listeners: {},
      addEventListener(type, callback) { this.listeners[type] = callback; }
    });
    return elements.get(id);
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8'), {
    ChessMindAutoPlay: require('../autoplay.js'),
    document: { getElementById: element },
    chrome: {
      storage: { local: { get(keys, callback) { callback({}); }, set(value) { writes.push(value); } } },
      tabs: { query(options, callback) { callback([]); } },
      runtime: { onMessage: { addListener() {} } }
    }
  });
  element('profileSelect').value = '3';
  element('profileSelect').listeners.change();
  assert.equal(writes.at(-1).humanizationLevel, 3);
  assert.equal(writes.at(-1).analysisPreset, undefined);
  for (const [name, depth, budget, delay] of [
    ['bullet', 12, 250, 80], ['blitz', 18, 1000, 150], ['rapid', 20, 3000, 250]
  ]) {
    element('presetSelect').value = name;
    element('presetSelect').listeners.change();
    const saved = writes.at(-1);
    assert.equal(saved.analysisPreset, name);
    assert.equal(saved.depth, depth);
    assert.equal(saved.timeBudgetMs, budget);
    assert.equal(saved.analysisDelayMs, delay);
    assert.ok(saved.moveDelayMaxMs > saved.moveDelayMinMs);
    assert.equal(saved.humanizationLevel, undefined);
    assert.equal(element('profileSelect').value, '3');
    assert.equal(element('depthSelect').value, depth);
    assert.equal(element('timeBudgetSelect').value, budget);
  }
  element('profileSelect').value = '4';
  element('profileSelect').listeners.change();
  assert.equal(element('presetSelect').value, 'rapid');
  assert.deepEqual(Object.keys(writes.at(-1)), ['humanizationLevel']);
  assert.equal(element('depthSelect').value, 20);
  assert.equal(element('timeBudgetSelect').value, 3000);
  element('moveDelayMin').value = '0.3';
  element('moveDelayMax').value = '0.7';
  element('moveDelayMin').listeners.change();
  assert.equal(writes.at(-1).moveDelayMinMs, 300);
  assert.equal(writes.at(-1).moveDelayMaxMs, 700);
  assert.equal(writes.at(-1).depth, undefined);
  assert.equal(element('presetSelect').value, 'rapid');
  const count = writes.length;
  element('moveDelayMin').value = '2';
  element('moveDelayMin').listeners.change();
  assert.equal(writes.length, count);
  element('qualityMin').value = '75'; element('qualityMax').value = '89';
  element('qualityToggle').checked = true;
  element('qualityToggle').listeners.change();
  assert.equal(writes.at(-1).qualityTarget.min, 75);
  assert.equal(writes.at(-1).qualityTarget.max, 89);
  assert.equal(writes.at(-1).qualityTarget.enabled, true);
  assert.equal(element('profileSelect').disabled, true);
  assert.equal(writes.at(-1).depth, undefined);
  assert.equal(writes.at(-1).timeBudgetMs, undefined);
  element('depthSelect').value = '15';
  element('depthSelect').listeners.change();
  assert.equal(writes.at(-1).analysisPreset, 'custom');
  assert.equal(writes.at(-1).depth, 15);
  assert.equal(element('presetSelect').value, 'custom');
});
