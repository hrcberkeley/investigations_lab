/**
 * CIB Controller
 *
 * CIB (Coordinated Inauthentic Behavior) detection parameters,
 * sensitivity presets, and results display.
 */

import { rawData, filteredData, columnarDataIndex, filteredIndices, graphData, cibDetection, nodes, vizManager, coordinationGraph, setFilteredIndices, setCibDetection, setCoordinationGraph } from './state.js';
import { saveCheckpoint, clearCheckpoint } from './data-loader.js';
import { buildCibTransferPayload, embeddingsCache } from './performance-utils.js';
import { getPostKey } from './utils.js';
import { renderLegend } from './ui-controller.js';
import { createWorkerManager } from './worker-utils.js';
import { toast } from './notifications.js';

// Prevent concurrent CIB detection calls from overwriting each other's handlers
let pendingCibPromise = null;
let pendingSince = 0;
const PENDING_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes — after this, assume previous run is dead
const CIB_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes hard timeout

let currentCallId = 0;

// Shared worker lifecycle (creation, ping/pong liveness, recreate-if-dead).
// Identical machinery is reused by the graph worker — see worker-utils.js.
const cibManager = createWorkerManager('assets/js/cib-worker.js');

// Labels describe STRICTNESS: low values are lenient (more flags, more false
// positives), high values are strict (fewer, higher-confidence flags).
export const thresholdLabels = {
  1: 'Most Lenient',
  2: 'Very Lenient',
  3: 'Lenient',
  4: 'Slightly Lenient',
  5: 'Medium',
  6: 'Slightly Strict',
  7: 'Strict',
  8: 'Very Strict',
  9: 'Extra Strict',
  10: 'Most Strict'
};

export const defaultCibParams = {
  semanticEnabled: true,
  semanticThreshold: 0.85,
  ngramThreshold: 0.3,
  usernameThreshold: 0.8,
  tfidfThreshold: 0.5,
  zscoreThreshold: 2,
  burstPosts: 5,
  rhythmCV: 0.1,
  nightGap: 7200,
  clusterSize: 5,
  crossMultiplier: 0.3,
  minSyncPosts: 2,
  minHashtagGroupSize: 3,
  minUsernameGroupSize: 3,
  minHighVolumePosts: 5,
  // Session 5: URL co-sharing & co-repost
  minUrlGroupSize: 3,
  urlRarityMaxFraction: 0.5,
  minRepostGroupSize: 3,
  repostRarityMaxFraction: 0.5
};

