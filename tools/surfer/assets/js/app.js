import { normalizeRawData } from './normalization.js';
import { safeMax, safeMin, escapeHtml, escapeAttr, getPostKey } from './utils.js';
import {
  filterData,
} from './analytics.js';
import {
  networkMetricsCache,
  communityDetectionCache,
  embeddingsCache,
  ProgressiveFileLoader,
  buildColumnarIndex,
  filterColumnarIndices,
  materializePostsByIndices,
  buildCibTransferPayload,

  perfMonitor
} from './performance-utils.js';
import {
  extractMentionNetwork,
  extractCoHashtagNetwork,
  extractUserHashtagNetwork,
  extractHashtagNetwork,
  extractPhotoTagNetwork,
  extractLocationNetwork,
  extractUrlCoshareNetwork,
  extractRepostNetwork
} from './network-extraction.js';
import { generateInvestigationReport, generateCSVReport } from './report-generator.js';
import { VisualizationManager, NODE_TYPE_COLORS, communityColors } from './visualization.js';
import { calculateNetworkMetrics, detectCommunities } from './community-detection.js';
import { postEngagement, normalizeUserIdentifier, safeExternalUrl, postMatchesNode } from './post-utils.js';
import {
  rawData, filteredData, columnarDataIndex, filteredIndices,
  graphData, nodes, communities, cibDetection, networkMetrics,
  vizManager, isRestoring, idToNode, adjacency, hoveredNode,
  comparisonState, csvData, csvMapping, coordinationGraph,
  setCsvData, setCsvMapping,
  setRawData, setFilteredData, setColumnarDataIndex, setFilteredIndices,
  setGraphData, setNodes, setCommunities, setCibDetection, setNetworkMetrics,
  setVizManager, setIsRestoring, setIdToNode, setAdjacency, setHoveredNode,
  setCoordinationGraph
} from './state.js';
import {
  parseTimestamp,
  convertCSVToUnified,
  calculateStatsChunked,
  sanitizeForJSON,
  sanitizeGraphData,
  saveCheckpoint,
  clearCheckpoint,
  getCheckpoint,
  buildProjectParts,
  decodeProjectEmbeddings,
  emergencySaveAsCSV
} from './data-loader.js';
import {
  thresholdLabels,
  defaultCibParams,
  getSensitivityPreset,
  applySensitivityPreset,
  getCibParams,
  resetCibParams,
  displayCIBResults,
  detectCIB
} from './cib-controller.js';
import { updateStatCards, updateCoach, renderLegend, gatherPostsForNode, samplePostsForNode, getAllPostsForNode, renderPostHTML, openNodeModal, showNodeInfo, initModalListeners, displayMetrics } from './ui-controller.js';
import { TableView } from './table-view.js';
import { TimelineView } from './timeline-view.js';
import { generateCoordinatedCluster, buildDetectionReportCard, DETECTOR_LABELS } from './synthetic-injection.js';
import { toast, confirmDialog } from './notifications.js';
// The Graph renderer lives in visualization.js, which imports the vendored
// cosmos.gl bundle (assets/js/vendor/) — no runtime CDN fetch.

// CIB Worker is now managed internally by cib-controller.js (created on demand,
// health-checked via ping/pong, and recreated if Chrome kills it).

// =========================
// Global state (imported from state.js)
// =========================

function refreshColumnarDataIndex(dataset, contextLabel = 'dataset') {
  if (!Array.isArray(dataset) || dataset.length === 0) {
    setColumnarDataIndex(null);
    setFilteredIndices(null);
    return;
  }

  perfMonitor.start('columnarIndexBuild');
  setColumnarDataIndex(buildColumnarIndex(dataset));
  setFilteredIndices(null);
  const duration = perfMonitor.end('columnarIndexBuild');

  console.log(
    `✓ Columnar index built for ${contextLabel}: ${columnarDataIndex.length} posts, ` +
    `${columnarDataIndex.authorDict.length} unique authors, ` +
    `${columnarDataIndex.hashtagDict.length} unique hashtags (${duration.toFixed(2)}ms)`
  );
}

// Hover & modal helpers / indexes (imported from state.js)

function buildAdjacency(network) {
  setAdjacency(new Map());
  if (!network || !Array.isArray(network.nodes)) return;

  const ensureEntry = (id) => {
    if (id === undefined || id === null) return null;
    const key = id;
    if (!adjacency.has(key)) {
      adjacency.set(key, new Set());
    }
    return key;
  };

  network.nodes.forEach(node => {
    ensureEntry(node?.id);
  });

  if (!Array.isArray(network.links)) return;

  network.links.forEach(link => {
    const sourceId = ensureEntry(link?.source?.id ?? link?.source);
    const targetId = ensureEntry(link?.target?.id ?? link?.target);
    if (sourceId === null || targetId === null || sourceId === targetId) return;

    adjacency.get(sourceId)?.add(targetId);
    adjacency.get(targetId)?.add(sourceId);
  });
}

// =========================
// DOM elements
// =========================
const fileInput = document.getElementById('file-input');
const networkTypeSelect = document.getElementById('network-type');
const nodeSizeBySelect = document.getElementById('node-size-by');
const engagementFilter = document.getElementById('engagement-filter');
const engagementValue = document.getElementById('engagement-value');
const cibThreshold = document.getElementById('cib-threshold');
const thresholdValue = document.getElementById('threshold-value');
const timeWindowInput = document.getElementById('time-window');
const timeWindowValue = document.getElementById('time-window-value');
const dateStart = document.getElementById('date-start');
const dateEnd = document.getElementById('date-end');
const searchInput = document.getElementById('search-input');
const exportBtn = document.getElementById('export-btn');
const exportCsvBtn = document.getElementById('export-csv-btn');
const exportReportBtn = document.getElementById('export-report-btn');
const detectBtn = document.getElementById('detect-btn');
const cibBtn = document.getElementById('cib-btn');
const cibSettingsBtn = document.getElementById('cib-settings-btn');
const cibSettingsPanel = document.getElementById('cib-settings-panel');
const closeCibSettings = document.getElementById('close-cib-settings');
const resetCibParamsBtn = document.getElementById('reset-cib-params');
const graphContainer = document.getElementById('network-canvas');

// Initialize Visualization Manager
setVizManager(new VisualizationManager(graphContainer, {
  tooltipElement: document.getElementById('node-tooltip'),
  onNodeClick: (node) => {
    showNodeInfo(node);
    openNodeModal(node);
  },
  onBackgroundClick: () => {
    // Clear search if needed, or just let search handler handle it
  },
  nodeSizeMode: document.getElementById('node-size-by')?.value || 'degree'
}));

initModalListeners();

// =========================
// Node table view (Session 4): accessible/sortable counterpart to the canvas.
// =========================
const tableView = new TableView(document.getElementById('table-view'), {
  onRowClick: (node) => {
    showNodeInfo(node);
    openNodeModal(node);
  },
});

// Resolve a node's community to a human label for the table's Community column.
function communityNameFor(node) {
  if (!communities || !communities.communities) return '—';
  const cid = communities.communities.get(node.id);
  if (cid === undefined || cid === communities.noiseClusterId || cid === 0) return '—';
  return communities.names?.get(cid) || `Cluster ${cid}`;
}

function refreshTableView() {
  if (!vizManager) return;
  tableView.setNodes(vizManager.getNodes(), communityNameFor);
}

// Only rebuild the (potentially large) table when it is actually on screen.
function refreshTableViewIfVisible() {
  if (tableView.isVisible()) refreshTableView();
}

(function wireViewToggle() {
  const graphBtn = document.getElementById('view-graph-btn');
  const tableBtn = document.getElementById('view-table-btn');
  const tableEl = document.getElementById('table-view');
  const canvasEl = document.getElementById('network-canvas');
  if (!graphBtn || !tableBtn || !tableEl) return;

  function showTable(show) {
    tableEl.hidden = !show;
    canvasEl.style.visibility = show ? 'hidden' : 'visible';
    tableBtn.classList.toggle('active', show);
    graphBtn.classList.toggle('active', !show);
    tableBtn.setAttribute('aria-pressed', String(show));
    graphBtn.setAttribute('aria-pressed', String(!show));
    if (show) {
      refreshTableView();
      tableView.focus();
    } else if (vizManager) {
      vizManager.resize();
    }
  }
  tableBtn.addEventListener('click', () => showTable(true));
  graphBtn.addEventListener('click', () => showTable(false));
})();

// =========================
// Timeline view (Session 6): post-volume histogram + drag-to-brush filtering.
// =========================
const timelineView = new TimelineView(document.getElementById('timeline-body'), {
  onBrush: (range) => {
    if (!range) {
      // Click without drag → clear the date filter entirely.
      dateStart.value = '';
      dateEnd.value = '';
    } else {
      dateStart.value = new Date(range.startSec * 1000).toISOString().split('T')[0];
      dateEnd.value = new Date(range.endSec * 1000).toISOString().split('T')[0];
    }
    updateNetwork();
  },
});

// Build a per-post "author is suspicious" mask aligned to the columnar index.
function buildFlaggedMask() {
  if (!columnarDataIndex || !cibDetection?.suspiciousUsers) return null;
  const normalizeForCib = (id) => String(id ?? '').replace(/^u_/, '').replace(/^user_/, '');
  const suspicious = new Set();
  cibDetection.suspiciousUsers.forEach(uid => suspicious.add(normalizeForCib(uid)));
  const { authorIndices, authorDict, length } = columnarDataIndex;
  const mask = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const ai = authorIndices[i];
    if (ai >= 0 && suspicious.has(normalizeForCib(authorDict[ai]))) mask[i] = 1;
  }
  return mask;
}

function refreshTimeline() {
  if (!columnarDataIndex || !columnarDataIndex.length) {
    timelineView.setData({ timestamps: null });
    return;
  }
  timelineView.setData({
    timestamps: columnarDataIndex.timestamps,
    flaggedMask: buildFlaggedMask(),
  });
  // Reflect the current date filter as the brush.
  const s = dateStart.value ? new Date(dateStart.value).getTime() / 1000 : null;
  const e = dateEnd.value ? (new Date(dateEnd.value).getTime() / 1000) + 86399 : null;
  if (s != null || e != null) timelineView.setBrushRange(s, e);
  else timelineView.setBrushRange(null, null);
}

