/**
 * UI Controller
 *
 * DOM-only rendering helpers for stats, legends, coaching tips, and modals.
 */

import { escapeHtml, escapeAttr } from './utils.js';
import { graphData, networkMetrics, communities, vizManager, rawData, filteredData, nodes, cibDetection, adjacency, idToNode, comparisonState, setComparisonState, coordinationGraph } from './state.js';
import { communityColors, SIGNAL_COLORS } from './visualization.js';
import { postEngagement, postMatchesNode, normalizeUserIdentifier, safeExternalUrl } from './post-utils.js';
import { toast } from './notifications.js';

export function updateStatCards(statsData) {
  if (!statsData) return;
  const posts = document.getElementById('stat-posts');
  const users = document.getElementById('stat-users');
  const hashtags = document.getElementById('stat-hashtags');
  const engagement = document.getElementById('stat-engagement');

  if (posts) posts.textContent = (statsData.posts ?? 0).toLocaleString();
  if (users) users.textContent = (statsData.users ?? 0).toLocaleString();
  if (hashtags) hashtags.textContent = (statsData.hashtags ?? 0).toLocaleString();
  if (engagement) engagement.textContent = (statsData.engagement ?? 0).toLocaleString();
}

export function updateCoach() {
  const coach = document.getElementById('edu-coach');
  const networkTypeSelect = document.getElementById('network-type');
  if (!coach) return;

  if (!graphData || !graphData.nodes.length) {
    coach.innerHTML = `<p><b>Coach</b> load data, then hover or click nodes.</p>`;
    return;
  }

  const dens = networkMetrics?.density ?? 0;
  const commCount = communities?.count ?? 0;

  let hint = '';
  const networkType = networkTypeSelect ? networkTypeSelect.value : 'hashtag';
  if (networkType === 'coordinationNetwork') {
    const compCount = coordinationGraph?.components?.length ?? 0;
    const singletons = coordinationGraph?.components?.filter(c => c.length === 1).length ?? 0;
    hint = `Coordination Network: nodes are flagged accounts, edges are evidence links. ${compCount} connected component${compCount !== 1 ? 's' : ''} (${singletons} singleton${singletons !== 1 ? 's' : ''} flagged by solo indicators). Edge colors show signal type — click a node to see its coordination partners.`;
  } else if (networkType === 'coHashtag') {
    hint = `You're looking at hashtag co-occurrence. Dense cliques can reflect coordinated messaging or just memes — check example posts in the modal.`;
  } else if (networkType === 'userHashtag') {
    hint = `This is a bipartite user↔hashtag graph. Click a hashtag hub: who uses it? One community or many?`;
  } else if (networkType === 'mention') {
    hint = `Mention networks highlight attention-giving. Are hubs amplifying each other, or bridging clusters?`;
  } else if (networkType === 'photoTag') {
    hint = `📷 Instagram photo tag network: see who tags whom in photos. This reveals collaboration and relationship patterns.`;
  } else if (networkType === 'location') {
    hint = `📍 Instagram location network: where are users posting from? Shared locations can indicate coordinated campaigns or events.`;
  } else {
    hint = `Hashtag usage view shows which tags carry engagement; hubs suggest narrative anchors.`;
  }

  const densNote = (parseFloat(dens) >= 0.15)
    ? `High density (${dens}) ⇒ tight interlinking. Inspect hubs for templated captions or synchronized timing.`
    : `Lower density (${dens}) ⇒ fragmented/diverse activity. Look for bridges and outliers.`;

  const commNote = commCount
    ? `Detected <b>${commCount}</b> community${commCount > 1 ? 'ies' : ''}. Compare top tags/posts across them for narrative splits.`
    : `Run "Detect Communities" to see sub-audiences.`;

  coach.innerHTML = `
    <p><b>Coach:</b> ${hint}</p>
    <p>${densNote}</p>
    <p>${commNote}</p>
  `;
}

