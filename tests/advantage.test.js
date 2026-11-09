const test = require('node:test');
const assert = require('node:assert/strict');
const { describe } = require('../advantage.js');
test('advantage is reversed for each player and neutral is centered', () => {
  const white = describe({ type: 'cp', value: 150 }, 'w');
  const black = describe({ type: 'cp', value: 150 }, 'b');
  assert.equal(white.label, 'Ahead +1.5');
  assert.equal(black.label, 'Behind −1.5');
  assert.ok(white.share > 50);
  assert.equal(white.share + black.share, 100);
  assert.equal(describe({ type: 'cp', value: 0 }, 'w').label, 'Equal');
  assert.equal(describe({ type: 'cp', value: 0 }, 'w').share, 50);
});
test('mate scores identify the winner without converting mate to pawns', () => {
  const score = { type: 'mate', value: 3, winningColor: 'b' };
  assert.equal(describe(score, 'b').label, 'Mate in 3');
  assert.equal(describe(score, 'w').label, 'Facing mate in 3');
  assert.equal(describe(score, 'b').share, 100);
  assert.equal(describe(score, 'w').share, 0);
  assert.equal(describe({ ...score, value: 0 }, 'b').label, 'Checkmate');
});
test('missing scores are not presented as equal positions and extreme scores stay bounded', () => {
  assert.equal(describe(null, 'w').label, 'Evaluating…');
  assert.equal(describe(undefined, 'w').label, 'Evaluation unavailable');
  assert.equal(describe({ type: 'cp', value: Infinity }, 'w').label, 'Evaluation unavailable');
  assert.equal(describe({ type: 'cp', value: 99999 }, 'w').share, 98);
});

test('badges anchor to player names and reverse color when the board flips', () => {
  const { create } = require('../advantage.js');
  const attached = [];
  const makeNode = () => ({
    style: {}, children: [], className: '', textContent: '', setAttribute() {},
    appendChild(child) { this.children.push(child); },
    querySelector(selector) {
      const find = node => node.className === selector.slice(1) ? node : node.children.map(find).find(Boolean);
      return find(this);
    },
    remove() { attached.splice(attached.indexOf(this), 1); }
  });
  const document = {
    createElement: makeNode,
    body: { appendChild(node) { attached.push(node); } },
    querySelector(selector) {
      const top = selector.includes('.top');
      return {
        getBoundingClientRect: () => ({ top: top ? 50 : 600, height: 50 }),
        querySelector: () => ({ getBoundingClientRect: () => ({ right: 120, width: 80 }) })
      };
    }
  };
  let flipped = false;
  const board = { getBoundingClientRect: () => ({ left: 20, top: 100, bottom: 600, width: 560, height: 500 }) };
  const view = create(document, { innerWidth: 1000, innerHeight: 800 }, () => board, () => flipped);
  view.show({ type: 'cp', value: 150 });
  assert.equal(attached.length, 2);
  assert.equal(attached[0].style.left, '130px');
  assert.equal(attached[0].style.top, '59px');
  assert.equal(attached[1].style.top, '609px');
  assert.equal(attached[0].querySelector('.cm-eval-text').textContent, 'Black · Behind −1.5');
  assert.equal(attached[1].querySelector('.cm-eval-text').textContent, 'White · Ahead +1.5');
  flipped = true; view.position();
  assert.equal(attached[0].querySelector('.cm-eval-text').textContent, 'White · Ahead +1.5');
  view.hide(); assert.equal(attached.length, 0);
});