// Collapse / expand the timeline strip.
(function wireTimelineCollapse() {
  const strip = document.getElementById('timeline-strip');
  const btn = document.getElementById('timeline-collapse');
  if (!strip || !btn) return;
  btn.addEventListener('click', () => {
    const collapsed = strip.classList.toggle('collapsed');
    btn.setAttribute('aria-expanded', String(!collapsed));
    if (!collapsed) requestAnimationFrame(() => timelineView.render());
  });
})();

// =========================
// Theme (Session 8): light/dark with persistence + canvas follow.
// =========================
(function wireTheme() {
  const STORAGE_KEY = 'schuimsurfer-theme';
  const toggle = document.getElementById('theme-toggle');
  const icon = document.getElementById('theme-toggle-icon');
  const label = document.getElementById('theme-toggle-label');

  function apply(theme) {
    document.documentElement.dataset.theme = theme;
    const dark = theme === 'dark';
    if (icon) icon.textContent = dark ? '☀️' : '🌙';
    if (label) label.textContent = dark ? 'Light' : 'Dark';
    if (toggle) toggle.setAttribute('aria-pressed', String(dark));
    vizManager?.applyTheme?.();
  }

  const saved = localStorage.getItem(STORAGE_KEY);
  const initial = saved || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  apply(initial);

  toggle?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(STORAGE_KEY, next);
    apply(next);
  });
})();

// Persist collapsible sidebar <details class="sidebar-section"> open state.
(function wireSidebarSections() {
  document.querySelectorAll('details.sidebar-section[id]').forEach(section => {
    const key = `schuimsurfer-section-${section.id}`;
    const saved = localStorage.getItem(key);
    if (saved === 'open') section.open = true;
    else if (saved === 'closed') section.open = false;
    section.addEventListener('toggle', () => {
      localStorage.setItem(key, section.open ? 'open' : 'closed');
    });
  });
})();

// =========================
// Synthetic injection validation (Session 7): plant a known coordinated cluster,
// run detection, and report which detectors caught it.
// =========================
const synInjectBtn = document.getElementById('syn-inject-btn');
let syntheticAccountIds = [];
// Assigned to the real implementation inside wireSyntheticInjection(); a normal
// CIB run calls this so the report card refreshes when a plant is present.
let renderSyntheticReport = () => {};

function syntheticDataPresent() {
  return Array.isArray(rawData) && rawData.some(p => p?.synthetic);
}

(function wireSyntheticInjection() {
  const toggleBtn = document.getElementById('synthetic-toggle-btn');
  const optionsEl = document.getElementById('synthetic-options');
  const banner = document.getElementById('synthetic-banner');
  const countEl = document.getElementById('syn-count');
  const removeBtn = document.getElementById('syn-remove-btn');
  const reportEl = document.getElementById('synthetic-report');
  if (!toggleBtn) return;

  toggleBtn.addEventListener('click', () => {
    optionsEl.style.display = optionsEl.style.display === 'none' ? 'block' : 'none';
  });

  function updateBanner() {
    const count = (rawData || []).filter(p => p?.synthetic).length;
    banner.style.display = count > 0 ? 'block' : 'none';
    if (count > 0) countEl.textContent = count.toLocaleString();
  }

  function renderReport() {
    if (!cibDetection || syntheticAccountIds.length === 0) { reportEl.innerHTML = ''; return; }
    const card = buildDetectionReportCard(syntheticAccountIds, {
      suspiciousUsers: cibDetection.suspiciousUsers,
      userReasons: cibDetection.userReasons,
    });
    const hits = Object.entries(card.detectorHits).sort((a, b) => b[1] - a[1]);
    const esc = (s) => { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; };
    reportEl.innerHTML = `
      <div style="border:1px solid #e5e7eb; border-radius:8px; padding:0.6rem; font-size:0.75rem; margin-top:0.5rem;">
        <div style="font-weight:700; margin-bottom:0.35rem;">🧪 Detection report card</div>
        <div>Planted accounts caught: <strong>${card.plantedCaughtCount}/${card.totalPlanted}</strong></div>
        <div style="color:#6b7280; margin:0.25rem 0;">Organic accounts also flagged: ${card.organicFlaggedCount}</div>
        <div style="margin-top:0.35rem; font-weight:600;">Detectors that fired:</div>
        <ul style="margin:0.25rem 0 0; padding-left:1rem;">
          ${hits.length ? hits.map(([k, n]) => `<li>${esc(DETECTOR_LABELS[k] || k)}: ${n}/${card.totalPlanted}</li>`).join('') : '<li style="color:#9ca3af;">none</li>'}
        </ul>
      </div>`;
  }
  // Exposed so a normal CIB run also refreshes the card when a plant is present.
  renderSyntheticReport = renderReport;

  synInjectBtn?.addEventListener('click', async () => {
    if (syntheticDataPresent()) {
      toast('Synthetic data is already present. Remove it before injecting a new cluster.');
      return;
    }
    const size = Math.max(2, parseInt(document.getElementById('syn-size').value || '6', 10));
    const postsPerAccount = Math.max(2, parseInt(document.getElementById('syn-posts').value || '8', 10));
    const captionStrategy = document.getElementById('syn-caption').value;

    // Anchor the plant near the end of the dataset's time range when possible.
    let baseTime = 1_700_000_000;
    const ts = columnarDataIndex?.timestamps;
    if (ts && ts.length) {
      let mx = 0;
      for (let i = 0; i < ts.length; i++) if (ts[i] > mx) mx = ts[i];
      if (mx > 0) baseTime = mx - postsPerAccount * 3600;
    }

    const { posts, accountIds } = generateCoordinatedCluster({
      size, postsPerAccount, captionStrategy, baseTime, seed: (Date.now() & 0xffff) || 1,
    });
    syntheticAccountIds = accountIds;

    loading.classList.add('active');
    loadingText.textContent = `Injecting ${posts.length} synthetic posts...`;
    setRawData([...(rawData || []), ...posts]);
    refreshColumnarDataIndex(rawData, 'with synthetic plant');
    updateStatCards(await calculateStatsChunked(rawData, (m) => loadingText.textContent = m));
    await updateNetwork();
    updateBanner();
    await detectCIB().catch(() => {});
    refreshTimeline();
    renderReport();
    loading.classList.remove('active');
  });

  removeBtn?.addEventListener('click', async () => {
    loading.classList.add('active');
    loadingText.textContent = 'Removing synthetic data...';
    setRawData((rawData || []).filter(p => !p?.synthetic));
    syntheticAccountIds = [];
    refreshColumnarDataIndex(rawData, 'after synthetic removal');
    updateStatCards(await calculateStatsChunked(rawData, (m) => loadingText.textContent = m));
    await updateNetwork();
    updateBanner();
    reportEl.innerHTML = '';
    refreshTimeline();
    loading.classList.remove('active');
  });
})();

// Sync node size mode
const nodeSizeSelect = document.getElementById('node-size-by');
if (nodeSizeSelect) {
  nodeSizeSelect.addEventListener('change', (e) => {
    vizManager.config.nodeSizeMode = e.target.value;
    vizManager.refreshStyling({ updateClusters: false });
  });
}

const emptyState = document.getElementById('empty-state');
const statsDiv = document.getElementById('stats');
const nodeInfo = document.getElementById('node-info');
const nodeDetails = document.getElementById('node-details');
const closeInfo = document.getElementById('close-info');
const loading = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const metricsPanel = document.getElementById('metrics-panel');
const metricsList = document.getElementById('metrics-list');
const cibPanel = document.getElementById('cib-panel');
const cibResults = document.getElementById('cib-results');
const tooltipEl = document.getElementById('node-tooltip');
const modalEl = document.getElementById('node-modal');
const modalClose = document.getElementById('modal-close');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalContentWrapper = document.getElementById('modal-content-wrapper');
const platformIndicator = document.getElementById('platform-indicator');
const renderingIndicator = document.getElementById('rendering-indicator');

const statElements = {
  posts: document.getElementById('stat-posts'),
  users: document.getElementById('stat-users'),
  hashtags: document.getElementById('stat-hashtags'),
  engagement: document.getElementById('stat-engagement'),
  nodes: document.getElementById('stat-nodes'),
  edges: document.getElementById('stat-edges'),
  density: document.getElementById('stat-density'),
  communities: document.getElementById('stat-communities'),
  suspicious: document.getElementById('stat-suspicious'),
};

// =========================
// UI constants (communityColors imported from visualization.js)
// =========================


cibThreshold.addEventListener('input', (e) => {
  const val = e.target.value;
  thresholdValue.textContent = thresholdLabels[val];
  // Apply sensitivity preset to advanced parameters
  applySensitivityPreset(parseInt(val, 10));
});

timeWindowInput.addEventListener('input', (e) => {
  const seconds = parseInt(e.target.value);
  if (seconds < 60) {
    timeWindowValue.textContent = `${seconds} second${seconds !== 1 ? 's' : ''}`;
  } else {
    const minutes = Math.floor(seconds / 60);
    const remainingSecs = seconds % 60;
    if (remainingSecs === 0) {
      timeWindowValue.textContent = `${minutes} minute${minutes !== 1 ? 's' : ''}`;
    } else {
      timeWindowValue.textContent = `${minutes}m ${remainingSecs}s`;
    }
  }
});

// =========================
// File upload (OPTIMIZED: Progressive loading)
// =========================

// CSV column mapping state (imported from state.js)

/**
 * Decide whether a file is actually a saved project by inspecting its CONTENT
 * rather than relying on the filename. Saved projects are produced by
 * `buildProjectParts()` and are either:
 *   - gzip-compressed (magic bytes 1f 8b), or
 *   - plain JSON that begins with `{"version":"…","metadata":{…},"data":{…}`.
 * Sniffing the bytes means renamed project files (e.g. "my-investigation.json"
 * or "case.json.gz") still load as projects instead of being misparsed.
 */
