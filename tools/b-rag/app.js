// In‑Browser RAG (No Backend)
// Embeddings: Transformers.js feature-extraction pipeline (WebGPU if available) citeturn0search13
// Vector store: IndexedDB
// LLM answering: window.LanguageModel (native Prompt API or language-model-polyfill), with download progress monitor citeturn0search1turn0search7

const els = {
  fileInput: document.getElementById('fileInput'),
  chunkSize: document.getElementById('chunkSize'),
  chunkOverlap: document.getElementById('chunkOverlap'),
  embedModel: document.getElementById('embedModel'),
  embedDevice: document.getElementById('embedDevice'),
  topK: document.getElementById('topK'),
  buildBtn: document.getElementById('buildBtn'),
  clearBtn: document.getElementById('clearBtn'),
  initLMBtn: document.getElementById('initLMBtn'),
  docList: document.getElementById('docList'),
  status: document.getElementById('status'),
  progress: document.getElementById('progress'),

  question: document.getElementById('question'),
  answer: document.getElementById('answer'),
  askBtn: document.getElementById('askBtn'),
  stopBtn: document.getElementById('stopBtn'),
  copyBtn: document.getElementById('copyBtn'),

  temperature: document.getElementById('temperature'),
  llmTopK: document.getElementById('llmTopK'),
  streaming: document.getElementById('streaming'),
  forceCitations: document.getElementById('forceCitations'),
  sources: document.getElementById('sources'),
  helpBtn: document.getElementById('helpBtn'),
  helpModal: document.getElementById('helpModal'),
  closeModalBtn: document.getElementById('closeModalBtn'),
};

function setStatus(msg) { els.status.textContent = msg; }
function setProgress(pct) {
  const safe = Math.max(0, Math.min(100, pct));
  els.progress.style.width = `${safe}%`;
  els.progress.parentElement.setAttribute('aria-hidden', safe === 0 ? 'true' : 'false');
}
function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return fallback;
}
function supportsWebGPU() { return typeof navigator !== 'undefined' && 'gpu' in navigator; }

// -------------------------
// IndexedDB helpers
// -------------------------
const DB_NAME = 'lmp_rag_db';
const DB_VER = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('chunks')) {
        const store = db.createObjectStore('chunks', { keyPath: 'id' });
        store.createIndex('docId', 'docId', { unique: false });
      }
      if (!db.objectStoreNames.contains('docs')) {
        db.createObjectStore('docs', { keyPath: 'docId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(storeName, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGetAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbClearAll() {
  const db = await openDB();
  for (const s of ['chunks', 'docs']) {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(s, 'readwrite');
      tx.objectStore(s).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }
}

async function dbDeleteDoc(docId) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('chunks', 'readwrite');
    const idx = tx.objectStore('chunks').index('docId');
    const req = idx.openCursor(IDBKeyRange.only(docId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });

  await new Promise((resolve, reject) => {
    const tx = db.transaction('docs', 'readwrite');
    tx.objectStore('docs').delete(docId);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

// -------------------------
// Document parsing
// -------------------------
function arrayBufferFromFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}
function textFromFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}
function stripHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || div.innerText || '').trim();
}
function cleanText(s) {
  return (s || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractTextFromPDF(file, onProgress) {
  // PDF.js text extraction via getTextContent() citeturn0search0turn0search3
  const pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/+esm');
  pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

  const buf = await arrayBufferFromFile(file);
  const loadingTask = pdfjs.getDocument({ data: buf });
  const pdf = await loadingTask.promise;

  let out = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    out.push(content.items.map(it => it.str).join(' '));
    if (onProgress) onProgress(p / pdf.numPages);
  }
  return cleanText(out.join('\n\n'));
}

async function extractTextFromDOCX(file) {
  const mammoth = await import('https://cdn.jsdelivr.net/npm/mammoth@1.8.0/+esm');
  const buf = await arrayBufferFromFile(file);
  const result = await mammoth.convertToHtml({ arrayBuffer: buf });
  return cleanText(stripHtml(result.value || ''));
}

async function extractText(file, onProgress) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return extractTextFromPDF(file, onProgress);
  if (name.endsWith('.docx')) return extractTextFromDOCX(file);
  if (name.endsWith('.html') || name.endsWith('.htm')) return cleanText(stripHtml(await textFromFile(file)));
  return cleanText(await textFromFile(file));
}

