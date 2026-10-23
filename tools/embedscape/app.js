// External deps loaded in index.html: PapaParse, UMAP, deck.gl (UMD)
const { Deck, ScatterplotLayer, OrthographicView, LinearInterpolator } = window.deck;

// Help modal handlers
const helpBtn = document.getElementById('help-btn');
const helpModal = document.getElementById('help-modal');
const helpClose = document.getElementById('help-close');

helpBtn?.addEventListener('click', () => { helpModal.style.display = 'block'; });
helpClose?.addEventListener('click', () => { helpModal.style.display = 'none'; });
helpModal?.addEventListener('click', (e) => { if (e.target === helpModal) helpModal.style.display = 'none'; });

let csv = [];
let fields = [];
let cfg = { text: null, label: null, link: null, image: null, video: null, mode: 'text', source: 'text', k: 5, batch: 16, imageEmbedder: 'Xenova/clip-vit-base-patch32', videoFps: 1, videoMaxFrames: 30 };

let embeddings = [];
let coords = [];
let clusters = [];
let nodes = [];
let searchVec = null;
let highlightedNodes = new Set();  // Track highlighted nodes for search

// Tagging system
let selectedNodes = new Set();  // Track selected nodes for tagging
let allTags = new Map();  // tag name -> Set of node ids
let colorMode = 'cluster';  // 'cluster' or 'tag'
let selectionMode = 'off';  // 'off', 'single', or 'multi'
let tagColors = {};  // tag name -> color

let deckInstance = null;
let currentViewState = null;  // Track current view state for animations
let worker = null;
let workerReady = false;

// Worker pool for parallel embedding
const WORKER_POOL_SIZE = 1; // WebGPU serializes on the GPU — multiple workers give no speedup and multiply VRAM usage
let workerPool = [];
let poolReady = false;

const el = (id) => document.getElementById(id);
const fileInput = el('csv-file');
const fileInfo = el('file-info');
const loadSavedBtn = el('load-emb-btn');
const embFile = el('emb-file');
const saveBtn = el('save-emb-btn');
const saveMsg = el('save-msg');

const configPanel = el('config');
const textCol = el('text-col');
const labelCol = el('label-col');
const linkCol = el('link-col');
const imageCol = el('image-col');
const videoCol = el('video-col');
const imageEmbedderSel = el('image-embedder');
const videoFpsInput = el('video-fps');
const videoMaxFramesInput = el('video-max-frames');
const kInput = el('k');
const batchInput = el('batch');

const processBtn = el('process');
const cancelBtn = el('cancel');

const progressPanel = el('progress');
const bar = el('bar');
const ptext = el('ptext');

const searchPanel = el('search');
const queryType = el('query-type');
const q = el('q');
const qImg = el('q-img');
const go = el('go');
const clearBtn = el('clear');
const th = el('th');
const thval = el('thval');
const results = el('results');

// Tagging UI elements
const selectionModeEl = el('selection-mode');
const selectedCountEl = el('selected-count');
const clearSelectionBtn = el('clear-selection');
const newTagInput = el('new-tag');
const addTagBtn = el('add-tag-btn');
const removeTagBtn = el('remove-tag-btn');
const currentTagsEl = el('current-tags');
const colorModeEl = el('color-mode');
const tagFilterEl = el('tag-filter');
const allTagsEl = el('all-tags');

const previewPanel = el('preview-panel');
const previewTable = el('preview-table');

// Image upload elements
const showImageUploadBtn = el('show-image-upload-btn');
const imageUploadSection = el('image-upload-section');
const dropZone = el('drop-zone');
const imageFilesInput = el('image-files');
const imageGrid = el('image-grid');
const imageActions = el('image-actions');
const embedImagesBtn = el('embed-images-btn');
const clearImagesBtn = el('clear-images-btn');

let uploadedImages = [];  // Array of {file, dataUrl, name, type: 'image'|'video'}
let dataSource = 'csv';  // 'csv' or 'images'

const MAX_PREVIEW_ROWS = 100;

// Hardcoded node size - good default for UMAP coordinate space
const DEFAULT_NODE_SIZE = 0.05;

const viz = el('viz');

const colors = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff', '#9a6324', '#fffac8', '#800000', '#aaffc3', '#808000', '#ffd8b1', '#000075', '#808080', '#ffffff', '#000000'];

const setBar = (pct, text) => { bar.style.width = `${pct}%`; bar.textContent = `${Math.round(pct)}%`; ptext.textContent = text || ''; };
const esc = (s) => { const d = document.createElement('div'); d.textContent = (s == null ? '' : String(s)); return d.innerHTML; };
const hexToRgb = (hex) => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) } : { r: 0, g: 0, b: 0 };
};

