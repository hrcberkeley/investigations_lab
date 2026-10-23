/**
 * Synthetic injection validation (Session 7). Pure, seeded, Node-testable.
 *
 * Generates a configurable coordinated cluster of normalized posts that should
 * trip the detectors (synchronized timing, templated/verbatim captions, shared
 * rare hashtags, patterned usernames, clustered creation dates, a shared rare
 * URL). Injecting it into a real dataset, running detection, and reporting which
 * detectors caught the plant teaches detector sensitivity and doubles as an
 * end-to-end regression check. Posts are tagged `platform: 'synthetic'` so they
 * can be stripped byte-for-byte afterward.
 */
import { mulberry32 } from './graph-algorithms.js';

const TEMPLATE_CAPTIONS = [
  'BREAKING: everyone needs to see this right now, share before it is gone {tag}',
  'I cannot believe what is happening, this changes everything {tag}',
  'The truth they do not want you to know, wake up and look {tag}',
];

const PARAPHRASE_POOL = [
  ['huge', 'massive', 'enormous', 'giant'],
  ['news', 'update', 'report', 'story'],
  ['everyone', 'everybody', 'all of you', 'folks'],
  ['must', 'need to', 'have to', 'should'],
  ['see', 'watch', 'view', 'look at'],
];

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * @param {object} options
 * @returns {{ posts: Array, accountIds: string[], options: object }}
 */
export function generateCoordinatedCluster(options = {}) {
  const {
    seed = 1,
    size = 5,                       // number of coordinated accounts
    postsPerAccount = 8,
    baseTime = 1_700_000_000,       // campaign start (unix sec)
    syncIntervalSec = 3600,         // accounts post in lockstep every hour…
    syncJitterSec = 20,             // …within this jitter (tight → sync fires)
    captionStrategy = 'templated',  // 'verbatim' | 'templated' | 'paraphrase'
    usernamePrefix = 'patriot_bot_',
    sharedHashtags = ['stopthesteal2026', 'wakeupnow7'],
    sharedUrl = 'evil.example/promo-9931',
    creationClustered = true,
    creationBase = 1_690_000_000,
    idPrefix = 'syn_',
  } = options;

  const rng = mulberry32(seed);
  const posts = [];
  const accountIds = [];

  for (let a = 0; a < size; a++) {
    const id = `${idPrefix}${a}`;
    accountIds.push(id);
    const uniqueId = `${usernamePrefix}${String(a + 1).padStart(3, '0')}`;
    // Clustered creation: all within a ~6h window (well under 24h).
    const authorCreateTime = creationClustered
      ? creationBase + Math.floor(rng() * 21600)
      : creationBase + Math.floor(rng() * 31_536_000);

    for (let k = 0; k < postsPerAccount; k++) {
      // Synchronized timing: every account posts around the same instants.
      const jitter = Math.floor((rng() - 0.5) * 2 * syncJitterSec);
      const createTime = baseTime + k * syncIntervalSec + jitter;

      let desc;
      if (captionStrategy === 'verbatim') {
        desc = TEMPLATE_CAPTIONS[0];
      } else if (captionStrategy === 'paraphrase') {
        desc = `This is ${pick(rng, PARAPHRASE_POOL[0])} ${pick(rng, PARAPHRASE_POOL[1])} ${pick(rng, PARAPHRASE_POOL[2])} ${pick(rng, PARAPHRASE_POOL[3])} ${pick(rng, PARAPHRASE_POOL[4])} this important coordinated message about the campaign today`;
      } else {
        // templated: same skeleton, rotating slot — high n-gram overlap
        const tpl = TEMPLATE_CAPTIONS[k % TEMPLATE_CAPTIONS.length];
        desc = tpl.replace('{tag}', `#${sharedHashtags[0]}`);
      }

      posts.push({
        platform: 'synthetic',
        synthetic: true,
        item_id: `${id}_p${k}`,
        data: {
          author: {
            id,
            uniqueId,
            nickname: uniqueId,
            verified: false,
            createTime: authorCreateTime,
          },
          createTime,
          desc,
          challenges: sharedHashtags.map(h => ({ id: h, title: h })),
          urls: sharedUrl ? [{ url: sharedUrl, domain: sharedUrl.split('/')[0] }] : [],
          repost: null,
          stats: { diggCount: 0, commentCount: 0, shareCount: 0, playCount: 0 },
          authorStats: { followerCount: 10 + Math.floor(rng() * 50) },
        },
      });
    }
  }

  return { posts, accountIds, options: { size, postsPerAccount, captionStrategy } };
}

