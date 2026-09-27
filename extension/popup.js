// Elements
const toggleBtn = document.getElementById('toggle-btn');
const connectionStatus = document.getElementById('connection-status');
const captureStatus = document.getElementById('capture-status');
const llmProviderInput = document.getElementById('llm-provider');
const lmstudioUrlInput = document.getElementById('lmstudio-url');
const ollamaUrlInput = document.getElementById('ollama-url');
const modelNameInput = document.getElementById('model-name');
const refreshModelsBtn = document.getElementById('refresh-models');
const modelStatusEl = document.getElementById('model-status');
const deepseekKeyInput = document.getElementById('deepseek-key');
const qwenUrlInput = document.getElementById('qwencloud-url');
const qwenKeyInput = document.getElementById('qwencloud-key');
const qwenModelInput = document.getElementById('qwencloud-model');
const minSilenceInput = document.getElementById('min-silence');
const maxSpeechInput = document.getElementById('max-speech');
const uiLangInput = document.getElementById('ui-lang');
const sourceLangInput = document.getElementById('source-lang');
const targetLangInput = document.getElementById('target-lang');
const showBilingualInput = document.getElementById('show-bilingual');
const bgColorInput = document.getElementById('bg-color');
const textColorInput = document.getElementById('text-color');
const fontSizeInput = document.getElementById('font-size');
const fontFamilyInput = document.getElementById('font-family');
const historyLinesInput = document.getElementById('history-lines');
const asrEngineInput = document.getElementById('asr-engine');
const loadModelBtn = document.getElementById('load-model');
const modelLoadStateEl = document.getElementById('model-load-state');
const contextSizeInput = document.getElementById('context-size');
const pinSubtitlesInput = document.getElementById('pin-subtitles');
const themeInput = document.getElementById('theme');
const saveTranscriptsInput = document.getElementById('save-transcripts');
const bgOpacityInput = document.getElementById('bg-opacity');
const fontWeightInput = document.getElementById('font-weight');
const textShadowInput = document.getElementById('text-shadow');
const shadowColorInput = document.getElementById('shadow-color');
const outlineColorInput = document.getElementById('outline-color');
const outlineWidthInput = document.getElementById('outline-width');
const subtitlePositionInput = document.getElementById('subtitle-position');
const originalPlacementInput = document.getElementById('original-placement');
const originalScaleInput = document.getElementById('original-scale');
const holdTimeInput = document.getElementById('hold-time');
const minDisplayInput = document.getElementById('min-display');
const vadThresholdInput = document.getElementById('vad-threshold');
const detectSpeakersInput = document.getElementById('detect-speakers');
const speakerThresholdInput = document.getElementById('speaker-threshold');

const DEFAULTS = {
  llmProvider: 'lmstudio',
  lmstudioUrl: 'http://127.0.0.1:1234',
  ollamaUrl: 'http://127.0.0.1:11434',
  qwencloudUrl: 'https://maas.qwencloudapi.com',
  qwencloudModel: 'qwen3.8-livetranslate-flash-realtime',
  uiLang: 'en',
  theme: 'dark',
  contextSize: 4096
};

let isCapturing = false;
// Last model-list status, kept so it can be re-rendered when the UI language changes.
let modelStatus = null;
// Last selected model per provider, so switching providers doesn't lose the choice.
let providerModels = { lmstudio: '', ollama: '', qwencloud: '' };
// Models reported by the server on the last refresh: [{ id, loaded, ctx }].
let lastModels = [];
// True when the server exposes LM Studio's load/unload API (LM Studio 0.4+).
let canManageModels = false;
// Progress of the last load/eject, written by background.js.
let modelState = null;
// Where the subtitles were last dragged on a page (fractions of the viewport), for the preview.
let draggedSpot = { x: null, y: null };
// Saved profiles and display configs (ConfigManager, created at the end of this file).
let profileConfigs = null;
let displayConfigs = null;
// A profile's model that isn't installed ({ key, name, download, quantization, sizeBytes, fallback })
// and the LM Studio download of it, if one is running ({ jobId, key, base, status, downloaded, total }).
let pendingModel = null;
let modelDownload = null;
let downloadTimer = null;

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(theme) {
  const resolved = theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : (theme || DEFAULTS.theme);
  document.documentElement.dataset.theme = resolved;
  try {
    localStorage.setItem('lcTheme', theme);
  } catch (e) {}
}

// Apply the last theme right away so the popup doesn't flash the wrong colours
// while chrome.storage loads.
try {
  applyTheme(localStorage.getItem('lcTheme') || DEFAULTS.theme);
} catch (e) {}
systemDark.addEventListener('change', () => {
  if (themeInput.value === 'system') applyTheme('system');
});

function t(key, vars) {
  return lcTranslate(uiLangInput.value, key, vars);
}

// ---------------------------------------------------------------------------
// Localization
// ---------------------------------------------------------------------------

function buildLanguageSelect(select, lang) {
  const current = select.value;
  select.innerHTML = '';

  if (select.dataset.firstValue) {
    select.add(new Option(lcTranslate(lang, select.dataset.firstI18n), select.dataset.firstValue));
  }

  for (const code of select.id === 'ui-lang' ? LC_UI_LANGS : LC_LANG_CODES) {
    if (select.id === 'target-lang' && LC_SOURCE_ONLY_LANGS.includes(code)) continue;
    let label = lcLanguageName(code, lang);
    if (select.id === 'ui-lang') {
      // UI language picker: show each language in its own script so it's
      // always findable, plus the name in the current UI language.
      const native = lcLanguageName(code, code);
      label = native === label ? native : `${native} (${label})`;
    }
    select.add(new Option(label, code));
  }

  if (current) select.value = current;
}

// ---------------------------------------------------------------------------
// Language pickers: the video and subtitle language menus, with a search box pinned at the top of
// the list (the same matching as the settings search, also on each language's English and native
// name), sorted A–Z in the UI language. The hidden <select> stays the source of truth: the rest of
// the popup reads and sets its value and listens for its changes.
// ---------------------------------------------------------------------------

// Other names people search for that the browser's language names don't cover (like data-search
// on the settings).
const LANG_SEARCH_ALIASES = {
  'zh-TW': 'Mandarin 中文 繁體 繁体 國語 Taiwan',
  'zh-CN': 'Mandarin 中文 简体 簡體 普通话',
  yue: 'Cantonese 粵語 粤语 廣東話 广东话 Hong Kong',
  bn: 'Bengali Bangla বাংলা',
  fil: 'Tagalog Pilipino',
  ms: 'Bahasa Melayu',
  id: 'Bahasa Indonesia',
  nl: 'Flemish Nederlands',
  ar: 'العربية',
  hi: 'हिन्दी'
};

class LanguagePicker {
  constructor(select) {
    this.select = select;
    this.items = [];
    this.active = -1;

    this.trigger = document.createElement('button');
    this.trigger.type = 'button';
    this.trigger.className = 'lang-trigger';
    this.trigger.id = `${select.id}-picker`;
    this.trigger.setAttribute('role', 'combobox');
    this.trigger.setAttribute('aria-haspopup', 'listbox');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.triggerLabel = document.createElement('span');
    this.trigger.appendChild(this.triggerLabel);
    select.before(this.trigger);

    // The menu lives on <body> with fixed positioning so the panel's edges can't clip it.
    this.menu = document.createElement('div');
    this.menu.className = 'lang-menu';
    this.menu.hidden = true;
    this.search = document.createElement('input');
    this.search.type = 'search';
    this.search.className = 'lang-search';
    this.search.autocomplete = 'off';
    this.search.spellcheck = false;
    this.list = document.createElement('ul');
    this.list.className = 'lang-options';
    this.list.id = `${select.id}-options`;
    this.list.setAttribute('role', 'listbox');
    this.search.setAttribute('aria-controls', this.list.id);
    this.trigger.setAttribute('aria-controls', this.list.id);
    this.menu.append(this.search, this.list);
    document.body.appendChild(this.menu);

    // The native select is kept for its value and events only.
    select.classList.add('lang-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    const label = document.querySelector(`label[for="${select.id}"]`);
    if (label) {
      label.htmlFor = this.trigger.id;
      // Named by the label's text itself (the label may also hold an icon, e.g. the UI Language globe).
      const text = label.querySelector('[data-i18n]') || label;
      this.trigger.setAttribute('aria-labelledby', text.id || (text.id = `${select.id}-label`));
    }

    // Keep the button in step with the select however its value changes: set from code (profiles,
    // saved settings), options rebuilt (UI language switch), or picked here.
    const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    const picker = this;
    Object.defineProperty(select, 'value', {
      configurable: true,
      get() { return native.get.call(this); },
      set(v) { native.set.call(this, v); picker.sync(); }
    });
    new MutationObserver(() => this.sync()).observe(select, { childList: true, subtree: true, characterData: true });
    select.addEventListener('change', () => this.sync());

    // While open, pressing the button must not move focus out of the search box: that blur would
    // close the menu first, and the click would then open it again.
    this.trigger.addEventListener('mousedown', (e) => {
      if (!this.menu.hidden) e.preventDefault();
    });
    this.trigger.addEventListener('click', () => (this.menu.hidden ? this.open() : this.close(true)));
    this.trigger.addEventListener('keydown', (e) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        this.open();
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Typing on the closed menu starts a search.
        e.preventDefault();
        this.open(e.key);
      }
    });
    this.search.addEventListener('input', () => this.render());
    this.search.addEventListener('keydown', (e) => this.onSearchKey(e));
    this.search.addEventListener('blur', () => {
      // Clicking an option keeps focus (mousedown is cancelled), so a blur means leaving the menu.
      setTimeout(() => { if (!this.menu.contains(document.activeElement)) this.close(false); }, 0);
    });
    this.onOutside = (e) => {
      if (!this.menu.contains(e.target) && !this.trigger.contains(e.target)) this.close(false);
    };
    this.onReposition = () => this.position();

