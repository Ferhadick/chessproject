(function (root) {
  function describe(evaluation, color) {
    if (evaluation === null) return { label: 'Evaluating…', share: 50 };
    if (!evaluation || !Number.isFinite(evaluation.value)) return { label: 'Evaluation unavailable', share: 50 };
    if (evaluation.type === 'mate') {
      const winning = evaluation.winningColor === color;
      return { label: evaluation.value === 0 ? (winning ? 'Checkmate' : 'Checkmated') : `${winning ? 'Mate' : 'Facing mate'} in ${Math.abs(evaluation.value)}`, share: winning ? 100 : 0 };
    }
    if (evaluation.type !== 'cp') return { label: 'Evaluation unavailable', share: 50 };
    const score = evaluation.value * (color === 'b' ? -1 : 1);
    return {
      label: Math.abs(score) < 10 ? 'Equal' : `${score > 0 ? 'Ahead' : 'Behind'} ${score > 0 ? '+' : '−'}${(Math.abs(score) / 100).toFixed(1)}`,
      share: Math.max(2, Math.min(98, 50 + 50 * Math.tanh(score / 400)))
    };
  }
  function create(document, window, getBoard, isFlipped) {
    let nodes = [];
    let evaluation = null;
    function position() {
      const board = getBoard();
      if (!board || !nodes.length) return;
      const rect = board.getBoundingClientRect();
      if (!rect.width || !rect.height) { nodes.forEach(node => { node.style.display = 'none'; }); return; }
      const flipped = isFlipped(board);
      nodes.forEach((node, index) => {
        const side = index === 0 ? 'top' : 'bottom';
        const anchor = document.querySelector(`.player-component.${side}, .board-layout-player.${side}, [class*="player"][class*="${side}"]`);
        const name = anchor?.querySelector('.user-username-component, [class*="username"]');
        const nameRect = name?.getBoundingClientRect();
        const row = anchor?.getBoundingClientRect();
        const x = nameRect?.width ? nameRect.right + 10 : rect.left + rect.width * 0.48;
        const y = row?.height ? row.top + (row.height - 32) / 2 : (index === 0 ? rect.top - 36 : rect.bottom + 5);
        node.style.left = `${Math.max(4, Math.min(window.innerWidth - 166, x))}px`;
        node.style.top = `${Math.max(4, Math.min(window.innerHeight - 36, y))}px`;
        node.style.display = '';
        const color = index === 0 ? (flipped ? 'w' : 'b') : (flipped ? 'b' : 'w');
        const display = describe(evaluation, color);
        node.querySelector('.cm-eval-text').textContent = `${color === 'w' ? 'White' : 'Black'} · ${display.label}`;
        node.querySelector('.cm-eval-fill').style.width = `${display.share}%`;
        node.title = `Engine evaluation in pawns${evaluation?.depth ? ` · depth ${evaluation.depth}` : ''}. Bar length is an advantage scale, not a win probability.`;
      });
    }
    function hide() { nodes.forEach(node => node.remove()); nodes = []; evaluation = null; }
    function show(value) {
      evaluation = value;
      if (!nodes.length) for (let i = 0; i < 2; i++) {
        const node = document.createElement('div');
        node.className = 'chessmind-advantage';
        node.setAttribute('role', 'status');
        node.setAttribute('aria-live', 'polite');
        node.style.cssText = 'position:fixed;z-index:99998;width:158px;padding:5px 7px;background:#1e1e2e;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;font:11px system-ui;pointer-events:none;box-sizing:border-box;';
        const text = document.createElement('div'); text.className = 'cm-eval-text';
        const track = document.createElement('div'); track.style.cssText = 'height:4px;background:#45475a;margin-top:4px;overflow:hidden;border-radius:2px;';
        const fill = document.createElement('div'); fill.className = 'cm-eval-fill'; fill.style.cssText = 'height:100%;background:#a6e3a1;transition:width .25s;';
        track.appendChild(fill); node.appendChild(text); node.appendChild(track);
        document.body.appendChild(node); nodes.push(node);
      }
      position();
    }
    return { show, hide, position };
  }
  const api = { describe, create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChessMindAdvantage = api;
})(globalThis);