// -------------------------
// Chunking
// -------------------------
function chunkText(text, chunkSize, overlap) {
  const t = cleanText(text);
  if (!t) return [];
  const size = Math.max(200, chunkSize);
  const ov = Math.max(0, Math.min(overlap, size - 1));

  let chunks = [];
  let i = 0;
  while (i < t.length) {
    const end = Math.min(t.length, i + size);
    chunks.push(t.slice(i, end));
    if (end >= t.length) break;
    i = end - ov;
  }
  return chunks;
}

// -------------------------
// Embeddings (Transformers.js)
// -------------------------
let embedder = null;
let embedderCfg = null;

async function ensureEmbedder() {
  const model = els.embedModel.value;
  const deviceChoice = els.embedDevice.value;
  const device = deviceChoice === 'auto' ? (supportsWebGPU() ? 'webgpu' : 'wasm') : deviceChoice;

  if (embedder && embedderCfg?.model === model && embedderCfg?.device === device) return;

  setStatus(`Loading embedding model (${model}) on ${device}…`);
  setProgress(0);

  const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.6.1/+esm');
  embedder = await pipeline('feature-extraction', model, { 
    device,
    dtype: 'fp32', // Explicitly specify dtype to avoid warning
    execution_providers: device === 'webgpu' ? ['webgpu', 'cpu'] : ['wasm', 'cpu']
  });
  embedderCfg = { model, device };

  setStatus(`Embedding model ready (${model} on ${device}).`);
}

function meanPool(output) {
  // Support tensor-like output with data+dims, or nested arrays.
  if (output?.data && output?.dims) {
    const [tokens, dim] = output.dims;
    const vec = new Float32Array(dim);
    const data = output.data;
    for (let t = 0; t < tokens; t++) {
      const off = t * dim;
      for (let d = 0; d < dim; d++) vec[d] += data[off + d];
    }
    for (let d = 0; d < dim; d++) vec[d] /= tokens;
    return vec;
  }
  const arr = Array.isArray(output) ? output : output?.[0];
  const tokens = arr.length;
  const dim = arr[0].length;
  const vec = new Float32Array(dim);
  for (let t = 0; t < tokens; t++) for (let d = 0; d < dim; d++) vec[d] += arr[t][d];
  for (let d = 0; d < dim; d++) vec[d] /= tokens;
  return vec;
}

function l2Normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

async function embedText(text, kind='passage') {
  await ensureEmbedder();
  const model = embedderCfg?.model || '';
  const isE5 = model.toLowerCase().includes('e5');
  const prefix = isE5 ? (kind === 'query' ? 'query: ' : 'passage: ') : '';
  const out = await embedder(prefix + text, { pooling: 'none' });
  return l2Normalize(meanPool(out));
}

// -------------------------
// Retrieval
// -------------------------
function cosineSim(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function bufToF32(buf) { return new Float32Array(buf); }

async function retrieve(question, k) {
  setStatus("Embedding query…");
  const qVec = await embedText(question, 'query');
  setStatus("Searching local index…");

  const chunks = await dbGetAll('chunks');
  if (!chunks.length) return [];

  const scored = chunks.map(ch => {
    const v = bufToF32(ch.embedding);
    return { ...ch, score: cosineSim(qVec, v) };
  }).sort((a,b)=>b.score-a.score).slice(0, k);

  return scored.map(s => ({ cid: s.cid, docName: s.docName, text: s.text, score: s.score }));
}

function renderSources(retrieved) {
  els.sources.innerHTML = "";
  if (!retrieved.length) {
    els.sources.innerHTML = '<div class="muted">No retrieval yet.</div>';
    return;
  }
  for (const r of retrieved) {
    const div = document.createElement('div');
    div.className = 'source-item';
    div.innerHTML = `
      <div class="source-head">
        <span class="source-id">${r.cid}</span>
        <span class="source-meta">${r.docName} · score ${r.score.toFixed(3)}</span>
      </div>
      <div class="source-text"></div>
    `;
    div.querySelector('.source-text').textContent = r.text;
    els.sources.appendChild(div);
  }
}

// -------------------------
// LLM (Prompt API / polyfill)
// -------------------------
let lmSession = null;
let currentAbort = null;

async function ensureLanguageModel() {
  if (!('LanguageModel' in window)) {
    if (!supportsWebGPU()) throw new Error("WebGPU not available. Polyfill requires WebGPU.");
    const mod = await import('https://cdn.jsdelivr.net/npm/language-model-polyfill/+esm');
    window.LanguageModel = mod.LanguageModelPolyfill;
  }
}

async function initLM() {
  els.initLMBtn.disabled = true;
  try {
    await ensureLanguageModel();
    setStatus("Initializing LLM session…");

    const temperature = clampNum(els.temperature.value, 0, 2, 0.2);
    const topK = clampNum(els.llmTopK.value, 1, 8, 20); // Language model polyfill limits topK to 8

    lmSession = await window.LanguageModel.create({
      temperature,
      topK,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          const pct = Math.round((e.loaded || 0) * 100);
          setProgress(pct);
          setStatus(`Downloading LLM… ${pct}%`);
        });
      },
    });

    setProgress(0);
    setStatus("LLM ready.");
    els.askBtn.disabled = false;
  } catch (err) {
    console.error(err);
    setStatus(`LLM init failed: ${err?.message || String(err)}`);
  } finally {
    els.initLMBtn.disabled = false;
  }
}

