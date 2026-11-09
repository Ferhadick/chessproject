// content.js — Injected into chess.com game pages
// Reads the board state, computes FEN, requests Stockfish analysis via background/offscreen host, and displays move overlay

(function () {
  'use strict';

  // ─── State ────────────────────────────────────────────────────────────────
  let overlayEl = null;
  let currentFen = null;
  let playerColor = null; // 'white' | 'black'
  let manualPlayerColor = 'auto'; // 'auto' | 'white' | 'black'
  let isEnabled = false;
  let analysisDepth = 15;
  let timeBudgetMs = 0;
  let analysisDelayMs = 350;
  let moveDelayMinMs = 0;
  let moveDelayMaxMs = 0;
  let humanizationLevel = 2; // 0=none, 1=low, 2=medium, 3=high
  let showBoardHighlights = true;
  let showAdvantageBars = true;
  let adaptiveDelay = true;
  let premovesEnabled = false;
  const replyCache = ChessMindAutoPlay.createPredictionCache();
  let qualityTarget = { enabled: false, min: 75, max: 89 };
  const advantageBars = ChessMindAdvantage.create(document, window, getBoardElement, isBoardFlipped);
  let lastComputedMove = null;
  let boardObserver = null;
  let watchedBoard = null;
  let boardCheckTimer = null;
  let analysisTimer = null;
  let analysisGeneration = 0;
  let lastGrid = null;
  let lastPlacement = null;
  let castlingRights = '-';
  let enPassantSquare = '-';
  let lastBoardElement = null;
  let lastMoveCount = 0;
  let lastPieceSignature = null;
  let positionIssue = 'Waiting for board…';
  const START_PLACEMENT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
  const MOVE_SELECTOR = '.move-list-row .node, .game-node-node, [data-whole-move-number] .node';

  let contextRetired = false;
  const RELOAD_MESSAGE = 'Extension updated — refresh this page';
  function contextError(error) {
    return contextRetired || /extension context invalidated/i.test(error?.message || String(error));
  }
  function retireContext() {
    if (contextRetired) return;
    contextRetired = true;
    isEnabled = false;
    invalidateAnalysis();
    clearInterval(boardCheckTimer);
    boardCheckTimer = null;
    clearTimeout(analysisTimer);
    boardObserver?.disconnect();
    boardObserver = null;
    clearHighlights();
    advantageBars.hide();
    autoPlayer.stop(RELOAD_MESSAGE);
    if (overlayEl) {
      overlayEl.querySelectorAll('input, select').forEach(control => {
        control.disabled = true;
        if (control.type === 'checkbox') control.checked = false;
      });
    }
    const wrap = document.getElementById('cm-move-wrap');
    if (wrap) wrap.style.display = 'none';
    setStatus(RELOAD_MESSAGE);
  }
  function extensionAvailable() {
    if (contextRetired) return false;
    try { if (chrome.runtime?.id) return true; } catch { /* Context was unloaded. */ }
    retireContext();
    return false;
  }
  async function extensionOperation(operation) {
    if (!extensionAvailable()) throw new Error(RELOAD_MESSAGE);
    try { return await operation(); }
    catch (error) {
      if (contextError(error)) retireContext();
      throw error;
    }
  }
  function notify(message) {
    // Missing receivers are normal when the popup is closed. The wrapper also
    // catches synchronous throws, which .sendMessage(...).catch() cannot catch.
    extensionOperation(() => chrome.runtime.sendMessage(message)).catch(() => {});
  }
  function saveSettings(settings) {
    extensionOperation(() => chrome.storage.local.set(settings)).catch(error => {
      if (!contextError(error)) console.error('[ChessMind] Could not save settings:', error);
    });
  }

  let researchLog = null;
  let logKey = null;
  let logQueue = Promise.resolve();
  function autoSettings() {
    return { depth: analysisDepth, timeBudgetMs, humanizationLevel, analysisDelayMs, moveDelayMinMs, moveDelayMaxMs, qualityTarget: { ...qualityTarget }, adaptiveDelay, premovesEnabled };
  }
  function gameOutcome() {
    const result = document.querySelector('.game-over-modal-content, .game-over-header-component, .game-over-message-component');
    return result && result.getBoundingClientRect().width > 0 ? result.textContent.trim().slice(0, 500) : null;
  }
  const autoPlayer = ChessMindAutoPlay.create({
    read: () => ({
      url: location.href, board: getBoardElement(), fen: buildFenFromDOM(),
      enabled: isEnabled, hidden: document.hidden, outcome: gameOutcome(),
      player: detectPlayerColor() === 'white' ? 'w' : 'b', settings: autoSettings()
    }),
    click: clickAutoSquare,
    promote: async (color, piece) => {
      const code = `${color}${piece}`;
      const choice = document.querySelector(`.promotion-window .piece.${code}, .promotion-piece.${code}, .promotion-window [data-piece="${code}"]`);
      if (!choice || choice.getBoundingClientRect().width === 0) return false;
      choice.click();
      return true;
    },
    record: event => {
      if (event.type === 'start') {
        logKey = `researchRun:${crypto.randomUUID()}`;
        researchLog = { version: 1, events: [] };
      }
      researchLog.events.push(event);
      const key = logKey;
      const snapshot = JSON.parse(JSON.stringify(researchLog));
      logQueue = logQueue.catch(() => {}).then(() => extensionOperation(() => chrome.storage.local.set({ [key]: snapshot })));
      return logQueue;
    },
    onLogError: error => { if (!contextError(error)) console.error('[ChessMind] Could not save research log:', error); },
    onState: (state, reason) => {
      if (!state.active) replyCache.clear();
      const toggle = document.getElementById('cm-autoplay');
      if (toggle) toggle.checked = state.active;
      publishStatus(reason, state.active ? 'active' : '');
      notify({ type: 'AUTOPLAY_STATE', ...state, reason });
    },
    onReady: () => { invalidateAnalysis(); analyzePosition(); }
  });

  async function clickAutoSquare(square) {
    if (!extensionAvailable()) throw new Error(RELOAD_MESSAGE);
    const board = getBoardElement();
    if (!board || document.hidden) throw new Error('Board is unavailable');
    const rect = board.getBoundingClientRect();
    const coords = getSquareCoords(square, isBoardFlipped(board));
    if (!coords || rect.width === 0 || rect.height === 0) throw new Error('Board is not visible');
    const clientX = rect.left + rect.width * coords.centerX / 100;
    const clientY = rect.top + rect.height * coords.centerY / 100;
    const target = document.elementFromPoint(clientX, clientY);
    if (!target || !board.contains(target)) throw new Error('Board is covered — move the panel and try again');
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const options = { bubbles: true, composed: true, cancelable: true, clientX, clientY,
        button: 0, buttons: type.endsWith('down') ? 1 : 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      target.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, options) : new MouseEvent(type, options));
    }
  }

  async function toggleAutoPlay(value) {
    if (!value) { autoPlayer.stop(); return; }
    if (!extensionAvailable()) throw new Error(RELOAD_MESSAGE);
    await autoPlayer.start();
    invalidateAnalysis();
    analyzePosition();
  }

  function invalidateAnalysis() {
    analysisGeneration++;
    currentFen = null;
    lastComputedMove = null;
  }

  function publishStatus(text, dotClass = 'waiting') {
    setStatus(contextRetired ? RELOAD_MESSAGE : text);
    if (!contextRetired) notify({ type: 'STATUS_UPDATE', text, dotClass });
  }

  // ─── Chess.com board reading ───────────────────────────────────────────────

  function getBoardElement() {
    return (
      document.querySelector('chess-board') ||
      document.querySelector('wc-chess-board') ||
      document.querySelector('.board') ||
      document.querySelector('#board')
    );
  }

  function isBoardFlipped(board) {
    return Boolean(board?.classList.contains('flipped') || board?.closest?.('.flipped') ||
      document.querySelector('.flipped chess-board, .flipped wc-chess-board, #board-layout-chessboard.flipped, .board-layout-main.flipped, .board-layout-chessboard.flipped'));
  }

  function pieceSignature(board) {
    const entries = [];
    board.querySelectorAll('.piece').forEach(el => {
      let square = '';
      let piece = '';
      el.classList.forEach(cls => {
        if (cls.startsWith('square-')) square = cls;
        if (/^[wb][pnbrqk]$/.test(cls)) piece = cls;
      });
      if (square && piece) entries.push(`${square}:${piece}`);
    });
    return entries.sort().join('|');
  }

  /**
   * Detects which color the local player is playing as.
   * Priority:
   * 1. Manual user override (if set to 'white' or 'black')
   * 2. Board flipped classes on board or container
   * 3. Board rank coordinates (if '1' is top or '8' is bottom -> Black)
   * 4. Bottom player profile piece icon (user is always bottom player on chess.com)
   */
  function detectPlayerColor() {
    if (manualPlayerColor && manualPlayerColor !== 'auto') {
      return manualPlayerColor;
    }

    const board = getBoardElement();

    // 1. Direct class check on board or common container elements
    if (isBoardFlipped(board)) return 'black';

    // 2. Coordinate check: in a flipped board, rank 1 is at the top
    const coordElements = document.querySelectorAll(
      '.coordinates text, .coordinates span, text.coordinate-grey, text.coordinate-light, text.coordinate-dark, .coordinate'
    );
    if (coordElements.length > 0 && board) {
      const boardRect = board.getBoundingClientRect();
      for (const el of coordElements) {
        const text = el.textContent.trim();
        const r = el.getBoundingClientRect();
        // If coordinate '1' is in the top 35% of the board -> playing as Black
        if (text === '1' && r.top < boardRect.top + boardRect.height * 0.35) {
          return 'black';
        }
        // If coordinate '8' is in the bottom 35% of the board -> playing as Black
        if (text === '8' && r.top > boardRect.top + boardRect.height * 0.65) {
          return 'black';
        }
        // If coordinate '8' is in the top 35% -> playing as White
        if (text === '8' && r.top < boardRect.top + boardRect.height * 0.35) {
          return 'white';
        }
      }
    }

    // 3. Bottom player profile piece icon / data-color attribute
    // In chess.com, the local player is ALWAYS rendered in the bottom player component
    const bottomPlayer = document.querySelector(
      '.player-component.bottom, .board-layout-player.bottom, [class*="player"][class*="bottom"]'
    );
    if (bottomPlayer) {
      if (
        bottomPlayer.querySelector('.black-pawn, .bp, [data-color="black"]') ||
        bottomPlayer.getAttribute('data-color') === 'black' ||
        bottomPlayer.className.includes('black')
      ) {
        return 'black';
      }
      if (
        bottomPlayer.querySelector('.white-pawn, .wp, [data-color="white"]') ||
        bottomPlayer.getAttribute('data-color') === 'white' ||
        bottomPlayer.className.includes('white')
      ) {
        return 'white';
      }
    }

    // 4. Top player profile (opponent)
    const topPlayer = document.querySelector(
      '.player-component.top, .board-layout-player.top, [class*="player"][class*="top"]'
    );
    if (topPlayer) {
      if (
        topPlayer.querySelector('.white-pawn, .wp, [data-color="white"]') ||
        topPlayer.getAttribute('data-color') === 'white'
      ) {
        return 'black'; // If opponent is White, player is Black
      }
      if (
        topPlayer.querySelector('.black-pawn, .bp, [data-color="black"]') ||
        topPlayer.getAttribute('data-color') === 'black'
      ) {
        return 'white';
      }
    }

    return 'white';
  }

  /**
   * Parses square class which can be numeric (square-54) or algebraic (square-e4).
   * Returns { file: 0..7, rank: 0..7 } or null.
   */
  function parseSquareClass(squareClass) {
    const str = squareClass.replace('square-', '');
    if (str.length !== 2) return null;

    let file, rank;
    const first = str[0].toLowerCase();
    const second = str[1];

    // Numeric format: square-54 -> file 5 (index 4), rank 4 (index 3)
    if (first >= '1' && first <= '8') {
      file = parseInt(first, 10) - 1;
      rank = parseInt(second, 10) - 1;
    }
    // Algebraic format: square-e4 -> file e (index 4), rank 4 (index 3)
    else if (first >= 'a' && first <= 'h') {
      file = first.charCodeAt(0) - 97;
      rank = parseInt(second, 10) - 1;
    } else {
      return null;
    }

    if (file < 0 || file > 7 || rank < 0 || rank > 7 || isNaN(rank)) return null;
    return { file, rank };
  }

  /**
   * Reads piece elements from the chess.com DOM and builds a FEN string.
   */
  function buildFenFromDOM() {
    const board = getBoardElement();
    if (!board) {
      positionIssue = 'Waiting for board…';
      return null;
    }
    if (board !== lastBoardElement) {
      lastBoardElement = board;
      lastGrid = null;
      lastPlacement = null;
      castlingRights = '-';
      enPassantSquare = '-';
      lastMoveCount = 0;
      lastPieceSignature = null;
    }

    // 8x8 grid: ranks 8→1 (top→bottom), files a→h
    const grid = Array.from({ length: 8 }, () => Array(8).fill(null));

    const pieces = board.querySelectorAll('.piece');
    if (pieces.length === 0) {
      positionIssue = 'Waiting for pieces…';
      return null;
    }

    let parsedPieces = 0;
    pieces.forEach((el) => {
      let squareClass = null;
      let pieceCode = null;

      el.classList.forEach((cls) => {
        if (cls.startsWith('square-')) squareClass = cls;
        if (/^[wb][pnbrqk]$/.test(cls)) pieceCode = cls;
      });

      if (!squareClass || !pieceCode) return;

      const parsed = parseSquareClass(squareClass);
      if (!parsed) return;

      // FEN row 0 = rank 8
      parsedPieces++;
      grid[7 - parsed.rank][parsed.file] = pieceCode;
    });

    const allPieces = grid.flat().filter(Boolean);
    if (parsedPieces !== allPieces.length ||
        allPieces.filter(p => p === 'wk').length !== 1 ||
        allPieces.filter(p => p === 'bk').length !== 1 ||
        allPieces.filter(p => p === 'wp').length > 8 ||
        allPieces.filter(p => p === 'bp').length > 8 ||
        allPieces.filter(p => p[0] === 'w').length > 16 ||
        allPieces.filter(p => p[0] === 'b').length > 16 ||
        grid[0].some(p => p?.[1] === 'p') ||
        grid[7].some(p => p?.[1] === 'p')) {
      positionIssue = 'Waiting for a complete position…';
      return null;
    }

    // Build FEN piece placement
    let fenRows = grid.map((row) => {
      let fenRow = '';
      let empty = 0;
      row.forEach((cell) => {
        if (cell === null) {
          empty++;
        } else {
          if (empty > 0) { fenRow += empty; empty = 0; }
          const color = cell[0]; // 'w' or 'b'
          const type = cell[1];  // p/n/b/r/q/k
          fenRow += color === 'w' ? type.toUpperCase() : type.toLowerCase();
        }
      });
      if (empty > 0) fenRow += empty;
      return fenRow;
    });

    const piecePlacement = fenRows.join('/');
    const turn = detectTurn() || (piecePlacement === START_PLACEMENT ? 'w' : null);
    if (!turn) {
      positionIssue = 'Cannot determine whose turn it is';
      return null;
    }
    updatePositionHistory(grid, piecePlacement);
    lastPieceSignature = pieceSignature(board);
    positionIssue = '';
    return `${piecePlacement} ${turn} ${castlingRights} ${enPassantSquare} 0 1`;
  }

  function updatePositionHistory(grid, placement) {
    if (placement === lastPlacement) return;
    const moveCount = document.querySelectorAll(MOVE_SELECTOR).length;
    if (placement === START_PLACEMENT && (!lastGrid || (lastMoveCount > 0 && moveCount === 0))) {
      castlingRights = 'KQkq';
      enPassantSquare = '-';
    } else if (lastGrid) {
      const rights = new Set(castlingRights === '-' ? '' : castlingRights);
      if (lastGrid[7][4] !== grid[7][4]) { rights.delete('K'); rights.delete('Q'); }
      if (lastGrid[0][4] !== grid[0][4]) { rights.delete('k'); rights.delete('q'); }
      if (lastGrid[7][7] !== grid[7][7]) rights.delete('K');
      if (lastGrid[7][0] !== grid[7][0]) rights.delete('Q');
      if (lastGrid[0][7] !== grid[0][7]) rights.delete('k');
      if (lastGrid[0][0] !== grid[0][0]) rights.delete('q');
      castlingRights = 'KQkq'.split('').filter(right => rights.has(right)).join('') || '-';

      enPassantSquare = '-';
      for (let file = 0; file < 8; file++) {
        if (lastGrid[6][file] === 'wp' && grid[6][file] === null && grid[4][file] === 'wp') {
          enPassantSquare = `${String.fromCharCode(97 + file)}3`;
        } else if (lastGrid[1][file] === 'bp' && grid[1][file] === null && grid[3][file] === 'bp') {
          enPassantSquare = `${String.fromCharCode(97 + file)}6`;
        }
      }
    } else {
      // A midgame board has no trustworthy history for castling or en passant.
      castlingRights = '-';
      enPassantSquare = '-';
    }
    lastGrid = grid;
    lastPlacement = placement;
    lastMoveCount = moveCount;
  }

  /**
   * Detects whose turn it is:
   * 1. Inspects the highlighted destination square to see which color moved last.
   * 2. Counts move list nodes (even = White, odd = Black).
   * 3. Checks active clocks relative to top/bottom player color.
   */
  function detectTurn() {
    const board = getBoardElement();

    // 1. Check highlighted square piece (who moved last?)
    if (board) {
      const highlights = board.querySelectorAll('.highlight');
      for (const hl of highlights) {
        let sqClass = null;
        hl.classList.forEach(c => { if (c.startsWith('square-')) sqClass = c; });
        if (sqClass) {
          const pieceOnSquare = board.querySelector(`.piece.${sqClass}`);
          if (pieceOnSquare) {
            let isWhitePiece = false;
            let isBlackPiece = false;
            pieceOnSquare.classList.forEach(c => {
              if (/^w[pnbrqk]$/.test(c)) isWhitePiece = true;
              if (/^b[pnbrqk]$/.test(c)) isBlackPiece = true;
            });
            // If White just moved to a highlight square, it is now Black's turn
            if (isWhitePiece) return 'b';
            // If Black just moved, it is now White's turn
            if (isBlackPiece) return 'w';
          }
        }
      }
    }

    // 2. Count move plies in the move list
    const moveNodes = document.querySelectorAll(MOVE_SELECTOR);
    if (moveNodes.length > 0) {
      // 0 moves = White, 1 move = Black, 2 moves = White, etc.
      return moveNodes.length % 2 === 0 ? 'w' : 'b';
    }

    // 3. Check active clock
    const activeClock = document.querySelector('.clock-player-turn, [class*="clock"][class*="turn"]');
    if (activeClock) {
      const isTop = Boolean(activeClock.closest('.top, .player-component.top, [class*="player"][class*="top"]'));
      const isBottom = Boolean(activeClock.closest('.bottom, .player-component.bottom, [class*="player"][class*="bottom"]'));
      const pColor = detectPlayerColor();
      if (isBottom) return pColor === 'white' ? 'w' : 'b';
      if (isTop) return pColor === 'white' ? 'b' : 'w';
    }

    return null;
  }

  // ─── Overlay UI ───────────────────────────────────────────────────────────

  function createOverlay() {
    if (overlayEl) return;

    overlayEl = document.createElement('div');
    overlayEl.id = 'chessmind-overlay';
    overlayEl.innerHTML = `
      <div class="cm-header">
        <span class="cm-logo">♟ ChessMind</span>
        <button id="cm-color-badge" class="cm-color-badge" title="Playing as (Click to toggle: Auto / White / Black)">Auto ⚪</button>
        <button class="cm-close" title="Hide panel (reopen from popup)" aria-label="Hide board panel">✕</button>
      </div>
      <div class="cm-body">
        <div class="cm-status" id="cm-status">Waiting for game…</div>
        <div class="cm-move-wrap" id="cm-move-wrap" style="display:none">
          <div class="cm-label">Best Move</div>
          <div class="cm-move" id="cm-move">—</div>
          <div class="cm-meta" id="cm-meta"></div>
        </div>
      </div>
      <label class="cm-toggle" style="padding:8px 12px" title="Automatically play suggested moves on this board">
        <input type="checkbox" id="cm-autoplay"> Auto-play <span style="margin-left:auto">Esc to stop</span>
      </label>
      <div class="cm-footer">
        <label class="cm-toggle" title="Enable/disable advisor">
          <input type="checkbox" id="cm-enabled" ${isEnabled ? 'checked' : ''}>
          <span>Active</span>
        </label>
        <label class="cm-toggle" title="Highlight move squares and arrow on board">
          <input type="checkbox" id="cm-highlight" ${showBoardHighlights ? 'checked' : ''}>
          <span>Board</span>
        </label>
        <select id="cm-humanize" ${qualityTarget.enabled ? 'disabled' : ''} title="Engine level (move-quality target overrides this when enabled)">
          <option value="0" ${humanizationLevel===0?'selected':''}>Pure — uncapped</option>
          <option value="4" ${humanizationLevel===4?'selected':''}>Expert — ~2300 Elo</option>
          <option value="1" ${humanizationLevel===1?'selected':''}>Subtle — ~1500 Elo</option>
          <option value="2" ${humanizationLevel===2?'selected':''}>Human — ~1200 Elo</option>
          <option value="3" ${humanizationLevel===3?'selected':''}>Casual — ~900 Elo</option>
        </select>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #chessmind-overlay {
        position: fixed;
        top: 80px;
        right: 20px;
        z-index: 2147483647;
        width: 230px;
        background: #1e1e2e;
        color: #cdd6f4;
        border: 1px solid #313244;
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        font-size: 13px;
        user-select: none;
        box-sizing: border-box;
      }
      #chessmind-overlay * {
        box-sizing: border-box;
      }
      .cm-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px 8px;
        border-bottom: 1px solid #313244;
        cursor: move;
        gap: 6px;
      }
      .cm-logo { font-weight: 700; font-size: 14px; color: #89b4fa; flex: 1; }
      .cm-color-badge {
        background: #313244;
        color: #89b4fa;
        border: 1px solid #45475a;
        border-radius: 6px;
        font-size: 11px;
        padding: 2px 7px;
        cursor: pointer;
        line-height: 1.2;
        transition: background 0.15s;
        font-family: inherit;
      }
      .cm-color-badge:hover {
        background: #45475a;
      }
      .cm-close {
        background: none; border: none; color: #6c7086;
        cursor: pointer; font-size: 14px; padding: 0; line-height: 1;
      }
      .cm-close:hover { color: #f38ba8; }
      .cm-body { padding: 14px 12px; text-align: center; }
      .cm-status { color: #89b4fa; font-size: 12px; }
      .cm-label { font-size: 11px; color: #6c7086; margin-bottom: 6px; text-transform: uppercase; letter-spacing: .06em; }
      .cm-move {
        font-size: 32px;
        font-weight: 800;
        color: #a6e3a1;
        letter-spacing: .04em;
        margin-bottom: 6px;
      }
      .cm-meta { font-size: 11px; color: #9399b2; }
      .cm-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px 10px;
        border-top: 1px solid #313244;
        gap: 6px;
      }
      .cm-toggle { display: flex; align-items: center; gap: 4px; cursor: pointer; font-size: 11px; color: #cdd6f4; }
      .cm-toggle input { accent-color: #89b4fa; cursor: pointer; }
      #cm-humanize {
        background: #313244; color: #cdd6f4; border: 1px solid #45475a;
        border-radius: 6px; font-size: 11px; padding: 3px 5px;
        cursor: pointer; max-width: 130px;
      }
      .cm-thinking {
        display: inline-block;
        animation: cm-pulse 1s infinite;
      }
      @keyframes cm-pulse {
        0%,100% { opacity:1; } 50% { opacity:.3; }
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(overlayEl);

    document.getElementById('cm-autoplay').addEventListener('change', async e => {
      try { await toggleAutoPlay(e.target.checked); }
      catch (error) { e.target.checked = false; publishStatus(error.message, ''); }
    });

    // Close button
    overlayEl.querySelector('.cm-close').addEventListener('click', () => {
      overlayEl.style.display = 'none';
    });

    // Toggle active
    document.getElementById('cm-enabled').addEventListener('change', (e) => {
      isEnabled = e.target.checked;
      saveSettings({ enabled: isEnabled });
      if (isEnabled) startWatching();
      else stopWatching();
    });

    // Toggle board highlights
    document.getElementById('cm-highlight').addEventListener('change', (e) => {
      showBoardHighlights = e.target.checked;
      saveSettings({ showBoardHighlights });
      if (!showBoardHighlights) {
        clearHighlights();
      } else if (lastComputedMove) {
        highlightMoveOnBoard(lastComputedMove);
      }
    });

    // Player color toggle badge
    document.getElementById('cm-color-badge').addEventListener('click', () => {
      if (manualPlayerColor === 'auto') {
        manualPlayerColor = 'white';
      } else if (manualPlayerColor === 'white') {
        manualPlayerColor = 'black';
      } else {
        manualPlayerColor = 'auto';
      }
      saveSettings({ manualPlayerColor });
      updateOverlayPlayerColorBadge();
      currentFen = null;
      clearHighlights();
      analyzePosition();
    });

    // Humanization level
    document.getElementById('cm-humanize').addEventListener('change', (e) => {
      humanizationLevel = parseInt(e.target.value, 10);
      saveSettings({ humanizationLevel });
      invalidateAnalysis();
      analyzePosition();
    });

    // Dragging
    makeDraggable(overlayEl, overlayEl.querySelector('.cm-header'));
    updateOverlayPlayerColorBadge();
  }

  function updateOverlayPlayerColorBadge() {
    const badge = document.getElementById('cm-color-badge');
    if (!badge) return;
    const detected = detectPlayerColor();
    const icon = detected === 'white' ? '⚪' : '⚫';
    if (manualPlayerColor === 'auto') {
      badge.textContent = `Auto ${icon}`;
      badge.style.color = '#89b4fa';
      badge.title = `Auto-detected: ${detected === 'white' ? 'White' : 'Black'} (click to change)`;
    } else if (manualPlayerColor === 'white') {
      badge.textContent = `⚪ White`;
      badge.style.color = '#a6e3a1';
      badge.title = `Locked to White (click to toggle)`;
    } else {
      badge.textContent = `⚫ Black`;
      badge.style.color = '#f38ba8';
      badge.title = `Locked to Black (click to toggle)`;
    }
  }

  function makeDraggable(el, handle) {
    let startX, startY, startLeft, startTop;
    handle.addEventListener('mousedown', (e) => {
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      e.preventDefault();

      const onMove = (ev) => {
        el.style.left = `${startLeft + ev.clientX - startX}px`;
        el.style.top = `${startTop + ev.clientY - startY}px`;
        el.style.right = 'auto';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function setStatus(msg) {
    const el = document.getElementById('cm-status');
    if (el) el.textContent = msg;
  }

  // ─── Board Highlighting (Squares + Arrow) ──────────────────────────────────
  let boardHighlightContainer = null;

  function clearHighlights() {
    if (boardHighlightContainer) {
      boardHighlightContainer.remove();
      boardHighlightContainer = null;
    }
  }

  function getSquareCoords(squareStr, isFlipped) {
    if (!squareStr || squareStr.length < 2) return null;
    const fileChar = squareStr[0].toLowerCase();
    const rankChar = squareStr[1];
    const col = fileChar.charCodeAt(0) - 97; // 0..7
    const row = parseInt(rankChar, 10) - 1;  // 0..7

    if (col < 0 || col > 7 || row < 0 || row > 7 || isNaN(row)) return null;

    let leftPercent, topPercent;
    if (!isFlipped) {
      leftPercent = col * 12.5;
      topPercent = (7 - row) * 12.5;
    } else {
      leftPercent = (7 - col) * 12.5;
      topPercent = row * 12.5;
    }

    return {
      left: leftPercent,
      top: topPercent,
      centerX: leftPercent + 6.25,
      centerY: topPercent + 6.25
    };
  }

  function updateHighlightPosition() {
    const board = getBoardElement();
    if (!board || !boardHighlightContainer) return;
    const rect = board.getBoundingClientRect();
    boardHighlightContainer.style.top = `${rect.top + window.scrollY}px`;
    boardHighlightContainer.style.left = `${rect.left + window.scrollX}px`;
    boardHighlightContainer.style.width = `${rect.width}px`;
    boardHighlightContainer.style.height = `${rect.height}px`;
  }

  window.addEventListener('resize', updateHighlightPosition, { passive: true });
  window.addEventListener('resize', advantageBars.position, { passive: true });
  window.addEventListener('scroll', advantageBars.position, { passive: true });
  window.addEventListener('scroll', updateHighlightPosition, { passive: true });

  function highlightMoveOnBoard(move) {
    lastComputedMove = move;
    clearHighlights();
    if (!showBoardHighlights || !move || move.length < 4) return;

    const board = getBoardElement();
    if (!board) return;

    const rect = board.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const isFlipped = isBoardFlipped(board);
    const fromStr = move.slice(0, 2);
    const toStr = move.slice(2, 4);

    const fromCoords = getSquareCoords(fromStr, isFlipped);
    const toCoords = getSquareCoords(toStr, isFlipped);
    if (!fromCoords || !toCoords) return;

    // Create container appended to document.body so boardObserver is NEVER triggered
    boardHighlightContainer = document.createElement('div');
    boardHighlightContainer.id = 'chessmind-board-highlights';
    boardHighlightContainer.style.cssText = `
      position: absolute;
      top: ${rect.top + window.scrollY}px;
      left: ${rect.left + window.scrollX}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      pointer-events: none;
      z-index: 99999;
      overflow: hidden;
    `;

    // From square highlight (cyan-blue glow)
    const fromEl = document.createElement('div');
    fromEl.className = 'chessmind-sq-highlight chessmind-from';
    fromEl.style.cssText = `
      position: absolute;
      left: ${fromCoords.left}%;
      top: ${fromCoords.top}%;
      width: 12.5%;
      height: 12.5%;
      background: rgba(59, 130, 246, 0.45);
      box-shadow: inset 0 0 0 3px #3b82f6, 0 0 10px rgba(59, 130, 246, 0.6);
      border-radius: 6px;
      pointer-events: none;
      box-sizing: border-box;
    `;

    // To square highlight (bright mint-green glow)
    const toEl = document.createElement('div');
    toEl.className = 'chessmind-sq-highlight chessmind-to';
    toEl.style.cssText = `
      position: absolute;
      left: ${toCoords.left}%;
      top: ${toCoords.top}%;
      width: 12.5%;
      height: 12.5%;
      background: rgba(34, 197, 94, 0.45);
      box-shadow: inset 0 0 0 3px #22c55e, 0 0 10px rgba(34, 197, 94, 0.7);
      border-radius: 6px;
      pointer-events: none;
      box-sizing: border-box;
    `;

    // Arrow SVG overlay
    const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgEl.setAttribute('viewBox', '0 0 100 100');
    svgEl.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none;';

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `
      <filter id="cm-glow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="0" stdDeviation="1.2" flood-color="#000" flood-opacity="0.8"/>
      </filter>
      <marker id="cm-arrowhead" markerWidth="6" markerHeight="6" refX="4.5" refY="3" orient="auto">
        <polygon points="0 0.6, 5.5 3, 0 5.4" fill="#22c55e" />
      </marker>
    `;
    svgEl.appendChild(defs);

    const dx = toCoords.centerX - fromCoords.centerX;
    const dy = toCoords.centerY - fromCoords.centerY;
    const dist = Math.hypot(dx, dy);

    if (dist > 0.01) {
      const startPad = 2.0;
      const endPad = 3.2;
      const x1 = fromCoords.centerX + (dx / dist) * startPad;
      const y1 = fromCoords.centerY + (dy / dist) * startPad;
      const x2 = toCoords.centerX - (dx / dist) * endPad;
      const y2 = toCoords.centerY - (dy / dist) * endPad;

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', `${x1}`);
      line.setAttribute('y1', `${y1}`);
      line.setAttribute('x2', `${x2}`);
      line.setAttribute('y2', `${y2}`);
      line.setAttribute('stroke', '#22c55e');
      line.setAttribute('stroke-width', '2.4');
      line.setAttribute('stroke-linecap', 'round');
      line.setAttribute('marker-end', 'url(#cm-arrowhead)');
      line.setAttribute('filter', 'url(#cm-glow)');
      svgEl.appendChild(line);
    }

    boardHighlightContainer.appendChild(fromEl);
    boardHighlightContainer.appendChild(toEl);
    boardHighlightContainer.appendChild(svgEl);

    document.body.appendChild(boardHighlightContainer);
  }

  function showMove(move, meta = '') {
    const wrap = document.getElementById('cm-move-wrap');
    const moveEl = document.getElementById('cm-move');
    const metaEl = document.getElementById('cm-meta');
    const statusEl = document.getElementById('cm-status');
    if (!wrap || !moveEl) return;

    wrap.style.display = 'block';
    if (statusEl) statusEl.textContent = '';

    const formatted = move
      ? `${move.slice(0, 2)}→${move.slice(2, 4)}${move.length > 4 ? '=' + move[4].toUpperCase() : ''}`
      : '—';

    moveEl.textContent = formatted;
    if (metaEl) metaEl.textContent = meta;

    // Highlight squares and draw arrow on the board
    highlightMoveOnBoard(move);
  }

  function showThinking() {
    clearHighlights();
    const wrap = document.getElementById('cm-move-wrap');
    const moveEl = document.getElementById('cm-move');
    const statusEl = document.getElementById('cm-status');
    if (wrap) wrap.style.display = 'block';
    if (moveEl) moveEl.innerHTML = '<span class="cm-thinking">⋯</span>';
    if (statusEl) statusEl.textContent = '';
    const metaEl = document.getElementById('cm-meta');
    if (metaEl) metaEl.textContent = 'Analyzing…';
  }

  // ─── Board watching ────────────────────────────────────────────────────────

  function startWatching() {
    if (!isEnabled) return;
    if (!boardCheckTimer) {
      boardCheckTimer = setInterval(() => {
        if (!extensionAvailable()) return;
        autoPlayer.monitor();
        advantageBars.position();
        if (getBoardElement() !== watchedBoard) startWatching();
      }, 1500);
    }
    const board = getBoardElement();
    if (!board) {
      boardObserver?.disconnect();
      boardObserver = null;
      watchedBoard = null;
      invalidateAnalysis();
      clearHighlights();
      advantageBars.hide();
      publishStatus('Waiting for board…');
      return;
    }

    watchedBoard = board;
    publishStatus('Watching board…', 'active');
    playerColor = detectPlayerColor();

    if (boardObserver) {
      boardObserver.disconnect();
    }

    boardObserver = new MutationObserver(() => {
      if (!extensionAvailable()) return;
      const signature = pieceSignature(board);
      if (signature !== lastPieceSignature) {
        invalidateAnalysis();
        lastPieceSignature = signature;
        clearHighlights();
        if (showAdvantageBars) advantageBars.show(null);
        publishStatus('Board changed…');
      }
      clearTimeout(analysisTimer);
      analysisTimer = setTimeout(analyzePosition, analysisDelayMs);
    });

    boardObserver.observe(board, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

    analyzePosition();
  }

  function stopWatching() {
    autoPlayer.stop('Advisor paused');
    advantageBars.hide();
    invalidateAnalysis();
    clearInterval(boardCheckTimer);
    boardCheckTimer = null;
    watchedBoard = null;
    clearHighlights();
    if (boardObserver) {
      boardObserver.disconnect();
      boardObserver = null;
    }
    clearTimeout(analysisTimer);
    publishStatus('Paused', '');
    const wrap = document.getElementById('cm-move-wrap');
    if (wrap) wrap.style.display = 'none';
  }

  function analyzePosition() {
    if (!isEnabled || document.hidden || !extensionAvailable()) return;

    const fen = buildFenFromDOM();
    if (!fen) {
      invalidateAnalysis();
      clearHighlights();
      advantageBars.hide();
      publishStatus(positionIssue);
      return;
    }

    if (fen === currentFen) return;
    analysisGeneration++;
    lastComputedMove = null;
    clearHighlights();
    currentFen = fen;

    const turn = fen.split(' ')[1]; // 'w' or 'b'
    playerColor = detectPlayerColor();
    updateOverlayPlayerColorBadge();

    // Evaluate both turns; only show or execute advice on the player's turn.
    const playerTurn = playerColor === 'white' ? 'w' : 'b';
    const isPlayerTurn = turn === playerTurn;
    const automatic = autoPlayer.state().active;
    if (isPlayerTurn && automatic && premovesEnabled) {
      const prepared = replyCache.take(fen, autoSettings());
      if (prepared) {
        if (showAdvantageBars) advantageBars.show(undefined);
        showMove(prepared.move, 'Prepared recapture');
        notify({ type: 'MOVE_UPDATE', move: prepared.move, meta: 'Prepared recapture' });
        autoPlayer.suggest(fen, prepared.move, 0, { ...autoSettings(), preparedReply: true,
          predictedOpponentMove: prepared.predictedOpponentMove });
        return;
      }
    }
    if (showAdvantageBars) advantageBars.show(null);
    if (!isPlayerTurn) {
      clearHighlights();
      publishStatus(`Waiting for opponent (${playerColor === 'white' ? 'Black' : 'White'})…`);
      const wrap = document.getElementById('cm-move-wrap');
      if (wrap) wrap.style.display = 'none';
      if (!showAdvantageBars && !(automatic && premovesEnabled)) return;
    } else {
      showThinking();
      publishStatus('Analyzing…', 'waiting');
    }
    const generation = ++analysisGeneration;
    const analysisStarted = performance.now();
    const settings = autoSettings();

    // Send position to background / offscreen Stockfish runner
    extensionOperation(() => new Promise((resolve, reject) => chrome.runtime.sendMessage(
      {
        type: 'ANALYZE_POSITION',
        fen,
        depth: analysisDepth,
        timeBudgetMs,
        humanizationLevel: isPlayerTurn ? humanizationLevel : 0,
        qualityTarget: isPlayerTurn ? qualityTarget : null,
        hints: { adaptiveDelay: automatic && adaptiveDelay, wantPrediction: !isPlayerTurn && automatic && premovesEnabled }
      },
      (response) => {
        try {
          if (!extensionAvailable()) { reject(new Error(RELOAD_MESSAGE)); return; }
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(response);
        } catch (error) { reject(error); }
      }
    ))).then(response => {
        if (!isEnabled || generation !== analysisGeneration || fen !== currentFen) return;
        if (!response || !response.success) {
          autoPlayer.stop('Engine error — stopped auto-play');
          if (showAdvantageBars) advantageBars.show(undefined);
          publishStatus('Engine error — try Refresh', '');
          console.error('[ChessMind]', response?.error);
          return;
        }

        if (showAdvantageBars) advantageBars.show(response.evaluation ?? undefined);
        if (!isPlayerTurn) {
          if (autoPlayer.state().active && premovesEnabled && response.prediction) {
            replyCache.put(response.prediction, settings);
            publishStatus('Prepared recapture ready; waiting for opponent');
          }
          return;
        }
        showMove(response.move, response.meta);
        publishStatus(response.move ? 'Suggestion ready' : 'No legal move', response.move ? 'active' : '');

        // Update popup if open
        notify({
          type: 'MOVE_UPDATE',
          move: response.move,
          meta: response.meta
        });
        autoPlayer.suggest(fen, response.move, Math.round(performance.now() - analysisStarted), { ...settings, moveQuality: response.moveQuality, difficulty: response.difficulty });
    }).catch(error => {
      if (contextError(error) || !isEnabled || generation !== analysisGeneration) return;
      autoPlayer.stop('Engine error — stopped auto-play');
      if (showAdvantageBars) advantageBars.show(undefined);
      publishStatus('Engine error — try Refresh', '');
      console.error('[ChessMind]', error);
    });
  }

  // ─── Message listener (from popup) ─────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SET_AUTOPLAY') {
      toggleAutoPlay(Boolean(message.value))
        .then(() => sendResponse({ ok: true, ...autoPlayer.state() }))
        .catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'REQUEST_FEN') {
      sendResponse({
        fen: buildFenFromDOM(),
        playerColor: detectPlayerColor(),
        turn: detectTurn(),
      });
      return true;
    }
    if (message.type === 'GET_LIVE_STATE') {
      const fen = buildFenFromDOM();
      const pColor = detectPlayerColor();
      const turn = fen ? fen.split(' ')[1] : null;
      const isMyTurn = turn === (pColor === 'white' ? 'w' : 'b');
      const levelLabels = ['Pure engine · uncapped', 'Subtle · ~1500 Elo', 'Human-like · ~1200 Elo', 'Casual · ~900 Elo', 'Expert · ~2300 Elo'];
      sendResponse({
        fen,
        autoPlay: autoPlayer.state(),
        autoPlayAllowed: ChessMindAutoPlay.isSupportedPage(location.href),
        playerColor: pColor,
        isMyTurn,
        lastMove: isEnabled && isMyTurn && fen === currentFen ? lastComputedMove : null,
        meta: levelLabels[humanizationLevel],
        status: fen ? (isMyTurn ? 'Your turn' : `Waiting for opponent (${pColor === 'white' ? 'Black' : 'White'})…`) : positionIssue
      });
      return true;
    }
    if (message.type === 'FORCE_ANALYZE') {
      replyCache.clear();
      invalidateAnalysis();
      analyzePosition();
      sendResponse({ ok: true });
    }
    if (message.type === 'SHOW_OVERLAY') {
      if (overlayEl) overlayEl.style.display = '';
      sendResponse({ ok: Boolean(overlayEl) });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !overlayEl) return;
    if (changes.enabled && changes.enabled.newValue !== isEnabled) {
      isEnabled = Boolean(changes.enabled.newValue);
      const toggle = document.getElementById('cm-enabled');
      if (toggle) toggle.checked = isEnabled;
      if (isEnabled) startWatching();
      else stopWatching();
    }
    let analysisSettingsChanged = false;
    if (['enabled', 'depth', 'timeBudgetMs', 'humanizationLevel', 'qualityTarget', 'manualPlayerColor',
      'moveDelayMinMs', 'moveDelayMaxMs', 'adaptiveDelay', 'premovesEnabled'].some(key => changes[key])) replyCache.clear();
    if (changes.adaptiveDelay) { adaptiveDelay = changes.adaptiveDelay.newValue !== false; analysisSettingsChanged = true; }
    if (changes.premovesEnabled) { premovesEnabled = changes.premovesEnabled.newValue === true; analysisSettingsChanged = true; }
    if (changes.qualityTarget) {
      qualityTarget = changes.qualityTarget.newValue || { enabled: false, min: 75, max: 89 };
      analysisSettingsChanged = true;
      const select = document.getElementById('cm-humanize');
      if (select) { select.disabled = Boolean(qualityTarget.enabled); select.title = qualityTarget.enabled ? 'Move-quality target is active; change it in the popup' : 'Engine level'; }
    }
    if (changes.humanizationLevel && changes.humanizationLevel.newValue !== humanizationLevel) {
      humanizationLevel = changes.humanizationLevel.newValue;
      const select = document.getElementById('cm-humanize');
      if (select) select.value = humanizationLevel;
      analysisSettingsChanged = true;
    }
    if (changes.depth && changes.depth.newValue !== analysisDepth) {
      analysisDepth = changes.depth.newValue;
      analysisSettingsChanged = true;
    }
    if (changes.timeBudgetMs && changes.timeBudgetMs.newValue !== timeBudgetMs) {
      timeBudgetMs = changes.timeBudgetMs.newValue ?? 0;
      analysisSettingsChanged = true;
    }
    if (changes.moveDelayMinMs) moveDelayMinMs = changes.moveDelayMinMs.newValue ?? 0;
    if (changes.moveDelayMaxMs) moveDelayMaxMs = changes.moveDelayMaxMs.newValue ?? 0;
    if (changes.analysisDelayMs) analysisDelayMs = changes.analysisDelayMs.newValue ?? 350;
    if (analysisSettingsChanged) {
      clearTimeout(analysisTimer);
      invalidateAnalysis();
      analyzePosition();
    }
    if (changes.showAdvantageBars) {
      showAdvantageBars = changes.showAdvantageBars.newValue !== false;
      if (!showAdvantageBars) advantageBars.hide();
      invalidateAnalysis();
      analyzePosition();
    }
    if (changes.showBoardHighlights && changes.showBoardHighlights.newValue !== showBoardHighlights) {
      showBoardHighlights = Boolean(changes.showBoardHighlights.newValue);
      const toggle = document.getElementById('cm-highlight');
      if (toggle) toggle.checked = showBoardHighlights;
      if (showBoardHighlights && lastComputedMove) highlightMoveOnBoard(lastComputedMove);
      else clearHighlights();
    }
    if (changes.manualPlayerColor && changes.manualPlayerColor.newValue !== manualPlayerColor) {
      manualPlayerColor = changes.manualPlayerColor.newValue;
      updateOverlayPlayerColorBadge();
      invalidateAnalysis();
      analyzePosition();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!isEnabled) return;
    invalidateAnalysis();
    clearHighlights();
    if (document.hidden) { autoPlayer.stop('Tab hidden'); publishStatus('Paused in background tab', ''); }
    else analyzePosition();
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') autoPlayer.stop();
  });
  document.addEventListener('pointerdown', event => {
    if (event.isTrusted && !overlayEl?.contains(event.target)) autoPlayer.stop('Manual page interaction');
  }, true);
  window.addEventListener('pagehide', () => autoPlayer.stop('Page closed'));

  // ─── Init ──────────────────────────────────────────────────────────────────

  function init() {
    extensionOperation(() => chrome.storage.local.get(['enabled', 'humanizationLevel', 'depth', 'showBoardHighlights', 'manualPlayerColor', 'timeBudgetMs', 'analysisDelayMs', 'analysisPreset', 'moveDelayMinMs', 'moveDelayMaxMs', 'showAdvantageBars', 'qualityTarget', 'adaptiveDelay', 'premovesEnabled'])).then(data => {
      if (contextRetired) return;
      isEnabled = data.enabled ?? false;
      humanizationLevel = data.humanizationLevel ?? 2;
      analysisDepth = data.depth ?? 15;
      timeBudgetMs = data.timeBudgetMs ?? 0;
      analysisDelayMs = data.analysisDelayMs ?? 350;
      ({ moveDelayMinMs, moveDelayMaxMs } = ChessMindAutoPlay.delayRange(data.analysisPreset, data.moveDelayMinMs, data.moveDelayMaxMs));
      showBoardHighlights = data.showBoardHighlights ?? true;
      showAdvantageBars = data.showAdvantageBars ?? true;
      adaptiveDelay = data.adaptiveDelay !== false;
      premovesEnabled = data.premovesEnabled === true;
      qualityTarget = data.qualityTarget || { enabled: false, min: 75, max: 89 };
      manualPlayerColor = data.manualPlayerColor ?? 'auto';

      createOverlay();
      if (isEnabled) startWatching();
    }).catch(error => {
      if (!contextError(error)) console.error('[ChessMind] Initialization failed:', error);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
