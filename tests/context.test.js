const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
function setup(sendMessage, options = {}) {
  const status = { textContent: '' };
  const controls = [{ type: 'checkbox', checked: true, disabled: false }];
  let stopped = 0, disconnected = 0, cleared = 0;
  const runtime = { id: 'test-extension', sendMessage, onMessage: { addListener() {} } };
  let adapter;
  const api = require('../autoplay.js');
  const context = {
    crypto: require('node:crypto'),
    ChessMindAutoPlay: { ...api, create(value) { adapter = value; return api.create(value); } },
    chrome: { runtime, storage: { local: { set: options.set || (async () => {}) }, onChanged: { addListener() {} } } },
    document: { readyState: 'loading', addEventListener() {}, getElementById: id => id === 'cm-status' ? status : null },
    ChessMindAdvantage: require('../advantage.js'),
    window: { addEventListener() {} },
    clearInterval() { cleared++; }, clearTimeout() { cleared++; },
    testOverlay: { querySelectorAll: () => controls },
    testObserver: { disconnect() { disconnected++; } },
    testStop() { stopped++; },
    console
  };
  // Expose private operations only in the test VM, keeping production globals clean.
  const instrumented = source.replace(/\}\)\(\);\s*$/, `
    overlayEl = testOverlay;
    boardObserver = testObserver;
    isEnabled = true;
    if (!${Boolean(options.realController)}) autoPlayer.stop = testStop;
    globalThis.subject = { publishStatus, saveSettings, extensionOperation, extensionAvailable, autoPlayer };
  })();`);
  vm.runInNewContext(instrumented, context);
  return { subject: context.subject, adapter, runtime, status, controls, stopped: () => stopped,
    disconnected: () => disconnected, cleared: () => cleared };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('synchronous invalidation during messaging shuts down without throwing', async () => {
  let calls = 0;
  const h = setup(() => { calls++; throw new Error('Extension context invalidated.'); });
  assert.doesNotThrow(() => h.subject.publishStatus('Watching board'));
  await settle();
  assert.match(h.status.textContent, /refresh this page/);
  assert.equal(h.stopped(), 1);
  assert.equal(h.disconnected(), 1);
  assert.equal(h.cleared(), 2);
  assert.equal(h.controls[0].disabled, true);
  assert.equal(h.controls[0].checked, false);
  h.subject.publishStatus('Old callback');
  await settle();
  assert.equal(calls, 1);
  assert.match(h.status.textContent, /refresh this page/);
});
test('missing runtime ID retires the script before an API call', async () => {
  let calls = 0;
  const h = setup(async () => { calls++; });
  h.runtime.id = undefined;
  h.subject.publishStatus('Watching');
  h.subject.saveSettings({ enabled: true });
  await settle();
  assert.equal(calls, 0);
  assert.equal(h.stopped(), 1);
  assert.equal(h.subject.extensionAvailable(), false);
});
test('asynchronous invalidation is caught while ordinary receiver failures keep the context usable', async () => {
  const h = setup(() => Promise.reject(new Error('Extension context invalidated.')));
  h.subject.publishStatus('Watching'); await settle();
  assert.equal(h.stopped(), 1);
  const normal = setup(() => Promise.reject(new Error('Receiving end does not exist')));
  normal.subject.publishStatus('Watching'); await settle();
  assert.equal(normal.stopped(), 0);
  assert.equal(normal.subject.extensionAvailable(), true);
});


function activeBoard(adapter) {
  adapter.read = () => ({ url: 'https://www.chess.com/play/computer', board: adapter,
    fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', player: 'w', enabled: true, hidden: false,
    settings: {} });
}
test('real logging queue handles invalidation while the initial write is pending', async () => {
  let rejectWrite;
  let writes = 0;
  const h = setup(async () => {}, { realController: true, set: () => {
    writes++;
    return new Promise((resolve, reject) => { rejectWrite = reject; });
  } });
  activeBoard(h.adapter);
  const starting = h.subject.autoPlayer.start();
  const rejected = assert.rejects(starting, /Extension context invalidated/);
  await settle();
  rejectWrite(new Error('Extension context invalidated.'));
  await rejected; await settle();
  assert.equal(h.subject.autoPlayer.state().active, false);
  assert.equal(h.subject.autoPlayer.state().busy, false);
  assert.equal(writes, 1);
  assert.match(h.status.textContent, /refresh this page/);
});
test('real stop logging handles an invalidated context without an unhandled rejection', async () => {
  let writes = 0;
  const h = setup(async () => {}, { realController: true, set: async () => {
    writes++;
    if (writes > 1) throw new Error('Extension context invalidated.');
  } });
  activeBoard(h.adapter);
  await h.subject.autoPlayer.start();
  assert.equal(h.subject.autoPlayer.state().active, true);
  assert.doesNotThrow(() => h.subject.autoPlayer.stop());
  await settle();
  assert.equal(h.subject.autoPlayer.state().active, false);
  assert.match(h.status.textContent, /refresh this page/);
});
