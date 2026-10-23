# IJEPA Visual Search — Optimized

A high-performance browser-based reverse image search using I-JEPA embeddings, optimized for large-scale datasets (500K+ images).

## Optimizations Implemented

### 1. Int8 Quantized Embeddings
- **Before**: Float32 = 5,120 bytes per embedding
- **After**: Int8 = 1,280 bytes per embedding (75% reduction)
- Pre-computed norms for fast similarity computation
- Symmetric quantization: `scale = max(|values|) / 127`

### 2. Origin Private File System (OPFS)
- 10-100x faster than IndexedDB for binary data
- Direct file system access within the browser sandbox
- Synchronous reads possible in Web Workers (future enhancement)
- Persistent across sessions

### 3. WebGPU-Accelerated Similarity Search
- Batch compute similarities using GPU compute shaders
- 100-1000x faster than CPU for large datasets
- Automatic fallback to CPU if WebGPU unavailable
- Processes candidates in parallel workgroups

### 4. K-Means Clustering
- Hierarchical search: query clusters first, then search within top-k clusters
- Reduces search space by 80-95% depending on cluster count
- K-means++ initialization for better cluster quality
- Configurable cluster count (4-64)

### 5. Virtual Scrolling
- Only renders visible database items
- Intersection Observer for lazy thumbnail loading
- Smooth scrolling through 100K+ items
- Fixed-height items for predictable layout

## Performance Expectations

| Dataset Size | Storage Size | Search Time (GPU) | Search Time (CPU) |
|-------------|--------------|-------------------|-------------------|
| 10K images  | ~15 MB       | 5-10 ms          | 50-100 ms         |
| 100K images | ~150 MB      | 20-50 ms         | 500-1000 ms       |
| 500K images | ~750 MB      | 50-100 ms        | 2-5 seconds       |

*With clustering enabled (k=32), search times reduced by ~90%*

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Browser Main Thread                     │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   UI/UX     │  │  ONNX       │  │   Virtual Scroll    │  │
│  │  Handlers   │  │  Runtime    │  │   + Lazy Loading    │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                       Data Layer                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  Int8       │  │  K-Means    │  │   Pre-computed      │  │
│  │  Embeddings │  │  Clusters   │  │   Norms             │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                      Storage Layer                           │
│  ┌─────────────────────────────────────────────────────────┐│
│  │                    OPFS (Binary Files)                  ││
│  │   embeddings.bin │ norms.bin │ centroids.bin │ meta.json││
│  └─────────────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────────┤
│                      Compute Layer                           │
│  ┌─────────────────────┐  ┌─────────────────────────────┐   │
│  │   WebGPU Compute    │  │   CPU Fallback              │   │
│  │   Similarity Shader │  │   (when GPU unavailable)    │   │
│  └─────────────────────┘  └─────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## File Format (Export)

Binary format for efficient storage:

```
[4 bytes]     Header length (uint32)
[N bytes]     JSON header (metadata, cluster assignments, config)
[M bytes]     Int8 embeddings (count × 1280)
[K bytes]     Float32 norms (count × 4)
[C bytes]     Float32 centroids (optional, k × 1280 × 4)
```

## Usage

### Setup

1. The I-JEPA model (~600MB) downloads from Hugging Face (`onnx-community/ijepa_vith14_1k`) on first use
2. Serve with a local HTTP server:
   ```bash
   python -m http.server 8080
   ```
3. Open `http://localhost:8080`

### Building the Database

1. Wait for all three status indicators to turn green:
   - Model loaded
   - WebGPU ready (or CPU fallback)
   - OPFS ready

2. Configure settings:
   - **Keyframes/video**: How many frames to extract from videos
   - **Clusters (k-means)**: Number of clusters for hierarchical search