export function renderLegend() {
  const legendContent = document.getElementById('legend-content');
  if (!legendContent || !vizManager) return;

  const networkTypeSelect = document.getElementById('network-type');
  if (networkTypeSelect?.value === 'coordinationNetwork') {
    const signalLabels = {
      sync: 'Synchronized posting',
      semantic: 'Semantic caption similarity',
      template: 'Template caption overlap',
      urls: 'Shared rare URLs',
      repost: 'Co-amplified accounts',
      hashtags: 'Shared rare hashtags',
      username: 'Similar usernames',
      creation: 'Clustered account creation',
    };
    legendContent.innerHTML = '<div style="font-size:0.7rem; font-weight:700; color:#374151; margin-bottom:0.4rem;">Edge signal type</div>' +
      Object.entries(signalLabels).map(([sig, label]) =>
        `<div class="legend-item"><div class="legend-dot" style="background:${SIGNAL_COLORS[sig]};"></div><span>${label}</span></div>`
      ).join('');
    return;
  }

  const mode = vizManager.mode;

  if (mode === 'risk') {
    legendContent.innerHTML = `
      <div class="risk-ramp" role="img" aria-label="CIB risk score colour scale: amber for lower scores grading to deep red for the highest.">
        <div class="risk-ramp-bar"></div>
        <div class="risk-ramp-labels"><span>Lower</span><span>CIB score</span><span>Higher</span></div>
      </div>
      <div class="legend-item"><div class="legend-dot" style="background:#d1d5db;"></div><span>Not flagged</span></div>
      <div class="legend-note">Flagged accounts shade amber → red by score. Open the table view for exact, sortable scores.</div>
    `;
    return;
  }

  if (mode === 'community') {
    const stats = vizManager.currentClusterStats;
    if (!stats || stats.size === 0) {
      legendContent.innerHTML = '<div style="font-size:0.75rem; color:#6b7280;">No communities detected. Run "Detect Communities" to see clusters.</div>';
      return;
    }

    legendContent.innerHTML = '';
    const sortedCids = Array.from(stats.keys()).sort((a, b) => a - b);
    const noiseId = communities?.noiseClusterId;

    sortedCids.forEach(cid => {
      const stat = stats.get(cid);
      if (stat.isNoise || cid === noiseId) return;

      let color = communityColors[(cid - 1) % communityColors.length];
      const customName = communities?.names?.get(cid) || `Cluster ${cid}`;

      const item = document.createElement('div');
      item.className = 'legend-item';
      item.style.display = 'flex';
      item.style.alignItems = 'center';
      item.style.marginBottom = '0.5rem';

      item.innerHTML = `
        <div class="legend-dot" style="background:${color}; flex-shrink:0;"></div>
        <input type="text" class="legend-input" value="${escapeAttr(customName)}" data-cid="${cid}" style="
          border: 1px solid transparent;
          background: transparent;
          font-size: 0.75rem;
          color: #374151;
          width: 100%;
          margin-left: 0.5rem;
          border-radius: 4px;
          padding: 2px 4px;
        " placeholder="Cluster ${cid}">
        <span style="font-size:0.7rem; color:#9ca3af; margin-left:auto;">(${stat.size})</span>
      `;

      const input = item.querySelector('input');
      input.addEventListener('focus', () => input.style.border = '1px solid #d1d5db');
      input.addEventListener('blur', () => input.style.border = '1px solid transparent');
      input.addEventListener('change', (e) => {
        const newName = e.target.value;
        if (communities) {
          if (!communities.names) communities.names = new Map();
          communities.names.set(cid, newName);
        }
        // Reflect the rename on the canvas cluster labels too
        vizManager?.scheduleClusterLabelRefresh?.();
      });

      legendContent.appendChild(item);
    });
  }
}

// =========================
// Post helpers
// =========================

export function gatherPostsForNode(node) {
  if (!node) return [];
  const dataset = Array.isArray(filteredData) && filteredData.length ? filteredData : rawData;
  if (!Array.isArray(dataset) || dataset.length === 0) return [];
  return dataset.filter(post => postMatchesNode(post, node));
}

export function samplePostsForNode(node, limit = 6) {
  const matches = gatherPostsForNode(node);
  if (matches.length <= limit) return matches;
  return [...matches]
    .sort((a, b) => postEngagement(b) - postEngagement(a))
    .slice(0, limit);
}

