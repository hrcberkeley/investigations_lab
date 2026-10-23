import { pipeline as pipelineV2, env as envV2 } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';
import { pipeline as pipelineV4, env as envV4 } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.0.0-next.3';

envV2.allowLocalModels = false;
envV2.useBrowserCache = true;
envV4.allowLocalModels = false;
envV4.useBrowserCache = true;

const MODELS = {
    nllb: { name: 'Xenova/nllb-200-distilled-600M' },
    gemma: { name: 'onnx-community/translategemma-text-4b-it-ONNX', size: 3111894696 },
};

let translator = null;
let activeModel = null;
let currentAbortId = null;

// Per-chunk input token budget. Gemma's generation is capped at max_new_tokens
// below, so its chunks stay small enough that translated output (which can run
// longer than the source) won't get truncated. NLLB has no such output cap.
const MAX_TOKENS = { nllb: 1500, gemma: 600 };
const MAX_RETRIES = 2;

/* ─── Script code → Gemma language code (for auto-detect) ─── */
const SCRIPT_TO_GEMMA = {
    arb_Arab: 'ar_SA', rus_Cyrl: 'ru_RU', zho_Hans: 'zh_TW', hin_Deva: 'hi_IN',
    ben_Beng: 'bn_IN', tha_Thai: 'th_TH', kor_Hang: 'ko_KR', jpn_Jpan: 'ja_JP',
    ell_Grek: 'el_GR', heb_Hebr: 'he_IL', tam_Taml: 'ta_IN', tel_Telu: 'te_IN',
    eng_Latn: 'en',
};

/* ─── Token estimation ─── */
function estimateTokens(text) {
    const cjk = (text.match(/[\u3000-\u9fff\uf900-\ufaff]/g) || []).length;
    return Math.ceil(cjk / 1.5 + (text.length - cjk) / 5);
}

/* ─── Sentence splitting (Intl.Segmenter with regex fallback) ─── */
function splitSentences(text) {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        try {
            const seg = new Intl.Segmenter(undefined, { granularity: 'sentence' });
            return [...seg.segment(text)].map(s => s.segment);
        } catch (_) { /* fallback */ }
    }
    return text.match(/[^.!?]*(?:(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|approx)\.[^.!?]*)*[.!?]+(?:\s+|$)|[^.!?]+$/gi) || [text];
}

/* ─── Build token-aware chunks from paragraphs ───
   Each chunk is an array of whole sentences (never a pre-joined string) so the
   caller can choose how to feed them to the model — see translateWithRetry. */
function buildChunks(text, maxTokens) {
    // Only a blank line counts as a paragraph break. A lone newline is usually just
    // a line-wrap artifact (common in PDF-extracted or copy-pasted text) — otherwise
    // each wrapped line becomes its own "chunk", and translation models reliably
    // hallucinate when fed a sentence fragment.
    const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/);
    const chunks = [];

    for (const rawPara of paragraphs) {
        // A lone newline is just a line-wrap artifact — collapse to a space. (Tried
        // rejoining hyphenated wraps like "under-\nstanding" too, but there's no
        // reliable way to tell that apart from a real compound word split across
        // lines, e.g. "well-\nknown" — got "wellknown" out of a real test. Leaving
        // the hyphen alone is the safe default: worst case is a stray space, not a
        // corrupted word.)
        const para = rawPara.replace(/\s*\n\s*/g, ' ').trim();
        if (!para) continue;

        const sentences = splitSentences(para).map(s => s.trim()).filter(Boolean);
        let bucket = [];
        let bucketTokens = 0;

        for (const s of sentences) {
            const t = estimateTokens(s);
            if (bucket.length && bucketTokens + t > maxTokens) {
                chunks.push(bucket);
                bucket = [];
                bucketTokens = 0;
            }
            bucket.push(s);
            bucketTokens += t;
        }
        if (bucket.length) chunks.push(bucket);
        chunks.push('\n'); // paragraph boundary marker
    }
    if (chunks.at(-1) === '\n') chunks.pop();
    return chunks;
}