    this.sync();
  }

  // The select's options as menu entries: the first option ("Auto Detect" / "Original Only")
  // stays on top, the languages below it A–Z.
  entries() {
    const uiLang = uiLangInput.value;
    const all = [...this.select.options].map(opt => {
      const special = opt.value === this.select.dataset.firstValue;
      const english = special ? lcTranslate('en', this.select.dataset.firstI18n) : lcLanguageName(opt.value, 'en');
      const nativeName = special ? '' : lcLanguageName(opt.value, opt.value);
      const extra = [english, nativeName, LANG_SEARCH_ALIASES[opt.value] || '', opt.value].join(' ');
      return { value: opt.value, label: opt.text, special, extra };
    });
    const collator = new Intl.Collator(LC_INTL_CODE[uiLang] || uiLang);
    const languages = all.filter(e => !e.special).sort((a, b) => collator.compare(a.label, b.label));
    return [...all.filter(e => e.special), ...languages];
  }

  sync() {
    const opt = this.select.selectedOptions[0];
    this.triggerLabel.textContent = opt ? opt.text : '';
    this.search.placeholder = t('langSearchPlaceholder');
    this.search.setAttribute('aria-label', t('langSearchPlaceholder'));
    if (!this.menu.hidden) this.render();
  }

  // Shown A–Z; while searching, best matches first (as in the settings search).
  render() {
    const query = this.search.value;
    let shown = this.entries().map(entry => ({ entry, positions: [] }));
    if (query.trim()) {
      shown = shown.map(({ entry }) => {
        const onLabel = matchScore(query, entry.label);
        const onExtra = matchScore(query, entry.extra, false);
        const score = Math.max(onLabel ? onLabel.score : -Infinity, onExtra ? onExtra.score * 0.6 : -Infinity);
        return { entry, score, positions: onLabel ? onLabel.positions : [] };
      }).filter(r => r.score > -Infinity).sort((a, b) => b.score - a.score);
    }
    this.items = shown;
    this.list.innerHTML = '';
    if (!shown.length) {
      const empty = document.createElement('li');
      empty.className = 'lang-empty';
      empty.textContent = t('langNoResults');
      this.list.appendChild(empty);
    }
    const current = this.select.value;
    shown.forEach(({ entry, positions }, i) => {
      const li = document.createElement('li');
      li.id = `${this.list.id}-${i}`;
      li.className = 'lang-option' + (entry.special ? ' special' : '');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(entry.value === current));
      li.appendChild(highlighted(entry.label, positions));
      // mousedown (not click) so the search box keeps focus and the menu doesn't close first
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.choose(entry.value);
      });
      li.addEventListener('mousemove', () => this.setActive(i, false));
      this.list.appendChild(li);
    });
    // Searching: the best match; otherwise the current language.
    const selected = shown.findIndex(r => r.entry.value === current);
    this.setActive(query.trim() ? 0 : Math.max(selected, 0), true);
  }

  setActive(index, scroll) {
    const options = [...this.list.querySelectorAll('.lang-option')];
    if (!options.length) {
      this.active = -1;
      this.search.removeAttribute('aria-activedescendant');
      return;
    }
    this.active = (index + options.length) % options.length;
    options.forEach((li, i) => li.classList.toggle('active', i === this.active));
    this.search.setAttribute('aria-activedescendant', options[this.active].id);
    if (scroll) options[this.active].scrollIntoView({ block: 'nearest' });
  }

  onSearchKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.setActive(this.active + (e.key === 'ArrowDown' ? 1 : -1), true);
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      this.setActive(Math.min(Math.max(this.active + (e.key === 'PageDown' ? 8 : -8), 0), this.items.length - 1), true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = this.items[this.active];
      if (item) this.choose(item.entry.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close(true);
    } else if (e.key === 'Tab') {
      this.close(false);
    }
  }

  choose(value) {
    const changed = value !== this.select.value;
    this.select.value = value;
    this.close(true);
    if (changed) this.select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Below the button, or above it when there's more room there; the list scrolls under the search
  // box, which stays at the top.
  position() {
    const r = this.trigger.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const up = below < 220 && above > below;
    const room = (up ? above : below) - 6;
    // At least 260 px wide so names stay readable under a narrow button (the UI language menu sits
    // in a half-width column), kept inside the popup.
    const margin = 12;
    const width = Math.min(Math.max(r.width, 260), window.innerWidth - margin * 2);
    const left = Math.max(margin, Math.min(r.left, window.innerWidth - width - margin));
    Object.assign(this.menu.style, {
      left: `${left}px`,
      width: `${width}px`,
      top: up ? '' : `${r.bottom + 6}px`,
      bottom: up ? `${window.innerHeight - r.top + 6}px` : '',
      maxHeight: `${Math.min(340, Math.max(room, 150))}px`
    });
  }

  open(initialQuery = '') {
    if (!this.menu.hidden) return;
    document.querySelectorAll('.lang-menu:not([hidden])').forEach(m => m.picker && m.picker.close(false));
    this.menu.picker = this;
    this.search.value = initialQuery;
    this.menu.hidden = false;
    this.trigger.setAttribute('aria-expanded', 'true');
    this.position();
    this.render();
    this.search.focus();
    document.addEventListener('mousedown', this.onOutside, true);
    window.addEventListener('scroll', this.onReposition, true);
    window.addEventListener('resize', this.onReposition);
  }

  close(focusTrigger) {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
    this.search.removeAttribute('aria-activedescendant');
    document.removeEventListener('mousedown', this.onOutside, true);
    window.removeEventListener('scroll', this.onReposition, true);
    window.removeEventListener('resize', this.onReposition);
    if (focusTrigger) this.trigger.focus();
  }
}

document.querySelectorAll('select.lang-select').forEach(sel => new LanguagePicker(sel));

function applyLanguage(lang) {
  document.documentElement.lang = lang;

  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = lcTranslate(lang, el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = lcTranslate(lang, el.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = lcTranslate(lang, el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('select.lang-select').forEach(sel => buildLanguageSelect(sel, lang));

  renderModelStatus();
  renderLoadState();
  updateHero();
  buildFontSelect();
  if (profileConfigs) {
    profileConfigs.render();
    displayConfigs.render();
  }
  updateShortcut();
  updateStatus();
  updateAsrNote();
}

// ---------------------------------------------------------------------------
// Status card and tabs
// ---------------------------------------------------------------------------

function updateHero() {
  const lang = uiLangInput.value;
  const source = sourceLangInput.value;
  const target = targetLangInput.value;
  document.getElementById('hero-source').textContent =
    source === 'auto' || !source ? t('heroAuto') : lcLanguageName(source, lang);
  document.getElementById('hero-target').textContent =
    target === 'none' || !target ? t('heroOriginal') : lcLanguageName(target, lang);
  document.getElementById('hero-model').textContent =
    target === 'none' ? '\u2014' : (currentModel() || '\u2014');
  renderLiveStats();
}

// ---------------------------------------------------------------------------
// Live speed and latency (status card). background.js stores the last line's timings as
// `liveStats` while captions run; nothing here is on the subtitle's path.
// ---------------------------------------------------------------------------

let liveStats = null;
const latencyBtn = document.getElementById('hero-latency');
const latencyTip = document.getElementById('latency-tip');

function formatMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function renderLiveStats() {
  const tps = document.getElementById('hero-tps');
  const s = isCapturing ? liveStats : null;
  const llmUsed = s && s.modelTps && targetLangInput.value !== 'none';
  tps.hidden = !llmUsed;
  if (llmUsed) tps.textContent = `${Math.round(s.modelTps)} t/s`;

  latencyBtn.hidden = !s;
  if (!s) {
    latencyTip.hidden = true;
    return;
  }
  latencyBtn.textContent = formatMs(s.roundTrip);
  latencyBtn.className = 'meta-stat latency ' + (s.roundTrip < 1500 ? 'good' : s.roundTrip < 3000 ? 'ok' : 'slow');
  latencyBtn.setAttribute('aria-label', `${t('tipRoundTrip')}: ${formatMs(s.roundTrip)}`);
  if (!latencyTip.hidden) fillLatencyTip();
}

function fillLatencyTip() {
  const s = liveStats;
  if (!s) return;
  latencyTip.innerHTML = '';
  const row = (label, value, cls = '') => {
    const el = document.createElement('div');
    el.className = 'tip-row ' + cls;
    const a = document.createElement('span');
    const b = document.createElement('span');
    a.textContent = label;
    b.textContent = value;
    el.append(a, b);
    latencyTip.appendChild(el);
  };
  const line = () => latencyTip.appendChild(document.createElement('hr'));

  row(t('tipRoundTrip'), formatMs(s.roundTrip), 'tip-total');
  row(t('tipRoundTripHint'), '', 'tip-sub');
  line();
  if (s.cloud !== undefined) row(t('tipCloud'), formatMs(s.cloud), 'tip-step');
  if (s.vad !== undefined) row(t('tipPause'), formatMs(s.vad), 'tip-step');
  if (s.asr !== undefined) row(t('tipAsr'), formatMs(s.asr), 'tip-step');
  if (s.speaker !== undefined) row(t('tipSpeakers'), formatMs(s.speaker), 'tip-step');
  if (s.wait >= 10) row(t('tipWaiting'), formatMs(s.wait), 'tip-step');
  if (s.cloud !== undefined) {
    // (Qwen Cloud LiveTranslate: listening and translating are one step)
  } else if (s.llm !== undefined) {
    row(t('tipLlm'), formatMs(s.llm), 'tip-step');
    if (s.tps) row(t('tipTokens', { tokens: s.tokens }), `${Math.round(s.tps)} t/s`, 'tip-step tip-sub');
    if (s.tps && s.prompt) row(t('tipPrompt'), formatMs(s.prompt), 'tip-step tip-sub');
    else if (s.engine) row(s.engine, '', 'tip-step tip-sub');
  } else {
    row(t('tipNoLlm'), '', 'tip-step tip-sub');
  }
  row(t('tipDelivery'), formatMs(s.delivery), 'tip-step');
  if (s.recent && s.recent.length > 1) {
    line();
    const avg = s.recent.reduce((a, b) => a + b, 0) / s.recent.length;
    row(t('tipAverage', { n: s.recent.length }), formatMs(avg));
  }
  if (s.vad === undefined) return;
  line();
  row(t('tipPauseHint', {
    setting: t('labelMinSilence').replace(/\s*[:：]\s*$/, ''),
    tab: t('tabTuning')
  }), '', 'tip-sub');
}

function showLatencyTip() {
  if (!liveStats || latencyBtn.hidden) return;
  fillLatencyTip();
  latencyTip.hidden = false;
  // Below the value, kept inside the popup.
  const r = latencyBtn.getBoundingClientRect();
  const width = latencyTip.offsetWidth;
  const left = Math.min(Math.max(8, r.right - width), document.documentElement.clientWidth - width - 8);
  latencyTip.style.left = left + 'px';
  latencyTip.style.top = (r.bottom + 8) + 'px';
}

function hideLatencyTip() {
  latencyTip.hidden = true;
}

latencyBtn.addEventListener('mouseenter', showLatencyTip);
latencyBtn.addEventListener('focus', showLatencyTip);
latencyBtn.addEventListener('mouseleave', hideLatencyTip);
latencyBtn.addEventListener('blur', hideLatencyTip);
latencyBtn.addEventListener('click', () => (latencyTip.hidden ? showLatencyTip() : hideLatencyTip()));

chrome.storage.local.get(['liveStats'], (result) => {
  liveStats = result.liveStats || null;
  renderLiveStats();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.liveStats) return;
  liveStats = changes.liveStats.newValue || null;
  renderLiveStats();
});

function showTab(name) {
  document.querySelectorAll('.segmented button').forEach(btn => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.hidden = panel.dataset.panel !== name;
  });
  // The preview measures itself for the dragged-spot position, which only works while visible.
  if (name === 'display') updatePreview();
  try {
    localStorage.setItem('lcTab', name);
  } catch (e) {}
}

document.querySelectorAll('.segmented button').forEach(btn => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});

let initialTab = 'live';
try {
  initialTab = localStorage.getItem('lcTab') || 'live';
} catch (e) {}
showTab(document.querySelector(`.segmented button[data-tab="${initialTab}"]`) ? initialTab : 'live');

