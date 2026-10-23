/**
 * audio-extractor.js
 * ──────────────────────────────────────────────────────────────────────────
 * Streaming audio extraction for MP4-family containers (mp4 / m4a / mov).
 *
 * The whole point: a 2-hour interview decoded to 16 kHz mono PCM is ~460 MB
 * held in RAM at once. That's what crashes tabs. Instead we:
 *
 *   1. Demux the container with mp4box.js → encoded audio packets only
 *      (tens of MB, not hundreds).
 *   2. Decode packets in time-bounded batches with WebCodecs AudioDecoder.
 *   3. Resample each batch to 16 kHz mono and YIELD it as one window.
 *   4. The caller transcribes the window, then asks for the next one — which
 *      is when we decode the next batch. Decoded PCM is never held in full.
 *
 * This is an OPTIMISATION with a guaranteed fallback: if anything here throws
 * (import fails, codec unsupported, weird container), the caller catches it
 * and runs the plain full-file decodeAudioData() path instead.
 *
 * Known limitation: windows are processed independently with no overlap, so a
 * word landing exactly on a 2-minute boundary can be split. Acceptable for v1.
 * ──────────────────────────────────────────────────────────────────────────
 */

const MP4BOX_URL = 'https://cdn.jsdelivr.net/npm/mp4box@0.5.2/+esm';
const TARGET_RATE = 16000;

/**
 * Can we stream this file? Requires WebCodecs + an MP4-family container.
 * Everything else (WAV, MP3, OGG, FLAC, WebM) uses the full-decode fallback.
 */
export function canStream(file) {
    if (typeof AudioDecoder === 'undefined') return false;
    const t = (file.type || '').toLowerCase();
    const n = (file.name || '').toLowerCase();
    return t.includes('mp4') || t.includes('m4a') || t.includes('quicktime')
        || n.endsWith('.mp4') || n.endsWith('.m4a') || n.endsWith('.mov');
}

/**
 * Async generator yielding decoded 16 kHz mono windows.
 *
 * First yield is metadata: { meta: true, totalWindows, durationSec }.
 * Subsequent yields are windows: { audio: Float32Array, offsetSec, windowIndex, totalWindows }.
 *
 * Backpressure is automatic: `for await` only pulls the next window after the
 * caller finishes awaiting the current one, so we decode just one batch ahead.
 */
export async function* streamAudioWindows(file, opts = {}) {
    const windowSeconds = opts.windowSeconds ?? 120;
    const onStage = opts.onStage;

    onStage?.('Reading container…');
    const { samples, config, sourceRate, durationSec } = await demux(file);

    // Verify the browser can actually decode this codec before committing.
    const support = await AudioDecoder.isConfigSupported(config);
    if (!support.supported) {
        throw new Error('WebCodecs cannot decode this audio codec: ' + config.codec);
    }

    // Decoder output frames land here for the current batch, then get drained.
    let batchFrames = [];
    let decodeError = null;

    const decoder = new AudioDecoder({
        output: (audioData) => {
            try { batchFrames.push(toMonoFloat32(audioData)); }
            finally { audioData.close(); }   // release decoded frame immediately
        },
        error: (e) => { decodeError = e; },
    });
    decoder.configure(config);

    const totalWindows = Math.max(1, Math.ceil((durationSec || 0) / windowSeconds) || 1);
    yield { meta: true, totalWindows, durationSec };

    let emitted16k = 0;     // running count of emitted target-rate samples → time offset
    let batch = [];
    let batchDur = 0;
    let windowIndex = 0;

    const decodeBatch = async () => {
        batchFrames = [];
        for (const s of batch) {
            decoder.decode(new EncodedAudioChunk({
                type: 'key',  // audio frames are independently decodable
                timestamp: Math.round((s.cts / s.timescale) * 1e6),
                duration:  Math.round((s.duration / s.timescale) * 1e6),
                data: s.data,
            }));
        }
        await decoder.flush();
        if (decodeError) throw decodeError;

        const source = concatFloat32(batchFrames);
        batchFrames = [];                                  // free decoded PCM
        const audio = resampleTo16k(source, sourceRate);   // → 16 kHz mono

        const offsetSec = emitted16k / TARGET_RATE;
        emitted16k += audio.length;
        windowIndex += 1;
        batch = [];
        batchDur = 0;
        return { audio, offsetSec, windowIndex, totalWindows };
    };

    onStage?.('Decoding audio…');
    for (const s of samples) {
        batch.push(s);
        batchDur += s.duration / s.timescale;
        if (batchDur >= windowSeconds) {
            yield await decodeBatch();
        }
    }
    if (batch.length) {
        yield await decodeBatch();
    }

    decoder.close();
}

