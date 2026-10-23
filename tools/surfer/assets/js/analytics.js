/**
 * ANALYTICS.JS
 *
 * Main-thread analytics helpers. The CIB detection algorithms themselves live
 * in cib-algorithms.js (shared with the web worker) — they are re-exported
 * here for convenience so existing imports keep working. Do not duplicate
 * algorithm code in this file.
 */

export {
  calculateDatasetStatistics,
  calculateTFIDF,
  buildHashtagStatistics,
  tfidfScore,
  getNGrams,
  ngramOverlap,
  ngramSetOverlap,
  levenshteinDistance,
  levenshteinWithin,
  groupSimilarUsernames,
  analyzePostingRhythm,
  analyzeNightPosting,
  detectAccountCreationClusters,
  detectTemporalBursts,
  detectSynchronizedPosting,
  countSyncPairs,
} from './cib-algorithms.js';

/**
 * Filter dataset based on engagement and date range criteria
 *
 * Filters posts to include only those meeting the specified engagement threshold
 * and falling within the specified date range. Used to focus analysis on high-
 * quality content from specific time periods.
 *
 * @param {Array<Object>} rawData - Array of normalized post objects
 * @param {Object} options - Filter options
 * @param {number} options.minEngagement - Minimum total engagement (likes+comments+shares)
 * @param {number} options.startDate - Unix timestamp for start of date range
 * @param {number} options.endDate - Unix timestamp for end of date range
 * @param {Function} options.onDebug - Optional callback to debug filtered posts
 * @returns {Array<Object>} Filtered array of posts
 */
export function filterData(rawData, { minEngagement, startDate, endDate, onDebug } = {}) {
  const minimum = Number.isFinite(minEngagement) ? minEngagement : 0;
  const start = Number.isFinite(startDate) ? startDate : 0;
  const end = Number.isFinite(endDate) ? endDate : Infinity;

  let debugCount = 0;
  return rawData.filter(post => {
    // Calculate total engagement for this post
    const engagement = (post.data?.stats?.diggCount || 0) +
                       (post.data?.stats?.commentCount || 0) +
                       (post.data?.stats?.shareCount || 0);
    const postTime = post.data?.createTime;

    // Check if post passes date filter (include posts without timestamps only if no date filter is set)
    const passesDateFilter = !postTime
      ? (!Number.isFinite(startDate) && !Number.isFinite(endDate))
      : (postTime >= start && postTime <= end);

    // Check if post meets engagement threshold
    const passesEngagement = engagement >= minimum;

    // Debug logging for posts that fail filtering
    if (onDebug && debugCount < 3 && (!passesEngagement || !passesDateFilter)) {
      onDebug(post, {
        engagement,
        minEngagement: minimum,
        passesEngagement,
        postTime,
        hasDateStart: Number.isFinite(startDate),
        hasDateEnd: Number.isFinite(endDate),
        passesDateFilter,
        createTime: post.data?.createTime,
      });
      debugCount += 1;
    }

    // Post must pass both filters to be included
    return passesEngagement && passesDateFilter;
  });
}