/* ─── Translate one chunk (array of sentences) with retry ─── */
async function translateWithRetry(sentences, src, tgt, model) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            if (model === 'gemma') {
                // LLMs handle multi-sentence context well (and can use it for better
                // pronoun/reference resolution), so send the whole chunk as one message.
                const text = sentences.join(' ');
                const messages = [{
                    role: 'user',
                    content: [{ type: 'text', source_lang_code: src, target_lang_code: tgt, text }],
                }];
                const out = await translator(messages, { max_new_tokens: 1024 });
                return { ok: true, text: out[0].generated_text.pop().content };
            }
            // NLLB was trained on sentence-level pairs, not concatenated paragraphs —
            // translate each sentence independently in one batched call so it never
            // sees a multi-sentence blob outside its training distribution.
            const out = await translator(sentences, {
                src_lang: src,
                tgt_lang: tgt,
                num_beams: 1,        // greedy decoding — much faster than beam search
            });
            return { ok: true, text: out.map(o => o.translation_text).join(' ') };
        } catch (err) {
            if (attempt === MAX_RETRIES) return { ok: false, error: err.message, original: sentences.join(' ') };
            await new Promise(r => setTimeout(r, 200));
        }
    }
}

/* ─── Validate cached model ─── */
async function validateCache() {
    try {
        const names = await caches.keys();
        const tc = names.find(n => n.includes('transformers'));
        if (!tc) return false;
        const cache = await caches.open(tc);
        return (await cache.keys()).length > 0;
    } catch { return false; }
}

/* ─── Script-based language detection heuristic ─── */
function detectScript(text) {
    const s = text.substring(0, 500);
    const counts = {
        arabic: (s.match(/[\u0600-\u06FF]/g) || []).length,
        cyrillic: (s.match(/[\u0400-\u04FF]/g) || []).length,
        cjk: (s.match(/[\u3000-\u9FFF\uF900-\uFAFF]/g) || []).length,
        devanagari: (s.match(/[\u0900-\u097F]/g) || []).length,
        bengali: (s.match(/[\u0980-\u09FF]/g) || []).length,
        thai: (s.match(/[\u0E00-\u0E7F]/g) || []).length,
        korean: (s.match(/[\uAC00-\uD7AF\u1100-\u11FF]/g) || []).length,
        japanese: (s.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []).length,
        greek: (s.match(/[\u0370-\u03FF]/g) || []).length,
        hebrew: (s.match(/[\u0590-\u05FF]/g) || []).length,
        tamil: (s.match(/[\u0B80-\u0BFF]/g) || []).length,
        telugu: (s.match(/[\u0C00-\u0C7F]/g) || []).length,
        georgian: (s.match(/[\u10A0-\u10FF]/g) || []).length,
        armenian: (s.match(/[\u0530-\u058F]/g) || []).length,
        latin: (s.match(/[a-zA-Z]/g) || []).length,
    };
    let best = 'latin', max = 0;
    for (const [k, v] of Object.entries(counts)) if (v > max) { max = v; best = k; }

    const map = {
        arabic: 'arb_Arab', cyrillic: 'rus_Cyrl', cjk: 'zho_Hans',
        devanagari: 'hin_Deva', bengali: 'ben_Beng', thai: 'tha_Thai',
        korean: 'kor_Hang', japanese: 'jpn_Jpan', greek: 'ell_Grek',
        hebrew: 'heb_Hebr', tamil: 'tam_Taml', telugu: 'tel_Telu',
        georgian: 'kat_Geor', armenian: 'hye_Armn', latin: 'eng_Latn',
    };
    return map[best] || 'eng_Latn';
}

