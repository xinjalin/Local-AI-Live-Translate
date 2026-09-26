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

// Where LM Studio can download `model` from: its catalog id (e.g. "qwen/qwen3.5-9b") or the
// Hugging Face repo it came from. null when unknown.
function lcDownloadSource(model, sources) {
  if (!model || !model.id) return null;
  if (model.id.includes('/')) return model.id.split('@')[0];
  for (const source of sources || []) {
    if (source.files.some(f => lcModelStem(f) === model.id)) return `https://huggingface.co/${source.repo}`;
  }
  return null;
}

// What an exported profile records about its model.
function lcModelMeta(model, sources) {
  return {
    key: model.id,
    name: model.name || model.id,
    quantization: model.quantization || '',
    sizeBytes: model.sizeBytes || 0,
    download: lcDownloadSource(model, sources)
  };
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