const DETECTOR_LABELS = {
  sync: 'Synchronized posting',
  semantic: 'Semantic captions',
  template: 'Template captions',
  hashtags: 'Rare hashtags',
  urls: 'Shared rare URLs',
  username: 'Similar usernames',
  creation: 'Clustered creation',
  repost: 'Co-repost',
  volume: 'High volume',
  burst: 'Posting bursts',
  rhythm: 'Regular rhythm',
  night: '24/7 posting',
};

/**
 * Build a report card comparing the planted accounts against detection output.
 *
 * @param {string[]} plantedIds
 * @param {object} cib - { suspiciousUsers:Set|Array, userReasons:Map|Array, indicatorKeysByUser?:Map }
 *   `indicatorKeysByUser` (id -> Set<key>) is preferred; otherwise indicators are
 *   inferred from the reason strings.
 * @returns {{ caught, missed, plantedCaughtCount, organicFlaggedCount,
 *             detectorHits, totalPlanted }}
 */
export function buildDetectionReportCard(plantedIds, cib) {
  const suspicious = cib.suspiciousUsers instanceof Set
    ? cib.suspiciousUsers
    : new Set(cib.suspiciousUsers || []);
  const reasonsMap = cib.userReasons instanceof Map
    ? cib.userReasons
    : new Map(cib.userReasons || []);
  const indicatorKeysByUser = cib.indicatorKeysByUser || null;

  const plantedSet = new Set(plantedIds);

  const indicatorsFor = (id) => {
    if (indicatorKeysByUser && indicatorKeysByUser.has(id)) return new Set(indicatorKeysByUser.get(id));
    // Infer from reason text.
    const reasons = reasonsMap.get(id) || [];
    const keys = new Set();
    for (const r of reasons) {
      const lower = r.toLowerCase();
      if (lower.includes('synchronized')) keys.add('sync');
      if (lower.includes('semantically')) keys.add('semantic');
      if (lower.includes('template')) keys.add('template');
      if (lower.includes('rare hashtag')) keys.add('hashtags');
      if (lower.includes('rare url')) keys.add('urls');
      if (lower.includes('username')) keys.add('username');
      if (lower.includes('created with')) keys.add('creation');
      if (lower.includes('co-amplified')) keys.add('repost');
      if (lower.includes('high-volume')) keys.add('volume');
      if (lower.includes('burst')) keys.add('burst');
      if (lower.includes('rhythm')) keys.add('rhythm');
      if (lower.includes('24/7')) keys.add('night');
    }
    return keys;
  };

  const caught = [];
  const missed = [];
  const detectorHits = {};
  for (const id of plantedIds) {
    if (suspicious.has(id)) {
      const keys = indicatorsFor(id);
      keys.forEach(k => { detectorHits[k] = (detectorHits[k] || 0) + 1; });
      caught.push({ id, indicators: Array.from(keys) });
    } else {
      missed.push(id);
    }
  }

  let organicFlaggedCount = 0;
  suspicious.forEach(id => { if (!plantedSet.has(id)) organicFlaggedCount++; });

  return {
    caught,
    missed,
    plantedCaughtCount: caught.length,
    totalPlanted: plantedIds.length,
    organicFlaggedCount,
    detectorHits,
  };
}

export { DETECTOR_LABELS };