async function isProjectFileByContent(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    if (head[0] === 0x1f && head[1] === 0x8b) return true; // gzip → always a project

    const text = await file.slice(0, 512).text();
    const compact = text.replace(/\s/g, '');
    return compact.startsWith('{"version":') &&
      compact.includes('"metadata":') &&
      compact.includes('"data":');
  } catch {
    return false;
  }
}

// Detect file type and route accordingly
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const fileName = file.name.toLowerCase();
  const isCSV = fileName.endsWith('.csv');
  // Fast path by name (default save names); otherwise sniff content so that
  // renamed/compressed project files still load (see isProjectFileByContent).
  const isJSON = fileName.endsWith('.json');
  const isGz = fileName.endsWith('.gz');
  const looksLikeProjectByName = fileName.includes('schuimsurfer-project') && (isJSON || isGz);
  const isProjectFile = looksLikeProjectByName || isGz ||
    ((isJSON || isGz) ? await isProjectFileByContent(file) : false);
  const isNDJSON = fileName.endsWith('.ndjson') || isJSON;

  try {
    if (isProjectFile) {
      // Load saved project
      await loadProject(file);
    } else if (isCSV) {
      await handleCSVUpload(file);
    } else if (isNDJSON) {
      await handleNDJSONUpload(file);
    } else {
      toast('Please upload a .csv, .ndjson, or .json file', { type: 'error' });
    }
  } finally {
    // Always reset so re-selecting the same file fires the change event again.
    fileInput.value = '';
  }
});