// ---------------------------------------------------------------------------
// Subtitle font + preview
// ---------------------------------------------------------------------------

function buildFontSelect() {
  const current = fontFamilyInput.value;
  fontFamilyInput.innerHTML = '';
  for (const [id, font] of Object.entries(LC_FONTS)) {
    const option = new Option(font.label || t('optFontSystem'), id);
    option.style.fontFamily = font.stack; // shown in its own font where the OS allows it
    fontFamilyInput.add(option);
  }
  if (current) fontFamilyInput.value = current;
}

function lookSettings() {
  return {
    bgColor: bgColorInput.value,
    textColor: textColorInput.value,
    bgOpacity: parseInt(bgOpacityInput.value),
    fontSize: fontSizeInput.value,
    fontFamily: fontFamilyInput.value,
    fontWeight: fontWeightInput.value,
    textShadow: textShadowInput.value,
    shadowColor: shadowColorInput.value,
    outlineColor: outlineColorInput.value,
    outlineWidth: parseFloat(outlineWidthInput.value),
    originalPlacement: originalPlacementInput.value,
    originalScale: parseInt(originalScaleInput.value)
  };
}

// Drawn with lcSubtitleLook(), the same function the overlay (content.js) uses.
function updatePreview() {
  const look = lcSubtitleLook(lookSettings());
  const box = document.getElementById('subtitle-preview');
  const raw = box.querySelector('.preview-raw');
  const main = box.querySelector('.preview-main');
  Object.assign(box.style, {
    background: look.background,
    border: look.border,
    boxShadow: look.boxShadow,
    backdropFilter: look.backdropFilter,
    fontFamily: look.fontFamily
  });
  Object.assign(raw.style, {
    fontSize: look.rawSize + 'px',
    textShadow: look.rawShadow,
    order: look.originalBelow ? 2 : 0,
    // like the overlay: no original line without Bilingual Mode or with "Original only"
    display: originalLineShown() ? '' : 'none'
  });
  Object.assign(main.style, {
    fontSize: look.mainSize + 'px',
    color: look.color,
    fontWeight: String(look.fontWeight),
    textShadow: look.mainShadow,
    order: 1
  });
  // "Person 1:" in front of the line, as on the page, while Label speakers is on.
  const speaker = box.querySelector('.preview-speaker');
  speaker.hidden = !detectSpeakersInput.checked;
  speaker.textContent = t('speakerLabel', { n: 1 });
  speaker.style.color = lcSpeakerColor(1, lookSettings());

  // Placement follows the Position setting vertically, but the box always stays centred
  // horizontally: in this small frame it spans 85% of the width, so a sideways offset that fits
  // on a real page (where the box is at most 750px wide) would push it off the edge.
  Object.assign(box.style, { transform: 'translateX(-50%)', left: '50%' });
  const position = subtitlePositionInput.value;
  if (position === 'custom' && draggedSpot.y !== null) {
    // Where it was dragged vertically, kept inside the frame (canvas px, before scaling).
    const canvasHeight = box.parentElement.clientHeight;
    const top = Math.min(Math.max(Number(draggedSpot.y) || 0, 0) * canvasHeight, canvasHeight - box.offsetHeight);
    Object.assign(box.style, { bottom: 'auto', top: Math.max(top, 0) + 'px' });
  } else if (position === 'top') {
    Object.assign(box.style, { bottom: 'auto', top: '8%' });
  } else {
    Object.assign(box.style, { top: 'auto', bottom: '8%' });
  }
}

function updateRangeLabels() {
  const set = (id, value) => { document.getElementById(id).textContent = value; };
  set('min-silence-val', minSilenceInput.value);
  set('max-speech-val', maxSpeechInput.value);
  set('vad-threshold-val', parseFloat(vadThresholdInput.value).toFixed(2));
  set('speaker-threshold-val', parseFloat(speakerThresholdInput.value).toFixed(2));
  set('bg-opacity-val', bgOpacityInput.value);
  set('original-scale-val', originalScaleInput.value);
  set('hold-time-val', holdTimeInput.value);
  set('min-display-val', minDisplayInput.value);
  set('outline-width-val', outlineWidthInput.value);
}

// Show only the options that apply to what is selected:
//  - Text Shadow: Off -> nothing; Soft / Medium / Strong -> shadow colour; Outline -> outline colour + width
//  - Original text position / size -> only while the original line is shown (Bilingual Mode on and
//    a translation language selected)
function updateContextualControls() {
  const style = textShadowInput.value;
  document.getElementById('shadow-color-row').hidden = !['soft', 'medium', 'strong'].includes(style);
  document.getElementById('outline-color-row').hidden = style !== 'outline';
  document.getElementById('group-outline-width').hidden = style !== 'outline';

  const originalShown = originalLineShown();
  document.getElementById('group-original-placement').hidden = !originalShown;
  document.getElementById('group-original-scale').hidden = !originalShown;

  // Speaker tuning (Tuning tab) -> only while Label speakers is on
  document.getElementById('speaker-tuning').hidden = !detectSpeakersInput.checked;
  updateAsrNote();
}

// Speaker labels need a server with the speaker model; say so when the running one can't do it.
async function checkSpeakerSupport() {
  const note = document.getElementById('speakers-unavailable');
  if (!detectSpeakersInput.checked) {
    note.hidden = true;
    return;
  }
  const health = await fetchJson('http://127.0.0.1:8000/health', 2000).catch(() => null);
  // Not running: nothing to say yet. Running without `speakers: true`: an older server or no model.
  note.hidden = !(health && health.server === 'local-ai-live-translate' && health.speakers !== true);
}

