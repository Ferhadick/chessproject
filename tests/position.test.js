const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const contentSource = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function createBoardReader(initialPieces) {
  let pieces = initialPieces;
  let moveCount = 0;
  let listener;
  const board = {
    classList: { contains: () => false },
    querySelectorAll: selector => selector === '.piece'
      ? Object.entries(pieces).map(([square, piece]) => ({
        classList: { forEach: callback => [`square-${square}`, piece].forEach(callback) }
      }))
      : []
  };
  const context = {
    ChessMindAutoPlay: require('../autoplay.js'),
    ChessMindAdvantage: require('../advantage.js'),
    window: { addEventListener() {} },
    document: {
      readyState: 'loading',
      addEventListener() {},
      querySelector: selector => selector === 'chess-board' ? board : null,
      querySelectorAll: selector => selector.startsWith('.move-list-row')
        ? Array(moveCount).fill({})
        : []
    },
    chrome: {
      runtime: { onMessage: { addListener: fn => { listener = fn; } } },
      storage: { onChanged: { addListener() {} } }
    }
  };
  vm.runInNewContext(contentSource, context);
  return {
    setPieces(nextPieces, nextMoveCount) { pieces = nextPieces; moveCount = nextMoveCount; },
    fen() {
      let response;
      listener({ type: 'REQUEST_FEN' }, {}, value => { response = value; });
      return response.fen;
    }
  };
}

function startingPieces() {
  const pieces = {};
  for (let file = 0; file < 8; file++) {
    const letter = String.fromCharCode(97 + file);
    pieces[`${letter}2`] = 'wp';
    pieces[`${letter}7`] = 'bp';
    pieces[`${letter}1`] = `w${'rnbqkbnr'[file]}`;
    pieces[`${letter}8`] = `b${'rnbqkbnr'[file]}`;
  }
  return pieces;
}

test('initial board has full castling rights', () => {
  const reader = createBoardReader(startingPieces());
  assert.equal(reader.fen(), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
});

test('double pawn push sets en passant for one position', () => {
  const pieces = startingPieces();
  const reader = createBoardReader(pieces);
  reader.fen();
  delete pieces.e2;
  pieces.e4 = 'wp';
  reader.setPieces(pieces, 1);
  assert.match(reader.fen(), / b KQkq e3 0 1$/);
  delete pieces.e7;
  pieces.e5 = 'bp';
  reader.setPieces(pieces, 2);
  assert.match(reader.fen(), / w KQkq e6 0 1$/);
  delete pieces.g1;
  pieces.f3 = 'wn';
  reader.setPieces(pieces, 3);
  assert.match(reader.fen(), / b KQkq - 0 1$/);
});

test('moving a home rook removes only its castling right', () => {
  const pieces = startingPieces();
  const reader = createBoardReader(pieces);
  reader.fen();
  delete pieces.h1;
  pieces.h3 = 'wr';
  reader.setPieces(pieces, 1);
  assert.match(reader.fen(), / b Qkq - 0 1$/);
  delete pieces.h3;
  pieces.h1 = 'wr';
  reader.setPieces(pieces, 2);
  assert.match(reader.fen(), / w Qkq - 0 1$/);
});

test('a new game restores starting castling rights', () => {
  const reader = createBoardReader(startingPieces());
  reader.fen();
  const moved = startingPieces();
  delete moved.h1;
  moved.h3 = 'wr';
  reader.setPieces(moved, 1);
  assert.match(reader.fen(), / b Qkq - 0 1$/);
  reader.setPieces(startingPieces(), 0);
  assert.match(reader.fen(), / w KQkq - 0 1$/);
});

test('midgame entry does not invent castling rights', () => {
  const pieces = startingPieces();
  delete pieces.e2;
  pieces.e4 = 'wp';
  const reader = createBoardReader(pieces);
  reader.setPieces(pieces, 1);
  assert.match(reader.fen(), / b - - 0 1$/);
});

test('midgame position with unknown turn is not analyzed', () => {
  const pieces = startingPieces();
  delete pieces.e2;
  pieces.e4 = 'wp';
  const reader = createBoardReader(pieces);
  assert.equal(reader.fen(), null);
});

test('incomplete board does not produce an engine position', () => {
  const pieces = startingPieces();
  delete pieces.e8;
  const reader = createBoardReader(pieces);
  assert.equal(reader.fen(), null);
});
