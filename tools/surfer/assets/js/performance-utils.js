// Performance Utilities: Caching, Progressive Loading, Virtual Scrolling

// ==========================
// Computation Cache
// ==========================

export class ComputationCache {
  constructor(maxSize = 100) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  /**
   * Generate cache key from data and parameters
   */
  getKey(data, params = {}) {
    const dataHash = this.hashData(data);
    const paramHash = JSON.stringify(params);
    return `${dataHash}:${paramHash}`;
  }

  /**
   * Simple hash based on data characteristics
   */
  hashData(data) {
    if (Array.isArray(data)) {
      return `arr:${data.length}:${data[0]?.data?.author?.id || ''}:${data[data.length - 1]?.data?.author?.id || ''}`;
    }
    if (data && typeof data === 'object' && data.nodes && data.links) {
      return `graph:${data.nodes.length}:${data.links.length}`;
    }
    return JSON.stringify(data).substring(0, 100);
  }

  /**
   * Get cached value or compute and cache it
   */
  get(data, params, computeFn) {
    const key = this.getKey(data, params);

    if (this.cache.has(key)) {
      console.log(`✓ Cache hit: ${key.substring(0, 50)}...`);
      return this.cache.get(key);
    }

    console.log(`⚠ Cache miss, computing: ${key.substring(0, 50)}...`);
    const result = computeFn();
    this.set(key, result);
    return result;
  }

  /**
   * Set cache entry with LRU eviction
   */
  set(key, value) {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
      console.log(`Cache evicted oldest entry: ${firstKey.substring(0, 50)}...`);
    }
    this.cache.set(key, value);
  }

  /**
   * Clear entire cache
   */
  clear() {
    this.cache.clear();
    console.log('Cache cleared');
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      keys: Array.from(this.cache.keys()).map(k => k.substring(0, 50))
    };
  }
}

// Global cache instances
export const networkMetricsCache = new ComputationCache(50);
export const communityDetectionCache = new ComputationCache(20);
export const embeddingsCache = new ComputationCache(10); // Cache embeddings

// ==========================
// Progressive File Loader
// ==========================

export class ProgressiveFileLoader {
  constructor(onProgress, onChunkProcessed) {
    this.onProgress = onProgress;
    this.onChunkProcessed = onChunkProcessed;
    this.chunkSize = 1000; // Process 1000 lines at a time
  }

