/**
 * NORMALIZATION.JS
 *
 * This module normalizes data from different social media platforms (TikTok, Instagram, Twitter)
 * into a unified format that the rest of the application can work with. It handles differences
 * in field names, data structures, and platform-specific features across platforms.
 */

import { extractUrlsFromText, normalizeUrl } from './cib-algorithms.js';

/**
 * Detect which platform a post comes from based on source_platform field
 * 
 * Different platforms use different data structures, so we need to identify
 * the source to apply the correct normalization logic.
 * 
 * @param {Object} post - Raw post data object
 * @returns {string} Platform identifier: 'tiktok', 'instagram', 'twitter', or 'unknown'
 */
function detectPlatform(post) {
  const platform = post.source_platform || '';

  // 1. Check explicit platform string
  if (platform.includes('instagram')) return 'instagram';
  if (platform.includes('tiktok')) return 'tiktok';
  if (platform.includes('twitter') || platform.includes('x.com')) return 'twitter';

  // 2. Fallback: Infer from data structure
  const data = post.data || {};

  // Instagram: usually has 'owner' or 'user' object and 'caption'
  if ((data.owner || data.user) && (data.caption || data.taken_at)) {
    return 'instagram';
  }

  // TikTok: usually has 'author' object with 'uniqueId' and 'challenges' array
  if (data.author && data.author.uniqueId && Array.isArray(data.challenges)) {
    return 'tiktok';
  }

  // TikTok (alternative): sometimes just 'author' and 'desc'
  if (data.author && data.desc !== undefined && data.createTime) {
    return 'tiktok';
  }

  // Twitter: usually has 'core' user data or 'legacy' tweet data
  if (data.core || (data.legacy && data.legacy.full_text)) {
    return 'twitter';
  }

  return 'unknown';
}

/**
 * Extract hashtags from text using regex pattern matching
 * 
 * Finds all hashtags in format #hashtag and converts them to normalized
 * format with unique IDs for use in the application.
 * 
 * @param {string} text - Text to extract hashtags from
 * @returns {Array<Object>} Array of hashtag objects with id and title
 */