// Video languages each speech engine can recognise (null: all of them). Mirrors ENGINE_LANGS and
// pick_engine() in the server, which switches engines the same way.
// langs: the languages an engine can recognise (null: any, except `excludes`).
const ASR_ENGINES = {
  sensevoice: { name: 'SenseVoice', langs: ['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'yue'] },
  whisper: { name: 'Whisper-Small', langs: null, excludes: ['yue'] },
  dolphin: { name: 'Dolphin', langs: ['zh-TW', 'zh-CN', 'ja', 'ko', 'yue', 'ru', 'id', 'vi', 'th', 'ms', 'fil', 'hi', 'ar', 'bn'] },
  omnilingual: { name: 'Omnilingual', langs: null }
};

function asrSupports(engine, lang) {
  const { langs, excludes = [] } = ASR_ENGINES[engine];
  return lang === 'auto' || ((!langs || langs.includes(lang)) && !excludes.includes(lang));
}

// Where another engine was measured to be the better stand-in (FALLBACK_ORDER in the server):
// Dolphin small for the South-East Asian languages; Omnilingual for Hindi, Arabic, Bengali and the
// European languages (close to Whisper-Small there, and much faster).
const ASR_FALLBACK_ORDER = {
  ...Object.fromEntries(['id', 'vi', 'th', 'ms', 'fil'].map(l => [l, ['dolphin', 'whisper']])),
  ...Object.fromEntries(['hi', 'ar'].map(l => [l, ['omnilingual', 'dolphin', 'whisper']])),
  ...Object.fromEntries(['pt', 'it', 'tr', 'pl', 'uk', 'nl'].map(l => [l, ['omnilingual', 'whisper']])),
  bn: ['omnilingual', 'dolphin'],
  yue: ['sensevoice', 'dolphin']
};
// Where Whisper-Small is unusable, so Omnilingual is much more accurate as well as faster
// (FLEURS word errors: Hindi 79%, Bengali 100%; Arabic 25.5% against 15.8%).
const WHISPER_POOR = ['hi', 'ar', 'bn'];

function engineInUse(engine, lang) {
  if (asrSupports(engine, lang)) return engine;
  return (ASR_FALLBACK_ORDER[lang] || ['sensevoice', 'whisper', 'dolphin']).find(e => asrSupports(e, lang)) || 'sensevoice';
}

// The best engine for a language: SenseVoice where it can, else the preferred stand-in.
function bestEngine(lang) {
  return engineInUse('sensevoice', lang);
}

// e.g. "SenseVoice can't recognise Indonesian speech, so Dolphin is used." or, with Whisper-Small
// chosen for Indonesian: "Whisper-Small is accurate but adds about 1-2 s per line. Dolphin is about
// as accurate for this language and much faster."
function updateAsrNote() {
  const note = document.getElementById('asr-note');
  const chosen = asrEngineInput.value;
  const lang = sourceLangInput.value;
  const used = engineInUse(chosen, lang);
  const parts = [];
  if (used !== chosen) {
    parts.push(t('asrFallback', {
      engine: ASR_ENGINES[chosen].name,
      language: lcLanguageName(lang, uiLangInput.value),
      fallback: ASR_ENGINES[used].name
    }));
  }
  const best = bestEngine(lang);
  if (used === 'whisper' && lang !== 'auto' && !asrSupports('sensevoice', lang)) {
    if (WHISPER_POOR.includes(lang)) {
      parts.push(t('asrTryOmnilingual'));
    } else {
      parts.push(t('asrWhisperSlow'));
      if (best === 'dolphin') parts.push(t('asrTryDolphin'));
    }
  }
  // Dolphin or Omnilingual picked for a language another engine handles better
  // (e.g. Japanese -> SenseVoice, Hindi -> Omnilingual)
  if ((used === 'dolphin' || used === 'omnilingual') && lang !== 'auto' && best !== used) {
    parts.push(t('asrDolphinNote', { engine: ASR_ENGINES[best].name }));
  }
  note.textContent = parts.join(' ');
  note.hidden = !parts.length;
}

function originalLineShown() {
  return showBilingualInput.checked && targetLangInput.value !== 'none';
}

// ---------------------------------------------------------------------------
// Keyboard shortcut
// ---------------------------------------------------------------------------

function updateShortcut() {
  chrome.commands.getAll((commands) => {
    const cmd = (commands || []).find(c => c.name === 'toggle-captions');
    document.getElementById('shortcut-key').textContent = (cmd && cmd.shortcut) || t('shortcutNotSet');
  });
}

document.getElementById('change-shortcut').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// ---------------------------------------------------------------------------
// Model discovery (LM Studio / Ollama)
// ---------------------------------------------------------------------------

function stripUrl(url) {
  return (url || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

async function fetchJson(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const isNetworkError = e => e instanceof TypeError || e.name === 'AbortError';

// Returns [{ id, loaded, ctx }] of chat-capable models, and sets canManageModels.
async function listLmStudioModels(base) {
  canManageModels = false;
  try {
    // LM Studio 0.4+ native API: load state, context length, load/unload and downloads.
    const models = await lcListLmModels(base);
    canManageModels = true;
    return models;
  } catch (e) {
    // Server not reachable at all: no point trying the other endpoints.
    if (isNetworkError(e)) throw e;
  }
  try {
    // Older LM Studio versions.
    const res = await fetchJson(`${base}/api/v0/models`);
    return (res.data || [])
      .filter(m => m.type !== 'embeddings')
      .map(m => ({ id: m.id, loaded: m.state === 'loaded' }));
  } catch (e) {
    if (isNetworkError(e)) throw e;
  }
  // Any other OpenAI-compatible server.
  const res = await fetchJson(`${base}/v1/models`);
  return (res.data || [])
    .filter(m => !/embed/i.test(m.id))
    .map(m => ({ id: m.id, loaded: false }));
}

async function listOllamaModels(base) {
  const res = await fetchJson(`${base}/api/tags`);
  return (res.models || []).map(m => ({ id: m.name, loaded: false }));
}

// ---------------------------------------------------------------------------
// Qwen Cloud (online): any chat / translation model on the account works as the translator; a
// LiveTranslate model (audio in, translated subtitles out) replaces the local speech recognition too.
// ---------------------------------------------------------------------------

const QWEN_LIVE_MODELS = ['qwen3.8-livetranslate-flash-realtime', 'qwen3.5-livetranslate-flash-realtime'];

function isLiveTranslate(model) {
  return /livetranslate/i.test(model || '') && /realtime/i.test(model || '');
}

// The model in use for the chosen provider.
function currentModel() {
  return llmProviderInput.value === 'qwencloud' ? qwenModelInput.value.trim() : modelNameInput.value;
}

function qwenBase() {
  return (qwenUrlInput.value.trim() || DEFAULTS.qwencloudUrl).replace(/\/+$/, '').replace(/\/compatible-mode(\/v1)?$/, '');
}

let qwenStatus = null;
function renderQwenStatus() {
  const el = document.getElementById('qwen-status');
  el.textContent = qwenStatus ? t(qwenStatus.key, qwenStatus.vars) : '';
  el.className = 'hint' + (qwenStatus && qwenStatus.cls ? ' ' + qwenStatus.cls : '');
}

// Explains what the chosen Qwen model does (LiveTranslate or text translation).
function updateQwenMode() {
  const el = document.getElementById('qwen-mode');
  const live = isLiveTranslate(qwenModelInput.value);
  const parts = [t(live ? 'qwenModeLive' : 'qwenModeText')];
  if (live && targetLangInput.value === 'none') parts.push(t('qwenNeedsTarget'));
  el.textContent = parts.join(' ');
}

async function refreshQwenModels() {
  const list = document.getElementById('qwencloud-models');
  const fill = (ids) => {
    list.innerHTML = '';
    for (const id of [...QWEN_LIVE_MODELS, ...ids.filter(id => !QWEN_LIVE_MODELS.includes(id))]) {
      list.appendChild(new Option(isLiveTranslate(id) ? `${id} (LiveTranslate)` : id, id));
    }
  };
  fill([]);
  if (!qwenKeyInput.value.trim()) {
    qwenStatus = { key: 'qwenNoKey', cls: '' };
    renderQwenStatus();
    return;
  }
  const spinner = document.getElementById('refresh-qwen');
  spinner.classList.add('spinning');
  try {
    const res = await lcFetchJson(`${qwenBase()}/compatible-mode/v1/models`,
      { headers: { Authorization: `Bearer ${qwenKeyInput.value.trim()}` } }, 8000);
    const ids = (res.data || []).map(m => m.id).filter(id => !/embed|rerank|tts|image|wanx|wan2/i.test(id)).sort();
    fill(ids);
    qwenStatus = { key: 'modelFound', vars: { n: ids.length }, cls: 'ok' };
  } catch (e) {
    qwenStatus = { key: 'modelErrorQwen', vars: { url: qwenBase(), err: e.message }, cls: 'error' };
  }
  spinner.classList.remove('spinning');
  renderQwenStatus();
}

function setModelStatus(key, vars, cls) {
  modelStatus = key ? { key, vars, cls } : null;
  renderModelStatus();
}

function renderModelStatus() {
  if (!modelStatus) {
    modelStatusEl.textContent = '';
    modelStatusEl.className = 'hint';
    return;
  }
  const parts = [].concat(modelStatus.key).map(k => t(k, modelStatus.vars));
  modelStatusEl.textContent = parts.join(' · ');
  modelStatusEl.className = 'hint' + (modelStatus.cls ? ' ' + modelStatus.cls : '');
}

function fillModelSelect(models) {
  const saved = providerModels[llmProviderInput.value];
  modelNameInput.innerHTML = '';

  const loadedTag = t('modelLoadedTag');
  for (const m of models) {
    modelNameInput.add(new Option(m.loaded ? `${m.id}  (${loadedTag})` : m.id, m.id));
  }
  // Keep a saved model visible even if the server doesn't list it right now.
  if (saved && !models.some(m => m.id === saved)) {
    modelNameInput.add(new Option(saved, saved), 0);
  }

  if (saved) {
    modelNameInput.value = saved;
  } else if (models.length) {
    // Nothing chosen yet: prefer a model LM Studio already has in memory.
    modelNameInput.value = (models.find(m => m.loaded) || models[0]).id;
  }
}

// True when the Local AI Live Translate server answers on its health endpoint.
function serverRunning() {
  return fetchJson('http://127.0.0.1:8000/health', 2000).then(
    res => res.server === 'local-ai-live-translate', () => false);
}

let refreshSeq = 0;
async function refreshModels() {
  const seq = ++refreshSeq;
  const provider = llmProviderInput.value;
  if (provider === 'qwencloud') {
    canManageModels = false;
    lastModels = [];
    renderLoadState();
    renderMissingModel();
    updateHero();
    updateQwenMode();
    await refreshQwenModels();
    return;
  }
  const base = stripUrl(provider === 'ollama' ? ollamaUrlInput.value : lmstudioUrlInput.value);

  refreshModelsBtn.classList.add('spinning');
  setModelStatus('modelLoading');

  const [models, serverUp] = await Promise.all([
    (provider === 'ollama' ? listOllamaModels(base) : listLmStudioModels(base))
      .catch(e => { console.warn('Model list failed:', e); return null; }),
    serverRunning()
  ]);

  if (seq !== refreshSeq) return; // a newer refresh superseded this one
  refreshModelsBtn.classList.remove('spinning');

  lastModels = models || [];
  if (provider !== 'lmstudio') canManageModels = false;
  fillModelSelect(lastModels);
  renderLoadState();
  updateHero();
  renderMissingModel();

  const keys = [];
  let cls = 'ok';
  if (models === null) {
    keys.push(provider === 'ollama' ? 'modelErrorOllama' : 'modelErrorLmstudio');
    cls = 'error';
  } else if (models.length === 0) {
    keys.push('modelNone');
    cls = 'error';
  } else {
    keys.push('modelFound');
  }
  if (!serverUp) {
    keys.push('serverDown');
    cls = 'error';
  }
  setModelStatus(keys, { n: models ? models.length : 0, url: base }, cls);

  // The select may have auto-picked a model; persist it.
  if (modelNameInput.value !== providerModels[provider]) saveSettings();
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshModels, 600);
}

// ---------------------------------------------------------------------------
// Model load / eject (LM Studio only)
// ---------------------------------------------------------------------------

function formatCtx(n) {
  return n >= 1024 ? `${Math.round(n / 1024)}K` : String(n);
}

function renderLoadState() {
  const model = modelNameInput.value;
  const manageable = llmProviderInput.value === 'lmstudio' && canManageModels;
  document.getElementById('group-context').hidden = !manageable;
  loadModelBtn.hidden = modelLoadStateEl.hidden = !(manageable && model);
  if (loadModelBtn.hidden) return;

  const info = lastModels.find(m => m.id === model);
  const mine = modelState && modelState.model === model;
  // Ignore a stale "loading" left behind if the service worker died mid-load.
  const busy = mine && ['loading', 'unloading'].includes(modelState.status) && Date.now() - modelState.ts < 180000;

  let key = 'loadStateIdle';
  let vars = {};
  let cls = '';
  if (busy) {
    key = modelState.status === 'loading' ? 'loadStateLoading' : 'loadStateUnloading';
    cls = 'busy';
  } else if (mine && modelState.status === 'error') {
    key = 'loadStateError';
    vars = { err: modelState.error };
    cls = 'error';
  } else if (info && info.loaded) {
    key = 'loadStateLoaded';
    vars = { ctx: formatCtx(info.ctx) };
    cls = 'ok';
  }
  modelLoadStateEl.textContent = t(key, vars);
  modelLoadStateEl.className = 'hint' + (cls ? ' ' + cls : '');

  const loaded = !busy && info && info.loaded;
  loadModelBtn.disabled = busy;
  loadModelBtn.textContent = loaded ? '\u23CF' : '\u25B6'; // eject / load
  loadModelBtn.title = t(loaded ? 'btnEjectTitle' : 'btnLoadTitle');
}

function modelAction(action) {
  if (!modelNameInput.value) return;
  chrome.runtime.sendMessage({
    type: 'lm-model',
    action,
    base: stripUrl(lmstudioUrlInput.value),
    model: modelNameInput.value,
    contextLength: parseInt(contextSizeInput.value)
  }, () => void chrome.runtime.lastError);
}

// background.js reports load/eject progress through storage, so this also
// works when the popup is reopened in the middle of a load.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.lmModelState) return;
  modelState = changes.lmModelState.newValue;
  renderLoadState();
  if (modelState && !['loading', 'unloading'].includes(modelState.status)) refreshModels();
});

function showProviderFields() {
  const provider = llmProviderInput.value;
  document.getElementById('group-lmstudio').hidden = provider !== 'lmstudio';
  document.getElementById('group-ollama').hidden = provider !== 'ollama';
  document.getElementById('group-qwencloud').hidden = provider !== 'qwencloud';
  document.getElementById('group-model').hidden = provider === 'qwencloud';
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

(async () => {
  const result = await chrome.storage.local.get([
    'llmProvider', 'lmstudioUrl', 'ollamaUrl', 'modelName', 'lmstudioModel', 'ollamaModel',
    'qwencloudUrl', 'qwencloudKey', 'qwencloudModel',
    'deepseekKey', 'minSilence', 'maxSpeech', 'vadThreshold', 'detectSpeakers', 'speakerThreshold',
    'uiLang', 'sourceLang', 'targetLang', 'showBilingual', 'asrEngine',
    'contextSize', 'theme', 'lmModelState', 'saveTranscripts',
    'profiles', 'activeProfile', 'displayConfigs', 'activeDisplayConfig', 'pendingModel', 'lmDownload',
    ...Object.keys(LC_SUBTITLE_DEFAULTS)
  ]);
  chrome.storage.local.remove('sitePresets'); // replaced by profiles
  // Subtitle look settings, with defaults for anything never saved.
  const look = { ...LC_SUBTITLE_DEFAULTS };
  for (const key of Object.keys(look)) if (result[key] !== undefined) look[key] = result[key];

  themeInput.value = result.theme || DEFAULTS.theme;
  applyTheme(themeInput.value);
  contextSizeInput.value = String(result.contextSize || DEFAULTS.contextSize);
  pinSubtitlesInput.checked = look.pinSubtitles === true;
  saveTranscriptsInput.checked = result.saveTranscripts === true; // off unless turned on
  modelState = result.lmModelState || null;

  llmProviderInput.value = result.llmProvider || DEFAULTS.llmProvider;
  lmstudioUrlInput.value = result.lmstudioUrl || DEFAULTS.lmstudioUrl;
  ollamaUrlInput.value = (!result.ollamaUrl || result.ollamaUrl === 'http://localhost:11434')
    ? DEFAULTS.ollamaUrl : result.ollamaUrl;

  // Older versions only stored one Ollama model in `modelName`.
  providerModels = {
    lmstudio: result.lmstudioModel || '',
    ollama: result.ollamaModel || (result.llmProvider ? '' : result.modelName) || '',
    qwencloud: result.qwencloudModel || DEFAULTS.qwencloudModel
  };
  qwenUrlInput.value = result.qwencloudUrl || DEFAULTS.qwencloudUrl;
  qwenKeyInput.value = result.qwencloudKey || '';
  qwenModelInput.value = providerModels.qwencloud;

  if (result.deepseekKey) deepseekKeyInput.value = result.deepseekKey;
  if (result.minSilence !== undefined) minSilenceInput.value = result.minSilence;
  if (result.maxSpeech !== undefined) maxSpeechInput.value = result.maxSpeech;
  if (result.vadThreshold !== undefined) vadThresholdInput.value = result.vadThreshold;
  if (result.speakerThreshold !== undefined) speakerThresholdInput.value = result.speakerThreshold;
  detectSpeakersInput.checked = result.detectSpeakers === true; // off unless turned on
  checkSpeakerSupport();

  // Language selects are generated, so build them before restoring their values.
  const uiLang = result.uiLang || DEFAULTS.uiLang;
  document.querySelectorAll('select.lang-select').forEach(sel => buildLanguageSelect(sel, uiLang));
  uiLangInput.value = uiLang;
  sourceLangInput.value = result.sourceLang || 'auto';
  targetLangInput.value = result.targetLang || 'none';

  showBilingualInput.checked = result.showBilingual !== undefined ? result.showBilingual : true;
  setDisplayInputs(look);
  updateContextualControls();
  updatePreview();
  if (result.asrEngine) asrEngineInput.value = result.asrEngine;

  showProviderFields();
  fillModelSelect([]);
  updateRangeLabels();
  pendingModel = result.pendingModel || null;
  modelDownload = result.lmDownload || null;
  profileConfigs.load(result);
  displayConfigs.load(result);
  applyLanguage(uiLangInput.value);
  await refreshModels();
  resumeModelDownload();
})();

let lastSubtitleMode = null; // subtitle language/bilingual mode last sent to the page

const saveSettings = () => {
  const provider = llmProviderInput.value;
  if (provider === 'qwencloud') providerModels.qwencloud = qwenModelInput.value.trim();
  else if (modelNameInput.value) providerModels[provider] = modelNameInput.value;

  const settings = {
    llmProvider: provider,
    lmstudioUrl: lmstudioUrlInput.value.trim(),
    ollamaUrl: ollamaUrlInput.value.trim(),
    modelName: providerModels[provider],
    lmstudioModel: providerModels.lmstudio,
    ollamaModel: providerModels.ollama,
    qwencloudUrl: qwenUrlInput.value.trim(),
    qwencloudKey: qwenKeyInput.value.trim(),
    qwencloudModel: providerModels.qwencloud,
    deepseekKey: deepseekKeyInput.value,
    minSilence: parseFloat(minSilenceInput.value),
    maxSpeech: parseFloat(maxSpeechInput.value),
    vadThreshold: parseFloat(vadThresholdInput.value),
    detectSpeakers: detectSpeakersInput.checked,
    speakerThreshold: parseFloat(speakerThresholdInput.value),
    uiLang: uiLangInput.value,
    sourceLang: sourceLangInput.value,
    targetLang: targetLangInput.value,
    showBilingual: showBilingualInput.checked,
    asrEngine: asrEngineInput.value,
    contextSize: parseInt(contextSizeInput.value),
    saveTranscripts: saveTranscriptsInput.checked,
    theme: themeInput.value,
    // Subtitle look (the overlay picks these up from storage by itself)
    ...lookSettings(),
    subtitlePosition: subtitlePositionInput.value,
    historyLines: parseInt(historyLinesInput.value),
    pinSubtitles: pinSubtitlesInput.checked,
    holdTime: parseFloat(holdTimeInput.value),
    minDisplay: parseFloat(minDisplayInput.value)
  };
  chrome.storage.local.set(settings);

  // Propagate to the running capture.
  const config = settings;
  chrome.runtime.sendMessage({ type: 'update-config', config });
  refreshConfigStates();

  const mode = `${config.targetLang}|${config.showBilingual}`;
  if (mode === lastSubtitleMode) return;
  lastSubtitleMode = mode;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'update-subtitle-mode',
        targetLang: config.targetLang,
        showBilingual: config.showBilingual
      }).catch(() => {});
    }
  });
};

