/**
 * Data Loader & Checkpoint Module
 *
 * Pure data transformation helpers, CSV conversion, JSON sanitization,
 * and IndexedDB checkpoint persistence.
 */

import { rawData, filteredData, graphData, communities, cibDetection, networkMetrics, filteredIndices, vizManager, coordinationGraph } from './state.js';
import { embeddingsCache } from './performance-utils.js';
import { encodeEmbeddingPair, decodeProjectEmbeddings } from './embedding-codec.js';

// Re-export so existing importers (app.js) can keep getting it from data-loader.
export { decodeProjectEmbeddings };

// =========================
// CSV Conversion
// =========================

export function parseTimestamp(str, format) {
  if (!str || str === '') return null;

  try {
    switch (format) {
      case 'unix':
        return parseInt(str);
      case 'unix-ms':
        return Math.floor(parseInt(str) / 1000);
      case 'iso':
        return Math.floor(new Date(str).getTime() / 1000);
      case 'us': // MM/DD/YYYY HH:mm:ss
      case 'eu': { // DD/MM/YYYY HH:mm:ss
        const parts = str.match(/(\d+)[\/\-](\d+)[\/\-](\d+)[\s\T]?(\d+)?:?(\d+)?:?(\d+)?/);
        if (!parts) {
          return Math.floor(new Date(str).getTime() / 1000);
        }

        let [, a, b, year, hour = 0, min = 0, sec = 0] = parts;
        const month = format === 'us' ? a : b;
        const day = format === 'us' ? b : a;

        if (year.length === 2) {
          year = parseInt(year) < 50 ? '20' + year : '19' + year;
        }

        return Math.floor(new Date(year, month - 1, day, hour, min, sec).getTime() / 1000);
      }
      default:
        return Math.floor(new Date(str).getTime() / 1000);
    }
  } catch (e) {
    console.warn(`Failed to parse timestamp: ${str}`, e);
    return null;
  }
}