function extractHashtagsFromText(text) {
  if (!text) return [];
  // Match hashtags using regex: # followed by word characters
  const matches = text.match(/#(\w+)/g) || [];
  // Convert each match to normalized format with unique ID
  return matches.map((tag, idx) => ({
    id: `ig_${tag.substring(1)}_${idx}`,  // Remove # and create unique ID
    title: tag.substring(1)                 // Hashtag text without #
  }));
}

/**
 * Extract user mentions from text using regex pattern matching
 * 
 * Finds all mentions in format @username and converts them to normalized
 * format for building mention networks.
 * 
 * @param {string} text - Text to extract mentions from
 * @returns {Array<Object>} Array of mention objects with username
 */
function extractMentionsFromText(text) {
  if (!text) return [];
  // Match mentions using regex: @ followed by word characters
  const matches = text.match(/@(\w+)/g) || [];
  // Convert each match to normalized format
  return matches.map(mention => ({
    username: mention.substring(1)  // Remove @ symbol
  }));
}

/**
 * Main normalization function - converts platform-specific data to unified format
 * 
 * This is the core normalization function that takes raw platform data and
 * converts it into a standardized format with consistent field names and structures.
 * It handles platform-specific variations and extracts all relevant information
 * needed for network analysis and CIB detection.
 * 
 * @param {Object} post - Raw post data from a social media platform
 * @returns {Object} Normalized post data with consistent structure
 */
function normalizePost(post) {
  // Detect which platform this post is from
  const platform = detectPlatform(post);
  // Start with copy of original post and add platform identifier
  const normalized = { ...post, platform };

  // Apply platform-specific normalization based on detected platform
  if (platform === 'instagram') {
    // Instagram-specific normalization
    const ig = post.data;
    // Instagram data may have author under 'owner' or 'user' field
    const owner = ig.owner || ig.user || {};
    // Extract caption text, handling nested structure
    const caption = ig.caption?.text || '';

    // Create normalized structure with Instagram-specific mapping
    normalized.data = {
      ...ig,
      // Map author fields to consistent format
      author: {
        id: owner.pk || owner.id,
        uniqueId: owner.username,
        nickname: owner.full_name || owner.username,
        verified: owner.is_verified || false
      },
      // Map timestamp (Instagram uses taken_at)
      createTime: ig.taken_at,
      // Map description/caption
      desc: caption,
      // Extract hashtags from caption text (Instagram has them embedded in text)
      challenges: extractHashtagsFromText(caption),
      // Extract shared URLs from caption text (Session 5: URL co-sharing)
      urls: extractUrlsFromText(caption),
      // Convert mentions to standardized format
      textExtra: extractMentionsFromText(caption).map(m => ({
        type: 0,
        userUniqueId: m.username,
        userId: null
      })),
      // Map engagement stats to consistent naming
      stats: {
        diggCount: ig.like_count || 0,
        commentCount: ig.comment_count || 0,
        shareCount: 0,  // Instagram doesn't track shares separately
        playCount: ig.view_count || 0
      },
      // Author stats (follower count not always available)
      authorStats: {
        followerCount: 0
      },
      // Store Instagram-specific data that might be useful
      _instagram: {
        location: ig.location,
        usertags: ig.usertags,
        carousel_media: ig.carousel_media
      }
    };
  } else if (platform === 'tiktok') {
    // TikTok data structure is already close to our normalized format
    // Just copy the data as-is since TikTok export format is compatible
    normalized.data = { ...post.data };
    // Extract shared URLs from caption text (Session 5: URL co-sharing)
    if (!normalized.data.urls) {
      normalized.data.urls = extractUrlsFromText(normalized.data.desc || '');
    }
  } else if (platform === 'twitter') {
    // Twitter-specific normalization
    const tweet = post.data;
    // Twitter has deeply nested user data structure
    const userResult = tweet.core?.user_results?.result || {};
    const userCore = userResult.core || {};
    const userLegacy = userResult.legacy || {};
    const tweetLegacy = tweet.legacy || {};

    /**
     * Helper function to parse Twitter's date format to Unix timestamp
     * Twitter uses ISO 8601 date strings that need conversion to Unix seconds
     * 
     * @param {string} dateStr - ISO 8601 date string from Twitter
     * @returns {number|null} Unix timestamp in seconds, or null if parsing fails
     */
    const parseTwitterDate = (dateStr) => {
      if (!dateStr) return null;
      const date = new Date(dateStr);
      // Convert milliseconds to seconds for consistency with other platforms
      const timestamp = Math.floor(date.getTime() / 1000);
      if (isNaN(timestamp)) {
        console.warn('Failed to parse Twitter date:', dateStr);
        return null;
      }
      return timestamp;
    };

    // Extract mentions from Twitter's entity structure
    const mentions = (tweetLegacy.entities?.user_mentions || []).map(m => ({
      type: 0,
      userUniqueId: m.screen_name,
      userId: m.id_str
    }));

    // Extract hashtags from Twitter's entity structure
    const hashtags = (tweetLegacy.entities?.hashtags || []).map(h => ({
      id: h.text,
      title: h.text
    }));

    // Extract shared URLs (Session 5): prefer expanded_url over the t.co
    // shortener; fall back to scanning the tweet text. De-dupe by normalized URL.
    const urlSeen = new Set();
    const urls = [];
    (tweetLegacy.entities?.urls || []).forEach(u => {
      const norm = normalizeUrl(u.expanded_url || u.url);
      if (norm && !urlSeen.has(norm.url)) { urlSeen.add(norm.url); urls.push(norm); }
    });
    extractUrlsFromText(tweetLegacy.full_text || '').forEach(norm => {
      // Skip t.co shorteners already represented by their expanded form.
      if (norm.domain === 't.co') return;
      if (!urlSeen.has(norm.url)) { urlSeen.add(norm.url); urls.push(norm); }
    });

    // Extract repost/quote target author (Session 5: co-repost network).
    const refResult = tweetLegacy.retweeted_status_result?.result
      || tweet.quoted_status_result?.result
      || tweetLegacy.quoted_status_result?.result;
    let repost = null;
    if (refResult) {
      const refUser = refResult.core?.user_results?.result || refResult.legacy?.user || {};
      const refScreen = refResult.core?.user_results?.result?.core?.screen_name
        || refResult.core?.user_results?.result?.legacy?.screen_name;
      const refId = refResult.core?.user_results?.result?.rest_id;
      if (refScreen || refId) {
        repost = {
          kind: tweetLegacy.retweeted_status_result ? 'retweet' : 'quote',
          targetId: refId || refScreen,
          targetName: refScreen || refId,
        };
      }
    }
    // Fallback: parse "RT @name:" prefix when structured data is absent.
    if (!repost) {
      const rt = /^RT @([A-Za-z0-9_]+):/.exec(tweetLegacy.full_text || '');
      if (rt) repost = { kind: 'retweet', targetId: rt[1], targetName: rt[1] };
    }

    // Debug logging for entities
    if (mentions.length > 0 || hashtags.length > 0) {
      console.log(`Tweet ${tweet.rest_id}: ${mentions.length} mentions, ${hashtags.length} hashtags`);
    }

    // Create normalized structure with Twitter-specific mapping
    normalized.data = {
      id: tweet.rest_id,
      // Map author fields from deeply nested Twitter structure
      author: {
        id: userResult.rest_id,
        uniqueId: userCore.screen_name || '',
        nickname: userCore.name || '',
        verified: userResult.is_blue_verified || userResult.verification?.verified || false,
        createTime: parseTwitterDate(userCore.created_at)  // User account creation time
      },
      createTime: parseTwitterDate(tweetLegacy.created_at),  // Tweet creation time
      desc: tweetLegacy.full_text || '',  // Full tweet text
      challenges: hashtags,  // Hashtags extracted from entities
      urls,                  // Shared URLs (expanded), Session 5
      repost,                // Repost/quote target author, Session 5
      textExtra: mentions,   // Mentions extracted from entities
      // Map engagement stats to consistent naming
      stats: {
        diggCount: tweetLegacy.favorite_count || 0,
        commentCount: tweetLegacy.reply_count || 0,
        shareCount: tweetLegacy.retweet_count || 0,
        playCount: parseInt(tweet.views?.count || '0')
      },
      // Map author statistics
      authorStats: {
        followerCount: userLegacy.followers_count || 0,
        followingCount: userLegacy.friends_count || 0,
        heartCount: userLegacy.favourites_count || 0,
        videoCount: userLegacy.statuses_count || 0
      }
    };
  }

  // Return the normalized post with platform identifier
  return normalized;
}

/**
 * Normalize an entire dataset by applying normalization to each post
 * 
 * This function processes an array of raw social media posts and converts
 * all of them to the unified format. It's the main entry point for data
 * normalization from the application.
 * 
 * @param {Array<Object>} data - Array of raw post objects from platform(s)
 * @returns {Array<Object>} Array of normalized post objects
 */
export function normalizeRawData(data) {
  // Apply normalization function to each post in the dataset
  return data.map(post => normalizePost(post));
}
