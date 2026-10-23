// Web Worker for CIB Detection
// Offloads heavy computation from the main thread to keep the UI responsive.
//
// All detection algorithms are imported from cib-algorithms.js (shared with
// the main thread — single source of truth, no copied code).
//
// IMPORTANT DESIGN RULE: the full dataset is always processed. There is no
// sampling anywhere in this pipeline. Speed comes from exact optimizations
// (precomputed statistics, inverted indexes, bounded edit distance, deduped
// caption embeddings) plus batching and progress reporting.

import {
  calculateDatasetStatistics,
  buildHashtagStatistics,
  tfidfScore,
  findTemplatePairs,
  groupSimilarUsernames,
  analyzePostingRhythm,
  analyzeNightPosting,
  detectAccountCreationClusters,
  detectTemporalBursts,
  detectSynchronizedPosting,
  findSimilarEmbeddingPairs,
  detectRareItemGroups,
} from './cib-algorithms.js';

// =========================
// Embedding model
// =========================

let extractor = null;
let transformersLoaded = false;

async function loadTransformersLibrary() {
  if (transformersLoaded) return;

  try {
    const module = await import('./transformers.min.js');
    self.pipeline = module.pipeline;
    transformersLoaded = true;
    self.postMessage({ type: 'log', message: '✓ Transformers.js library loaded' });
  } catch (error) {
    self.postMessage({ type: 'log', message: `⚠️ Failed to load Transformers.js: ${error.message}` });
    throw error;
  }
}

async function initEmbeddingModel() {
  if (!extractor) {
    self.postMessage({ type: 'log', message: 'Loading embedding model (Xenova/all-MiniLM-L6-v2, ~23MB)...' });

    await loadTransformersLibrary();

    const pipeline = self.pipeline;
    if (!pipeline) {
      throw new Error('Transformers.js pipeline not available. Library may not have loaded correctly.');
    }

    extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    self.postMessage({ type: 'log', message: '✓ Embedding model ready (384-dimensional vectors)' });
  }
  return extractor;
}

/**
 * Embed a batch of texts in one model call. Returns one Float32Array per text.
 * Batching is dramatically faster than per-text calls and changes nothing
 * about the results.
 */
async function getEmbeddingsBatch(texts) {
  const model = await initEmbeddingModel();
  const output = await model(texts, { pooling: 'mean', normalize: true });
  const data = output.data;
  const dims = data.length / texts.length;
  const rows = new Array(texts.length);
  for (let i = 0; i < texts.length; i++) {
    rows[i] = Float32Array.prototype.slice.call(data, i * dims, (i + 1) * dims);
  }
  return rows;
}

// =========================
// Columnar payload materialization
// =========================

function materializePostsFromColumnarPayload(payload) {
  if (!payload || !Number.isFinite(payload.count)) return [];

  const {
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
    authorDict,
    authorLabelDict,
    captionDict,
    hashtagDict,
    urlDict,
    repostDict,
    repostNameDict,
  } = payload;

  const posts = new Array(count);

  for (let i = 0; i < count; i++) {
    const authorIdx = authorIndices[i];
    const authorId = authorIdx >= 0 ? authorDict[authorIdx] : null;
    const authorLabel = authorIdx >= 0
      ? (authorLabelDict[authorIdx] || authorDict[authorIdx] || '')
      : '';

    const captionIdx = captionIndices[i];
    const caption = captionIdx >= 0 ? (captionDict[captionIdx] || '') : '';

    const tagStart = hashtagOffsets[i];
    const tagEnd = hashtagOffsets[i + 1];
    const challenges = [];
    for (let j = tagStart; j < tagEnd; j++) {
      const tagIdx = hashtagPool[j];
      const tagTitle = hashtagDict[tagIdx];
      if (!tagTitle) continue;
      challenges.push({ id: tagTitle, title: tagTitle });
    }

    // URLs (Session 5) — guarded so a v1 payload still materializes.
    const urls = [];
    if (urlOffsets && urlPool && urlDict) {
      const us = urlOffsets[i];
      const ue = urlOffsets[i + 1];
      for (let j = us; j < ue; j++) {
        const u = urlDict[urlPool[j]];
        if (u) urls.push({ url: u, domain: u.split('/')[0] });
      }
    }

    // Repost target (Session 5)
    let repost = null;
    if (repostIndices && repostDict) {
      const rIdx = repostIndices[i];
      if (rIdx >= 0) {
        repost = { targetId: repostDict[rIdx], targetName: (repostNameDict && repostNameDict[rIdx]) || repostDict[rIdx] };
      }
    }

    posts[i] = {
      data: {
        author: {
          id: authorId,
          uniqueId: authorLabel,
          nickname: authorLabel,
          createTime: authorCreateTimes[i] || undefined,
        },
        createTime: createTimes[i] || undefined,
        desc: caption,
        challenges,
        urls,
        repost,
      },
    };
  }

  return posts;
}

