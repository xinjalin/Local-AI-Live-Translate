// Online AI providers and their API keys (popup, offscreen document and background worker).
//
// Online providers are only offered once "Cloud AI providers" is turned on (Model tab). While one
// is the chosen translator, the text of what's captured is sent to it - through the app server on
// this PC, which only ever sends a key to its own provider's HTTPS address (server/translator.py).
//
// API keys are kept in this extension's own IndexedDB, not in chrome.storage: chrome.storage.local
// is also readable by the extension's script inside every web page (content.js), which even gets
// told about each change to it. IndexedDB belongs to the extension's origin, so only the
// extension's own pages can open it. Keys are never put in profiles, exports or messages between
// the extension's parts; the offscreen document reads them here when it configures the app server.

const LC_LOCAL_PROVIDERS = ['lmstudio', 'ollama'];

// keysUrl: where to create a key. models: the provider's model list (read with the key, straight
// from the popup; the key goes nowhere else from here).
const LC_CLOUD_PROVIDERS = {
  qwencloud: { name: 'Qwen Cloud', keysUrl: 'https://home.qwencloud.com/api-keys' },
  openai: { name: 'OpenAI', keysUrl: 'https://platform.openai.com/api-keys',
            models: 'https://api.openai.com/v1/models', prefer: [/-mini$/, /mini/] },
  anthropic: { name: 'Anthropic Claude', keysUrl: 'https://console.anthropic.com/settings/keys',
               models: 'https://api.anthropic.com/v1/models', prefer: [/haiku/] },
  deepseek: { name: 'DeepSeek', keysUrl: 'https://platform.deepseek.com/api_keys',
              models: 'https://api.deepseek.com/models', prefer: [/^deepseek-chat$/] },
  google: { name: 'Google Gemini', keysUrl: 'https://aistudio.google.com/apikey',
            models: 'https://generativelanguage.googleapis.com/v1beta/openai/models', prefer: [/flash$/, /flash/] },
  xai: { name: 'xAI Grok', keysUrl: 'https://console.x.ai/',
         models: 'https://api.x.ai/v1/models', prefer: [/fast/, /mini/] }
};

// Qwen Cloud / Alibaba Cloud Model Studio endpoints (the app server accepts only these).
const LC_QWEN_ENDPOINTS = [
  'https://maas.qwencloudapi.com',
  'https://dashscope-intl.aliyuncs.com',
  'https://dashscope-us.aliyuncs.com',
  'https://dashscope.aliyuncs.com'
];

function lcIsCloudProvider(provider) {
  return Object.prototype.hasOwnProperty.call(LC_CLOUD_PROVIDERS, provider);
}

function lcQwenEndpoint(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '').replace(/\/compatible-mode(\/v1)?$/, '');
  return LC_QWEN_ENDPOINTS.includes(clean) ? clean : LC_QWEN_ENDPOINTS[0];
}

// A pasted key: trimmed, and plausible (printable, no spaces). Returns '' for anything else.
function lcCleanKey(value) {
  const key = String(value || '').trim();
  return /^[\x21-\x7e]{8,400}$/.test(key) ? key : '';
}

// Chat models from a provider's model list (not embeddings, speech, images and the like).
function lcChatModels(provider, data) {
  const skip = /embed|tts|whisper|transcribe|dall-e|image|imagen|veo|sora|audio|realtime|moderation|rerank|search|computer-use|aqa|vision-preview/i;
  return (data && Array.isArray(data.data) ? data.data : [])
    .map(m => String(m.id || '').replace(/^models\//, ''))
    .filter(id => id && !skip.test(id))
    .sort();
}

// A model to start with when none is chosen yet (the provider's small, fast one if listed).
function lcPreferredModel(provider, ids) {
  for (const re of (LC_CLOUD_PROVIDERS[provider] || {}).prefer || []) {
    const hit = ids.find(id => re.test(id));
    if (hit) return hit;
  }
  return ids[0] || '';
}

// Reads a provider's model list with its key.
async function lcListCloudModels(provider, key, qwenUrl) {
  let url;
  const headers = {};
  if (provider === 'qwencloud') {
    url = `${lcQwenEndpoint(qwenUrl)}/compatible-mode/v1/models`;
    headers.Authorization = `Bearer ${key}`;
  } else if (provider === 'anthropic') {
    url = LC_CLOUD_PROVIDERS.anthropic.models;
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    // (Anthropic asks browser-based callers to say so; the key is the user's own)
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else {
    url = LC_CLOUD_PROVIDERS[provider].models;
    headers.Authorization = `Bearer ${key}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return lcChatModels(provider, await res.json());
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// API key store (IndexedDB "lc-private", object store "apiKeys": provider id -> key)
// ---------------------------------------------------------------------------

const LcApiKeys = (() => {
  const DB = 'lc-private';
  const STORE = 'apiKeys';

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function run(mode, action) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = action(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  return {
    async get(provider) {
      return (await run('readonly', store => store.get(provider))) || '';
    },
    // { provider: key } for every saved key (for the offscreen document only)
    async all() {
      const out = {};
      const db = await open();
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readonly');
          const req = tx.objectStore(STORE).openCursor();
          req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
              if (lcIsCloudProvider(cursor.key)) out[cursor.key] = cursor.value;
              cursor.continue();
            }
          };
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
      return out;
    },
    // { provider: last 4 characters } - what the popup shows of a saved key
    async hints() {
      const keys = await this.all();
      return Object.fromEntries(Object.entries(keys).map(([p, k]) => [p, k.slice(-4)]));
    },
    async set(provider, key) {
      if (!lcIsCloudProvider(provider) || !lcCleanKey(key)) throw new Error('invalid key');
      await run('readwrite', store => store.put(lcCleanKey(key), provider));
    },
    async remove(provider) {
      await run('readwrite', store => store.delete(provider));
    },
    async clear() {
      await run('readwrite', store => store.clear());
    }
  };
})();

// Keys saved by older versions in chrome.storage.local (Qwen Cloud, and DeepSeek from the old
// "cloud translation backup") move to the key store and are deleted from chrome.storage.local.
async function lcMigrateApiKeys() {
  const old = await chrome.storage.local.get(['qwencloudKey', 'deepseekKey']);
  const moves = { qwencloud: old.qwencloudKey, deepseek: old.deepseekKey };
  for (const [provider, key] of Object.entries(moves)) {
    if (lcCleanKey(key) && !(await LcApiKeys.get(provider))) await LcApiKeys.set(provider, key);
  }
  if (old.qwencloudKey !== undefined || old.deepseekKey !== undefined) {
    await chrome.storage.local.remove(['qwencloudKey', 'deepseekKey']);
  }
}