const renderPreview = (data, columns) => {
  if (!previewPanel || !previewTable) return;

  if (!data || data.length === 0) {
    previewTable.innerHTML = '<div class="muted small">No data rows to preview yet.</div>';
    previewPanel.style.display = 'block';
    return;
  }

  const rows = data.slice(0, MAX_PREVIEW_ROWS);
  const safeColumns = columns && columns.length ? columns : Object.keys(rows[0] || {});

  const header = safeColumns.map(col => `<th>${esc(col)}</th>`).join('');
  const body = rows.map((row, idx) => {
    const cells = safeColumns.map(col => {
      const value = row[col];
      const safeVal = value == null ? '' : String(value);
      return `<td title="${esc(safeVal)}">${esc(safeVal)}</td>`;
    }).join('');
    return `<tr><td class="preview-row-num">${idx + 1}</td>${cells}</tr>`;
  }).join('');

  previewTable.innerHTML = `
    <table class="preview-table">
      <thead><tr><th>#</th>${header}</tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  previewPanel.style.display = 'block';
};

const hidePreview = () => {
  if (!previewPanel || !previewTable) return;
  previewPanel.style.display = 'none';
  previewTable.innerHTML = '';
};

// Helper function to flatten various NDJSON structures (Zeeschuimer exports: Instagram, Twitter/X, TikTok)
// Auto-detects platform and extracts data with fallbacks
function flattenNdjsonData(row) {
  const flattened = {};
  const data = row.data || {};
  const metadata = row;

  // Preserve all top-level metadata fields
  Object.keys(metadata).forEach(key => {
    if (key !== 'data') {
      flattened[key] = metadata[key];
    }
  });

  // Helper function to safely get nested values
  const safeGet = (obj, path, defaultValue = '') => {
    if (!obj) return defaultValue;
    const keys = path.split('.');
    let current = obj;
    for (const key of keys) {
      if (current && typeof current === 'object' && current !== null) {
        current = current[key];
      } else {
        return defaultValue;
      }
    }
    return current === undefined || current === null ? defaultValue : current;
  };

  // Detect platform based on data structure
  const detectPlatform = () => {
    // Check source_platform metadata first
    const sourcePlatform = (metadata.source_platform || '').toLowerCase();
    if (sourcePlatform.includes('twitter') || sourcePlatform.includes('x.com')) return 'twitter';
    if (sourcePlatform.includes('instagram')) return 'instagram';
    if (sourcePlatform.includes('tiktok')) return 'tiktok';

    // Fallback to structure detection
    if (data.__typename === 'Tweet' || data.legacy?.full_text) return 'twitter';
    if (data.author?.uniqueId || data.video?.playAddr) return 'tiktok';
    if (data.caption?.text || data.owner?.username || data.image_versions2) return 'instagram';

    return 'unknown';
  };

  const platform = detectPlatform();
  flattened._detected_platform = platform;

  // Extract text content based on platform
  const extractText = () => {
    // Twitter/X - text is in legacy.full_text
    if (platform === 'twitter') {
      return safeGet(data, 'legacy.full_text', '') ||
        safeGet(data, 'full_text', '') ||
        safeGet(data, 'text', '') || '';
    }

    // TikTok - text is in desc or contents[0].desc
    if (platform === 'tiktok') {
      return data.desc ||
        safeGet(data, 'contents.0.desc', '') ||
        '';
    }

    // Instagram - text is in caption.text
    if (platform === 'instagram') {
      return safeGet(data, 'caption.text', '') ||
        data.accessibility_caption ||
        '';
    }

    // Generic fallback - try all common paths
    return safeGet(data, 'legacy.full_text', '') ||
      safeGet(data, 'caption.text', '') ||
      data.desc ||
      safeGet(data, 'text', '') ||
      safeGet(data, 'full_text', '') ||
      safeGet(data, 'body', '') || '';
  };

  // Extract user information based on platform
  const extractUser = () => {
    // Twitter/X - user is in core.user_results.result
    if (platform === 'twitter') {
      const user = safeGet(data, 'core.user_results.result', {});
      const legacy = user.legacy || {};
      const core = user.core || {};
      return {
        username: core.screen_name || legacy.screen_name || user.screen_name || '',
        full_name: core.name || legacy.name || user.name || '',
        profile_pic_url: safeGet(user, 'avatar.image_url', '') ||
          legacy.profile_image_url_https ||
          user.profile_image_url_https || '',
        followers_count: legacy.followers_count || user.followers_count || 0,
        verified: user.is_blue_verified || legacy.verified || user.verified || false,
        description: safeGet(user, 'profile_bio.description', '') || legacy.description || ''
      };
    }

    // TikTok - user is in author
    if (platform === 'tiktok') {
      const author = data.author || {};
      const stats = data.authorStats || {};
      return {
        username: author.uniqueId || '',
        full_name: author.nickname || '',
        profile_pic_url: author.avatarMedium || author.avatarThumb || author.avatarLarger || '',
        followers_count: stats.followerCount || 0,
        verified: author.verified || false,
        description: author.signature || ''
      };
    }

    // Instagram - user is in owner or user
    if (platform === 'instagram') {
      const owner = data.owner || data.user || {};
      return {
        username: owner.username || '',
        full_name: owner.full_name || '',
        profile_pic_url: owner.profile_pic_url || safeGet(owner, 'hd_profile_pic_url_info.url', '') || '',
        followers_count: owner.follower_count || 0,
        verified: owner.is_verified || false,
        description: ''
      };
    }

    // Generic fallback
    return {
      username: safeGet(data, 'username', '') || safeGet(data, 'screen_name', ''),
      full_name: safeGet(data, 'name', '') || safeGet(data, 'full_name', ''),
      profile_pic_url: safeGet(data, 'profile_pic_url', '') || safeGet(data, 'profile_image_url', ''),
      followers_count: 0,
      verified: false,
      description: ''
    };
  };

  // Extract media (images/videos) based on platform
  const extractMedia = () => {
    const media = [];

    // Twitter/X - media is in legacy.entities.media or legacy.extended_entities.media
    if (platform === 'twitter') {
      const legacyMedia = safeGet(data, 'legacy.entities.media', []) || [];
      const extendedMedia = safeGet(data, 'legacy.extended_entities.media', []) || [];
      const allMedia = extendedMedia.length > 0 ? extendedMedia : legacyMedia;

      if (Array.isArray(allMedia)) {
        allMedia.forEach(m => {
          media.push({
            type: m.type || 'photo',
            url: m.media_url_https || m.media_url || '',
            video_url: safeGet(m, 'video_info.variants.0.url', '') || '',
            alt_text: m.ext_alt_text || ''
          });
        });
      }
    }

    // TikTok - video cover and playback URL
    if (platform === 'tiktok') {
      const video = data.video || {};
      if (video.cover || video.originCover) {
        media.push({
          type: 'video',
          url: video.cover || video.originCover || video.dynamicCover || '',
          video_url: video.playAddr || safeGet(video, 'PlayAddrStruct.UrlList.0', '') || '',
          alt_text: ''
        });
      }
    }

    // Instagram - images in image_versions2, videos in video_versions
    if (platform === 'instagram') {
      // Single image
      const candidates = safeGet(data, 'image_versions2.candidates', []);
      if (Array.isArray(candidates) && candidates.length > 0) {
        media.push({
          type: 'photo',
          url: candidates[0].url || '',
          video_url: '',
          alt_text: data.accessibility_caption || ''
        });
      }

      // Video
      const videoVersions = data.video_versions || [];
      if (Array.isArray(videoVersions) && videoVersions.length > 0) {
        media.push({
          type: 'video',
          url: candidates[0]?.url || '', // thumbnail
          video_url: videoVersions[0].url || '',
          alt_text: ''
        });
      }

      // Carousel media
      const carousel = data.carousel_media || [];
      if (Array.isArray(carousel)) {
        carousel.forEach(item => {
          const itemCandidates = safeGet(item, 'image_versions2.candidates', []);
          if (itemCandidates.length > 0) {
            media.push({
              type: 'photo',
              url: itemCandidates[0].url || '',
              video_url: '',
              alt_text: ''
            });
          }
          const itemVideos = item.video_versions || [];
          if (itemVideos.length > 0) {
            media.push({
              type: 'video',
              url: itemCandidates[0]?.url || '',
              video_url: itemVideos[0].url || '',
              alt_text: ''
            });
          }
        });
      }
    }

    return media;
  };

  // Extract engagement metrics based on platform
  const extractMetrics = () => {
    // Twitter/X - metrics in legacy object and views
    if (platform === 'twitter') {
      const legacy = data.legacy || {};
      return {
        favorites_count: legacy.favorite_count || 0,
        retweet_count: legacy.retweet_count || 0,
        reply_count: legacy.reply_count || 0,
        quote_count: legacy.quote_count || 0,
        view_count: parseInt(safeGet(data, 'views.count', '0')) || 0,
        share_count: 0,
        play_count: 0
      };
    }

    // TikTok - metrics in stats object
    if (platform === 'tiktok') {
      const stats = data.stats || data.statsV2 || {};
      return {
        favorites_count: parseInt(stats.diggCount) || 0,
        retweet_count: 0,
        reply_count: parseInt(stats.commentCount) || 0,
        quote_count: 0,
        view_count: parseInt(stats.playCount) || 0,
        share_count: parseInt(stats.shareCount) || 0,
        play_count: parseInt(stats.playCount) || 0
      };
    }

    // Instagram - metrics directly on data object
    if (platform === 'instagram') {
      return {
        favorites_count: data.like_count || 0,
        retweet_count: 0,
        reply_count: data.comment_count || 0,
        quote_count: 0,
        view_count: data.view_count || data.play_count || 0,
        share_count: 0,
        play_count: data.play_count || 0
      };
    }

    // Generic fallback
    return {
      favorites_count: 0,
      retweet_count: 0,
      reply_count: 0,
      quote_count: 0,
      view_count: 0,
      share_count: 0,
      play_count: 0
    };
  };

  // Extract hashtags based on platform
  const extractHashtags = () => {
    const hashtags = [];

    if (platform === 'twitter') {
      const entities = safeGet(data, 'legacy.entities.hashtags', []);
      if (Array.isArray(entities)) {
        entities.forEach(h => hashtags.push(h.text || ''));
      }
    }

    if (platform === 'tiktok') {
      const challenges = data.challenges || [];
      if (Array.isArray(challenges)) {
        challenges.forEach(c => hashtags.push(c.title || ''));
      }
      const textExtra = data.textExtra || [];
      if (Array.isArray(textExtra)) {
        textExtra.forEach(t => {
          if (t.hashtagName) hashtags.push(t.hashtagName);
        });
      }
    }

    // Instagram hashtags are typically in caption text, extract them
    if (platform === 'instagram') {
      const caption = safeGet(data, 'caption.text', '');
      const matches = caption.match(/#[\w\u00C0-\u024F]+/g) || [];
      matches.forEach(m => hashtags.push(m.replace('#', '')));
    }

    return [...new Set(hashtags)]; // Remove duplicates
  };

  // Extract timestamp based on platform
  const extractTimestamp = () => {
    if (platform === 'twitter') {
      return safeGet(data, 'legacy.created_at', '') || '';
    }
    if (platform === 'tiktok') {
      const ts = data.createTime;
      if (ts) {
        // Convert Unix timestamp to ISO string
        return new Date(ts * 1000).toISOString();
      }
      return '';
    }
    if (platform === 'instagram') {
      const ts = data.taken_at;
      if (ts) {
        return new Date(ts * 1000).toISOString();
      }
      return '';
    }
    return safeGet(data, 'created_at', '') || safeGet(data, 'timestamp', '') || '';
  };

  // Build flattened object
  flattened.text = extractText();
  flattened.caption = flattened.text; // Alias for compatibility

  const userInfo = extractUser();
  flattened.username = userInfo.username;
  flattened.full_name = userInfo.full_name;
  flattened.profile_pic_url = userInfo.profile_pic_url;
  flattened.followers_count = userInfo.followers_count;
  flattened.verified = userInfo.verified;
  flattened.user_description = userInfo.description;

  flattened.id = data.id || data.rest_id || data.pk || safeGet(data, 'legacy.id_str', '') || '';
  flattened.post_type = data.__typename || data.media_type || (data.video ? 'video' : 'photo') || '';

  // Handle media URLs
  const mediaItems = extractMedia();
  if (mediaItems.length > 0) {
    const firstMedia = mediaItems[0];
    flattened.image_url = firstMedia.url || '';
    flattened.video_url = firstMedia.video_url || '';
    flattened.alt_text = firstMedia.alt_text || '';
  } else {
    flattened.image_url = '';
    flattened.video_url = '';
    flattened.alt_text = '';
  }

  flattened.has_media = mediaItems.length > 0;
  flattened.media_count = mediaItems.length;
  flattened.all_media = JSON.stringify(mediaItems);

  // Extract metrics
  const metrics = extractMetrics();
  flattened.favorites_count = metrics.favorites_count;
  flattened.likes = metrics.favorites_count; // Alias
  flattened.retweets = metrics.retweet_count;
  flattened.comments = metrics.reply_count;
  flattened.views = metrics.view_count;
  flattened.shares = metrics.share_count;
  flattened.plays = metrics.play_count;

  // Extract hashtags
  const hashtags = extractHashtags();
  flattened.hashtags = hashtags.join(', ');
  flattened.hashtags_array = JSON.stringify(hashtags);

  // Extract timestamp
  flattened.created_at = extractTimestamp();

  // Metadata fields
  flattened._original_data = data;
  flattened._nav_index = metadata.nav_index || '';
  flattened._item_id = metadata.item_id || metadata.id || '';
  flattened._timestamp_collected = metadata.timestamp_collected || '';
  flattened._source_platform = metadata.source_platform || '';

  return flattened;
}

function resetState() {
  embeddings = []; coords = []; clusters = []; nodes = [];
  searchVec = null; highlightedNodes = new Set(); selectedNodes = new Set();
  allTags = new Map(); tagColors = {};
  if (deckInstance) { deckInstance.finalize(); deckInstance = null; }
  if (worker) { worker.terminate(); worker = null; }
  workerReady = false;
  el('viz').style.display = 'none';
  el('search').style.display = 'none';
  saveBtn.disabled = true;
  results.textContent = '';
}

fileInput.addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  resetState();
  dataSource = 'csv';

  // Check if file is NDJSON (.ndjson or .jsonl extension)
  const fileName = f.name.toLowerCase();
  const isNdjson = fileName.endsWith('.ndjson') || fileName.endsWith('.jsonl');

  // Use streaming for files larger than 5MB
  const STREAMING_THRESHOLD = 5 * 1024 * 1024;
  const useStreaming = f.size > STREAMING_THRESHOLD;

  // Show loading indicator for large files
  if (useStreaming) {
    fileInfo.innerHTML = `<strong>Loading:</strong> ${esc(f.name)} (${(f.size / 1024 / 1024).toFixed(1)} MB)...`;
  }

  if (isNdjson) {
    try {
      if (useStreaming) {
        // Use streaming parser for large NDJSON files
        const result = await parseNDJSONStreaming(f, (pct, msg) => {
          fileInfo.innerHTML = `<strong>Parsing:</strong> ${esc(f.name)} - ${msg}`;
        });
        csv = result.data;
        fields = result.fields;
      } else {
        // Small file - parse in memory
        const text = await f.text();
        const lines = text.split('\n').filter(line => line.trim() !== '');
        const parsed = lines.map(line => {
          try { return JSON.parse(line); }
          catch (err) { return null; }
        }).filter(row => row !== null);

        csv = parsed.map(flattenNdjsonData);

        const fieldSet = new Set();
        csv.forEach(row => Object.keys(row).forEach(key => fieldSet.add(key)));
        fields = Array.from(fieldSet);
      }

      // Count detected platforms
      const platformCounts = {};
      csv.forEach(row => {
        const p = row._detected_platform || 'unknown';
        platformCounts[p] = (platformCounts[p] || 0) + 1;
      });
      const platformStr = Object.entries(platformCounts)
        .map(([p, count]) => `${p}: ${count}`)
        .join(', ');

      fileInfo.innerHTML = `<strong>File:</strong> ${esc(f.name)} · <strong>Type:</strong> NDJSON · <strong>Rows:</strong> ${csv.length.toLocaleString()} · <strong>Platform(s):</strong> ${platformStr}`;
      populateColumnSelectors();

      // Auto-select useful columns for social media NDJSON
      if (fields.includes('text')) textCol.value = 'text';
      if (fields.includes('username')) labelCol.value = 'username';
      if (fields.includes('image_url')) imageCol.value = 'image_url';
      if (fields.includes('video_url')) videoCol.value = 'video_url';

      renderPreview(csv, fields);
      showCSVConfig();
      updateUI();
      configPanel.style.display = 'block';
    } catch (err) {
      alert('Error parsing NDJSON file: ' + err.message);
      return;
    }
  } else {
    // CSV file
    try {
      if (useStreaming) {
        // Use streaming parser for large CSV files
        const result = await parseCSVStreaming(f, (pct, msg) => {
          fileInfo.innerHTML = `<strong>Parsing:</strong> ${esc(f.name)} - ${msg}`;
        });
        csv = result.data;
        fields = result.fields;

        fileInfo.innerHTML = `<strong>File:</strong> ${esc(f.name)} · <strong>Rows:</strong> ${csv.length.toLocaleString()}`;
        populateColumnSelectors();
        renderPreview(csv, fields);
        showCSVConfig();
        updateUI();
        configPanel.style.display = 'block';
      } else {
        // Small file - parse synchronously
        Papa.parse(f, {
          header: true,
          skipEmptyLines: true,
          complete: (res) => {
            csv = res.data;
            fields = res.meta.fields || Object.keys(csv[0] || {});
            fileInfo.innerHTML = `<strong>File:</strong> ${esc(f.name)} · <strong>Rows:</strong> ${csv.length.toLocaleString()}`;
            populateColumnSelectors();
            renderPreview(csv, fields);
            showCSVConfig();
            updateUI();
            configPanel.style.display = 'block';
          }
        });
      }
    } catch (err) {
      alert('Error parsing CSV file: ' + err.message);
    }
  }
});

function populateColumnSelectors() {
  [textCol, labelCol, linkCol, imageCol, videoCol].forEach(sel => { sel.innerHTML = ''; });
  fields.forEach(col => {
    textCol.appendChild(new Option(col, col));
    labelCol.appendChild(new Option(col, col));
    linkCol.appendChild(new Option(col, col));
    imageCol.appendChild(new Option(col, col));
    videoCol.appendChild(new Option(col, col));
  });
  textCol.prepend(new Option('None', ''));
  labelCol.prepend(new Option('None', ''));
  linkCol.prepend(new Option('None', ''));
  imageCol.prepend(new Option('None', ''));
  videoCol.prepend(new Option('None', ''));
}

loadSavedBtn.addEventListener('click', () => embFile.click());
embFile.addEventListener('change', async (e) => {
  const f = e.target.files?.[0]; if (!f) return;
  dataSource = 'csv';
  const txt = await f.text();
  const data = JSON.parse(txt);
  csv = data.csv; fields = Object.keys(csv[0] || {});
  cfg = data.cfg; embeddings = data.embeddings; coords = data.coords; clusters = data.clusters;
  if (!cfg._embedMode) { cfg._embedMode = cfg.mode; }
  cfg.imageEmbedder = cfg.imageEmbedder || 'Xenova/clip-vit-base-patch32';
  computeEmbedMetadata(cfg);

  if (data.tags) {
    allTags = new Map(Object.entries(data.tags.allTags || {}).map(([tag, ids]) => [tag, new Set(ids)]));
    tagColors = data.tags.tagColors || {};
  } else {
    allTags = new Map();
    tagColors = {};
  }

  [textCol, labelCol, linkCol, imageCol, videoCol].forEach(sel => { sel.innerHTML = ''; });
  fields.forEach(col => {
    textCol.appendChild(new Option(col, col));
    labelCol.appendChild(new Option(col, col));
    linkCol.appendChild(new Option(col, col));
    imageCol.appendChild(new Option(col, col));
    videoCol.appendChild(new Option(col, col));
  });
  textCol.value = cfg.text || '';
  labelCol.value = cfg.label || '';
  linkCol.value = cfg.link || '';
  imageCol.value = cfg.image || '';
  videoCol.value = cfg.video || '';
  if (imageEmbedderSel) imageEmbedderSel.value = cfg.imageEmbedder || 'Xenova/clip-vit-base-patch32';
  kInput.value = cfg.k || 5;
  batchInput.value = cfg.batch || 16;
  if (videoFpsInput) videoFpsInput.value = cfg.videoFps || 1;
  if (videoMaxFramesInput) videoMaxFramesInput.value = cfg.videoMaxFrames || 30;
  renderPreview(csv, fields);
  showCSVConfig();
  updateUI();

  await buildNodesAndViz();

  if (data.tags && data.tags.nodeTags) {
    data.tags.nodeTags.forEach((tagArray, i) => {
      if (nodes[i]) {
        nodes[i].tags = new Set(tagArray || []);
      }
    });
  }

  updateTagUI();

  el('search').style.display = 'block';
  viz.style.display = 'flex';
  saveBtn.disabled = false;
  updateQueryAvailability();

  if (!worker) {
    worker = createWorker();
    workerReady = false;
    setupWorkerHandlers();
  }
});

saveBtn.addEventListener('click', () => {
  const tagsData = {
    allTags: Object.fromEntries(Array.from(allTags.entries()).map(([tag, ids]) => [tag, Array.from(ids)])),
    tagColors: tagColors,
    nodeTags: nodes.map(n => n.tags ? Array.from(n.tags) : [])
  };

  const payload = {
    version: '2.1',
    timestamp: new Date().toISOString(),
    csv,
    cfg,
    embeddings,
    coords,
    clusters,
    tags: tagsData
  };

  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `embeddings_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  saveMsg.style.display = 'block';
  saveMsg.textContent = `✅ Saved ${embeddings.length} vectors + tags.`;
  setTimeout(() => saveMsg.style.display = 'none', 2500);
});

