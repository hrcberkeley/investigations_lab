/**
 * CIB DETECTION ALGORITHMS (shared)
 *
 * Pure, dependency-free functions used by both the main thread (analytics.js)
 * and the CIB web worker (cib-worker.js). This is the single source of truth —
 * do not copy these functions into other files.
 *
 * DESIGN RULE: every function here processes the FULL input. No sampling.
 * Performance comes from exact optimizations only:
 *   - precomputed document frequencies (TF-IDF)
 *   - inverted-index candidate generation (n-grams) — pairs with zero shared
 *     n-grams have overlap 0 and provably cannot pass a positive threshold
 *   - length-bound pruning + early-exit Levenshtein — pairs whose length
 *     difference already exceeds the edit budget provably cannot pass
 *   - two-pointer counting over sorted timestamps (synchronized posting)
 * Long loops accept an optional async `yieldFn` so callers can keep the
 * thread responsive and report progress, without skipping any work.
 */

// =========================
// Dataset statistics
// =========================

export function calculateDatasetStatistics(filteredData) {
  const postCounts = new Map();
  const hashtagCounts = new Map();

  filteredData.forEach(post => {
    const userId = post.data?.author?.id;
    if (!userId) return;

    postCounts.set(userId, (postCounts.get(userId) || 0) + 1);

    const hashtags = post.data?.challenges?.length || 0;
    hashtagCounts.set(userId, (hashtagCounts.get(userId) || 0) + hashtags);
  });

  const posts = Array.from(postCounts.values());
  const hashtags = Array.from(hashtagCounts.values());

  const postsMean = posts.reduce((a, b) => a + b, 0) / (posts.length || 1);
  const hashtagsMean = hashtags.reduce((a, b) => a + b, 0) / (hashtags.length || 1);

  return {
    posts: {
      mean: postsMean,
      stdDev: Math.sqrt(posts.reduce((sq, n) => sq + Math.pow(n - postsMean, 2), 0) / (posts.length || 1)),
    },
    hashtags: {
      mean: hashtagsMean,
      stdDev: Math.sqrt(hashtags.reduce((sq, n) => sq + Math.pow(n - hashtagsMean, 2), 0) / (hashtags.length || 1)),
    },
  };
}

// =========================
// TF-IDF (precomputed document frequencies)
// =========================

/**
 * Build per-user hashtag profiles and global document frequencies in one
 * linear pass. Replaces the previous per-post rebuild of every user's Set,
 * which was O(posts × users × tags). Results are numerically identical.
 *
 * @param {Map<string, Array<string>>} userHashtagLists - userId -> all hashtags used (with repeats)
 * @returns {{ profiles: Map<string, {counts: Map<string, number>, total: number}>, docFreq: Map<string, number>, totalUsers: number }}
 */
export function buildHashtagStatistics(userHashtagLists) {
  const profiles = new Map();
  const docFreq = new Map();

  userHashtagLists.forEach((tags, userId) => {
    const counts = new Map();
    for (let i = 0; i < tags.length; i++) {
      counts.set(tags[i], (counts.get(tags[i]) || 0) + 1);
    }
    profiles.set(userId, { counts, total: tags.length });
    // Document frequency: number of users whose hashtag set contains the tag
    counts.forEach((_, tag) => {
      docFreq.set(tag, (docFreq.get(tag) || 0) + 1);
    });
  });

  return { profiles, docFreq, totalUsers: userHashtagLists.size };
}

/**
 * TF-IDF for one hashtag of one user, using precomputed statistics.
 * Identical formula to the original calculateTFIDF:
 *   tf  = count(tag in user's tags) / total user tags
 *   idf = ln(totalUsers / (usersWithTag + 1))
 */
export function tfidfScore(hashtag, userProfile, docFreq, totalUsers) {
  if (!userProfile || userProfile.total === 0) return 0;
  const tf = (userProfile.counts.get(hashtag) || 0) / userProfile.total;
  const idf = Math.log(totalUsers / ((docFreq.get(hashtag) || 0) + 1));
  return tf * idf;
}

/**
 * Legacy-signature TF-IDF retained for compatibility/teaching. Prefer
 * buildHashtagStatistics + tfidfScore in hot paths.
 */
