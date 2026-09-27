// LM Studio helpers shared by the popup and the import page: model listing, where each model can be
// downloaded from, and downloads through LM Studio's REST API (LM Studio 0.4+).

const LC_SERVER_URL = 'http://127.0.0.1:8000';

async function lcFetchJson(url, options = {}, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch (e) {}
    if (!res.ok) {
      const err = data.error && (data.error.message || data.error);
      throw new Error(typeof err === 'string' ? err : `HTTP ${res.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Chat models installed in LM Studio: [{ id, loaded, ctx, name, publisher, quantization, sizeBytes }].
async function lcListLmModels(base) {
  const res = await lcFetchJson(`${base}/api/v1/models`);
  return (res.models || [])
    .filter(m => m.type === 'llm')
    .map(m => ({
      id: m.key,
      loaded: m.loaded_instances.length > 0,
      ctx: m.loaded_instances[0] && m.loaded_instances[0].config.context_length,
      name: m.display_name || m.key,
      publisher: m.publisher || '',
      quantization: (m.quantization && m.quantization.name) || '',
      sizeBytes: m.size_bytes || 0
    }));
}

// Hugging Face repos of the installed models, from the LiveCaption server (it reads LM Studio's
// models folder). Empty when the server isn't running.
async function lcModelSources() {
  try {
    return (await lcFetchJson(`${LC_SERVER_URL}/model-sources`, {}, 2000)).sources || [];
  } catch (e) {
    return [];
  }
}

// "HY-MT2-7B-Q8_0.gguf" -> "hy-mt2-7b": LM Studio's key for a Hugging Face model is its file name
// without the quantization suffix.
function lcModelStem(file) {
  return file.toLowerCase()
    .replace(/\.gguf$/, '')
    .replace(/[-_.](ud-)?(i?q\d[a-z0-9_]*|f16|bf16|f32)$/, '');
}

// Whether a GGUF file is the one LM Studio lists as `key`. LM Studio also turns "." and "_" into
// "-" in some names ("Hy-MT2-30B-A3B.i1-IQ3_M.gguf" -> "hy-mt2-30b-a3b-i1").
function lcFileMatchesKey(file, key) {
  const norm = s => s.replace(/[._]/g, '-');
  return norm(lcModelStem(file.split('/').pop())) === norm(key.toLowerCase());
}

// Where LM Studio can download `model` from: its catalog id (e.g. "qwen/qwen3.5-9b") or the
// Hugging Face repo it came from. null when unknown.
function lcDownloadSource(model, sources) {
  if (!model || !model.id) return null;
  if (model.id.includes('/')) return model.id.split('@')[0];
  for (const source of sources || []) {
    if (source.files.some(f => lcFileMatchesKey(f, model.id))) return `https://huggingface.co/${source.repo}`;
  }
  return null;
}

// What an exported profile records about its model. The publisher (the Hugging Face account LM
// Studio downloaded it from) lets the importer find the model even when `download` is unknown.
function lcModelMeta(model, sources) {
  return {
    key: model.id,
    name: model.name || model.id,
    publisher: model.publisher || '',
    quantization: model.quantization || '',
    sizeBytes: model.sizeBytes || 0,
    download: lcDownloadSource(model, sources)
  };
}

// Whether a missing model with no known download source can be looked up on Hugging Face.
function lcCanFindModel(meta) {
  return !!(meta && meta.key && !meta.key.includes('/'));
}

// A profile's model that isn't installed and whose download source is unknown (exported while the
// app server wasn't running, or by an older version): the Hugging Face repo, from the model's
// publisher if known, with a GGUF file LM Studio would list under the same key, in the model's
// quantization. Only runs when the user asks to download the model, and only sends its name and
// publisher to Hugging Face. Resolves to { download, sizeBytes } or null.
async function lcFindModelSource(meta) {
  if (!lcCanFindModel(meta)) return null;
  const key = meta.key.split('@')[0];
  const quant = (meta.quantization || '').toLowerCase();
  const api = 'https://huggingface.co/api/models';
  const searches = [];
  if (meta.publisher && /^[\w.-]+$/.test(meta.publisher)) {
    searches.push(`author=${encodeURIComponent(meta.publisher)}&search=${encodeURIComponent(key)}`);
  }
  searches.push(`search=${encodeURIComponent(key)}&filter=gguf&sort=downloads`);
  const checked = new Set();
  for (const query of searches) {
    let repos = [];
    try {
      repos = await lcFetchJson(`${api}?${query}&limit=20`, {}, 10000);
    } catch (e) {
      continue;
    }
    for (const repo of repos) {
      const id = repo.id || repo.modelId;
      if (!id || checked.has(id) || !/^[\w.-]+\/[\w.-]+$/.test(id)) continue;
      if (checked.size >= 12) return null;
      checked.add(id);
      let info;
      try {
        info = await lcFetchJson(`${api}/${id}?blobs=true`, {}, 10000);
      } catch (e) {
        continue;
      }
      const files = (info.siblings || []).filter(f =>
        /\.gguf$/i.test(f.rfilename) && !/mmproj/i.test(f.rfilename) && lcFileMatchesKey(f.rfilename, key));
      const file = files.find(f => !quant || f.rfilename.toLowerCase().includes(quant));
      if (file) return { download: `https://huggingface.co/${id}`, sizeBytes: file.size || 0 };
    }
  }
  return null;
}

// Only LM Studio catalog ids and Hugging Face repos are ever sent to LM Studio's downloader.
function lcValidDownloadSource(source) {
  return typeof source === 'string' &&
    (/^[\w.-]+\/[\w.-]+$/.test(source) || /^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/?$/.test(source));
}

// Starts a download; resolves to LM Studio's response ({ job_id, status, total_size_bytes }).
function lcStartDownload(base, meta) {
  const body = { model: meta.download };
  if (meta.download.startsWith('https://') && meta.quantization) body.quantization = meta.quantization;
  return lcFetchJson(`${base}/api/v1/models/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, 30000);
}

function lcDownloadStatus(base, jobId) {
  return lcFetchJson(`${base}/api/v1/models/download/status/${encodeURIComponent(jobId)}`);
}

function lcFormatBytes(bytes) {
  if (!bytes) return '';
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

// Servers on this computer. Anything else means subtitle text would leave the PC.
function lcIsLocalUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch (e) {
    return false;
  }
}
