/**
 * transcriber-worker.js
 * Runs Whisper transcription in a background thread so the UI never freezes.
 *
 * Message protocol
 * ─────────────────────────────────────────────────────────────────
 * Main → Worker
 *   { type: 'ping' }
 *   { type: 'load',       modelId, deviceType, loadOptions }
 *   { type: 'transcribe', audioData: Float32Array, options }   ← audioData is transferred (zero-copy)
 *
 * Worker → Main
 *   { type: 'pong' }
 *   { type: 'progress',  data }           ← model download/load progress
 *   { type: 'ready' }                     ← model loaded, ready to transcribe
 *   { type: 'chunk',     text }           ← partial result after each 30-s chunk
 *   { type: 'result',    result }         ← final transcription object
 *   { type: 'error',     message }        ← something went wrong
 */

// Lazy-load transformers.js only when the model is first requested.
// This lets the worker respond to the handshake ping immediately,
// even on slow connections where the CDN fetch takes a while.
let tfModule    = null;
let transcriber = null;
let loadedModel = null;

async function getTF() {
    if (!tfModule) {
        tfModule = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1');
        tfModule.env.allowLocalModels = false;
        tfModule.env.useBrowserCache  = true;
    }
    return tfModule;
}

self.addEventListener('message', async ({ data }) => {
    // Handshake — lets the main thread verify the worker loaded correctly.
    if (data.type === 'ping') {
        self.postMessage({ type: 'pong' });
        return;
    }

    try {
        if (data.type === 'load') {
            await loadModel(data.modelId, data.deviceType, data.loadOptions);
        } else if (data.type === 'transcribe') {
            await runTranscription(data.audioData, data.options);
        }
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
    }
});

async function loadModel(modelId, deviceType, loadOptions = {}) {
    // Return immediately if the same model is already cached.
    if (loadedModel === modelId && transcriber) {
        self.postMessage({ type: 'ready' });
        return;
    }

    const { pipeline } = await getTF();

    transcriber = await pipeline(
        'automatic-speech-recognition',
        modelId,
        {
            device:            deviceType,
            ...loadOptions,
            progress_callback: (p) => self.postMessage({ type: 'progress', data: p }),
        }
    );

    loadedModel = modelId;
    self.postMessage({ type: 'ready' });
}

async function runTranscription(audioData, options) {
    const result = await transcriber(audioData, {
        ...options,
        // Send partial results to the UI after each 30-second chunk.
        chunk_callback: (chunk) => {
            if (chunk?.text) {
                self.postMessage({ type: 'chunk', text: chunk.text });
            }
        },
    });

    self.postMessage({ type: 'result', result });
}