export function calculateTFIDF(hashtag, userHashtags, allHashtags) {
  let count = 0;
  for (let i = 0; i < userHashtags.length; i++) {
    if (userHashtags[i] === hashtag) count++;
  }
  const tf = userHashtags.length ? count / userHashtags.length : 0;

  let usersWithHashtag = 0;
  for (let i = 0; i < allHashtags.length; i++) {
    if (allHashtags[i].has(hashtag)) usersWithHashtag++;
  }
  const idf = Math.log(allHashtags.length / (usersWithHashtag + 1));

  return tf * idf;
}

// =========================
// URL co-sharing & co-repost coordination (Session 5)
// =========================

// Tracking / attribution params that don't change the destination resource;
// stripped so the same link with different campaign tags collapses to one URL.
const URL_TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'utm_name', 'utm_reader', 'utm_social', 'utm_brand',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'mc_cid', 'mc_eid',
  'igshid', 'igsh', 'ref', 'ref_src', 'ref_url', 'source', 's', 't',
  'spm', 'cmpid', 'yclid', 'twclid', '_ga', 'mkt_tok',
]);

/**
 * Normalize a single URL for coordination comparison:
 *  - lowercase host, strip a leading "www."
 *  - drop the fragment and tracking query params
 *  - sort remaining query params so order doesn't create false distinctions
 * Returns { url, domain } or null if the input isn't a usable http(s) URL.
 */
export function normalizeUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let candidate = raw.trim();
  if (!candidate) return null;
  if (!/^https?:\/\//i.test(candidate)) {
    // Only accept bare hosts that at least look like a domain.
    if (!/^[\w-]+(\.[\w-]+)+/.test(candidate)) return null;
    candidate = 'http://' + candidate;
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host.includes('.')) return null;

  const kept = [];
  for (const [k, v] of parsed.searchParams.entries()) {
    if (URL_TRACKING_PARAMS.has(k.toLowerCase())) continue;
    kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const query = kept.map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join('&');

  let path = parsed.pathname || '';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  const url = host + path + (query ? `?${query}` : '');
  return { url, domain: host };
}

/**
 * Extract and normalize all URLs found in free text (captions/tweets).
 * De-duplicates within the text so one post counts a URL once.
 */
export function extractUrlsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = text.match(/https?:\/\/[^\s<>"')]+/gi) || [];
  const seen = new Set();
  const out = [];
  for (const m of matches) {
    const norm = normalizeUrl(m);
    if (norm && !seen.has(norm.url)) {
      seen.add(norm.url);
      out.push(norm);
    }
  }
  return out;
}

/**
 * Generic rare-item group detector — the shared engine behind URL co-sharing
 * and co-repost detection (and structurally identical to rare-hashtag grouping).
 *
 * For every distinct item, the set of users who used it is the candidate group.
 * An item is "coordinated evidence" when it is shared by at least `minGroupSize`
 * users AND is rare — used by no more than `maxUserFraction` of all users (so
 * nytimes.com shared by everyone is ignored, but an obscure link pushed by 8
 * accounts is flagged). Processes the FULL input; nothing is sampled.
 *
 * @param {Map<string, Set<string>|Array<string>>} userItemLists - userId -> items (deduped per user recommended)
 * @returns {Array<{item: string, users: string[], userCount: number, fraction: number}>}
 */
export function detectRareItemGroups(userItemLists, { minGroupSize = 3, maxUserFraction = 0.5 } = {}) {
  const totalUsers = userItemLists.size;
  if (totalUsers === 0) return [];

  const usersByItem = new Map(); // item -> Set<userId>
  userItemLists.forEach((items, userId) => {
    const unique = items instanceof Set ? items : new Set(items);
    unique.forEach(item => {
      if (item == null || item === '') return;
      let set = usersByItem.get(item);
      if (!set) { set = new Set(); usersByItem.set(item, set); }
      set.add(userId);
    });
  });

  const maxUsers = maxUserFraction * totalUsers;
  const groups = [];
  usersByItem.forEach((users, item) => {
    if (users.size >= minGroupSize && users.size <= maxUsers) {
      groups.push({
        item,
        users: Array.from(users),
        userCount: users.size,
        fraction: users.size / totalUsers,
      });
    }
  });
  // Rarest (most suspicious) first.
  groups.sort((a, b) => a.userCount - b.userCount);
  return groups;
}

// =========================
// N-grams & template detection
// =========================

export function getNGrams(text, n = 5) {
  const words = text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/);
  const ngrams = [];

  for (let i = 0; i <= words.length - n; i++) {
    ngrams.push(words.slice(i, i + n).join(' '));
  }
  return ngrams;
}

