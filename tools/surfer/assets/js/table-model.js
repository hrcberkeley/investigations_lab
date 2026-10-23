/**
 * Node-table model (Session 4). Pure, no DOM — Node-testable.
 *
 * Builds, filters and sorts the rows behind the accessible/scannable node table.
 * The table is the full dataset (no sampling) — virtualization in table-view.js
 * keeps rendering cheap; this module just shapes and orders the data.
 */

export const TABLE_COLUMNS = [
  { key: 'label', label: 'Account', type: 'text' },
  { key: 'type', label: 'Type', type: 'text' },
  { key: 'degree', label: 'Degree', type: 'number' },
  { key: 'community', label: 'Community', type: 'text' },
  { key: 'followers', label: 'Followers', type: 'number' },
  { key: 'posts', label: 'Posts', type: 'number' },
  { key: 'score', label: 'CIB score', type: 'number' },
  { key: 'indicators', label: 'Indicators', type: 'number' },
];

export function buildTableRow(node, communityName) {
  const followers = typeof node.followers === 'number' ? node.followers : null;
  const posts = typeof node.count === 'number' ? node.count : null;
  const flagged = !!node.suspicious;
  return {
    id: node.id,
    label: String(node.label ?? node.id ?? ''),
    type: node.type === 'user'
      ? (node.verified ? 'user (verified)' : 'user')
      : String(node.type ?? 'node'),
    degree: Number.isFinite(node.degree) ? node.degree : 0,
    community: communityName ?? '—',
    followers,
    posts,
    score: flagged && Number.isFinite(node.cibScore) ? node.cibScore : 0,
    indicators: Array.isArray(node.cibReasons) ? node.cibReasons.length : 0,
    flagged,
  };
}

export function buildTableRows(nodes, communityNameFor) {
  return nodes.map(n => buildTableRow(n, communityNameFor ? communityNameFor(n) : '—'));
}

export function filterTableRows(rows, { text = '', flaggedOnly = false } = {}) {
  const q = String(text).trim().toLowerCase();
  if (!q && !flaggedOnly) return rows.slice();
  return rows.filter(r => {
    if (flaggedOnly && !r.flagged) return false;
    if (!q) return true;
    return r.label.toLowerCase().includes(q)
      || r.type.toLowerCase().includes(q)
      || String(r.community).toLowerCase().includes(q);
  });
}

const COLUMN_TYPE = new Map(TABLE_COLUMNS.map(c => [c.key, c.type]));

export function sortTableRows(rows, key, dir = 'desc') {
  const numeric = COLUMN_TYPE.get(key) === 'number';
  const sign = dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    if (numeric) {
      // Missing numeric values (null followers/posts) sink to the bottom
      // regardless of sort direction.
      const aMiss = !Number.isFinite(a[key]);
      const bMiss = !Number.isFinite(b[key]);
      if (aMiss || bMiss) {
        if (aMiss && bMiss) return a.label.localeCompare(b.label);
        return aMiss ? 1 : -1;
      }
      if (a[key] !== b[key]) return (a[key] - b[key]) * sign;
      return a.label.localeCompare(b.label);
    }
    const av = String(a[key] ?? '').toLowerCase();
    const bv = String(b[key] ?? '').toLowerCase();
    if (av === bv) return a.label.localeCompare(b.label);
    return av < bv ? -sign : sign;
  });
}
