// Subtitle overlay injected into web pages. Appearance comes from chrome.storage (see
// subtitle-styles.js); subtitles and the current language mode come from background.js.

let subtitleContainer = null;
let clearTimer = null;
let subtitleHistory = [];
let settings = { ...LC_SUBTITLE_DEFAULTS };
// Language mode of the running capture, sent along with every subtitle.
let mode = { targetLang: 'none', showBilingual: true };
// UI language, for the speaker labels ("Person 1").
let uiLang = 'en';

const SETTING_KEYS = Object.keys(LC_SUBTITLE_DEFAULTS);

chrome.storage.local.get([...SETTING_KEYS, 'uiLang'], (result) => {
  uiLang = result.uiLang || 'en';
  for (const key of SETTING_KEYS) {
    if (result[key] !== undefined) settings[key] = result[key];
  }
  applyLook();
  applyPosition();
});

// Settings changed in the popup (or a subtitle dragged in another tab): apply right away.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.uiLang) {
    uiLang = changes.uiLang.newValue || 'en';
    renderHistorySubtitles();
  }
  const changed = SETTING_KEYS.filter(key => key in changes);
  if (!changed.length) return;
  for (const key of changed) {
    const value = changes[key].newValue;
    settings[key] = value === undefined ? LC_SUBTITLE_DEFAULTS[key] : value;
  }
  applyLook();
  if (changed.some(k => k === 'subtitlePosition' || k === 'subtitleX' || k === 'subtitleY')) applyPosition();
  if (changed.includes('historyLines')) trimHistory();
  // (speaker label colours depend on the box colour)
  if (['historyLines', 'originalPlacement', 'bgColor', 'bgOpacity'].some(k => changed.includes(k))) renderHistorySubtitles();
  // Unpinning: let the box fade out as usual.
  if (changed.includes('pinSubtitles') && !settings.pinSubtitles) scheduleClear(3000);
});

// Hide the box after `ms`, unless it is pinned.
function scheduleClear(ms) {
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = settings.pinSubtitles ? null : setTimeout(clearSubtitle, ms);
}

function trimHistory() {
  const keep = (parseInt(settings.historyLines) || 0) + 1; // history lines + the latest line
  if (subtitleHistory.length > keep) subtitleHistory = subtitleHistory.slice(-keep);
}

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

// Initialize subtitle overlay
function initSubtitleOverlay() {
  if (document.getElementById('lalt-subtitle-container')) return;

  subtitleContainer = document.createElement('div');
  subtitleContainer.id = 'lalt-subtitle-container';

  // Inject styling directly into the DOM. Values that the user can change are CSS variables
  // set by applyLook().
  const style = document.createElement('style');
  style.textContent = `
    #lalt-subtitle-container {
      position: fixed;
      bottom: 8%;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      width: 85%;
      max-width: 750px;
      box-sizing: border-box;
      padding: 12px 18px;
      background: var(--lalt-bg);
      backdrop-filter: var(--lalt-blur);
      -webkit-backdrop-filter: var(--lalt-blur);
      border: var(--lalt-border);
      border-radius: 12px;
      box-shadow: var(--lalt-shadow);
      text-align: center;
      pointer-events: auto;
      cursor: grab;
      user-select: none;
      display: none;
      opacity: 0;
      transition: opacity 0.25s ease;
      font-family: var(--lalt-font);
    }

    #lalt-subtitle-container:active {
      cursor: grabbing;
    }

    #lalt-subtitle-container.visible {
      opacity: 1;
    }

    .lalt-subtitle-line {
      margin-bottom: 12px;
      transition: opacity 0.25s ease, transform 0.25s ease;
    }

    .lalt-subtitle-line:last-child {
      margin-bottom: 0;
    }

    /* Faded style for history lines */
    .lalt-subtitle-line.history-line {
      opacity: 0.45;
      transform: scale(0.94);
      margin-bottom: 8px;
    }

    .lalt-subtitle-raw-item {
      font-size: var(--lalt-raw-size);
      color: rgba(220, 225, 235, 0.75);
      margin: 2px 0;
      line-height: 1.4;
      text-shadow: var(--lalt-raw-shadow);
      font-weight: 400;
    }

    .lalt-subtitle-zh-item {
      font-size: var(--lalt-main-size);
      color: var(--lalt-color);
      line-height: 1.4;
      text-shadow: var(--lalt-main-shadow);
      font-weight: var(--lalt-weight);
    }

    .lalt-speaker {
      font-weight: 700;
    }
  `;

  document.head.appendChild(style);
  document.body.appendChild(subtitleContainer);
  applyLook();
  applyPosition();

  // Drag to move. The spot is saved, so the box stays there (in every tab) until reset.
  let dragging = false;
  let moved = false;
  let startX, startY, initialX, initialY;

  subtitleContainer.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // Left click only
    const rect = subtitleContainer.getBoundingClientRect();
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    initialX = rect.left;
    initialY = rect.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return; // a click, not a drag
    moved = true;
    const st = subtitleContainer.style;
    st.transform = 'none';
    st.bottom = 'auto';
    st.left = (initialX + dx) + 'px';
    st.top = (initialY + dy) + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    if (!moved) return;
    const rect = subtitleContainer.getBoundingClientRect();
    chrome.storage.local.set({
      subtitlePosition: 'custom',
      subtitleX: rect.left / window.innerWidth,
      subtitleY: rect.top / window.innerHeight
    });
  });

  // Double click: back to the default position at the bottom.
  subtitleContainer.addEventListener('dblclick', () => {
    chrome.storage.local.set({ subtitlePosition: 'bottom' });
  });

  document.addEventListener('fullscreenchange', handleFullscreenChange);
  document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
}