export function ngramOverlap(textA, textB, n = 5) {
  const ngramsA = getNGrams(textA, n);
  const ngramsB = getNGrams(textB, n);
  if (ngramsA.length === 0 || ngramsB.length === 0) return 0;

  const setA = new Set(ngramsA);
  const setB = new Set(ngramsB);
  let overlap = 0;
  setA.forEach(ngram => {
    if (setB.has(ngram)) overlap++;
  });
  return overlap / Math.max(setA.size, setB.size);
}

/**
 * Overlap between two precomputed n-gram Sets (same formula as ngramOverlap).
 */
export function ngramSetOverlap(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let overlap = 0;
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  small.forEach(ngram => {
    if (large.has(ngram)) overlap++;
  });
  return overlap / Math.max(setA.size, setB.size);
}

/**
 * Find all caption pairs whose n-gram overlap >= threshold, using an
 * inverted index for candidate generation. EXACT for threshold > 0:
 * a pair with no shared n-gram has overlap 0 and cannot qualify, so only
 * pairs sharing at least one n-gram are scored. Every qualifying pair is
 * found — nothing is sampled.
 *
 * @param {Array<{text: string}>} items - captions (any extra fields preserved)
 * @param {number} threshold - minimum overlap (must be > 0 for indexing; if
 *   <= 0 the function falls back to comparing all pairs, which is required
 *   for exactness in that degenerate configuration)
 * @param {number} n - n-gram size
 * @param {Function} [shouldPair] - optional (i, j) => boolean filter applied
 *   before scoring (e.g. skip same-account pairs)
 * @param {Function} [yieldFn] - optional async function awaited periodically
 * @param {Function} [onProgress] - optional (done, total) progress callback
 * @returns {Promise<Array<{i: number, j: number, overlap: number}>>}
 */
export async function findTemplatePairs(items, threshold, n = 5, shouldPair = null, yieldFn = null, onProgress = null) {
  const ngramSets = items.map(item => new Set(getNGrams(item.text, n)));
  const results = [];
  const count = items.length;

  if (threshold <= 0) {
    // Degenerate configuration: every pair qualifies for scoring.
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        if (shouldPair && !shouldPair(i, j)) continue;
        const overlap = ngramSetOverlap(ngramSets[i], ngramSets[j]);
        if (overlap >= threshold) results.push({ i, j, overlap });
      }
      if (yieldFn && i % 50 === 0) await yieldFn();
      if (onProgress && i % 200 === 0) onProgress(i, count);
    }
    return results;
  }

  // Inverted index: n-gram -> caption indices containing it
  const index = new Map();
  for (let i = 0; i < count; i++) {
    ngramSets[i].forEach(ngram => {
      let list = index.get(ngram);
      if (!list) {
        list = [];
        index.set(ngram, list);
      }
      list.push(i);
    });
    if (yieldFn && i % 2000 === 0) await yieldFn();
  }

  // Candidate pairs: share at least one n-gram. Deduplicate via per-i Set.
  for (let i = 0; i < count; i++) {
    const candidates = new Set();
    ngramSets[i].forEach(ngram => {
      const list = index.get(ngram);
      for (let k = 0; k < list.length; k++) {
        if (list[k] > i) candidates.add(list[k]);
      }
    });

    candidates.forEach(j => {
      if (shouldPair && !shouldPair(i, j)) return;
      const overlap = ngramSetOverlap(ngramSets[i], ngramSets[j]);
      if (overlap >= threshold) results.push({ i, j, overlap });
    });

    if (yieldFn && i % 200 === 0) await yieldFn();
    if (onProgress && i % 500 === 0) onProgress(i, count);
  }

  return results;
}

// =========================
// Levenshtein / username similarity
// =========================

/**
 * Full Levenshtein distance (kept for compatibility and tests).
 */
