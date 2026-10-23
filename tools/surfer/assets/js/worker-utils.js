/**
 * Worker Utilities (main-thread side)
 *
 * Shared lifecycle helpers for the app's module workers (CIB worker, graph
 * worker). Both workers speak the same minimal health-check protocol:
 *
 *   main → worker: { type: 'ping', pingId }
 *   worker → main: { type: 'pong', pingId }
 *
 * This module centralizes worker creation, ping/pong liveness checks, and the
 * "ensure a healthy worker exists (recreate if dead)" logic so each controller
 * doesn't reimplement it (and drift over time).
 */

/**
 * Send a ping and resolve true if a matching pong comes back within timeoutMs,
 * false otherwise (worker hung, crashed, or never started).
 */
export function pingWorker(worker, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const pingId = `${Date.now()}-${Math.random()}`;
    const timer = setTimeout(() => {
      worker.removeEventListener('message', handler);
      resolve(false);
    }, timeoutMs);
    const handler = (e) => {
      if (e.data && e.data.type === 'pong' && e.data.pingId === pingId) {
        clearTimeout(timer);
        worker.removeEventListener('message', handler);
        resolve(true);
      }
    };
    worker.addEventListener('message', handler);
    worker.postMessage({ type: 'ping', pingId });
  });
}

/**
 * Create a manager that owns a single module worker and keeps it healthy.
 *
 * @param {string} url - worker script URL (module worker)
 * @param {object} [options]
 * @param {(err) => void} [options.onError] - extra handler for worker.onerror
 * @returns {{ ensureWorker: () => Promise<Worker>, getWorker: () => Worker|null,
 *             create: () => Worker, terminate: () => void, isHealthy: () => boolean }}
 */
export function createWorkerManager(url, { onError } = {}) {
  let activeWorker = null;
  let healthy = false;

  function create() {
    if (activeWorker) {
      try { activeWorker.terminate(); } catch { /* ignore */ }
    }
    const worker = new Worker(url, { type: 'module' });
    worker.onerror = (err) => {
      healthy = false;
      console.error(`Worker error (${url}):`, err.message || err);
      if (onError) onError(err);
    };
    activeWorker = worker;
    healthy = true;
    return worker;
  }

  async function ensureWorker() {
    if (activeWorker && healthy) {
      const alive = await pingWorker(activeWorker, 3000);
      if (alive) return activeWorker;
    }
    console.log(`🔄 Creating fresh worker (${url})...`);
    return create();
  }

  function terminate() {
    if (activeWorker) {
      try { activeWorker.terminate(); } catch { /* ignore */ }
    }
    activeWorker = null;
    healthy = false;
  }

  return {
    ensureWorker,
    getWorker: () => activeWorker,
    create,
    terminate,
    isHealthy: () => healthy,
    markUnhealthy: () => { healthy = false; },
  };
}
