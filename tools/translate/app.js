const $ = s => document.querySelector(s);

/* ─── DOM refs ─── */
const statusEl = $('#status');
const statusText = $('#statusText');
const progressBar = $('#progressBar');
const progressFill = $('#progressFill');
const chunkProgress = $('#chunkProgress');
const chunkFill = $('#chunkFill');
const chunkLabel = $('#chunkLabel');
const inputEl = $('#inputText');
const outputEl = $('#outputText');
const inCount = $('#inCount');
const outCount = $('#outCount');
const translateBtn = $('#translateBtn');
const stopBtn = $('#stopBtn');
const detectBtn = $('#detectBtn');
const swapBtn = $('#swapBtn');
const copyBtn = $('#copyBtn');
const pasteBtn = $('#pasteBtn');
const clearBtn = $('#clearBtn');
const uploadBtn = $('#uploadBtn');
const fileInput = $('#fileInput');
const historyBtn = $('#historyBtn');
const historyOverlay = $('#historyOverlay');
const historyList = $('#historyList');
const closeHistBtn = $('#closeHistoryBtn');
const clearHistBtn = $('#clearHistoryBtn');
const modelSelect = $('#modelSelect');
const langCountText = $('#langCountText');
const langDescText = $('#langDescText');
const cacheDescText = $('#cacheDescText');

/* ─── State ─── */
let worker = null;
let languageSets = { nllb: {}, gemma: {} };
let languages = {};
let sortedLangs = [];
let currentAbortId = null;
let currentModel = localStorage.getItem('hrc_model') === 'gemma' ? 'gemma' : 'nllb';
const HISTORY_KEY = 'hrc_translate_history';
const MODEL_DEFAULTS = {
  nllb: { src: 'eng_Latn', tgt: 'spa_Latn' },
  gemma: { src: 'en', tgt: 'es' },
};
const MODEL_INFO = {
  nllb: { count: '200+ Languages', desc: "Powered by Meta's NLLB-200 model.", cache: '~600 MB model downloaded once.' },
  gemma: { count: '56 Languages', desc: "Powered by Google's TranslateGemma 4B model.", cache: '~3 GB model downloaded once.' },
};

if (!('gpu' in navigator)) {
  const gemmaOpt = modelSelect.querySelector('option[value="gemma"]');
  if (gemmaOpt) { gemmaOpt.disabled = true; gemmaOpt.textContent += ' (WebGPU unavailable)'; }
  if (currentModel === 'gemma') { currentModel = 'nllb'; localStorage.setItem('hrc_model', 'nllb'); }
}
modelSelect.value = currentModel;

/* ─── Helpers ─── */
function setStatus(msg, ready = false) {
  statusText.textContent = msg;
  statusEl.classList.toggle('ready', ready);
}

function updateCounts() {
  inCount.textContent = `${inputEl.value.length} chars`;
  outCount.textContent = `${outputEl.value.length} chars`;
}

/* ─── Searchable Language Combobox ─── */
function setupCombobox(prefix, defaultCode) {
  const trigger = $(`#${prefix}LangTrigger`);
  const display = $(`#${prefix}LangDisplay`);
  const dropdown = $(`#${prefix}LangDropdown`);
  const search = $(`#${prefix}LangSearch`);
  const options = $(`#${prefix}LangOptions`);
  const hidden = $(`#${prefix}Lang`);

  function render(filter = '') {
    const f = filter.toLowerCase();
    options.innerHTML = '';
    for (const [code, name] of sortedLangs) {
      if (f && !name.toLowerCase().includes(f) && !code.toLowerCase().includes(f)) continue;
      const div = document.createElement('div');
      div.className = 'lang-option' + (code === hidden.value ? ' selected' : '');
      div.innerHTML = `<span>${name}</span><span class="lang-code">${code}</span>`;
      div.addEventListener('click', () => {
        hidden.value = code;
        display.textContent = name;
        close();
      });
      options.appendChild(div);
    }
  }

  function open() {
    dropdown.classList.add('open');
    trigger.classList.add('active');
    search.value = '';
    render();
    requestAnimationFrame(() => search.focus());
  }

  function close() {
    dropdown.classList.remove('open');
    trigger.classList.remove('active');
  }

  trigger.addEventListener('click', () => dropdown.classList.contains('open') ? close() : open());
  search.addEventListener('input', () => render(search.value));
  search.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  document.addEventListener('click', e => {
    if (!dropdown.contains(e.target) && !trigger.contains(e.target)) close();
  });

  // Set initial display
  hidden.value = defaultCode;
  display.textContent = languages[defaultCode] || defaultCode;
  return { setValue(code) { hidden.value = code; display.textContent = languages[code] || code; } };
}