// Handle NDJSON file upload (existing logic)
async function handleNDJSONUpload(file) {
  loading.classList.add('active');
  loadingText.textContent = 'Loading data...';

  perfMonitor.start('fileLoad');

  try {
    // Use progressive loader for better performance on large files
    const loader = new ProgressiveFileLoader(
      (progress, message) => {
        loadingText.textContent = message;
      },
      null // No per-chunk processing needed yet
    );

    const parsed = await loader.loadNDJSON(file);

    perfMonitor.end('fileLoad');
    perfMonitor.logMemory();

    loadingText.textContent = 'Normalizing data...';

    // Normalize data to handle both TikTok and Instagram
    setRawData(normalizeRawData(parsed));
    refreshColumnarDataIndex(rawData, 'NDJSON import');

    // Detect platforms
    const platformCounts = {};
    rawData.forEach(p => {
      const platform = p.platform || 'unknown';
      platformCounts[platform] = (platformCounts[platform] || 0) + 1;
    });

    const platformParts = [];
    if (platformCounts.tiktok) platformParts.push(`🎵 TikTok (${platformCounts.tiktok})`);
    if (platformCounts.instagram) platformParts.push(`📷 Instagram (${platformCounts.instagram})`);
    if (platformCounts.twitter) platformParts.push(`🐦 Twitter/X (${platformCounts.twitter})`);
    if (platformCounts.unknown) platformParts.push(`❓ Unknown (${platformCounts.unknown})`);

    const platformText = platformParts.join(' · ') || 'No data';
    platformIndicator.textContent = `· ${platformText}`;
    console.log(`Loaded ${rawData.length} posts from: ${platformText}`);

    // set date bounds from data (avoid spread operator for large datasets)
    loadingText.textContent = 'Calculating date range...';
    let minTimestamp = Infinity;
    let maxTimestamp = -Infinity;

    for (let i = 0; i < rawData.length; i++) {
      const timestamp = rawData[i]?.data?.createTime;
      if (timestamp) {
        if (timestamp < minTimestamp) minTimestamp = timestamp;
        if (timestamp > maxTimestamp) maxTimestamp = timestamp;
      }

      // Yield control more frequently for massive datasets
      if (i % 5000 === 0 && i > 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    if (minTimestamp !== Infinity) {
      const minDate = new Date(minTimestamp * 1000);
      const maxDate = new Date(maxTimestamp * 1000);
      dateStart.value = minDate.toISOString().split('T')[0];
      dateEnd.value = maxDate.toISOString().split('T')[0];
    }

    loadingText.textContent = 'Calculating statistics...';
    const statSummary = await calculateStatsChunked(rawData, (message) => {
      loadingText.textContent = message;
    });
    updateStatCards(statSummary);

    loadingText.textContent = 'Building network...';
    updateNetwork();
    refreshTimeline();
    emptyState.style.display = 'none';
    statsDiv.style.display = 'flex';
    exportBtn.disabled = false;
    detectBtn.disabled = false;
    cibBtn.disabled = false;
    cibSettingsBtn.disabled = false;
    if (synInjectBtn) synInjectBtn.disabled = false;
    if (saveProjectBtn) saveProjectBtn.disabled = false;
    // CIB export buttons enabled after CIB detection runs
  } catch (err) {
    toast('Error parsing file: ' + err.message, { type: 'error' });
  } finally {
    loading.classList.remove('active');
  }
}

// Handle CSV file upload
async function handleCSVUpload(file) {
  loading.classList.add('active');
  loadingText.textContent = 'Loading CSV file...';

  try {
    const loader = new ProgressiveFileLoader(
      (progress, message) => { loadingText.textContent = message; },
      null
    );

    setCsvData(await loader.loadCSV(file));
    loading.classList.remove('active');

    // Show column mapper modal
    showCSVMapper(csvData);
  } catch (err) {
    toast('Error parsing CSV: ' + err.message, { type: 'error' });
    loading.classList.remove('active');
    fileInput.value = ''; // Reset input
  }
}

// Show CSV column mapper modal
function showCSVMapper(data) {
  const modal = document.getElementById('csv-mapper-modal');
  const preview = document.getElementById('csv-preview');
  const mappingGrid = document.getElementById('csv-mapping-grid');

  // Show preview (first 3 rows)
  const previewRows = data.rows.slice(0, 3);
  let previewHTML = '<table style="width: 100%; border-collapse: collapse;"><thead><tr>';
  data.headers.forEach(h => {
    previewHTML += `<th style="border: 1px solid #e5e7eb; padding: 0.5rem; background: #fff; text-align: left;">${escapeHtml(h)}</th>`;
  });
  previewHTML += '</tr></thead><tbody>';
  previewRows.forEach(row => {
    previewHTML += '<tr>';
    row.forEach(cell => {
      const displayCell = cell.length > 50 ? cell.substring(0, 50) + '...' : cell;
      previewHTML += `<td style="border: 1px solid #e5e7eb; padding: 0.5rem;">${escapeHtml(displayCell)}</td>`;
    });
    previewHTML += '</tr>';
  });
  previewHTML += '</tbody></table>';
  preview.innerHTML = previewHTML;

  // Generate mapping controls
  const fieldDefinitions = [
    { key: 'authorId', label: 'Author ID *', desc: 'Unique user identifier' },
    { key: 'authorUsername', label: 'Author Username *', desc: 'Display name or handle' },
    { key: 'postId', label: 'Post ID *', desc: 'Unique post identifier' },
    { key: 'timestamp', label: 'Timestamp *', desc: 'Post creation time' },
    { key: 'text', label: 'Post Text/Caption *', desc: 'Main content' },
    { key: 'likes', label: 'Likes Count', desc: 'Number of likes' },
    { key: 'comments', label: 'Comments Count', desc: 'Number of comments' },
    { key: 'shares', label: 'Shares/Retweets', desc: 'Number of shares' },
    { key: 'views', label: 'Views/Plays', desc: 'Number of views' },
    { key: 'hashtags', label: 'Hashtags', desc: 'Comma-separated hashtags' },
    { key: 'mentions', label: 'Mentions', desc: 'Comma-separated @mentions' },
    { key: 'followers', label: 'Follower Count', desc: 'Author follower count' },
    { key: 'verified', label: 'Verified Status', desc: 'Is account verified (yes/no, true/false, 1/0)' },
    { key: 'location', label: 'Location', desc: 'Geographic location' },
    { key: 'url', label: 'Post URL', desc: 'Link to original post' }
  ];

  let mappingHTML = '';
  fieldDefinitions.forEach(field => {
    mappingHTML += `
      <div style="margin-bottom: 0.75rem;">
        <label style="display: block; font-weight: 600; margin-bottom: 0.25rem;">
          ${field.label}
        </label>
        <div style="font-size: 0.75rem; color: #6b7280; margin-bottom: 0.25rem;">
          ${field.desc}
        </div>
        <select id="csv-map-${field.key}" data-field="${field.key}" class="csv-mapping-select"
                style="width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 6px;">
          <option value="">(not mapped)</option>
          ${data.headers.map(h => `<option value="${escapeAttr(h)}">${escapeHtml(h)}</option>`).join('')}
        </select>
      </div>
    `;
  });
  mappingGrid.innerHTML = mappingHTML;

  // Auto-detect mappings
  autoDetectMappings(data.headers);

  modal.classList.add('active');
}

// Auto-detect column mappings
function autoDetectMappings(headers) {
  const patterns = {
    authorId: ['user_id', 'author_id', 'userid', 'authorid', 'user.id', 'from_id'],
    authorUsername: ['username', 'user', 'author', 'screen_name', 'handle', 'user.username', 'from_user'],
    postId: ['post_id', 'postid', 'tweet_id', 'tweetid', 'id', 'status_id', 'message_id'],
    timestamp: ['timestamp', 'created_at', 'date', 'time', 'createtime', 'posted_at', 'created'],
    text: ['text', 'content', 'caption', 'description', 'desc', 'message', 'body', 'full_text'],
    likes: ['likes', 'like_count', 'likecount', 'favorites', 'favorite_count', 'digg_count'],
    comments: ['comments', 'comment_count', 'commentcount', 'replies', 'reply_count'],
    shares: ['shares', 'share_count', 'sharecount', 'retweets', 'retweet_count'],
    views: ['views', 'view_count', 'viewcount', 'plays', 'play_count', 'playcount', 'impressions'],
    hashtags: ['hashtags', 'tags', 'hashtag', 'tag'],
    mentions: ['mentions', 'mention', 'user_mentions'],
    followers: ['followers', 'follower_count', 'followercount', 'followers_count'],
    verified: ['verified', 'is_verified', 'isverified'],
    location: ['location', 'place', 'geo', 'country', 'city'],
    url: ['url', 'link', 'permalink', 'post_url']
  };

  Object.entries(patterns).forEach(([field, patterns]) => {
    const select = document.getElementById(`csv-map-${field}`);
    if (!select) return;

    // Try to find matching header (case-insensitive)
    const match = headers.find(h =>
      patterns.some(p => h.toLowerCase().includes(p.toLowerCase()) || p.toLowerCase().includes(h.toLowerCase()))
    );

    if (match) {
      select.value = match;
    }
  });
}

// Helper to set a specific mapping (for presets)
function setMapping(field, value) {
  const select = document.getElementById(`csv-map-${field}`);
  if (select && csvData.headers.includes(value)) {
    select.value = value;
  }
}

// CSV Import button handler
document.getElementById('csv-import')?.addEventListener('click', async () => {
  // Collect mappings
  const collectedMapping = {};
  document.querySelectorAll('.csv-mapping-select').forEach(select => {
    const field = select.dataset.field;
    const column = select.value;
    if (column) {
      collectedMapping[field] = column;
    }
  });
  setCsvMapping(collectedMapping);

  // Validate required fields
  const required = ['authorId', 'authorUsername', 'postId', 'timestamp', 'text'];
  const missing = required.filter(f => !csvMapping[f]);
  if (missing.length > 0) {
    toast('Please map these required fields: ' + missing.join(', '), { type: 'error' });
    return;
  }

  // Close mapper
  document.getElementById('csv-mapper-modal').classList.remove('active');

  // Convert CSV to unified format
  loading.classList.add('active');
  loadingText.textContent = 'Converting CSV data...';

  try {
    const dateFormat = document.getElementById('csv-date-format').value;

    // Pass progress callback to show conversion progress
    setRawData(await convertCSVToUnified(csvData, csvMapping, dateFormat, (message) => {
      loadingText.textContent = message;
    }));
    refreshColumnarDataIndex(rawData, 'CSV import');

    if (rawData.length === 0) {
      throw new Error('No data was converted. Please check your column mappings.');
    }

    loadingText.textContent = 'Processing data...';

    // Set platform indicator
    platformIndicator.textContent = `· 📊 CSV Import (${rawData.length} posts)`;
    console.log(`Loaded ${rawData.length} posts from CSV`);

    // Set date bounds from data (avoid spread operator with large arrays)
    loadingText.textContent = 'Calculating date range...';
    let minTimestamp = Infinity;
    let maxTimestamp = -Infinity;

    // Iterate without creating intermediate arrays
    for (let i = 0; i < rawData.length; i++) {
      const timestamp = rawData[i]?.data?.createTime;
      if (timestamp) {
        if (timestamp < minTimestamp) minTimestamp = timestamp;
        if (timestamp > maxTimestamp) maxTimestamp = timestamp;
      }

      // Yield control more frequently for massive datasets
      if (i % 5000 === 0 && i > 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    if (minTimestamp !== Infinity) {
      const minDate = new Date(minTimestamp * 1000);
      const maxDate = new Date(maxTimestamp * 1000);
      dateStart.value = minDate.toISOString().split('T')[0];
      dateEnd.value = maxDate.toISOString().split('T')[0];
    }

    // Continue with normal flow (calculate stats without creating large intermediate arrays)
    loadingText.textContent = 'Calculating statistics...';
    const statSummary = await calculateStatsChunked(rawData, (message) => {
      loadingText.textContent = message;
    });
    updateStatCards(statSummary);

    loadingText.textContent = 'Building network...';
    updateNetwork();
    refreshTimeline();
    emptyState.style.display = 'none';
    statsDiv.style.display = 'flex';
    exportBtn.disabled = false;
    detectBtn.disabled = false;
    cibBtn.disabled = false;
    cibSettingsBtn.disabled = false;
    if (synInjectBtn) synInjectBtn.disabled = false;
    if (saveProjectBtn) saveProjectBtn.disabled = false;

    // Reset file input
    fileInput.value = '';
  } catch (err) {
    toast('Error converting CSV: ' + err.message, { type: 'error' });
    console.error('CSV conversion error:', err);
  } finally {
    loading.classList.remove('active');
  }
});

// CSV Cancel button handler
document.getElementById('csv-cancel')?.addEventListener('click', () => {
  document.getElementById('csv-mapper-modal').classList.remove('active');
  setCsvData(null);
  setCsvMapping({});
  fileInput.value = ''; // Reset file input
});

// CSV Close button handler
document.getElementById('csv-mapper-close')?.addEventListener('click', () => {
  document.getElementById('csv-mapper-modal').classList.remove('active');
  setCsvData(null);
  setCsvMapping({});
  fileInput.value = '';
});

// CSV Preset button handlers
document.getElementById('preset-auto')?.addEventListener('click', () => {
  if (csvData?.headers) {
    autoDetectMappings(csvData.headers);
  }
});

document.getElementById('preset-twitter')?.addEventListener('click', () => {
  // Twitter Academic API / Standard Export mappings
  setMapping('authorId', 'author_id');
  setMapping('authorUsername', 'username');
  setMapping('postId', 'id');
  setMapping('timestamp', 'created_at');
  setMapping('text', 'text');
  setMapping('likes', 'like_count');
  setMapping('comments', 'reply_count');
  setMapping('shares', 'retweet_count');
  setMapping('views', 'impression_count');
  setMapping('followers', 'followers_count');
  setMapping('verified', 'verified');
});

document.getElementById('preset-instagram')?.addEventListener('click', () => {
  // Common Instagram export field names
  setMapping('authorId', 'owner_id');
  setMapping('authorUsername', 'owner_username');
  setMapping('postId', 'id');
  setMapping('timestamp', 'taken_at');
  setMapping('text', 'caption');
  setMapping('likes', 'like_count');
  setMapping('comments', 'comment_count');
  setMapping('views', 'view_count');
  setMapping('location', 'location_name');
});

document.getElementById('preset-tiktok')?.addEventListener('click', () => {
  // TikTok export field names
  setMapping('authorId', 'author_id');
  setMapping('authorUsername', 'author_username');
  setMapping('postId', 'id');
  setMapping('timestamp', 'create_time');
  setMapping('text', 'desc');
  setMapping('likes', 'digg_count');
  setMapping('comments', 'comment_count');
  setMapping('shares', 'share_count');
  setMapping('views', 'play_count');
  setMapping('followers', 'follower_count');
});

// =========================
// Checkpoint System (Crash Recovery) - IndexedDB-based
// =========================

/**
 * Resume operation from checkpoint
 * Currently only supports CIB Detection recovery
 */
async function resumeFromCheckpoint(checkpoint) {
  if (!checkpoint || !checkpoint.recoveryData) {
    throw new Error('No recovery data in checkpoint');
  }

  if (checkpoint.operation !== 'CIB Detection') {
    throw new Error(`Recovery not implemented for operation: ${checkpoint.operation}`);
  }

  // Validate that we have the necessary data
  // Restore DATA if present (Fixed: actually restore the data)
  if (checkpoint.data && checkpoint.data.length > 0) {
    console.log('📦 Restoring data from checkpoint...');
    setRawData(checkpoint.data);
    setFilteredData(checkpoint.filteredData || rawData);

    // Rebuild columnar index so filters + CIB payload work correctly
    refreshColumnarDataIndex(rawData, 'checkpoint restore');

    // Update UI to reflect loaded data
    if (statElements.posts) statElements.posts.textContent = rawData.length;
    platformIndicator.textContent = `· 🔄 Restored Session (${rawData.length} posts)`;
  }

  // Validate that we have the necessary data
  if (!rawData || rawData.length === 0) {
    throw new Error(`Data restoration failed. Checkpoint did not contain valid data.`);
  }

  if (rawData.length !== checkpoint.dataSize) {
    console.warn(`Data size mismatch: Checkpoint says ${checkpoint.dataSize}, stored ${rawData.length}. Proceeding anyway.`);
  }

  // Ensure filteredData exists
  if (!filteredData) setFilteredData(rawData);

  console.log('✅ Data validation passed');
  console.log(`📂 Resuming from ${checkpoint.progress}% (stage: ${checkpoint.recoveryData.completedStage})`);

  // Rebuild the network graph before CIB detection can run.
  // detectCIB guards on graphData being present; without this it returns
  // silently and the checkpoint is never cleared.
  console.log('🔨 Rebuilding network from checkpoint data...');
  await updateNetwork();

  if (!graphData || graphData.nodes.length === 0) {
    throw new Error('Network rebuild failed. Cannot resume CIB detection without a valid graph.');
  }

  // Show the main UI — the empty-state overlay was left visible
  emptyState.style.display = 'none';
  statsDiv.style.display = 'flex';

  // Resume CIB detection from checkpoint
  console.log('🔄 Restarting CIB detection process using worker...');
  await detectCIB();
}


// Check for incomplete work on page load
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(async () => {
    const checkpoint = await getCheckpoint();
    if (checkpoint) {
      const minutes = Math.round((Date.now() - checkpoint.timestamp) / 1000 / 60);
      const hours = Math.floor(minutes / 60);
      const remainingMinutes = minutes % 60;
      const timeAgo = hours > 0 ? `${hours}h ${remainingMinutes}m ago` : `${minutes}m ago`;

      const hasRecoveryData =
        checkpoint.operation === 'CIB Detection' &&
        Array.isArray(checkpoint.data) &&
        checkpoint.data.length > 0;

      let message;
      if (hasRecoveryData) {
        message = `🔄 RECOVERY AVAILABLE\n\n` +
          `Found incomplete operation: "${checkpoint.operation}"\n` +
          `Progress: ${checkpoint.progress}% complete\n` +
          `Time: ${timeAgo}\n` +
          `Data size: ${checkpoint.dataSize} posts\n` +
          `Stage: ${checkpoint.recoveryData.completedStage || 'Unknown'}\n\n` +
          `✅ Recovery data is available!\n\n` +
          `Would you like to:\n` +
          `• Click OK to RESUME from checkpoint\n` +
          `• Click Cancel to START FRESH (clears checkpoint)`;
      } else {
        message = `⚠️ CHECKPOINT FOUND\n\n` +
          `Found incomplete operation: "${checkpoint.operation}"\n` +
          `Progress: ${checkpoint.progress}% complete\n` +
          `Time: ${timeAgo}\n\n` +
          `No recovery data available for this checkpoint.\n` +
          `Click OK to clear and start fresh.`;
      }

      if (hasRecoveryData) {
        // Auto-resume if the checkpoint is very recent (likely a tab discard/reload
        // rather than an old abandoned session). For older checkpoints, ask the user.
        const isRecent = minutes < 10;
        if (isRecent) {
          console.log('🔄 Auto-resuming from recent checkpoint...');
          if (loadingText) loadingText.textContent = 'Resuming previous session...';
          if (loading) loading.classList.add('active');
          try {
            await resumeFromCheckpoint(checkpoint);
          } catch (error) {
            console.error('Failed to resume from checkpoint:', error);
            toast(`❌ Recovery failed: ${error.message}\n\nClearing checkpoint. You'll need to restart.`, { type: 'error' });
            await clearCheckpoint();
          }
        } else {
          // Offer recovery for older checkpoints
          if (await confirmDialog(message, { title: 'Resume previous session?', confirmLabel: 'Resume', cancelLabel: 'Start fresh' })) {
            console.log('🔄 Attempting to resume from checkpoint...');
            try {
              await resumeFromCheckpoint(checkpoint);
            } catch (error) {
              console.error('Failed to resume from checkpoint:', error);
              toast(`❌ Recovery failed: ${error.message}\n\nClearing checkpoint. You'll need to restart.`, { type: 'error' });
              await clearCheckpoint();
            }
          } else {
            // User chose to start fresh
            await clearCheckpoint();
            console.log('✓ Checkpoint cleared, ready to start fresh');
          }
        }
      } else {
        // No recovery data, just clear
        if (await confirmDialog(message, { title: 'Clear previous session?', confirmLabel: 'Clear', cancelLabel: 'Keep' })) {
          await clearCheckpoint();
          console.log('✓ Checkpoint cleared');
        }
      }
    }
  }, 1000); // Delay to avoid interfering with page load
});

// Periodically reduce memory footprint by clearing unused data
function reduceMemoryFootprint() {
  // Clear cosmograph hover state
  if (vizManager) {
    vizManager.handlePointOut();
  }

  // Suggest garbage collection (if available)
  if (window.gc) {
    console.log('🗑️ Suggesting garbage collection...');
    window.gc();
  }
}

// Monitor memory usage and log warnings
if (performance.memory) {
  setInterval(() => {
    const used = performance.memory.usedJSHeapSize;
    const limit = performance.memory.jsHeapSizeLimit;
    const usedMB = (used / 1024 / 1024).toFixed(2);
    const limitMB = (limit / 1024 / 1024).toFixed(2);
    const percentage = ((used / limit) * 100).toFixed(1);

    if (percentage > 80) {
      console.warn(`⚠️ High memory usage: ${usedMB} MB / ${limitMB} MB (${percentage}%)`);
      console.warn('   Consider saving your project and refreshing the page.');
      reduceMemoryFootprint();
    }
  }, 30000); // Check every 30 seconds
}

// Warn user if they leave tab during long operation
let tabHiddenDuringOperation = false;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Tab was hidden — flush a checkpoint immediately so the latest state is
    // on disk if the browser decides to discard this tab.
    getCheckpoint().then((checkpoint) => {
      if (checkpoint) {
        console.warn('⚠️ Tab hidden during operation. Browser may throttle or kill this tab.');
        console.warn('   Keep this tab visible to prevent crashes.');
        tabHiddenDuringOperation = true;
        // Force a checkpoint flush so we have the most recent data on disk
        saveCheckpoint(checkpoint.operation, checkpoint.progress, checkpoint.recoveryData, { includeData: false })
          .catch(() => { /* ignore flush errors */ });
      }
    }).catch(() => { });
  } else {
    // Tab became visible again
    if (tabHiddenDuringOperation) {
      getCheckpoint().then((checkpoint) => {
        if (checkpoint) {
          console.log('✓ Tab visible again, operation continuing...');
        }
      }).catch(() => { });
      tabHiddenDuringOperation = false;
    }
  }
});