3. Pick an embedding model in the header: **I-JEPA**, **CLIP**, or
   **Concept (OWLv2 + CLIP)**. Concept mode reveals a **Concept prompt** input:
   enter a text prompt like `red cars`, and an OWLv2 zero-shot detector
   (`onnx-community/owlv2-base-patch16-ensemble-ONNX`, lazy-loaded, WebGPU fp16
   with WASM q8 fallback) scans each image/frame so that **only the matching
   regions are cropped, CLIP-embedded, and stored** — non-matching files/frames
   are skipped. Since crops are CLIP embeddings, text search keeps working.

3. Drag and drop images/videos or click to browse

4. Database auto-saves to OPFS after processing

### Searching

1. Switch to "Search" tab
2. Upload a query image
3. Click "Search"
4. Results show similarity percentage and cluster assignment

### Database Management

- **Recluster**: Rebuild k-means clusters (useful after adding many items)
- **Export**: Download binary database file
- **Import**: Load a previously exported database
- **Clear**: Delete all data

## WebGPU Compute Shader

The similarity computation runs on the GPU:

```wgsl
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= numCandidates) { return; }
    
    var dot: i32 = 0;
    let base = idx * DIM;
    
    for (var i = 0u; i < DIM; i++) {
        dot += query[i] * candidates[base + i];
    }
    
    let similarity = f32(dot) / (queryNorm * norms[idx]);
    results[idx] = similarity;
}
```

## Browser Requirements

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| OPFS    | 102+   | 111+    | 15.2+  | 102+ |
| WebGPU  | 113+   | 🚧      | 🚧     | 113+ |
| WASM    | ✅     | ✅      | ✅     | ✅   |

*🚧 = Behind flag or in development*

## Memory Considerations

| Component | Size per 100K images |
|-----------|---------------------|
| Int8 Embeddings | 128 MB |
| Float32 Norms | 400 KB |
| Thumbnails | ~500 MB (100x100 JPEG) |
| Metadata | ~10 MB |
| **Total** | ~650 MB |

Thumbnails are stored as data URLs in metadata for simplicity. For even larger datasets, consider:
- Storing thumbnails separately in OPFS
- Using even smaller thumbnails (50x50)
- Lazy-loading thumbnails from a CDN

## Future Enhancements

- [ ] Web Worker for background processing
- [ ] SIMD-accelerated CPU fallback
- [ ] Product Quantization for further compression
- [ ] Streaming video processing
- [ ] Multi-query batch search
- [ ] Incremental clustering (add to clusters without full rebuild)

## Troubleshooting

**WebGPU not available**
- Update Chrome/Edge to latest version
- Check `chrome://gpu` for WebGPU status
- Fallback to CPU is automatic

**Concept mode: the detector (Grounding DINO)**
- Concept mode uses **Grounding DINO** (`onnx-community/grounding-dino-tiny-ONNX`)
  for zero-shot, text-prompted detection, running on **WebGPU (fp16)** by default.
  It was chosen over OWLv2 specifically because OWLv2's detection head is silently
  miscomputed by ORT's WebGPU backend (returns all-zero scores → nothing detected),
  whereas Grounding DINO computes correctly on WebGPU and is much faster there than
  OWLv2 on CPU (~seconds/frame vs ~40s).
- Grounding DINO emits many low-confidence candidate boxes, so the concept score
  threshold is higher (0.3) than OWLv2's, and crops are capped per frame
  (`CONCEPT_MAX_BOXES`). If you get too few/many matches, tune `CONCEPT_THRESHOLD`.
- The **"Detector on CPU"** toggle under the concept prompt forces the WASM path
  (slower) for GPUs where the WebGPU session misbehaves. Takes effect on the next
  detector load (fresh page load). A catchable WebGPU init failure also falls back
  to WASM automatically.
- Video is one detection *per frame*: WebGPU keeps this fast; on the CPU fallback a
  long clip can take minutes (and, without a worker, blocks the UI during each frame).

**OPFS not working**
- Ensure you're serving via HTTP (not file://)
- Check browser storage quota
- Try incognito mode to rule out extensions

**Slow initial load**
- Model is ~600MB, cached after first load
- Large databases load from OPFS on startup

**Out of memory**
- Reduce thumbnail size
- Use fewer clusters
- Process images in smaller batches