// Colour pickers and sliders fire an input event for every step of a drag. The preview follows
// every step; the settings (and so the subtitles on the page) at most every 100 ms while
// dragging, and once more with the final value when the picker closes or the slider is let go.
let dragSaveTimer = null;
function saveWhileDragging() {
  if (dragSaveTimer) return;
  dragSaveTimer = setTimeout(() => {
    dragSaveTimer = null;
    saveSettings();
  }, 100);
}
function saveDragEnd() {
  clearTimeout(dragSaveTimer);
  dragSaveTimer = null;
  saveSettings();
}

llmProviderInput.addEventListener('change', () => {
  showProviderFields();
  fillModelSelect([]);
  saveSettings();
  refreshModels();
});
for (const input of [lmstudioUrlInput, ollamaUrlInput, qwenUrlInput, qwenKeyInput]) {
  input.addEventListener('input', () => {
    saveSettings();
    scheduleRefresh();
  });
}
qwenModelInput.addEventListener('input', () => {
  saveSettings();
  updateHero();
  updateQwenMode();
});
document.getElementById('refresh-qwen').addEventListener('click', refreshQwenModels);
modelNameInput.addEventListener('change', () => {
  if (pendingModel) setPendingModel(null);
  saveSettings();
  renderLoadState();
  updateHero();
  // Picking a model in LM Studio mode loads it (and ejects the previous one).
  if (llmProviderInput.value === 'lmstudio' && canManageModels) modelAction('load');
});
refreshModelsBtn.addEventListener('click', refreshModels);
loadModelBtn.addEventListener('click', () => {
  const info = lastModels.find(m => m.id === modelNameInput.value);
  modelAction(info && info.loaded ? 'unload' : 'load');
});
contextSizeInput.addEventListener('change', () => {
  saveSettings();
  // Context size is fixed at load time, so reload a loaded model with the new size.
  const info = lastModels.find(m => m.id === modelNameInput.value);
  if (info && info.loaded && info.ctx !== parseInt(contextSizeInput.value)) modelAction('load');
});
pinSubtitlesInput.addEventListener('change', saveSettings);
saveTranscriptsInput.addEventListener('change', saveSettings);
themeInput.addEventListener('change', () => {
  applyTheme(themeInput.value);
  saveSettings();
});
deepseekKeyInput.addEventListener('input', saveSettings);

uiLangInput.addEventListener('change', () => {
  applyLanguage(uiLangInput.value);
  fillModelSelect(lastModels); // re-localize the "loaded" tags
  saveSettings();
  updatePreview(); // speaker label
});
sourceLangInput.addEventListener('change', () => {
  saveSettings();
  updateHero();
  updateAsrNote();
});
targetLangInput.addEventListener('change', () => {
  saveSettings();
  updateHero();
  updateQwenMode();
  updateContextualControls();
  updatePreview();
});
showBilingualInput.addEventListener('change', () => {
  saveSettings();
  updateContextualControls();
  updatePreview();
});
asrEngineInput.addEventListener('change', () => {
  saveSettings();
  updateAsrNote();
});
detectSpeakersInput.addEventListener('change', () => {
  saveSettings();
  updateContextualControls();
  updatePreview();
  checkSpeakerSupport();
});

// Subtitle look: save (the overlay updates itself from storage) and refresh the preview.
for (const input of [bgColorInput, textColorInput, shadowColorInput, outlineColorInput, bgOpacityInput, originalScaleInput, outlineWidthInput]) {
  input.addEventListener('input', () => {
    updateRangeLabels();
    updatePreview();
    saveWhileDragging();
  });
  input.addEventListener('change', saveDragEnd);
}
for (const input of [fontSizeInput, fontFamilyInput, fontWeightInput, textShadowInput, originalPlacementInput]) {
  input.addEventListener('change', () => {
    updateContextualControls();
    saveSettings();
    updatePreview();
  });
}
historyLinesInput.addEventListener('change', saveSettings);
subtitlePositionInput.addEventListener('change', () => {
  saveSettings();
  updatePreview();
});
for (const input of [minSilenceInput, maxSpeechInput, vadThresholdInput, speakerThresholdInput, holdTimeInput, minDisplayInput]) {
  input.addEventListener('input', () => {
    updateRangeLabels();
    saveWhileDragging();
  });
  input.addEventListener('change', saveDragEnd);
}

// Dragging the subtitles on the page switches the position to "where I last dragged it"
// (and double-clicking resets it); keep the picker in sync while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.subtitleX) draggedSpot.x = changes.subtitleX.newValue;
  if (changes.subtitleY) draggedSpot.y = changes.subtitleY.newValue;
  if (changes.subtitlePosition && changes.subtitlePosition.newValue) {
    subtitlePositionInput.value = changes.subtitlePosition.newValue;
  }
  if (changes.subtitlePosition || changes.subtitleX || changes.subtitleY) {
    updatePreview();
    refreshConfigStates(); // a drag on the page can make the display config "edited"
  }
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function updateStatus() {
  chrome.runtime.sendMessage({ type: 'get-status' }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn("Could not communicate with background script:", chrome.runtime.lastError.message);
      return;
    }
    if (response) {
      isCapturing = response.isCapturing;

      // Update toggle button
      renderLiveStats();
      if (isCapturing) {
        toggleBtn.textContent = t('btnStop');
        toggleBtn.className = 'btn btn-stop';
        captureStatus.textContent = t('statusCapturing');
        captureStatus.className = 'chip live';
      } else {
        toggleBtn.textContent = t('btnStart');
        toggleBtn.className = 'btn btn-start';
        captureStatus.textContent = t('statusInactive');
        captureStatus.className = 'chip';
      }

      // Update connection status
      if (response.isConnected) {
        connectionStatus.textContent = t('statusConnected');
        connectionStatus.className = 'meta-value online';
      } else {
        connectionStatus.textContent = isCapturing ? t('statusConnecting') : t('statusDisconnected');
        connectionStatus.className = 'meta-value offline';
      }
    }
  });
}

// Periodic polling while popup is open
const intervalId = setInterval(updateStatus, 1000);
window.addEventListener('unload', () => clearInterval(intervalId));

