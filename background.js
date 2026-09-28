// background.js — Service Worker
// Manages offscreen Stockfish host and message routing

let creatingOffscreenPromise = null;

async function ensureOffscreen() {
  try {
    if ('hasDocument' in chrome.offscreen) {
      if (await chrome.offscreen.hasDocument()) return;
    } else if (chrome.runtime.getContexts) {
      const existing = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
      });
      if (existing && existing.length > 0) return;
    }
  } catch (e) {
    // Fall through to creation
  }

  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }

  creatingOffscreenPromise = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Run Stockfish chess engine in a dedicated worker environment'
  });

  try {
    await creatingOffscreenPromise;
  } catch (err) {
    if (!err.message?.includes('Only a single offscreen document')) {
      console.error('[ChessMind Background] Error creating offscreen doc:', err);
    }
  } finally {
    creatingOffscreenPromise = null;
  }
}

// Pre-create offscreen on startup or install
chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreen().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreen().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ANALYZE_POSITION') {
    (async () => {
      try {
        await ensureOffscreen();
        chrome.runtime.sendMessage(
          { ...message, type: 'RUN_STOCKFISH' },
          (response) => {
            if (chrome.runtime.lastError) {
              sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else {
              sendResponse(response || { success: false, error: 'No response from engine' });
            }
          }
        );
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open for async response
  }

  if (message.type === 'GET_ANALYSIS') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'REQUEST_FEN' }, (response) => {
          sendResponse(response);
        });
      }
    });
    return true;
  }
});