/* ─── Message handler ─── */
self.addEventListener('message', async (event) => {
    const msg = event.data;

    if (msg.type === 'load') {
        const model = msg.data?.model === 'gemma' ? 'gemma' : 'nllb';
        try {
            if (model === activeModel && translator) { self.postMessage({ status: 'ready' }); return; }

            if (model === 'gemma' && !navigator.gpu) {
                self.postMessage({ status: 'error', data: 'TranslateGemma requires a WebGPU-capable browser.' });
                return;
            }

            self.postMessage({ status: 'loading', data: model === 'gemma' ? 'Loading TranslateGemma 4B…' : 'Loading model…' });

            if (translator?.dispose) { try { await translator.dispose(); } catch (_) { } }
            translator = null;
            activeModel = null;

            if (model === 'gemma') {
                const loaded = new Map();
                let lastPct = -1;
                translator = await pipelineV4('text-generation', MODELS.gemma.name, {
                    device: 'webgpu',
                    dtype: 'q4',
                    progress_callback: (e) => {
                        if (e.status !== 'progress') return;
                        loaded.set(e.file, e.loaded);
                        const sum = Array.from(loaded.values()).reduce((a, b) => a + b, 0);
                        const pct = Math.round((100 / MODELS.gemma.size) * sum * 100) / 100;
                        if (pct !== lastPct) { lastPct = pct; self.postMessage({ status: 'progress', data: { status: 'progress', progress: pct } }); }
                    },
                });
            } else {
                const init = () => pipelineV2('translation', MODELS.nllb.name, {
                    progress_callback: (d) => { if (d.status === 'progress') self.postMessage({ status: 'progress', data: d }); }
                });

                try {
                    translator = await init();
                } catch (err) {
                    console.warn('Load failed, clearing cache and retrying…', err);
                    try { await caches.delete('transformers-cache'); } catch (_) { }
                    translator = await init();
                }
            }

            activeModel = model;
            self.postMessage({ status: 'ready' });
        } catch (err) { self.postMessage({ status: 'error', data: err.message }); }

    } else if (msg.type === 'translate') {
        const model = msg.data?.model === 'gemma' ? 'gemma' : 'nllb';
        if (!translator || model !== activeModel) { self.postMessage({ status: 'error', data: 'Model not loaded' }); return; }

        const abortId = msg.abortId || Date.now();
        currentAbortId = abortId;

        try {
            const { text, src_lang, tgt_lang } = msg.data;
            const chunks = buildChunks(text, MAX_TOKENS[model]);
            const translatable = chunks.filter(c => c !== '\n');
            const total = translatable.length;
            let done = 0;

            for (const chunk of chunks) {
                if (currentAbortId !== abortId) { self.postMessage({ status: 'aborted' }); return; }

                if (chunk === '\n') { self.postMessage({ status: 'partial', data: '\n\n' }); continue; }

                done++;
                self.postMessage({ status: 'chunk_progress', data: { current: done, total } });

                const res = await translateWithRetry(chunk, src_lang, tgt_lang, model);
                if (currentAbortId !== abortId) { self.postMessage({ status: 'aborted' }); return; }

                if (res.ok) {
                    self.postMessage({ status: 'partial', data: res.text + ' ' });
                } else {
                    self.postMessage({ status: 'chunk_error', data: { chunk: done, total, error: res.error, original: res.original } });
                    self.postMessage({ status: 'partial', data: `[⚠ ${res.original}] ` });
                }
            }
            self.postMessage({ status: 'complete', data: '' });
        } catch (err) { self.postMessage({ status: 'error', data: err.message }); }

    } else if (msg.type === 'abort') {
        currentAbortId = null;

    } else if (msg.type === 'detect') {
        const { text, model } = msg.data;
        const nllbCode = detectScript(text);
        const code = model === 'gemma' ? (SCRIPT_TO_GEMMA[nllbCode] || 'en') : nllbCode;
        self.postMessage({ status: 'detected', data: code });
    }
});