// Button toggle
toggleBtn.addEventListener('click', async () => {
  if (isCapturing) {
    chrome.runtime.sendMessage({ type: 'stop-capture' }, () => {
      setTimeout(updateStatus, 200);
    });
  } else {
    saveSettings();
    try {
      // 1. Get active tab
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length === 0) return;
      const tab = tabs[0];

      // 2. Request stream ID under user gesture
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (streamId) => {
        if (chrome.runtime.lastError) {
          console.error("Failed to get audio capture stream ID:", chrome.runtime.lastError.message);
          alert(t('alertPermission') + chrome.runtime.lastError.message);
          return;
        }

        // 3. Send message to background
        chrome.runtime.sendMessage({
          type: 'start-capture',
          streamId: streamId,
          tabId: tab.id
        }, () => {
          setTimeout(updateStatus, 200);
        });
      });
    } catch (err) {
      console.error("Failed to start capture:", err);
    }
  }
});

// ---------------------------------------------------------------------------
// Settings search: type to get matching settings, pick one to jump to it.
// The index is read from the page itself, so it covers every setting in the
// current UI language (plus English names and a few synonyms from data-search).
// ---------------------------------------------------------------------------

const searchInput = document.getElementById('settings-search');
const searchMenu = document.getElementById('search-results');
const SEARCHABLE = '.panel-title, .field, .switch-row, .swatch-field, .shortcut-row';
const WORD_BREAK = /[\s\-(/·,&]/;
const MAX_RESULTS = 8;
let searchItems = [];
let searchActive = -1;

function cleanLabel(text) {
  return (text || '').replace(/\s+/g, ' ').replace(/\s*[:：]\s*$/, '').trim();
}

// Lower-cased code points with accents removed (é -> e), one output char per input char,
// so match positions can be used to highlight the original label.
function foldChars(text) {
  return [...text.toLowerCase()].map(c => c.normalize('NFKD')[0] || c);
}

function labelElementOf(item) {
  if (item.matches('.panel-title')) return item;
  if (item.matches('.field')) {
    const label = item.querySelector(':scope > label');
    return label && (label.querySelector('[data-i18n]') || label);
  }
  return item.querySelector('[data-i18n]') || item.querySelector('span');
}

function buildSearchIndex() {
  const items = [];
  document.querySelectorAll('.tab-panel').forEach(panel => {
    const tabButton = document.querySelector(`.segmented button[data-tab="${panel.dataset.panel}"]`);
    const tabLabel = cleanLabel(tabButton.textContent);
    panel.querySelectorAll(SEARCHABLE).forEach(el => {
      // Skip settings hidden for another reason than their tab being closed (e.g. Ollama fields
      // while LM Studio is selected).
      const hidden = el.closest('[hidden]');
      if (hidden && hidden !== panel) return;
      const labelEl = labelElementOf(el);
      const label = cleanLabel(labelEl && labelEl.textContent);
      if (!label) return;
      const panelEl = el.closest('.panel');
      const title = panelEl && panelEl.querySelector('.panel-title');
      const section = title && title !== el ? cleanLabel(title.textContent) : '';
      const english = labelEl && labelEl.dataset.i18n ? cleanLabel(lcTranslate('en', labelEl.dataset.i18n)) : '';
      items.push({
        el,
        tab: panel.dataset.panel,
        label,
        crumb: [tabLabel, section].filter(Boolean).join(' › '),
        extra: [english, el.dataset.search || '', section, tabLabel].join(' ')
      });
    });
  });
  return items;
}

// Optimal string alignment distance (Levenshtein + adjacent swaps), for typo tolerance.
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

// Best "letters in order" match of `letters` in `t`, trying every start point so the
// highlight lands on the tightest match ("opacty" -> [O]pac[ity], not Backgr[o]und...).
function subsequenceMatch(letters, t) {
  let best = null;
  for (let start = t.indexOf(letters[0]); start !== -1; start = t.indexOf(letters[0], start + 1)) {
    // Abbreviations start at the beginning of a word ("ctx" -> Context, "shdw" -> Shadow).
    if (start > 0 && !WORD_BREAK.test(t[start - 1])) continue;
    const positions = [];
    let score = 0;
    let gaps = 0;
    let from = start;
    let prev = -2;
    for (const c of letters) {
      const found = t.indexOf(c, from);
      if (found === -1) return best; // later starts can't match either
      score += 10;
      if (found === prev + 1) score += 15;
      if (found === 0 || WORD_BREAK.test(t[found - 1])) score += 20;
      if (prev >= 0) {
        gaps += found - prev - 1;
        score -= Math.min(found - prev - 1, 8); // gaps between matched letters
      }
      positions.push(found);
      prev = found;
      from = found + 1;
    }
    // Letters scattered far apart ("time" in "Transla-t-i-on M-od-e-l") aren't a real match.
    if (gaps > letters.length * 2) continue;
    if (!best || score > best.score) best = { score, positions };
  }
  return best;
}

// Score `query` against `text`: { score, positions } or null when it doesn't match.
// Exact substring > letters in order (only when `fuzzy`) > every word within a small typo distance.
function matchScore(query, text, fuzzy = true) {
  const q = foldChars(query.trim());
  const t = foldChars(text);
  if (!q.length || !t.length) return null;
  const tStr = t.join('');
  const qStr = q.join('');

  const at = tStr.indexOf(qStr);
  if (at !== -1) {
    const idx = [...tStr.slice(0, at)].length;
    const wordStart = idx === 0 || WORD_BREAK.test(t[idx - 1]);
    return {
      score: 1000 + (wordStart ? 200 : 0) + (q.length === t.length ? 300 : 0) - idx,
      positions: q.map((_, k) => idx + k)
    };
  }

  // Letters in order, rewarding runs and word starts ("fnt sz" -> "Subtitle Font Size").
  if (fuzzy) {
    const letters = q.filter(c => !/\s/.test(c));
    const sub = subsequenceMatch(letters, t);
    if (sub && sub.score > letters.length * 12) return sub;
  }

  // Typos: every query word must be close to a word (or the start of a word) in the text.
  const words = tStr.split(WORD_BREAK).filter(Boolean);
  let total = 0;
  for (const qw of qStr.split(/\s+/).filter(Boolean)) {
    const allowed = qw.length >= 7 ? 2 : qw.length >= 4 ? 1 : 0;
    let best = Infinity;
    for (const w of words) {
      best = Math.min(best, editDistance(qw, w), editDistance(qw, w.slice(0, qw.length)));
    }
    if (best > allowed) return null;
    total += 40 - best * 15;
  }
  return { score: total, positions: [] };
}

function searchSettings(query) {
  const results = [];
  for (const item of searchItems) {
    const onLabel = matchScore(query, item.label);
    // Synonyms and section names: whole words or typos only, since loose letter matching over
    // that longer text finds letters in order almost anywhere.
    const onExtra = matchScore(query, item.extra, false);
    const score = Math.max(onLabel ? onLabel.score : -Infinity, onExtra ? onExtra.score * 0.6 : -Infinity);
    if (score === -Infinity) continue;
    results.push({ item, score, positions: onLabel ? onLabel.positions : [] });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS);
}

// The label with the matched characters wrapped in <mark>.
function highlighted(label, positions) {
  const frag = document.createDocumentFragment();
  const marks = new Set(positions);
  let run = '';
  let runMarked = false;
  const flush = () => {
    if (!run) return;
    if (runMarked) {
      const mark = document.createElement('mark');
      mark.textContent = run;
      frag.appendChild(mark);
    } else {
      frag.appendChild(document.createTextNode(run));
    }
    run = '';
  };
  [...label].forEach((ch, i) => {
    if (marks.has(i) !== runMarked) {
      flush();
      runMarked = marks.has(i);
    }
    run += ch;
  });
  flush();
  return frag;
}

function renderSearch() {
  const query = searchInput.value;
  searchMenu.innerHTML = '';
  searchActive = -1;
  if (!query.trim()) {
    closeSearch();
    return;
  }
  // Rebuilt on every keystroke (it's ~35 settings): labels follow the UI language and whichever
  // settings are currently visible.
  searchItems = buildSearchIndex();
  const results = searchSettings(query);
  if (!results.length) {
    const empty = document.createElement('li');
    empty.className = 'search-empty';
    empty.textContent = t('searchNoResults');
    searchMenu.appendChild(empty);
  }
  results.forEach((result, i) => {
    const li = document.createElement('li');
    li.id = `search-option-${i}`;
    li.setAttribute('role', 'option');
    li.className = 'search-option';
    const label = document.createElement('span');
    label.className = 'search-label';
    label.appendChild(highlighted(result.item.label, result.positions));
    const crumb = document.createElement('span');
    crumb.className = 'search-crumb';
    crumb.textContent = result.item.crumb;
    li.append(label, crumb);
    // mousedown (not click) so the input doesn't lose focus and close the list first
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      goToSetting(result.item);
    });
    li.addEventListener('mousemove', () => setActive(i));
    li.searchItem = result.item;
    searchMenu.appendChild(li);
  });
  searchMenu.hidden = false;
  searchInput.setAttribute('aria-expanded', 'true');
  if (results.length) setActive(0);
}

function setActive(index) {
  const options = [...searchMenu.querySelectorAll('.search-option')];
  if (!options.length) return;
  searchActive = (index + options.length) % options.length;
  options.forEach((li, i) => li.classList.toggle('active', i === searchActive));
  const active = options[searchActive];
  searchInput.setAttribute('aria-activedescendant', active.id);
  active.scrollIntoView({ block: 'nearest' });
}

function closeSearch() {
  searchMenu.hidden = true;
  searchInput.setAttribute('aria-expanded', 'false');
  searchInput.removeAttribute('aria-activedescendant');
}

function goToSetting(item) {
  searchInput.value = '';
  closeSearch();
  searchInput.blur();
  showTab(item.tab);
  // A section title highlights its whole panel; a setting highlights its own row.
  const target = item.el.matches('.panel-title') ? item.el.closest('.panel') : item.el;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('search-hit');
  void target.offsetWidth; // restart the highlight animation
  target.classList.add('search-hit');
  setTimeout(() => target.classList.remove('search-hit'), 1800);
  const control = item.el.matches('.panel-title') ? null
    : item.el.querySelector('.lang-trigger') || item.el.querySelector('select, input, button');
  if (control) setTimeout(() => control.focus({ preventScroll: true }), 400);
}

searchInput.addEventListener('focus', () => {
  if (searchInput.value.trim()) renderSearch();
});
searchInput.addEventListener('input', renderSearch);
searchInput.addEventListener('blur', closeSearch);
searchInput.addEventListener('keydown', (e) => {
  const open = !searchMenu.hidden;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!open) renderSearch();
    else setActive(searchActive + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (open) setActive(searchActive - 1);
  } else if (e.key === 'Enter') {
    const active = searchMenu.querySelectorAll('.search-option')[searchActive];
    if (open && active) {
      e.preventDefault();
      goToSetting(active.searchItem);
    }
  } else if (e.key === 'Escape') {
    if (open) {
      e.preventDefault();
      closeSearch();
    } else {
      searchInput.value = '';
      searchInput.blur();
    }
  }
});