export function getSensitivityPreset(thresholdValue) {
  const presets = {
    1: {
      semanticEnabled: true, semanticThreshold: 0.70, ngramThreshold: 0.15,
      usernameThreshold: 0.60, tfidfThreshold: 0.25, zscoreThreshold: 1.0,
      burstPosts: 3, rhythmCV: 0.20, nightGap: 14400, clusterSize: 3,
      crossMultiplier: 0.20, minSyncPosts: 2, minHashtagGroupSize: 3,
      minUsernameGroupSize: 3, minHighVolumePosts: 5
    },
    2: {
      semanticEnabled: true, semanticThreshold: 0.75, ngramThreshold: 0.20,
      usernameThreshold: 0.70, tfidfThreshold: 0.35, zscoreThreshold: 1.5,
      burstPosts: 4, rhythmCV: 0.15, nightGap: 10800, clusterSize: 4,
      crossMultiplier: 0.25, minSyncPosts: 2, minHashtagGroupSize: 3,
      minUsernameGroupSize: 3, minHighVolumePosts: 5
    },
    3: {
      semanticEnabled: true, semanticThreshold: 0.78, ngramThreshold: 0.22,
      usernameThreshold: 0.75, tfidfThreshold: 0.40, zscoreThreshold: 1.7,
      burstPosts: 4, rhythmCV: 0.12, nightGap: 9000, clusterSize: 4,
      crossMultiplier: 0.25, minSyncPosts: 2, minHashtagGroupSize: 3,
      minUsernameGroupSize: 3, minHighVolumePosts: 5
    },
    4: {
      semanticEnabled: true, semanticThreshold: 0.82, ngramThreshold: 0.25,
      usernameThreshold: 0.77, tfidfThreshold: 0.45, zscoreThreshold: 1.8,
      burstPosts: 4, rhythmCV: 0.11, nightGap: 7800, clusterSize: 4,
      crossMultiplier: 0.27, minSyncPosts: 2, minHashtagGroupSize: 3,
      minUsernameGroupSize: 3, minHighVolumePosts: 5
    },
    5: {
      semanticEnabled: true, semanticThreshold: 0.85, ngramThreshold: 0.30,
      usernameThreshold: 0.80, tfidfThreshold: 0.50, zscoreThreshold: 2.0,
      burstPosts: 5, rhythmCV: 0.10, nightGap: 7200, clusterSize: 5,
      crossMultiplier: 0.30, minSyncPosts: 2, minHashtagGroupSize: 3,
      minUsernameGroupSize: 3, minHighVolumePosts: 5
    },
    6: {
      semanticEnabled: true, semanticThreshold: 0.87, ngramThreshold: 0.35,
      usernameThreshold: 0.83, tfidfThreshold: 0.55, zscoreThreshold: 2.2,
      burstPosts: 5, rhythmCV: 0.09, nightGap: 6600, clusterSize: 5,
      crossMultiplier: 0.32, minSyncPosts: 2, minHashtagGroupSize: 3,
      minUsernameGroupSize: 3, minHighVolumePosts: 5
    },
    7: {
      semanticEnabled: true, semanticThreshold: 0.89, ngramThreshold: 0.40,
      usernameThreshold: 0.85, tfidfThreshold: 0.60, zscoreThreshold: 2.5,
      burstPosts: 6, rhythmCV: 0.08, nightGap: 6000, clusterSize: 6,
      crossMultiplier: 0.35, minSyncPosts: 2, minHashtagGroupSize: 3,
      minUsernameGroupSize: 3, minHighVolumePosts: 6
    },
    8: {
      semanticEnabled: true, semanticThreshold: 0.91, ngramThreshold: 0.45,
      usernameThreshold: 0.88, tfidfThreshold: 0.70, zscoreThreshold: 2.8,
      burstPosts: 7, rhythmCV: 0.07, nightGap: 5400, clusterSize: 6,
      crossMultiplier: 0.38, minSyncPosts: 3, minHashtagGroupSize: 5,
      minUsernameGroupSize: 4, minHighVolumePosts: 8
    },
    9: {
      semanticEnabled: true, semanticThreshold: 0.93, ngramThreshold: 0.50,
      usernameThreshold: 0.90, tfidfThreshold: 0.80, zscoreThreshold: 3.2,
      burstPosts: 8, rhythmCV: 0.06, nightGap: 4800, clusterSize: 7,
      crossMultiplier: 0.42, minSyncPosts: 5, minHashtagGroupSize: 7,
      minUsernameGroupSize: 6, minHighVolumePosts: 12
    },
    10: {
      semanticEnabled: true, semanticThreshold: 0.95, ngramThreshold: 0.60,
      usernameThreshold: 0.93, tfidfThreshold: 1.00, zscoreThreshold: 3.5,
      burstPosts: 9, rhythmCV: 0.05, nightGap: 3600, clusterSize: 8,
      crossMultiplier: 0.45, minSyncPosts: 10, minHashtagGroupSize: 15,
      minUsernameGroupSize: 12, minHighVolumePosts: 25
    }
  };

  return presets[thresholdValue] || presets[5];
}