/* ─── Language loading ─── */
let srcCombo, tgtCombo;
async function loadLanguages() {
  const [nllbRes, gemmaRes] = await Promise.all([fetch('./languages.json'), fetch('./gemma-languages.json')]);
  languageSets.nllb = await nllbRes.json();
  languageSets.gemma = await gemmaRes.json();

  languages = languageSets[currentModel];
  sortedLangs = Object.entries(languages).sort(([, a], [, b]) => a.localeCompare(b));
  const d = MODEL_DEFAULTS[currentModel];
  srcCombo = setupCombobox('src', d.src);
  tgtCombo = setupCombobox('tgt', d.tgt);
}

function applyModelLanguages(model) {
  languages = languageSets[model];
  sortedLangs = Object.entries(languages).sort(([, a], [, b]) => a.localeCompare(b));
  const d = MODEL_DEFAULTS[model];
  srcCombo.setValue(d.src);
  tgtCombo.setValue(d.tgt);
  updateAboutInfo(model);
}

function updateAboutInfo(model) {
  const info = MODEL_INFO[model];
  langCountText.textContent = info.count;
  langDescText.textContent = info.desc;
  cacheDescText.textContent = info.cache;
}

/* ─── Worker init ─── */
function attachWorkerListeners() {
  worker.onmessage = ({ data: msg }) => {
    switch (msg.status) {
      case 'loading':
        setStatus(msg.data);
        break;
      case 'progress':
        if (msg.data.status === 'progress') {
          const pct = Math.round(msg.data.progress || 0);
          setStatus(`Downloading model… ${pct}%`);
          progressBar.classList.add('active');
          progressFill.style.width = pct + '%';
        }
        break;
      case 'ready':
        setStatus('Ready', true);
        translateBtn.disabled = false;
        progressBar.classList.remove('active');
        progressFill.style.width = '100%';
        break;
      case 'chunk_progress': {
        const { current, total } = msg.data;
        chunkProgress.hidden = false;
        chunkFill.style.width = (current / total * 100) + '%';
        chunkLabel.textContent = `Chunk ${current} / ${total}`;
        break;
      }
      case 'partial':
        outputEl.value += msg.data;
        outputEl.scrollTop = outputEl.scrollHeight;
        updateCounts();
        break;
      case 'chunk_error':
        console.warn('Chunk error:', msg.data);
        break;
      case 'complete':
        setStatus('Translation complete', true);
        translateBtn.disabled = false;
        translateBtn.hidden = false;
        stopBtn.hidden = true;
        saveHistory();
        setTimeout(() => { chunkProgress.hidden = true; }, 1500);
        break;
      case 'aborted':
        setStatus('Stopped', true);
        translateBtn.disabled = false;
        translateBtn.hidden = false;
        stopBtn.hidden = true;
        chunkProgress.hidden = true;
        break;
      case 'detected':
        if (languages[msg.data]) {
          srcCombo.setValue(msg.data);
          setStatus(`Detected: ${languages[msg.data]}`, true);
        }
        break;
      case 'error':
        setStatus('Error: ' + msg.data);
        translateBtn.disabled = false;
        translateBtn.hidden = false;
        stopBtn.hidden = true;
        chunkProgress.hidden = true;
        break;
    }
  };
}

async function init() {
  await loadLanguages();
  updateAboutInfo(currentModel);
  setStatus('Loading worker…');
  worker = new Worker('worker.js', { type: 'module' });
  attachWorkerListeners();
  worker.postMessage({ type: 'load', data: { model: currentModel } });
}

