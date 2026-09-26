let isCapturing = false;
let isConnected = false;
let activeTabId = null;
// Language mode of the running capture, sent along with every subtitle.
let captureMode = { targetLang: 'none', showBilingual: true };

// The service worker is suspended when idle and restarted on the next message,
// which resets these variables. Restore them from storage before answering.
const stateReady = chrome.storage.local.get(['isCapturing', 'isConnected', 'activeTabId', 'captureMode']).then((result) => {
  isCapturing = result.isCapturing || false;
  isConnected = result.isConnected || false;
  activeTabId = result.activeTabId || null;
  captureMode = result.captureMode || captureMode;
  return chrome.offscreen.hasDocument();
}).then(hasDoc => setBadge(hasDoc));

// "ON" on the toolbar icon while captions are running.
function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
}

function setCaptureMode(targetLang, showBilingual) {
  captureMode = { targetLang: targetLang || 'none', showBilingual: showBilingual !== false };
  chrome.storage.local.set({ captureMode });
}

// ---------------------------------------------------------------------------
// Keyboard shortcut (chrome://extensions/shortcuts): start/stop on the current tab
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-captions') return;
  await stateReady;
  if (await chrome.offscreen.hasDocument()) {
    await stopCapture();
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    // Allowed here because a keyboard shortcut counts as the user invoking the extension.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    await startCapture(streamId, tab.id);
  } catch (err) {
    // e.g. chrome:// pages, which can't be captured
    console.warn('Shortcut could not start captions on this tab:', err);
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    setTimeout(() => setBadge(false), 2500);
  }
});

// Listen to messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'get-status') {
    stateReady.then(() => chrome.offscreen.hasDocument()).then(hasDoc => {
      // The offscreen document only exists while capturing, so it is the source of truth.
      isCapturing = hasDoc;
      setBadge(hasDoc);
      if (!hasDoc) {
        isConnected = false;
        activeTabId = null;
        chrome.storage.local.set({ isCapturing: false, isConnected: false, activeTabId: null });
      }
      sendResponse({ isCapturing, isConnected });
    });
    return true;
  }

  if (message.type === 'lm-model') {
    handleModelAction(message).then(sendResponse);
    return true;
  }
  
  if (message.type === 'start-capture') {
    startCapture(message.streamId, message.tabId).then(() => sendResponse({ success: true }));
    return true;
  }
  
  if (message.type === 'stop-capture') {
    stopCapture().then(() => sendResponse({ success: true }));
    return true;
  }
  
  if (message.type === 'update-config') {
    // Forward config updates to offscreen if active
    chrome.offscreen.hasDocument().then(hasDoc => {
      if (hasDoc) {
        setCaptureMode(message.config.targetLang, message.config.showBilingual);
        chrome.runtime.sendMessage({
          type: 'update-config',
          target: 'offscreen',
          config: message.config
        });
        
        const tabId = activeTabId;
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: 'update-subtitle-mode',
            targetLang: message.config.targetLang,
            showBilingual: message.config.showBilingual
          }).catch(() => {});
        }
      }
    });
    sendResponse({ success: true });
    return true;
  }
  
  // Messages from Offscreen
  if (message.target === 'background') {
    if (message.type === 'websocket-connected') {
      isConnected = true;
      chrome.storage.local.set({ isConnected: true });
    }
    
    if (message.type === 'websocket-disconnected') {
      isConnected = false;
      chrome.storage.local.set({ isConnected: false });
    }
    
    if (message.type === 'subtitle-data') {
      // Forward subtitle translation to content script in the active tab
      stateReady.then(async () => {
        const tabId = activeTabId;
        if (!tabId) return;
        chrome.tabs.sendMessage(tabId, {
          type: 'render-subtitle',
          data: message.data,
          targetLang: captureMode.targetLang,
          showBilingual: captureMode.showBilingual
        }).catch(err => {
          console.warn("Failed to send subtitle to content script (tab might have been closed or reloaded):", err);
        });
        // Only after the line is on its way to the page, so this never delays a subtitle.
        if (message.data.timing && !message.data.pending) recordLiveStats(message.data.timing);
      });
    }

    if (message.type === 'offscreen-error') {
      console.error("Offscreen capture error:", message.error);
      stopCapture();
    }
  }
});

