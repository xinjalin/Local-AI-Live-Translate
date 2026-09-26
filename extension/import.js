// Import page. Reads a configs file exported from the popup (Export on the Profile or Display
// Config panel), previews it, checks each profile's model against LM Studio - offering to download
// missing ones, which can be skipped and done later from the Model tab - and adds the chosen configs.
//
// File format:
// {
//   "format": "local-ai-live-translate-configs", "version": 1, "exportedAt": "...",
//   "profiles":       [{ "name", "settings": {...}, "model": { key, name, quantization, sizeBytes, download } }],
//   "displayConfigs": [{ "name", "settings": {...} }]
// }
// Every value is checked against the allowed options before it is stored.

let lang = 'en';
let lmBase = 'http://127.0.0.1:1234';
let items = []; // { kind, name, finalName, settings, model, checkbox }

const t = (key, vars) => lcTranslate(lang, key, vars);
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function sanitizeName(v) {
  return str(v, 60).replace(/[\u0000-\u001f]/g, '');
}

function sanitizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const profile = sanitizeProfileBase(raw);
  // Speaker labels and speech detection tuning: only in profiles saved by newer versions.
  const optional = (key, min, max) => {
    const v = raw[key];
    if (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v))) profile[key] = Math.min(Math.max(Number(v), min), max);
  };
  if (raw.detectSpeakers !== undefined) profile.detectSpeakers = raw.detectSpeakers === true;
  // Qwen Cloud (the API key is never exported): an https address and a model name
  if (raw.qwencloudUrl !== undefined) {
    let url = 'https://maas.qwencloudapi.com';
    try {
      const u = new URL(str(raw.qwencloudUrl));
      if (u.protocol === 'https:') url = (u.origin + u.pathname).replace(/\/+$/, '');
    } catch (e) {}
    profile.qwencloudUrl = url;
  }
  if (raw.qwencloudModel !== undefined) profile.qwencloudModel = str(raw.qwencloudModel, 120).replace(/[^\w.\-:/]/g, '');
  optional('speakerThreshold', 0.3, 0.7);
  optional('vadThreshold', 0.2, 0.8);
  optional('minSilence', 0.2, 1.2);
  optional('maxSpeech', 2, 12);
  return profile;
}

function sanitizeProfileBase(raw) {
  const origin = (v, fallback) => {
    try {
      const u = new URL(str(v));
      // Scheme, host, port and path only: no credentials, query or fragment.
      return u.protocol === 'http:' || u.protocol === 'https:' ? (u.origin + u.pathname).replace(/\/+$/, '') : fallback;
    } catch (e) {
      return fallback;
    }
  };
  return {
    llmProvider: ['ollama', 'qwencloud'].includes(raw.llmProvider) ? raw.llmProvider : 'lmstudio',
    lmstudioUrl: origin(raw.lmstudioUrl, 'http://127.0.0.1:1234'),
    ollamaUrl: origin(raw.ollamaUrl, 'http://127.0.0.1:11434'),
    lmstudioModel: str(raw.lmstudioModel, 200),
    ollamaModel: str(raw.ollamaModel, 200),
    contextSize: [4096, 8192, 16384].includes(Number(raw.contextSize)) ? Number(raw.contextSize) : 4096,
    sourceLang: raw.sourceLang === 'auto' || LC_LANG_CODES.includes(raw.sourceLang) ? raw.sourceLang : 'auto',
    targetLang: raw.targetLang === 'none' || LC_LANG_CODES.includes(raw.targetLang) ? raw.targetLang : 'none',
    asrEngine: ['whisper', 'dolphin'].includes(raw.asrEngine) ? raw.asrEngine : 'sensevoice',
    showBilingual: raw.showBilingual !== false
  };
}

