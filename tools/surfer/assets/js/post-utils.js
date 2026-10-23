/**
 * Post Utilities
 *
 * Pure helper functions for working with normalized post objects.
 */

/**
 * Calculate total engagement for a post across all platform-specific stat fields.
 */
export function postEngagement(post) {
  const stats = post?.data?.stats || post?.stats || {};
  const instagramStats = post?.data?._instagram?.insights || post?.data?._instagram || {};

  const fields = [
    'diggCount', 'commentCount', 'shareCount', 'playCount', 'forwardCount', 'collectCount', 'favoriteCount',
    'likeCount', 'viewCount', 'share_count', 'comment_count', 'like_count', 'play_count', 'favorite_count',
    'saveCount', 'play', 'likes', 'comments', 'shares', 'views'
  ];

  let total = 0;
  fields.forEach(key => { total += Number(stats[key] ?? instagramStats[key] ?? 0) || 0; });
  return total;
}

/**
 * Normalize a user identifier by lowercasing and stripping prefixes.
 */
export function normalizeUserIdentifier(value) {
  if (value === undefined || value === null) return null;
  return String(value).toLowerCase().replace(/^user_/, '').replace(/^u_/, '').replace(/^@/, '');
}

/**
 * Validate an external URL, allowing only http/https protocols.
 */
export function safeExternalUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
  } catch (e) {
    return null;
  }
  return null;
}

/**
 * Check whether a post matches a given node (by ID, label, or normalized identifier).
 */
export function postMatchesNode(post, node) {
  if (!post || !node) return false;
  const type = node.type || 'user';
  const nodeId = String(node.id ?? '').toLowerCase();
  const normalizedNodeId = normalizeUserIdentifier(node.id);
  const nodeLabel = node.label ? String(node.label).toLowerCase().replace(/^@/, '') : null;

  if (type === 'user') {
    const author = post?.data?.author || post?.author || {};
    const authorId = author.id != null ? String(author.id).toLowerCase() : null;
    const authorHandle = author.uniqueId ? String(author.uniqueId).toLowerCase() : null;
    const normalizedAuthorId = normalizeUserIdentifier(author.id);

    if (authorId && authorId === nodeId) return true;
    if (normalizedNodeId && normalizedAuthorId && normalizedNodeId === normalizedAuthorId) return true;
    if (nodeLabel && authorHandle && nodeLabel === authorHandle) return true;

    const mentions = post?.data?.textExtra?.filter(m => m.type === 0) || [];
    return mentions.some(m => {
      const mentionId = m.userId != null ? String(m.userId).toLowerCase() : null;
      const normalizedMentionId = normalizeUserIdentifier(m.userId || (m.userUniqueId ? `user_${m.userUniqueId}` : null));
      const mentionHandle = m.userUniqueId ? String(m.userUniqueId).toLowerCase() : null;

      if (mentionId && mentionId === nodeId) return true;
      if (normalizedNodeId && normalizedMentionId && normalizedNodeId === normalizedMentionId) return true;
      if (nodeLabel && mentionHandle && nodeLabel === mentionHandle) return true;
      return false;
    });
  }

  if (type === 'hashtag') {
    const title = nodeLabel;
    const challenges = post?.data?.challenges || [];
    return challenges.some(tag => {
      const tagId = tag?.id != null ? String(tag.id).toLowerCase() : null;
      const tagTitle = tag?.title ? String(tag.title).toLowerCase() : null;
      if (tagId && tagId === nodeId) return true;
      if (title && tagTitle && title === tagTitle) return true;
      return false;
    });
  }

  if (type === 'location') {
    const location = post?.data?._instagram?.location || post?.data?.location || {};
    if (!location) return false;
    const locationId = location.id != null ? String(location.id).toLowerCase() : null;
    const locationName = location.name ? String(location.name).toLowerCase() : null;
    if (locationId && locationId === nodeId) return true;
    if (nodeLabel && locationName && nodeLabel === locationName) return true;
    return false;
  }

  if (type === 'sound' || type === 'music') {
    const music = post?.data?.music || {};
    const musicId = music?.id != null ? String(music.id).toLowerCase() : null;
    const musicTitle = music?.title ? String(music.title).toLowerCase() : null;
    if (musicId && musicId === nodeId) return true;
    if (nodeLabel && musicTitle && nodeLabel === musicTitle) return true;
    return false;
  }

  // Generic fallback: try matching by ID or label string inclusion
  const combined = JSON.stringify(post).toLowerCase();
  if (nodeId && combined.includes(nodeId)) return true;
  if (nodeLabel && combined.includes(nodeLabel)) return true;
  return false;
}