// "/" jumps to the search box (unless you're typing somewhere else).
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.matches('input, select, textarea')) return;
  e.preventDefault();
  searchInput.focus();
});

// ---------------------------------------------------------------------------
// Saved configs. Two independent kinds:
//   - profiles: the translation setup (LLM server + URL, model, context size, languages,
//     speech engine, bilingual mode). The DeepSeek key is deliberately never copied into them.
//   - display configs: the subtitle look, layout and timing.
// Stored as chrome.storage.local `profiles` / `displayConfigs` ([{ id, name, settings }]) plus the
// id of the active one (`activeProfile` / `activeDisplayConfig`).
// ---------------------------------------------------------------------------

function setDisplayInputs(look) {
  const s = { ...LC_SUBTITLE_DEFAULTS, ...look };
  bgColorInput.value = s.bgColor;
  textColorInput.value = s.textColor;
  bgOpacityInput.value = s.bgOpacity;
  fontSizeInput.value = LC_FONT_SIZES[s.fontSize] ? s.fontSize : 'medium';
  buildFontSelect();
  fontFamilyInput.value = LC_FONTS[s.fontFamily] ? s.fontFamily : 'system';
  fontWeightInput.value = s.fontWeight;
  textShadowInput.value = s.textShadow;
  shadowColorInput.value = s.shadowColor;
  outlineColorInput.value = s.outlineColor;
  outlineWidthInput.value = s.outlineWidth;
  subtitlePositionInput.value = s.subtitlePosition;
  draggedSpot = { x: s.subtitleX, y: s.subtitleY };
  originalPlacementInput.value = s.originalPlacement;
  originalScaleInput.value = s.originalScale;
  historyLinesInput.value = s.historyLines;
  pinSubtitlesInput.checked = s.pinSubtitles === true;
  holdTimeInput.value = s.holdTime;
  minDisplayInput.value = s.minDisplay;
}

function captureDisplay() {
  return {
    ...lookSettings(),
    subtitlePosition: subtitlePositionInput.value,
    subtitleX: draggedSpot.x,
    subtitleY: draggedSpot.y,
    historyLines: parseInt(historyLinesInput.value),
    pinSubtitles: pinSubtitlesInput.checked,
    holdTime: parseFloat(holdTimeInput.value),
    minDisplay: parseFloat(minDisplayInput.value)
  };
}

function applyDisplay(settings) {
  setDisplayInputs(settings);
  // The dragged spot isn't one of the inputs saveSettings() writes, so store it here.
  chrome.storage.local.set({ subtitleX: draggedSpot.x, subtitleY: draggedSpot.y });
  updateRangeLabels();
  updateContextualControls();
  saveSettings();
  updatePreview();
}

function captureProfile() {
  const provider = llmProviderInput.value;
  const models = { ...providerModels };
  if (provider === 'qwencloud') models.qwencloud = qwenModelInput.value.trim();
  else if (modelNameInput.value) models[provider] = modelNameInput.value;
  // While the profile's own model isn't installed yet, another model is used in its place; the
  // profile still means its own model, so it isn't shown as edited.
  if (pendingModel) models.lmstudio = pendingModel.key;
  return {
    llmProvider: provider,
    lmstudioUrl: lmstudioUrlInput.value.trim(),
    ollamaUrl: ollamaUrlInput.value.trim(),
    lmstudioModel: models.lmstudio || '',
    ollamaModel: models.ollama || '',
    qwencloudUrl: qwenUrlInput.value.trim(),
    qwencloudModel: models.qwencloud || '',
    contextSize: parseInt(contextSizeInput.value),
    sourceLang: sourceLangInput.value,
    targetLang: targetLangInput.value,
    asrEngine: asrEngineInput.value,
    showBilingual: showBilingualInput.checked,
    detectSpeakers: detectSpeakersInput.checked,
    speakerThreshold: parseFloat(speakerThresholdInput.value),
    vadThreshold: parseFloat(vadThresholdInput.value),
    minSilence: parseFloat(minSilenceInput.value),
    maxSpeech: parseFloat(maxSpeechInput.value)
  };
}

async function applyProfile(p, config) {
  // The model in use now, to keep translating with if this profile's model isn't installed.
  const previousModel = llmProviderInput.value === 'lmstudio' ? modelNameInput.value : providerModels.lmstudio;
  if (pendingModel) setPendingModel(null);
  llmProviderInput.value = p.llmProvider || DEFAULTS.llmProvider;
  lmstudioUrlInput.value = p.lmstudioUrl || DEFAULTS.lmstudioUrl;
  ollamaUrlInput.value = p.ollamaUrl || DEFAULTS.ollamaUrl;
  providerModels = { lmstudio: p.lmstudioModel || '', ollama: p.ollamaModel || '', qwencloud: providerModels.qwencloud };
  // (Qwen Cloud settings: not in profiles saved before it was added. The API key is never in profiles.)
  if (p.qwencloudUrl !== undefined) qwenUrlInput.value = p.qwencloudUrl || DEFAULTS.qwencloudUrl;
  if (p.qwencloudModel !== undefined) providerModels.qwencloud = p.qwencloudModel;
  qwenModelInput.value = providerModels.qwencloud;
  updateQwenMode();
  contextSizeInput.value = String(p.contextSize || DEFAULTS.contextSize);
  sourceLangInput.value = p.sourceLang || 'auto';
  targetLangInput.value = p.targetLang || 'none';
  asrEngineInput.value = p.asrEngine || 'sensevoice';
  showBilingualInput.checked = p.showBilingual !== false;
  // Profiles saved before these settings existed don't have them: the current values stay.
  if (p.detectSpeakers !== undefined) detectSpeakersInput.checked = p.detectSpeakers === true;
  if (p.speakerThreshold !== undefined) speakerThresholdInput.value = p.speakerThreshold;
  if (p.vadThreshold !== undefined) vadThresholdInput.value = p.vadThreshold;
  if (p.minSilence !== undefined) minSilenceInput.value = p.minSilence;
  if (p.maxSpeech !== undefined) maxSpeechInput.value = p.maxSpeech;
  updateRangeLabels();
  checkSpeakerSupport();
  showProviderFields();
  fillModelSelect(lastModels);
  saveSettings();
  updateHero();
  updateContextualControls();
  updatePreview();
  await refreshModels();
  const wanted = p.lmstudioModel;
  if (llmProviderInput.value === 'lmstudio' && canManageModels && wanted && !lastModels.some(m => m.id === wanted)) {
    // Not installed here: keep translating with the model that was in use, and offer to download
    // this one (Model tab). Imported profiles know where their model comes from.
    const meta = config && config.model && config.model.key === wanted
      ? config.model
      : { key: wanted, name: wanted, download: null, quantization: '', sizeBytes: 0 };
    const fallback = lastModels.some(m => m.id === previousModel) ? previousModel : '';
    providerModels.lmstudio = fallback;
    fillModelSelect(lastModels);
    const inUse = lastModels.find(m => m.id === modelNameInput.value);
    setPendingModel({ ...meta, fallback: inUse ? inUse.name : modelNameInput.value });
    saveSettings();
    updateHero();
    renderLoadState();
    return;
  }
  // Like picking the model in the list: load it into LM Studio at the profile's context size.
  if (llmProviderInput.value === 'lmstudio' && canManageModels && modelNameInput.value) {
    const info = lastModels.find(m => m.id === modelNameInput.value);
    if (!info || !info.loaded || info.ctx !== parseInt(contextSizeInput.value)) modelAction('load');
  }
}

// Same values, ignoring key order and number/string differences from the inputs.
function sameSettings(a, b) {
  const norm = (o) => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k] === null ? null : String(o[k])]));
  return norm(a) === norm(b);
}