// Speed / latency of the last line, for the popup's status card. `timing` comes from the server
// (see timing_summary in live_translate_server.py); the server and the browser share this PC's clock,
// so "now - speech_end" is the full round trip: speech end -> subtitle delivered to the page.
let liveStats = null;
function recordLiveStats(timing) {
  const roundTrip = Math.max(0, Date.now() - timing.speech_end);
  const prev = liveStats || {};
  liveStats = {
    ...timing,
    roundTrip,
    delivery: Math.max(0, roundTrip - timing.server),
    recent: [...(prev.recent || []), roundTrip].slice(-10),
    // Lines that don't need the LLM (already in the target language) keep the model's last speed.
    modelTps: timing.tps !== undefined ? timing.tps : prev.modelTps,
    at: Date.now()
  };
  chrome.storage.local.set({ liveStats });
}

function clearLiveStats() {
  liveStats = null;
  chrome.storage.local.remove('liveStats');
}

async function startCapture(streamId, tabId) {
  clearLiveStats();
  const hasDoc = await chrome.offscreen.hasDocument();
  if (hasDoc) {
    console.log("Offscreen document already exists. Stopping before restarting...");
    await stopCapture();
  }
  
  try {
    activeTabId = tabId;
    isCapturing = true;
    await chrome.storage.local.set({ isCapturing: true, activeTabId: tabId });
    
    // 3. Load config from storage
    const storage = await chrome.storage.local.get(['llmProvider', 'lmstudioUrl', 'ollamaUrl', 'modelName', 'deepseekKey', 'minSilence', 'maxSpeech', 'vadThreshold', 'showBilingual', 'sourceLang', 'targetLang', 'asrEngine', 'saveTranscripts', 'detectSpeakers', 'speakerThreshold', 'qwencloudUrl', 'qwencloudKey']);
    const config = {
      llmProvider: storage.llmProvider || 'lmstudio',
      lmstudioUrl: storage.lmstudioUrl || 'http://127.0.0.1:1234',
      ollamaUrl: (storage.ollamaUrl === 'http://localhost:11434' || !storage.ollamaUrl) ? 'http://127.0.0.1:11434' : storage.ollamaUrl,
      modelName: storage.modelName || '',
      deepseekKey: storage.deepseekKey || '',
      qwencloudUrl: storage.qwencloudUrl || 'https://maas.qwencloudapi.com',
      qwencloudKey: storage.qwencloudKey || '',
      minSilence: storage.minSilence !== undefined ? storage.minSilence : 0.5,
      maxSpeech: storage.maxSpeech !== undefined ? storage.maxSpeech : 6.0,
      vadThreshold: storage.vadThreshold !== undefined ? storage.vadThreshold : 0.4,
      sourceLang: storage.sourceLang || 'auto',
      targetLang: storage.targetLang || 'none',
      asrEngine: storage.asrEngine || 'sensevoice',
      saveTranscripts: storage.saveTranscripts === true,
      detectSpeakers: storage.detectSpeakers === true,
      speakerThreshold: storage.speakerThreshold !== undefined ? storage.speakerThreshold : 0.5
    };
    const showBilingual = storage.showBilingual !== false;
    setCaptureMode(config.targetLang, showBilingual);
    setBadge(true);
    
    // 4. Create Offscreen Document if it doesn't exist
    const hasDocument = await chrome.offscreen.hasDocument();
    if (!hasDocument) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: 'Capture tab audio for real-time speech transcription'
      });
    }
    
    // 5. Tell Content Script to show/reset subtitles overlay
    chrome.tabs.sendMessage(activeTabId, { 
      type: 'show-subtitles',
      targetLang: config.targetLang,
      showBilingual: showBilingual
    }).catch(() => {
      // Content script might not be loaded yet, ignoring
    });
    
    // 6. Tell Offscreen Document to start recording and connect WebSocket
    // We add a tiny delay to ensure the offscreen document is ready to listen
    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'init-recording',
        target: 'offscreen',
        streamId: streamId,
        config: config
      });
    }, 300);
    
    console.log(`Started tab audio capture on tab: ${activeTabId}`);
    
  } catch (err) {
    console.error("Failed to start capture:", err);
    setBadge(false);
    isCapturing = false;
    isConnected = false;
    activeTabId = null;
    await chrome.storage.local.set({ isCapturing: false, isConnected: false, activeTabId: null });
  }
}