export function getAllPostsForNode(node) {
  const matches = gatherPostsForNode(node);
  return [...matches].sort((a, b) => postEngagement(b) - postEngagement(a));
}

export function renderPostHTML(p) {
  const a = p?.data?.author || {};
  const platform = p.platform || 'unknown';

  let profileUrl, postUrl, platformIcon;
  if (platform === 'instagram') {
    profileUrl = a?.uniqueId ? `https://www.instagram.com/${a.uniqueId}` : null;
    const postCode = p?.data?.code || p?.code || p?.data?.pk;
    const username = a?.uniqueId || p?.data?.user?.username;
    postUrl = postCode ? (username ? `https://www.instagram.com/${username}/p/${postCode}/` : `https://www.instagram.com/p/${postCode}/`) : null;
    platformIcon = '📷';
  } else if (platform === 'tiktok') {
    profileUrl = a?.uniqueId ? `https://www.tiktok.com/@${a.uniqueId}` : null;
    const username = a?.uniqueId;
    const videoId = p?.data?.id || p?.id;
    postUrl = (username && videoId) ? `https://www.tiktok.com/@${username}/video/${videoId}` :
      (p?.tiktok_url || p?.data?.tiktok_url || p?.data?.webVideoUrl || p?.data?.shareUrl || null);
    platformIcon = '🎵';
  } else if (platform === 'twitter') {
    profileUrl = a?.uniqueId ? `https://x.com/${a.uniqueId}` : null;
    const username = a?.uniqueId;
    const tweetId = p?.data?.id || p?.id;
    postUrl = (username && tweetId) ? `https://x.com/${username}/status/${tweetId}` : null;
    platformIcon = '🐦';
  } else {
    profileUrl = null;
    postUrl = null;
    platformIcon = '❓';
  }

  const capRaw = (p?.data?.desc || '').slice(0, 220);
  const cap = escapeHtml(capRaw);
  const eng = postEngagement(p);
  const t = p?.data?.createTime ? new Date(p.data.createTime * 1000).toLocaleString() : '';

  const location = p?.data?._instagram?.location;
  const locationText = location ? ` · 📍 ${escapeHtml(location.name)}` : '';

  const safePostUrl = safeExternalUrl(postUrl);
  const safeUsername = escapeHtml(a.uniqueId || '(unknown user)');

  const postLink = safePostUrl
    ? `<a href="${escapeAttr(safePostUrl)}" target="_blank" rel="noopener" style="color:#059669; text-decoration:underline; font-weight:600;">🔗 view post</a>`
    : `<span style="color:#9ca3af; font-size:0.75rem;">no link available</span>`;

  return `<div style="padding:.6rem .6rem; border:1px solid #eee; border-radius:8px; margin:.45rem 0;">
    <div style="display:flex; justify-content:space-between; align-items:start; gap:0.5rem;">
      <div style="font-weight:600; flex:1;">${platformIcon} ${a.uniqueId ? '@' + safeUsername : safeUsername}</div>
      <div style="flex-shrink:0;">${postLink}</div>
    </div>
    <div style="opacity:.95; margin-top:0.25rem;">${cap}${capRaw.length === 220 ? '…' : ''}</div>
    <div style="opacity:.7; margin-top:.2rem">time: ${t} · engagement: ${eng.toLocaleString()}${locationText}</div>
  </div>`;
}

// =========================
// Modal helpers
// =========================

function findNodeByUsername(username) {
  const possibleIds = [username, `u_${username}`, `@${username}`];
  for (const id of possibleIds) {
    const node = idToNode.get(id);
    if (node) return node;
  }
  for (const node of nodes) {
    if (node.label === username || node.label === `@${username}` || node.id === username) {
      return node;
    }
  }
  return null;
}