function buildRagPrompt(question, retrieved, forceCitations) {
  const citeRule = forceCitations
    ? "When you use information from a source chunk, cite it inline as [D#-C#]. If the answer is not in the sources, say you cannot find it in the uploaded documents."
    : "Prefer using the provided sources. If unsupported, say so.";

  const sourcesText = retrieved.map(r =>
    `SOURCE ${r.cid} (${r.docName}; score ${r.score.toFixed(3)})\n${r.text}`
  ).join('\n\n---\n\n');

  return [
    "You answer questions using ONLY the provided SOURCES from the user's uploaded documents.",
    citeRule,
    "Do not invent facts. If multiple sources conflict, explain the conflict briefly.",
    "",
    "QUESTION:",
    question,
    "",
    "SOURCES:",
    sourcesText,
    "",
    "ANSWER:"
  ].join('\n');
}

async function ask() {
  const q = (els.question.value || '').trim();
  if (!q) { setStatus("Write a question first."); return; }

  const k = clampNum(els.topK.value, 1, 20, 5);

  els.askBtn.disabled = true;
  els.stopBtn.disabled = false;
  els.copyBtn.disabled = true;
  els.answer.value = "";
  currentAbort = new AbortController();

  try {
    const retrieved = await retrieve(q, k);
    renderSources(retrieved);

    if (!retrieved.length) { setStatus("Index is empty. Upload docs and build the index first."); return; }
    if (!lmSession) { setStatus("LLM not initialized. Click “Initialize LLM” first."); return; }

    setStatus("Generating answer…");
    const prompt = buildRagPrompt(q, retrieved, els.forceCitations.checked);

    if (els.streaming.checked && lmSession.promptStreaming) {
      let out = "";
      const stream = await lmSession.promptStreaming(prompt, { signal: currentAbort.signal });
      for await (const chunk of stream) {
        out += chunk;
        els.answer.value = out;
        els.answer.scrollTop = els.answer.scrollHeight;
      }
    } else {
      const out = await lmSession.prompt(prompt, { signal: currentAbort.signal });
      els.answer.value = out ?? '';
    }

    setStatus("Done.");
    els.copyBtn.disabled = false;
  } catch (err) {
    if (currentAbort?.signal?.aborted) setStatus("Stopped.");
    else {
      console.error(err);
      setStatus(`Ask failed: ${err?.message || String(err)}`);
    }
  } finally {
    els.askBtn.disabled = false;
    els.stopBtn.disabled = true;
    currentAbort = null;
  }
}

function stop() { if (currentAbort) currentAbort.abort(); }

async function copyAnswer() {
  const txt = els.answer.value || '';
  if (!txt) return;
  try {
    await navigator.clipboard.writeText(txt);
    setStatus("Copied answer to clipboard.");
  } catch {
    els.answer.select(); document.execCommand('copy');
    setStatus("Copied answer (fallback).");
  }
}

// -------------------------
// Index build
// -------------------------
let loadedFiles = [];