function sanitizeDisplay(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const d = LC_SUBTITLE_DEFAULTS;
  const color = (v, fallback) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fallback);
  const num = (v, min, max, fallback) =>
    (v !== null && v !== '' && Number.isFinite(Number(v)) ? Math.min(Math.max(Number(v), min), max) : fallback);
  const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
  const fraction = (v) => (v === null || v === undefined ? null : num(v, 0, 1, null));
  return {
    bgColor: color(raw.bgColor, d.bgColor),
    textColor: color(raw.textColor, d.textColor),
    bgOpacity: num(raw.bgOpacity, 0, 100, d.bgOpacity),
    fontSize: pick(raw.fontSize, Object.keys(LC_FONT_SIZES), d.fontSize),
    fontFamily: pick(raw.fontFamily, Object.keys(LC_FONTS), d.fontFamily),
    fontWeight: pick(raw.fontWeight, Object.keys(LC_FONT_WEIGHTS), d.fontWeight),
    textShadow: pick(raw.textShadow, LC_TEXT_SHADOW_STYLES, d.textShadow),
    shadowColor: color(raw.shadowColor, d.shadowColor),
    outlineColor: color(raw.outlineColor, d.outlineColor),
    outlineWidth: num(raw.outlineWidth, 0.5, 5, d.outlineWidth),
    originalPlacement: pick(raw.originalPlacement, ['above', 'below'], d.originalPlacement),
    originalScale: num(raw.originalScale, 50, 100, d.originalScale),
    subtitlePosition: pick(raw.subtitlePosition, ['bottom', 'top', 'custom'], d.subtitlePosition),
    subtitleX: fraction(raw.subtitleX),
    subtitleY: fraction(raw.subtitleY),
    historyLines: pick(Number(raw.historyLines), [0, 1, 2], d.historyLines),
    pinSubtitles: raw.pinSubtitles === true,
    holdTime: num(raw.holdTime, 0, 5, d.holdTime),
    minDisplay: num(raw.minDisplay, 1, 10, d.minDisplay)
  };
}

function sanitizeModel(raw, key) {
  if (!raw || typeof raw !== 'object' || !key || str(raw.key, 200) !== key) return null;
  const size = Number(raw.sizeBytes);
  return {
    key,
    name: str(raw.name, 120) || key,
    quantization: str(raw.quantization, 24),
    sizeBytes: Number.isFinite(size) && size > 0 ? size : 0,
    download: lcValidDownloadSource(raw.download) ? raw.download : null
  };
}

// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------