function openComparisonView(primaryNode, comparisonUsername) {
  const modalBody = document.getElementById('modal-body');
  const modalTitle = document.getElementById('modal-title');
  const modalContentWrapper = document.getElementById('modal-content-wrapper');
  const comparisonNode = findNodeByUsername(comparisonUsername);

  if (!comparisonNode) {
    toast(`Could not find user: ${comparisonUsername}`, { type: 'error' });
    return;
  }

  setComparisonState({
    primaryNode: primaryNode,
    comparisonNode: comparisonNode
  });

  if (modalContentWrapper) {
    modalContentWrapper.style.width = 'min(1200px, 95vw)';
  }

  const safePrimaryLabel = escapeHtml(primaryNode.label);
  const safeComparisonLabel = escapeHtml(comparisonNode.label);
  modalTitle.innerHTML = `Comparison: @${safePrimaryLabel} vs @${safeComparisonLabel} <button id="back-to-single" style="background:#6b7280; color:white; border:none; padding:.4rem .8rem; border-radius:6px; cursor:pointer; font-size:0.875rem; margin-left:1rem;">← Back</button>`;

  const primaryPosts = samplePostsForNode(primaryNode, 10);
  const comparisonPosts = samplePostsForNode(comparisonNode, 10);

  const primaryPostsHTML = primaryPosts.map(p => renderPostHTML(p)).join('');
  const comparisonPostsHTML = comparisonPosts.map(p => renderPostHTML(p)).join('');

  modalBody.innerHTML = `
    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:1rem; margin-bottom:1rem;">
      <div style="border-right: 2px solid #e5e7eb; padding-right:1rem;">
        <h3 style="margin-bottom:0.5rem; color:#111827;">@${safePrimaryLabel}</h3>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-bottom:8px; font-size:0.875rem;">
          <div><div class="small" style="color:#6b7280;">Type</div><div><b>${escapeHtml(primaryNode.type)}</b></div></div>
          <div><div class="small" style="color:#6b7280;">Degree</div><div><b>${primaryNode.degree ?? 0}</b></div></div>
          <div><div class="small" style="color:#6b7280;">Followers</div><div><b>${(primaryNode.followers || 0).toLocaleString()}</b></div></div>
          <div><div class="small" style="color:#6b7280;">Verified</div><div><b>${primaryNode.verified ? 'Yes' : 'No'}</b></div></div>
        </div>
        ${primaryNode.suspicious ? `
        <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:6px; padding:0.5rem; margin-bottom:0.5rem; font-size:0.75rem;">
          <div style="font-weight:700; color:#991b1b;">⚠️ CIB Risk: ${primaryNode.cibScore}/100</div>
        </div>
        ` : ''}
        <div style="margin-top:0.75rem; margin-bottom:0.5rem; font-weight:700;">Example posts (${primaryPosts.length})</div>
        <div style="max-height:400px; overflow-y:auto;">
          ${primaryPostsHTML || '<div class="small" style="color:#6b7280;">No posts found</div>'}
        </div>
      </div>
      <div style="padding-left:1rem;">
        <h3 style="margin-bottom:0.5rem; color:#111827;">@${safeComparisonLabel}</h3>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-bottom:8px; font-size:0.875rem;">
          <div><div class="small" style="color:#6b7280;">Type</div><div><b>${escapeHtml(comparisonNode.type)}</b></div></div>
          <div><div class="small" style="color:#6b7280;">Degree</div><div><b>${comparisonNode.degree ?? 0}</b></div></div>
          <div><div class="small" style="color:#6b7280;">Followers</div><div><b>${(comparisonNode.followers || 0).toLocaleString()}</b></div></div>
          <div><div class="small" style="color:#6b7280;">Verified</div><div><b>${comparisonNode.verified ? 'Yes' : 'No'}</b></div></div>
        </div>
        ${comparisonNode.suspicious ? `
        <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:6px; padding:0.5rem; margin-bottom:0.5rem; font-size:0.75rem;">
          <div style="font-weight:700; color:#991b1b;">⚠️ CIB Risk: ${comparisonNode.cibScore}/100</div>
        </div>
        ` : ''}
        <div style="margin-top:0.75rem; margin-bottom:0.5rem; font-weight:700;">Example posts (${comparisonPosts.length})</div>
        <div style="max-height:400px; overflow-y:auto;">
          ${comparisonPostsHTML || '<div class="small" style="color:#6b7280;">No posts found</div>'}
        </div>
      </div>
    </div>
  `;

  setTimeout(() => {
    const backBtn = document.getElementById('back-to-single');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        if (comparisonState && comparisonState.primaryNode) {
          openNodeModal(comparisonState.primaryNode);
        }
      });
    }
  }, 0);
}

