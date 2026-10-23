/**
 * Community Detection Controller
 *
 * Thin main-thread wrapper that runs Louvain community detection and network
 * metrics in a dedicated Web Worker (assets/js/graph-worker.js), keeping the UI
 * interactive on large graphs. The actual algorithms live in the pure,
 * Node-tested module graph-algorithms.js.
 *
 * This replaces the previous main-thread implementation, which kept the tab
 * alive during minutes-long computations with a setInterval heartbeat and an
 * AudioContext oscillator — fragile hacks that are now gone. Worker liveness is
 * handled by the shared health-check protocol in worker-utils.js, and the
 * "Cancel Analysis" button can abort a run by terminating the worker.
 *
 * The public API (detectCommunities, calculateNetworkMetrics) keeps the same
 * async signature the call sites in app.js already use.
 */

import { perfMonitor } from './performance-utils.js';
import { serializeGraph } from './graph-algorithms.js';
import { createWorkerManager } from './worker-utils.js';

// Fixed seed → reproducible community assignments run-to-run (investigators can
// reproduce results, and behavior is deterministic). Previously Louvain shuffled
// with Math.random(), giving slightly different clusters each run.
const COMMUNITY_SEED = 1;

// Hard ceiling so a wedged worker reports instead of hanging forever.
const GRAPH_OP_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

const manager = createWorkerManager('assets/js/graph-worker.js');

/**
 * Run a single graph operation in the worker, relaying progress, supporting
 * cancellation via the shared "Cancel Analysis" button, and detecting worker
 * death (crash/terminate) instead of hanging.
 *
 * Resolves with the worker's payload on success, or null if cancelled.
 */
function runGraphOp({ messageType, completeType, graph, extra = {}, onProgress, extractResult }) {
  return new Promise((resolve, reject) => {
    let worker;
    let timeoutId = null;
    let cancelHandler = null;
    const cancelBtn = typeof document !== 'undefined'
      ? document.getElementById('cancel-cib-btn')
      : null;

    const cleanup = () => {
      if (worker) {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onWorkerError);
      }
      if (timeoutId) clearTimeout(timeoutId);
      if (cancelBtn && cancelHandler) {
        cancelBtn.removeEventListener('click', cancelHandler);
        cancelBtn.style.display = 'none';
      }
    };

    const onMessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === 'progress') {
        if (onProgress) onProgress(msg.message);
        return;
      }
      if (msg.type === completeType) {
        cleanup();
        resolve(extractResult(msg));
        return;
      }
      if (msg.type === 'error') {
        cleanup();
        reject(new Error(msg.error || 'Graph worker error'));
      }
    };

    const onWorkerError = (err) => {
      // Worker crashed mid-computation — surface it rather than hang.
      manager.markUnhealthy();
      cleanup();
      reject(new Error(`Graph worker crashed: ${err.message || 'unknown error'}`));
    };

    manager.ensureWorker()
      .then((w) => {
        worker = w;
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onWorkerError);

        // Wire the Cancel button: terminate the worker and resolve as cancelled.
        if (cancelBtn) {
          cancelHandler = () => {
            console.warn('🛑 Graph analysis cancelled by user');
            manager.terminate(); // kills the worker; next op recreates it
            cleanup();
            resolve(null);
          };
          cancelBtn.style.display = 'inline-block';
          cancelBtn.addEventListener('click', cancelHandler);
        }

        timeoutId = setTimeout(() => {
          manager.terminate();
          cleanup();
          reject(new Error('Graph operation timed out'));
        }, GRAPH_OP_TIMEOUT_MS);

        const { payload, transfer } = serializeGraph(graph);
        worker.postMessage({ type: messageType, graph: payload, ...extra }, transfer);
      })
      .catch((err) => {
        cleanup();
        reject(err);
      });
  });
}

export async function calculateNetworkMetrics(graph, onProgress) {
  if (!graph || graph.nodes.length === 0) return null;

  perfMonitor.start('networkMetrics');
  try {
    const payload = await runGraphOp({
      messageType: 'networkMetrics',
      completeType: 'metricsComplete',
      graph,
      onProgress,
      extractResult: (msg) => ({ metrics: msg.metrics, degrees: msg.degrees }),
    });

    if (!payload) return null; // cancelled

    // Apply degrees back onto the caller's own node objects (the worker computed
    // them on a copy). Node-size "degree" mode and tooltips depend on this.
    if (payload.degrees && payload.degrees.length) {
      const degreeMap = new Map(payload.degrees);
      graph.nodes.forEach(node => { node.degree = degreeMap.get(node.id) || 0; });
    }

    return payload.metrics;
  } finally {
    perfMonitor.end('networkMetrics');
  }
}

export async function detectCommunities(graph, onProgress) {
  if (!graph || graph.nodes.length === 0) return null;

  if (graph.nodes.length > 10000 && onProgress) {
    onProgress(`Detecting communities in large graph (${graph.nodes.length} nodes)... This may take a while.`);
  }

  perfMonitor.start('communityDetection');
  try {
    const result = await runGraphOp({
      messageType: 'detectCommunities',
      completeType: 'communitiesComplete',
      graph,
      extra: { seed: COMMUNITY_SEED },
      onProgress,
      extractResult: (msg) => msg.result,
    });

    if (!result) return null; // cancelled or empty

    // Rebuild the communities Map from the serialized entries.
    return {
      communities: new Map(result.communities),
      count: result.count,
      total: result.total,
      noiseClusterId: result.noiseClusterId,
      minClusterSize: result.minClusterSize,
      modularity: result.modularity,
    };
  } finally {
    perfMonitor.end('communityDetection');
  }
}
