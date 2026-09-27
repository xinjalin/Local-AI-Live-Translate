let mediaStream = null;
let audioContext = null;
let playbackContext = null;
let processor = null;
let ws = null;
let config = {};
let reconnectTimer = null;
let reconnectDelay = 1000;
let sentConfig = '';
let configTimer = null;
// Saved API keys (cloud.js), read here - not passed around in messages - for the app server config.
let apiKeys = {};
const keysReady = loadApiKeys();

async function loadApiKeys() {
  try {
    apiKeys = await LcApiKeys.all();
  } catch (e) {
    apiKeys = {};
    console.warn('Could not read the saved API keys');
  }
}

// Must not be an async function: a listener that returns a Promise counts as a
// reply in Chrome, so it would answer messages meant for the background worker
// (e.g. the popup's 'get-status') with `undefined`.
chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== 'offscreen') return;

  if (message.type === 'init-recording') {
    config = message.config;
    startRecording(message.streamId);
  }

  if (message.type === 'update-config') {
    config = message.config;
    queueConfig();
  }

  if (message.type === 'api-keys-changed') {
    loadApiKeys().then(queueConfig);
  }
});

async function startRecording(streamId) {
  try {
    // Proactively clean up any previous recording resources/connections
    cleanup();
    
    // Wait 200ms to allow Chrome to release previous streams
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // 1. Capture stream with retry logic
    const maxRetries = 3;
    let attempt = 0;
    
    while (attempt < maxRetries) {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: 'tab',
              chromeMediaSourceId: streamId
            }
          }
        });
        break; // Success, exit retry loop
      } catch (err) {
        attempt++;
        console.warn(`Attempt ${attempt} to capture tab audio failed:`, err);
        if (attempt >= maxRetries) {
          throw err; // Re-throw error if all retries failed
        }
        // Wait 300ms before retrying
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    
    // 2. Play original audio stream back to user so they hear it
    playbackContext = new AudioContext();
    const playbackSource = playbackContext.createMediaStreamSource(mediaStream);
    playbackSource.connect(playbackContext.destination);
    
    // 3. Connect to WebSocket backend
    connectWebSocket();
    
    // 4. Downsample captured stream to 16kHz for SenseVoice ASR
    audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(mediaStream);
    
    // Buffer size of 4096 frames
    processor = audioContext.createScriptProcessor(4096, 1, 1);
    
    source.connect(processor);
    processor.connect(audioContext.destination); // Required to trigger onaudioprocess
    
    processor.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      
      const inputData = e.inputBuffer.getChannelData(0); // Float32 Array
      
      // Convert Float32 to 16-bit PCM (Int16)
      const int16Buffer = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        let s = Math.max(-1, Math.min(1, inputData[i]));
        int16Buffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      
      // Send binary data over WS
      ws.send(int16Buffer.buffer);
    };
    
  } catch (err) {
    console.error("Offscreen capture failure:", err);
    chrome.runtime.sendMessage({
      target: 'background',
      type: 'offscreen-error',
      error: err.message
    });
  }
}

function connectWebSocket() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  
  // Hardcoded to localhost backend (as we want offline/local security)
  ws = new WebSocket('ws://127.0.0.1:8000/stream');
  
  ws.onopen = () => {
    console.log("WebSocket backend connected successfully.");
    reconnectDelay = 1000; // Reset delay
    chrome.runtime.sendMessage({
      target: 'background',
      type: 'websocket-connected'
    });
    
    // Send configuration instantly after connection opens
    sendConfigToBackend();
  };
  
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.event === 'subtitle') {
        // Forward ASR & translation subtitles to background worker
        chrome.runtime.sendMessage({
          target: 'background',
          type: 'subtitle-data',
          data: data
        });
      }
    } catch (e) {
      console.warn("Failed to parse backend message:", e);
    }
  };
  
  ws.onclose = () => {
    console.warn("WebSocket closed.");
    chrome.runtime.sendMessage({
      target: 'background',
      type: 'websocket-disconnected'
    });
    
    // Attempt auto-reconnect if capture is active
    if (mediaStream) {
      console.log(`WebSocket disconnected. Retrying in ${reconnectDelay / 1000}s...`);
      reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 16000);
        connectWebSocket();
      }, reconnectDelay);
    }
  };
  
  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
  };
}

// The popup sends its settings on every change, including the subtitle look (dozens of times a
// second while a colour or slider is dragged). The server only gets its own settings, and only
// once they have changed and stopped changing.
function queueConfig() {
  clearTimeout(configTimer);
  configTimer = null;
  if (JSON.stringify(backendConfig()) !== sentConfig) configTimer = setTimeout(sendConfigToBackend, 300);
}

async function sendConfigToBackend() {
  clearTimeout(configTimer);
  configTimer = null;
  await keysReady;
  if (ws && ws.readyState === WebSocket.OPEN) {
    sentConfig = JSON.stringify(backendConfig());
    ws.send(sentConfig);
  }
}

function backendConfig() {
  // An online provider (and its key) only while cloud providers are turned on in the popup; the
  // key goes to the app server on this PC, which sends it only to that provider.
  const cloud = config.cloudEnabled === true && lcIsCloudProvider(config.llmProvider);
  const provider = cloud || config.llmProvider === 'ollama' ? config.llmProvider : 'lmstudio';
  return {
    event: 'config',
    llm_provider: provider,
    llm_url: provider === 'qwencloud' ? lcQwenEndpoint(config.qwencloudUrl)
      : provider === 'ollama' ? config.ollamaUrl : cloud ? '' : config.lmstudioUrl,
    api_key: cloud ? apiKeys[provider] || '' : '',
    model_name: provider === config.llmProvider ? config.modelName : config.lmstudioModel || '',
    min_silence: config.minSilence,
    max_speech: config.maxSpeech,
    vad_threshold: config.vadThreshold !== undefined ? config.vadThreshold : 0.4,
    source_lang: config.sourceLang,
    target_lang: config.targetLang,
    asr_engine: config.asrEngine,
    save_transcript: config.saveTranscripts === true,
    detect_speakers: config.detectSpeakers === true,
    speaker_threshold: config.speakerThreshold !== undefined ? config.speakerThreshold : 0.5,
    prompt_template: config.promptTemplate || 'auto'
  };
}

// Ensure cleanup on window unload
window.addEventListener('unload', () => {
  cleanup();
});

function cleanup() {
  console.log("Cleaning up offscreen contexts...");
  
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectDelay = 1000;
  
  if (processor) {
    try {
      processor.disconnect();
    } catch (e) {
      console.warn("Error disconnecting processor:", e);
    }
    processor = null;
  }
  
  if (audioContext) {
    try {
      audioContext.close();
    } catch (e) {
      console.warn("Error closing audioContext:", e);
    }
    audioContext = null;
  }
  
  if (playbackContext) {
    try {
      playbackContext.close();
    } catch (e) {
      console.warn("Error closing playbackContext:", e);
    }
    playbackContext = null;
  }
  
  if (mediaStream) {
    try {
      mediaStream.getTracks().forEach(track => {
        try {
          track.stop();
        } catch (err) {
          console.warn("Error stopping track:", err);
        }
      });
    } catch (e) {
      console.warn("Error stopping mediaStream tracks:", e);
    }
    mediaStream = null;
  }
  
  if (ws) {
    try {
      ws.close();
    } catch (e) {
      console.warn("Error closing WebSocket:", e);
    }
    ws = null;
  }
}