export function openNodeModal(node) {
  const modalEl = document.getElementById('node-modal');
  const modalBody = document.getElementById('modal-body');
  const modalTitle = document.getElementById('modal-title');
  const modalContentWrapper = document.getElementById('modal-content-wrapper');

  setComparisonState(null);

  if (modalContentWrapper) {
    modalContentWrapper.style.width = 'min(780px, 92vw)';
  }

  let prefix = '';
  if (node.type === 'user') prefix = '@';
  else if (node.type === 'hashtag') prefix = '#';
  else if (node.type === 'location') prefix = '📍';
  if (modalTitle) modalTitle.textContent = `${prefix}${String(node.label || node.id)}`;

  // Coordination-network-specific modal
  const networkTypeSelect = document.getElementById('network-type');
  if (networkTypeSelect?.value === 'coordinationNetwork' && coordinationGraph) {
    const nodeLinks = coordinationGraph.links.filter(
      l => l.source === node.id || l.target === node.id
    );
    const signalLabels = {
      sync: '⏱ Synchronized posting',
      semantic: '🤖 Semantic similarity',
      template: '📋 Template captions',
      urls: '🔗 Shared rare URLs',
      repost: '🔁 Co-amplified accounts',
      hashtags: '#️⃣ Shared rare hashtags',
      username: '👤 Similar usernames',
      creation: '🏭 Clustered creation',
    };
    // Group partners by signal type
    const bySignal = new Map();
    for (const link of nodeLinks) {
      const partnerId = link.source === node.id ? link.target : link.source;
      const partnerLabel = coordinationGraph.nodes.find(n => n.id === partnerId)?.label || partnerId;
      for (const sig of link.signals) {
        if (!bySignal.has(sig)) bySignal.set(sig, []);
        bySignal.get(sig).push({ id: partnerId, label: partnerLabel, weight: link.weight });
      }
    }

    const score = cibDetection?.userScores?.get(node.id);
    const reasons = cibDetection?.userReasons?.get(node.id) || [];

    let partnersHTML = '';
    if (bySignal.size === 0) {
      partnersHTML = '<div style="color:#6b7280; font-size:0.85rem;">No coordination partners — flagged by solo indicators only (rhythm, volume, night posting).</div>';
    } else {
      for (const [sig, partners] of bySignal) {
        const label = signalLabels[sig] || sig;
        const color = SIGNAL_COLORS[sig] || '#6b7280';
        const partnerList = partners.map(p =>
          `<a href="#" class="coord-partner-link" data-partner-id="${escapeAttr(p.id)}" style="color:${color}; text-decoration:underline; font-weight:600; cursor:pointer;">${escapeHtml(p.label)}</a>`
        ).join(', ');
        partnersHTML += `<div style="margin-bottom:0.6rem;">
          <div style="font-weight:700; color:${color}; font-size:0.8rem; margin-bottom:0.25rem;">${label}</div>
          <div style="font-size:0.85rem;">${partnerList}</div>
        </div>`;
      }
    }

    if (modalBody) modalBody.innerHTML = `
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-bottom:8px;">
        <div><div class="small" style="color:#6b7280;">Type</div><div><b>${escapeHtml(node.type)}</b></div></div>
        <div><div class="small" style="color:#6b7280;">Degree</div><div><b>${nodeLinks.length} partner${nodeLinks.length !== 1 ? 's' : ''}</b></div></div>
        ${score !== undefined ? `<div><div class="small" style="color:#6b7280;">CIB Risk Score</div><div><b style="color:#991b1b;">${score}/100</b></div></div>` : ''}
      </div>
      ${reasons.length ? `
      <div class="warning-box" style="margin:.5rem 0;">
        <div style="font-weight:700; color:#991b1b; margin-bottom:.3rem;">⚠️ CIB Indicators</div>
        <ul style="margin:0; padding-left:1.2rem; list-style:disc; font-size:0.8rem; color:#7f1d1d;">
          ${reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('')}
        </ul>
      </div>` : ''}
      <div style="margin:.6rem 0 .3rem; font-weight:700;">Coordination partners (${nodeLinks.length})</div>
      ${partnersHTML}
    `;

    setTimeout(() => {
      modalBody.querySelectorAll('.coord-partner-link').forEach(link => {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          const partnerId = link.getAttribute('data-partner-id');
          const partnerNode = coordinationGraph.nodes.find(n => n.id === partnerId);
          if (partnerNode) openComparisonView(node, partnerNode.label);
        });
      });
    }, 0);

    if (modalEl) modalEl.style.display = 'flex';
    return;
  }

  const nbs = Array.from(adjacency.get(node.id) || []);
  const neighborHTML = nbs.slice(0, 14).map(id => {
    const lab = idToNode.get(id)?.label || id;
    return `<code style="background:#f3f4f6; padding:.15rem .35rem; border-radius:6px; margin:.12rem; display:inline-block;">${escapeHtml(lab)}</code>`;
  }).join('');

  const posts = (node.type === 'hashtag' || node.type === 'location') ? getAllPostsForNode(node) : samplePostsForNode(node, 6);
  const postsHTML = posts.map(p => renderPostHTML(p)).join('');

  const teach = (() => {
    const deg = node.degree ?? 0;
    if (deg >= 12) return `This is a high-degree ${node.type}. Hubs can shape attention flows. Are neighbors from diverse communities, or mostly one echo chamber?`;
    if (deg <= 1) return `This ${node.type} has very few connections. Is it peripheral, new, or filtered out by thresholds?`;
    return `Mid-degree ${node.type}. Check neighbors and example posts to see whether it bridges topics or audiences.`;
  })();

  const postsSectionTitle = (node.type === 'hashtag' || node.type === 'location')
    ? `All posts (${posts.length})`
    : `Example posts (${posts.length})`;

  const postsContainerStyle = (node.type === 'hashtag' || node.type === 'location')
    ? `max-height:300px; overflow-y:auto; border:1px solid #e5e7eb; border-radius:8px; padding:.5rem; background:#fafafa;`
    : '';

  let cibReasonsHTML = '';
  if (node.suspicious && node.cibReasons) {
    cibReasonsHTML = node.cibReasons.map(reason => {
      const multiUserPattern = /^((?:Synchronized posting|Rare hashtag combinations|Similar username pattern|Semantically similar captions|Template caption)[^:]*with:\s*)(.+)$/;
      const multiUserMatch = reason.match(multiUserPattern);

      if (multiUserMatch && multiUserMatch[2]) {
        let usernameText = multiUserMatch[2];
        let moreSuffix = '';
        const moreMatch = usernameText.match(/(.+?)\s+(and\s+\d+\s+more)$/);
        if (moreMatch) {
          usernameText = moreMatch[1];
          moreSuffix = moreMatch[2];
        }
        const usernames = usernameText.split(',').map(u => u.trim()).filter(u => u.length > 0);
        const clickableUsernames = usernames.map(username => {
          return `<a href="#" class="comparison-link" data-username="${escapeAttr(username)}" style="color:#dc2626; text-decoration:underline; font-weight:600; cursor:pointer;">${escapeHtml(username)}</a>`;
        });
        const clickableReason = escapeHtml(multiUserMatch[1]) + clickableUsernames.join(', ') + (moreSuffix ? ' ' + escapeHtml(moreSuffix) : '');
        return `<li style="margin:.15rem 0; color:#991b1b;">${clickableReason}</li>`;
      }

      const withPattern = /with\s+(@?)([a-zA-Z0-9_.-]+)/;
      const match = reason.match(withPattern);
      if (match && match[2]) {
        const username = match[2];
        const clickableReason = reason.replace(
          match[0],
          `with <a href="#" class="comparison-link" data-username="${escapeAttr(username)}" style="color:#dc2626; text-decoration:underline; font-weight:600; cursor:pointer;">${escapeHtml(match[1])}${escapeHtml(username)}</a>`
        );
        return `<li style="margin:.15rem 0; color:#991b1b;">${clickableReason}</li>`;
      }

      return `<li style="margin:.15rem 0; color:#991b1b;">${escapeHtml(reason)}</li>`;
    }).join('');
  }

  if (modalBody) modalBody.innerHTML = `
    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-bottom:8px;">
      <div><div class="small" style="color:#6b7280;">Type</div><div><b>${escapeHtml(node.type)}</b></div></div>
      <div><div class="small" style="color:#6b7280;">Degree</div><div><b>${node.degree ?? 0}</b></div></div>
      ${node.type === 'user'
      ? `<div><div class="small" style="color:#6b7280;">Followers</div><div><b>${(node.followers || 0).toLocaleString()}</b></div></div>
           <div><div class="small" style="color:#6b7280;">Verified</div><div><b>${node.verified ? 'Yes' : 'No'}</b></div></div>`
      : node.type === 'location'
        ? `<div><div class="small" style="color:#6b7280;">Posts at location</div><div><b>${node.count || 0}</b></div></div>
           <div><div class="small" style="color:#6b7280;">Coordinates</div><div><b>${node.lat?.toFixed(4) || '?'}, ${node.lng?.toFixed(4) || '?'}</b></div></div>`
        : `<div><div class="small" style="color:#6b7280;">Usage count</div><div><b>${node.count || 0}</b></div></div><div></div>`}
    </div>

    ${node.suspicious ? `
    <div class="warning-box" style="margin:.5rem 0;">
      <div style="font-weight:700; color:#991b1b; margin-bottom:.4rem;">⚠️ CIB DETECTED (Risk Score: ${node.cibScore}/100)</div>
      <div style="font-size:0.75rem; color:#7f1d1d; margin-bottom:.3rem;"><b>Indicators triggered:</b></div>
      <ul style="margin:0; padding-left:1.2rem; list-style:disc;">
        ${cibReasonsHTML}
      </ul>
      <p style="margin-top:.4rem;"><strong>Note:</strong> These are behavioral indicators. Verify with manual inspection before drawing conclusions.</p>
    </div>
    ` : ''}

    <div class="small" style="background:#fff7ed; border:1px solid #fde7c7; padding:.6rem .7rem; border-radius:8px; margin:.4rem 0;">
      <b>Why it matters:</b> ${escapeHtml(teach)}
    </div>

    <div style="margin:.6rem 0 .25rem; font-weight:700;">Neighbors (${nbs.length})</div>
    <div>${neighborHTML || '<span class="small" style="color:#6b7280;">No neighbors</span>'}</div>

    <div style="margin:.9rem 0 .35rem; font-weight:700;">${postsSectionTitle}</div>
    <div style="${postsContainerStyle}" id="posts-container">
      ${postsHTML || '<div class="small" style="color:#6b7280;">No posts found for this node given current filters.</div>'}
    </div>
    ${(node.type === 'hashtag' || node.type === 'location') && posts.length > 0 ?
      `<div class="small" style="color:#6b7280; margin-top:.25rem; text-align:center;">Scroll to see all ${posts.length} posts</div>` : ''}
  `;

  setTimeout(() => {
    const comparisonLinks = modalBody.querySelectorAll('.comparison-link');
    comparisonLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const username = link.getAttribute('data-username');
        openComparisonView(node, username);
      });
    });
  }, 0);

  if (modalEl) modalEl.style.display = 'flex';
}