  /**
   * Load and parse NDJSON file progressively
   */
  async loadNDJSON(file) {
    const totalSize = file.size;
    let loadedSize = 0;
    let buffer = '';
    let allData = [];
    let lineCount = 0;

    try {
      const stream = file.stream();
      const reader = stream.pipeThrough(new TextDecoderStream()).getReader();

      let chunk = [];

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        loadedSize += value.length;
        buffer += value;

        // Report loading progress
        const loadProgress = (loadedSize / totalSize) * 50; // 0-50% for loading
        this.onProgress(loadProgress, `Loading file... ${Math.round(loadProgress)}%`);

        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const parsed = JSON.parse(line);
            chunk.push(parsed);
            lineCount++;

            // Process chunk when it reaches chunkSize
            if (chunk.length >= this.chunkSize) {
              if (this.onChunkProcessed) {
                await this.onChunkProcessed(chunk, lineCount);
              }
              allData.push(...chunk);
              chunk = [];

              // Report processing progress
              const processProgress = 50 + (allData.length / lineCount) * 25; // 50-75% for processing
              this.onProgress(processProgress, `Processed ${allData.length} posts...`);
            }
          } catch (parseError) {
            console.warn(`Failed to parse line ${lineCount}: ${parseError.message}`);
          }
        }
      }

      // Process remaining lines in buffer
      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer);
          chunk.push(parsed);
          lineCount++;
        } catch (parseError) {
          console.warn(`Failed to parse final line: ${parseError.message}`);
        }
      }

      // Process final chunk
      if (chunk.length > 0) {
        if (this.onChunkProcessed) {
          await this.onChunkProcessed(chunk, lineCount);
        }
        allData.push(...chunk);
      }

      this.onProgress(75, `Finalizing ${allData.length} posts...`);

      return allData;

    } catch (error) {
      console.error('Error in progressive file loading:', error);
      throw error;
    }
  }

  /**
   * Parse a single CSV line handling quoted fields with commas and newlines
   */
  parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          // Escaped quote inside quoted field
          current += '"';
          i++; // Skip next quote
        } else {
          // Toggle quote state
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        // Field delimiter (only outside quotes)
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    // Push last field
    result.push(current.trim());
    return result;
  }

  /**
   * Load and parse CSV file progressively
   */
  async loadCSV(file) {
    const totalSize = file.size;
    let loadedSize = 0;
    let buffer = '';
    let headers = null;
    let allRows = [];
    let rowCount = 0;

    try {
      const stream = file.stream();
      const reader = stream.pipeThrough(new TextDecoderStream()).getReader();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        loadedSize += value.length;
        buffer += value;

        // Report loading progress
        const loadProgress = (loadedSize / totalSize) * 50; // 0-50% for loading
        this.onProgress(loadProgress, `Loading CSV... ${Math.round(loadProgress)}%`);

        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const row = this.parseCSVLine(line);

            if (!headers) {
              // First row is headers
              headers = row.map(h => h.replace(/^"(.+)"$/, '$1').trim()); // Remove surrounding quotes
            } else {
              // Clean up cell values (remove surrounding quotes)
              const cleanedRow = row.map(cell => cell.replace(/^"(.+)"$/, '$1').trim());
              allRows.push(cleanedRow);
              rowCount++;

              // Report progress periodically
              if (rowCount % 100 === 0) {
                const processProgress = 50 + (rowCount / (rowCount + 100)) * 25;
                this.onProgress(processProgress, `Processed ${rowCount} rows...`);
              }
            }
          } catch (parseError) {
            console.warn(`Failed to parse CSV line ${rowCount + 1}: ${parseError.message}`);
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const row = this.parseCSVLine(buffer);
          if (!headers) {
            headers = row.map(h => h.replace(/^"(.+)"$/, '$1').trim());
          } else {
            const cleanedRow = row.map(cell => cell.replace(/^"(.+)"$/, '$1').trim());
            allRows.push(cleanedRow);
            rowCount++;
          }
        } catch (parseError) {
          console.warn(`Failed to parse final CSV line: ${parseError.message}`);
        }
      }

      this.onProgress(75, `Loaded ${rowCount} rows from CSV...`);

      return {
        headers: headers || [],
        rows: allRows
      };

    } catch (error) {
      console.error('Error in CSV file loading:', error);
      throw error;
    }
  }
}

// ==========================
// Columnar Dataset Index
// ==========================