// Yield to the event loop so the worker stays responsive to ping messages
// and Chrome doesn't consider it frozen.
function yieldToEventLoop() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function reportProgress(progress, message) {
  self.postMessage({ type: 'progress', progress, message });
}

// Base score contribution per indicator type (applied once per indicator,
// regardless of how many separate pieces of evidence support it).
const INDICATOR_SCORES = {
  sync: 25,
  hashtags: 20,
  username: 10,
  volume: 15,
  burst: 15,
  rhythm: 20,
  night: 25,
  semantic: 25,
  template: 20,
  creation: 30,
  urls: 22,     // co-sharing a rare URL is a strong coordination signal
  repost: 18,   // systematically amplifying the same source accounts
};

function formatPartnerList(names, limit = 5) {
  const display = names.slice(0, limit);
  const more = names.length > limit ? ` and ${names.length - limit} more` : '';
  return `${display.join(', ')}${more}`;
}

// =========================
// Coordination graph builder
// =========================

const SIGNAL_COLORS = {
  sync: '#ef4444',
  semantic: '#8b5cf6',
  template: '#f97316',
  hashtags: '#10b981',
  username: '#3b82f6',
  creation: '#f59e0b',
  urls: '#0ea5e9',
  repost: '#a855f7',
};

// Dominant signal for coloring: use the first match in priority order
const SIGNAL_PRIORITY = ['sync', 'semantic', 'template', 'urls', 'repost', 'hashtags', 'username', 'creation'];

function dominantSignal(signals) {
  for (const sig of SIGNAL_PRIORITY) {
    if (signals.includes(sig)) return sig;
  }
  return signals[0] || 'sync';
}

/**
 * Build a { nodes, links, components } coordination graph from all pairwise
 * evidence produced during CIB detection.
 *
 * - Pairwise evidence (sync, semantic, template) → direct edges.
 * - Group evidence (hashtags, usernames, creation clusters) → clique expansion
 *   capped at MAX_GROUP_RENDER members per group to avoid edge explosion.
 * - Edges between the same pair are merged (signals aggregated, weight summed).
 * - Components are computed via union-find on all flagged users (including singletons).
 */
function buildCoordinationGraph(
  suspiciousUsers,
  userIdToName,
  synchGroups,
  semanticGroups,
  captionPairs,
  hashtagSequences,
  qualifyingUsernameGroups,
  creationClusters,
  params,
  urlGroups = [],
  repostGroups = []
) {
  const MAX_GROUP_RENDER = 20;

  const edgeMap = new Map(); // canonicalKey -> { source, target, weight, signalsSet }

  function addEdge(a, b, signal, weight) {
    if (a === b) return;
    const src = a < b ? a : b;
    const tgt = a < b ? b : a;
    const key = `${src}\x00${tgt}`;
    if (!edgeMap.has(key)) {
      edgeMap.set(key, { source: src, target: tgt, weight: 0, signalsSet: new Set() });
    }
    const e = edgeMap.get(key);
    e.weight += weight;
    e.signalsSet.add(signal);
  }

  // Sync pairs (pairwise, exact count)
  for (const g of synchGroups) {
    addEdge(g.u1, g.u2, 'sync', g.syncCount || 1);
  }

  // Semantic groups (users already deduplicated per group)
  for (const group of semanticGroups) {
    const users = group.users;
    const sim = parseFloat(group.similarity) || 1;
    for (let i = 0; i < users.length; i++) {
      for (let j = i + 1; j < users.length; j++) {
        addEdge(users[i], users[j], 'semantic', sim);
      }
    }
  }

  // Template pairs
  for (const pair of captionPairs) {
    const users = pair.users;
    const overlap = pair.overlap || 1;
    for (let i = 0; i < users.length; i++) {
      for (let j = i + 1; j < users.length; j++) {
        addEdge(users[i], users[j], 'template', overlap);
      }
    }
  }

  // Hashtag groups (clique, capped)
  hashtagSequences.forEach((data) => {
    if (data.users.size < (params.minHashtagGroupSize || 3)) return;
    const members = Array.from(data.users).slice(0, MAX_GROUP_RENDER);
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        addEdge(members[i], members[j], 'hashtags', 1);
      }
    }
  });

  // Username groups (clique, capped)
  for (const group of qualifyingUsernameGroups) {
    const members = group.slice(0, MAX_GROUP_RENDER);
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        addEdge(members[i], members[j], 'username', 1);
      }
    }
  }

  // Creation clusters (clique, capped)
  for (const cluster of creationClusters) {
    const members = Array.from(cluster).slice(0, MAX_GROUP_RENDER);
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        addEdge(members[i], members[j], 'creation', 1);
      }
    }
  }

  // URL co-share groups (clique, capped) — Session 5
  for (const g of urlGroups) {
    const members = g.users.slice(0, MAX_GROUP_RENDER);
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        addEdge(members[i], members[j], 'urls', 1);
      }
    }
  }

  // Co-repost groups (clique, capped) — Session 5
  for (const g of repostGroups) {
    const members = g.users.slice(0, MAX_GROUP_RENDER);
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        addEdge(members[i], members[j], 'repost', 1);
      }
    }
  }

  // Build node list
  const nodeList = Array.from(suspiciousUsers).map(id => ({
    id,
    label: userIdToName.get(id) || String(id),
    type: 'user',
  }));

  // Build link list (serialize signalsSet → signals array + dominant color)
  const linkList = Array.from(edgeMap.values()).map(e => {
    const signals = Array.from(e.signalsSet);
    return {
      source: e.source,
      target: e.target,
      weight: e.weight,
      signals,
      color: SIGNAL_COLORS[dominantSignal(signals)] || '#6b7280',
    };
  });

  // Connected components via union-find (all flagged users, including singletons)
  const parent = new Map();
  function getRoot(x) {
    if (!parent.has(x)) parent.set(x, x);
    const p = parent.get(x);
    if (p !== x) { const r = getRoot(p); parent.set(x, r); return r; }
    return x;
  }
  function union(x, y) { parent.set(getRoot(x), getRoot(y)); }

  for (const id of suspiciousUsers) getRoot(id);
  for (const link of linkList) union(link.source, link.target);

  const compMap = new Map();
  for (const id of suspiciousUsers) {
    const root = getRoot(id);
    if (!compMap.has(root)) compMap.set(root, []);
    compMap.get(root).push(id);
  }
  const components = Array.from(compMap.values()).sort((a, b) => b.length - a.length);

  return { nodes: nodeList, links: linkList, components };
}