export async function convertCSVToUnified(csvData, mapping, dateFormat, onProgress) {
  const unified = [];
  let successCount = 0;
  let errorCount = 0;
  const chunkSize = 500;
  const totalRows = csvData.rows.length;

  const convertRow = (row, idx) => {
    const getCell = (field) => {
      const colName = mapping[field];
      if (!colName) return null;
      const colIdx = csvData.headers.indexOf(colName);
      return colIdx >= 0 ? row[colIdx] : null;
    };

    const timestampStr = getCell('timestamp');
    let timestamp = null;
    if (timestampStr) {
      timestamp = parseTimestamp(timestampStr, dateFormat);
    }

    const hashtagsStr = getCell('hashtags');
    const hashtags = hashtagsStr
      ? hashtagsStr.split(/[,\s]+/).filter(t => t.trim())
          .map(t => t.replace(/^#/, '').trim())
          .filter(t => t.length > 0)
          .map(t => ({ id: t, title: t }))
      : [];

    const mentionsStr = getCell('mentions');
    const mentions = mentionsStr
      ? mentionsStr.split(/[,\s]+/).filter(m => m.trim())
          .map(m => m.replace(/^@/, '').trim())
          .filter(m => m.length > 0)
          .map(m => ({ type: 0, userId: m, userUniqueId: m }))
      : [];

    const verifiedStr = getCell('verified');
    const verified = verifiedStr
      ? ['yes', 'true', '1', 'verified'].includes(verifiedStr.toLowerCase().trim())
      : false;

    return {
      platform: 'csv',
      data: {
        id: getCell('postId') || `csv_${idx}`,
        author: {
          id: getCell('authorId') || `user_${idx}`,
          uniqueId: getCell('authorUsername') || 'unknown',
          nickname: getCell('authorUsername') || 'unknown',
          verified: verified
        },
        createTime: timestamp,
        desc: getCell('text') || '',
        challenges: hashtags,
        textExtra: mentions,
        stats: {
          diggCount: parseInt(getCell('likes')) || 0,
          commentCount: parseInt(getCell('comments')) || 0,
          shareCount: parseInt(getCell('shares')) || 0,
          playCount: parseInt(getCell('views')) || 0
        },
        authorStats: {
          followerCount: parseInt(getCell('followers')) || 0
        },
        _csv: {
          location: getCell('location'),
          url: getCell('url'),
          rowIndex: idx
        }
      }
    };
  };

  for (let i = 0; i < totalRows; i += chunkSize) {
    const chunk = csvData.rows.slice(i, Math.min(i + chunkSize, totalRows));

    for (let j = 0; j < chunk.length; j++) {
      const row = chunk[j];
      const idx = i + j;
      try {
        const post = convertRow(row, idx);
        unified.push(post);
        successCount++;
      } catch (err) {
        console.warn(`Failed to convert row ${idx + 1}: ${err.message}`);
        errorCount++;
      }
    }

    const progress = Math.floor((i + chunk.length) / totalRows * 100);
    if (onProgress) {
      onProgress(`Converting CSV data... ${progress}% (${i + chunk.length}/${totalRows} rows)`);
    }

    await new Promise(resolve => setTimeout(resolve, 0));
  }

  console.log(`CSV conversion complete: ${successCount} rows converted, ${errorCount} errors`);
  return unified;
}

export async function calculateStatsChunked(dataset, onProgress) {
  const chunkSize = 5000;
  const uniqueUsers = new Set();
  const uniqueHashtags = new Set();
  let totalEngagement = 0;
  const totalRows = dataset.length;

  for (let i = 0; i < totalRows; i += chunkSize) {
    const end = Math.min(i + chunkSize, totalRows);

    for (let j = i; j < end; j++) {
      const p = dataset[j];

      const userId = p?.data?.author?.id;
      if (userId) uniqueUsers.add(userId);

      const hashtags = p?.data?.challenges;
      if (hashtags && hashtags.length > 0) {
        for (let k = 0; k < hashtags.length; k++) {
          const title = hashtags[k]?.title;
          if (title) uniqueHashtags.add(title);
        }
      }

      const engagement = (p?.data?.stats?.diggCount || 0) + (p?.data?.stats?.commentCount || 0);
      totalEngagement += engagement;
    }

    if (onProgress) {
      const progress = Math.floor((end / totalRows) * 100);
      onProgress(`Calculating statistics... ${progress}% (${end}/${totalRows})`);
    }

    await new Promise(resolve => setTimeout(resolve, 0));
  }

  return {
    posts: totalRows,
    users: uniqueUsers.size,
    hashtags: uniqueHashtags.size,
    engagement: totalRows ? Math.round(totalEngagement / totalRows) : 0,
  };
}

// =========================
// JSON Sanitization
// =========================

export function sanitizeForJSON(obj, seen = new WeakSet()) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') return obj;
  if (obj instanceof Date) return obj.toISOString();
  if (ArrayBuffer.isView(obj)) return Array.from(obj);

  if (Array.isArray(obj)) {
    if (seen.has(obj)) {
      console.warn('Circular reference detected in array, skipping');
      return null;
    }
    seen.add(obj);
    return obj.map(item => sanitizeForJSON(item, seen));
  }

  if (typeof obj === 'function' || typeof obj === 'symbol') return undefined;
  if (obj instanceof HTMLElement || obj instanceof Node) return undefined;
  if (obj instanceof ReadableStream || obj instanceof WritableStream) return undefined;
  if (typeof WebGLRenderingContext !== 'undefined' && obj instanceof WebGLRenderingContext) return undefined;

  if (typeof obj === 'object') {
    if (seen.has(obj)) {
      console.warn('Circular reference detected in object, skipping');
      return null;
    }
    seen.add(obj);

    const sanitized = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        const value = sanitizeForJSON(obj[key], seen);
        if (value !== undefined) {
          sanitized[key] = value;
        }
      }
    }
    return sanitized;
  }

  return obj;
}

export function sanitizeGraphData(gd) {
  if (!gd) return null;

  return {
    nodes: gd.nodes.map(node => ({
      id: node.id,
      label: node.label,
      size: typeof node.size === 'number' ? node.size : undefined,
      color: typeof node.color === 'string' ? node.color : undefined,
      type: node.type,
      verified: node.verified,
      suspicious: node.suspicious,
      cibScore: node.cibScore,
      count: node.count
    })),
    links: gd.links.map(link => ({
      source: typeof link.source === 'object' ? link.source.id : link.source,
      target: typeof link.target === 'object' ? link.target.id : link.target,
      weight: link.weight
    }))
  };
}

// =========================
// Checkpoint System (IndexedDB)
// =========================

const CHECKPOINT_DB_NAME = 'schuimsurfer_checkpoints';
const CHECKPOINT_DB_VERSION = 1;
const CHECKPOINT_STORE_NAME = 'checkpoints';
const CHECKPOINT_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

function openCheckpointDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CHECKPOINT_DB_NAME, CHECKPOINT_DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(CHECKPOINT_STORE_NAME)) {
        const store = db.createObjectStore(CHECKPOINT_STORE_NAME, { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
  });
}