showImageUploadBtn?.addEventListener('click', () => {
  imageUploadSection.style.display = 'block';
  showImageUploadBtn.style.display = 'none';
});

dropZone?.addEventListener('click', () => imageFilesInput?.click());

dropZone?.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone?.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone?.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/') || f.type.startsWith('video/'));
  if (files.length > 0) handleImageFiles(files);
});

imageFilesInput?.addEventListener('change', (e) => {
  const files = Array.from(e.target.files);
  if (files.length > 0) handleImageFiles(files);
});

async function handleImageFiles(files) {
  for (const file of files) {
    const dataUrl = await fileToDataUrl(file);
    const type = file.type.startsWith('video/') ? 'video' : 'image';
    uploadedImages.push({ file, dataUrl, name: file.name, type });
  }
  renderImageGrid();
  imageGrid.style.display = 'grid';
  imageActions.style.display = 'flex';
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function renderImageGrid() {
  imageGrid.innerHTML = uploadedImages.map((item, i) => {
    if (item.type === 'video') {
      return `<div class="image-item"><video src="${item.dataUrl}" title="${esc(item.name)}" style="width:100%;height:100%;object-fit:cover"></video><div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:24px;color:white;text-shadow:0 0 4px black;pointer-events:none">▶</div><button class="remove-btn" data-index="${i}">×</button></div>`;
    } else {
      return `<div class="image-item"><img src="${item.dataUrl}" alt="${esc(item.name)}" title="${esc(item.name)}"><button class="remove-btn" data-index="${i}">×</button></div>`;
    }
  }).join('');

  imageGrid.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      uploadedImages.splice(idx, 1);
      renderImageGrid();
      if (uploadedImages.length === 0) {
        imageGrid.style.display = 'none';
        imageActions.style.display = 'none';
      }
    });
  });
}