// Emergency checkpoint flush before the browser unloads the page
window.addEventListener('beforeunload', () => {
  getCheckpoint().then((checkpoint) => {
    if (checkpoint) {
      saveCheckpoint(checkpoint.operation, checkpoint.progress, checkpoint.recoveryData, { includeData: false })
        .catch(() => { });
    }
  }).catch(() => { });
});

// =========================
// Project Save/Load
// =========================


async function saveProject() {
  try {
    loading.classList.add('active');
    loadingText.textContent = 'Preparing project file...';

    // Serialize as an array of JSON string parts (slices the big arrays so no
    // single string approaches the engine's max-string-length).
    const { parts, metadata } = buildProjectParts({
      networkType: networkTypeSelect.value,
      nodeSizeBy: nodeSizeBySelect.value,
      engagementFilter: engagementFilter.value,
      engagementValue: engagementValue.value,
      cibThreshold: cibThreshold.value,
      timeWindow: timeWindowInput.value,
      dateStart: dateStart.value,
      dateEnd: dateEnd.value,
      vizMode: vizManager ? vizManager.mode : 'community',
      platform: platformIndicator.textContent || 'Unknown'
    });

    loadingText.textContent = 'Serializing data...';
    // Blob from parts: bytes are concatenated without ever building one giant JS
    // string, so the string-length ceiling that broke large saves disappears.
    const jsonBlob = new Blob(parts, { type: 'application/json' });

    // gzip the JSON when the platform supports it (all current browsers do).
    // Old uncompressed .json projects keep loading; gzip detection is by magic
    // bytes on load, not by filename.
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    let blob = jsonBlob;
    let filename = `schuimsurfer-project-${timestamp}.json`;

    if (typeof CompressionStream !== 'undefined') {
      loadingText.textContent = 'Compressing project...';
      const compressedStream = jsonBlob.stream().pipeThrough(new CompressionStream('gzip'));
      blob = await new Response(compressedStream).blob();
      filename = `schuimsurfer-project-${timestamp}.json.gz`;
    }

    loadingText.textContent = 'Creating download...';
    const url = URL.createObjectURL(blob);

    // Create download link
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log(`✓ Project saved: ${filename}`);
    console.log(`  - Data: ${metadata.datasetSize} posts`);
    console.log(`  - CIB Analysis: ${metadata.hasCibAnalysis ? 'Yes' : 'No'}`);
    console.log(`  - Uncompressed: ${(jsonBlob.size / 1024 / 1024).toFixed(2)} MB · Download: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);

    loading.classList.remove('active');

    // Show success message
    const originalText = loadingText.textContent;
    loadingText.textContent = `✓ Project saved: ${filename}`;
    loading.classList.add('active');
    setTimeout(() => {
      loading.classList.remove('active');
    }, 2000);

  } catch (error) {
    console.error('Failed to save project:', error);
    console.error('Error details:', error.stack);

    // Try emergency fallback - save raw data as CSV
    try {
      loadingText.textContent = 'JSON save failed, trying emergency CSV export...';
      console.warn('Attempting emergency CSV export of raw data...');

      await emergencySaveAsCSV();

      toast('⚠️ Full project save failed due to serialization error.\n\n' +
        'Emergency backup saved as CSV (raw data only).\n\n' +
        'Error: ' + error.message + '\n\n' +
        'Check console for details.');
    } catch (csvError) {
      console.error('Emergency CSV save also failed:', csvError);
      toast('❌ Critical error: Failed to save project in any format.\n\n' +
        'Primary error: ' + error.message + '\n' +
        'CSV fallback error: ' + csvError.message + '\n\n' +
        'Your data is still in memory. Do not close this tab.\n' +
        'Try these steps:\n' +
        '1. Open browser console (F12)\n' +
        '2. Copy this command: copy(JSON.stringify(rawData))\n' +
        '3. Paste into a text file as backup');
    }

    loading.classList.remove('active');
  }
}

/**
 * Incremental auto-save during long operations
 * Saves project at key milestones to prevent data loss
 */
let lastAutoSaveTime = 0;
const AUTO_SAVE_INTERVAL = 5 * 60 * 1000; // 5 minutes

async function incrementalAutoSave(force = false) {
  const now = Date.now();

  // Skip if saved recently (unless forced)
  if (!force && (now - lastAutoSaveTime) < AUTO_SAVE_INTERVAL) {
    console.log(`⏭️ Skipping auto-save (last saved ${Math.round((now - lastAutoSaveTime) / 1000)}s ago)`);
    return;
  }

  try {
    console.log('💾 Performing incremental auto-save...');
    const previousLoadingState = loading.classList.contains('active');
    const previousText = loadingText.textContent;

    // Save in background without disrupting UI
    await saveProject();

    // Restore previous UI state
    if (previousLoadingState) {
      loading.classList.add('active');
      loadingText.textContent = previousText;
    }

    lastAutoSaveTime = now;
    console.log('✓ Incremental auto-save completed');
  } catch (error) {
    console.warn('⚠️ Incremental auto-save failed:', error.message);
    // Don't throw - let the operation continue
  }
}


async function loadProject(file) {
  setIsRestoring(true);
  try {
    loading.classList.add('active');
    loadingText.textContent = 'Loading project file...';

    // Read the project file. Saved projects are gzipped (magic bytes 1f 8b);
    // older saves are plain JSON. Detect by content, not filename, so renamed
    // and pre-compression files both load.
    loadingText.textContent = 'Reading project file...';
    const header = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    const isGzip = header[0] === 0x1f && header[1] === 0x8b;

    let text;
    if (isGzip) {
      loadingText.textContent = 'Decompressing project...';
      const stream = file.stream().pipeThrough(new DecompressionStream('gzip'));
      text = await new Response(stream).text();
    } else {
      text = await file.text();
    }

    loadingText.textContent = 'Parsing project data...';
    const projectData = JSON.parse(text);

    // Validate project file
    if (!projectData.version || !projectData.metadata || !projectData.data) {
      throw new Error('Invalid project file format');
    }

    console.log(`Loading project from ${projectData.metadata.timestamp}`);
    console.log(`  - Version: ${projectData.version}`);
    console.log(`  - Dataset size: ${projectData.metadata.datasetSize} posts`);
    console.log(`  - Has embeddings: ${projectData.metadata.hasEmbeddings}`);
    console.log(`  - Has CIB analysis: ${projectData.metadata.hasCibAnalysis}`);

    // Restore data
    loadingText.textContent = 'Restoring dataset...';
    setRawData(projectData.data.rawData);
    setFilteredData(projectData.data.filteredData);
    setFilteredIndices(
      projectData.data.filteredIndices
        ? new Uint32Array(projectData.data.filteredIndices)
        : null
    );
    refreshColumnarDataIndex(rawData, 'project restore');

    // Restore analysis results
    loadingText.textContent = 'Restoring analysis...';
    setGraphData(projectData.analysis.graphData);
    setNetworkMetrics(projectData.analysis.networkMetrics);
    setCommunities(projectData.analysis.communities);
    if (communities) {
      // Restore communities map (nodeId -> clusterId)
      if (Array.isArray(communities.communities)) {
        communities.communities = new Map(communities.communities);
      } else if (typeof communities.communities === 'object' && communities.communities !== null) {
        // Fallback if saved as object
        communities.communities = new Map(Object.entries(communities.communities));
      }

      // Restore names map
      if (Array.isArray(communities.names)) {
        communities.names = new Map(communities.names);
      } else if (typeof communities.names === 'object' && communities.names !== null) {
        // Fallback if saved as object
        communities.names = new Map(Object.entries(communities.names));
      } else {
        communities.names = new Map();
      }
    }
    vizManager.nodeSizeStats = projectData.analysis.nodeSizeStats;

    // Restore coordination graph
    if (projectData.analysis.coordinationGraph) {
      setCoordinationGraph(projectData.analysis.coordinationGraph);
      const coordOption = document.querySelector('#network-type option[value="coordinationNetwork"]');
      if (coordOption) coordOption.disabled = false;
    }

    // Restore CIB detection (deserialize Sets and Maps)
    if (projectData.analysis.cibDetection) {
      loadingText.textContent = 'Restoring CIB analysis...';
      const cib = projectData.analysis.cibDetection;
      setCibDetection({
        suspiciousUsers: new Set(cib.suspiciousUsers),
        indicators: cib.indicators,
        userScores: new Map(cib.userScores),
        userReasons: new Map(cib.userReasons)
      });

      // Re-apply suspicious flags to graph nodes (crucial for visualization)
      if (graphData && graphData.nodes) {
        const suspiciousSet = cibDetection.suspiciousUsers;
        const scoreMap = cibDetection.userScores;
        graphData.nodes.forEach(node => {
          if (suspiciousSet.has(node.id)) {
            node.suspicious = true;
            node.cibScore = scoreMap.get(node.id);
          }
        });
      }
    }

    // Restore embeddings cache (decoding base64 Float32 vectors; legacy decimal
    // arrays are passed through unchanged).
    if (projectData.embeddings && projectData.embeddings.length > 0) {
      loadingText.textContent = 'Restoring embeddings cache...';
      embeddingsCache.clear();
      decodeProjectEmbeddings(projectData.embeddings).forEach(({ key, value }) => {
        const embeddingsMap = new Map(value);
        embeddingsCache.cache.set(key, embeddingsMap);
      });
      console.log(`✓ Restored ${projectData.embeddings.length} cached embedding sets`);
    }

    // Restore UI state
    loadingText.textContent = 'Restoring UI state...';
    if (projectData.uiState) {
      networkTypeSelect.value = projectData.uiState.networkType;
      nodeSizeBySelect.value = projectData.uiState.nodeSizeBy;
      engagementFilter.value = projectData.uiState.engagementFilter;
      engagementValue.value = projectData.uiState.engagementValue;
      cibThreshold.value = projectData.uiState.cibThreshold;
      timeWindowInput.value = projectData.uiState.timeWindow;
      dateStart.value = projectData.uiState.dateStart;
      dateEnd.value = projectData.uiState.dateEnd;

      // Update UI displays
      thresholdValue.textContent = thresholdLabels[cibThreshold.value];
      timeWindowValue.textContent = timeWindowInput.value + 's';
    }

    // Set platform indicator
    platformIndicator.textContent = projectData.metadata.platform;

    // Update stats
    loadingText.textContent = 'Calculating statistics...';
    const statSummary = await calculateStatsChunked(rawData, (message) => {
      loadingText.textContent = message;
    });
    updateStatCards(statSummary);

    // Display metrics if available
    if (networkMetrics) {
      displayMetrics(networkMetrics);
    }

    // Display CIB results if available
    if (cibDetection) {
      displayCIBResults(cibDetection);
      exportCsvBtn.disabled = false;
      exportReportBtn.disabled = false;

      // Switch to Risk Mode (CIB)
      vizManager.setMode('risk');
      const vizModeSelect = document.getElementById('viz-mode');
      if (vizModeSelect) vizModeSelect.value = 'risk';
      renderLegend();

      // Update suspicious count in stats
      if (statElements.suspicious) {
        statElements.suspicious.textContent = cibDetection.suspiciousUsers.size;
      }
    }



    // Initialize globals with restored data
    if (graphData) {
      console.log('Restoring graph state...');

      // Rebuild adjacency from restored graph
      buildAdjacency(graphData);
      setIdToNode(new Map(graphData.nodes.map(n => [n.id, n])));

      // Update VizManager directly with restored data
      vizManager.updateData(graphData, communities);

      // Sync globals
      setNodes(vizManager.getNodes());
      setIdToNode(vizManager.getIdToNode());

      // Display metrics
      if (networkMetrics) displayMetrics(networkMetrics);
    }

    // Restore Viz Mode
    const savedMode = projectData.uiState?.vizMode || 'community';
    const vizModeSelect = document.getElementById('viz-mode');
    if (vizModeSelect) {
      vizModeSelect.value = savedMode;
      vizManager.setMode(savedMode);
    }
    renderLegend();

    // Show UI
    setIsRestoring(false); // Restoration complete
    refreshTimeline();
    emptyState.style.display = 'none';
    statsDiv.style.display = 'flex';

    loading.classList.remove('active');
    updateCoach();

    console.log('✓ Project loaded successfully');

  } catch (error) {
    console.error('Failed to load project:', error);
    toast('Failed to load project: ' + error.message, { type: 'error' });
    loading.classList.remove('active');
  }
}

// =========================
// CIB Advanced Parameters (imported from cib-controller.js)
// =========================

// =========================
// CIB detection (OPTIMIZED: Spatial indexing for synchronized posts)
// =========================

// Optimization: Synchronized posting detection moved to Web Worker

/**
 * Resume CIB Detection from checkpoint
 * This function continues CIB analysis from where it left off
 */
// Resume CIB Detection legacy code removed

// Network extraction functions moved to network-extraction.js

// =========================
// Metrics & communities (OPTIMIZED: Cached calculations)
// =========================
// =========================
// Update network (OPTIMIZED: Progressive visualization + cache invalidation)
// =========================
// =========================
function updateNetwork() {
  return new Promise((resolve) => {
    loading.classList.add('active');
    loadingText.textContent = 'Building network...';

    // Clear caches when filters change (data has changed)
    networkMetricsCache.clear();
    communityDetectionCache.clear();
    embeddingsCache.clear(); // Also clear embeddings cache

    perfMonitor.start('updateNetwork');

    setTimeout(async () => {
      // Skip updates during project restoration
      if (isRestoring) {
        loading.classList.remove('active');
        resolve();
        return;
      }

      const minEngagement = parseInt(engagementFilter.value, 10);
      const startDateValue = dateStart.value ? new Date(dateStart.value).getTime() / 1000 : undefined;
      const endDateValue = dateEnd.value ? (new Date(dateEnd.value).getTime() / 1000) + 86399 : undefined;

      let filtered;
      if (columnarDataIndex && columnarDataIndex.length === rawData.length) {
        setFilteredIndices(filterColumnarIndices(columnarDataIndex, {
          minEngagement,
          startDate: startDateValue,
          endDate: endDateValue,
        }));
        filtered = materializePostsByIndices(rawData, filteredIndices);
      } else {
        filtered = filterData(rawData, {
          minEngagement,
          startDate: startDateValue,
          endDate: endDateValue,
          onDebug(post, details) {
            console.log(`Filter Debug - Post ${post.item_id}:`, details);
          },
        });
        setFilteredIndices(null);
      }

      setFilteredData(filtered);
      console.log(`Filtered: ${filteredData.length} posts out of ${rawData.length} (${rawData.length - filteredData.length} filtered out). MinEngagement: ${minEngagement}, DateRange: ${dateStart.value || 'none'} - ${dateEnd.value || 'none'}`);
      const networkType = networkTypeSelect.value;

      const progressCallback = (message) => {
        loadingText.textContent = message;
      };

      let network;
      switch (networkType) {
        case 'mention': network = await extractMentionNetwork(filtered, progressCallback); break;
        case 'coHashtag': network = await extractCoHashtagNetwork(filtered, progressCallback); break;
        case 'userHashtag': network = await extractUserHashtagNetwork(filtered, progressCallback); break;
        case 'hashtag': network = await extractHashtagNetwork(filtered, progressCallback); break;
        case 'photoTag': network = await extractPhotoTagNetwork(filtered, progressCallback); break;
        case 'location': network = await extractLocationNetwork(filtered, progressCallback); break;
        case 'urlCoshare': network = await extractUrlCoshareNetwork(filtered, progressCallback); break;
        case 'repost': network = await extractRepostNetwork(filtered, progressCallback); break;
        case 'coordinationNetwork':
          if (coordinationGraph && coordinationGraph.nodes.length > 0) {
            network = { nodes: coordinationGraph.nodes, links: coordinationGraph.links };
          } else {
            network = { nodes: [], links: [] };
          }
          break;
        default: network = { nodes: [], links: [] };
      }

      // Store full network for analysis and visualization
      const fullNetwork = network;
      setGraphData(network);

      setCommunities(null);
      setCibDetection(null);

      // Calculate metrics on full network
      setNetworkMetrics(await calculateNetworkMetrics(fullNetwork, progressCallback));
      displayMetrics(networkMetrics);

      // Show full network stats
      if (statElements.nodes) statElements.nodes.textContent = fullNetwork.nodes.length.toLocaleString();
      if (statElements.edges) statElements.edges.textContent = fullNetwork.links.length.toLocaleString();
      if (statElements.density) statElements.density.textContent = networkMetrics ? networkMetrics.density : '0';
      if (statElements.communities) statElements.communities.textContent = '0';
      if (statElements.suspicious) statElements.suspicious.textContent = '0';

      cibPanel.style.display = 'none';

      // Check if network is empty
      if (fullNetwork.nodes.length === 0 || fullNetwork.links.length === 0) {
        loading.classList.remove('active');
        loadingText.textContent = `No ${networkType === 'mention' ? 'mentions' :
          networkType === 'coHashtag' ? 'co-hashtags' :
            networkType === 'hashtag' ? 'hashtags' :
              networkType === 'userHashtag' ? 'user-hashtag connections' :
                networkType === 'photoTag' ? 'photo tags' :
                  networkType === 'location' ? 'location connections' :
                    networkType === 'urlCoshare' ? 'shared URLs' :
                      networkType === 'repost' ? 'repost/quote relations (Twitter/X only)' :
                        networkType === 'coordinationNetwork' ? 'coordinated accounts (run CIB detection first)' :
                          'connections'} found in this dataset. Try a different network type.`;
        setTimeout(() => { loadingText.textContent = ''; }, 5000);
        perfMonitor.end('updateNetwork');
        resolve();
        return;
      }

      // Build adjacency using rendered network (graphData)
      buildAdjacency(graphData);
      setIdToNode(new Map(graphData.nodes.map(n => [n.id, n])));

      perfMonitor.end('updateNetwork');
      perfMonitor.logMemory();

      // For coordination network, keep CIB risk mode so suspicious nodes stay red;
      // also ensure the viz mode selector reflects the current state.
      if (networkType === 'coordinationNetwork' && cibDetection) {
        vizManager.setMode('risk');
        const vizModeSelect = document.getElementById('viz-mode');
        if (vizModeSelect) vizModeSelect.value = 'risk';
      }

      vizManager.updateData(graphData, communities);
      // Sync globals used by other parts of the app
      setNodes(vizManager.getNodes());
      setIdToNode(vizManager.getIdToNode());
      loading.classList.remove('active');
      updateCoach();
      renderLegend();
      refreshTableViewIfVisible();
      resolve(); // Resolve when done
    }, 100);
  });
}


// =========================
function postMatchesNodeWrapper(post, node) {
  // Thin wrapper so existing calls still work; delegates to pure utility.
  return postMatchesNode(post, node);
}


// =========================
// Communities button
// =========================
cibBtn.addEventListener('click', () => detectCIB().then(() => { refreshTimeline(); renderSyntheticReport(); }).catch(() => {}));

// CIB Advanced Settings handlers
cibSettingsBtn.addEventListener('click', () => {
  const isOpening = cibSettingsPanel.style.display === 'none';
  cibSettingsPanel.style.display = isOpening ? 'block' : 'none';

  // Initialize parameters with current sensitivity preset when opening
  if (isOpening) {
    const currentThreshold = parseInt(cibThreshold.value, 10);
    applySensitivityPreset(currentThreshold);
  }
});

closeCibSettings.addEventListener('click', () => {
  cibSettingsPanel.style.display = 'none';
});

resetCibParamsBtn.addEventListener('click', () => {
  resetCibParams();
  const currentLevel = thresholdLabels[cibThreshold.value];
  toast(`CIB parameters reset to ${currentLevel} sensitivity preset`);
});

detectBtn.addEventListener('click', async () => {
  if (!graphData || graphData.nodes.length === 0) return;
  loading.classList.add('active');
  loadingText.textContent = 'Detecting communities...';

  const progressCallback = (msg) => {
    loadingText.textContent = msg;
  };

  setTimeout(async () => {
    setCommunities(await detectCommunities(graphData, progressCallback));
    if (communities && statElements.communities) statElements.communities.textContent = communities.count;

    // Calculate and display network metrics (including modularity)
    if (!networkMetrics) {
      loadingText.textContent = 'Calculating network metrics...';
      setNetworkMetrics(await calculateNetworkMetrics(graphData, progressCallback));
    }
    displayMetrics(networkMetrics);

    // Update Visualizer with new communities WITHOUT destroying the graph
    vizManager.communities = communities;
    vizManager.currentClusterStats = vizManager.computeClusterStats();
    vizManager.refreshStyling();

    // Initialize community names map if needed
    if (communities && !communities.names) {
      communities.names = new Map();
    }

    // Switch to Community Mode
    vizManager.setMode('community');
    const vizModeSelect = document.getElementById('viz-mode');
    if (vizModeSelect) vizModeSelect.value = 'community';

    // Allow visualizer time to update stats before rendering legend
    setTimeout(() => {
      renderLegend();
      refreshTableViewIfVisible();
      loading.classList.remove('active');
      updateCoach();
    }, 100);
  }, 100);
});

// =========================
// Controls wiring
// =========================
networkTypeSelect.addEventListener('change', updateNetwork);
nodeSizeBySelect.addEventListener('change', () => {
  // Clear cached stats when sizing mode changes
  vizManager.nodeSizeStats = null;
  if (nodes.length > 0) vizManager.refreshStyling({ updateClusters: false });
});
// 'input' only updates the label while dragging; the expensive network rebuild
// happens once on release ('change') instead of dozens of times per drag.
engagementFilter.addEventListener('input', (e) => {
  engagementValue.textContent = `${e.target.value}+ interactions`;
});
engagementFilter.addEventListener('change', () => {
  updateNetwork();
});
function syncTimelineBrushFromDates() {
  const s = dateStart.value ? new Date(dateStart.value).getTime() / 1000 : null;
  const e = dateEnd.value ? (new Date(dateEnd.value).getTime() / 1000) + 86399 : null;
  timelineView.setBrushRange(s == null && e == null ? null : s, e);
}
dateStart.addEventListener('change', () => { updateNetwork(); syncTimelineBrushFromDates(); });
dateEnd.addEventListener('change', () => { updateNetwork(); syncTimelineBrushFromDates(); });

exportBtn.addEventListener('click', () => {
  if (!graphData) return;
  const exportData = {
    ...graphData,
    metrics: networkMetrics,
    communities: communities ? {
      count: communities.count,
      noiseClusterId: communities.noiseClusterId,
      minClusterSize: communities.minClusterSize,
      assignments: Array.from(communities.communities.entries()),
      names: communities.names ? Array.from(communities.names.entries()) : []
    } : null,
    cibDetection: cibDetection ? {
      suspiciousUsers: Array.from(cibDetection.suspiciousUsers),
      indicators: cibDetection.indicators,
      userScores: Array.from(cibDetection.userScores.entries()),
      userReasons: Array.from(cibDetection.userReasons.entries())
    } : null,
    uiState: {
      networkType: networkTypeSelect.value,
      nodeSizeBy: nodeSizeBySelect.value,
      engagementFilter: engagementFilter.value,
      engagementValue: engagementValue.textContent,
      cibThreshold: cibThreshold.value,
      timeWindow: timeWindowInput.value,
      dateStart: dateStart.value,
      dateEnd: dateEnd.value,
      vizMode: document.getElementById('viz-mode')?.value || 'community'
    }
  };
  const dataStr = JSON.stringify(exportData, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = `network_analysis_${Date.now()}.json`; link.click();
  URL.revokeObjectURL(url);
});

// Export CIB Detection Results as CSV


exportCsvBtn.addEventListener('click', () => {
  if (!cibDetection || !cibDetection.suspiciousUsers || cibDetection.suspiciousUsers.size === 0) {
    toast('No CIB detection results available. Please run "Detect Coordinated Behavior" first.', { type: 'error' });
    return;
  }

  // Exclude synthetic test posts from exports (Session 7).
  const exportData = filteredData.filter(p => !p?.synthetic);
  const csvContent = generateCSVReport(cibDetection, exportData);

  // Download
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `cib_suspicious_accounts_${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
});

// Export Investigation Report as HTML
exportReportBtn.addEventListener('click', () => {
  if (!cibDetection || !cibDetection.suspiciousUsers || cibDetection.suspiciousUsers.size === 0) {
    toast('No CIB detection results available. Please run "Detect Coordinated Behavior" first.', { type: 'error' });
    return;
  }

  const networkSnapshotUrl = document.querySelector('canvas')?.toDataURL('image/png'); // Attempt to get canvas data, fallback if null

  // Get enriched nodes from visualization manager (includes all CIB metadata)
  const vizNodes = vizManager.getNodes();
  const simulationState = vizManager.getGraphState();

  // Build export graph data with all metadata
  const exportGraphData = {
    nodes: vizNodes.map((node, index) => {
      // Clone node with all properties
      const exportNode = {
        id: node.id,
        label: node.label,
        type: node.type,
        degree: node.degree,
        verified: node.verified,
        followers: node.followers,
        count: node.count,
        suspicious: node.suspicious,
        cibScore: node.cibScore,
        cibReasons: node.cibReasons,
      };

      // Add positions from simulation
      if (simulationState) {
        const pos = simulationState.get(node.id);
        if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
          exportNode.x = pos.x;
          exportNode.y = pos.y;
          exportNode.z = 0;
        } else {
          // Fallback to circular layout
          const angle = (index / vizNodes.length) * 2 * Math.PI;
          const radius = Math.sqrt(vizNodes.length) * 30;
          exportNode.x = Math.cos(angle) * radius;
          exportNode.y = Math.sin(angle) * radius;
          exportNode.z = 0;
        }
      } else {
        // Fallback to circular layout
        const angle = (index / vizNodes.length) * 2 * Math.PI;
        const radius = Math.sqrt(vizNodes.length) * 30;
        exportNode.x = Math.cos(angle) * radius;
        exportNode.y = Math.sin(angle) * radius;
        exportNode.z = 0;
      }

      return exportNode;
    }),
    links: graphData.links || []
  };

  console.log(`Export: ${exportGraphData.nodes.length} nodes with full metadata`);

  const staticInfo = {
    timestamp: new Date().toLocaleString(),
    platformText: platformIndicator.textContent.replace('· ', '').trim(),
    thresholdText: thresholdValue.textContent,
    timeWindowText: timeWindowValue.textContent,
    networkSnapshotUrl: networkSnapshotUrl,
    coordinationGraph: coordinationGraph || null
  };

  // Exclude synthetic test posts from the report (Session 7).
  const reportData = filteredData.filter(p => !p?.synthetic);
  const html = generateInvestigationReport(cibDetection, reportData, getCibParams(), staticInfo, exportGraphData);

  // Download
  const blob = new Blob([html], { type: 'text/html;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `cib_investigation_report_${Date.now()}.html`;
  link.click();
  URL.revokeObjectURL(url);
});

// Save Project button handler
const saveProjectBtn = document.getElementById('save-project-btn');
if (saveProjectBtn) {
  saveProjectBtn.addEventListener('click', async () => {
    if (!rawData || rawData.length === 0) {
      toast('No data loaded. Please load a dataset first.', { type: 'error' });
      return;
    }
    await saveProject();
  });
}

if (searchInput) {
  searchInput.addEventListener('input', (e) => {
    const term = e.target.value.trim().toLowerCase();
    if (!term || !nodes.length) {
      vizManager.clearHighlight();
      graphContainer.classList.remove('hovering');
      if (vizManager?.hideTooltip) vizManager.hideTooltip();
      return;
    }

    const matches = nodes
      .filter(n => (n.label || '').toLowerCase().includes(term) || String(n.id).toLowerCase().includes(term))
      .map(n => vizManager.nodeIndex.get(n.id))
      .filter(index => index !== undefined);

    console.log(`Search: Found ${matches.length} nodes matching "${term}"`);

    if (!matches.length) {
      vizManager.clearHighlight();
      return;
    }

    if (vizManager.graph) {
      vizManager.graph.selectPointsByIndices(matches);
      vizManager.graph.fitViewByPointIndices(matches, 400, 0.2);
    }

    const firstIndex = matches[0];
    const firstNode = nodes[firstIndex];
    if (firstNode) {
      setHoveredNode(firstNode);
      // cosmosHoverIndex was removed
      graphContainer.classList.add('hovering');
      showNodeInfo(firstNode);
    }
  });
}
else {
  console.error('Search input element not found! Check if #search-input exists in HTML.');
}

// OPTIMIZED: Only resize canvas, don't reinitialize everything

let resizeTimeout;
window.addEventListener('resize', () => {
  // Debounce resize to avoid excessive redraws
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => vizManager.resize(), 100);
});

// Help Modal functionality
const helpBtn = document.getElementById('help-btn');
const helpModal = document.getElementById('help-modal');
const helpClose = document.getElementById('help-close');
const helpBody = document.getElementById('help-body');

// Simple markdown to HTML converter (basic features)
function markdownToHtml(md) {
  const escapeMarkdownHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const escapeAttrValue = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const safeHelpUrl = (value) => {
    try {
      const url = new URL(String(value ?? ''), window.location.href);
      if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
        return url.toString();
      }
    } catch (_) {
      // Invalid or unsupported URL
    }
    return '#';
  };

  let html = escapeMarkdownHtml(md);

  // Headers
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
  html = html.replace(/^#### (.*$)/gim, '<h4>$1</h4>');

  // Bold
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

  // Italic  
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');

  // Code inline
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^\)]+)\)/g, (_, text, url) => {
    const safeUrl = escapeAttrValue(safeHelpUrl(url));
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  // Horizontal rules
  html = html.replace(/^---$/gim, '<hr>');

  // Lists (basic)
  html = html.replace(/^\- (.*$)/gim, '<li>$1</li>');
  html = html.replace(/^(\d+)\. (.*$)/gim, '<li>$2</li>');

  // Wrap consecutive <li> in <ul>
  html = html.replace(/(<li>.*<\/li>\n?)+/g, function (match) {
    return '<ul>' + match + '</ul>';
  });

  // Paragraphs
  html = html.split('\n\n').map(para => {
    para = para.trim();
    if (!para) return '';
    if (para.startsWith('<h') || para.startsWith('<ul') || para.startsWith('<hr') || para.startsWith('<pre')) {
      return para;
    }
    return '<p>' + para + '</p>';
  }).join('\n');

  // Code blocks
  html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');

  return html;
}