export function showNodeInfo(node) {
  const nodeDetails = document.getElementById('node-details');
  const nodeInfo = document.getElementById('node-info');

  let html = `<div class="info-row"><span class="info-label">Label:</span> <span class="info-value">${escapeHtml(node.label)}</span></div>`;
  html += `<div class="info-row"><span class="info-label">Type:</span> <span class="info-value">${escapeHtml(node.type)}</span></div>`;
  if (node.degree !== undefined) html += `<div class="info-row"><span class="info-label">Degree:</span> <span class="info-value">${node.degree}</span></div>`;
  if (node.followers !== undefined) html += `<div class="info-row"><span class="info-label">Followers:</span> <span class="info-value">${(node.followers || 0).toLocaleString()}</span></div>`;
  if (node.count !== undefined) html += `<div class="info-row"><span class="info-label">Usage:</span> <span class="info-value">${node.count} posts</span></div>`;
  if (node.suspicious) {
    html += `<div class="info-row"><span class="cib-indicator">⚠️ SUSPICIOUS ACTIVITY</span></div>`;
    const score = node.cibScore || (cibDetection?.userScores?.get(node.id));
    if (score) html += `<div class="info-row"><span class="info-label">CIB Score:</span> <span class="cib-score">${score}/100</span></div>`;
    const reasons = cibDetection?.userReasons?.get(node.id);
    if (reasons && reasons.length > 0) {
      html += `<div style="margin-top:0.5rem; border-top:1px solid #eee; padding-top:0.5rem;">`;
      html += `<div class="info-label" style="margin-bottom:0.25rem;">Detection Reasons:</div>`;
      html += `<ul style="padding-left:1rem; margin:0; font-size:0.75rem; color:#dc2626;">`;
      reasons.forEach(r => html += `<li>${escapeHtml(r)}</li>`);
      html += `</ul></div>`;
    }
  }
  if (communities && communities.communities.has(node.id)) {
    const cid = communities.communities.get(node.id);
    const isNoise = cid === communities.noiseClusterId;
    const clusterLabel = isNoise ? 'Noise' : `#${cid}`;
    html += `<div class="info-row"><span class="info-label">Community:</span> <span class="info-value">${clusterLabel}</span></div>`;
  }
  if (node.verified) html += `<div class="info-row" style="color:#2563eb; font-weight: 600;">✓ Verified</div>`;
  if (nodeDetails) nodeDetails.innerHTML = html;
  if (nodeInfo) nodeInfo.style.display = 'block';
}