async function stopCapture() {
  clearLiveStats();
  try {
    // 1. Close Offscreen Document
    const hasDocument = await chrome.offscreen.hasDocument();
    if (hasDocument) {
      await chrome.offscreen.closeDocument();
    }
    
    // 2. Tell Content Script to hide subtitles
    const tabId = activeTabId;
    if (tabId) {
      chrome.tabs.sendMessage(tabId, { type: 'hide-subtitles' }).catch(() => {});
    }
    
  } catch (err) {
    console.error("Failed to stop capture safely:", err);
  } finally {
    isCapturing = false;
    isConnected = false;
    activeTabId = null;
    setBadge(false);
    await chrome.storage.local.set({ isCapturing: false, isConnected: false, activeTabId: null });
    console.log("Stopped tab audio capture");
  }
}

// ---------------------------------------------------------------------------
// LM Studio model management (load / eject). This runs in the service worker
// rather than the popup so a load keeps going after the popup is closed. The
// popup follows progress through `lmModelState` in storage.
// ---------------------------------------------------------------------------

async function lmFetch(base, path, body) {
  const init = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined;
  const res = await fetch(base + path, init);
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch (e) {}
  if (!res.ok) {
    const err = data.error && (data.error.message || data.error);
    throw new Error(typeof err === 'string' ? err : (text || `HTTP ${res.status}`));
  }
  return data;
}

function setModelState(state) {
  return chrome.storage.local.set({ lmModelState: { ...state, ts: Date.now() } });
}

let modelQueue = Promise.resolve();

function handleModelAction(message) {
  // One action at a time, so quickly changing the dropdown can't load several models at once.
  const run = modelQueue.then(() => runModelAction(message));
  modelQueue = run.catch(() => {});
  return run;
}

async function runModelAction({ action, base, model, contextLength }) {
  try {
    const { models } = await lmFetch(base, '/api/v1/models');
    const llms = (models || []).filter(m => m.type === 'llm');
    const instances = llms.flatMap(m => m.loaded_instances.map(inst => ({ key: m.key, inst })));

    if (action === 'load') {
      await setModelState({ status: 'loading', model, contextLength });
      // Keep one matching instance; loading the same model again would create a second copy.
      const keep = instances.find(({ key, inst }) => key === model && inst.config?.context_length === contextLength);
      // Only one translation model at a time, so it always has the whole GPU.
      for (const { inst } of instances) {
        if (keep && inst === keep.inst) continue;
        await lmFetch(base, '/api/v1/models/unload', { instance_id: inst.id });
      }
      if (!keep) {
        await lmFetch(base, '/api/v1/models/load', { model, context_length: contextLength, flash_attention: true });
      }
      await setModelState({ status: 'loaded', model, contextLength });
    } else if (action === 'unload') {
      await setModelState({ status: 'unloading', model });
      for (const { key, inst } of instances) {
        if (key === model) await lmFetch(base, '/api/v1/models/unload', { instance_id: inst.id });
      }
      await setModelState({ status: 'idle', model });
    }
    return { ok: true };
  } catch (e) {
    console.warn(`Model ${action} failed:`, e);
    await setModelState({ status: 'error', model, error: e.message });
    return { ok: false, error: e.message };
  }
}