function makeId(prefix='doc_') {
  return prefix + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function renderDocList(docs) {
  if (!docs.length) {
    els.docList.innerHTML = '<div class="muted">No documents loaded yet.</div>';
    return;
  }
  els.docList.innerHTML = "";
  for (const d of docs) {
    const div = document.createElement('div');
    div.className = 'source-item';
    div.innerHTML = `
      <div class="source-head">
        <span class="source-id">${d.docName}</span>
        <span class="source-meta">${d.numChunks} chunks · added ${new Date(d.addedAt).toLocaleString()}</span>
      </div>
      <div class="row actions" style="margin-top:10px; grid-template-columns: 1fr 1fr;">
        <button data-del="${d.docId}" type="button">Delete</button>
        <button data-view="${d.docId}" type="button">View chunks</button>
      </div>
    `;
    div.querySelector('[data-del]').addEventListener('click', async (e) => {
      const id = e.currentTarget.getAttribute('data-del');
      await dbDeleteDoc(id);
      await refreshDocs();
      setStatus(`Deleted ${d.docName}.`);
    });
    div.querySelector('[data-view]').addEventListener('click', async (e) => {
      const id = e.currentTarget.getAttribute('data-view');
      const chunks = (await dbGetAll('chunks')).filter(c => c.docId === id);
      alert(`${d.docName}\n\nChunks (first 20):\n` + chunks.slice(0, 20).map(c => `${c.cid}: ${c.text.slice(0, 140).replace(/\n/g,' ')}`).join('\n') + (chunks.length>20?'\n…':''));
    });
    els.docList.appendChild(div);
  }
}

async function refreshDocs() {
  const docs = await dbGetAll('docs');
  docs.sort((a,b)=>b.addedAt-a.addedAt);
  renderDocList(docs);
}

async function buildIndex() {
  const files = loadedFiles;
  if (!files.length) { setStatus("Choose files first."); return; }

  const chunkSize = clampNum(els.chunkSize.value, 200, 8000, 1800);
  const overlap = clampNum(els.chunkOverlap.value, 0, 2000, 250);

  els.buildBtn.disabled = true;
  setProgress(0);

  try {
    await ensureEmbedder();

    let fileIdx = 0;
    for (const file of files) {
      fileIdx += 1;

      setStatus(`Extracting text (${file.name})…`);
      setProgress(0);
      const text = await extractText(file, (p) => setProgress(Math.round(p * 30)));

      const chunks = chunkText(text, chunkSize, overlap);
      const docId = makeId('doc_');
      const docName = file.name;
      const addedAt = Date.now();

      setStatus(`Embedding ${chunks.length} chunks from ${file.name}…`);
      let done = 0;
      for (let i = 0; i < chunks.length; i++) {
        const vec = await embedText(chunks[i], 'passage');
        const cid = `D${fileIdx}-C${i+1}`;

        await dbPut('chunks', {
          id: `${docId}:${i}`,
          docId,
          docName,
          cid,
          chunkIndex: i,
          text: chunks[i],
          embedding: vec.buffer
        });

        done += 1;
        setProgress(30 + Math.round((done / Math.max(1, chunks.length)) * 70));
      }

      await dbPut('docs', { docId, docName, numChunks: chunks.length, addedAt });
      setProgress(0);
      setStatus(`Indexed ${file.name} (${chunks.length} chunks).`);
    }

    await refreshDocs();
    setStatus("Index build complete.");
  } catch (err) {
    console.error(err);
    setStatus(`Index build failed: ${err?.message || String(err)}`);
  } finally {
    els.buildBtn.disabled = false;
    setProgress(0);
  }
}

async function clearIndex() {
  if (!confirm("Clear the entire local index (docs + embeddings)?")) return;
  els.clearBtn.disabled = true;
  try {
    await dbClearAll();
    await refreshDocs();
    els.sources.innerHTML = '<div class="muted">No retrieval yet.</div>';
    els.answer.value = "";
    setStatus("Cleared index.");
  } catch (err) {
    console.error(err);
    setStatus(`Clear failed: ${err?.message || String(err)}`);
  } finally {
    els.clearBtn.disabled = false;
  }
}

// -------------------------
// Wiring
// -------------------------
els.fileInput.addEventListener('change', (e) => {
  loadedFiles = Array.from(e.target.files || []);
  setStatus(loadedFiles.length ? `Loaded ${loadedFiles.length} file(s). Click “Build / Update index”.` : "No files selected.");
});

els.buildBtn.addEventListener('click', buildIndex);
els.clearBtn.addEventListener('click', clearIndex);
els.initLMBtn.addEventListener('click', initLM);

els.askBtn.addEventListener('click', ask);
els.stopBtn.addEventListener('click', stop);
els.copyBtn.addEventListener('click', copyAnswer);

// Modal Logic
function openModal() {
  els.helpModal.classList.add('open');
}
function closeModal() {
  els.helpModal.classList.remove('open');
}
els.helpBtn.addEventListener('click', openModal);
els.closeModalBtn.addEventListener('click', closeModal);
els.helpModal.addEventListener('click', (e) => {
  if (e.target === els.helpModal) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && els.helpModal.classList.contains('open')) closeModal();
});

refreshDocs().catch(()=>{});
setStatus("Upload docs, build the index, then initialize the LLM and ask questions.");