modelSelect.addEventListener('change', () => {
  currentModel = modelSelect.value;
  localStorage.setItem('hrc_model', currentModel);
  applyModelLanguages(currentModel);
  outputEl.value = '';
  updateCounts();
  translateBtn.disabled = true;
  chunkProgress.hidden = true;
  progressFill.style.width = '0%';
  setStatus('Loading model…');
  worker.postMessage({ type: 'load', data: { model: currentModel } });
});

/* ─── Translate ─── */
function doTranslate() {
  const text = inputEl.value.trim();
  if (!text) return;

  currentAbortId = Date.now();
  outputEl.value = '';
  setStatus('Translating…');
  translateBtn.hidden = true;
  stopBtn.hidden = false;
  chunkProgress.hidden = false;
  chunkFill.style.width = '0%';
  chunkLabel.textContent = '';
  updateCounts();

  worker.postMessage({
    type: 'translate',
    abortId: currentAbortId,
    data: { text, src_lang: $('#srcLang').value, tgt_lang: $('#tgtLang').value, model: currentModel }
  });
}

translateBtn.addEventListener('click', doTranslate);
stopBtn.addEventListener('click', () => {
  worker.postMessage({ type: 'abort' });
  currentAbortId = null;
});

/* ─── Detect language ─── */
detectBtn.addEventListener('click', () => {
  const text = inputEl.value.trim();
  if (!text) return;
  worker.postMessage({ type: 'detect', data: { text, model: currentModel } });
});

/* ─── Swap ─── */
swapBtn.addEventListener('click', () => {
  const sc = $('#srcLang').value, tc = $('#tgtLang').value;
  srcCombo.setValue(tc);
  tgtCombo.setValue(sc);
});

/* ─── Copy / Paste / Clear ─── */
copyBtn.addEventListener('click', async () => {
  if (!outputEl.value) return;
  try {
    await navigator.clipboard.writeText(outputEl.value);
    setStatus('Copied!', true);
    setTimeout(() => setStatus('Ready', true), 1500);
  } catch (e) { console.error('Copy failed', e); }
});
pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    inputEl.value = text;
    updateCounts();
  } catch (e) { console.error('Paste failed', e); }
});
clearBtn.addEventListener('click', () => { inputEl.value = ''; outputEl.value = ''; updateCounts(); });

/* ─── File upload (PDF / DOCX → plain text) ───
   Extraction only fills #inputText — translation still goes through the same
   doTranslate() → worker chunking pipeline as typed/pasted text, so nothing
   here needs to know about NLLB vs Gemma. */
const PDFJS_VERSION = '6.2.108';
const MAMMOTH_VERSION = '1.12.1';

// A vertical gap between lines much bigger than this page's own normal line
// spacing is a real paragraph break (extra spacing PDF authors put between
// paragraphs); a normal gap is just a wrapped line. "Normal" is derived from
// the page itself (its smallest recurring line-to-line gap) rather than a
// fixed multiple of font size, since documents vary a lot in chosen line
// spacing (single, 1.5x, double...) and a fixed ratio would misfire on those.
// This uses pdf.js's actual per-line position data instead of guessing
// paragraph structure from characters. Doesn't attempt multi-column layout
// detection — out of scope, same as pdf.js's own reading order.
function pdfLinesToText(items) {
  const lines = [];
  let cur = null;
  for (const item of items) {
    if (!cur) cur = { str: '', y: item.transform[5], height: 0 };
    cur.height = Math.max(cur.height, item.height || 0);
    cur.str += item.str;
    if (item.hasEOL) {
      lines.push(cur);
      cur = null;
    } else {
      cur.str += ' ';
    }
  }
  if (cur && cur.str.trim()) lines.push(cur);

  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i - 1].y - lines[i].y;
    if (g > 0) gaps.push(g);
  }
  const normalGap = gaps.length ? Math.min(...gaps) : (lines[0]?.height || 12);

  let text = '';
  let prevY = null;
  for (const line of lines) {
    const str = line.str.trim();
    if (!str) continue;
    if (prevY !== null) {
      const gap = prevY - line.y; // PDF y grows upward; positive = moved down the page
      text += gap > normalGap * 1.5 ? '\n\n' : '\n';
    }
    text += str;
    prevY = line.y;
  }
  return text.trim();
}