export function initModalListeners() {
  const modalEl = document.getElementById('node-modal');
  const modalClose = document.getElementById('modal-close');
  const closeInfo = document.getElementById('close-info');

  if (modalClose) modalClose.addEventListener('click', () => { if (modalEl) modalEl.style.display = 'none'; });
  if (modalEl) modalEl.addEventListener('click', (e) => { if (e.target === modalEl) modalEl.style.display = 'none'; });
  if (closeInfo) closeInfo.addEventListener('click', () => { const nodeInfo = document.getElementById('node-info'); if (nodeInfo) nodeInfo.style.display = 'none'; });
}

export function displayMetrics(metrics) {
  const metricsPanel = document.getElementById('metrics-panel');
  const metricsList = document.getElementById('metrics-list');
  if (!metricsPanel || !metricsList) return;

  if (!metrics) {
    metricsPanel.style.display = 'none';
    return;
  }

  const items = [
    { label: 'Nodes', value: metrics.nodes ?? 0 },
    { label: 'Edges', value: metrics.edges ?? 0 },
    { label: 'Density', value: typeof metrics.density === 'number' ? metrics.density.toFixed(4) : '0' },
    { label: 'Avg Degree', value: typeof metrics.avgDegree === 'number' ? metrics.avgDegree.toFixed(2) : '0' },
    { label: 'Max Degree', value: metrics.maxDegree ?? 0 },
    { label: 'Avg Clustering', value: typeof metrics.avgClustering === 'number' ? metrics.avgClustering.toFixed(3) : '0' }
  ];

  // Add modularity if communities are detected
  if (communities && communities.modularity !== undefined) {
    const modularityValue = communities.modularity.toFixed(3);
    const modularityClass = communities.modularity > 0.3 ? 'good-modularity' : '';
    items.push({
      label: 'Modularity',
      value: modularityValue,
      className: modularityClass
    });
  }

  metricsList.innerHTML = items.map(item =>
    `<li><span class="metric-name">${escapeHtml(item.label)}</span><span class="metric-value ${escapeHtml(item.className || '')}">${escapeHtml(String(item.value))}</span></li>`
  ).join('');

  metricsPanel.style.display = 'block';
}