// Load README content
async function loadReadme() {
  try {
    const response = await fetch('README.md');
    const markdown = await response.text();
    const html = markdownToHtml(markdown);
    helpBody.innerHTML = html;
  } catch (error) {
    console.error('Failed to load README:', error);
    helpBody.innerHTML = `
      <h1>SchuimSurfer User Guide</h1>
      <p><strong>Unable to load README.md file.</strong> Please ensure README.md is in the same directory as this HTML file.</p>
      <h2>Quick Start</h2>
      <p>1. Upload your social media data (JSON format)<br>
      2. Select network type from dropdown<br>
      3. Click "Detect Communities" to identify clusters<br>
      4. Click "Detect Coordinated Behavior" to run CIB analysis<br>
      5. Click nodes to see details</p>
      <h2>CIB Detection Methods</h2>
      <ul>
        <li>🤖 <strong>Semantic Similarity</strong> - AI-powered caption matching</li>
        <li>⏱️ <strong>Synchronized Posting</strong> - Coordinated timing detection</li>
        <li>🏷️ <strong>TF-IDF Hashtags</strong> - Rare hashtag combinations</li>
        <li>👤 <strong>Username Patterns</strong> - Similar account names</li>
        <li>📈 <strong>Z-Score Analysis</strong> - Statistical outlier detection</li>
        <li>💥 <strong>Temporal Bursts</strong> - Activity spikes</li>
        <li>🎵 <strong>Posting Rhythm</strong> - Bot-like regularity</li>
        <li>🌙 <strong>24/7 Activity</strong> - No sleep gaps</li>
        <li>📝 <strong>N-gram Templates</strong> - Caption templates</li>
        <li>🏭 <strong>Account Clustering</strong> - Batch creation detection</li>
      </ul>
      <h2>Advanced Settings</h2>
      <p>Click "Advanced CIB Settings" to fine-tune detection parameters:</p>
      <ul>
        <li><strong>Semantic Similarity</strong> (0.85) - AI caption threshold</li>
        <li><strong>N-gram Overlap</strong> (0.3) - Template detection</li>
        <li><strong>Username Similarity</strong> (0.8) - Name matching</li>
        <li><strong>TF-IDF Threshold</strong> (0.5) - Rare hashtag sensitivity</li>
        <li><strong>Z-Score Threshold</strong> (2) - Volume outliers</li>
        <li><strong>Burst Min Posts</strong> (5) - Burst trigger</li>
        <li><strong>Rhythm CV</strong> (0.1) - Regularity threshold</li>
        <li><strong>Night Gap</strong> (7200s) - 24/7 detection</li>
        <li><strong>Cluster Size</strong> (5) - Account creation groups</li>
        <li><strong>Cross-Indicator Bonus</strong> (0.3) - Score multiplier</li>
      </ul>
      <h2>Important Notes</h2>
      <p><strong>⚠️ These are indicators, not proof.</strong> Always verify findings manually and consider context.</p>
      <p><strong>Privacy:</strong> All processing happens in your browser. No data is sent to servers.</p>
      <p><strong>Legitimate Coordination:</strong> Activist campaigns, fan communities, and event promotions may trigger detection. Context matters!</p>
    `;
  }
}