export function applySensitivityPreset(thresholdValue) {
  const preset = getSensitivityPreset(thresholdValue);

  document.getElementById('param-semantic-enabled').value = preset.semanticEnabled.toString();
  document.getElementById('param-semantic-threshold').value = preset.semanticThreshold;
  document.getElementById('param-ngram-threshold').value = preset.ngramThreshold;
  document.getElementById('param-username-threshold').value = preset.usernameThreshold;
  document.getElementById('param-tfidf-threshold').value = preset.tfidfThreshold;
  document.getElementById('param-zscore-threshold').value = preset.zscoreThreshold;
  document.getElementById('param-burst-posts').value = preset.burstPosts;
  document.getElementById('param-rhythm-cv').value = preset.rhythmCV;
  document.getElementById('param-night-gap').value = preset.nightGap;
  document.getElementById('param-cluster-size').value = preset.clusterSize;
  document.getElementById('param-cross-multiplier').value = preset.crossMultiplier;
  document.getElementById('param-min-sync-posts').value = preset.minSyncPosts;
  document.getElementById('param-min-hashtag-group').value = preset.minHashtagGroupSize;
  document.getElementById('param-min-username-group').value = preset.minUsernameGroupSize;
  document.getElementById('param-min-highvolume-posts').value = preset.minHighVolumePosts;

  // Session 5 — derive URL/repost thresholds from the preset's strictness:
  // reuse the hashtag group size, and tighten the rarity ceiling as strictness rises.
  const urlEl = document.getElementById('param-min-url-group');
  const repostEl = document.getElementById('param-min-repost-group');
  const urlRarityEl = document.getElementById('param-url-rarity');
  const repostRarityEl = document.getElementById('param-repost-rarity');
  const rarityCeiling = Math.max(0.2, 0.6 - (thresholdValue - 1) * 0.04); // 0.6 → ~0.24
  if (urlEl) urlEl.value = preset.minHashtagGroupSize;
  if (repostEl) repostEl.value = preset.minHashtagGroupSize;
  if (urlRarityEl) urlRarityEl.value = rarityCeiling.toFixed(2);
  if (repostRarityEl) repostRarityEl.value = rarityCeiling.toFixed(2);

  const presetIndicator = document.getElementById('sensitivity-preset-indicator');
  if (presetIndicator) {
    presetIndicator.textContent = `Current preset: ${thresholdLabels[thresholdValue]}`;
  }
}

export function getCibParams() {
  return {
    semanticEnabled: document.getElementById('param-semantic-enabled')?.value === 'true',
    semanticThreshold: parseFloat(document.getElementById('param-semantic-threshold')?.value || defaultCibParams.semanticThreshold),
    ngramThreshold: parseFloat(document.getElementById('param-ngram-threshold')?.value || defaultCibParams.ngramThreshold),
    usernameThreshold: parseFloat(document.getElementById('param-username-threshold')?.value || defaultCibParams.usernameThreshold),
    tfidfThreshold: parseFloat(document.getElementById('param-tfidf-threshold')?.value || defaultCibParams.tfidfThreshold),
    zscoreThreshold: parseFloat(document.getElementById('param-zscore-threshold')?.value || defaultCibParams.zscoreThreshold),
    burstPosts: parseInt(document.getElementById('param-burst-posts')?.value || defaultCibParams.burstPosts),
    rhythmCV: parseFloat(document.getElementById('param-rhythm-cv')?.value || defaultCibParams.rhythmCV),
    nightGap: parseInt(document.getElementById('param-night-gap')?.value || defaultCibParams.nightGap),
    clusterSize: parseInt(document.getElementById('param-cluster-size')?.value || defaultCibParams.clusterSize),
    crossMultiplier: parseFloat(document.getElementById('param-cross-multiplier')?.value || defaultCibParams.crossMultiplier),
    minSyncPosts: parseInt(document.getElementById('param-min-sync-posts')?.value || defaultCibParams.minSyncPosts),
    minHashtagGroupSize: parseInt(document.getElementById('param-min-hashtag-group')?.value || defaultCibParams.minHashtagGroupSize),
    minUsernameGroupSize: parseInt(document.getElementById('param-min-username-group')?.value || defaultCibParams.minUsernameGroupSize),
    minHighVolumePosts: parseInt(document.getElementById('param-min-highvolume-posts')?.value || defaultCibParams.minHighVolumePosts),
    minUrlGroupSize: parseInt(document.getElementById('param-min-url-group')?.value || defaultCibParams.minUrlGroupSize),
    urlRarityMaxFraction: parseFloat(document.getElementById('param-url-rarity')?.value || defaultCibParams.urlRarityMaxFraction),
    minRepostGroupSize: parseInt(document.getElementById('param-min-repost-group')?.value || defaultCibParams.minRepostGroupSize),
    repostRarityMaxFraction: parseFloat(document.getElementById('param-repost-rarity')?.value || defaultCibParams.repostRarityMaxFraction)
  };
}