function toSafeString(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function getOrAddDictionaryIndex(value, map, dict) {
  const key = toSafeString(value);
  if (!key) return -1;
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const next = dict.length;
  dict.push(key);
  map.set(key, next);
  return next;
}

/**
 * Build a compact index for filtering and worker payload generation.
 * Keeps original objects untouched for exact analysis behavior.
 */
export function buildColumnarIndex(posts = []) {
  const count = posts.length;

  const timestamps = new Int32Array(count);
  const engagement = new Uint32Array(count);
  const authorCreateTimes = new Int32Array(count);
  const authorIndices = new Int32Array(count);
  const captionIndices = new Int32Array(count);
  authorIndices.fill(-1);
  captionIndices.fill(-1);

  const authorDict = [];
  const authorLabelDict = [];
  const captionDict = [];
  const hashtagDict = [];

  const authorMap = new Map();
  const captionMap = new Map();
  const hashtagMap = new Map();
  const hashtagPool = [];
  const hashtagOffsets = new Uint32Array(count + 1);

  // Session 5: URL co-sharing + repost columns (mirror the hashtag layout).
  const urlDict = [];
  const urlMap = new Map();
  const urlPool = [];
  const urlOffsets = new Uint32Array(count + 1);
  const repostDict = [];        // target identifier (id or @name)
  const repostNameDict = [];    // parallel display name
  const repostMap = new Map();
  const repostIndices = new Int32Array(count);
  repostIndices.fill(-1);

  for (let i = 0; i < count; i++) {
    const post = posts[i];
    const data = post?.data || {};
    const author = data.author || {};

    const createTime = Number(data.createTime) || 0;
    timestamps[i] = createTime;
    authorCreateTimes[i] = Number(author.createTime) || 0;

    const postEngagement =
      (Number(data.stats?.diggCount) || 0) +
      (Number(data.stats?.commentCount) || 0) +
      (Number(data.stats?.shareCount) || 0);
    engagement[i] = postEngagement;

    const authorId = toSafeString(author.id);
    if (authorId) {
      let authorIdx = authorMap.get(authorId);
      if (authorIdx === undefined) {
        authorIdx = authorDict.length;
        authorMap.set(authorId, authorIdx);
        authorDict.push(authorId);
        authorLabelDict.push(toSafeString(author.uniqueId || author.nickname || authorId));
      } else if (!authorLabelDict[authorIdx]) {
        authorLabelDict[authorIdx] = toSafeString(author.uniqueId || author.nickname || authorId);
      }
      authorIndices[i] = authorIdx;
    }

    const captionIndex = getOrAddDictionaryIndex(data.desc, captionMap, captionDict);
    if (captionIndex >= 0) captionIndices[i] = captionIndex;

    hashtagOffsets[i] = hashtagPool.length;
    const hashtags = data.challenges || [];
    for (let j = 0; j < hashtags.length; j++) {
      const tagTitle = hashtags[j]?.title;
      const tagIdx = getOrAddDictionaryIndex(tagTitle, hashtagMap, hashtagDict);
      if (tagIdx >= 0) hashtagPool.push(tagIdx);
    }
    hashtagOffsets[i + 1] = hashtagPool.length;

    // URLs (deduped per post)
    urlOffsets[i] = urlPool.length;
    const urls = data.urls || [];
    const seenUrl = new Set();
    for (let j = 0; j < urls.length; j++) {
      const u = urls[j]?.url;
      if (!u || seenUrl.has(u)) continue;
      seenUrl.add(u);
      const urlIdx = getOrAddDictionaryIndex(u, urlMap, urlDict);
      if (urlIdx >= 0) urlPool.push(urlIdx);
    }
    urlOffsets[i + 1] = urlPool.length;

    // Repost / quote target author
    const repostTarget = data.repost?.targetId;
    if (repostTarget != null && repostTarget !== '') {
      const key = toSafeString(repostTarget);
      let rIdx = repostMap.get(key);
      if (rIdx === undefined) {
        rIdx = repostDict.length;
        repostMap.set(key, rIdx);
        repostDict.push(key);
        repostNameDict.push(toSafeString(data.repost?.targetName || key));
      }
      repostIndices[i] = rIdx;
    }
  }

  return {
    length: count,
    timestamps,
    engagement,
    authorCreateTimes,
    authorIndices,
    captionIndices,
    hashtagOffsets,
    hashtagPool: Uint32Array.from(hashtagPool),
    urlOffsets,
    urlPool: Uint32Array.from(urlPool),
    repostIndices,
    authorDict,
    authorLabelDict,
    captionDict,
    hashtagDict,
    urlDict,
    repostDict,
    repostNameDict
  };
}

export function filterColumnarIndices(columnarIndex, { minEngagement, startDate, endDate } = {}) {
  if (!columnarIndex || !Number.isFinite(columnarIndex.length)) return new Uint32Array();

  const minimum = Number.isFinite(minEngagement) ? minEngagement : 0;
  const hasStart = Number.isFinite(startDate);
  const hasEnd = Number.isFinite(endDate);
  const start = hasStart ? startDate : 0;
  const end = hasEnd ? endDate : Infinity;
  const hasDateFilter = hasStart || hasEnd;

  const matches = [];
  const timestamps = columnarIndex.timestamps;
  const engagement = columnarIndex.engagement;

  for (let i = 0; i < columnarIndex.length; i++) {
    if (engagement[i] < minimum) continue;

    const postTime = timestamps[i];
    const hasTimestamp = postTime > 0;
    const passesDateFilter = !hasTimestamp ? !hasDateFilter : (postTime >= start && postTime <= end);

    if (passesDateFilter) matches.push(i);
  }

  return Uint32Array.from(matches);
}

export function materializePostsByIndices(posts, indices) {
  if (!Array.isArray(posts) || !indices) return [];
  const length = indices.length || 0;
  const materialized = new Array(length);
  for (let i = 0; i < length; i++) {
    materialized[i] = posts[indices[i]];
  }
  return materialized;
}

/**
 * Build compact worker payload and transfer typed buffers to avoid deep clone costs.
 */
export function buildCibTransferPayload(columnarIndex, filteredIndices) {
  if (!columnarIndex || !filteredIndices || filteredIndices.length === 0) {
    return null;
  }

  const count = filteredIndices.length;
  const authorIndices = new Int32Array(count);
  const createTimes = new Int32Array(count);
  const authorCreateTimes = new Int32Array(count);
  const captionIndices = new Int32Array(count);
  const hashtagOffsets = new Uint32Array(count + 1);
  const urlOffsets = new Uint32Array(count + 1);
  const repostIndices = new Int32Array(count);

  const fullOffsets = columnarIndex.hashtagOffsets;
  const fullPool = columnarIndex.hashtagPool;
  // URL columns may be absent in older indexes; guard so callers stay working.
  const fullUrlOffsets = columnarIndex.urlOffsets;
  const fullUrlPool = columnarIndex.urlPool;
  const fullRepostIndices = columnarIndex.repostIndices;
  let totalHashtags = 0;
  let totalUrls = 0;

  for (let i = 0; i < count; i++) {
    const dataIndex = filteredIndices[i];
    totalHashtags += fullOffsets[dataIndex + 1] - fullOffsets[dataIndex];
    if (fullUrlOffsets) totalUrls += fullUrlOffsets[dataIndex + 1] - fullUrlOffsets[dataIndex];
  }

  const hashtagPool = new Uint32Array(totalHashtags);
  const urlPool = new Uint32Array(totalUrls);
  let cursor = 0;
  let urlCursor = 0;

  for (let i = 0; i < count; i++) {
    const dataIndex = filteredIndices[i];
    authorIndices[i] = columnarIndex.authorIndices[dataIndex];
    createTimes[i] = columnarIndex.timestamps[dataIndex];
    authorCreateTimes[i] = columnarIndex.authorCreateTimes[dataIndex];
    captionIndices[i] = columnarIndex.captionIndices[dataIndex];
    repostIndices[i] = fullRepostIndices ? fullRepostIndices[dataIndex] : -1;

    hashtagOffsets[i] = cursor;
    const start = fullOffsets[dataIndex];
    const end = fullOffsets[dataIndex + 1];
    for (let j = start; j < end; j++) {
      hashtagPool[cursor++] = fullPool[j];
    }
    hashtagOffsets[i + 1] = cursor;

    urlOffsets[i] = urlCursor;
    if (fullUrlOffsets) {
      const us = fullUrlOffsets[dataIndex];
      const ue = fullUrlOffsets[dataIndex + 1];
      for (let j = us; j < ue; j++) urlPool[urlCursor++] = fullUrlPool[j];
    }
    urlOffsets[i + 1] = urlCursor;
  }

  const payload = {
    version: 2,
    count,
    authorIndices,
    createTimes,
    authorCreateTimes,
    captionIndices,
    hashtagOffsets,
    hashtagPool,
    urlOffsets,
    urlPool,
    repostIndices,
    authorDict: columnarIndex.authorDict,
    authorLabelDict: columnarIndex.authorLabelDict,
    captionDict: columnarIndex.captionDict,
    hashtagDict: columnarIndex.hashtagDict,
    urlDict: columnarIndex.urlDict || [],
    repostDict: columnarIndex.repostDict || [],
    repostNameDict: columnarIndex.repostNameDict || []
  };

  const transferables = [
    authorIndices.buffer,
    createTimes.buffer,
    authorCreateTimes.buffer,
    captionIndices.buffer,
    hashtagOffsets.buffer,
    hashtagPool.buffer,
    urlOffsets.buffer,
    urlPool.buffer,
    repostIndices.buffer
  ];

  return { payload, transferables };
}

// ==========================
// Performance Monitor
// ==========================

export class PerformanceMonitor {
  constructor() {
    this.timings = new Map();
  }

  start(label) {
    this.timings.set(label, performance.now());
  }

  end(label) {
    const startTime = this.timings.get(label);
    if (startTime === undefined) {
      console.warn(`No start time found for label: ${label}`);
      return 0;
    }

    const duration = performance.now() - startTime;
    this.timings.delete(label);

    console.log(`⏱️ ${label}: ${duration.toFixed(2)}ms`);
    return duration;
  }

  logMemory() {
    if (performance.memory) {
      const used = (performance.memory.usedJSHeapSize / 1048576).toFixed(2);
      const total = (performance.memory.totalJSHeapSize / 1048576).toFixed(2);
      console.log(`💾 Memory: ${used}MB / ${total}MB`);
    }
  }
}

export const perfMonitor = new PerformanceMonitor();
