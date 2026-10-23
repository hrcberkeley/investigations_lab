/**
 * SHARED UTILITIES
 *
 * Pure helper functions used across the main thread, worker, and report generator.
 * Keep this module dependency-free so it can be imported everywhere.
 */

/**
 * Safe max that avoids spread-operator stack limits on large arrays.
 */
export function safeMax(array) {
  if (!array || array.length === 0) return 0;
  let max = array[0];
  for (let i = 1; i < array.length; i++) {
    if (array[i] > max) max = array[i];
  }
  return max;
}

/**
 * Safe min that avoids spread-operator stack limits on large arrays.
 */
export function safeMin(array) {
  if (!array || array.length === 0) return 0;
  let min = array[0];
  for (let i = 1; i < array.length; i++) {
    if (array[i] < min) min = array[i];
  }
  return min;
}

/**
 * Escape HTML entities to prevent injection.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape an attribute value (HTML + back-tick for unquoted contexts).
 */
export function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

/**
 * Convert a hex colour string to normalised [r, g, b, a] floats.
 */
export function hexToFloatColor(hex, alpha = 1) {
  const normalized = hex.replace('#', '');
  const bigint = parseInt(normalized, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return [r / 255, g / 255, b / 255, alpha];
}

/**
 * Build a stable lookup key for a normalized post object.
 * Used when object-reference equality cannot be relied on
 * (e.g. after JSON deserialization).
 */
export function getPostKey(post) {
  const d = post?.data || {};
  const author = d.author || {};
  return `${d.id || ''}|${d.createTime || 0}|${author.id || ''}|${(d.desc || '').slice(0, 40)}`;
}
