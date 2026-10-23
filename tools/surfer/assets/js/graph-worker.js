// Web Worker for graph analysis (community detection + network metrics).
//
// Moves Louvain community detection and the clustering-coefficient computation
// off the main thread so the UI stays interactive (pan/zoom/tooltips) on large
// graphs. Replaces the old main-thread approach that relied on a setInterval
// heartbeat and an AudioContext oscillator to discourage tab discard.
//
// All algorithms are imported from graph-algorithms.js (shared with Node tests —
// single source of truth, no copied code).
//
// Protocol (matches the CIB worker's health-check convention):
//   { type: 'ping', pingId }                         → { type: 'pong', pingId }
//   { type: 'networkMetrics', graph: <serialized> }  → progress* , { type: 'metricsComplete', metrics, degrees }
//   { type: 'detectCommunities', graph, seed }       → progress* , { type: 'communitiesComplete', result }
//
// The graph is transferred in the typed-array format produced by serializeGraph.

import { deserializeGraph, computeNetworkMetrics, runLouvain } from './graph-algorithms.js';

function reportProgress(message) {
  self.postMessage({ type: 'progress', message });
}

self.onmessage = function (e) {
  const { type, graph, seed, pingId } = e.data;

  if (type === 'ping') {
    self.postMessage({ type: 'pong', pingId });
    return;
  }

  if (type === 'networkMetrics') {
    try {
      const rebuilt = deserializeGraph(graph);
      const result = computeNetworkMetrics(rebuilt, reportProgress);
      self.postMessage({
        type: 'metricsComplete',
        metrics: result ? result.metrics : null,
        degrees: result ? Array.from(result.degrees.entries()) : [],
      });
    } catch (error) {
      self.postMessage({ type: 'error', error: error.message, stack: error.stack });
    }
    return;
  }

  if (type === 'detectCommunities') {
    try {
      const rebuilt = deserializeGraph(graph);
      const result = runLouvain(rebuilt, { onProgress: reportProgress, seed });
      // Serialize the communities Map for structured clone.
      const serialized = result
        ? {
            communities: Array.from(result.communities.entries()),
            count: result.count,
            total: result.total,
            noiseClusterId: result.noiseClusterId,
            minClusterSize: result.minClusterSize,
            modularity: result.modularity,
          }
        : null;
      self.postMessage({ type: 'communitiesComplete', result: serialized });
    } catch (error) {
      self.postMessage({ type: 'error', error: error.message, stack: error.stack });
    }
    return;
  }
};