function uniqueName(name, taken) {
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name} (${n})`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

async function readFile(file) {
  $('file-error').hidden = true;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    data = null;
  }
  const parsed = [];
  if (data && typeof data === 'object') {
    for (const raw of Array.isArray(data.profiles) ? data.profiles : []) {
      const settings = sanitizeProfile(raw && raw.settings);
      const name = sanitizeName(raw && raw.name);
      if (settings && name) {
        parsed.push({ kind: 'profiles', name, settings, model: sanitizeModel(raw.model, settings.lmstudioModel) });
      }
    }
    for (const raw of Array.isArray(data.displayConfigs) ? data.displayConfigs : []) {
      const settings = sanitizeDisplay(raw && raw.settings);
      const name = sanitizeName(raw && raw.name);
      if (settings && name) parsed.push({ kind: 'displayConfigs', name, settings });
    }
  }
  if (!parsed.length) {
    $('file-error').textContent = t('importInvalid');
    $('file-error').hidden = false;
    return;
  }

  // Names already in use get a " (2)" suffix so nothing is overwritten.
  const stored = await chrome.storage.local.get(['profiles', 'displayConfigs']);
  const taken = {
    profiles: new Set((stored.profiles || []).map(c => c.name.toLowerCase())),
    displayConfigs: new Set((stored.displayConfigs || []).map(c => c.name.toLowerCase()))
  };
  for (const item of parsed) item.finalName = uniqueName(item.name, taken[item.kind]);

  items = parsed;
  renderItems();
  checkModels();
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

function langName(code, special) {
  return code === special ? t(special === 'auto' ? 'heroAuto' : 'heroOriginal') : lcLanguageName(code, lang);
}

function profileSummary(s, model) {
  const provider = { ollama: 'Ollama', qwencloud: 'Qwen Cloud' }[s.llmProvider] || 'LM Studio';
  const modelName = { ollama: s.ollamaModel, qwencloud: s.qwencloudModel }[s.llmProvider] ||
    (s.llmProvider === 'lmstudio' ? ((model && model.name) || s.lmstudioModel) : '');
  const langs = `${langName(s.sourceLang, 'auto')} → ${langName(s.targetLang, 'none')}`;
  return [provider, modelName, langs, s.detectSpeakers ? t('labelDetectSpeakers') : ''].filter(Boolean).join(' · ');
}

const SIZE_KEYS = { xsmall: 'optSizeXsmall', small: 'optSizeSmall', medium: 'optSizeMedium', large: 'optSizeLarge', xlarge: 'optSizeXlarge', xxlarge: 'optSizeXxlarge', huge: 'optSizeHuge' };
const SHADOW_KEYS = { off: 'optShadowOff', soft: 'optShadowSoft', medium: 'optShadowMedium', strong: 'optShadowStrong', outline: 'optShadowOutline' };

function displaySummary(s) {
  const font = LC_FONTS[s.fontFamily].label || t('optFontSystem');
  return [font, t(SIZE_KEYS[s.fontSize]), `${t('labelTextShadow')}: ${t(SHADOW_KEYS[s.textShadow])}`].join(' · ');
}

function hint(text, cls) {
  const el = document.createElement('div');
  el.className = 'hint' + (cls ? ' ' + cls : '');
  el.textContent = text;
  return el;
}

function renderItems() {
  $('pick-panel').hidden = true;
  $('items').hidden = false;
  const lists = { profiles: $('profile-items'), displayConfigs: $('display-items') };
  lists.profiles.innerHTML = '';
  lists.displayConfigs.innerHTML = '';
  $('profiles-panel').hidden = !items.some(i => i.kind === 'profiles');
  $('display-panel').hidden = !items.some(i => i.kind === 'displayConfigs');

  items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'import-item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.id = `import-item-${index}`;
    item.checkbox = checkbox;

    const body = document.createElement('div');
    body.className = 'import-body';
    const name = document.createElement('label');
    name.className = 'import-name';
    name.htmlFor = checkbox.id;
    name.textContent = item.name;
    body.appendChild(name);
    if (item.finalName !== item.name) body.appendChild(hint(t('importRenamed', { name: item.finalName })));

    if (item.kind === 'profiles') {
      const s = item.settings;
      body.appendChild(hint(profileSummary(s, item.model)));
      const server = { ollama: s.ollamaUrl, qwencloud: s.qwencloudUrl }[s.llmProvider] || s.lmstudioUrl;
      if (!lcIsLocalUrl(server)) body.appendChild(hint(t('importRemoteServer', { host: server }), 'error'));
      item.modelEl = document.createElement('div');
      item.modelEl.className = 'import-model';
      body.appendChild(item.modelEl);
    } else {
      body.appendChild(hint(displaySummary(item.settings)));
    }
    row.append(checkbox, body);
    lists[item.kind].appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Profile models: installed? If not, offer a download (skippable)
// ---------------------------------------------------------------------------

async function checkModels() {
  const profiles = items.filter(i => i.kind === 'profiles' && i.settings.llmProvider === 'lmstudio' && i.settings.lmstudioModel);
  if (!profiles.length) return;
  $('lm-note').textContent = t('importCheckingModels');
  $('lm-note').hidden = false;
  let installed = null;
  try {
    installed = await lcListLmModels(lmBase);
  } catch (e) {}
  if (!installed) {
    $('lm-note').textContent = t('importLmUnreachable');
    return;
  }
  $('lm-note').hidden = true;
  for (const item of profiles) {
    const key = item.settings.lmstudioModel;
    const model = installed.find(m => m.id === key);
    item.modelEl.innerHTML = '';
    if (model) {
      item.modelEl.appendChild(hint(t('importModelInstalled', { model: model.name }), 'ok'));
    } else {
      renderMissing(item);
    }
  }
}

function renderMissing(item, state = {}) {
  const meta = item.model || { key: item.settings.lmstudioModel, name: item.settings.lmstudioModel, sizeBytes: 0, download: null };
  const el = item.modelEl;
  el.innerHTML = '';
  if (state.done) {
    el.appendChild(hint(t('importModelDownloaded', { model: meta.name }), 'ok'));
    return;
  }
  const size = lcFormatBytes(meta.sizeBytes);
  el.appendChild(hint(t('importModelMissing', { model: size ? `${meta.name} (${size})` : meta.name }), 'error'));
  if (state.later) {
    el.appendChild(hint(t('importLaterNote')));
    return;
  }
  if (!meta.download) {
    el.appendChild(hint(t('downloadNoSource')));
    return;
  }
  el.appendChild(hint(t('importDownloadFrom', { source: meta.download.replace('https://', '') })));

  if (state.progress) {
    const p = state.progress;
    const pct = p.total ? Math.floor((p.downloaded / p.total) * 100) : 0;
    const bar = document.createElement('div');
    bar.className = 'progress';
    bar.innerHTML = '<div class="progress-bar"></div>';
    bar.firstChild.style.width = pct + '%';
    el.append(hint(p.status === 'paused' ? t('downloadPaused')
      : p.status === 'starting' ? t('downloadStarting')
        : t('downloadProgress', { pct, done: lcFormatBytes(p.downloaded) || '0 MB', total: lcFormatBytes(p.total) })), bar);
    return;
  }
  if (state.error) el.appendChild(hint(t('downloadFailed', { err: state.error }), 'error'));

  const actions = document.createElement('div');
  actions.className = 'import-actions';
  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'small-btn primary';
  download.textContent = size ? t('btnDownloadModel', { size }) : t('btnDownloadModelNoSize');
  download.addEventListener('click', () => downloadModel(item, meta));
  const later = document.createElement('button');
  later.type = 'button';
  later.className = 'small-btn';
  later.textContent = t('importLater');
  later.addEventListener('click', () => renderMissing(item, { later: true }));
  actions.append(download, later);
  el.appendChild(actions);
}

async function downloadModel(item, meta) {
  renderMissing(item, { progress: { status: 'starting', downloaded: 0, total: meta.sizeBytes } });
  let res;
  try {
    res = await lcStartDownload(lmBase, meta);
  } catch (e) {
    renderMissing(item, { error: e.message });
    return;
  }
  if (!res.job_id || res.status === 'already_downloaded' || res.status === 'completed') {
    renderMissing(item, { done: true });
    return;
  }
  const poll = async () => {
    try {
      const st = await lcDownloadStatus(lmBase, res.job_id);
      if (st.status === 'completed') {
        renderMissing(item, { done: true });
        return;
      }
      if (st.status === 'failed') {
        renderMissing(item, { error: '' });
        return;
      }
      renderMissing(item, { progress: { status: st.status, downloaded: st.downloaded_bytes || 0, total: st.total_size_bytes || meta.sizeBytes } });
    } catch (e) {
      // LM Studio briefly unreachable: keep trying
    }
    setTimeout(poll, 1000);
  };
  poll();
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

async function importSelected() {
  const chosen = items.filter(i => i.checkbox.checked);
  if (!chosen.length) {
    $('import-error').textContent = t('importNothing');
    $('import-error').hidden = false;
    return;
  }
  const stored = await chrome.storage.local.get(['profiles', 'displayConfigs']);
  const lists = { profiles: stored.profiles || [], displayConfigs: stored.displayConfigs || [] };
  for (const item of chosen) {
    const config = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: item.finalName, settings: item.settings };
    if (item.model) config.model = item.model;
    lists[item.kind].push(config);
  }
  await chrome.storage.local.set(lists);
  $('items').hidden = true;
  $('done-panel').hidden = false;
  $('done-text').textContent = t('importDone', { n: chosen.length });
}

// ---------------------------------------------------------------------------
// Page setup
// ---------------------------------------------------------------------------

(async () => {
  const stored = await chrome.storage.local.get(['uiLang', 'theme', 'lmstudioUrl']);
  lang = stored.uiLang || 'en';
  lmBase = (stored.lmstudioUrl || lmBase).trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  const theme = stored.theme || 'dark';
  document.documentElement.dataset.theme = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.title = `${t('importTitle')} · Local AI Live Translate`;
})();

$('file-input').addEventListener('change', (e) => {
  if (e.target.files[0]) readFile(e.target.files[0]);
});
const drop = $('drop-zone');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
});
$('import-btn').addEventListener('click', importSelected);
$('close-btn').addEventListener('click', () => window.close());