clearImagesBtn?.addEventListener('click', () => {
  uploadedImages = [];
  imageGrid.innerHTML = '';
  imageGrid.style.display = 'none';
  imageActions.style.display = 'none';
  imageUploadSection.style.display = 'none';
  showImageUploadBtn.style.display = 'block';
  imageFilesInput.value = '';
});

embedImagesBtn?.addEventListener('click', () => {
  if (uploadedImages.length === 0) {
    alert('Please add some images or videos first!');
    return;
  }

  dataSource = 'images';
  const hasImages = uploadedImages.some(item => item.type === 'image');
  const hasVideos = uploadedImages.some(item => item.type === 'video');

  csv = uploadedImages.map((item, i) => {
    const row = { label: item.name, link: '', text: '' };
    if (item.type === 'image') {
      row.__imageData = item.dataUrl;
      row.__videoData = '';
    } else {
      row.__imageData = '';
      row.__videoData = item.dataUrl;
    }
    return row;
  });

  fields = ['__imageData', '__videoData', 'label', 'link', 'text'];
  cfg.label = 'label';
  cfg.link = null;
  cfg.text = null;
  cfg.mode = 'multimodal';

  if (hasImages && hasVideos) {
    cfg.image = '__imageData';
    cfg.video = '__videoData';
    cfg.source = 'image';
    fileInfo.innerHTML = `✅ Loaded ${uploadedImages.length} files (${uploadedImages.filter(i => i.type === 'image').length} images, ${uploadedImages.filter(i => i.type === 'video').length} videos) • Configure settings below`;
  } else if (hasVideos) {
    cfg.image = null;
    cfg.video = '__videoData';
    cfg.source = 'video';
    fileInfo.innerHTML = `✅ Loaded ${uploadedImages.length} video${uploadedImages.length > 1 ? 's' : ''} • Configure settings below`;
  } else {
    cfg.image = '__imageData';
    cfg.video = null;
    cfg.source = 'image';
    fileInfo.innerHTML = `✅ Loaded ${uploadedImages.length} image${uploadedImages.length > 1 ? 's' : ''} • Configure settings below`;
  }

  fileInfo.style.display = 'block';
  [textCol, labelCol, linkCol, imageCol, videoCol].forEach(sel => { sel.innerHTML = ''; });
  fields.forEach(col => {
    textCol.appendChild(new Option(col, col));
    labelCol.appendChild(new Option(col, col));
    linkCol.appendChild(new Option(col, col));
    imageCol.appendChild(new Option(col, col));
    videoCol.appendChild(new Option(col, col));
  });
  textCol.prepend(new Option('None', ''));
  labelCol.prepend(new Option('None', ''));
  linkCol.prepend(new Option('None', ''));
  imageCol.prepend(new Option('None', ''));
  videoCol.prepend(new Option('None', ''));

  imageCol.value = cfg.image || '';
  videoCol.value = cfg.video || '';
  labelCol.value = 'label';
  textCol.value = '';
  linkCol.value = '';

  showImageConfig();
  configPanel.style.display = 'block';

  if (imageEmbedderSel) imageEmbedderSel.value = 'Xenova/clip-vit-base-patch32';

  updateUI();
});

function showCSVConfig() {
  const columnRow = document.getElementById('column-config-row');
  const modeWrapper = document.getElementById('mode-select-wrapper');
  const sourceWrapper = document.getElementById('source-select-wrapper');
  const configTitle = document.getElementById('config-title');
  if (columnRow) columnRow.style.display = 'grid';
  if (modeWrapper) modeWrapper.style.display = 'block';
  if (sourceWrapper) sourceWrapper.style.display = 'block';
  if (configTitle) configTitle.textContent = '2) Configure columns & model';
}

function showImageConfig() {
  const columnRow = document.getElementById('column-config-row');
  const modeWrapper = document.getElementById('mode-select-wrapper');
  const sourceWrapper = document.getElementById('source-select-wrapper');
  const configTitle = document.getElementById('config-title');
  const imageEmbedderRow = document.getElementById('image-embedder-row');
  if (columnRow) columnRow.style.display = 'none';
  if (modeWrapper) modeWrapper.style.display = 'none';
  if (sourceWrapper) sourceWrapper.style.display = 'none';
  if (imageEmbedderRow) imageEmbedderRow.style.display = 'block';
  if (configTitle) configTitle.textContent = '2) Configure image embedding';
}

const updateUI = () => {
  const hasVideo = videoCol.value && videoCol.value !== '';

  if (imageEmbedderSel) {
    const row = document.getElementById('image-embedder-row');
    if (row) {
      row.style.display = 'block';
    }
  }

  const videoRow = document.getElementById('video-processing-row');
  if (videoRow) {
    videoRow.style.display = hasVideo ? 'block' : 'none';
  }
};

const computeEmbedMetadata = (config) => {
  config._embedFamily = config.mode === 'text' ? 'text' : 'clip';
  config._embedHasImage = config.mode === 'multimodal';
  config._embedHasVideo = config.mode === 'multimodal' && config.source === 'video';
  config._embedHasText = config.mode === 'text' || config.mode === 'multimodal';
  return config;
};

const updateQueryAvailability = () => {
  const canImageQuery = !!cfg._embedHasImage;
  const canTextQuery = !!cfg._embedHasText;

  if (queryType?.options?.length >= 2) {
    queryType.options[0].disabled = !canTextQuery;
    queryType.options[1].disabled = !canImageQuery;

    if (queryType.value === 'image' && !canImageQuery) queryType.value = 'text';
    if (queryType.value === 'text' && !canTextQuery) queryType.value = 'image';
  }

  const isImageQuery = queryType.value === 'image';
  q.style.display = isImageQuery ? 'none' : 'block';
  qImg.style.display = isImageQuery ? 'block' : 'none';
};

textCol.addEventListener('change', updateUI);
imageCol.addEventListener('change', updateUI);
videoCol.addEventListener('change', updateUI);
imageEmbedderSel?.addEventListener('change', updateUI);

processBtn.addEventListener('click', async () => {
  cfg.text = textCol.value || null;
  cfg.label = labelCol.value || null;
  cfg.link = linkCol.value || null;
  cfg.image = imageCol.value || null;
  cfg.video = videoCol.value || null;
  cfg.k = parseInt(kInput.value || '5', 10);
  cfg.batch = parseInt(batchInput.value || '16', 10);
  cfg.imageEmbedder = imageEmbedderSel?.value || 'Xenova/clip-vit-base-patch32';
  cfg.videoFps = parseFloat(videoFpsInput?.value || '1');
  cfg.videoMaxFrames = parseInt(videoMaxFramesInput?.value || '30', 10);

  if (!cfg.text && !cfg.image && !cfg.video) { alert('Please select at least a text, image, or video column.'); return; }

  cfg.mode = 'multimodal';
  cfg.source = 'both';

  computeEmbedMetadata(cfg);
  hidePreview();
  configPanel.style.display = 'none';
  progressPanel.style.display = 'block';
  setBar(2, 'Preparing data...');

  cfg._embedMode = cfg.mode;
  const items = buildItems(csv, cfg);

  // Handle video frame extraction if needed
  if (cfg.source === 'video' && cfg.video) {
    const videoItems = items.filter(item => item.video && item.video.trim() !== '');
    const totalVideos = videoItems.length;
    if (totalVideos > 0) {
      setBar(5, `Extracting frames from ${totalVideos} video${totalVideos > 1 ? 's' : ''}...`);
      let processedCount = 0;
      for (const item of items) {
        if (item.video && item.video.trim() !== '') {
          processedCount++;
          try {
            setBar(5 + (processedCount / totalVideos) * 7, `Extracting frames: Video ${processedCount}/${totalVideos}`);
            const frames = await extractFramesFromVideo(
              item.video,
              cfg.videoFps || 1,
              cfg.videoMaxFrames || 30,
              (frameNum, totalFrames) => {
                const videoProgress = (processedCount - 1) / totalVideos;
                const frameProgress = (frameNum / totalFrames) / totalVideos;
                const pct = 5 + (videoProgress + frameProgress) * 7;
                setBar(pct, `Video ${processedCount}/${totalVideos}: Frame ${frameNum}/${totalFrames}`);
              }
            );
            item.videoFrames = frames;
          } catch (err) {
            console.warn('Failed to extract frames from video:', item.video, err.message);
            item.videoFrames = [];
          }
        }
      }
    }
  }

  cancelBtn.disabled = false;

  // Use worker pool for datasets with >100 items, single worker for smaller
  const USE_POOL_THRESHOLD = 100;
  const usePool = items.length > USE_POOL_THRESHOLD && cfg.source !== 'video'; // Video processing doesn't benefit from pooling

  if (usePool) {
    setBar(3, `Using ${WORKER_POOL_SIZE} parallel workers for ${items.length.toLocaleString()} items...`);

    try {
      const poolEmbeddings = await runWithWorkerPool(cfg, items, (pct, msg) => {
        setBar(pct, msg);
      });

      embeddings = poolEmbeddings;
      terminateWorkerPool();

      // Continue with UMAP and clustering
      setBar(96, 'Running UMAP...');
      await new Promise(r => setTimeout(r, 50));

      const umap = new UMAP.UMAP({ nNeighbors: Math.min(15, items.length - 1), minDist: 0.1, nComponents: 2 });
      coords = umap.fit(embeddings);

      setBar(98, 'Clustering...');
      clusters = kMeans(coords, cfg.k || 5);

      setBar(100, 'Building visualization...');
      await buildNodesAndViz();

      progressPanel.style.display = 'none';
      updateTagUI();

      el('search').style.display = 'block';
      viz.style.display = 'flex';
      saveBtn.disabled = false;
      updateQueryAvailability();

      // Create a worker for queries
      if (!worker) {
        worker = createWorker();
        workerReady = false;
        setupWorkerHandlers();
      }

    } catch (err) {
      alert('Embedding error: ' + err.message);
      terminateWorkerPool();
      progressPanel.style.display = 'none';
      configPanel.style.display = 'block';
    }

  } else {
    // Use single worker for smaller datasets or video
    setBar(4, 'Loading worker & model...');

    if (worker) { worker.terminate(); worker = null; }
    worker = createWorker();
    workerReady = false;
    setupWorkerHandlers();

    worker.postMessage({ type: 'start', cfg, items });
  }
});