export function resetCibParams() {
  const currentThreshold = parseInt(document.getElementById('cib-threshold').value, 10);
  applySensitivityPreset(currentThreshold);
}

export async function detectCIB() {
  const loading = document.getElementById('loading');
  const loadingText = document.getElementById('loading-text');
  const timeWindowInput = document.getElementById('time-window');
  const exportCsvBtn = document.getElementById('export-csv-btn');
  const exportReportBtn = document.getElementById('export-report-btn');
  const statSuspicious = document.getElementById('stat-suspicious');

  if (!graphData || graphData.nodes.length === 0) return;

  // If a previous run is still "pending", check how old it is. If it's older than
  // PENDING_MAX_AGE_MS the worker probably died and the Promise is hanging forever.
  if (pendingCibPromise) {
    const age = Date.now() - pendingSince;
    if (age < PENDING_MAX_AGE_MS) {
      console.log('CIB detection already in progress, returning existing promise');
      return pendingCibPromise;
    }
    console.warn(`⚠️ Previous CIB detection appears stuck (age: ${age}ms). Starting fresh.`);
    pendingCibPromise = null;
    pendingSince = 0;
  }

  if (loading) loading.classList.add('active');
  if (loadingText) loadingText.textContent = 'Initializing CIB detection...';

  const params = getCibParams();
  const timeWindow = parseInt(timeWindowInput?.value, 10);

  // Ensure we can still build transferable payloads after project restore/fallback paths.
  if (
    columnarDataIndex &&
    columnarDataIndex.length === rawData.length &&
    (!filteredIndices || filteredIndices.length !== filteredData.length)
  ) {
    const rawIndexLookup = new Map();
    for (let i = 0; i < rawData.length; i++) {
      const key = getPostKey(rawData[i]);
      if (!rawIndexLookup.has(key)) {
        rawIndexLookup.set(key, i);
      }
    }

    const remapped = new Uint32Array(filteredData.length);
    let remapOk = true;
    for (let i = 0; i < filteredData.length; i++) {
      const idx = rawIndexLookup.get(getPostKey(filteredData[i]));
      if (idx === undefined) {
        remapOk = false;
        break;
      }
      remapped[i] = idx;
    }

    setFilteredIndices(remapOk ? remapped : null);
  }

  // The heavy work runs in the worker, so the tab no longer needs the old
  // setInterval heartbeat / silent-AudioContext keepalive hacks to stay warm.

  // Get or create a healthy worker
  let worker;
  try {
    worker = await cibManager.ensureWorker();
  } catch (err) {
    console.error('Failed to create CIB worker:', err);
    if (loading) loading.classList.remove('active');
    if (loadingText) loadingText.textContent = 'Failed to start CIB worker';
    throw err;
  }

  const callId = ++currentCallId;
  pendingSince = Date.now();
  let timeoutId = null;
  const cancelBtn = document.getElementById('cancel-cib-btn');
  let cancelHandler = null;

  pendingCibPromise = new Promise((resolve, reject) => {
    saveCheckpoint('CIB Detection', 0, { stage: 'Initializing CIB detection...' }, { includeData: true });

    let settled = false;

    // Cancel button: terminate the worker and clean up quietly.
    cancelHandler = () => {
      if (settled) return;
      settled = true;
      console.warn('🛑 CIB detection cancelled by user');
      cibManager.terminate();
      worker.removeEventListener('message', messageHandler);
      if (loading) loading.classList.remove('active');
      if (loadingText) loadingText.textContent = 'CIB detection cancelled.';
      clearCheckpoint().catch(() => { });
      resolve('cancelled');
    };
    if (cancelBtn) {
      cancelBtn.style.display = 'inline-block';
      cancelBtn.addEventListener('click', cancelHandler);
    }

    const messageHandler = async (e) => {
      const { type, progress, message, result, error } = e.data;
      if (settled && (type === 'complete' || type === 'error')) return;

      if (type === 'progress') {
        if (loadingText) loadingText.textContent = message;
        if (progress % 10 === 0) {
          saveCheckpoint('CIB Detection', progress, { stage: message }, { includeData: false });
        }
      } else if (type === 'complete') {
        if (loadingText) loadingText.textContent = 'Finalizing results...';

        setCibDetection({
          suspiciousUsers: new Set(result.suspiciousUsers),
          indicators: result.indicators,
          userScores: new Map(result.userScores),
          userReasons: new Map(result.userReasons)
        });

        if (result.coordinationGraph) {
          setCoordinationGraph(result.coordinationGraph);
          const coordOption = document.querySelector('#network-type option[value="coordinationNetwork"]');
          if (coordOption) coordOption.disabled = false;
        }

        if (result.embeddings && result.embeddings.length > 0) {
          console.log(`📥 Received ${result.embeddings.length} embeddings from worker`);
          const cacheKey = embeddingsCache.getKey(filteredData, params);
          embeddingsCache.set(cacheKey, new Map(result.embeddings));
        }

        if (statSuspicious) statSuspicious.textContent = cibDetection.suspiciousUsers.size;

        displayCIBResults(cibDetection);

        const normalizeForCib = (id) => String(id ?? '').replace(/^u_/, '').replace(/^user_/, '');
        const suspiciousByNormalized = new Map();
        cibDetection.suspiciousUsers.forEach((uid) => {
          suspiciousByNormalized.set(normalizeForCib(uid), uid);
        });

        nodes.forEach(node => {
          const matchedUserId = suspiciousByNormalized.get(normalizeForCib(node.id));
          if (matchedUserId) {
            node.suspicious = true;
            node.cibScore = cibDetection.userScores.get(matchedUserId) || 0;
            node.cibReasons = cibDetection.userReasons.get(matchedUserId) || [];
          } else {
            node.suspicious = false;
            node.cibScore = 0;
            node.cibReasons = [];
          }
        });

        if (vizManager) {
          vizManager.setMode('risk');
          const vizModeSelect = document.getElementById('viz-mode');
          if (vizModeSelect) vizModeSelect.value = 'risk';

          vizManager.refreshStyling();
          renderLegend();
        }

        if (exportCsvBtn) exportCsvBtn.disabled = false;
        if (exportReportBtn) exportReportBtn.disabled = false;

        if (loading) loading.classList.remove('active');
        await clearCheckpoint();
        worker.removeEventListener('message', messageHandler);
        settled = true;
        resolve();

      } else if (type === 'error') {
        console.error('CIB Worker Error:', error);
        toast('CIB Detection failed: ' + error, { type: 'error' });
        if (loading) loading.classList.remove('active');
        worker.removeEventListener('message', messageHandler);
        settled = true;
        reject(new Error(error));
      } else if (type === 'log') {
        console.log('Worker:', message);
      }
    };

    worker.addEventListener('message', messageHandler);

    // Hard timeout: if the worker doesn't finish in 15 minutes, force-reject.
    // This is the safety net that prevents the UI from hanging forever when
    // Chrome kills the worker in a background tab.
    timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error('⏱️ CIB detection timed out after 15 minutes — worker may have been killed');
      cibManager.markUnhealthy();
      worker.removeEventListener('message', messageHandler);
      if (loading) loading.classList.remove('active');
      if (loadingText) loadingText.textContent = 'CIB detection timed out. Please try again.';
      reject(new Error('CIB detection timed out after 15 minutes'));
    }, CIB_TIMEOUT_MS);

    const packedPayload = (columnarDataIndex && filteredIndices && filteredIndices.length)
      ? buildCibTransferPayload(columnarDataIndex, filteredIndices)
      : null;

    if (packedPayload) {
      worker.postMessage({
        type: 'detectCIBColumnar',
        payload: packedPayload.payload,
        params,
        timeWindow
      }, packedPayload.transferables);
    } else {
      worker.postMessage({
        type: 'detectCIB',
        data: filteredData,
        params,
        timeWindow
      });
    }
  });

  try {
    await pendingCibPromise;
  } finally {
    pendingCibPromise = null;
    pendingSince = 0;
    if (cancelBtn) {
      cancelBtn.style.display = 'none';
      if (cancelHandler) cancelBtn.removeEventListener('click', cancelHandler);
    }
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export function displayCIBResults(results) {
  const params = getCibParams();
  const cibResults = document.getElementById('cib-results');
  const cibPanel = document.getElementById('cib-panel');
  if (!cibResults || !cibPanel) return;

  let html = '<ul class="metrics-list">';
  html += `<li><span class="metric-name">Suspicious Accounts</span><span class="metric-value cib-score">${results.suspiciousUsers.size}</span></li>`;
  html += `<li><span class="metric-name">Synchronized Posting</span><span class="metric-value">${results.indicators.synchronized} pairs</span></li>`;
  html += `<li><span class="metric-name">Rare Hashtag Combos</span><span class="metric-value">${results.indicators.identicalHashtags} users</span></li>`;
  html += `<li><span class="metric-name">Similar Usernames</span><span class="metric-value">${results.indicators.similarUsernames} users</span></li>`;
  html += `<li><span class="metric-name">High Volume Posting</span><span class="metric-value">${results.indicators.highVolume} users</span></li>`;

  if (results.indicators.semanticDuplicates > 0) {
    html += `<li><span class="metric-name">🤖 Semantic Duplicates</span><span class="metric-value">${results.indicators.semanticDuplicates} pairs</span></li>`;
  } else if (!params.semanticEnabled) {
    html += `<li><span class="metric-name">🤖 Semantic Duplicates</span><span class="metric-value" style="color: #9ca3af;">disabled</span></li>`;
  }

  if (results.indicators.temporalBursts) {
    html += `<li><span class="metric-name">Posting Bursts</span><span class="metric-value">${results.indicators.temporalBursts} users</span></li>`;
  }
  if (results.indicators.templateCaptions) {
    html += `<li><span class="metric-name">Template Captions</span><span class="metric-value">${results.indicators.templateCaptions} pairs</span></li>`;
  }
  if (results.indicators.accountCreationClusters) {
    html += `<li><span class="metric-name">Account Creation Clusters</span><span class="metric-value">${results.indicators.accountCreationClusters} clusters</span></li>`;
  }
  // Session 5: URL co-sharing — show coverage honestly when absent
  if (results.indicators.urlCoverage > 0) {
    html += `<li><span class="metric-name">🔗 URL Co-sharing</span><span class="metric-value">${results.indicators.urlCoshare || 0} rare links</span></li>`;
  } else if (results.indicators.urlCoverage === 0) {
    html += `<li><span class="metric-name">🔗 URL Co-sharing</span><span class="metric-value" style="color:#9ca3af;">no URLs in data</span></li>`;
  }
  // Session 5: Co-repost / amplification
  if (results.indicators.repostCoverage > 0) {
    html += `<li><span class="metric-name">🔁 Co-repost</span><span class="metric-value">${results.indicators.repost || 0} shared targets</span></li>`;
  } else if (results.indicators.repostCoverage === 0) {
    html += `<li><span class="metric-name">🔁 Co-repost</span><span class="metric-value" style="color:#9ca3af;">not in this data</span></li>`;
  }

  if (coordinationGraph) {
    const connectedComps = coordinationGraph.components?.filter(c => c.length > 1).length ?? 0;
    html += `<li><span class="metric-name">🔗 Coord. clusters</span><span class="metric-value" style="font-weight:700;">${connectedComps}</span></li>`;
  }

  html += '</ul>';

  if (coordinationGraph) {
    html += `<div style="margin-top:0.75rem; text-align:center;">
      <button id="view-coord-network-btn" style="background:#dc2626; color:white; border:none; padding:.4rem .9rem; border-radius:6px; cursor:pointer; font-size:0.8rem; font-weight:600;">🔗 View Coordination Network</button>
    </div>`;
  }

  cibResults.innerHTML = html;
  cibPanel.style.display = 'block';

  setTimeout(() => {
    const btn = document.getElementById('view-coord-network-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        const sel = document.getElementById('network-type');
        if (sel) {
          sel.value = 'coordinationNetwork';
          sel.dispatchEvent(new Event('change'));
        }
      });
    }
  }, 0);
}
