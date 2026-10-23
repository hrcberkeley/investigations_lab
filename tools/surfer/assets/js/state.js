/**
 * Global Application State
 *
 * Live bindings exported for use across modules. In ESM, imported bindings
 * are read-only from the consumer's side. To mutate shared state, use the
 * exported `setXxx(value)` helpers below.
 */

// Core datasets
export let rawData = [];
export function setRawData(v) { rawData = v; }

export let filteredData = [];
export function setFilteredData(v) { filteredData = v; }

// Columnar indexing
export let columnarDataIndex = null;
export function setColumnarDataIndex(v) { columnarDataIndex = v; }

export let filteredIndices = null;
export function setFilteredIndices(v) { filteredIndices = v; }

// Network / visualization
export let graphData = null;
export function setGraphData(v) { graphData = v; }

export let nodes = [];
export function setNodes(v) { nodes = v; }

export let communities = null;
export function setCommunities(v) { communities = v; }

export let vizManager = null;
export function setVizManager(v) { vizManager = v; }

// CIB & analytics
export let cibDetection = null;
export function setCibDetection(v) { cibDetection = v; }

export let networkMetrics = null;
export function setNetworkMetrics(v) { networkMetrics = v; }

// UI / lifecycle flags
export let isRestoring = false;
export function setIsRestoring(v) { isRestoring = v; }

// Visualization helpers / indexes
export let idToNode = new Map();
export function setIdToNode(v) { idToNode = v; }

export let adjacency = new Map();
export function setAdjacency(v) { adjacency = v; }

export let hoveredNode = null;
export function setHoveredNode(v) { hoveredNode = v; }

// Modal / comparison state
export let comparisonState = null;
export function setComparisonState(v) { comparisonState = v; }

// Coordination graph (built after CIB detection)
export let coordinationGraph = null;
export function setCoordinationGraph(v) { coordinationGraph = v; }

// CSV import state
export let csvData = null;
export function setCsvData(v) { csvData = v; }

export let csvMapping = {};
export function setCsvMapping(v) { csvMapping = v; }

// Keep window.nodes in sync for legacy renderer access
Object.defineProperty(window, 'nodes', {
  get: () => nodes,
  configurable: true
});