export function levenshteinDistance(a, b) {
  const matrix = Array.from({ length: b.length + 1 }, (_, i) => [i]);
  matrix[0] = Array.from({ length: a.length + 1 }, (_, j) => j);

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + 1,
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Levenshtein distance with an upper bound. Returns the exact distance when
 * it is <= maxDist, otherwise any value > maxDist (early exit). Two-row DP
 * with row-minimum cutoff — exact for threshold decisions.
 */
export function levenshteinWithin(a, b, maxDist) {
  const lenA = a.length;
  const lenB = b.length;
  if (Math.abs(lenA - lenB) > maxDist) return maxDist + 1;
  if (lenA === 0) return lenB;
  if (lenB === 0) return lenA;

  let prev = new Array(lenA + 1);
  let curr = new Array(lenA + 1);
  for (let j = 0; j <= lenA; j++) prev[j] = j;

  for (let i = 1; i <= lenB; i++) {
    curr[0] = i;
    let rowMin = i;
    const charB = b.charCodeAt(i - 1);
    for (let j = 1; j <= lenA; j++) {
      const cost = a.charCodeAt(j - 1) === charB ? 0 : 1;
      const val = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr[j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDist) return maxDist + 1; // distance can only grow
    [prev, curr] = [curr, prev];
  }
  return prev[lenA];
}

/**
 * Disjoint-set (union-find) for transitive grouping.
 */
export class UnionFind {
  constructor() {
    this.parent = new Map();
  }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    // Path compression
    let node = x;
    while (this.parent.get(node) !== root) {
      const next = this.parent.get(node);
      this.parent.set(node, root);
      node = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
  groups() {
    const out = new Map();
    this.parent.forEach((_, x) => {
      const root = this.find(x);
      if (!out.has(root)) out.set(root, []);
      out.get(root).push(x);
    });
    return Array.from(out.values());
  }
}

/**
 * Group users with similar usernames (Levenshtein similarity >= threshold)
 * into TRANSITIVE groups via union-find. This fixes the previous pair-keyed
 * grouping where every "group" had exactly 2 members and could never reach
 * a minimum group size of 3.
 *
 * ALL pairs are considered. Exact pruning only:
 *  - usernames are sorted by length; a pair (short, long) can only qualify
 *    if long.length <= short.length / threshold, so the inner loop breaks
 *    as soon as candidates get too long — no qualifying pair is skipped.
 *  - levenshteinWithin early-exits once the edit budget is exceeded.
 *
 * @param {Array<[string, string]>} usernameEntries - [userId, username] pairs
 * @param {number} threshold - similarity in (0, 1]
 * @param {Function} [yieldFn] - optional async yield
 * @param {Function} [onProgress] - optional (done, total) callback
 * @returns {Promise<Array<Array<string>>>} groups of userIds (size >= 2)
 */
export async function groupSimilarUsernames(usernameEntries, threshold, yieldFn = null, onProgress = null) {
  const entries = usernameEntries
    .filter(([, name]) => typeof name === 'string' && name.length >= 4)
    .sort((a, b) => a[1].length - b[1].length);

  const uf = new UnionFind();
  const total = entries.length;
  const safeThreshold = Math.max(threshold, 1e-9);

  for (let i = 0; i < total; i++) {
    const [idA, nameA] = entries[i];
    const lenA = nameA.length;
    // Longest possible partner length that can still reach the threshold:
    // similarity = 1 - dist/maxLen >= t requires dist <= (1-t)*maxLen and
    // dist >= |lenB - lenA|, so lenB <= lenA / t. The 1e-9 epsilon guards
    // against float rounding making the bound too tight (pruning must never
    // exclude a qualifying pair; the exact similarity check below protects
    // against false positives).
    const maxLenB = lenA / safeThreshold + 1e-9;

    for (let j = i + 1; j < total; j++) {
      const [idB, nameB] = entries[j];
      const lenB = nameB.length;
      if (lenB > maxLenB) break; // sorted by length — no further j can qualify

      const maxLen = Math.max(lenA, lenB);
      const maxDist = Math.floor((1 - safeThreshold) * maxLen + 1e-9);
      const distance = levenshteinWithin(nameA, nameB, maxDist);
      if (distance <= maxDist) {
        // Verify with the exact original similarity formula
        const similarity = 1 - distance / maxLen;
        if (similarity >= threshold) uf.union(idA, idB);
      }
    }

    if (yieldFn && i % 100 === 0) await yieldFn();
    if (onProgress && i % 250 === 0) onProgress(i, total);
  }

  return uf.groups().filter(group => group.length >= 2);
}

// =========================
// Temporal patterns
// =========================

export function analyzePostingRhythm(posts, cvThreshold = 0.1) {
  if (posts.length < 5) return { regular: false, stdDev: null };

  const timestamps = posts.map(p => p.timestamp).sort((a, b) => a - b);
  const intervals = [];

  for (let i = 1; i < timestamps.length; i++) {
    intervals.push(timestamps[i] - timestamps[i - 1]);
  }

  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const variance = intervals.reduce((sum, interval) => sum + Math.pow(interval - mean, 2), 0) / intervals.length;
  const stdDev = Math.sqrt(variance);
  const coefficientOfVariation = stdDev / mean;

  return {
    regular: coefficientOfVariation < cvThreshold,
    stdDev,
    mean,
    cv: coefficientOfVariation,
  };
}

/**
 * 24/7 activity detection. Uses UTC day binning so results do not depend on
 * the analyst's local timezone. (Note: the timezone of the *posting accounts*
 * is still unknown — gap-based detection is inherently approximate.)
 */
export function analyzeNightPosting(posts, gapThreshold = 7200) {
  if (posts.length < 10) return { suspicious: false };

  const timestamps = posts.map(p => p.timestamp).sort((a, b) => a - b);
  const dailyGaps = new Map();

  timestamps.forEach(ts => {
    const date = new Date(ts * 1000);
    const dayKey = `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;

    if (!dailyGaps.has(dayKey)) dailyGaps.set(dayKey, []);
    dailyGaps.get(dayKey).push(date.getUTCHours() * 3600 + date.getUTCMinutes() * 60);
  });

  const avgMaxGap = Array.from(dailyGaps.values()).map(day => {
    day.sort((a, b) => a - b);
    let maxGap = 0;

    for (let i = 1; i < day.length; i++) {
      maxGap = Math.max(maxGap, day[i] - day[i - 1]);
    }

    if (day.length > 1) {
      maxGap = Math.max(maxGap, 86400 - day[day.length - 1] + day[0]);
    }

    return maxGap;
  }).reduce((a, b) => a + b, 0) / (dailyGaps.size || 1);

  return {
    suspicious: avgMaxGap < gapThreshold,
    avgMaxGap,
  };
}

export function detectAccountCreationClusters(posts, timeWindow = 86400, minClusterSize = 5) {
  const accountCreationTimes = new Map();
  const uniqueAccounts = new Set();

  posts.forEach(post => {
    const author = post.data?.author;
    if (!author?.id) return;

    uniqueAccounts.add(author.id);

    const creationTime = author.createTime;
    if (!creationTime) return;

    if (!accountCreationTimes.has(author.id)) {
      accountCreationTimes.set(author.id, creationTime);
    }
  });

  const clusters = new Map();
  const sorted = Array.from(accountCreationTimes.entries()).sort((a, b) => a[1] - b[1]);

  sorted.forEach(([userId, time]) => {
    let foundCluster = false;

    for (const [clusterTime, accounts] of clusters) {
      if (Math.abs(time - clusterTime) < timeWindow) {
        accounts.add(userId);
        foundCluster = true;
        break;
      }
    }

    if (!foundCluster) {
      clusters.set(time, new Set([userId]));
    }
  });

  return {
    clusters: Array.from(clusters.values()).filter(cluster => cluster.size >= minClusterSize),
    totalAccounts: uniqueAccounts.size,
    accountsWithCreationTime: accountCreationTimes.size,
  };
}

export function detectTemporalBursts(postsByUser, timeWindow, minPosts = 5) {
  const bursts = [];

  postsByUser.forEach((posts, userId) => {
    const timestamps = posts.map(p => p.timestamp).sort((a, b) => a - b);

    for (let i = 0; i < timestamps.length; i++) {
      const windowEnd = timestamps[i] + timeWindow;
      let postsInWindow = 0;
      let j = i;

      while (j < timestamps.length && timestamps[j] < windowEnd) {
        postsInWindow++;
        j++;
      }

      if (postsInWindow >= minPosts) {
        bursts.push({
          userId,
          time: timestamps[i],
          count: postsInWindow,
          timestamps: timestamps.slice(i, j),
        });
        break;
      }
    }
  });

  return bursts;
}

// =========================
// Synchronized posting
// =========================

/**
 * Count pairs (a, b) with a from sortedA, b from sortedB, |a - b| < window.
 * Two-pointer sliding window: O(|A| + |B|) instead of O(|A| × |B|). Exact.
 */
export function countSyncPairs(sortedA, sortedB, window) {
  let count = 0;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < sortedA.length; i++) {
    const t = sortedA[i];
    while (lo < sortedB.length && sortedB[lo] <= t - window) lo++;
    if (hi < lo) hi = lo;
    while (hi < sortedB.length && sortedB[hi] < t + window) hi++;
    count += hi - lo;
  }
  return count;
}

/**
 * Detect synchronized posting between all user pairs. Time-bucket indexing
 * generates candidate pairs (users who posted within the same or adjacent
 * bucket — any pair with at least one synchronized post must co-occur in
 * some bucket neighborhood, so no qualifying pair is missed). Each candidate
 * pair is then counted exactly over ALL their posts with two pointers.
 *
 * @param {Map<string, Array<number>>} timestampsByUser - userId -> UNSORTED timestamps
 * @returns {Promise<Array<{u1: string, u2: string, syncCount: number}>>}
 */
export async function detectSynchronizedPosting(timestampsByUser, timeWindow, minSyncPosts, yieldFn = null, onProgress = null) {
  // Sort each user's timestamps once
  const sortedByUser = new Map();
  timestampsByUser.forEach((timestamps, userId) => {
    sortedByUser.set(userId, [...timestamps].sort((a, b) => a - b));
  });

  // Bucket users by time window
  const timeBuckets = new Map();
  sortedByUser.forEach((timestamps, userId) => {
    for (let i = 0; i < timestamps.length; i++) {
      const bucketKey = Math.floor(timestamps[i] / timeWindow);
      let bucket = timeBuckets.get(bucketKey);
      if (!bucket) {
        bucket = new Set();
        timeBuckets.set(bucketKey, bucket);
      }
      bucket.add(userId);
    }
  });

  const results = [];
  const processedPairs = new Set();
  const bucketKeys = Array.from(timeBuckets.keys()).sort((a, b) => a - b);
  let bucketsDone = 0;

  for (const bucketKey of bucketKeys) {
    // Candidate users: this bucket plus the next one (covers all pairs whose
    // synchronized posts straddle a bucket boundary; symmetric pairs from the
    // previous bucket were already handled when that bucket was processed).
    const users = new Set(timeBuckets.get(bucketKey));
    const nextBucket = timeBuckets.get(bucketKey + 1);
    if (nextBucket) nextBucket.forEach(u => users.add(u));

    const userIds = Array.from(users);
    for (let i = 0; i < userIds.length; i++) {
      for (let j = i + 1; j < userIds.length; j++) {
        const u1 = userIds[i];
        const u2 = userIds[j];
        const pairKey = u1 < u2 ? `${u1}|${u2}` : `${u2}|${u1}`;
        if (processedPairs.has(pairKey)) continue;
        processedPairs.add(pairKey);

        const syncCount = countSyncPairs(sortedByUser.get(u1), sortedByUser.get(u2), timeWindow);
        if (syncCount >= minSyncPosts) {
          results.push({ u1, u2, syncCount });
        }
      }
    }

    bucketsDone++;
    if (yieldFn && bucketsDone % 25 === 0) await yieldFn();
    if (onProgress && bucketsDone % 100 === 0) onProgress(bucketsDone, bucketKeys.length);
  }

  return results;
}

// =========================
// Embedding similarity helpers
// =========================

/**
 * Find all pairs of embedding rows with cosine similarity >= threshold.
 * Embeddings are expected to be L2-normalized (cosine == dot product).
 * Exhaustive blocked pairwise comparison over a packed Float32Array —
 * every pair is compared, nothing is sampled.
 *
 * @param {Float32Array} matrix - rowCount × dims, row-major, normalized
 * @param {number} rowCount
 * @param {number} dims
 * @param {number} threshold
 * @param {Function} [shouldPair] - optional (i, j) => boolean pre-filter
 * @param {Function} [yieldFn]
 * @param {Function} [onProgress] - (done, total) over outer rows
 * @returns {Promise<Array<{i: number, j: number, similarity: number}>>}
 */
export async function findSimilarEmbeddingPairs(matrix, rowCount, dims, threshold, shouldPair = null, yieldFn = null, onProgress = null) {
  const results = [];

  for (let i = 0; i < rowCount; i++) {
    const offsetI = i * dims;
    for (let j = i + 1; j < rowCount; j++) {
      if (shouldPair && !shouldPair(i, j)) continue;
      const offsetJ = j * dims;
      let dot = 0;
      for (let d = 0; d < dims; d++) {
        dot += matrix[offsetI + d] * matrix[offsetJ + d];
      }
      if (dot >= threshold) {
        results.push({ i, j, similarity: dot });
      }
    }
    if (yieldFn && i % 64 === 0) await yieldFn();
    if (onProgress && i % 128 === 0) onProgress(i, rowCount);
  }

  return results;
}