function handleFullscreenChange() {
  if (!subtitleContainer) return;
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  (fullscreenElement || document.body).appendChild(subtitleContainer);
  applyPosition();
}

function applyLook() {
  if (!subtitleContainer) return;
  const look = lcSubtitleLook(settings);
  const vars = {
    '--lalt-bg': look.background,
    '--lalt-border': look.border,
    '--lalt-shadow': look.boxShadow,
    '--lalt-blur': look.backdropFilter,
    '--lalt-color': look.color,
    '--lalt-font': look.fontFamily,
    '--lalt-weight': String(look.fontWeight),
    '--lalt-main-size': look.mainSize + 'px',
    '--lalt-raw-size': look.rawSize + 'px',
    '--lalt-main-shadow': look.mainShadow,
    '--lalt-raw-shadow': look.rawShadow
  };
  for (const [name, value] of Object.entries(vars)) subtitleContainer.style.setProperty(name, value);
}

function applyPosition() {
  if (!subtitleContainer) return;
  const st = subtitleContainer.style;
  const fullscreen = isFullscreen();
  // In fullscreen the box lives inside the fullscreen element, which covers the screen.
  st.position = fullscreen ? 'absolute' : 'fixed';

  if (settings.subtitlePosition === 'custom' && settings.subtitleX !== null && settings.subtitleY !== null) {
    const clamp = (v, max) => Math.min(Math.max(Number(v) || 0, 0), max);
    st.transform = 'none';
    st.bottom = 'auto';
    st.left = clamp(settings.subtitleX, 0.9) * 100 + '%';
    st.top = clamp(settings.subtitleY, 0.92) * 100 + '%';
  } else if (settings.subtitlePosition === 'top') {
    st.transform = 'translateX(-50%)';
    st.left = '50%';
    st.bottom = 'auto';
    st.top = fullscreen ? '6%' : '8%';
  } else {
    st.transform = 'translateX(-50%)';
    st.left = '50%';
    st.top = 'auto';
    st.bottom = fullscreen ? '10%' : '8%';
  }
}