// Open modal
if (!window.__helpModalInitialized && helpBtn && helpModal && helpClose && helpBody) {
  window.__helpModalInitialized = true;

  helpBtn.addEventListener('click', () => {
    helpModal.classList.add('active');
    if (helpBody.innerHTML.includes('Loading guide')) {
      loadReadme();
    }
  });

  // Close modal
  helpClose.addEventListener('click', () => {
    helpModal.classList.remove('active');
  });

  // Close on overlay click
  helpModal.addEventListener('click', () => {
    helpModal.classList.remove('active');
  });

  // Prevent closing when clicking content
  document.querySelector('.help-content')?.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // Close on Escape key (help modal and node modal)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (helpModal.classList.contains('active')) {
      helpModal.classList.remove('active');
      return;
    }
    const nodeModal = document.getElementById('node-modal');
    if (nodeModal && nodeModal.style.display !== 'none' && nodeModal.style.display !== '') {
      nodeModal.style.display = 'none';
    }
  });
}

// =========================
// Initialize CIB parameters with default sensitivity preset
// =========================
// Set initial parameters based on the default threshold value (5 = Medium)
applySensitivityPreset(parseInt(cibThreshold.value, 10));

// =========================
// Visualization Mode & Legend Logic
// =========================
const vizModeSelect = document.getElementById('viz-mode');
const legendContent = document.getElementById('legend-content');

if (vizModeSelect) {
  vizModeSelect.addEventListener('change', (e) => {
    const mode = e.target.value;
    vizManager.setMode(mode);
    renderLegend();
  });
}
