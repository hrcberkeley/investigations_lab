/**
 * Report Generator Module
 * Generates HTML and CSV reports for CIB investigation results.
 */
import { safeMax, safeMin, escapeHtml } from './utils.js';

function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/<\//g, '<\\/')
    .replace(/<!--/g, '<\\!--')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// =========================
// HTML Report Generation
// =========================
export function generateInvestigationReport(cibDetection, filteredData, params, staticInfo, graphData) {
  const { timestamp, platformText, thresholdText, timeWindowText, networkSnapshotUrl } = staticInfo;

  // Calculate statistics
  const totalSuspicious = cibDetection.suspiciousUsers.size;
  const scores = Array.from(cibDetection.userScores.values());
  const critical = scores.filter(s => s >= 86).length;
  const high = scores.filter(s => s >= 61 && s < 86).length;
  const medium = scores.filter(s => s >= 31 && s < 61).length;
  const low = scores.filter(s => s < 31).length;

  // Get dataset info
  const totalPosts = filteredData.length;
  const uniqueUsers = new Set(filteredData.map(p => p.data?.author?.id).filter(Boolean)).size;
  const suspicionRate = uniqueUsers > 0 ? ((totalSuspicious / uniqueUsers) * 100).toFixed(1) : '0.0';
  const timestamps = filteredData.map(p => p.data?.createTime).filter(Boolean);
  const minDate = timestamps.length > 0 ? new Date(safeMin(timestamps) * 1000).toLocaleDateString() : 'N/A';
  const maxDate = timestamps.length > 0 ? new Date(safeMax(timestamps) * 1000).toLocaleDateString() : 'N/A';

  // Collect top offenders
  const topOffenders = Array.from(cibDetection.suspiciousUsers)
    .map(userId => ({
      userId,
      score: cibDetection.userScores.get(userId) || 0,
      reasons: cibDetection.userReasons.get(userId) || [],
      userData: filteredData.find(p => p.data?.author?.id === userId)?.data?.author || {}
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20); // Top 20
  const graphDataJson = safeJsonForScript(graphData || { nodes: [], links: [] });

  // Build HTML
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CIB Investigation Report - ${escapeHtml(timestamp)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      color: #1f2937;
      background: #f9fafb;
      padding: 2rem;
    }
    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
    .header { border-bottom: 3px solid #dc2626; padding-bottom: 1.5rem; margin-bottom: 2rem; }
    h1 { color: #dc2626; font-size: 2rem; margin-bottom: 0.5rem; }
    .subtitle { color: #6b7280; font-size: 0.875rem; }
    .section { margin: 2rem 0; }
    h2 { color: #111827; font-size: 1.5rem; margin-bottom: 1rem; border-left: 4px solid #dc2626; padding-left: 1rem; }
    h3 { color: #374151; font-size: 1.25rem; margin: 1.5rem 0 1rem; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin: 1.5rem 0; }
    .stat-box { background: #f3f4f6; padding: 1.25rem; border-radius: 8px; text-align: center; }
    .stat-box.critical { background: #fee2e2; border: 2px solid #dc2626; }
    .stat-box.high { background: #fed7aa; border: 2px solid #ea580c; }
    .stat-box.medium { background: #fef3c7; border: 2px solid #d97706; }
    .stat-label { font-size: 0.75rem; color: #6b7280; text-transform: uppercase; font-weight: 600; }
    .stat-value { font-size: 2rem; font-weight: 700; color: #111827; margin-top: 0.25rem; }
    .indicator-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem; margin: 1.5rem 0; }
    .indicator-box { background: #f9fafb; border: 1px solid #e5e7eb; padding: 1rem; border-radius: 8px; }
    .indicator-box strong { display: block; color: #111827; margin-bottom: 0.25rem; }
    table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 0.875rem; }
    th { background: #111827; color: white; padding: 0.75rem; text-align: left; font-weight: 600; }
    td { padding: 0.75rem; border-bottom: 1px solid #e5e7eb; }
    tr:hover { background: #f9fafb; }
    .risk-badge { 
      display: inline-block; 
      padding: 0.25rem 0.75rem; 
      border-radius: 9999px; 
      font-size: 0.75rem; 
      font-weight: 600;
      text-transform: uppercase;
    }
    .risk-critical { background: #fee2e2; color: #991b1b; }
    .risk-high { background: #fed7aa; color: #9a3412; }
    .risk-medium { background: #fef3c7; color: #92400e; }
    .risk-low { background: #dbeafe; color: #1e40af; }
    .warning-box { background: #fef3c7; border: 2px solid #f59e0b; padding: 1rem; border-radius: 8px; margin: 1rem 0; }
    .warning-box strong { color: #92400e; }
    .footer { margin-top: 3rem; padding-top: 2rem; border-top: 1px solid #e5e7eb; text-align: center; color: #6b7280; font-size: 0.875rem; }
    .key-findings { background: #fee2e2; border-left: 4px solid #dc2626; padding: 1rem; margin: 1rem 0; }
    .key-findings ul { margin-left: 1.5rem; margin-top: 0.5rem; }
    .key-findings li { margin: 0.5rem 0; color: #7f1d1d; }
    ul.reasons { list-style: disc; margin-left: 1.5rem; font-size: 0.875rem; color: #4b5563; }
    ul.reasons li { margin: 0.25rem 0; }
    .params-box { background: #f3f4f6; padding: 1rem; border-radius: 8px; font-size: 0.875rem; }
    .params-box code { background: #e5e7eb; padding: 0.125rem 0.375rem; border-radius: 4px; }
    @media print { body { background: white; padding: 0; } .container { box-shadow: none; } }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🛡️ Coordinated Inauthentic Behavior Investigation Report</h1>
      <div class="subtitle">Generated: ${escapeHtml(timestamp)} | Tool: SchuimSurfer | Platform: ${escapeHtml(platformText)}</div>
    </div>

    <div class="section">
      <h2>Executive Summary</h2>
      <div class="summary-grid">
        <div class="stat-box">
          <div class="stat-label">Total Posts Analyzed</div>
          <div class="stat-value">${totalPosts.toLocaleString()}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Unique Users</div>
          <div class="stat-value">${uniqueUsers.toLocaleString()}</div>
        </div>
        <div class="stat-box critical">
          <div class="stat-label">Suspicious Accounts</div>
          <div class="stat-value">${totalSuspicious}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Suspicion Rate</div>
          <div class="stat-value">${suspicionRate}%</div>
        </div>
      </div>

      <div class="summary-grid">
        <div class="stat-box critical">
          <div class="stat-label">Critical Risk (86-100)</div>
          <div class="stat-value">${critical}</div>
        </div>
        <div class="stat-box high">
          <div class="stat-label">High Risk (61-85)</div>
          <div class="stat-value">${high}</div>
        </div>
        <div class="stat-box medium">
          <div class="stat-label">Medium Risk (31-60)</div>
          <div class="stat-value">${medium}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Low Risk (0-30)</div>
          <div class="stat-value">${low}</div>
        </div>
      </div>

      <p><strong>Data Range:</strong> ${escapeHtml(minDate)} to ${escapeHtml(maxDate)}</p>
      <p><strong>CIB Sensitivity Level:</strong> ${escapeHtml(thresholdText || 'N/A')}</p>
    </div>

    <div class="section">
      <h2>Key Findings</h2>
      <div class="key-findings">
        <strong style="color: #991b1b;">⚠️ Primary Concerns:</strong>
        <ul>
          ${critical > 0 ? `<li><strong>${critical} accounts</strong> flagged as <strong>CRITICAL RISK</strong> - Multiple indicators suggest coordinated inauthentic behavior</li>` : ''}
          ${high > 0 ? `<li><strong>${high} accounts</strong> flagged as <strong>HIGH RISK</strong> - Strong evidence of coordination</li>` : ''}
          ${cibDetection.indicators.synchronized > 0 ? `<li><strong>Synchronized posting detected:</strong> ${cibDetection.indicators.synchronized} account pairs posting within narrow time windows</li>` : ''}
          ${cibDetection.indicators.identicalHashtags > 0 ? `<li><strong>Coordinated hashtag usage:</strong> ${cibDetection.indicators.identicalHashtags} users sharing rare hashtag combinations</li>` : ''}
          ${cibDetection.indicators.similarUsernames > 0 ? `<li><strong>Username pattern matching:</strong> ${cibDetection.indicators.similarUsernames} users with similar account names</li>` : ''}
          ${cibDetection.indicators.accountCreationClusters > 0 ? `<li><strong>Bot farm indicators:</strong> ${cibDetection.indicators.accountCreationClusters} clusters of accounts created simultaneously</li>` : ''}
          ${cibDetection.indicators.semanticDuplicates > 0 ? `<li><strong>AI-detected coordination:</strong> ${cibDetection.indicators.semanticDuplicates} pairs of semantically similar captions</li>` : ''}
        </ul>
      </div>
    </div>

    <div class="section">
      <h2>Detection Indicators Summary</h2>
      <div class="indicator-grid">
        <div class="indicator-box">
          <strong>⏱️ Synchronized Posting</strong>
          ${cibDetection.indicators.synchronized || 0} account pairs detected
        </div>
        <div class="indicator-box">
          <strong>🏷️ Rare Hashtag Combos</strong>
          ${cibDetection.indicators.identicalHashtags || 0} users flagged
        </div>
        <div class="indicator-box">
          <strong>👤 Similar Usernames</strong>
          ${cibDetection.indicators.similarUsernames || 0} users flagged
        </div>
        <div class="indicator-box">
          <strong>📈 High Volume Posting</strong>
          ${cibDetection.indicators.highVolume || 0} users flagged
        </div>
        ${cibDetection.indicators.semanticDuplicates ? `
        <div class="indicator-box">
          <strong>🤖 Semantic Duplicates (AI)</strong>
          ${cibDetection.indicators.semanticDuplicates} pairs detected
        </div>` : ''}
        ${cibDetection.indicators.temporalBursts ? `
        <div class="indicator-box">
          <strong>💥 Temporal Bursts</strong>
          ${cibDetection.indicators.temporalBursts} users flagged
        </div>` : ''}
        ${cibDetection.indicators.templateCaptions ? `
        <div class="indicator-box">
          <strong>📝 Template Captions</strong>
          ${cibDetection.indicators.templateCaptions} pairs detected
        </div>` : ''}
        ${cibDetection.indicators.accountCreationClusters ? `
        <div class="indicator-box">
          <strong>🏭 Account Creation Clusters</strong>
          ${cibDetection.indicators.accountCreationClusters} clusters detected
        </div>` : ''}
      </div>
    </div>

    <div class="section">
      <h2>Visual Analysis</h2>

      <h3>Network Graph</h3>

      <!-- Interactive Graph Section using Cosmos.GL (same as main app) -->
      ${graphData ? `
      <style>
        #report-graph-container {
          width: 100%;
          height: 600px;
          position: relative;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          overflow: hidden;
          background: #ffffff;
        }
        #report-graph-container canvas {
          width: 100%;
          height: 100%;
          display: block;
        }
        #report-tooltip {
          position: absolute;
          pointer-events: none;
          display: none;
          background: #111827;
          color: #fff;
          padding: 0.4rem 0.6rem;
          border-radius: 0.375rem;
          font-size: 12px;
          box-shadow: 0 6px 20px rgba(0,0,0,0.2);
          z-index: 10;
          max-width: 250px;
        }
        #report-modal {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.5);
          display: none;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }
        #report-modal.active { display: flex; }
        #report-modal-content {
          width: min(700px, 90vw);
          max-height: 80vh;
          overflow: auto;
          background: #fff;
          border-radius: 12px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.35);
        }
        #report-modal-header {
          padding: 16px 18px;
          border-bottom: 1px solid #eee;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        #report-modal-title {
          font-weight: 700;
          font-size: 16px;
        }
        #report-modal-close {
          border: none;
          background: #f3f4f6;
          padding: 0.4rem 0.6rem;
          border-radius: 8px;
          cursor: pointer;
        }
        #report-modal-body {
          padding: 16px 18px;
          font-size: 14px;
        }
      </style>

      <div id="report-graph-container"></div>
      <div id="report-tooltip"></div>

      <!-- Modal for node details -->
      <div id="report-modal">
        <div id="report-modal-content">
          <div id="report-modal-header">
            <div id="report-modal-title">Node Details</div>
            <button id="report-modal-close">Close</button>
          </div>
          <div id="report-modal-body"></div>
        </div>
      </div>

      <!-- Network Legend -->
      <div style="background: #f9fafb; padding: 0.75rem; border-radius: 6px; border: 1px solid #e5e7eb; font-size: 0.75rem; margin-top: 0.5rem;">
        <div style="font-weight: 600; margin-bottom: 0.5rem; color: #374151;">Graph Legend</div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.5rem;">
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span style="width: 10px; height: 10px; background: #dc2626; border-radius: 50%; display: inline-block;"></span>
            <span>Suspicious Account</span>
          </div>
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span style="width: 10px; height: 10px; background: #3b82f6; border-radius: 50%; display: inline-block;"></span>
            <span>Verified Account</span>
          </div>
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span style="width: 10px; height: 10px; background: #8b5cf6; border-radius: 50%; display: inline-block;"></span>
            <span>Regular User</span>
          </div>
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span style="width: 10px; height: 10px; background: #10b981; border-radius: 50%; display: inline-block;"></span>
            <span>Hashtag</span>
          </div>
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span style="width: 10px; height: 10px; background: #f59e0b; border-radius: 50%; display: inline-block;"></span>
            <span>Location</span>
          </div>
        </div>
      </div>

      <script type="module">
        import { Graph } from 'https://unpkg.com/@cosmos.gl/graph@2.5.0/dist/index.js?module';

        (function() {
          const graphData = ${graphDataJson};
          const container = document.getElementById('report-graph-container');
          const tooltip = document.getElementById('report-tooltip');
          const modal = document.getElementById('report-modal');
          const modalTitle = document.getElementById('report-modal-title');
          const modalBody = document.getElementById('report-modal-body');
          const modalClose = document.getElementById('report-modal-close');

          const NODE_SIZE_MIN = 6;
          const NODE_SIZE_MAX = 24;

          // Safe min/max for large datasets
          function safeMax(array) {
            if (!array || array.length === 0) return 0;
            let max = array[0];
            for (let i = 1; i < array.length; i++) {
              if (array[i] > max) max = array[i];
            }
            return max;
          }

          function safeMin(array) {
            if (!array || array.length === 0) return 0;
            let min = array[0];
            for (let i = 1; i < array.length; i++) {
              if (array[i] < min) min = array[i];
            }
            return min;
          }

          // Helper: hex to float color
          function hexToFloatColor(hex, alpha = 1) {
            const normalized = hex.replace('#', '');
            const bigint = parseInt(normalized, 16);
            const r = (bigint >> 16) & 255;
            const g = (bigint >> 8) & 255;
            const b = bigint & 255;
            return [r / 255, g / 255, b / 255, alpha];
          }

          function esc(value) {
            return String(value ?? '')
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;');
          }

          // Get node color
          function getNodeColor(node) {
            if (node.suspicious) return '#dc2626';
            if (node.type === 'user') {
              return node.verified ? '#3b82f6' : '#8b5cf6';
            }
            if (node.type === 'hashtag') return '#10b981';
            if (node.type === 'location') return '#f59e0b';
            return '#6b7280';
          }

          // Get node size
          function getNodeSize(node) {
            const degree = node.degree || 0;
            if (degree === 0) return 8;
            const metric = Math.log10(degree + 1);
            const metrics = graphData.nodes.map(n => Math.log10((n.degree || 0) + 1));
            const min = safeMin(metrics);
            const max = safeMax(metrics);
            if (max <= min) return 10;
            const normalized = (metric - min) / (max - min);
            return NODE_SIZE_MIN + normalized * (NODE_SIZE_MAX - NODE_SIZE_MIN);
          }

          // Build geometry
          const nodes = graphData.nodes.map((n, i) => ({ ...n, index: i }));
          const nodeIndex = new Map(nodes.map(n => [n.id, n.index]));

          const pointPositions = new Float32Array(nodes.length * 2);
          const pointColors = new Float32Array(nodes.length * 4);
          const pointSizes = new Float32Array(nodes.length);

          nodes.forEach((node, index) => {
            // Use provided positions or fall back to circular layout
            pointPositions[index * 2] = node.x || 0;
            pointPositions[index * 2 + 1] = node.y || 0;

            const [r, g, b, a] = hexToFloatColor(getNodeColor(node));
            pointColors.set([r, g, b, a], index * 4);
            pointSizes[index] = getNodeSize(node);
          });

          const linkPairs = [];
          const linkColorValues = [];
          const linkWidths = [];

          (graphData.links || []).forEach(link => {
            const sourceIndex = nodeIndex.get(link.source.id || link.source);
            const targetIndex = nodeIndex.get(link.target.id || link.target);
            if (sourceIndex === undefined || targetIndex === undefined) return;

            linkPairs.push(sourceIndex, targetIndex);
            const weight = link.weight || 1;
            const alpha = Math.min(0.6 + weight * 0.1, 0.9);
            const [r, g, b] = hexToFloatColor('#6b7280', alpha);
            linkColorValues.push(r, g, b, alpha);
            linkWidths.push(Math.max(0.8, Math.min(weight * 0.8, 3.0)));
          });

          // Initialize Cosmos.GL graph
          const graph = new Graph(container, {
            backgroundColor: '#ffffff',
            pointColor: '#9ca3af',
            pointSize: 6,
            linkColor: '#d1d5db',
            linkWidth: 0.6,
            enableSimulation: false,  // FROZEN - no simulation
            enableDrag: false,         // Disable dragging for static report
            hoveredPointCursor: 'pointer',
          });

          graph.setPointPositions(pointPositions);
          graph.setPointSizes(pointSizes);
          graph.setPointColors(pointColors);
          graph.setLinks(new Float32Array(linkPairs));
          graph.setLinkColors(new Float32Array(linkColorValues));
          graph.setLinkWidths(new Float32Array(linkWidths));
          graph.render();

          // Fit view to show entire graph
          const allIndices = nodes.map((_, i) => i);
          graph.fitViewByPointIndices(allIndices, 0, 0.15);

          // Tooltip handlers
          let hoveredNode = null;
          graph.setConfig({
            onPointMouseOver: (index, position, event) => {
              const node = nodes[index];
              if (!node) return;
              hoveredNode = node;

              const label = node.label || node.id;
              let prefix = '';
              if (node.type === 'user') prefix = '@';
              else if (node.type === 'hashtag') prefix = '#';
              else if (node.type === 'location') prefix = '📍';

              const deg = node.degree || 0;
              const meta = node.type === 'user'
                ? \`\${node.verified ? 'Verified · ' : ''}\${(node.followers || 0).toLocaleString()} followers\`
                : \`\${node.count || 0} posts\`;

              tooltip.innerHTML = \`<div style="font-weight:600">\${esc(prefix + label)}</div>\` +
                \`<div style="opacity:.85">\${esc(node.type)} · degree \${deg}\${meta ? ' · ' + esc(meta) : ''}</div>\`;
              tooltip.style.display = 'block';

              // Position tooltip - check if event has clientX/clientY
              if (event && event.clientX !== undefined && event.clientY !== undefined) {
                const offset = 10;
                const containerRect = container.getBoundingClientRect();
                tooltip.style.left = \`\${event.clientX - containerRect.left + offset}px\`;
                tooltip.style.top = \`\${event.clientY - containerRect.top + offset}px\`;
              } else if (position && position.length >= 2) {
                // Fallback to using position if event doesn't have clientX/Y
                tooltip.style.left = \`\${position[0] + 10}px\`;
                tooltip.style.top = \`\${position[1] + 10}px\`;
              }

              graph.selectPointByIndex(index, true);
            },
            onPointMouseOut: () => {
              hoveredNode = null;
              tooltip.style.display = 'none';
              graph.unselectPoints();
            },
            onPointClick: (index) => {
              const node = nodes[index];
              if (!node) return;
              openModal(node);
            },
            onMouseMove: (index, position, event) => {
              if (hoveredNode && event && event.clientX !== undefined && event.clientY !== undefined) {
                const offset = 10;
                const containerRect = container.getBoundingClientRect();
                tooltip.style.left = \`\${event.clientX - containerRect.left + offset}px\`;
                tooltip.style.top = \`\${event.clientY - containerRect.top + offset}px\`;
              }
            }
          });

          // Modal handlers
          function openModal(node) {
            let prefix = '';
            if (node.type === 'user') prefix = '@';
            else if (node.type === 'hashtag') prefix = '#';
            else if (node.type === 'location') prefix = '📍';
            modalTitle.textContent = \`\${prefix}\${node.label || node.id}\`;

            let cibSection = '';
            if (node.suspicious && node.cibReasons && node.cibReasons.length > 0) {
              cibSection = \`
                <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:6px; padding:0.75rem; margin-bottom:1rem;">
                  <div style="font-weight:700; color:#991b1b; margin-bottom:0.5rem;">⚠️ CIB Risk: \${node.cibScore || 0}/100</div>
                  <div style="font-size:0.875rem; color:#7f1d1d;">
                    <strong>Reasons:</strong>
                    <ul style="margin:0.5rem 0 0 1.5rem; list-style:disc;">
                      \${node.cibReasons.map(r => \`<li style="margin:0.25rem 0;">\${esc(r)}</li>\`).join('')}
                    </ul>
                  </div>
                </div>
              \`;
            }

            modalBody.innerHTML = \`
              <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-bottom:1rem;">
                <div><div style="font-size:0.75rem; color:#6b7280;">Type</div><div><b>\${esc(node.type)}</b></div></div>
                <div><div style="font-size:0.75rem; color:#6b7280;">Degree</div><div><b>\${node.degree || 0}</b></div></div>
                \${node.type === 'user' ? \`
                  <div><div style="font-size:0.75rem; color:#6b7280;">Followers</div><div><b>\${(node.followers || 0).toLocaleString()}</b></div></div>
                  <div><div style="font-size:0.75rem; color:#6b7280;">Verified</div><div><b>\${node.verified ? 'Yes' : 'No'}</b></div></div>
                \` : \`
                  <div><div style="font-size:0.75rem; color:#6b7280;">Usage count</div><div><b>\${node.count || 0}</b></div></div>
                  <div></div>
                \`}
              </div>
              \${cibSection}
              <div style="font-size:0.875rem; color:#6b7280; font-style:italic;">
                This is a static snapshot. For full analysis, use the main application.
              </div>
            \`;

            modal.classList.add('active');
          }

          modalClose.addEventListener('click', () => {
            modal.classList.remove('active');
          });

          modal.addEventListener('click', (e) => {
            if (e.target === modal) {
              modal.classList.remove('active');
            }
          });
        })();
      </script>
      <p style="text-align:center; font-size: 0.75rem; color: #6b7280; margin-top: 0.5rem;">
        Interactive Network: Hover nodes for details, click for more information. This is a static snapshot - simulation is frozen.
      </p>
      ` : '<p>No graph data available.</p>'}
      
      <h3>Suspicious Activity Timeline</h3>
      <div style="margin-top: 1rem; padding: 1rem; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px;">
        ${(() => {
      // Advanced SVG Chart Generation with Axes and Labels
      const suspiciousPosts = filteredData.filter(p => cibDetection.suspiciousUsers.has(p.data?.author?.id));
      if (suspiciousPosts.length === 0) return '<p class="text-gray-500 italic p-4 text-center">No suspicious activity detected to chart.</p>';

      const timestamps = suspiciousPosts.map(p => p.data?.createTime).filter(t => t).sort((a, b) => a - b);
      if (timestamps.length === 0) return '';

      const minT = timestamps[0];
      const maxT = timestamps[timestamps.length - 1];
      const range = maxT - minT || 1;

      // Chart Dimensions
      const width = 800;
      const height = 250;
      const margin = { top: 20, right: 30, bottom: 40, left: 50 };
      const chartW = width - margin.left - margin.right;
      const chartH = height - margin.top - margin.bottom;

      // Binning (Daily or dynamic bins)
      const binCount = 60;
      const bins = new Array(binCount).fill(0);
      timestamps.forEach(t => {
        const idx = Math.floor(((t - minT) / range) * (binCount - 1));
        bins[idx]++;
      });

      const maxCount = safeMax(bins) || 1;

      // Generate Gridlines (Y-Axis)
      const gridLines = [0, 0.25, 0.5, 0.75, 1].map(p => {
        const val = Math.round(maxCount * p);
        const y = chartH - (val / maxCount) * chartH;
        return `
                    <line x1="${margin.left}" y1="${y + margin.top}" x2="${width - margin.right}" y2="${y + margin.top}" stroke="#e5e7eb" stroke-width="1" stroke-dasharray="4 4" />
                    <text x="${margin.left - 10}" y="${y + margin.top + 4}" font-family="sans-serif" font-size="10" fill="#6b7280" text-anchor="end">${val}</text>
                `;
      }).join('');

      // Generate Bars
      let barSvg = '';
      bins.forEach((count, i) => {
        if (count === 0) return;
        const barH = (count / maxCount) * chartH;
        const barW = (chartW / binCount) - 2;
        const x = margin.left + (i * (chartW / binCount));
        const y = margin.top + (chartH - barH);

        // Color intensity based on height
        const opacity = 0.5 + (count / maxCount) * 0.5;

        barSvg += `<rect x="${x}" y="${y}" width="${Math.max(1, barW)}" height="${barH}" fill="#dc2626" fill-opacity="${opacity}" />`;

        // Tooltip title
        barSvg += `<title>${new Date((minT + (i / binCount) * range) * 1000).toLocaleDateString()}: ${count} posts</title>`;
      });

      // Generate X-Axis Labels (Date Ticks)
      const xLabels = [0, 0.25, 0.5, 0.75, 1].map(p => {
        const t = minT + (range * p);
        const date = new Date(t * 1000);
        const x = margin.left + (p * chartW);
        const label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        return `<text x="${x}" y="${height - 10}" font-family="sans-serif" font-size="11" fill="#4b5563" text-anchor="middle">${label}</text>`;
      }).join('');

      // Peak annotation
      const peakBinIdx = bins.indexOf(maxCount);
      const peakX = margin.left + (peakBinIdx * (chartW / binCount)) + (chartW / binCount) / 2;
      const peakY = margin.top + (chartH - ((maxCount / maxCount) * chartH)) - 5;

      return `
                <div style="width: 100%; overflow-x: auto;">
                    <svg viewBox="0 0 ${width} ${height}" style="width: 100%; min-width: 600px;">
                        <!-- Background -->
                        <rect width="${width}" height="${height}" fill="#fff" />
                        
                        <!-- Gridlines -->
                        ${gridLines}
                        <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#9ca3af" stroke-width="1" />
                        <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#9ca3af" stroke-width="1" />
                        
                        <!-- Data -->
                        ${barSvg}
                        
                        <!-- Labels -->
                        ${xLabels}
                        
                        <!-- Axis Titles -->
                        <text x="${15}" y="${height / 2}" transform="rotate(-90 15,${height / 2})" font-family="sans-serif" font-size="11" fill="#6b7280" text-anchor="middle">Posts Volume</text>
                        
                        <!-- Peak Annotation -->
                        <text x="${peakX}" y="${peakY}" font-family="sans-serif" font-size="10" font-weight="bold" fill="#dc2626" text-anchor="middle">Peak: ${maxCount}</text>
                    </svg>
                </div>
            `;
    })()}
        <p style="text-align:center; font-size: 0.75rem; color: #6b7280; margin-top: 0.5rem;">Timeline of posts from flagged accounts</p>
      </div>
    </div>
    
    <div class="section">
      <h2>Concrete Evidence Samples</h2>
      
      ${cibDetection.indicators.identicalHashtagsDetails && cibDetection.indicators.identicalHashtagsDetails.length > 0 ? `
      <h3>Repetitive Hashtag Campaigns</h3>
      <table>
        <thead><tr><th>Hashtags Used together</th><th>User Count</th></tr></thead>
        <tbody>
          ${cibDetection.indicators.identicalHashtagsDetails.map(d => `
            <tr><td><code style="font-size:0.75rem;">${escapeHtml(d.tags)}</code></td><td><strong>${d.count}</strong></td></tr>
          `).join('')}
        </tbody>
      </table>` : ''}
      
      ${cibDetection.indicators.semanticDuplicatesDetails && cibDetection.indicators.semanticDuplicatesDetails.length > 0 ? `
      <h3>Coordinated Messaging (Semantic Duplicates)</h3>
      <table>
        <thead><tr><th>Similarity</th><th>Caption Sample 1</th><th>Caption Sample 2</th></tr></thead>
        <tbody>
          ${cibDetection.indicators.semanticDuplicatesDetails.slice(0, 10).map(d => `
            <tr>
              <td>${d.similarity}</td>
              <td style="font-size:0.75rem;">${escapeHtml(d.captions[0])}...</td>
              <td style="font-size:0.75rem;">${escapeHtml(d.captions[1])}...</td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : ''}
    </div>

    <div class="section">
      <h2>Top ${Math.min(20, topOffenders.length)} Suspicious Accounts</h2>
      <table>
        <thead>
          <tr>
            <th>Rank</th>
            <th>Username</th>
            <th>Risk Score</th>
            <th>Risk Level</th>
            <th>Indicators</th>
            <th>Key Reasons</th>
          </tr>
        </thead>
        <tbody>
          ${topOffenders.map((offender, idx) => {
      const riskClass = offender.score >= 86 ? 'risk-critical' :
        offender.score >= 61 ? 'risk-high' :
          offender.score >= 31 ? 'risk-medium' : 'risk-low';
      const riskLevel = offender.score >= 86 ? 'Critical' :
        offender.score >= 61 ? 'High' :
          offender.score >= 31 ? 'Medium' : 'Low';
      return `
            <tr>
              <td><strong>${idx + 1}</strong></td>
              <td>${escapeHtml(offender.userData.uniqueId || offender.userData.nickname || offender.userId)}</td>
              <td><strong>${offender.score}</strong>/100</td>
              <td><span class="risk-badge ${riskClass}">${riskLevel}</span></td>
              <td>${offender.reasons.length}</td>
              <td style="max-width: 400px;">
                <ul class="reasons">
                  ${offender.reasons.slice(0, 3).map(r => `<li>${escapeHtml(r)}</li>`).join('')}
                  ${offender.reasons.length > 3 ? `<li><em>+${offender.reasons.length - 3} more...</em></li>` : ''}
                </ul>
              </td>
            </tr>
            `;
    }).join('')}
        </tbody>
      </table>
    </div>

    ${staticInfo.coordinationGraph?.components?.length > 0 ? (() => {
  const comps = staticInfo.coordinationGraph.components;
  const coordUserScores = cibDetection.userScores;
  const coordUserReasons = cibDetection.userReasons;
  const connectedComps = comps.filter(c => c.length > 1);
  const singletons = comps.filter(c => c.length === 1);
  const rows = connectedComps.slice(0, 30).map((comp, i) => {
    const memberList = comp
      .sort((a, b) => (coordUserScores.get(b) || 0) - (coordUserScores.get(a) || 0))
      .map(uid => {
        const score = coordUserScores.get(uid) || 0;
        const label = staticInfo.coordinationGraph.nodes.find(n => n.id === uid)?.label || uid;
        return `<span title="${escapeHtml(uid)}" style="background:#fef2f2; border:1px solid #fecaca; padding:.1rem .35rem; border-radius:4px; font-size:0.8rem; margin:.1rem; display:inline-block;">${escapeHtml(label)} (${score})</span>`;
      }).join(' ');
    const signalSet = new Set();
    staticInfo.coordinationGraph.links
      .filter(l => comp.includes(l.source) || comp.includes(l.target))
      .forEach(l => l.signals?.forEach(s => signalSet.add(s)));
    return `<tr><td style="padding:.5rem; border:1px solid #e5e7eb; white-space:nowrap;">${i + 1}</td>
      <td style="padding:.5rem; border:1px solid #e5e7eb;">${comp.length}</td>
      <td style="padding:.5rem; border:1px solid #e5e7eb;">${Array.from(signalSet).join(', ')}</td>
      <td style="padding:.5rem; border:1px solid #e5e7eb;">${memberList}</td></tr>`;
  }).join('');
  return `
    <div class="section">
      <h2>Coordinated Clusters</h2>
      <p style="color:#6b7280; margin-bottom:1rem;">${connectedComps.length} connected cluster${connectedComps.length !== 1 ? 's' : ''} found (${singletons.length} isolated flagged account${singletons.length !== 1 ? 's' : ''} with no pairwise partner).</p>
      <table style="width:100%; border-collapse:collapse; font-size:0.875rem;">
        <thead><tr style="background:#f9fafb;">
          <th style="padding:.5rem; border:1px solid #e5e7eb; text-align:left;">#</th>
          <th style="padding:.5rem; border:1px solid #e5e7eb; text-align:left;">Size</th>
          <th style="padding:.5rem; border:1px solid #e5e7eb; text-align:left;">Signals</th>
          <th style="padding:.5rem; border:1px solid #e5e7eb; text-align:left;">Members (risk score)</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
})() : ''}

    <div class="section">
      <h2>Detection Parameters Used</h2>
      <div class="params-box">
        <p><strong>Configuration:</strong></p>
        <ul style="margin-left: 1.5rem; margin-top: 0.5rem;">
          <li>Semantic Similarity: ${params.semanticEnabled ? `Enabled (threshold: ${params.semanticThreshold})` : 'Disabled'}</li>
          <li>Time Window: ${timeWindowText || 'N/A'}</li>
          <li>N-gram Overlap: ${params.ngramThreshold}</li>
          <li>Username Similarity: ${params.usernameThreshold}</li>
          <li>TF-IDF Threshold: ${params.tfidfThreshold}</li>
          <li>Z-Score Threshold: ${params.zscoreThreshold}</li>
          <li>Burst Min Posts: ${params.burstPosts}</li>
          <li>Rhythm CV Threshold: ${params.rhythmCV}</li>
          <li>Night Gap: ${params.nightGap}s</li>
          <li>Cluster Min Size: ${params.clusterSize}</li>
          <li>Cross-Indicator Bonus: ${params.crossMultiplier}</li>
        </ul>
      </div>
    </div>

    <div class="section">
      <div class="warning-box">
        <strong>⚠️ Important Disclaimer:</strong>
        <p style="margin-top: 0.5rem;">
          This report presents <strong>behavioral indicators</strong>, not definitive proof of inauthentic activity. 
          Legitimate activism, coordinated campaigns, fan communities, and event promotion can trigger these signals. 
          <strong>Always verify findings manually</strong> and consider contextual factors before drawing conclusions.
          Multiple indicators increase confidence, but human judgment is essential for accurate assessment.
        </p>
      </div>
    </div>

    <div class="section">
      <h2>Recommended Actions</h2>
      <ol style="margin-left: 2rem; line-height: 2;">
        <li><strong>Manual Review:</strong> Investigate the top ${Math.min(10, critical + high)} high-risk accounts in detail</li>
        <li><strong>Content Analysis:</strong> Examine post content for narrative themes and coordination patterns</li>
        <li><strong>Temporal Analysis:</strong> Review activity timelines for unusual patterns</li>
        <li><strong>Network Analysis:</strong> Examine connections between flagged accounts</li>
        <li><strong>Context Research:</strong> Investigate surrounding events that may explain coordinated activity</li>
        <li><strong>Cross-Platform Check:</strong> Look for similar patterns on other social media platforms</li>
        <li><strong>Documentation:</strong> Preserve evidence (screenshots, URLs, timestamps) for further investigation</li>
      </ol>
    </div>

    <div class="footer">
      <p><strong>Generated by SchuimSurfer</strong> - Social Media Network Analysis & CIB Detection Tool</p>
      <p>Report generated: ${escapeHtml(timestamp)}</p>
      <p style="margin-top: 1rem; font-size: 0.75rem; color: #9ca3af;">
        This is an automated analysis report. All findings should be verified by qualified investigators.
      </p>
    </div>
  </div>
</body>
</html>`;

  return html;
}

// =========================
// CSV Report Generation
// =========================
export function generateCSVReport(cibDetection, filteredData) {
  // Collect all suspicious users with data
  const rows = [];
  const headers = [
    'User ID', 'Username', 'Risk Score', 'Risk Level', 'Indicator Count',
    'Indicators', 'Followers', 'Verified', 'Posts in Dataset',
    'Avg Engagement', 'Detection Reasons'
  ];
  rows.push(headers);

  // Group posts by user for stats
  const userPosts = new Map();
  filteredData.forEach(p => {
    const uid = p.data?.author?.id;
    if (uid) {
      if (!userPosts.has(uid)) userPosts.set(uid, []);
      userPosts.get(uid).push(p);
    }
  });

  cibDetection.suspiciousUsers.forEach(userId => {
    const posts = userPosts.get(userId) || [];
    const author = posts[0]?.data?.author || {};
    const score = cibDetection.userScores.get(userId) || 0;
    const reasons = cibDetection.userReasons.get(userId) || [];

    // Calculate risk level
    let riskLevel = 'Low';
    if (score >= 86) riskLevel = 'Critical';
    else if (score >= 61) riskLevel = 'High';
    else if (score >= 31) riskLevel = 'Medium';

    // Engagement stats
    const avgEngagement = posts.length > 0
      ? (posts.reduce((sum, p) => sum + (p.data?.stats?.diggCount || 0), 0) / posts.length).toFixed(1)
      : 0;

    // Determine which indicators triggered
    const indicatorTypes = new Set();
    reasons.forEach(r => {
      if (r.includes('Synchronized')) indicatorTypes.add('Synchronized Posting');
      if (r.includes('Hashtag')) indicatorTypes.add('Coordinated Hashtags');
      if (r.includes('Username')) indicatorTypes.add('Similar Usernames');
      if (r.includes('High Volume')) indicatorTypes.add('High Volume');
      if (r.includes('Burst')) indicatorTypes.add('Temporal Burst');
      if (r.includes('Rhythm')) indicatorTypes.add('Rhythmic Posting');
    });

    const username = author.uniqueId || author.nickname || userId;
    const followers = author?.followerCount || posts[0]?.data?.authorStats?.followerCount || 0;
    const verified = author.verified ? 'Yes' : 'No';
    const postCount = posts.length;

    rows.push([
      userId,
      username,
      score,
      riskLevel,
      reasons.length,
      Array.from(indicatorTypes).join('; '),
      followers,
      verified,
      postCount,
      avgEngagement,
      reasons.join('; ')
    ]);
  });

  // Convert to CSV format
  const csvContent = rows.map(row =>
    row.map(cell => {
      // Escape quotes and wrap in quotes if contains comma, newline, or quote
      const cellStr = String(cell);
      if (cellStr.includes(',') || cellStr.includes('\n') || cellStr.includes('"')) {
        return '"' + cellStr.replace(/"/g, '""') + '"';
      }
      return cellStr;
    }).join(',')
  ).join('\n');

  return csvContent;
}
