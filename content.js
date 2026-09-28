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
  let humanizationLevel = 2; // 0=none, 1=low, 2=medium, 3=high
  let showBoardHighlights = true;
  let lastComputedMove = null;
  let boardObserver = null;
  let analysisTimer = null;

  // ─── Chess.com board reading ───────────────────────────────────────────────

  function getBoardElement() {
    return (
      document.querySelector('chess-board') ||
      document.querySelector('wc-chess-board') ||
      document.querySelector('.board') ||
      document.querySelector('#board')
    );
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
    if (board?.classList.contains('flipped')) return 'black';

    const flippedParent = document.querySelector(
      '.flipped chess-board, .flipped wc-chess-board, #board-layout-chessboard.flipped, .board-layout-main.flipped, .board-layout-chessboard.flipped, [class*="board"][class*="flipped"]'
    );
    if (flippedParent) return 'black';

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
    if (!board) return null;

    // 8x8 grid: ranks 8→1 (top→bottom), files a→h
    const grid = Array.from({ length: 8 }, () => Array(8).fill(null));

    const pieces = board.querySelectorAll('.piece');
    if (pieces.length === 0) return null;

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
      grid[7 - parsed.rank][parsed.file] = pieceCode;
    });

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
    const turn = detectTurn();

    return `${piecePlacement} ${turn} KQkq - 0 1`;
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
    const moveNodes = document.querySelectorAll(
      '.move-list-row .node, .game-node-node, [data-whole-move-number] .node, .node:not(.icon-font-chess):not(.icon-font)'
    );
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

    // Opening position defaults to White
    return 'w';
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
        <button class="cm-close" title="Close">✕</button>
      </div>
      <div class="cm-body">
        <div class="cm-status" id="cm-status">Waiting for game…</div>
        <div class="cm-move-wrap" id="cm-move-wrap" style="display:none">
          <div class="cm-label">Best Move</div>
          <div class="cm-move" id="cm-move">—</div>
          <div class="cm-meta" id="cm-meta"></div>
        </div>
      </div>
      <div class="cm-footer">
        <label class="cm-toggle" title="Enable/disable advisor">
          <input type="checkbox" id="cm-enabled" ${isEnabled ? 'checked' : ''}>
          <span>Active</span>
        </label>
        <label class="cm-toggle" title="Highlight move squares and arrow on board">
          <input type="checkbox" id="cm-highlight" ${showBoardHighlights ? 'checked' : ''}>
          <span>Board</span>
        </label>
        <select id="cm-humanize" title="Humanization level">
          <option value="0" ${humanizationLevel===0?'selected':''}>Pure</option>
          <option value="1" ${humanizationLevel===1?'selected':''}>Subtle</option>
          <option value="2" ${humanizationLevel===2?'selected':''}>Human</option>
          <option value="3" ${humanizationLevel===3?'selected':''}>Casual</option>
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
        cursor: pointer; max-width: 72px;
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

    // Close button
    overlayEl.querySelector('.cm-close').addEventListener('click', () => {
      overlayEl.style.display = 'none';
    });

    // Toggle active
    document.getElementById('cm-enabled').addEventListener('change', (e) => {
      isEnabled = e.target.checked;
      chrome.storage.local.set({ enabled: isEnabled });
      if (isEnabled) startWatching();
      else stopWatching();
    });

    // Toggle board highlights
    document.getElementById('cm-highlight').addEventListener('change', (e) => {
      showBoardHighlights = e.target.checked;
      chrome.storage.local.set({ showBoardHighlights });
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
      chrome.storage.local.set({ manualPlayerColor });
      updateOverlayPlayerColorBadge();
      currentFen = null;
      clearHighlights();
      analyzePosition();
    });

    // Humanization level
    document.getElementById('cm-humanize').addEventListener('change', (e) => {
      humanizationLevel = parseInt(e.target.value, 10);
      chrome.storage.local.set({ humanizationLevel });
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
  window.addEventListener('scroll', updateHighlightPosition, { passive: true });

  function highlightMoveOnBoard(move) {
    lastComputedMove = move;
    clearHighlights();
    if (!showBoardHighlights || !move || move.length < 4) return;

    const board = getBoardElement();
    if (!board) return;

    const rect = board.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const isFlipped = board.classList.contains('flipped');
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
    const board = getBoardElement();
    if (!board) {
      setStatus('Waiting for board…');
      setTimeout(startWatching, 1000);
      return;
    }

    setStatus('Watching board…');
    playerColor = detectPlayerColor();

    if (boardObserver) {
      boardObserver.disconnect();
    }

    boardObserver = new MutationObserver(() => {
      clearHighlights();
      clearTimeout(analysisTimer);
      analysisTimer = setTimeout(analyzePosition, 350);
    });

    boardObserver.observe(board, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

    analyzePosition();
  }

  function stopWatching() {
    clearHighlights();
    if (boardObserver) {
      boardObserver.disconnect();
      boardObserver = null;
    }
    clearTimeout(analysisTimer);
    setStatus('Paused');
    const wrap = document.getElementById('cm-move-wrap');
    if (wrap) wrap.style.display = 'none';
  }

  function analyzePosition() {
    if (!isEnabled) return;

    const fen = buildFenFromDOM();
    if (!fen) {
      setStatus('Waiting for board…');
      return;
    }

    if (fen === currentFen) return;
    currentFen = fen;

    const turn = fen.split(' ')[1]; // 'w' or 'b'
    playerColor = detectPlayerColor();
    updateOverlayPlayerColorBadge();

    // Check if it's the player's turn
    const playerTurn = playerColor === 'white' ? 'w' : 'b';
    if (turn !== playerTurn) {
      clearHighlights();
      setStatus(`Waiting for opponent (${playerColor === 'white' ? 'Black' : 'White'})…`);
      const wrap = document.getElementById('cm-move-wrap');
      if (wrap) wrap.style.display = 'none';
      return;
    }

    showThinking();

    // Send position to background / offscreen Stockfish runner
    chrome.runtime.sendMessage(
      {
        type: 'ANALYZE_POSITION',
        fen,
        depth: analysisDepth,
        humanizationLevel
      },
      (response) => {
        if (chrome.runtime.lastError || !response || !response.success) {
          setStatus('Engine error');
          console.error('[ChessMind]', chrome.runtime.lastError || response?.error);
          return;
        }

        showMove(response.move, response.meta);

        // Update popup if open
        chrome.runtime.sendMessage({
          type: 'MOVE_UPDATE',
          move: response.move,
          meta: response.meta
        }).catch(() => {});
      }
    );
  }

  // ─── Message listener (from popup) ─────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
      const levelLabels = ['Pure engine', 'Subtle', 'Human-like', 'Casual'];
      sendResponse({
        fen,
        playerColor: pColor,
        isMyTurn,
        lastMove: isMyTurn ? lastComputedMove : null,
        meta: levelLabels[humanizationLevel],
        status: isMyTurn ? 'Your turn' : `Waiting for opponent (${pColor === 'white' ? 'Black' : 'White'})…`
      });
      return true;
    }
    if (message.type === 'SET_ENABLED') {
      isEnabled = message.value;
      if (isEnabled) startWatching();
      else stopWatching();
      const cb = document.getElementById('cm-enabled');
      if (cb) cb.checked = isEnabled;
    }
    if (message.type === 'SET_HUMANIZE') {
      humanizationLevel = message.value;
      const sel = document.getElementById('cm-humanize');
      if (sel) sel.value = humanizationLevel;
    }
    if (message.type === 'SET_DEPTH') {
      analysisDepth = message.value;
    }
    if (message.type === 'SET_HIGHLIGHT') {
      showBoardHighlights = message.value;
      const cb = document.getElementById('cm-highlight');
      if (cb) cb.checked = showBoardHighlights;
      if (!showBoardHighlights) {
        clearHighlights();
      } else if (lastComputedMove) {
        highlightMoveOnBoard(lastComputedMove);
      }
    }
    if (message.type === 'FORCE_ANALYZE') {
      currentFen = null;
      analyzePosition();
    }
  });

  // ─── Init ──────────────────────────────────────────────────────────────────

  function init() {
    chrome.storage.local.get(['enabled', 'humanizationLevel', 'depth', 'showBoardHighlights', 'manualPlayerColor'], (data) => {
      isEnabled = data.enabled ?? false;
      humanizationLevel = data.humanizationLevel ?? 2;
      analysisDepth = data.depth ?? 15;
      showBoardHighlights = data.showBoardHighlights ?? true;
      manualPlayerColor = data.manualPlayerColor ?? 'auto';

      createOverlay();
      if (isEnabled) startWatching();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 1000);
  }
})();