async function extractPdfText(file) {
  const pdfjsLib = await import(`https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`);
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

  const doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(pdfLinesToText(content.items));
  }
  return pages.filter(Boolean).join('\n\n').trim();
}

async function extractDocxText(file) {
  const mammoth = await import(`https://esm.sh/mammoth@${MAMMOTH_VERSION}`);
  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return value.trim();
}

async function handleFileUpload(file) {
  const name = file.name.toLowerCase();
  const isPdf = name.endsWith('.pdf') || file.type === 'application/pdf';
  const isDocx = name.endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  if (!isPdf && !isDocx) {
    setStatus('Unsupported file — please upload a .pdf or .docx file.');
    return;
  }

  uploadBtn.disabled = true;
  setStatus(`Extracting text from ${file.name}…`);

  try {
    const text = isPdf ? await extractPdfText(file) : await extractDocxText(file);
    if (!text) {
      setStatus(isPdf
        ? 'No extractable text found — this looks like a scanned PDF (image only). OCR isn\'t supported; try a text-based PDF or a DOCX instead.'
        : 'No text found in this document.');
      return;
    }
    inputEl.value = text;
    updateCounts();
    setStatus(`Loaded ${text.length.toLocaleString()} characters from ${file.name}`, true);
  } catch (err) {
    console.error('File extraction failed', err);
    setStatus(`Couldn't read ${file.name}: ${err.message}`);
  } finally {
    uploadBtn.disabled = false;
  }
}

uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (file) handleFileUpload(file);
});

/* ─── Live char counts ─── */
inputEl.addEventListener('input', updateCounts);
outputEl.addEventListener('input', updateCounts);

/* ─── Keyboard shortcuts ─── */
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); doTranslate(); }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); swapBtn.click(); }
});

/* ─── History ─── */
function getHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; } }
function setHistoryData(h) { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); }

function saveHistory() {
  const src = inputEl.value.trim(), tgt = outputEl.value.trim();
  if (!src || !tgt) return;
  const h = getHistory();
  h.unshift({ ts: Date.now(), sl: $('#srcLang').value, tl: $('#tgtLang').value, src, tgt, model: currentModel });
  if (h.length > 50) h.length = 50;
  setHistoryData(h);
}

function renderHistory() {
  const h = getHistory();
  if (!h.length) { historyList.innerHTML = '<div class="history-empty">No translations yet</div>'; return; }
  historyList.innerHTML = h.map((item, i) => {
    const langs = languageSets[item.model || 'nllb'] || {};
    return `
    <div class="history-item" data-idx="${i}">
      <div class="history-item-header">
        <span class="history-langs">${langs[item.sl] || item.sl} → ${langs[item.tl] || item.tl}</span>
        <span class="history-time">${new Date(item.ts).toLocaleString()}</span>
      </div>
      <div class="history-preview">${escHtml(item.src.substring(0, 120))}</div>
    </div>`;
  }).join('');

  historyList.querySelectorAll('.history-item').forEach(el => {
    el.addEventListener('click', () => {
      const item = h[+el.dataset.idx];
      const model = item.model || 'nllb';
      if (model !== currentModel && !modelSelect.querySelector(`option[value="${model}"]`).disabled) {
        modelSelect.value = model;
        modelSelect.dispatchEvent(new Event('change'));
      }
      srcCombo.setValue(item.sl);
      tgtCombo.setValue(item.tl);
      inputEl.value = item.src;
      outputEl.value = item.tgt;
      updateCounts();
      historyOverlay.hidden = true;
    });
  });
}

function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

historyBtn.addEventListener('click', () => { renderHistory(); historyOverlay.hidden = false; });
closeHistBtn.addEventListener('click', () => { historyOverlay.hidden = true; });
historyOverlay.addEventListener('click', e => { if (e.target === historyOverlay) historyOverlay.hidden = true; });
clearHistBtn.addEventListener('click', () => { setHistoryData([]); renderHistory(); });

/* ─── Init ─── */
init();