cancelBtn.addEventListener('click', () => {
  if (worker) { worker.terminate(); worker = null; }
  terminateWorkerPool(); // Also terminate any pool workers
  progressPanel.style.display = 'none';
  configPanel.style.display = 'block';
  if (csv?.length) renderPreview(csv, fields);
});

queryType.addEventListener('change', () => {
  const isImageQuery = queryType.value === 'image';
  q.style.display = isImageQuery ? 'none' : 'block';
  qImg.style.display = isImageQuery ? 'block' : 'none';

  if (isImageQuery && !cfg._embedHasImage) {
    alert('Image search only works when embeddings include images.');
    queryType.value = 'text';
    q.style.display = 'block';
    qImg.style.display = 'none';
  }
});

function rerunSearch() {
  if (!searchVec || !embeddings.length) return;
  const thr = parseFloat(th.value);
  const sims = embeddings.map((e, i) => ({ i, s: cosSim(searchVec, e) }))
    .filter(o => o.s >= thr)
    .sort((a, b) => b.s - a.s);
  paintMatches(new Set(sims.map(o => o.i)));

  if (sims.length === 0) {
    results.innerHTML = 'No matches — try lowering threshold.';
    return;
  }

  results.innerHTML = `Found ${sims.length} matches (top 10):<br><br>`;
  const resultList = document.createElement('div');
  resultList.style.display = 'flex';
  resultList.style.flexDirection = 'column';
  resultList.style.gap = '8px';

  sims.slice(0, 10).forEach(o => {
    const lab = cfg.label ? csv[o.i][cfg.label] : `Row ${o.i + 1}`;
    const resultItem = document.createElement('div');
    resultItem.style.cursor = 'pointer';
    resultItem.style.padding = '6px';
    resultItem.style.borderRadius = '4px';
    resultItem.style.transition = 'background 0.2s';
    resultItem.innerHTML = `<b>${esc(lab)}</b> — sim ${o.s.toFixed(3)}`;

    resultItem.addEventListener('mouseenter', () => { resultItem.style.background = '#e8ecff'; });
    resultItem.addEventListener('mouseleave', () => { resultItem.style.background = 'transparent'; });
    resultItem.addEventListener('click', () => {
      paintMatches(new Set([o.i]));
      resultList.querySelectorAll('div').forEach(el => {
        el.style.fontWeight = 'normal';
        el.style.background = 'transparent';
      });
      resultItem.style.fontWeight = 'bold';
      resultItem.style.background = '#e8ecff';

      if (deckInstance && nodes[o.i] && currentViewState) {
        const node = nodes[o.i];
        const [x, y] = node.position;
        currentViewState = {
          ...currentViewState,
          target: [x, y, 0],
          zoom: currentViewState.zoom + 3,
          transitionDuration: 500,
          transitionInterpolator: new LinearInterpolator(['target', 'zoom'])
        };
        deckInstance.setProps({ viewState: currentViewState });
      }
    });

    resultList.appendChild(resultItem);
  });

  results.appendChild(resultList);
}

th.addEventListener('input', () => {
  thval.textContent = Number(th.value).toFixed(2);
  if (searchVec) rerunSearch();
});

go.addEventListener('click', async () => {
  const isImageQuery = queryType.value === 'image';

  if (isImageQuery) {
    const file = qImg.files?.[0];
    if (!file) {
      alert('Please select an image file');
      return;
    }

    if (!worker) {
      worker = createWorker();
      workerReady = false;
      setupWorkerHandlers();
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const imageDataUrl = e.target.result;
      const queryMode = cfg._embedMode || cfg.mode;
      worker.postMessage({ type: 'encodeQuery', image: imageDataUrl, cfg: { ...cfg, mode: queryMode, query: true } });
    };
    reader.readAsDataURL(file);
  } else {
    const queryInput = q.value.trim();
    if (!queryInput) {
      alert('Enter a query');
      return;
    }

    if (!worker) {
      worker = createWorker();
      workerReady = false;
      setupWorkerHandlers();
    }

    const queryMode = cfg._embedMode || cfg.mode;
    worker.postMessage({ type: 'encodeQuery', text: queryInput, cfg: { ...cfg, mode: queryMode, query: true } });
  }
});

clearBtn.addEventListener('click', () => {
  q.value = '';
  qImg.value = '';
  results.textContent = '';
  searchVec = null;
  paintMatches(new Set());
});

selectionModeEl?.addEventListener('change', () => {
  selectionMode = selectionModeEl.value;
  if (selectionMode === 'off') {
    selectedNodes.clear();
    updateSelectionUI();
    refreshVisualization();
  }
});

clearSelectionBtn?.addEventListener('click', () => {
  selectedNodes.clear();
  updateSelectionUI();
  refreshVisualization();
});

addTagBtn?.addEventListener('click', () => {
  const tagName = newTagInput.value.trim();
  if (!tagName) {
    alert('Enter a tag name');
    return;
  }
  if (selectedNodes.size === 0) {
    alert('Select nodes first');
    return;
  }

  if (!allTags.has(tagName)) {
    allTags.set(tagName, new Set());
    const colorIndex = allTags.size - 1;
    tagColors[tagName] = colors[colorIndex % colors.length];
  }

  selectedNodes.forEach(nodeId => {
    allTags.get(tagName).add(nodeId);
    if (!nodes[nodeId].tags) nodes[nodeId].tags = new Set();
    nodes[nodeId].tags.add(tagName);
  });

  newTagInput.value = '';
  updateTagUI();
  refreshVisualization();
});

removeTagBtn?.addEventListener('click', () => {
  const tagName = newTagInput.value.trim();
  if (!tagName) {
    alert('Enter a tag name to remove');
    return;
  }
  if (selectedNodes.size === 0) {
    alert('Select nodes first');
    return;
  }

  if (!allTags.has(tagName)) {
    alert('Tag does not exist');
    return;
  }

  selectedNodes.forEach(nodeId => {
    allTags.get(tagName).delete(nodeId);
    if (nodes[nodeId].tags) {
      nodes[nodeId].tags.delete(tagName);
    }
  });

  if (allTags.get(tagName).size === 0) {
    allTags.delete(tagName);
    delete tagColors[tagName];
  }

  newTagInput.value = '';
  updateTagUI();
  refreshVisualization();
});

colorModeEl?.addEventListener('change', () => {
  colorMode = colorModeEl.value;
  refreshVisualization();
});

tagFilterEl?.addEventListener('change', () => {
  refreshVisualization();
});

function updateSelectionUI() {
  if (selectedCountEl) {
    selectedCountEl.textContent = selectedNodes.size.toString();
  }

  if (currentTagsEl && selectedNodes.size > 0) {
    const tagCounts = new Map();
    selectedNodes.forEach(nodeId => {
      const node = nodes[nodeId];
      if (node.tags) {
        node.tags.forEach(tag => {
          tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        });
      }
    });

    currentTagsEl.innerHTML = tagCounts.size === 0
      ? '<div class="muted small">No tags on selected items</div>'
      : '<div class="muted small">Tags on selected items:</div>' + Array.from(tagCounts.entries()).map(([tag, count]) => `<span class="tag-badge">${esc(tag)} (${count}/${selectedNodes.size})</span>`).join('');
  } else if (currentTagsEl) {
    currentTagsEl.innerHTML = '<div class="muted small">Select items to view/add tags</div>';
  }
}

function updateTagUI() {
  updateSelectionUI();

  if (tagFilterEl) {
    const selectedFilters = Array.from(tagFilterEl.selectedOptions).map(o => o.value);
    tagFilterEl.innerHTML = '<option value="all">All items</option>';
    allTags.forEach((nodeIds, tagName) => {
      const opt = document.createElement('option');
      opt.value = tagName;
      opt.textContent = `${tagName} (${nodeIds.size})`;
      if (selectedFilters.includes(tagName)) opt.selected = true;
      tagFilterEl.appendChild(opt);
    });
  }

  if (allTagsEl) {
    if (allTags.size === 0) {
      allTagsEl.style.display = 'none';
    } else {
      allTagsEl.style.display = 'block';
      allTagsEl.innerHTML = '<div class="muted small">All tags:</div>' + Array.from(allTags.entries()).map(([tag, nodeIds]) => `<span class="tag-badge" style="background:${tagColors[tag]}">${esc(tag)} (${nodeIds.size})</span>`).join('');
    }
  }
}