class ConfigManager {
  constructor({ prefix, listKey, activeKey, nameKey, capture, apply, onChange, warning, exportItems }) {
    Object.assign(this, { listKey, activeKey, nameKey, capture, apply, onChange, warning, exportItems });
    const $ = (suffix) => document.getElementById(`${prefix}-config-${suffix}`);
    this.select = $('select');
    this.newBtn = $('new');
    this.updateBtn = $('update');
    this.deleteBtn = $('delete');
    this.nameRow = $('name-row');
    this.nameInput = $('name');
    this.status = $('status');
    this.list = [];
    this.activeId = null;
    this.message = null; // { key, name } shown for a moment after an action

    this.select.addEventListener('change', () => this.choose(this.select.value));
    this.newBtn.addEventListener('click', () => this.startNew());
    this.updateBtn.addEventListener('click', () => this.update());
    this.deleteBtn.addEventListener('click', () => this.remove());
    $('name-save').addEventListener('click', () => this.saveNew());
    $('name-cancel').addEventListener('click', () => this.cancelNew());
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.saveNew();
      if (e.key === 'Escape') this.cancelNew();
    });
    $('export').addEventListener('click', () => this.exportAll());
    // A file picker would close the popup, so importing happens on its own page.
    $('import').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('import.html') }));
  }

  load(stored) {
    this.list = Array.isArray(stored[this.listKey]) ? stored[this.listKey] : [];
    this.activeId = this.find(stored[this.activeKey]) ? stored[this.activeKey] : null;
    this.render();
  }

  find(id) {
    return this.list.find(c => c.id === id) || null;
  }

  active() {
    return this.find(this.activeId);
  }

  persist() {
    chrome.storage.local.set({ [this.listKey]: this.list, [this.activeKey]: this.activeId });
    if (this.onChange) this.onChange();
  }

  isEdited() {
    const config = this.active();
    if (!config) return false;
    // Configs saved before a setting existed don't have it, and applying them leaves it as it is,
    // so only the settings a config has are compared.
    const current = this.capture();
    return !sameSettings(config.settings, Object.fromEntries(Object.keys(config.settings).map(k => [k, current[k]])));
  }

  render() {
    this.select.innerHTML = '';
    this.select.add(new Option(t('optNoConfig'), ''));
    for (const config of this.list) this.select.add(new Option(config.name, config.id));
    this.select.value = this.activeId || '';
    this.refresh();
  }

  // Button states and status line; cheap enough to run on every settings change.
  // `settingsChanged`: a real edit replaces any "Saved/Applied" message right away.
  refresh(settingsChanged = false) {
    const edited = this.isEdited();
    if (settingsChanged && edited) this.message = null;
    this.updateBtn.disabled = !edited;
    this.deleteBtn.disabled = !this.active();
    let text = '';
    let cls = '';
    const warning = this.warning && this.warning();
    if (this.message) {
      text = t(this.message.key, this.message.vars);
      cls = this.message.cls || 'ok';
    } else if (edited) {
      text = t('configEdited');
      cls = 'busy';
    } else if (warning) {
      text = warning;
      cls = 'error';
    }
    this.status.textContent = text;
    this.status.className = 'hint config-status' + (cls ? ' ' + cls : '');
    this.status.hidden = !text;
  }

  flash(key, vars, cls) {
    this.message = { key, vars, cls };
    this.refresh();
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.message = null;
      this.refresh();
    }, 2500);
  }

  choose(id) {
    this.cancelDelete();
    const config = this.find(id);
    this.activeId = config ? config.id : null;
    this.persist();
    if (config) {
      this.apply(config.settings, config);
      this.flash('configApplied', { name: config.name });
    } else {
      this.refresh();
    }
  }

  startNew() {
    this.cancelDelete();
    this.nameRow.hidden = false;
    this.nameInput.value = '';
    this.nameInput.placeholder = t(this.nameKey, { n: this.list.length + 1 });
    this.nameInput.focus();
  }

  cancelNew() {
    this.nameRow.hidden = true;
  }

  saveNew() {
    const name = this.nameInput.value.trim() || this.nameInput.placeholder;
    const config = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, settings: this.capture() };
    this.list.push(config);
    this.activeId = config.id;
    this.nameRow.hidden = true;
    this.persist();
    this.render();
    this.flash('configSaved', { name });
  }

  update() {
    const config = this.active();
    if (!config) return;
    const settings = this.capture();
    // Model details from an import only stay while the profile still uses that model.
    if (config.model && config.model.key !== settings.lmstudioModel) delete config.model;
    config.settings = settings;
    this.persist();
    this.flash('configSaved', { name: config.name });
  }

  // Saves every config of this kind to a JSON file (see import.js for the format).
  async exportAll() {
    if (!this.list.length) {
      this.flash('exportNothing', {}, 'busy');
      return;
    }
    const data = {
      format: 'local-ai-live-translate-configs',
      version: 1,
      exportedAt: new Date().toISOString(),
      [this.listKey]: await this.exportItems(this.list)
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `local-ai-live-translate-${this.listKey}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    this.flash('configExported', { n: this.list.length });
  }

  // Two clicks: the first arms the button (red), the second deletes.
  remove() {
    const config = this.active();
    if (!config) return;
    if (!this.deleteArmed) {
      this.deleteArmed = true;
      this.deleteBtn.classList.add('confirm');
      this.deleteBtn.title = t('btnConfirmDelete');
      this.deleteTimer = setTimeout(() => this.cancelDelete(), 3000);
      return;
    }
    this.cancelDelete();
    this.list = this.list.filter(c => c.id !== config.id);
    this.activeId = null;
    this.persist();
    this.render();
    this.flash('configDeleted', { name: config.name });
  }

  cancelDelete() {
    clearTimeout(this.deleteTimer);
    this.deleteArmed = false;
    this.deleteBtn.classList.remove('confirm');
    this.deleteBtn.title = t('btnDeleteConfig');
  }
}

// The status card shows the active profile's name in place of "LIVE TRANSLATE".
function updateHeroLabel() {
  const profile = profileConfigs.active();
  document.getElementById('hero-label').textContent = profile ? profile.name : 'LIVE TRANSLATE';
}

// Profiles are exported with details of their model (name, size and where LM Studio can download
// it from), so the importer can offer to download a model it doesn't have.
async function exportProfiles(list) {
  let installed = [];
  try {
    installed = await lcListLmModels(stripUrl(lmstudioUrlInput.value));
  } catch (e) {}
  const sources = await lcModelSources();
  return list.map(config => {
    const key = config.settings.lmstudioModel;
    const model = installed.find(m => m.id === key);
    const meta = model ? lcModelMeta(model, sources) : (config.model && config.model.key === key ? config.model : null);
    return { name: config.name, settings: config.settings, model: meta };
  });
}

profileConfigs = new ConfigManager({
  prefix: 'profile',
  listKey: 'profiles',
  activeKey: 'activeProfile',
  nameKey: 'defaultProfileName',
  capture: captureProfile,
  apply: applyProfile,
  onChange: updateHeroLabel,
  warning: () => (pendingModel ? t('modelMissingShort', { model: pendingModel.name || pendingModel.key }) : null),
  exportItems: exportProfiles
});

displayConfigs = new ConfigManager({
  prefix: 'display',
  listKey: 'displayConfigs',
  activeKey: 'activeDisplayConfig',
  nameKey: 'defaultDisplayName',
  capture: captureDisplay,
  apply: applyDisplay,
  exportItems: async (list) => list.map(config => ({ name: config.name, settings: config.settings }))
});

function refreshConfigStates() {
  if (!profileConfigs) return; // during start-up
  profileConfigs.refresh(true);
  displayConfigs.refresh(true);
  updateHeroLabel();
}

// ---------------------------------------------------------------------------
// Missing models: when a profile's model isn't installed, the model in use keeps translating and
// the Model tab offers to download it through LM Studio. Downloads keep running in LM Studio when
// the popup closes; the popup picks up the progress again when it's reopened.
// ---------------------------------------------------------------------------

function setPendingModel(meta) {
  pendingModel = meta;
  chrome.storage.local.set({ pendingModel: meta });
  renderMissingModel();
  refreshConfigStates();
}

function setModelDownload(download) {
  modelDownload = download;
  chrome.storage.local.set({ lmDownload: download });
  renderMissingModel();
}

function renderMissingModel() {
  const box = document.getElementById('model-missing');
  box.hidden = !pendingModel || llmProviderInput.value !== 'lmstudio';
  if (box.hidden) return;

  const name = pendingModel.name || pendingModel.key;
  document.getElementById('model-missing-text').textContent =
    t('modelMissingProfile', { model: name, fallback: pendingModel.fallback || '\u2014' });

  const button = document.getElementById('download-model');
  const status = document.getElementById('download-status');
  const progress = document.getElementById('download-progress');
  const download = modelDownload && modelDownload.key === pendingModel.key ? modelDownload : null;
  const known = lcValidDownloadSource(pendingModel.download);
  // Without a known source the button first looks the model up on Hugging Face.
  const canDownload = known || (lcCanFindModel(pendingModel) && !pendingModel.notFound);
  const running = download && ['searching', 'starting', 'downloading', 'paused', 'completed'].includes(download.status);

  button.hidden = !canDownload || running;
  button.textContent = !known ? t('btnFindDownload')
    : pendingModel.sizeBytes ? t('btnDownloadModel', { size: lcFormatBytes(pendingModel.sizeBytes) })
      : t('btnDownloadModelNoSize');
  progress.hidden = !running || download.status === 'searching';

  let text = '';
  if (!canDownload) {
    text = t(pendingModel.notFound ? 'downloadNotFound' : 'downloadNoSource');
  } else if (download) {
    if (download.status === 'searching') text = t('downloadSearching');
    else if (download.status === 'starting') text = t('downloadStarting');
    else if (download.status === 'paused') text = t('downloadPaused');
    else if (download.status === 'failed') text = t('downloadFailed', { err: download.error || '' });
    else {
      const pct = download.total ? Math.floor((download.downloaded / download.total) * 100) : 0;
      text = t('downloadProgress', { pct, done: lcFormatBytes(download.downloaded) || '0 MB', total: lcFormatBytes(download.total) });
      document.getElementById('download-bar').style.width = pct + '%';
    }
  }
  status.textContent = text;
}

async function startModelDownload() {
  let meta = pendingModel;
  if (!meta) return;
  const base = stripUrl(lmstudioUrlInput.value);
  if (!lcValidDownloadSource(meta.download)) {
    // The profile doesn't say where its model comes from: find it on Hugging Face first.
    if (!lcCanFindModel(meta)) return;
    setModelDownload({ key: meta.key, base, status: 'searching' });
    const found = await lcFindModelSource(meta);
    if (!pendingModel || pendingModel.key !== meta.key) return;
    if (!found) {
      setModelDownload(null);
      setPendingModel({ ...meta, notFound: true });
      renderMissingModel();
      return;
    }
    meta = { ...meta, download: found.download, sizeBytes: meta.sizeBytes || found.sizeBytes };
    setPendingModel(meta);
    rememberModelSource(meta);
  }
  setModelDownload({ key: meta.key, base, status: 'starting' });
  try {
    const res = await lcStartDownload(base, meta);
    if (!res.job_id || res.status === 'already_downloaded' || res.status === 'completed') {
      setModelDownload(null);
      await modelReady(meta.key);
      return;
    }
    setModelDownload({ jobId: res.job_id, key: meta.key, base, status: res.status || 'downloading', downloaded: 0, total: res.total_size_bytes || meta.sizeBytes });
    pollModelDownload();
  } catch (e) {
    setModelDownload({ key: meta.key, base, status: 'failed', error: e.message });
  }
}

function pollModelDownload() {
  clearTimeout(downloadTimer);
  if (!modelDownload || !modelDownload.jobId || !['downloading', 'paused'].includes(modelDownload.status)) return;
  downloadTimer = setTimeout(async () => {
    try {
      const st = await lcDownloadStatus(modelDownload.base, modelDownload.jobId);
      if (st.status === 'completed') {
        // Stays at 100% until the model is switched to, so the button doesn't reappear meanwhile.
        const key = modelDownload.key;
        setModelDownload({ ...modelDownload, status: 'completed', downloaded: modelDownload.total });
        await modelReady(key);
        setModelDownload(null);
        return;
      }
      setModelDownload({
        ...modelDownload,
        status: st.status,
        downloaded: st.downloaded_bytes || 0,
        total: st.total_size_bytes || modelDownload.total
      });
    } catch (e) {
      // LM Studio briefly unreachable: keep trying
    }
    pollModelDownload();
  }, 1000);
}

// Keep a looked-up download source with the saved profile(s) using that model, so exporting them
// again carries it.
async function rememberModelSource(meta) {
  const { profiles = [] } = await chrome.storage.local.get('profiles');
  let changed = false;
  for (const profile of profiles) {
    if (profile.settings && profile.settings.lmstudioModel === meta.key && !(profile.model && profile.model.download)) {
      profile.model = { ...(profile.model || {}), key: meta.key, name: meta.name || meta.key, publisher: meta.publisher || '',
        quantization: meta.quantization || '', sizeBytes: meta.sizeBytes || 0, download: meta.download };
      changed = true;
    }
  }
  if (changed) chrome.storage.local.set({ profiles });
}

// The profile's model is installed now: use it and load it into LM Studio.
async function modelReady(key) {
  await refreshModels();
  if (!pendingModel || pendingModel.key !== key || !lastModels.some(m => m.id === key)) return;
  const name = pendingModel.name || key;
  providerModels.lmstudio = key;
  setPendingModel(null);
  fillModelSelect(lastModels);
  modelNameInput.value = key;
  saveSettings();
  renderLoadState();
  updateHero();
  if (canManageModels) modelAction('load');
  profileConfigs.flash('downloadDone', { model: name });
}

// On popup open: a download still running, or a model that finished while the popup was closed.
function resumeModelDownload() {
  if (pendingModel && lastModels.some(m => m.id === pendingModel.key)) {
    modelReady(pendingModel.key);
  } else if (modelDownload && ['completed', 'searching'].includes(modelDownload.status)) {
    // (a Hugging Face lookup cut short by closing the popup: just offer the button again)
    setModelDownload(null);
  } else if (modelDownload) {
    renderMissingModel();
    pollModelDownload();
  }
}

document.getElementById('download-model').addEventListener('click', startModelDownload);