// ── Demux ──────────────────────────────────────────────────────────────────
async function demux(file) {
    const mod = await import(/* @vite-ignore */ MP4BOX_URL);
    const MP4Box = mod.default ?? mod;
    if (!MP4Box || typeof MP4Box.createFile !== 'function') {
        throw new Error('mp4box.js failed to load');
    }
    const mp4box = MP4Box.createFile();

    return new Promise((resolve, reject) => {
        const samples = [];
        let config = null, sourceRate = 0, durationSec = 0, ready = false;

        mp4box.onError = (e) => reject(new Error('Demux error: ' + e));

        mp4box.onReady = (info) => {
            const track = info.audioTracks && info.audioTracks[0];
            if (!track) { reject(new Error('No audio track found in this file')); return; }

            sourceRate = track.audio.sample_rate;
            durationSec = (info.duration && info.timescale)
                ? info.duration / info.timescale
                : (track.movie_duration && track.movie_timescale)
                    ? track.movie_duration / track.movie_timescale
                    : 0;

            config = {
                codec: track.codec,
                sampleRate: track.audio.sample_rate,
                numberOfChannels: track.audio.channel_count,
            };
            const description = getDecoderDescription(mp4box, track);
            if (description) config.description = description;

            ready = true;
            mp4box.setExtractionOptions(track.id, null, { nbSamples: 1000 });
            mp4box.start();
        };

        mp4box.onSamples = (id, _user, list) => {
            for (const s of list) {
                samples.push({
                    data: s.data.slice(0),   // copy → detach from mp4box internal buffers
                    cts: s.cts,
                    duration: s.duration,
                    timescale: s.timescale,
                });
            }
            // Let mp4box free buffer ranges it no longer needs.
            mp4box.releaseUsedSamples(id, list[list.length - 1].number + 1);
        };

        readFileSlices(file, mp4box)
            .then(() => {
                mp4box.flush();
                if (!ready) reject(new Error('Could not parse container (missing moov)'));
                else resolve({ samples, config, sourceRate, durationSec });
            })
            .catch(reject);
    });
}

/** Feed the file to mp4box in slices so we never hold a second full copy. */
async function readFileSlices(file, mp4box, chunkSize = 4 * 1024 * 1024) {
    let offset = 0;
    while (offset < file.size) {
        const buf = await file.slice(offset, offset + chunkSize).arrayBuffer();
        buf.fileStart = offset;
        mp4box.appendBuffer(buf);
        offset += buf.byteLength;
    }
}

/**
 * Pull the codec-specific decoder config out of the sample description box.
 * AAC needs its AudioSpecificConfig (from esds); FLAC needs dfLa; MP3 needs
 * nothing. Anything we can't extract, we return null and let the decoder try
 * bare — and if that fails, isConfigSupported / flush throws → fallback.
 */
function getDecoderDescription(mp4box, track) {
    const trak = mp4box.getTrackById(track.id);
    const entries = trak?.mdia?.minf?.stbl?.stsd?.entries || [];
    for (const entry of entries) {
        if (entry.esds) {   // AAC
            try {
                const dsi = entry.esds.esd.descs[0].descs[0];
                if (dsi?.data) return new Uint8Array(dsi.data);
            } catch (_) { /* keep looking */ }
        }
        if (entry.dfLa?.data) {   // FLAC
            return new Uint8Array(entry.dfLa.data);
        }
    }
    return null;
}

// ── PCM helpers ──────────────────────────────────────────────────────────────
/** Convert one decoded AudioData frame to mono Float32 at its source rate. */
function toMonoFloat32(audioData) {
    const ch = audioData.numberOfChannels;
    const frames = audioData.numberOfFrames;

    if (ch === 1) {
        const out = new Float32Array(frames);
        audioData.copyTo(out, { planeIndex: 0, format: 'f32-planar' });
        return out;
    }

    // Mix down the first two channels (sufficient for speech).
    const a = new Float32Array(frames);
    const b = new Float32Array(frames);
    audioData.copyTo(a, { planeIndex: 0, format: 'f32-planar' });
    audioData.copyTo(b, { planeIndex: 1, format: 'f32-planar' });
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i++) out[i] = (a[i] + b[i]) * 0.5;
    return out;
}

function concatFloat32(arrays) {
    let len = 0;
    for (const a of arrays) len += a.length;
    const out = new Float32Array(len);
    let o = 0;
    for (const a of arrays) { out.set(a, o); o += a.length; }
    return out;
}

/**
 * Resample to 16 kHz mono.
 *   • Downsample: average the input samples falling in each output window
 *     (a cheap box filter that gives basic anti-aliasing — plenty for speech).
 *   • Upsample: linear interpolation.
 */
function resampleTo16k(input, inputRate) {
    if (!input.length) return input;
    if (inputRate === TARGET_RATE) return input;

    const ratio = inputRate / TARGET_RATE;
    const outLen = Math.max(1, Math.floor(input.length / ratio));
    const out = new Float32Array(outLen);

    if (ratio > 1) {
        for (let i = 0; i < outLen; i++) {
            const start = Math.floor(i * ratio);
            const end = Math.min(input.length, Math.floor((i + 1) * ratio));
            let sum = 0, n = 0;
            for (let j = start; j < end; j++) { sum += input[j]; n++; }
            out[i] = n ? sum / n : input[start] || 0;
        }
    } else {
        for (let i = 0; i < outLen; i++) {
            const pos = i * ratio;
            const i0 = Math.floor(pos);
            const frac = pos - i0;
            const s0 = input[i0] ?? 0;
            const s1 = input[i0 + 1] ?? s0;
            out[i] = s0 + (s1 - s0) * frac;
        }
    }
    return out;
}