function refreshVisualization() {
  if (!deckInstance || !deckInstance._createLayer) return;

  const selectedFilters = tagFilterEl ? Array.from(tagFilterEl.selectedOptions).map(o => o.value) : [];
  let filteredNodeIds = null;

  if (selectedFilters.length > 0 && !selectedFilters.includes('all')) {
    filteredNodeIds = new Set();
    selectedFilters.forEach(tagName => {
      if (allTags.has(tagName)) {
        allTags.get(tagName).forEach(nodeId => filteredNodeIds.add(nodeId));
      }
    });
  }

  const newLayer = deckInstance._createLayer(highlightedNodes, selectedNodes, filteredNodeIds);
  deckInstance.setProps({ layers: [newLayer] });
}

function setupWorkerHandlers() {
  if (!worker) return;

  worker.onmessage = async (ev) => {
    const { type, data } = ev.data || {};

    if (type === 'progress') {
      setBar(data.pct, data.msg || '');
    } else if (type === 'batch') {
      embeddings.push(...data.embeddings);
      setBar(data.pct, data.msg);
    } else if (type === 'done') {
      setBar(88, 'Clustering...');
      clusters = kMeans(embeddings, cfg.k);
      setBar(92, 'UMAP (2D)...');
      coords = await umap2D(embeddings);
      setBar(96, 'Preparing visualization...');
      await buildNodesAndViz();
      setBar(100, 'Ready!');
      progressPanel.style.display = 'none';
      el('search').style.display = 'block';
      viz.style.display = 'flex';
      saveBtn.disabled = false;
      workerReady = true;
      updateQueryAvailability();
    } else if (type === 'qvec') {
      searchVec = data.vec;
      rerunSearch();
    } else if (type === 'error') {
      alert('Worker error: ' + data.message);
      progressPanel.style.display = 'none';
      configPanel.style.display = 'block';
    }
  };
}

async function buildNodesAndViz() {
  const g = document.getElementById('graph-container');
  g.innerHTML = '';

  const canvas = document.createElement('canvas');
  canvas.id = 'deck-canvas';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  g.appendChild(canvas);

  // Wait for layout to complete before measuring dimensions
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  nodes = coords.map((xy, i) => ({
    id: i,
    position: [xy[0], xy[1], 0],
    cluster: clusters[i],
    text: cfg.text && csv[i][cfg.text] ? csv[i][cfg.text] : '',
    label: cfg.label && csv[i][cfg.label] ? csv[i][cfg.label] : `Row ${i + 1}`,
    link: cfg.link && csv[i][cfg.link] ? csv[i][cfg.link] : null,
    image: cfg.image && csv[i][cfg.image] ? csv[i][cfg.image] : null,
    video: cfg.video && csv[i][cfg.video] ? csv[i][cfg.video] : null,
    tags: new Set()
  }));

  const xValues = coords.map(xy => xy[0]);
  const yValues = coords.map(xy => xy[1]);
  const centerX = (Math.min(...xValues) + Math.max(...xValues)) / 2;
  const centerY = (Math.min(...yValues) + Math.max(...yValues)) / 2;
  const xSpan = Math.max(...xValues) - Math.min(...xValues);
  const ySpan = Math.max(...yValues) - Math.min(...yValues);

  // Use both width and height to calculate proper zoom
  const containerWidth = g.offsetWidth || g.clientWidth || 800;
  const containerHeight = g.offsetHeight || g.clientHeight || 600;

  // Calculate zoom to fit data in container with padding
  let initialZoom = 0;
  if (xSpan > 0 && ySpan > 0) {
    const zoomX = Math.log2(containerWidth / (xSpan * 1.2));
    const zoomY = Math.log2(containerHeight / (ySpan * 1.2));
    initialZoom = Math.min(zoomX, zoomY); // Use the smaller zoom to ensure everything fits
  } else if (xSpan > 0 || ySpan > 0) {
    const maxSpan = Math.max(xSpan, ySpan);
    const minDim = Math.min(containerWidth, containerHeight);
    initialZoom = Math.log2(minDim / (maxSpan * 1.2));
  }

  const createLayer = (highlightedIndices = new Set(), selectedIndices = new Set(), filteredIndices = null) => {
    const baseRadius = DEFAULT_NODE_SIZE;
    const highlightedArray = Array.from(highlightedIndices);
    const selectedArray = Array.from(selectedIndices);
    const filterArray = filteredIndices ? Array.from(filteredIndices) : null;
    const displayData = filteredIndices ? nodes.filter(n => filteredIndices.has(n.id)) : nodes;

    return new ScatterplotLayer({
      id: 'scatter-layer',
      data: displayData,
      pickable: true,
      opacity: 1,
      stroked: true,
      filled: true,
      radiusUnits: 'common',
      radiusScale: 1,
      radiusMinPixels: 3,
      radiusMaxPixels: 100,
      lineWidthUnits: 'common',
      lineWidthMinPixels: 1,
      getPosition: d => d.position,
      getRadius: d => {
        if (highlightedIndices.has(d.id)) return baseRadius * 2.5;
        if (selectedIndices.has(d.id)) return baseRadius * 1.8;
        return baseRadius;
      },
      getFillColor: d => {
        if (highlightedIndices.has(d.id)) {
          return [255, 215, 0, 255];
        }
        if (selectedIndices.has(d.id)) {
          return [0, 255, 255, 200];
        }
        if (colorMode === 'tag' && d.tags && d.tags.size > 0) {
          const firstTag = Array.from(d.tags)[0];
          const tagColor = tagColors[firstTag] || colors[0];
          const rgb = hexToRgb(tagColor);
          return [rgb.r, rgb.g, rgb.b, 255];
        }
        const color = colors[d.cluster % colors.length];
        const rgb = hexToRgb(color);
        return [rgb.r, rgb.g, rgb.b, 255];
      },
      getLineColor: d => {
        if (highlightedIndices.has(d.id)) return [255, 0, 0, 255];
        if (selectedIndices.has(d.id)) return [0, 200, 200, 255];
        return [0, 0, 0, 80];
      },
      getLineWidth: d => {
        if (highlightedIndices.has(d.id)) return baseRadius * 0.3;
        if (selectedIndices.has(d.id)) return baseRadius * 0.2;
        return baseRadius * 0.1;
      },
      updateTriggers: {
        getRadius: [highlightedArray, selectedArray, colorMode],
        getFillColor: [highlightedArray, selectedArray, colorMode, filterArray],
        getLineColor: [highlightedArray, selectedArray],
        getLineWidth: [highlightedArray, selectedArray]
      }
    });
  };

  currentViewState = {
    target: [centerX, centerY, 0],
    zoom: initialZoom
  };

  deckInstance = new Deck({
    canvas: 'deck-canvas',
    width: containerWidth,
    height: containerHeight,
    glOptions: { alpha: false },
    parameters: { clearColor: [1, 1, 1, 1] },
    views: [new OrthographicView({ controller: true })],
    viewState: currentViewState,
    onViewStateChange: ({ viewState }) => {
      currentViewState = viewState;
      deckInstance.setProps({ viewState: currentViewState });
    },
    layers: [createLayer()],
    onClick: (info, event) => {
      if (info.object) {
        const nodeId = info.object.id;

        if (selectionMode === 'single') {
          selectedNodes.clear();
          selectedNodes.add(nodeId);
          updateSelectionUI();
          refreshVisualization();
        } else if (selectionMode === 'multi') {
          if (event.srcEvent?.ctrlKey || event.srcEvent?.metaKey) {
            if (selectedNodes.has(nodeId)) {
              selectedNodes.delete(nodeId);
            } else {
              selectedNodes.add(nodeId);
            }
            updateSelectionUI();
            refreshVisualization();
          } else {
            showModal(info.object, nodeId);
          }
        } else {
          showModal(info.object, nodeId);
        }
      }
    },
    getTooltip: ({ object }) => {
      if (object) {
        const tagList = object.tags && object.tags.size > 0
          ? '<br><span style="font-size:0.9em">Tags: ' + Array.from(object.tags).map(t => `<span style="background:#dc2626;padding:2px 4px;border-radius:3px;margin:2px">${esc(t)}</span>`).join(' ') + '</span>'
          : '';
        return {
          html: `<strong>${esc(object.label)}</strong>${tagList}`,
          style: {
            backgroundColor: '#333',
            color: '#fff',
            padding: '8px',
            borderRadius: '4px'
          }
        };
      }
    }
  });

  deckInstance._createLayer = createLayer;

  // Handle container resize
  const resizeObserver = new ResizeObserver(() => {
    if (deckInstance) {
      const newWidth = g.offsetWidth || g.clientWidth;
      const newHeight = g.offsetHeight || g.clientHeight;
      if (newWidth > 0 && newHeight > 0) {
        deckInstance.setProps({ width: newWidth, height: newHeight });
      }
    }
  });
  resizeObserver.observe(g);

  updateTagUI();
}