// Render history subtitles based on configurations
function renderHistorySubtitles() {
  if (!subtitleContainer) return;

  subtitleContainer.innerHTML = ''; // Clear previous elements

  // Nothing to show (e.g. a settings change while idle): don't leave an empty box on screen.
  if (subtitleHistory.length === 0) {
    subtitleContainer.classList.remove('visible');
    subtitleContainer.style.display = 'none';
    return;
  }

  const originalBelow = settings.originalPlacement === 'below';

  subtitleHistory.forEach((item, index) => {
    const lineWrapper = document.createElement('div');
    lineWrapper.className = 'lalt-subtitle-line';
    if (index !== subtitleHistory.length - 1) {
      lineWrapper.classList.add('history-line');
    }

    const add = (className, text) => {
      const el = document.createElement('div');
      el.className = className;
      el.textContent = text;
      lineWrapper.appendChild(el);
      return el;
    };
    // The main line gets the speaker label (when speaker detection is on): "Person 2: ..."
    const addMain = (text) => {
      const el = add('lalt-subtitle-zh-item', text);
      if (item.speaker) {
        const label = document.createElement('span');
        label.className = 'lalt-speaker';
        label.textContent = lcTranslate(uiLang, 'speakerLabel', { n: item.speaker });
        label.style.color = lcSpeakerColor(item.speaker, settings);
        el.prepend(label, ' ');
      }
    };

    if (mode.targetLang === 'none') {
      // Only the original, with the main (larger, bolder) styling
      addMain(item.text_raw || item.text_zh);
    } else if (mode.showBilingual && item.text_raw && item.text_raw !== item.text_zh) {
      // Original + translation, in the order chosen in the popup
      if (!originalBelow) add('lalt-subtitle-raw-item', item.text_raw);
      addMain(item.text_zh);
      if (originalBelow) add('lalt-subtitle-raw-item', item.text_raw);
    } else {
      addMain(item.text_zh);
    }

    subtitleContainer.appendChild(lineWrapper);
  });

  subtitleContainer.style.display = 'block';
  subtitleContainer.classList.add('visible');
}

function setMode(message) {
  mode = {
    targetLang: message.targetLang || 'none',
    showBilingual: message.showBilingual !== false
  };
}

// Listen to runtime messages from background.js
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'show-subtitles') {
    initSubtitleOverlay();
    setMode(message);
    subtitleHistory = []; // Reset history queue
    subtitleContainer.innerHTML = '';

    // Push initial status placeholder in the user's UI language
    chrome.storage.local.get(['uiLang'], (result) => {
      const readyText = lcTranslate(result.uiLang || 'en', 'subtitleReady');
      subtitleHistory.push({
        text_raw: mode.targetLang === 'none' ? readyText : '',
        text_zh: readyText,
        placeholder: true
      });
      renderHistorySubtitles();
      scheduleClear(Math.max(4000, settings.minDisplay * 1000));
    });
  }

  if (message.type === 'hide-subtitles') {
    clearSubtitle();
  }

  if (message.type === 'render-subtitle') {
    // The server can send each line twice: first untranslated ({pending: true}), then with its
    // translation. Only show the finished line, so the original never flashes up first.
    if (message.data && message.data.pending) return;
    initSubtitleOverlay();
    setMode(message);

    const data = message.data;
    const line = { text_raw: data.text_raw, text_zh: data.text_zh, duration: data.duration, start: data.start, speaker: data.speaker };

    // Clear initial status placeholders if any
    subtitleHistory = subtitleHistory.filter(item => !item.placeholder);

    // Check for duplicate segment updates (same start time)
    const duplicateIndex = subtitleHistory.findIndex(item => item.start === data.start);
    if (duplicateIndex !== -1) {
      subtitleHistory[duplicateIndex] = line;
    } else {
      subtitleHistory.push(line);
    }
    trimHistory();
    renderHistorySubtitles();

    // Keep the line up for as long as it was spoken plus the extra time, and at least the minimum.
    const shown = (data.duration || 3) + Number(settings.holdTime);
    scheduleClear(Math.max(Number(settings.minDisplay), shown) * 1000);
  }

  if (message.type === 'update-subtitle-mode') {
    initSubtitleOverlay();
    setMode(message);
    renderHistorySubtitles();
  }
});

function clearSubtitle() {
  subtitleHistory = [];
  if (subtitleContainer) {
    subtitleContainer.classList.remove('visible');
    setTimeout(() => {
      // Check if another segment hasn't triggered visibility before hiding
      if (!subtitleContainer.classList.contains('visible')) {
        subtitleContainer.style.display = 'none';
        subtitleContainer.innerHTML = '';
      }
    }, 250);
  }
}