export async function saveCheckpoint(operation, progress, partialResults = null, options = {}) {
  try {
    const db = await openCheckpointDB();
    const includeData = options.includeData === true;
    let preservedData = null;
    let preservedFilteredData = null;
    let preservedHasSnapshot = false;

    if (!includeData) {
      try {
        const readTx = db.transaction([CHECKPOINT_STORE_NAME], 'readonly');
        const readStore = readTx.objectStore(CHECKPOINT_STORE_NAME);
        const existing = await new Promise((resolve, reject) => {
          const req = readStore.get('current');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        if (existing && existing.hasDataSnapshot && Array.isArray(existing.data)) {
          preservedData = existing.data;
          preservedFilteredData = existing.filteredData;
          preservedHasSnapshot = true;
        }
      } catch (e) {
        // Continue without preserved snapshot if this fails.
      }
    }

    const checkpoint = {
      id: 'current',
      operation: operation,
      progress: progress,
      timestamp: Date.now(),
      dataSize: rawData.length,
      filteredDataSize: filteredData?.length || 0,

      data: includeData ? rawData : preservedData,
      filteredData: includeData ? filteredData : preservedFilteredData,

      recoveryData: partialResults ? {
        cibResults: partialResults.results ? {
          suspiciousUsers: Array.from(partialResults.results.suspiciousUsers || []),
          indicators: partialResults.results.indicators || {}
        } : null,
        completedStage: partialResults.stage || null,
        params: partialResults.params || null,
        timeWindow: partialResults.timeWindow || null,
        stats: partialResults.stats || null
      } : {
        rawDataSample: rawData.slice(0, 100),
        graphSize: graphData ? { nodes: graphData.nodes?.length, links: graphData.links?.length } : null
      },
      hasDataSnapshot: includeData || preservedHasSnapshot
    };

    const transaction = db.transaction([CHECKPOINT_STORE_NAME], 'readwrite');
    const store = transaction.objectStore(CHECKPOINT_STORE_NAME);
    store.put(checkpoint);

    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });

    console.log(`📌 Checkpoint saved to IndexedDB: ${operation} (${progress}%) - Stage: ${partialResults?.stage || 'N/A'}`);
    db.close();
  } catch (error) {
    console.warn('Failed to save checkpoint to IndexedDB:', error);
    try {
      localStorage.setItem('schuimsurfer_checkpoint_fallback', JSON.stringify({
        operation: operation,
        progress: progress,
        timestamp: Date.now(),
        dataSize: rawData.length
      }));
    } catch (e) {
      console.error('Could not save checkpoint fallback:', e);
    }
  }
}

export async function clearCheckpoint() {
  try {
    const db = await openCheckpointDB();
    const transaction = db.transaction([CHECKPOINT_STORE_NAME], 'readwrite');
    const store = transaction.objectStore(CHECKPOINT_STORE_NAME);
    store.delete('current');

    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });

    console.log('✓ Checkpoint cleared from IndexedDB');
    db.close();
  } catch (error) {
    console.error('Failed to clear checkpoint:', error);
  }

  localStorage.removeItem('schuimsurfer_checkpoint_fallback');
}

export async function getCheckpoint() {
  try {
    const db = await openCheckpointDB();
    const transaction = db.transaction([CHECKPOINT_STORE_NAME], 'readonly');
    const store = transaction.objectStore(CHECKPOINT_STORE_NAME);
    const request = store.get('current');

    const checkpoint = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    db.close();

    if (!checkpoint) {
      const fallback = localStorage.getItem('schuimsurfer_checkpoint_fallback');
      if (fallback) {
        return JSON.parse(fallback);
      }
      return null;
    }

    const age = Date.now() - checkpoint.timestamp;
    if (age > CHECKPOINT_MAX_AGE) {
      console.log('Checkpoint expired, clearing...');
      await clearCheckpoint();
      return null;
    }

    return checkpoint;
  } catch (error) {
    console.error('Failed to load checkpoint:', error);
    return null;
  }
}

// =========================
// Project Serialization
// =========================

function serializeCibDetection(cib) {
  if (!cib) return null;
  return {
    suspiciousUsers: Array.from(cib.suspiciousUsers || []),
    indicators: cib.indicators || {},
    userScores: cib.userScores ? Array.from(cib.userScores.entries()) : [],
    userReasons: cib.userReasons ? Array.from(cib.userReasons.entries()) : []
  };
}

function serializeCommunities(comms) {
  if (!comms) return null;
  return {
    communities: comms.communities ? Array.from(comms.communities.entries()) : [],
    names: comms.names ? Array.from(comms.names.entries()) : [],
    modularity: comms.modularity,
    noiseClusterId: comms.noiseClusterId,
    clusterStats: comms.clusterStats
  };
}

/**
 * Append a JSON array of `arr`, encoded element-by-element via `encodeFn`, to the
 * `parts` array in slices. Keeps each individual string part well under the
 * engine's max-string-length so very large datasets serialize without hitting
 * the single-giant-string ceiling. The parts concatenate to valid JSON.
 */