// =========================
// Main CIB detection
// =========================

async function detectCIB(filteredData, params, timeWindow) {
  const results = {
    suspiciousUsers: new Set(),
    indicators: {},
    userScores: new Map(),
    userReasons: new Map(),
  };

  reportProgress(5, 'Calculating dataset statistics...');
  const stats = calculateDatasetStatistics(filteredData);
  await yieldToEventLoop();

  // ---- Shared per-user structures (one pass over the data) ----
  const timestampsByUser = new Map();   // userId -> [unix ts]
  const fullPostsByUser = new Map();    // userId -> [post]
  const userHashtagLists = new Map();   // userId -> [tag, tag, ...] (with repeats)
  const userIdToName = new Map();       // userId -> display name
  const userUrlSets = new Map();        // userId -> Set<url>   (Session 5)
  const userDomainSets = new Map();     // userId -> Set<domain>(Session 5)
  const userRepostSets = new Map();     // userId -> Set<targetId> (Session 5)
  let postsWithUrls = 0;
  let postsWithRepost = 0;

  filteredData.forEach(post => {
    const userId = post.data?.author?.id;
    if (!userId) return;

    const urls = post.data?.urls;
    if (urls && urls.length) {
      postsWithUrls++;
      let uset = userUrlSets.get(userId);
      if (!uset) { uset = new Set(); userUrlSets.set(userId, uset); }
      let dset = userDomainSets.get(userId);
      if (!dset) { dset = new Set(); userDomainSets.set(userId, dset); }
      for (let i = 0; i < urls.length; i++) {
        if (urls[i]?.url) uset.add(urls[i].url);
        if (urls[i]?.domain) dset.add(urls[i].domain);
      }
    }

    const repost = post.data?.repost;
    if (repost && repost.targetId != null && repost.targetId !== '') {
      postsWithRepost++;
      let rset = userRepostSets.get(userId);
      if (!rset) { rset = new Set(); userRepostSets.set(userId, rset); }
      rset.add(String(repost.targetId));
    }

    if (!fullPostsByUser.has(userId)) fullPostsByUser.set(userId, []);
    fullPostsByUser.get(userId).push(post);

    const author = post.data.author;
    if (!userIdToName.has(userId)) {
      userIdToName.set(userId, author.uniqueId || author.nickname || `user_${userId}`);
    }

    const timestamp = post.data?.createTime;
    if (timestamp) {
      if (!timestampsByUser.has(userId)) timestampsByUser.set(userId, []);
      timestampsByUser.get(userId).push(timestamp);
    }

    const hashtags = post.data?.challenges;
    if (hashtags && hashtags.length) {
      if (!userHashtagLists.has(userId)) userHashtagLists.set(userId, []);
      const list = userHashtagLists.get(userId);
      for (let i = 0; i < hashtags.length; i++) {
        if (hashtags[i]?.title) list.push(hashtags[i].title);
      }
    }
  });

  // ---- 1) Synchronized posting (bucketed candidates + exact two-pointer counts) ----
  reportProgress(10, `Detecting synchronized posting across ${timestampsByUser.size} users...`);

  const synchGroups = await detectSynchronizedPosting(
    timestampsByUser, timeWindow, params.minSyncPosts,
    yieldToEventLoop,
    (done, total) => reportProgress(10, `Synchronized posting: ${Math.floor((done / total) * 100)}% of time buckets...`)
  );
  synchGroups.forEach(group => {
    results.suspiciousUsers.add(group.u1);
    results.suspiciousUsers.add(group.u2);
  });
  results.indicators.synchronized = synchGroups.length;
  results.indicators.synchronizedDetails = synchGroups.slice(0, 50);
  await yieldToEventLoop();

  // ---- 2) Rare hashtag sequences (TF-IDF with precomputed document frequencies) ----
  reportProgress(20, 'Analyzing hashtag patterns...');

  const { profiles, docFreq, totalUsers } = buildHashtagStatistics(userHashtagLists);

  const hashtagSequences = new Map();
  let hashtagPostsDone = 0;
  for (const post of filteredData) {
    hashtagPostsDone++;
    const userId = post.data?.author?.id;
    const hashtags = post.data?.challenges?.map(c => c.title) || [];
    if (!userId || !hashtags.length) continue;

    const profile = profiles.get(userId);
    let tfidfSum = 0;
    for (let i = 0; i < hashtags.length; i++) {
      tfidfSum += tfidfScore(hashtags[i], profile, docFreq, totalUsers);
    }
    const avgTfidf = tfidfSum / hashtags.length;

    if (avgTfidf > params.tfidfThreshold) {
      const key = [...hashtags].sort().join(',');
      if (!hashtagSequences.has(key)) hashtagSequences.set(key, { users: new Set(), tfidf: avgTfidf });
      hashtagSequences.get(key).users.add(userId);
    }

    if (hashtagPostsDone % 5000 === 0) {
      reportProgress(22, `Hashtag analysis: ${hashtagPostsDone}/${filteredData.length} posts...`);
      await yieldToEventLoop();
    }
  }

  let identicalHashtagUsers = 0;
  hashtagSequences.forEach((data) => {
    if (data.users.size >= params.minHashtagGroupSize) {
      data.users.forEach(u => results.suspiciousUsers.add(u));
      identicalHashtagUsers += data.users.size;
    }
  });
  results.indicators.identicalHashtags = identicalHashtagUsers;
  results.indicators.identicalHashtagsDetails = Array.from(hashtagSequences.entries())
    .filter(([, data]) => data.users.size >= params.minHashtagGroupSize)
    .map(([tags, data]) => ({ tags, count: data.users.size }))
    .slice(0, 20);
  await yieldToEventLoop();

  // ---- 3) Similar usernames (transitive union-find groups, bounded Levenshtein) ----
  reportProgress(30, `Comparing ${userIdToName.size} usernames...`);

  const usernameEntries = [];
  userIdToName.forEach((name, userId) => {
    usernameEntries.push([userId, name]);
  });

  const allUsernameGroups = await groupSimilarUsernames(
    usernameEntries, params.usernameThreshold,
    yieldToEventLoop,
    (done, total) => reportProgress(32, `Username comparison: ${Math.floor((done / total) * 100)}% (${done}/${total})...`)
  );
  const qualifyingUsernameGroups = allUsernameGroups.filter(g => g.length >= params.minUsernameGroupSize);

  const usernameGroupByUser = new Map(); // userId -> group (array of userIds)
  let similarUsernameCount = 0;
  qualifyingUsernameGroups.forEach(group => {
    similarUsernameCount += group.length;
    group.forEach(userId => {
      results.suspiciousUsers.add(userId);
      usernameGroupByUser.set(userId, group);
    });
  });
  results.indicators.similarUsernames = similarUsernameCount;
  await yieldToEventLoop();

  // ---- 4) High-volume posting (z-score) ----
  reportProgress(40, 'Detecting high-volume posters...');

  const highVolumeUsers = new Set();
  if (stats.posts.stdDev > 0) {
    timestampsByUser.forEach((timestamps, userId) => {
      if (timestamps.length >= params.minHighVolumePosts) {
        const zScore = (timestamps.length - stats.posts.mean) / stats.posts.stdDev;
        if (zScore > params.zscoreThreshold) {
          results.suspiciousUsers.add(userId);
          highVolumeUsers.add(userId);
        }
      }
    });
  }
  results.indicators.highVolume = highVolumeUsers.size;

  // ---- 5) Temporal bursts ----
  reportProgress(50, 'Analyzing posting bursts...');

  const postsByUserForBursts = new Map();
  timestampsByUser.forEach((timestamps, userId) => {
    postsByUserForBursts.set(userId, timestamps.map(t => ({ timestamp: t })));
  });
  const bursts = detectTemporalBursts(postsByUserForBursts, timeWindow, params.burstPosts);
  results.indicators.temporalBursts = bursts.length;
  const burstsByUser = new Map();
  bursts.forEach(burst => {
    if (!burstsByUser.has(burst.userId)) burstsByUser.set(burst.userId, []);
    burstsByUser.get(burst.userId).push(burst);
  });
  await yieldToEventLoop();

  // ---- 6) Posting rhythm & 24/7 activity (computed once per user, reused in scoring) ----
  reportProgress(55, 'Checking posting rhythms...');

  const rhythmByUser = new Map();
  const nightByUser = new Map();
  timestampsByUser.forEach((timestamps, userId) => {
    const wrapped = timestamps.map(t => ({ timestamp: t }));
    const rhythm = analyzePostingRhythm(wrapped, params.rhythmCV);
    rhythmByUser.set(userId, rhythm);
    if (rhythm.regular) results.suspiciousUsers.add(userId);

    const nightPosting = analyzeNightPosting(wrapped, params.nightGap);
    nightByUser.set(userId, nightPosting);
    if (nightPosting.suspicious) results.suspiciousUsers.add(userId);
  });
  await yieldToEventLoop();

  // ---- Unique captions (shared by semantic + template detection) ----
  // Identical caption text always produces an identical embedding and an
  // n-gram overlap of 1, so computing per unique caption (while tracking
  // every user who posted it) is exactly equivalent to per-post computation
  // — and far cheaper on datasets with repeated captions.
  const uniqueCaptions = new Map(); // caption -> Set<userId>
  filteredData.forEach(post => {
    const userId = post.data?.author?.id;
    const caption = post.data?.desc || '';
    if (!userId || caption.length < 20) return;
    if (!uniqueCaptions.has(caption)) uniqueCaptions.set(caption, new Set());
    uniqueCaptions.get(caption).add(userId);
  });

  const captionTexts = Array.from(uniqueCaptions.keys());
  const captionUsers = captionTexts.map(text => Array.from(uniqueCaptions.get(text)));

  // A pair of caption indices can produce a cross-account match unless both
  // captions belong to exactly the same single user.
  const canCrossAccount = (i, j) => {
    const usersI = captionUsers[i];
    const usersJ = captionUsers[j];
    if (usersI.length > 1 || usersJ.length > 1) return true;
    return usersI[0] !== usersJ[0];
  };

  // Captions posted verbatim by 2+ accounts: exact duplicates (similarity 1,
  // overlap 1) — flag without spending model/comparison time on them.
  const exactDuplicateCaptionIdxs = [];
  for (let i = 0; i < captionTexts.length; i++) {
    if (captionUsers[i].length >= 2) exactDuplicateCaptionIdxs.push(i);
  }

  // ---- 7) Semantic duplicate captions (batched embeddings over unique captions) ----
  let semanticGroups = [];
  const captionEmbeddings = new Map(); // userId -> [{caption, embedding, userId}] (project-save format)

  if (params.semanticEnabled && captionTexts.length > 0) {
    reportProgress(60, `Loading AI model for semantic analysis (${captionTexts.length} unique captions)...`);

    const EMBED_BATCH = 16;
    const dims = 384;
    let matrix = null;

    for (let start = 0; start < captionTexts.length; start += EMBED_BATCH) {
      const batch = captionTexts.slice(start, start + EMBED_BATCH);
      const rows = await getEmbeddingsBatch(batch);

      if (!matrix) matrix = new Float32Array(captionTexts.length * rows[0].length);
      for (let b = 0; b < rows.length; b++) {
        matrix.set(rows[b], (start + b) * rows[b].length);
      }

      const done = Math.min(start + EMBED_BATCH, captionTexts.length);
      const embedProgress = 62 + Math.floor((done / captionTexts.length) * 10);
      reportProgress(embedProgress, `Generating embeddings (${done}/${captionTexts.length} unique captions)...`);
      await yieldToEventLoop();
    }

    const actualDims = matrix ? matrix.length / captionTexts.length : dims;

    reportProgress(73, `Comparing semantic similarity (${captionTexts.length} captions, all pairs)...`);

    const similarPairs = await findSimilarEmbeddingPairs(
      matrix, captionTexts.length, actualDims, params.semanticThreshold,
      canCrossAccount,
      yieldToEventLoop,
      (done, total) => reportProgress(75, `Semantic comparison: ${Math.floor((done / total) * 100)}%...`)
    );

    // Exact duplicates across accounts (similarity 1 by definition)
    exactDuplicateCaptionIdxs.forEach(i => {
      const users = captionUsers[i];
      users.forEach(u => results.suspiciousUsers.add(u));
      semanticGroups.push({
        users,
        similarity: '1.000',
        captions: [captionTexts[i].slice(0, 50), captionTexts[i].slice(0, 50)],
      });
    });

    similarPairs.forEach(({ i, j, similarity }) => {
      const users = Array.from(new Set([...captionUsers[i], ...captionUsers[j]]));
      users.forEach(u => results.suspiciousUsers.add(u));
      semanticGroups.push({
        users,
        similarity: similarity.toFixed(3),
        captions: [captionTexts[i].slice(0, 50), captionTexts[j].slice(0, 50)],
      });
    });

    // Project-save format: one entry per (user, unique caption)
    if (matrix) {
      for (let i = 0; i < captionTexts.length; i++) {
        const embedding = Array.from(matrix.subarray(i * actualDims, (i + 1) * actualDims));
        captionUsers[i].forEach(userId => {
          if (!captionEmbeddings.has(userId)) captionEmbeddings.set(userId, []);
          captionEmbeddings.get(userId).push({ caption: captionTexts[i], embedding, userId });
        });
      }
    }
  }

  results.indicators.semanticDuplicates = semanticGroups.length;
  results.indicators.semanticDuplicatesDetails = semanticGroups.slice(0, 50);
  await yieldToEventLoop();

  // ---- 8) N-gram template captions (inverted-index candidates over unique captions) ----
  reportProgress(80, `Detecting template captions (${captionTexts.length} unique captions)...`);

  const captionItems = captionTexts.map(text => ({ text }));
  const templateRawPairs = await findTemplatePairs(
    captionItems, params.ngramThreshold, 5,
    canCrossAccount,
    yieldToEventLoop,
    (done, total) => reportProgress(82, `Template detection: ${Math.floor((done / total) * 100)}%...`)
  );

  const captionPairs = [];
  // Exact duplicates across accounts (overlap 1 by definition)
  exactDuplicateCaptionIdxs.forEach(i => {
    const users = captionUsers[i];
    users.forEach(u => results.suspiciousUsers.add(u));
    captionPairs.push({ users, overlap: 1 });
  });
  templateRawPairs.forEach(({ i, j, overlap }) => {
    const users = Array.from(new Set([...captionUsers[i], ...captionUsers[j]]));
    users.forEach(u => results.suspiciousUsers.add(u));
    captionPairs.push({ users, overlap });
  });

  results.indicators.templateCaptions = captionPairs.length;
  results.indicators.templateCaptionsDetails = captionPairs.slice(0, 50);
  results.indicators.duplicateCaptions = semanticGroups.length + captionPairs.length;
  await yieldToEventLoop();

  // ---- 9) Account creation clustering ----
  reportProgress(85, 'Checking account creation patterns...');

  const creationResult = detectAccountCreationClusters(filteredData, 86400, params.clusterSize);
  const creationClusters = creationResult.clusters;
  results.indicators.accountCreationClusters = creationClusters.length;
  results.indicators.accountCreationCoverage = creationResult.totalAccounts > 0
    ? creationResult.accountsWithCreationTime / creationResult.totalAccounts
    : 0;
  if (creationResult.totalAccounts > 0 && creationResult.accountsWithCreationTime === 0) {
    self.postMessage({
      type: 'log',
      message: 'ℹ️ No account creation dates in this dataset (typically only present in Twitter/X data) — creation clustering cannot run.',
    });
  }
  creationClusters.forEach(cluster => {
    cluster.forEach(userId => results.suspiciousUsers.add(userId));
  });
  await yieldToEventLoop();

  // ---- 10) URL co-sharing (rare shared links) ----
  reportProgress(87, 'Analyzing shared URLs...');
  const urlMaxFraction = params.urlRarityMaxFraction ?? 0.5;
  const minUrlGroupSize = params.minUrlGroupSize ?? 3;
  const urlGroups = detectRareItemGroups(userUrlSets, { minGroupSize: minUrlGroupSize, maxUserFraction: urlMaxFraction });
  const domainGroups = detectRareItemGroups(userDomainSets, { minGroupSize: minUrlGroupSize, maxUserFraction: urlMaxFraction });
  urlGroups.forEach(g => g.users.forEach(u => results.suspiciousUsers.add(u)));
  results.indicators.urlCoshare = urlGroups.length;
  results.indicators.urlCoshareDetails = urlGroups.slice(0, 50).map(g => ({ url: g.item, users: g.users.length }));
  results.indicators.urlCoverage = postsWithUrls;
  if (postsWithUrls === 0) {
    self.postMessage({ type: 'log', message: 'ℹ️ No URLs found in this dataset — URL co-sharing detection cannot run.' });
  }

  // ---- 11) Co-repost / co-amplification (rare shared amplified targets) ----
  reportProgress(89, 'Analyzing repost/amplification patterns...');
  const minRepostGroupSize = params.minRepostGroupSize ?? 3;
  const repostGroups = detectRareItemGroups(userRepostSets, { minGroupSize: minRepostGroupSize, maxUserFraction: params.repostRarityMaxFraction ?? 0.5 });
  repostGroups.forEach(g => g.users.forEach(u => results.suspiciousUsers.add(u)));
  results.indicators.repost = repostGroups.length;
  results.indicators.repostDetails = repostGroups.slice(0, 50).map(g => ({ target: g.item, users: g.users.length }));
  results.indicators.repostCoverage = postsWithRepost;
  if (postsWithRepost === 0) {
    self.postMessage({ type: 'log', message: 'ℹ️ No repost/quote relations in this dataset (typically only present in Twitter/X data) — co-repost detection cannot run.' });
  }
  await yieldToEventLoop();

  // ---- Risk scores (structured indicators, not text matching) ----
  reportProgress(90, `Calculating risk scores for ${results.suspiciousUsers.size} flagged accounts...`);

  // Pre-index pairwise evidence by user for O(1) lookup during scoring
  const syncPartnersByUser = new Map();
  synchGroups.forEach(g => {
    if (!syncPartnersByUser.has(g.u1)) syncPartnersByUser.set(g.u1, []);
    if (!syncPartnersByUser.has(g.u2)) syncPartnersByUser.set(g.u2, []);
    syncPartnersByUser.get(g.u1).push(g.u2);
    syncPartnersByUser.get(g.u2).push(g.u1);
  });

  const hashtagPartnersByUser = new Map();
  hashtagSequences.forEach((data) => {
    if (data.users.size < params.minHashtagGroupSize) return;
    data.users.forEach(userId => {
      if (!hashtagPartnersByUser.has(userId)) hashtagPartnersByUser.set(userId, []);
      const partners = hashtagPartnersByUser.get(userId);
      data.users.forEach(other => {
        if (other !== userId) partners.push(other);
      });
    });
  });

  const semanticByUser = new Map();
  semanticGroups.forEach(group => {
    group.users.forEach(userId => {
      if (!semanticByUser.has(userId)) semanticByUser.set(userId, []);
      semanticByUser.get(userId).push(group);
    });
  });

  const templateByUser = new Map();
  captionPairs.forEach(pair => {
    pair.users.forEach(userId => {
      if (!templateByUser.has(userId)) templateByUser.set(userId, []);
      templateByUser.get(userId).push(pair);
    });
  });

  const creationClusterByUser = new Map();
  creationClusters.forEach(cluster => {
    cluster.forEach(userId => creationClusterByUser.set(userId, cluster));
  });

  // URL / repost: partner set + the shared items, per user (Session 5)
  const urlEvidenceByUser = new Map();   // userId -> { partners:Set, items:Set }
  urlGroups.forEach(g => {
    g.users.forEach(userId => {
      let e = urlEvidenceByUser.get(userId);
      if (!e) { e = { partners: new Set(), items: new Set() }; urlEvidenceByUser.set(userId, e); }
      e.items.add(g.item);
      g.users.forEach(o => { if (o !== userId) e.partners.add(o); });
    });
  });
  const repostEvidenceByUser = new Map();
  repostGroups.forEach(g => {
    g.users.forEach(userId => {
      let e = repostEvidenceByUser.get(userId);
      if (!e) { e = { partners: new Set(), items: new Set() }; repostEvidenceByUser.set(userId, e); }
      e.items.add(g.item);
      g.users.forEach(o => { if (o !== userId) e.partners.add(o); });
    });
  });

  const toName = (id) => userIdToName.get(id) || id;

  results.userScores = new Map();
  results.userReasons = new Map();

  results.suspiciousUsers.forEach(userId => {
    const indicatorKeys = new Set();
    const reasons = [];

    const syncPartners = syncPartnersByUser.get(userId);
    if (syncPartners && syncPartners.length > 0) {
      indicatorKeys.add('sync');
      reasons.push(`Synchronized posting with: ${formatPartnerList(syncPartners.map(toName))}`);
    }

    const hashtagPartners = hashtagPartnersByUser.get(userId);
    if (hashtagPartners && hashtagPartners.length > 0) {
      indicatorKeys.add('hashtags');
      reasons.push(`Rare hashtag combinations with: ${formatPartnerList(hashtagPartners.map(toName))}`);
    }

    const usernameGroup = usernameGroupByUser.get(userId);
    if (usernameGroup) {
      indicatorKeys.add('username');
      const others = usernameGroup.filter(u => u !== userId).map(toName);
      reasons.push(`Similar username pattern with: ${formatPartnerList(others)}`);
    }

    if (highVolumeUsers.has(userId)) {
      indicatorKeys.add('volume');
      const postCount = timestampsByUser.get(userId)?.length || 0;
      const zScore = stats.posts.stdDev > 0 ? (postCount - stats.posts.mean) / stats.posts.stdDev : 0;
      reasons.push(`High-volume posting (z-score: ${zScore.toFixed(1)})`);
    }

    const userBursts = burstsByUser.get(userId);
    if (userBursts && userBursts.length > 0) {
      indicatorKeys.add('burst');
      userBursts.forEach(burst => {
        const timeDesc = timeWindow < 60
          ? `${timeWindow} second${timeWindow !== 1 ? 's' : ''}`
          : `${Math.floor(timeWindow / 60)} minute${Math.floor(timeWindow / 60) !== 1 ? 's' : ''}`;
        reasons.push(`Posting burst: ${burst.count} posts in ${timeDesc}`);
      });
    }

    const rhythm = rhythmByUser.get(userId);
    if (rhythm?.regular) {
      indicatorKeys.add('rhythm');
      reasons.push(`Highly regular posting rhythm (CV: ${(rhythm.cv * 100).toFixed(1)}%)`);
    }

    const nightPosting = nightByUser.get(userId);
    if (nightPosting?.suspicious) {
      indicatorKeys.add('night');
      reasons.push(`24/7 posting pattern (max gap: ${Math.floor(nightPosting.avgMaxGap / 3600)}h)`);
    }

    const userSemanticGroups = semanticByUser.get(userId);
    if (userSemanticGroups && userSemanticGroups.length > 0) {
      indicatorKeys.add('semantic');
      const partners = new Set();
      let maxSim = 0;
      userSemanticGroups.forEach(group => {
        group.users.forEach(u => { if (u !== userId) partners.add(u); });
        maxSim = Math.max(maxSim, parseFloat(group.similarity));
      });
      reasons.push(`Semantically similar captions (max ${maxSim.toFixed(3)}) with: ${formatPartnerList(Array.from(partners).map(toName))}`);
    }

    const userTemplatePairs = templateByUser.get(userId);
    if (userTemplatePairs && userTemplatePairs.length > 0) {
      indicatorKeys.add('template');
      const partners = new Set();
      let maxOverlap = 0;
      userTemplatePairs.forEach(pair => {
        pair.users.forEach(u => { if (u !== userId) partners.add(u); });
        maxOverlap = Math.max(maxOverlap, pair.overlap);
      });
      reasons.push(`Template caption (up to ${(maxOverlap * 100).toFixed(0)}% overlap) with: ${formatPartnerList(Array.from(partners).map(toName))}`);
    }

    const creationCluster = creationClusterByUser.get(userId);
    if (creationCluster) {
      indicatorKeys.add('creation');
      reasons.push(`Account created with ${creationCluster.size - 1} others within 24 hours`);
    }

    const urlEvidence = urlEvidenceByUser.get(userId);
    if (urlEvidence && urlEvidence.partners.size > 0) {
      indicatorKeys.add('urls');
      const domains = Array.from(new Set(Array.from(urlEvidence.items).map(u => u.split('/')[0])));
      reasons.push(`Shared rare URL${urlEvidence.items.size > 1 ? 's' : ''} (${formatPartnerList(domains, 3)}) with: ${formatPartnerList(Array.from(urlEvidence.partners).map(toName))}`);
    }

    const repostEvidence = repostEvidenceByUser.get(userId);
    if (repostEvidence && repostEvidence.partners.size > 0) {
      indicatorKeys.add('repost');
      const targets = Array.from(repostEvidence.items).map(id => userIdToName.get(id) || id);
      reasons.push(`Co-amplified the same account${repostEvidence.items.size > 1 ? 's' : ''} (${formatPartnerList(targets, 3)}) with: ${formatPartnerList(Array.from(repostEvidence.partners).map(toName))}`);
    }

    // Base score: one contribution per distinct indicator type
    let score = 0;
    indicatorKeys.forEach(key => { score += INDICATOR_SCORES[key] || 0; });

    // Cross-indicator multiplier (per distinct indicator, as documented)
    if (indicatorKeys.size >= 2) {
      score = score * (1 + params.crossMultiplier * indicatorKeys.size);
    }

    // Combination bonuses (structured — no reason-text matching)
    if (indicatorKeys.has('username') && indicatorKeys.has('creation')) score += 20; // bot farm pattern
    if (indicatorKeys.has('sync') && indicatorKeys.has('rhythm')) score += 15;       // automation pattern

    results.userScores.set(userId, Math.min(100, Math.round(score)));
    results.userReasons.set(userId, reasons);
  });

  reportProgress(95, 'Finalizing analysis...');

  const coordinationGraph = buildCoordinationGraph(
    results.suspiciousUsers,
    userIdToName,
    synchGroups,
    semanticGroups,
    captionPairs,
    hashtagSequences,
    qualifyingUsernameGroups,
    creationClusters,
    params,
    urlGroups,
    repostGroups
  );

  const serializedResults = {
    suspiciousUsers: Array.from(results.suspiciousUsers),
    indicators: results.indicators,
    userScores: Array.from(results.userScores.entries()),
    userReasons: Array.from(results.userReasons.entries()),
    embeddings: Array.from(captionEmbeddings.entries()),
    coordinationGraph,
  };

  reportProgress(100, 'Analysis complete!');

  return serializedResults;
}

// =========================
// Worker message handler
// =========================

self.onmessage = async function (e) {
  const { type, data, payload, params, timeWindow, pingId } = e.data;

  if (type === 'ping') {
    self.postMessage({ type: 'pong', pingId });
    return;
  }

  if (type === 'detectCIB') {
    try {
      const result = await detectCIB(data, params, timeWindow);
      self.postMessage({ type: 'complete', result });
    } catch (error) {
      self.postMessage({ type: 'error', error: error.message, stack: error.stack });
    }
  } else if (type === 'detectCIBColumnar') {
    try {
      const materializedData = materializePostsFromColumnarPayload(payload);
      const result = await detectCIB(materializedData, params, timeWindow);
      self.postMessage({ type: 'complete', result });
    } catch (error) {
      self.postMessage({ type: 'error', error: error.message, stack: error.stack });
    }
  }
};
