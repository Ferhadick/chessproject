// popup.js — Controls the popup UI and communicates with content script

const humanizeLabels = ['Engine pure', 'Subtle', 'Human-like', 'Casual', 'Expert ~2300'];

const enabledToggle = document.getElementById('enabledToggle');
const highlightToggle = document.getElementById('highlightToggle');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const moveDisplay = document.getElementById('moveDisplay');
const moveSub = document.getElementById('moveSub');
const humanizeSlider = document.getElementById('humanizeSlider');
const humanizeLabel = document.getElementById('humanizeLabel');
const depthSelect = document.getElementById('depthSelect');
const refreshBtn = document.getElementById('refreshBtn');

// ─── Load saved settings ────────────────────────────────────────────────────
chrome.storage.local.get(['enabled', 'humanizationLevel', 'depth', 'showBoardHighlights'], (data) => {
  const enabled = data.enabled ?? false;
  const level = data.humanizationLevel ?? 2;
  const depth = data.depth ?? 15;
  const showHighlights = data.showBoardHighlights ?? true;

  enabledToggle.checked = enabled;
  if (highlightToggle) highlightToggle.checked = showHighlights;
  humanizeSlider.value = level;
  humanizeLabel.textContent = humanizeLabels[level];
  depthSelect.value = depth;

  updateStatusUI(enabled);

  // Query live game state from active tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_LIVE_STATE' }, (res) => {
        if (chrome.runtime.lastError || !res) return;

        if (res.isMyTurn && res.lastMove) {
          showMoveInPopup(res.lastMove, res.meta || '');
        } else if (res.status) {
          moveDisplay.textContent = '—';
          moveDisplay.className = 'move-big';
          moveSub.textContent = res.status;
        }
      });
    }
  });
});

// ─── Toggle enabled ─────────────────────────────────────────────────────────
enabledToggle.addEventListener('change', () => {
  const enabled = enabledToggle.checked;
  chrome.storage.local.set({ enabled });
  updateStatusUI(enabled);
  sendToContent({ type: 'SET_ENABLED', value: enabled });
});

// ─── Toggle highlight on board ──────────────────────────────────────────────
if (highlightToggle) {
  highlightToggle.addEventListener('change', () => {
    const showBoardHighlights = highlightToggle.checked;
    chrome.storage.local.set({ showBoardHighlights });
    sendToContent({ type: 'SET_HIGHLIGHT', value: showBoardHighlights });
  });
}

// ─── Humanization slider ─────────────────────────────────────────────────────
humanizeSlider.addEventListener('input', () => {
  const level = parseInt(humanizeSlider.value, 10);
  humanizeLabel.textContent = humanizeLabels[level];
  chrome.storage.local.set({ humanizationLevel: level });
  sendToContent({ type: 'SET_HUMANIZE', value: level });
});

// ─── Depth select ─────────────────────────────────────────────────────────────
depthSelect.addEventListener('change', () => {
  const depth = parseInt(depthSelect.value, 10);
  chrome.storage.local.set({ depth });
  sendToContent({ type: 'SET_DEPTH', value: depth });
});

// ─── Refresh button ──────────────────────────────────────────────────────────
refreshBtn.addEventListener('click', () => {
  moveDisplay.textContent = '⋯';
  moveDisplay.className = 'move-big thinking';
  moveSub.textContent = 'Analyzing…';
  sendToContent({ type: 'FORCE_ANALYZE' });
});

// ─── Listen for move updates from content script ─────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'MOVE_UPDATE') {
    showMoveInPopup(message.move, message.meta || '');
    chrome.storage.local.set({ lastMove: message.move, lastMeta: message.meta });
  }
  if (message.type === 'STATUS_UPDATE') {
    statusText.textContent = message.text;
    statusDot.className = 'status-dot ' + (message.dotClass || '');
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function showMoveInPopup(move, meta) {
  if (!move || move === 'null') {
    moveDisplay.textContent = '—';
    moveDisplay.className = 'move-big';
    moveSub.textContent = 'No move available';
    return;
  }
  const formatted = `${move.slice(0, 2)}→${move.slice(2, 4)}${move.length > 4 ? '=' + move[4].toUpperCase() : ''}`;
  moveDisplay.textContent = formatted;
  moveDisplay.className = 'move-big';
  moveSub.textContent = meta || '';
}

function updateStatusUI(enabled) {
  if (enabled) {
    statusDot.className = 'status-dot active';
    statusText.textContent = 'Active — watching board';
  } else {
    statusDot.className = 'status-dot';
    statusText.textContent = 'Disabled';
    moveDisplay.textContent = '—';
    moveDisplay.className = 'move-big';
    moveSub.textContent = 'Enable the advisor to start';
  }
}

function sendToContent(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, message).catch(() => {});
    }
  });
}