function paintMatches(set) {
  if (!deckInstance || !deckInstance._createLayer) return;

  highlightedNodes = set;
  refreshVisualization();
}

function showModal(data, idx) {
  let modal = document.getElementById('modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal';
    modal.className = 'modal';

    const content = document.createElement('div');
    content.className = 'modal-content';

    const closeBtn = document.createElement('span');
    closeBtn.id = 'close';
    closeBtn.className = 'close';
    closeBtn.innerHTML = '&times;';

    const title = document.createElement('h3');
    title.id = 'mtitle';
    title.textContent = 'Item';

    const body = document.createElement('div');
    body.id = 'mbody';

    content.appendChild(closeBtn);
    content.appendChild(title);
    content.appendChild(body);
    modal.appendChild(content);
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
    closeBtn.addEventListener('click', () => modal.style.display = 'none');
  }

  const titleEl = modal.querySelector('#mtitle');
  const bodyEl = modal.querySelector('#mbody');
  titleEl.textContent = data.label || `Row ${idx + 1}`;

  bodyEl.innerHTML = '';

  if (data.image) {
    const preview = document.createElement('div');
    preview.className = 'preview';

    const img = document.createElement('img');
    img.src = esc(data.image);
    img.alt = 'preview';

    const cap = document.createElement('div');
    cap.className = 'small muted';
    cap.innerHTML = 'Image from column <b>' + esc(cfg.image) + '</b>';

    preview.appendChild(img);
    preview.appendChild(cap);
    bodyEl.appendChild(preview);

    const spacer = document.createElement('div');
    spacer.className = 'spacer';
    bodyEl.appendChild(spacer);
  }

  if (data.video) {
    const preview = document.createElement('div');
    preview.className = 'preview';

    const video = document.createElement('video');
    video.src = esc(data.video);
    video.controls = true;
    video.style.maxWidth = '100%';
    video.style.maxHeight = '300px';
    video.style.borderRadius = '8px';

    const cap = document.createElement('div');
    cap.className = 'small muted';
    cap.innerHTML = 'Video from column <b>' + esc(cfg.video) + '</b>';

    preview.appendChild(video);
    preview.appendChild(cap);
    bodyEl.appendChild(preview);

    const spacer = document.createElement('div');
    spacer.className = 'spacer';
    bodyEl.appendChild(spacer);
  }

  if (data.text) {
    const box = document.createElement('div');
    box.className = 'info-box';
    box.style.whiteSpace = 'pre-wrap';
    box.textContent = data.text;
    bodyEl.appendChild(box);
  }

  if (data.link) {
    const p = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = 'Link:';
    const space = document.createTextNode(' ');
    const a = document.createElement('a');
    a.href = data.link;
    a.target = '_blank';
    a.textContent = data.link;
    p.appendChild(strong);
    p.appendChild(space);
    p.appendChild(a);
    bodyEl.appendChild(p);
  }

  const meta = document.createElement('p');
  meta.className = 'small muted';
  meta.innerHTML = 'Cluster <b>' + data.cluster + '</b> • Index <b>' + idx + '</b>';
  bodyEl.appendChild(meta);

  modal.style.display = 'block';
}

function cosSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  na = Math.sqrt(na);
  nb = Math.sqrt(nb);
  return (na === 0 || nb === 0) ? 0 : dot / (na * nb);
}

function kMeans(data, k, maxIter = 100) {
  const n = data.length, d = data[0].length;
  const idx = [...Array(n).keys()].sort(() => Math.random() - 0.5);
  const cent = [];
  for (let i = 0; i < k; i++) cent.push([...data[idx[i]]]);
  let assign = new Array(n).fill(0), changed = true, it = 0;

  while (changed && it < maxIter) {
    changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0, md = Infinity;
      for (let j = 0; j < k; j++) {
        let s = 0;
        for (let p = 0; p < d; p++) {
          const diff = data[i][p] - cent[j][p];
          s += diff * diff;
        }
        const dist = Math.sqrt(s);
        if (dist < md) { md = dist; best = j; }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        changed = true;
      }
    }
    const sums = Array.from({ length: k }, () => Array(d).fill(0));
    const counts = Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      counts[c]++;
      for (let p = 0; p < d; p++) {
        sums[c][p] += data[i][p];
      }
    }
    for (let j = 0; j < k; j++) {
      if (counts[j] > 0) {
        for (let p = 0; p < d; p++) {
          cent[j][p] = sums[j][p] / counts[j];
        }
      }
    }
    it++;
  }
  return assign;
}

async function umap2D(vecs) {
  const u = new UMAP.UMAP({ nComponents: 2, nNeighbors: 15, minDist: 0.1, spread: 1.0 });
  return await u.fitAsync(vecs);
}

async function extractFramesFromVideo(videoUrl, fps, maxFrames, onProgress) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.preload = 'metadata';
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const frames = [];
    let currentFrameIndex = 0;

    const cleanup = () => {
      video.remove();
      canvas.remove();
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Video processing timeout'));
    }, 60000);

    video.onerror = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new Error('Failed to load video'));
    };

    video.onloadedmetadata = () => {
      const duration = video.duration;
      const interval = 1 / fps;
      const totalFrames = Math.min(Math.floor(duration * fps), maxFrames);

      if (totalFrames === 0) {
        clearTimeout(timeout);
        cleanup();
        resolve([]);
        return;
      }

      video.onseeked = () => {
        try {
          canvas.width = 224;
          canvas.height = 224;
          ctx.drawImage(video, 0, 0, 224, 224);
          frames.push(canvas.toDataURL('image/jpeg', 0.8));

          if (onProgress) onProgress(currentFrameIndex + 1, totalFrames);
          currentFrameIndex++;

          if (currentFrameIndex < totalFrames) {
            video.currentTime = Math.min(currentFrameIndex * interval, duration);
          } else {
            clearTimeout(timeout);
            cleanup();
            resolve(frames);
          }
        } catch (err) {
          clearTimeout(timeout);
          cleanup();
          reject(err);
        }
      };

      video.currentTime = 0;
    };

    video.src = videoUrl;
  });
}

function buildItems(rows, cfg) {
  const items = [];
  for (let i = 0; i < rows.length; i++) {
    const rec = rows[i];
    const t = cfg.text ? (rec[cfg.text] || '') : '';
    const im = cfg.image ? (rec[cfg.image] || '') : '';
    const vid = cfg.video ? (rec[cfg.video] || '') : '';
    items.push({ index: i, text: t, image: im, video: vid });
  }
  return items;
}

