// cosmos.gl is vendored locally (assets/js/vendor/) so the app loads with no
// network access — see Session 3 in ROADMAP.md. To bump versions, replace the
// vendored bundle and update this path. (Previously fetched from unpkg at runtime.)
import { Graph } from './vendor/cosmos-graph-2.5.0.js';
import { safeMax, safeMin, escapeHtml } from './utils.js';
import { riskColor, UNFLAGGED_COLOR } from './risk-color.js';

// Signal type colors for coordination graph edges
export const SIGNAL_COLORS = {
    sync: '#ef4444',
    semantic: '#8b5cf6',
    template: '#f97316',
    hashtags: '#10b981',
    username: '#3b82f6',
    creation: '#f59e0b',
    urls: '#0ea5e9',
    repost: '#a855f7',
};

// Constants
export const NODE_TYPE_COLORS = {
    userVerified: '#2563eb',
    userUnverified: '#8b5cf6',
    hashtag: '#10b981',
    location: '#f59e0b',
    sound: '#6366f1',
    music: '#6366f1',
    default: '#6b7280',
    noise: '#d1d5db',
};

// Colour-blind-safe categorical palette (Okabe–Ito + Paul Tol), chosen so
// adjacent community colours stay distinguishable under deuteranopia/protanopia
// and none collide with the muted-grey "noise" colour. (Session 4)
export const communityColors = ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#d55e00', '#56b4e9', '#f0e442', '#999933', '#882255', '#44aa99'];

const NODE_SIZE_MIN = 6;
const NODE_SIZE_MAX = 24;
const NODE_SIZE_UNIFORM = 10;