function appendArrayInSlices(parts, arr, encodeFn, sliceSize = 500) {
  if (!arr || arr.length === 0) {
    parts.push('[]');
    return;
  }
  parts.push('[');
  let buf = '';
  for (let i = 0; i < arr.length; i++) {
    buf += (i === 0 ? '' : ',') + encodeFn(arr[i], i);
    if ((i + 1) % sliceSize === 0) {
      parts.push(buf);
      buf = '';
    }
  }
  if (buf) parts.push(buf);
  parts.push(']');
}

function appendEmbeddingsInSlices(parts) {
  const cache = embeddingsCache && embeddingsCache.cache;
  if (!cache || cache.size === 0) {
    parts.push('[]');
    return;
  }
  parts.push('[');
  let firstEntry = true;
  cache.forEach((value, key) => {
    parts.push((firstEntry ? '' : ',') + '{"key":' + JSON.stringify(key) + ',"value":');
    firstEntry = false;
    if (value instanceof Map) {
      const pairs = Array.from(value.entries());
      appendArrayInSlices(parts, pairs, ([k, v]) => JSON.stringify(encodeEmbeddingPair(k, v)));
    } else {
      parts.push(JSON.stringify(value));
    }
    parts.push('}');
  });
  parts.push(']');
}

/**
 * Build a saved project as an array of string parts that concatenate to valid
 * JSON. The big arrays (rawData, filteredData, embeddings) are emitted in slices
 * so no single string approaches the engine limit; the caller wraps the parts in
 * a Blob (and gzips it). Returns { parts, metadata }.
 */
export function buildProjectParts(uiState) {
  const serializedCommunities = serializeCommunities(communities);
  const serializedCibDetection = serializeCibDetection(cibDetection);
  const hasEmbeddings = !!(embeddingsCache && embeddingsCache.cache && embeddingsCache.cache.size > 0);

  const metadata = {
    timestamp: new Date().toISOString(),
    datasetSize: rawData.length,
    platform: 'Unknown',
    hasEmbeddings,
    hasCibAnalysis: !!serializedCibDetection,
    hasCommunities: !!serializedCommunities
  };

  const analysis = {
    graphData: sanitizeGraphData(graphData),
    networkMetrics: sanitizeForJSON(networkMetrics),
    communities: serializedCommunities,
    cibDetection: serializedCibDetection,
    nodeSizeStats: sanitizeForJSON(vizManager?.nodeSizeStats),
    coordinationGraph: coordinationGraph || null
  };

  const parts = [];
  parts.push('{"version":"1.1.0",');
  parts.push('"metadata":' + JSON.stringify(metadata) + ',');
  parts.push('"data":{"rawData":');
  appendArrayInSlices(parts, rawData, (post) => JSON.stringify(sanitizeForJSON(post)));
  parts.push(',"filteredData":');
  appendArrayInSlices(parts, filteredData, (post) => JSON.stringify(sanitizeForJSON(post)));
  parts.push(',"filteredIndices":' + (filteredIndices ? JSON.stringify(Array.from(filteredIndices)) : 'null'));
  parts.push('},"analysis":' + JSON.stringify(analysis) + ',');
  parts.push('"embeddings":');
  appendEmbeddingsInSlices(parts);
  parts.push(',"uiState":' + JSON.stringify(uiState));
  parts.push('}');

  console.log('📦 Project parts prepared for serialization');
  console.log(`  - Raw data: ${rawData.length} posts`);
  console.log(`  - Graph: ${graphData?.nodes?.length || 0} nodes, ${graphData?.links?.length || 0} links`);
  console.log(`  - Embeddings: ${embeddingsCache?.cache?.size || 0} cached entries`);

  return { parts, metadata };
}

export async function emergencySaveAsCSV() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const filename = `schuimsurfer-EMERGENCY-${timestamp}.csv`;

  const headers = ['author_id', 'author_username', 'post_id', 'timestamp', 'text', 'likes', 'comments', 'shares', 'views'];
  let csvContent = headers.join(',') + '\n';

  rawData.forEach(post => {
    const row = [
      post.data?.author?.id || '',
      post.data?.author?.uniqueId || '',
      post.data?.id || '',
      post.data?.createTime || '',
      (post.data?.desc || '').replace(/"/g, ''),
      post.data?.stats?.diggCount || 0,
      post.data?.stats?.commentCount || 0,
      post.data?.stats?.shareCount || 0,
      post.data?.stats?.playCount || 0
    ];
    csvContent += row.map(field => `"${field}"`).join(',') + '\n';
  });

  const blob = new Blob([csvContent], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  console.log(`✓ Emergency CSV saved: ${filename} (${rawData.length} posts)`);
}