// Worker code shared between single worker and pool workers
const WORKER_CODE = `
self.onmessage = async (ev) => {
  const { type, cfg, items, text, image, workerId, startIndex } = ev.data || {};
  try {
    if (type === 'start') { await runBatches(cfg, items); }
    else if (type === 'initPool') { await initWorkerPool(cfg, workerId); }
    else if (type === 'processBatch') { await processPoolBatch(cfg, items, workerId, startIndex); }
    else if (type === 'encodeQuery') {
      const v = await encodeQuery(cfg, text, image);
      self.postMessage({ type: 'qvec', data: { vec: v } });
    }
  } catch (e) {
    self.postMessage({ type: 'error', data: { message: e.message, workerId } });
  }
};

const MODEL_ID = 'Xenova/clip-vit-base-patch32';
let textModel = null;
let visionModel = null;
let tokenizer = null;
let processor = null;
let RawImageClass = null;

async function loadModels() {
  if (textModel && visionModel) return;
  const t = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.0');
  t.env.allowRemoteModels = true;
  t.env.allowLocalModels = false;
  t.env.useBrowserCache = true;
  RawImageClass = t.RawImage;

  self.postMessage({ type: 'progress', data: { pct: 8, msg: 'Loading CLIP ViT-B/32 tokenizer & processor...' } });
  tokenizer = await t.AutoTokenizer.from_pretrained(MODEL_ID);
  processor = await t.AutoProcessor.from_pretrained(MODEL_ID);

  const progressCallback = (progress) => {
    if (progress && progress.status === 'progress' && progress.total) {
      const percent = Math.round((progress.loaded / progress.total) * 100);
      self.postMessage({ type: 'progress', data: { pct: 10 + percent * 0.75, msg: 'Downloading CLIP: ' + percent + '%' } });
    }
  };

  // Prefer WebGPU for speed; fall back to wasm if unavailable
  let device = 'wasm';
  let dtype = 'q8';
  try {
    if (self.navigator?.gpu) {
      const adapter = await self.navigator.gpu.requestAdapter();
      if (adapter) { device = 'webgpu'; }
    }
  } catch (_) {}

  const deviceLabel = device === 'webgpu' ? 'WebGPU' : 'CPU (WebGPU unavailable)';
  self.postMessage({ type: 'progress', data: { pct: 10, msg: 'Downloading CLIP ViT-B/32 (' + deviceLabel + ')...' } });

  // Load sequentially — two simultaneous WebGPU initialisations can race
  textModel = await t.CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { device, dtype, progress_callback: progressCallback });
  self.postMessage({ type: 'progress', data: { pct: 55, msg: 'Loading vision model...' } });
  visionModel = await t.CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { device, dtype, progress_callback: progressCallback });
}

function l2Normalize(arr) {
  let n = 0;
  for (let i = 0; i < arr.length; i++) n += arr[i] * arr[i];
  n = Math.sqrt(n) || 1;
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] / n;
  return out;
}

async function fetchImage(url) {
  if (url.startsWith('data:')) {
    const blob = await (await fetch(url)).blob();
    return await RawImageClass.fromBlob(blob);
  }
  // No third-party proxy fallback — CORS-blocked images are skipped
  return await RawImageClass.read(url);
}

async function embedText(text) {
  const inputs = tokenizer([text], { padding: true, truncation: true });
  const { text_embeds } = await textModel(inputs);
  return l2Normalize(Array.from(text_embeds.data));
}

async function embedImage(url) {
  const image = await fetchImage(url);
  const inputs = await processor(image);
  const { image_embeds } = await visionModel(inputs);
  return l2Normalize(Array.from(image_embeds.data));
}

async function getEmbedding(o) {
  await loadModels();
  const vecs = [];

  if (o.text && o.text.trim()) {
    vecs.push(await embedText(o.text));
  }

  if (o.image && o.image.trim()) {
    try {
      vecs.push(await embedImage(o.image));
    } catch (err) {
      console.warn('Image embed skipped (CORS or load error):', err.message);
    }
  }

  if (o.videoFrames && o.videoFrames.length > 0) {
    const frameVecs = [];
    for (const frame of o.videoFrames) {
      try { frameVecs.push(await embedImage(frame)); }
      catch (err) { console.warn('Frame embed skipped:', err.message); }
    }
    if (frameVecs.length > 0) {
      const dim = frameVecs[0].length;
      const pooled = new Array(dim).fill(0);
      for (const fv of frameVecs) for (let i = 0; i < dim; i++) pooled[i] += fv[i];
      for (let i = 0; i < dim; i++) pooled[i] /= frameVecs.length;
      vecs.push(l2Normalize(pooled));
    }
  }

  if (vecs.length === 0) return null;
  if (vecs.length === 1) return vecs[0];

  // Average text + image vectors — both live in the shared CLIP embedding space
  const dim = vecs[0].length;
  const avg = new Array(dim).fill(0);
  for (const v of vecs) for (let i = 0; i < dim; i++) avg[i] += v[i];
  for (let i = 0; i < dim; i++) avg[i] /= vecs.length;
  return l2Normalize(avg);
}

async function initWorkerPool(cfg, workerId) {
  self.postMessage({ type: 'poolProgress', data: { workerId, status: 'loading' } });
  await loadModels();
  self.postMessage({ type: 'poolReady', data: { workerId } });
}

async function processPoolBatch(cfg, items, workerId, startIndex) {
  const vecs = [];
  for (const o of items) {
    try {
      const v = await getEmbedding(o);
      vecs.push(v || new Array(512).fill(0));
    } catch (err) {
      console.error(err);
      vecs.push(new Array(512).fill(0));
    }
  }
  self.postMessage({ type: 'poolBatch', data: { workerId, startIndex, embeddings: vecs } });
}

async function runBatches(cfg, items) {
  const N = items.length;
  const B = Math.max(1, Math.min(64, cfg.batch || 16));
  await loadModels();

  for (let i = 0; i < N; i += B) {
    const batch = items.slice(i, Math.min(i + B, N));
    const vecs = [];
    for (const o of batch) {
      try {
        const v = await getEmbedding(o);
        vecs.push(v || new Array(512).fill(0));
      } catch (err) {
        console.error(err);
        vecs.push(new Array(512).fill(0));
      }
    }
    const done = Math.min(i + B, N);
    const pct = 15 + (done / N) * 80;
    self.postMessage({ type: 'batch', data: { embeddings: vecs, pct, msg: 'Embedding ' + done + '/' + N } });
  }
  self.postMessage({ type: 'done' });
}

async function encodeQuery(cfg, text, image) {
  await loadModels();
  if (image) return await embedImage(image);
  return await embedText(text);
}
`;

function createWorker() {
  const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
  return new Worker(URL.createObjectURL(blob));
}

// Create worker pool for parallel processing
function createWorkerPool(size) {
  const pool = [];
  for (let i = 0; i < size; i++) {
    const w = createWorker();
    pool.push({ worker: w, id: i, ready: false, busy: false });
  }
  return pool;
}

// Terminate all workers in pool
function terminateWorkerPool() {
  for (const pw of workerPool) {
    pw.worker.terminate();
  }
  workerPool = [];
  poolReady = false;
}

// Run embedding with worker pool (parallel processing)
async function runWithWorkerPool(cfg, items, onProgress) {
  return new Promise((resolve, reject) => {
    const N = items.length;
    const poolSize = Math.min(WORKER_POOL_SIZE, Math.ceil(N / 10)); // Don't use more workers than needed

    terminateWorkerPool();
    workerPool = createWorkerPool(poolSize);

    let workersReady = 0;
    let totalProcessed = 0;
    const results = new Array(N);
    let currentBatchIndex = 0;
    const BATCH_SIZE = Math.max(1, Math.min(32, Math.ceil(N / poolSize / 4)));

    // Distribute next batch to a worker
    const assignNextBatch = (pw) => {
      if (currentBatchIndex >= N) {
        pw.busy = false;
        // Check if all done
        if (totalProcessed >= N) {
          onProgress(95, 'Finalizing embeddings...');
          resolve(results);
        }
        return;
      }

      const start = currentBatchIndex;
      const end = Math.min(start + BATCH_SIZE, N);
      const batch = items.slice(start, end);
      currentBatchIndex = end;

      pw.busy = true;
      pw.worker.postMessage({ type: 'processBatch', cfg, items: batch, workerId: pw.id, startIndex: start });
    };

    // Setup handlers for each worker
    for (const pw of workerPool) {
      pw.worker.onmessage = (ev) => {
        const { type, data } = ev.data;

        if (type === 'poolReady') {
          workersReady++;
          pw.ready = true;
          onProgress(10 + (workersReady / poolSize) * 5, `Workers ready: ${workersReady}/${poolSize}`);

          if (workersReady === poolSize) {
            poolReady = true;
            onProgress(15, 'Starting parallel embedding...');
            // Start distributing work
            for (const w of workerPool) {
              assignNextBatch(w);
            }
          }
        } else if (type === 'poolBatch') {
          const { startIndex, embeddings: vecs } = data;
          // Store results at correct indices
          for (let i = 0; i < vecs.length; i++) {
            results[startIndex + i] = vecs[i];
          }
          totalProcessed += vecs.length;
          const pct = 15 + (totalProcessed / N) * 80;
          onProgress(pct, `Embedding ${totalProcessed}/${N} (parallel)`);

          // Assign next batch to this worker
          assignNextBatch(pw);
        } else if (type === 'poolProgress') {
          onProgress(5 + (workersReady / poolSize) * 5, `Loading model in worker ${data.workerId + 1}...`);
        } else if (type === 'error') {
          reject(new Error(data.message));
        }
      };

      pw.worker.onerror = (err) => {
        reject(new Error('Worker error: ' + err.message));
      };
    }

    // Initialize all workers with model
    onProgress(5, `Initializing ${poolSize} workers...`);
    for (const pw of workerPool) {
      pw.worker.postMessage({ type: 'initPool', cfg, workerId: pw.id });
    }
  });
}

// ========== STREAMING FILE PARSING ==========

// Stream parse CSV file with progress callback
async function parseCSVStreaming(file, onProgress, onComplete) {
  return new Promise((resolve, reject) => {
    const results = [];
    let rowCount = 0;
    const fileSize = file.size;
    let processedBytes = 0;

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      chunk: (chunk, parser) => {
        results.push(...chunk.data);
        rowCount += chunk.data.length;
        // Estimate progress based on rows (chunk doesn't give byte position reliably)
        if (onProgress) {
          onProgress(Math.min(rowCount / 1000, 0.9), `Parsed ${rowCount} rows...`);
        }
      },
      complete: () => {
        if (onProgress) onProgress(1, `Parsed ${results.length} rows`);
        resolve({ data: results, fields: results.length > 0 ? Object.keys(results[0]) : [] });
      },
      error: (err) => {
        reject(err);
      }
    });
  });
}

// Stream parse NDJSON file with progress callback
async function parseNDJSONStreaming(file, onProgress) {
  return new Promise((resolve, reject) => {
    const results = [];
    const fileSize = file.size;
    let processedBytes = 0;
    let lineBuffer = '';

    const reader = file.stream().getReader();
    const decoder = new TextDecoder();

    async function processChunk() {
      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            // Process any remaining content
            if (lineBuffer.trim()) {
              try {
                const parsed = JSON.parse(lineBuffer.trim());
                results.push(flattenNdjsonData(parsed));
              } catch (e) {
                console.warn('Failed to parse final line:', e);
              }
            }
            break;
          }

          processedBytes += value.length;
          const text = decoder.decode(value, { stream: true });
          lineBuffer += text;

          // Process complete lines
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.trim()) {
              try {
                const parsed = JSON.parse(line);
                results.push(flattenNdjsonData(parsed));
              } catch (e) {
                console.warn('Failed to parse line:', e);
              }
            }
          }

          if (onProgress) {
            const pct = processedBytes / fileSize;
            onProgress(pct, `Parsed ${results.length} rows (${Math.round(pct * 100)}%)`);
          }
        }

        // Extract fields from flattened data
        const fieldSet = new Set();
        results.forEach(row => Object.keys(row).forEach(key => fieldSet.add(key)));

        resolve({ data: results, fields: Array.from(fieldSet) });
      } catch (err) {
        reject(err);
      }
    }

    processChunk();
  });
}
