/**
 * Embedding codec (pure module)
 *
 * Encodes/decodes 384-dim Float32 caption embeddings for project saves. As
 * decimal JSON each dimension costs ~9 chars; as base64 of the raw Float32
 * buffer it costs ~5.6 chars (4 bytes → 4/3 base64 chars) and gzip compresses
 * the base64 far better than decimal text.
 *
 * No DOM / browser-only globals — only btoa/atob/Float32Array (available in
 * browsers and Node), so this is exercised directly by Node tests
 * (tests/embedding-codec.test.mjs).
 */

export function float32ToBase64(arr) {
  const f32 = arr instanceof Float32Array ? arr : Float32Array.from(arr || []);
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let binary = '';
  const CHUNK = 0x8000; // avoid call-stack limits in String.fromCharCode.apply
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToFloat32Array(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/**
 * Encode one [key, embeddingObject] cache pair for serialization, converting the
 * embedding vector to base64. Non-embedding values pass through untouched.
 */
export function encodeEmbeddingPair(k, v) {
  if (v && typeof v === 'object' && v.embedding !== undefined) {
    return [k, {
      caption: v.caption,
      embeddingB64: float32ToBase64(v.embedding),
      userId: v.userId,
    }];
  }
  return [k, v];
}

/**
 * Normalize a parsed project's embeddings entries into the in-memory shape
 * (key + array of [k, {caption, embedding, userId}]), decoding base64 vectors
 * back to plain number arrays. Tolerates the legacy decimal-array format.
 */
export function decodeProjectEmbeddings(embeddings) {
  if (!Array.isArray(embeddings)) return [];
  return embeddings.map(({ key, value }) => {
    if (!Array.isArray(value)) return { key, value };
    const decoded = value.map(([k, v]) => {
      if (v && typeof v === 'object' && v.embeddingB64 !== undefined) {
        return [k, {
          caption: v.caption,
          embedding: Array.from(base64ToFloat32Array(v.embeddingB64)),
          userId: v.userId,
        }];
      }
      return [k, v];
    });
    return { key, value: decoded };
  });
}
