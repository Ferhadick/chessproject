// popup.js — Controls the popup UI and communicates with content script

const enabledToggle = document.getElementById('enabledToggle');
const advantageToggle = document.getElementById('advantageToggle');
advantageToggle.addEventListener('change', () => chrome.storage.local.set({ showAdvantageBars: advantageToggle.checked }));
const highlightToggle = document.getElementById('highlightToggle');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const adaptiveDelayToggle = document.getElementById('adaptiveDelayToggle');
const premoveToggle = document.getElementById('premoveToggle');
adaptiveDelayToggle.addEventListener('change', () => chrome.storage.local.set({ adaptiveDelay: adaptiveDelayToggle.checked }));
premoveToggle.addEventListener('change', () => chrome.storage.local.set({ premovesEnabled: premoveToggle.checked }));
const autoPlayToggle = document.getElementById('autoPlayToggle');
const autoPlayStatus = document.getElementById('autoPlayStatus');
const exportResearchBtn = document.getElementById('exportResearchBtn');
autoPlayToggle.addEventListener('change', () => {
  const value = autoPlayToggle.checked;
  autoPlayToggle.disabled = true;
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (!tabs[0]?.id) { autoPlayToggle.checked = false; autoPlayStatus.textContent = 'Open a chess board first'; return; }
    chrome.tabs.sendMessage(tabs[0].id, { type: 'SET_AUTOPLAY', value }, response => {
      const error = chrome.runtime.lastError;
      autoPlayToggle.disabled = false;
      autoPlayToggle.checked = Boolean(response?.active);
      autoPlayStatus.textContent = error?.message || response?.error || (response?.active ? 'Auto-play active · Esc to stop' : 'Auto-play off');
    });
  });
});
exportResearchBtn.addEventListener('click', async () => {
  try {
    const data = await chrome.storage.local.get(null);
    const runs = Object.entries(data).filter(([key]) => key.startsWith('researchRun:'))
      .map(([id, run]) => ({ id, ...run }));
    if (!runs.length) { autoPlayStatus.textContent = 'No research logs yet'; return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, runs }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `chessmind-research-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { autoPlayStatus.textContent = `Export failed: ${error.message}`; }
});
const moveDisplay = document.getElementById('moveDisplay');
const moveSub = document.getElementById('moveSub');
const PRESETS = {
  bullet: { depth: 12, timeBudgetMs: 250, analysisDelayMs: 80, ...ChessMindAutoPlay.PRESET_DELAYS.bullet },
  blitz: { depth: 18, timeBudgetMs: 1000, analysisDelayMs: 150, ...ChessMindAutoPlay.PRESET_DELAYS.blitz },
  rapid: { depth: 20, timeBudgetMs: 3000, analysisDelayMs: 250, ...ChessMindAutoPlay.PRESET_DELAYS.rapid }
};
const PRESET_HELP = {
  custom: 'Adjust settings individually.',
  bullet: 'Depth 12 · up to 0.25s · move delay 0.15–0.6s.',
  blitz: 'Depth 18 · up to 1s · move delay 0.5–1.8s.',
  rapid: 'Depth 20 · up to 3s · move delay 1.5–5s.'
};
const presetSelect = document.getElementById('presetSelect');
const presetHelp = document.getElementById('presetHelp');
const moveDelayMin = document.getElementById('moveDelayMin');
const moveDelayMax = document.getElementById('moveDelayMax');
const moveDelayHelp = document.getElementById('moveDelayHelp');
function displayMoveDelay(settings) {
  moveDelayMin.value = settings.moveDelayMinMs / 1000;
  moveDelayMax.value = settings.moveDelayMaxMs / 1000;
}
for (const input of [moveDelayMin, moveDelayMax]) input.addEventListener('change', () => {
  const min = Number(moveDelayMin.value), max = Number(moveDelayMax.value);
  if (moveDelayMin.value === '' || moveDelayMax.value === '' || !Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max > 30 || min > max) {
    moveDelayHelp.textContent = 'Enter a range from 0 to 30 seconds, with minimum no larger than maximum.';
    return;
  }
  chrome.storage.local.set({ moveDelayMinMs: Math.round(min * 1000), moveDelayMaxMs: Math.round(max * 1000) });
  moveDelayHelp.textContent = 'Saved. Applies to the next suggestion; analysis limits stay unchanged.';
});
const timeBudgetSelect = document.getElementById('timeBudgetSelect');
function showPreset(value) {
  presetSelect.value = PRESETS[value] ? value : 'custom';
  presetHelp.textContent = PRESET_HELP[presetSelect.value];
}
function saveCustom(settings) {
  showPreset('custom');
  chrome.storage.local.set({ ...settings, analysisPreset: 'custom' });
}
presetSelect.addEventListener('change', () => {
  const preset = PRESETS[presetSelect.value];
  showPreset(presetSelect.value);
  if (!preset) {
    chrome.storage.local.set({ analysisPreset: 'custom' });
    return;
  }
  depthSelect.value = preset.depth;
  timeBudgetSelect.value = preset.timeBudgetMs;
  displayMoveDelay(preset);
  chrome.storage.local.set({ ...preset, analysisPreset: presetSelect.value });
});
timeBudgetSelect.addEventListener('change', () => {
  saveCustom({ timeBudgetMs: Number(timeBudgetSelect.value) });
});
const qualityToggle = document.getElementById('qualityToggle');
const qualityMin = document.getElementById('qualityMin');
const qualityMax = document.getElementById('qualityMax');
for (const control of [qualityToggle, qualityMin, qualityMax]) control.addEventListener('change', () => {
  const min = Number(qualityMin.value), max = Number(qualityMax.value);
  if (qualityMin.value === '' || qualityMax.value === '' || !Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max > 100 || min > max) {
    document.getElementById('qualityHelp').textContent = 'Enter a range from 0 to 100 with minimum no greater than maximum.';
    return;
  }
  profileSelect.disabled = qualityToggle.checked;
  chrome.storage.local.set({ qualityTarget: { enabled: qualityToggle.checked, min, max } });
  document.getElementById('qualityHelp').textContent = 'Saved. Internal estimate, not Chess.com accuracy. Overrides engine level while on; preserves depth and time limits. Advantage protection can exceed the range. No win guarantee.';
});
const profileSelect = document.getElementById('profileSelect');
const depthSelect = document.getElementById('depthSelect');
const refreshBtn = document.getElementById('refreshBtn');
const showPanelBtn = document.getElementById('showPanelBtn');
let activeTabId = null;
let boardAvailable = false;
let contentAvailable = false;

// ─── Load saved settings ────────────────────────────────────────────────────
chrome.storage.local.get(['enabled', 'humanizationLevel', 'depth', 'showBoardHighlights', 'analysisPreset', 'timeBudgetMs', 'moveDelayMinMs', 'moveDelayMaxMs', 'showAdvantageBars', 'qualityTarget', 'adaptiveDelay', 'premovesEnabled'], (data) => {
  const enabled = data.enabled ?? false;
  const level = data.humanizationLevel ?? 2;
  const depth = data.depth ?? 15;
  const showHighlights = data.showBoardHighlights ?? true;

  enabledToggle.checked = enabled;
  adaptiveDelayToggle.checked = data.adaptiveDelay !== false;
  premoveToggle.checked = data.premovesEnabled === true;
  advantageToggle.checked = data.showAdvantageBars ?? true;
  if (highlightToggle) highlightToggle.checked = showHighlights;
  profileSelect.value = level;
  qualityToggle.checked = Boolean(data.qualityTarget?.enabled);
  qualityMin.value = data.qualityTarget?.min ?? 75;
  qualityMax.value = data.qualityTarget?.max ?? 89;
  profileSelect.disabled = qualityToggle.checked;
  depthSelect.value = depth;
  timeBudgetSelect.value = data.timeBudgetMs ?? 0;
  showPreset(data.analysisPreset);
  displayMoveDelay(ChessMindAutoPlay.delayRange(data.analysisPreset, data.moveDelayMinMs, data.moveDelayMaxMs));

  updateStatusUI(enabled);

  // Query live game state from active tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      activeTabId = tabs[0].id;
      chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_LIVE_STATE' }, (res) => {
        if (chrome.runtime.lastError || !res) {
          showConnectionError();
          return;
        }

        autoPlayToggle.disabled = !res.autoPlayAllowed;
        autoPlayToggle.checked = Boolean(res.autoPlay?.active);
        autoPlayStatus.textContent = res.autoPlay?.active ? 'Auto-play active · Esc to stop' :
          res.autoPlayAllowed ? 'Auto-play off · enable the advisor first' : 'Open a supported chess board for auto-play';
        contentAvailable = true;
        showPanelBtn.disabled = false;
        if (!res.fen) {
          statusText.textContent = res.status || 'Waiting for board…';
          statusDot.className = 'status-dot waiting';
          moveSub.textContent = res.status || 'Waiting for board…';
          refreshBtn.disabled = true;
          return;
        }

        boardAvailable = true;
        refreshBtn.disabled = !enabled;
        if (!enabled) return;
        statusText.textContent = res.status;
        statusDot.className = 'status-dot ' + (res.isMyTurn ? 'active' : 'waiting');
        if (res.isMyTurn && res.lastMove) {
          showMoveInPopup(res.lastMove, res.meta || '');
        } else if (res.status) {
          moveDisplay.textContent = '—';
          moveDisplay.className = 'move-big';
          moveSub.textContent = res.status;
        }
      });
    } else {
      showConnectionError();
    }
  });
});

// ─── Toggle enabled ─────────────────────────────────────────────────────────
enabledToggle.addEventListener('change', () => {
  const enabled = enabledToggle.checked;
  chrome.storage.local.set({ enabled });
  updateStatusUI(enabled);
});

// ─── Toggle highlight on board ──────────────────────────────────────────────
if (highlightToggle) {
  highlightToggle.addEventListener('change', () => {
    const showBoardHighlights = highlightToggle.checked;
    chrome.storage.local.set({ showBoardHighlights });
  });
}

// ─── Move style ──────────────────────────────────────────────────────────────
profileSelect.addEventListener('change', () => {
  const level = parseInt(profileSelect.value, 10);
  chrome.storage.local.set({ humanizationLevel: level });
});

// ─── Depth select ─────────────────────────────────────────────────────────────
depthSelect.addEventListener('change', () => {
  const depth = parseInt(depthSelect.value, 10);
  saveCustom({ depth });
});

// ─── Refresh button ──────────────────────────────────────────────────────────
refreshBtn.addEventListener('click', () => {
  if (!enabledToggle.checked) return;
  moveDisplay.textContent = '⋯';
  moveDisplay.className = 'move-big thinking';
  moveSub.textContent = 'Analyzing…';
  sendToContent({ type: 'FORCE_ANALYZE' }, showConnectionError);
});

showPanelBtn.addEventListener('click', () => {
  sendToContent({ type: 'SHOW_OVERLAY' }, showConnectionError);
});

// ─── Listen for move updates from content script ─────────────────────────────
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.tab?.id !== activeTabId) return;
  if (message.type === 'AUTOPLAY_STATE') {
    autoPlayToggle.checked = message.active;
    autoPlayStatus.textContent = message.reason;
  }
  if (message.type === 'MOVE_UPDATE') {
    showMoveInPopup(message.move, message.meta || '');
    chrome.storage.local.set({ lastMove: message.move, lastMeta: message.meta });
  }
  if (message.type === 'STATUS_UPDATE') {
    if (message.text === 'Watching board…' || message.text === 'Board changed…' ||
        message.text === 'Analyzing…' || message.text === 'Suggestion ready' ||
        message.text === 'No legal move' || message.text.startsWith('Engine error') ||
        message.text.startsWith('Waiting for opponent')) boardAvailable = true;
    if (message.text.startsWith('Waiting for board') ||
        message.text.startsWith('Waiting for pieces') ||
        message.text.startsWith('Waiting for a complete position') ||
        message.text.startsWith('Cannot determine')) boardAvailable = false;
    refreshBtn.disabled = !enabledToggle.checked || !boardAvailable;
    statusText.textContent = message.text;
    statusDot.className = 'status-dot ' + (message.dotClass || '');
    if (message.text === 'Analyzing…') {
      moveDisplay.textContent = '⋯';
      moveDisplay.className = 'move-big thinking';
      moveSub.textContent = 'Analyzing current position';
    } else if (message.text.startsWith('Engine error')) {
      moveDisplay.textContent = '—';
      moveDisplay.className = 'move-big';
      moveSub.textContent = 'Try Refresh';
    } else if (message.text !== 'Suggestion ready') {
      moveDisplay.textContent = '—';
      moveDisplay.className = 'move-big';
      moveSub.textContent = message.text;
    }
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
  refreshBtn.disabled = !enabled || !boardAvailable;
  showPanelBtn.disabled = !contentAvailable;
  if (enabled) {
    statusDot.className = 'status-dot ' + (boardAvailable ? 'active' : '');
    statusText.textContent = boardAvailable ? 'Active — watching board' : 'Checking for board…';
  } else {
    statusDot.className = 'status-dot';
    statusText.textContent = 'Disabled';
    moveDisplay.textContent = '—';
    moveDisplay.className = 'move-big';
    moveSub.textContent = 'Enable the advisor to start';
  }
}

function showConnectionError() {
  boardAvailable = false;
  contentAvailable = false;
  autoPlayToggle.disabled = true;
  autoPlayToggle.checked = false;
  statusText.textContent = 'No supported board found';
  statusDot.className = 'status-dot';
  moveDisplay.textContent = '—';
  moveDisplay.className = 'move-big';
  moveSub.textContent = 'Open a supported chess board to use the advisor';
  refreshBtn.disabled = true;
  showPanelBtn.disabled = true;
}

function sendToContent(message, onError = null) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]?.id) { onError?.(); return; }
    chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
      if (chrome.runtime.lastError || !response?.ok) onError?.();
    });
  });
}