// Helper Functions
function hexToFloatColor(hex, alpha = 1) {
    const normalized = hex.replace('#', '');
    const bigint = parseInt(normalized, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return [r / 255, g / 255, b / 255, alpha];
}

export class VisualizationManager {
    constructor(container, config = {}) {
        this.container = container;
        this.config = config; // { onNodeClick, onNodeHover, onBackgroundClick, nodeBodyMapper }
        this.graph = null;
        this.nodes = [];
        this.links = [];
        this.nodeIndex = new Map(); // id -> index
        this.idToNode = new Map();
        this.nodeSizeStats = null;
        this.communities = null;
        this.clusterLabels = [];
        this.currentClusterStats = new Map();
        this.hoverIndex = null;
        this.hoveredNode = null;
        this.mode = 'community'; // 'community' | 'risk'
        this.renderScheduled = false;
        this.maxClusterLabelNodes = Number(config.maxClusterLabelNodes || 4000);
        this.clusterLabelsEnabled = true;

        // Create cluster label layer
        this.clusterLabelLayer = document.createElement('div');
        this.clusterLabelLayer.style.position = 'absolute';
        this.clusterLabelLayer.style.inset = '0';
        this.clusterLabelLayer.style.pointerEvents = 'none';
        this.container.appendChild(this.clusterLabelLayer);

        // Tooltip
        this.tooltipEl = config.tooltipElement;

        // Binders
        this.handlePointOver = this.handlePointOver.bind(this);
        this.handlePointOut = this.handlePointOut.bind(this);
        this.handlePointClick = this.handlePointClick.bind(this);
        this.handleMouseMove = this.handleMouseMove.bind(this);
        this.handleBackgroundClick = this.handleBackgroundClick.bind(this);
        this.scheduleClusterLabelRefresh = this.scheduleClusterLabelRefresh.bind(this);
        this.requestRender = this.requestRender.bind(this);
    }

    init() {
        this.ensureGraph();
    }

    canvasBackground() {
        // Follow the theme token so the graph background matches light/dark mode.
        try {
            const v = getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg').trim();
            if (v) return v;
        } catch { /* non-DOM env */ }
        return '#ffffff';
    }

    applyTheme() {
        if (this.graph) {
            this.graph.setConfig({ backgroundColor: this.canvasBackground() });
            this.requestRender();
        }
    }

    ensureGraph() {
        if (!this.graph) {
            this.graph = new Graph(this.container, {
                backgroundColor: this.canvasBackground(),
                pointColor: '#9ca3af',
                pointGreyoutOpacity: 0.12,
                pointSize: 6,
                linkColor: '#d1d5db',
                linkGreyoutOpacity: 0.18,
                linkWidth: 0.6,
                enableSimulation: true,
                enableDrag: true,
                hoveredPointCursor: 'pointer',
                fitViewOnInit: false, // We control camera fitting manually in updateData()
                simulation: {
                    gravity: 0.5,
                    center: 1.0,
                    repulsion: 0.2,
                    linkDistance: 10,
                    linkSpring: 1.0,
                    friction: 0.98, // Very high friction - simulation stops quickly
                    cluster: 0.1,
                    decay: 1000, // Much shorter decay - 1 second instead of 3
                },
            });

            this.graph.setConfig({
                onPointMouseOver: this.handlePointOver,
                onPointMouseOut: this.handlePointOut,
                onPointClick: this.handlePointClick,
                onMouseMove: this.handleMouseMove,
                onClick: this.handleBackgroundClick,
                onZoom: this.scheduleClusterLabelRefresh,
                onSimulationTick: this.scheduleClusterLabelRefresh,
            });
        }
        return this.graph;
    }

    requestRender() {
        if (!this.graph || this.renderScheduled) return;
        this.renderScheduled = true;
        requestAnimationFrame(() => {
            this.renderScheduled = false;
            if (this.graph) this.graph.render();
        });
    }

    updateData(graphData, communities) {
        if (!graphData || graphData.nodes.length === 0) {
            this.clear();
            return;
        }

        this.communities = communities;
        this.clusterLabelLayer.innerHTML = '';
        this.clusterLabels = [];
        this.hoverIndex = null;
        this.hoveredNode = null;
        this.container.classList.remove('hovering');

        // Process nodes
        this.nodes = graphData.nodes.map((node, index) => ({
            ...node,
            index,
        }));

        this.links = graphData.links || [];

        // Index maps
        this.nodeIndex = new Map(this.nodes.map(n => [n.id, n.index]));
        this.idToNode = new Map(this.nodes.map(n => [n.id, n]));

        this.currentClusterStats = this.computeClusterStats();
        this.nodeSizeStats = null; // will be recomputed if needed
        this.clusterLabelsEnabled = this.nodes.length <= this.maxClusterLabelNodes;

        const geometry = this.buildGeometry();

        // Only destroy/recreate the graph if node count increased beyond current buffer capacity.
        // Preserving the existing WebGL context when possible avoids expensive teardown.
        const needsRecreate = !this.graph || this.nodes.length > (this.lastNodeCount || 0);
        if (needsRecreate) {
            this.destroyGraph();
        }
        const graph = this.ensureGraph();
        this.lastNodeCount = this.nodes.length;

        graph.setPointPositions(geometry.pointPositions);
        graph.setPointSizes(geometry.pointSizes);
        graph.setPointColors(geometry.pointColors);
        graph.setPointClusters(geometry.pointClusters);
        graph.setLinks(geometry.links);
        graph.setLinkColors(geometry.linkColors);
        graph.setLinkWidths(geometry.linkWidths);
        // Reheat simulation so nodes animate into their new layout even when the
        // graph context is reused. Without this the simulation may have decayed to
        // alpha ≈ 0 and nodes would freeze in place.
        graph.store.alpha = 1;
        this.requestRender();

        // Fit the camera AFTER the render frame has uploaded the new positions.
        // requestRender() schedules a RAF callback; by scheduling our own RAF
        // callback here we guarantee it runs *after* render() has updated buffers.
        requestAnimationFrame(() => {
            if (this.graph && this.nodes.length > 0) {
                const indices = this.nodes.map((_, i) => i);
                this.graph.fitViewByPointIndices(indices, 0, 0.15);
            }
        });
        // Smooth re-fit once the short simulation has settled.
        setTimeout(() => {
            if (this.graph && this.nodes.length > 0) {
                const indices = this.nodes.map((_, i) => i);
                this.graph.fitViewByPointIndices(indices, 800, 0.15);
            }
        }, 1200); // Wait for 1000ms decay + 200ms buffer

        this.updateClusterLabels();
    }

    destroyGraph() {
        if (this.graph) {
            if (typeof this.graph.destroy === 'function') {
                this.graph.destroy();
            }
            this.graph = null;
        }
        // Remove canvas if any remains (Cosmos appends canvas)
        const canvas = this.container.querySelector('canvas');
        if (canvas) canvas.remove();
    }

    clear() {
        this.clusterLabelLayer.innerHTML = '';
        this.clusterLabels = [];
        if (this.graph) {
            this.graph.setPointPositions(new Float32Array());
            this.graph.setLinks(new Float32Array());
            this.requestRender();
        }
        this.hideTooltip();
        this.nodes = [];
        this.links = [];
        this.nodeIndex.clear();
        this.idToNode.clear();
    }

    buildGeometry() {
        const pointPositions = new Float32Array(this.nodes.length * 2);
        const pointColors = new Float32Array(this.nodes.length * 4);
        const pointSizes = new Float32Array(this.nodes.length);
        const pointClusters = new Float32Array(this.nodes.length);

        this.nodes.forEach((node, index) => {
            // Initialize random positions if not provided (Cosmos simulation handles layout)
            const angle = Math.random() * Math.PI * 2;
            // Moderate initial radius — close enough that the camera doesn't need to
            // zoom out dramatically, but spread enough that repulsion doesn't explode.
            const radius = 100 + Math.random() * 300;
            pointPositions[index * 2] = Math.cos(angle) * radius;
            pointPositions[index * 2 + 1] = Math.sin(angle) * radius;

            const [r, g, b, a] = hexToFloatColor(this.getNodeColor(node));
            pointColors.set([r, g, b, a], index * 4);

            pointSizes[index] = Math.max(4, this.getNodeSize(node));

            const cid = this.communities?.communities?.get(node.id) ?? 0;
            pointClusters[index] = cid;
        });

        const linkPairs = [];
        const linkColorValues = [];
        const linkWidths = [];

        this.links.forEach(link => {
            const sourceIndex = this.nodeIndex.get(link.source.id || link.source);
            const targetIndex = this.nodeIndex.get(link.target.id || link.target);

            if (sourceIndex === undefined || targetIndex === undefined) return;

            linkPairs.push(sourceIndex, targetIndex);

            const weight = link.weight || 1;
            const alpha = Math.min(0.55 + weight * 0.08, 0.88);
            const edgeHex = link.color || (link.signals?.length > 0
                ? (SIGNAL_COLORS[link.signals[0]] || '#6b7280')
                : '#6b7280');
            const [r, g, b, a] = hexToFloatColor(edgeHex, alpha);
            linkColorValues.push(r, g, b, a);
            linkWidths.push(Math.max(0.8, Math.min(weight * 0.8, 3.0)));
        });

        return {
            pointPositions,
            pointColors,
            pointSizes,
            pointClusters,
            links: new Float32Array(linkPairs),
            linkColors: new Float32Array(linkColorValues),
            linkWidths: new Float32Array(linkWidths),
        };
    }

    getNodeColor(node) {
        if (!node) return NODE_TYPE_COLORS.default;

        // Mode: Risk Analysis — graded amber→deep-red ramp by CIB score so
        // severity is visible at a glance; unflagged nodes stay muted grey.
        if (this.mode === 'risk') {
            if (node.suspicious) return riskColor(node.cibScore ?? 0);
            return UNFLAGGED_COLOR;
        }

        // Mode: Community — colour by cluster
        if (this.communities?.communities) {
            const cid = this.communities.communities.get(node.id);
            const noiseId = this.communities.noiseClusterId;
            if (cid === noiseId || cid === 0) {
                return NODE_TYPE_COLORS.noise;
            }
            if (cid !== undefined && cid > 0) {
                return communityColors[(cid - 1) % communityColors.length];
            }
        }

        // Priority 3: Type based
        if (node.type === 'user') {
            return node.verified ? NODE_TYPE_COLORS.userVerified : NODE_TYPE_COLORS.userUnverified;
        }
        return NODE_TYPE_COLORS[node.type] || NODE_TYPE_COLORS.default;
    }

    setMode(mode) {
        if (this.mode !== mode) {
            this.mode = mode;
            this.refreshStyling({ updateClusters: true });
        }
    }

    getNodeSize(node) {
        if (!node) return NODE_SIZE_UNIFORM;

        // We assume mode is 'degree' by default or passed in config/state
        // If needing external control, we can add a property
        const mode = this.config.nodeSizeMode || 'degree';

        if (mode === 'uniform') return NODE_SIZE_UNIFORM;

        if (!this.nodeSizeStats || this.nodeSizeStats.mode !== mode) {
            this.nodeSizeStats = this.computeNodeSizeStatsForMode(mode);
        }

        const metric = this.getNodeSizeMetric(node, mode);
        if (!Number.isFinite(metric)) return this.nodeSizeStats.defaultSize;

        const { min, max, minSize, maxSize, defaultSize } = this.nodeSizeStats;
        if (max <= min) return defaultSize;

        const normalized = (metric - min) / (max - min);
        const clamped = Math.max(0, Math.min(1, normalized));
        return minSize + clamped * (maxSize - minSize);
    }

    getNodeSizeMetric(node, mode) {
        if (!node) return 0;
        switch (mode) {
            case 'followers':
                if (typeof node.followers === 'number') return Math.log10(Math.max(0, node.followers) + 1);
                if (typeof node.count === 'number') return Math.log10(Math.max(0, node.count) + 1); // Fallback
                return Math.log10((node.degree ?? 0) + 1);
            case 'degree':
            default:
                return Math.log10((node.degree ?? 0) + 1);
        }
    }

    computeNodeSizeStatsForMode(mode) {
        if (!this.nodes.length) {
            return { mode, min: 0, max: 0, minSize: NODE_SIZE_UNIFORM, maxSize: NODE_SIZE_UNIFORM, defaultSize: NODE_SIZE_UNIFORM };
        }
        const metrics = this.nodes
            .map(node => this.getNodeSizeMetric(node, mode))
            .filter(v => Number.isFinite(v));

        if (!metrics.length) {
            return { mode, min: 0, max: 0, minSize: NODE_SIZE_UNIFORM, maxSize: NODE_SIZE_UNIFORM, defaultSize: NODE_SIZE_UNIFORM };
        }

        const min = safeMin(metrics);
        const max = safeMax(metrics);

        if (max <= min) {
            const size = Math.max(NODE_SIZE_MIN, Math.min(NODE_SIZE_MAX, NODE_SIZE_UNIFORM));
            return { mode, min, max, minSize: size, maxSize: size, defaultSize: size };
        }

        return { mode, min, max, minSize: NODE_SIZE_MIN, maxSize: NODE_SIZE_MAX, defaultSize: NODE_SIZE_UNIFORM };
    }

    computeClusterStats() {
        const stats = new Map();
        if (!this.communities || !this.communities.communities) return stats;

        const noiseId = this.communities.noiseClusterId;

        this.nodes.forEach(node => {
            const cid = this.communities.communities.get(node.id);
            if (cid === undefined) return;
            if (!stats.has(cid)) {
                stats.set(cid, { size: 0, suspicious: 0, isNoise: cid === noiseId });
            }
            const entry = stats.get(cid);
            entry.size += 1;
            if (node.suspicious) entry.suspicious += 1;
        });
        return stats;
    }

    refreshStyling({ updateClusters = true } = {}) {
        if (!this.graph || !this.nodes.length) return;

        const colors = new Float32Array(this.nodes.length * 4);
        const sizes = new Float32Array(this.nodes.length);
        const clusters = updateClusters ? new Float32Array(this.nodes.length) : null;

        this.nodes.forEach((node, index) => {
            const [r, g, b, a] = hexToFloatColor(this.getNodeColor(node));
            colors.set([r, g, b, a], index * 4);
            sizes[index] = Math.max(4, this.getNodeSize(node));
            if (clusters) {
                const cid = this.communities?.communities?.get(node.id) ?? 0;
                clusters[index] = cid;
            }
        });

        this.graph.setPointColors(colors);
        this.graph.setPointSizes(sizes);
        if (clusters) {
            this.graph.setPointClusters(clusters);
            this.currentClusterStats = this.computeClusterStats();
            this.updateClusterLabels();
        }
        this.requestRender();
    }

    updateClusterLabels() {
        if (!this.clusterLabelsEnabled) {
            this.clusterLabelLayer.innerHTML = '';
            this.clusterLabels = [];
            return;
        }

        if (!this.graph || !this.communities || !this.communities.communities) {
            this.clusterLabelLayer.innerHTML = '';
            this.clusterLabels = [];
            return;
        }

        const positions = this.graph.getClusterPositions?.();
        if (!positions || positions.length === 0) {
            this.clusterLabelLayer.innerHTML = '';
            this.clusterLabels = [];
            return;
        }

        const clusterCount = positions.length / 2;
        if (this.clusterLabels.length !== clusterCount) {
            this.clusterLabelLayer.innerHTML = '';
            this.clusterLabels = [];
            for (let i = 0; i < clusterCount; i++) {
                const label = document.createElement('div');
                label.className = 'cosmos-cluster-label';
                this.clusterLabelLayer.appendChild(label);
                this.clusterLabels.push(label);
            }
        }

        const noiseId = this.communities.noiseClusterId;

        // ... (existing code) ...
        for (let i = 0; i < clusterCount; i++) {
            const label = this.clusterLabels[i];
            const stats = this.currentClusterStats.get(i);

            if (!stats || stats.isNoise || i === noiseId) {
                label.style.display = 'none';
                continue;
            }

            label.style.display = 'block';
            const customName = this.communities.names?.get(i) || `Cluster ${i}`;
            label.innerHTML = `${escapeHtml(customName)}<small>${escapeHtml(stats.size)} nodes${stats.suspicious ? ` · ${escapeHtml(stats.suspicious)} flagged` : ''}</small>`;

            const color = communityColors[(i - 1 + communityColors.length) % communityColors.length];
            label.style.background = `${color}1f`;
            label.style.border = `1px solid ${color}`;
            label.style.color = color;

            const spaceX = positions[i * 2];
            const spaceY = positions[i * 2 + 1];

            if (spaceX == null || spaceY == null) {
                label.style.display = 'none';
                continue;
            }

            const [screenX, screenY] = this.graph.spaceToScreenPosition([spaceX, spaceY]);
            label.style.left = `${screenX}px`;
            label.style.top = `${screenY}px`;
        }
    }

    getGraphState() {
        if (!this.graph || !this.nodes.length) return null;

        // Attempt to get current point positions from the graph simulation
        // The graph API should provide the updated positions
        const positions = this.graph.getPointPositions();

        if (!positions || positions.length < this.nodes.length * 2) {
            console.warn('Could not retrieve valid positions from graph');
            return null;
        }

        const state = new Map();
        this.nodes.forEach((node, i) => {
            state.set(node.id, {
                x: positions[i * 2],
                y: positions[i * 2 + 1]
            });
        });

        return state;
    }

    resize() {
        if (this.graph) {
            this.requestRender();
            this.updateClusterLabels();
        }
    }

    scheduleClusterLabelRefresh() {
        if (!this.clusterLabelsEnabled) return;
        if (this._pendingClusterUpdate) cancelAnimationFrame(this._pendingClusterUpdate);
        this._pendingClusterUpdate = requestAnimationFrame(() => {
            this._pendingClusterUpdate = null;
            this.updateClusterLabels();
        });
    }

    // Handlers
    handlePointOver(index, position, event) {
        const node = this.nodes[index];
        if (!node) return;
        this.hoverIndex = index;
        this.hoveredNode = node;
        this.container.classList.add('hovering');
        this.highlightNeighbors(node);
        this.showTooltip(node, event);
    }

    handlePointOut() {
        this.hoverIndex = null;
        this.hoveredNode = null;
        this.container.classList.remove('hovering');
        this.hideTooltip();
        this.clearHighlight();
    }

    handlePointClick(index) {
        const node = this.nodes[index];
        if (!node) return;
        if (this.config.onNodeClick) {
            this.config.onNodeClick(node);
        }
    }

    handleBackgroundClick() {
        this.hoverIndex = null;
        this.hoveredNode = null;
        this.container.classList.remove('hovering');
        this.hideTooltip();
        this.clearHighlight();
        if (this.config.onBackgroundClick) {
            this.config.onBackgroundClick();
        }
    }

    handleMouseMove(index, position, event) {
        if (this.hoveredNode && this.tooltipEl) {
            this.moveTooltip(event);
        }
    }

    highlightNeighbors(node) {
        if (!this.graph || !node) return;
        const index = this.nodeIndex.get(node.id);
        if (index === undefined) return;
        this.graph.selectPointByIndex(index, true);
    }

    clearHighlight() {
        this.graph?.unselectPoints();
    }

    // Tooltip Logic
    showTooltip(node, event) {
        if (!this.tooltipEl || !event) return;
        const deg = node.degree ?? 0;
        const label = escapeHtml(node.label ?? node.id);
        let prefix = '';
        if (node.type === 'user') prefix = '@';
        else if (node.type === 'hashtag') prefix = '#';
        else if (node.type === 'location') prefix = '📍';

        const meta = node.type === 'user'
            ? `${node.verified ? 'Verified · ' : ''}${(node.followers || 0).toLocaleString()} followers`
            : `${node.count || 0} posts`;

        this.tooltipEl.innerHTML = `<div style="font-weight:600">${prefix}${label}</div>` +
            `<div style="opacity:.85">${escapeHtml(node.type)} · degree ${escapeHtml(deg)}${meta ? ' · ' + escapeHtml(meta) : ''}</div>`;
        this.tooltipEl.style.display = 'block';
        this.moveTooltip(event);
    }

    moveTooltip(event) {
        if (!this.tooltipEl || !event) return;
        const offset = 10;
        const pad = 8;
        const containerRect = this.container.getBoundingClientRect();
        const vw = containerRect.width;
        const vh = containerRect.height;
        const containerX = event.clientX - containerRect.left;
        const containerY = event.clientY - containerRect.top;

        this.tooltipEl.style.left = '0px';
        this.tooltipEl.style.top = '0px';
        const tb = this.tooltipEl.getBoundingClientRect();

        let tx = containerX + offset;
        let ty = containerY + offset;

        if (tx + tb.width + pad > vw) {
            tx = containerX - tb.width - offset;
            if (tx < pad) tx = pad;
        }
        if (ty + tb.height + pad > vh) {
            ty = containerY - tb.height - offset;
            if (ty < pad) ty = pad;
        }

        this.tooltipEl.style.left = `${tx}px`;
        this.tooltipEl.style.top = `${ty}px`;
    }

    hideTooltip() {
        if (this.tooltipEl) this.tooltipEl.style.display = 'none';
    }

    // Public Getters
    getNodes() {
        return this.nodes;
    }

    getIdToNode() {
        return this.idToNode;
    }
}
