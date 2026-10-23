/**
 * Graph Algorithms (pure module)
 *
 * Louvain community detection, network metrics (degree, density, clustering
 * coefficient) and modularity. Pure functions only — no DOM, no globals, no
 * timers. This is the single source of truth for these computations, shared by
 * the graph Web Worker (assets/js/graph-worker.js) and exercised directly by
 * Node tests (tests/graph-algorithms.test.mjs).
 *
 * Mirrors the cib-algorithms.js pattern: the worker imports these functions and
 * runs them off the main thread, while tests verify them against hand-computed
 * fixtures.
 *
 * NON-NEGOTIABLE: every node and every edge is processed. No sampling.
 */

import { safeMax } from './utils.js';

// =========================
// Seeded PRNG (for reproducible Louvain runs)
// =========================

/**
 * mulberry32 — a small, fast, deterministic PRNG. Given the same 32-bit seed it
 * always produces the same sequence, so community detection becomes reproducible
 * (handy for investigators repeating an analysis and essential for tests).
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleArray(array, rng) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// =========================
// Graph serialization (typed-array transfer format)
// =========================

/**
 * Serialize a graph into a compact, transferable form for postMessage. Node ids
 * (strings) are sent once; edges are packed into a Uint32Array of index pairs
 * plus a Float32Array of weights, so structured-clone cost stays linear in edge
 * count instead of allocating an object per edge.
 *
 * Returns { nodeIds, edgeIndex, weights } plus the transfer list.
 */
export function serializeGraph(graph) {
  const nodeIds = graph.nodes.map(n => n.id);
  const indexOf = new Map();
  nodeIds.forEach((id, i) => indexOf.set(id, i));

  const links = graph.links;
  const edgeIndex = new Uint32Array(links.length * 2);
  const weights = new Float32Array(links.length);

  let w = 0;
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const sourceId = link.source && link.source.id !== undefined ? link.source.id : link.source;
    const targetId = link.target && link.target.id !== undefined ? link.target.id : link.target;
    const si = indexOf.get(sourceId);
    const ti = indexOf.get(targetId);
    // Skip edges that reference nodes not in the node list (defensive).
    if (si === undefined || ti === undefined) continue;
    edgeIndex[w * 2] = si;
    edgeIndex[w * 2 + 1] = ti;
    weights[w] = Number.isFinite(link.weight) ? link.weight : 1;
    w++;
  }

  // Trim to the number of valid edges actually written.
  const trimmedIndex = w === links.length ? edgeIndex : edgeIndex.slice(0, w * 2);
  const trimmedWeights = w === links.length ? weights : weights.slice(0, w);

  return {
    payload: { nodeIds, edgeIndex: trimmedIndex, weights: trimmedWeights },
    transfer: [trimmedIndex.buffer, trimmedWeights.buffer],
  };
}

/**
 * Rebuild a minimal graph ({ nodes: [{id}], links: [{source,target,weight}] })
 * from the serialized payload. Used inside the worker.
 */
export function deserializeGraph({ nodeIds, edgeIndex, weights }) {
  const nodes = nodeIds.map(id => ({ id }));
  const links = new Array(weights.length);
  for (let i = 0; i < weights.length; i++) {
    links[i] = {
      source: nodeIds[edgeIndex[i * 2]],
      target: nodeIds[edgeIndex[i * 2 + 1]],
      weight: weights[i],
    };
  }
  return { nodes, links };
}

// =========================
// Network metrics + clustering coefficient
// =========================

/**
 * Compute degree-based metrics and the average clustering coefficient over the
 * FULL graph. Returns the metrics object plus a degrees Map so the caller can
 * apply degrees back onto its own node objects (the worker can't mutate the
 * main thread's nodes).
 */
export function computeNetworkMetrics(graph, onProgress) {
  const n = graph.nodes.length;
  const m = graph.links.length;
  if (n === 0) return null;

  if (onProgress) onProgress('Calculating network metrics...');

  const maxEdges = (n * (n - 1)) / 2;
  const density = maxEdges > 0 ? (m / maxEdges).toFixed(3) : 0;

  const degrees = new Map();
  graph.nodes.forEach(node => degrees.set(node.id, 0));

  const adjacency = new Map();
  graph.nodes.forEach(node => adjacency.set(node.id, new Set()));

  graph.links.forEach(link => {
    const sourceId = link.source && link.source.id !== undefined ? link.source.id : link.source;
    const targetId = link.target && link.target.id !== undefined ? link.target.id : link.target;
    degrees.set(sourceId, (degrees.get(sourceId) || 0) + 1);
    degrees.set(targetId, (degrees.get(targetId) || 0) + 1);
    adjacency.get(sourceId)?.add(targetId);
    adjacency.get(targetId)?.add(sourceId);
  });

  const degreeValues = Array.from(degrees.values());
  const avgDegree = (degreeValues.reduce((a, b) => a + b, 0) / n).toFixed(2);
  const maxDegree = degrees.size ? safeMax(degreeValues) : 0;

  if (onProgress) onProgress(`Calculating clustering coefficient... (${n} nodes)`);

  let totalClustering = 0;
  let validNodes = 0;

  for (let i = 0; i < graph.nodes.length; i++) {
    const node = graph.nodes[i];
    const neighbors = adjacency.get(node.id);
    if (!neighbors || neighbors.size < 2) continue;

    let triangles = 0;
    const arr = Array.from(neighbors);
    for (let a = 0; a < arr.length; a++) {
      const setA = adjacency.get(arr[a]);
      for (let b = a + 1; b < arr.length; b++) {
        if (setA && setA.has(arr[b])) triangles++;
      }
    }
    const possible = (neighbors.size * (neighbors.size - 1)) / 2;
    if (possible > 0) {
      totalClustering += triangles / possible;
      validNodes++;
    }

    if (onProgress && i > 0 && i % 2000 === 0) {
      const progress = Math.floor((i / graph.nodes.length) * 100);
      onProgress(`Calculating clustering... ${progress}% (${i}/${n} nodes)`);
    }
  }

  const avgClustering = validNodes > 0 ? (totalClustering / validNodes).toFixed(3) : 0;

  return {
    metrics: { nodes: n, edges: m, density, avgDegree, maxDegree, avgClustering },
    degrees,
  };
}

// =========================
// Louvain community detection
// =========================

export function runLouvain(graph, { onProgress, seed } = {}) {
  if (!graph || graph.nodes.length === 0) return null;

  const rng = typeof seed === 'number' ? mulberry32(seed) : Math.random;

  const baseState = createLouvainState(
    graph.nodes.map(n => n.id),
    graph.links.map(link => ({
      source: link.source && link.source.id !== undefined ? link.source.id : link.source,
      target: link.target && link.target.id !== undefined ? link.target.id : link.target,
      weight: link.weight || 1,
    }))
  );

  if (baseState.totalWeight === 0) {
    // No edges — collapse everything into a noise cluster.
    const assignments = new Map();
    baseState.nodeIds.forEach(id => assignments.set(id, 0));
    return finalizeLouvainClusters(assignments, baseState.adjacency, baseState.nodeIds.length, graph);
  }

  const levelAssignments = [];
  let currentState = baseState;
  let keepIterating = true;
  let safety = 0;

  while (keepIterating && safety < 10) {
    if (onProgress) {
      onProgress(`Community detection pass ${safety + 1}... (${currentState.nodeIds.length} nodes)`);
    }

    const { assignment, moved } = executeLouvainPhase(currentState, rng);
    levelAssignments.push(assignment);
    keepIterating = moved;
    safety += 1;

    if (!moved) break;

    currentState = aggregateLouvainGraph(currentState, assignment);
    if (currentState.nodeIds.length <= 1) break;
  }

  if (onProgress) onProgress('Finalizing communities...');

  const flattenedAssignments = new Map();
  baseState.nodeIds.forEach(nodeId => {
    let community = levelAssignments[0]?.get(nodeId) ?? 0;
    for (let level = 1; level < levelAssignments.length; level++) {
      const map = levelAssignments[level];
      community = map.get(community) ?? community;
    }
    flattenedAssignments.set(nodeId, community ?? 0);
  });

  return finalizeLouvainClusters(flattenedAssignments, baseState.adjacency, baseState.nodeIds.length, graph);
}

export function createLouvainState(nodeIds, links) {
  const adjacency = new Map();
  const degrees = new Map();
  const edges = [];

  nodeIds.forEach(id => {
    if (!adjacency.has(id)) adjacency.set(id, new Map());
    if (!degrees.has(id)) degrees.set(id, 0);
  });

  let totalWeight = 0;

  links.forEach(({ source, target, weight }) => {
    if (source === undefined || target === undefined) return;
    const s = source;
    const t = target;
    const w = Number.isFinite(weight) ? weight : 1;

    if (!adjacency.has(s)) adjacency.set(s, new Map());
    if (!adjacency.has(t)) adjacency.set(t, new Map());
    if (!degrees.has(s)) degrees.set(s, 0);
    if (!degrees.has(t)) degrees.set(t, 0);

    if (s === t) {
      const current = adjacency.get(s).get(t) || 0;
      adjacency.get(s).set(t, current + w);
      degrees.set(s, (degrees.get(s) || 0) + w * 2);
    } else {
      const mapS = adjacency.get(s);
      const mapT = adjacency.get(t);
      mapS.set(t, (mapS.get(t) || 0) + w);
      mapT.set(s, (mapT.get(s) || 0) + w);
      degrees.set(s, (degrees.get(s) || 0) + w);
      degrees.set(t, (degrees.get(t) || 0) + w);
    }

    edges.push({ source: s, target: t, weight: w });
    totalWeight += w;
  });

  return {
    nodeIds: [...nodeIds],
    adjacency,
    degrees,
    totalWeight,
    links: edges,
  };
}

export function executeLouvainPhase(state, rng = Math.random) {
  const { nodeIds, adjacency, degrees, totalWeight } = state;
  const nodeCommunities = new Map();
  const communityDegree = new Map();

  nodeIds.forEach(id => {
    nodeCommunities.set(id, id);
    const deg = degrees.get(id) || 0;
    communityDegree.set(id, deg);
  });

  let moved = false;
  let improvement = true;
  const order = [...nodeIds];

  while (improvement) {
    improvement = false;
    shuffleArray(order, rng);

    order.forEach(nodeId => {
      const nodeDegree = degrees.get(nodeId) || 0;
      const currentCommunity = nodeCommunities.get(nodeId);

      const neighborWeights = adjacency.get(nodeId) || new Map();
      const neighborCommunities = new Map();

      neighborWeights.forEach((weight, neighborId) => {
        if (neighborId === nodeId) return;
        const neighborCommunity = nodeCommunities.get(neighborId);
        neighborCommunities.set(
          neighborCommunity,
          (neighborCommunities.get(neighborCommunity) || 0) + weight
        );
      });

      const currentCommunityAfterRemoval = (communityDegree.get(currentCommunity) || 0) - nodeDegree;
      communityDegree.set(currentCommunity, currentCommunityAfterRemoval);

      let bestCommunity = currentCommunity;
      let bestGain = neighborCommunities.get(currentCommunity) || 0;
      bestGain -= (currentCommunityAfterRemoval * nodeDegree) / (2 * totalWeight);

      neighborCommunities.forEach((weightToCommunity, communityId) => {
        const sumTot = communityDegree.get(communityId) || 0;
        const gain = weightToCommunity - (sumTot * nodeDegree) / (2 * totalWeight);
        if (gain > bestGain + 1e-9) {
          bestGain = gain;
          bestCommunity = communityId;
        }
      });

      communityDegree.set(bestCommunity, (communityDegree.get(bestCommunity) || 0) + nodeDegree);
      nodeCommunities.set(nodeId, bestCommunity);

      if (bestCommunity !== currentCommunity) {
        moved = true;
        improvement = true;
      }
    });
  }

  const remappedCommunities = new Map();
  let index = 0;
  nodeCommunities.forEach(comm => {
    if (!remappedCommunities.has(comm)) {
      remappedCommunities.set(comm, index++);
    }
  });

  const assignment = new Map();
  nodeCommunities.forEach((comm, nodeId) => {
    assignment.set(nodeId, remappedCommunities.get(comm));
  });

  return { assignment, moved };
}

export function aggregateLouvainGraph(state, assignment) {
  const communityNodes = new Map();
  assignment.forEach((community, nodeId) => {
    if (!communityNodes.has(community)) communityNodes.set(community, []);
    communityNodes.get(community).push(nodeId);
  });

  const newNodeIds = [...communityNodes.keys()];
  const aggregatedWeights = new Map();

  state.links.forEach(({ source, target, weight }) => {
    const sourceCommunity = assignment.get(source);
    const targetCommunity = assignment.get(target);
    if (sourceCommunity === undefined || targetCommunity === undefined) return;

    const key = sourceCommunity <= targetCommunity
      ? `${sourceCommunity}|${targetCommunity}`
      : `${targetCommunity}|${sourceCommunity}`;
    aggregatedWeights.set(key, (aggregatedWeights.get(key) || 0) + weight);
  });

  const newLinks = [];
  aggregatedWeights.forEach((weight, key) => {
    const [a, b] = key.split('|').map(val => (Number.isNaN(Number(val)) ? val : Number(val)));
    newLinks.push({ source: a, target: b, weight });
  });

  return createLouvainState(newNodeIds, newLinks);
}

export function finalizeLouvainClusters(assignments, adjacency, nodeCount, graph) {
  const clusterMembers = new Map();
  assignments.forEach((clusterId, nodeId) => {
    if (!clusterMembers.has(clusterId)) clusterMembers.set(clusterId, []);
    clusterMembers.get(clusterId).push(nodeId);
  });

  const minSize = computeAdaptiveClusterThreshold(nodeCount);
  console.log(`Community filtering: min cluster size = ${minSize} for ${nodeCount} nodes`);

  const noiseNodes = new Set();
  const validClusters = [];
  const filteredClusters = [];

  clusterMembers.forEach((members, clusterId) => {
    const hasInternalEdges = clusterHasInternalEdges(members, adjacency);
    const tooSmall = members.length < minSize;
    const isSingleton = members.length <= 1;

    if (isSingleton || tooSmall || !hasInternalEdges) {
      members.forEach(nodeId => noiseNodes.add(nodeId));
      filteredClusters.push({
        id: clusterId,
        size: members.length,
        reason: isSingleton ? 'singleton' : (tooSmall ? 'too small' : 'no internal edges'),
      });
      return;
    }
    validClusters.push({ id: clusterId, members });
  });

  if (filteredClusters.length > 0) {
    const summary = {};
    filteredClusters.forEach(c => {
      summary[c.reason] = (summary[c.reason] || 0) + 1;
    });
    console.log(`Filtered ${filteredClusters.length} clusters as noise:`, summary);
  }

  validClusters.sort((a, b) => b.members.length - a.members.length);

  const remap = new Map();
  let nextId = 1;
  validClusters.forEach(cluster => {
    remap.set(cluster.id, nextId++);
  });

  const finalAssignments = new Map();
  assignments.forEach((clusterId, nodeId) => {
    if (noiseNodes.has(nodeId)) {
      finalAssignments.set(nodeId, 0);
    } else {
      finalAssignments.set(nodeId, remap.get(clusterId) || 0);
    }
  });

  const nonNoiseCount = nextId - 1;
  const noiseClusterId = noiseNodes.size > 0 ? 0 : null;

  let modularity = 0;
  if (graph && graph.links && graph.links.length > 0) {
    modularity = calculateModularity(graph, finalAssignments);
  }

  const communitySizes = new Map();
  finalAssignments.forEach((cid) => {
    communitySizes.set(cid, (communitySizes.get(cid) || 0) + 1);
  });
  const sortedSizes = Array.from(communitySizes.entries())
    .filter(([cid]) => cid !== 0)
    .sort((a, b) => b[1] - a[1])
    .map(([cid, size]) => `C${cid}:${size}`);

  console.log(`✓ Community detection complete: ${nonNoiseCount} communities (${sortedSizes.join(', ')}), ${noiseNodes.size} noise nodes, modularity: ${modularity.toFixed(3)}`);

  return {
    communities: finalAssignments,
    count: nonNoiseCount,
    total: noiseClusterId === 0 ? nonNoiseCount + 1 : nonNoiseCount,
    noiseClusterId,
    minClusterSize: minSize,
    modularity,
  };
}

export function computeAdaptiveClusterThreshold(nodeCount) {
  // Lenient thresholds preserve smaller legitimate communities.
  if (nodeCount <= 50) return 2;
  if (nodeCount <= 150) return 3;
  if (nodeCount <= 400) return 3;
  if (nodeCount <= 800) return 4;
  if (nodeCount <= 1500) return 5;
  return Math.max(6, Math.floor(nodeCount * 0.005));
}

export function clusterHasInternalEdges(members, adjacency) {
  if (!members || members.length === 0) return false;
  const memberSet = new Set(members);
  for (const nodeId of members) {
    const neighbors = adjacency.get(nodeId);
    if (!neighbors) continue;
    for (const neighborId of neighbors.keys()) {
      if (neighborId !== nodeId && memberSet.has(neighborId)) {
        return true;
      }
    }
  }
  return false;
}

export function calculateModularity(graph, communityAssignments) {
  if (!graph || !communityAssignments || graph.links.length === 0) {
    return 0;
  }

  let totalWeight = 0;
  const degrees = new Map();

  graph.nodes.forEach(node => degrees.set(node.id, 0));

  graph.links.forEach(link => {
    const sourceId = link.source && link.source.id !== undefined ? link.source.id : link.source;
    const targetId = link.target && link.target.id !== undefined ? link.target.id : link.target;
    const weight = link.weight || 1;

    degrees.set(sourceId, (degrees.get(sourceId) || 0) + weight);
    degrees.set(targetId, (degrees.get(targetId) || 0) + weight);
    totalWeight += weight;
  });

  if (totalWeight === 0) return 0;

  let modularity = 0;

  graph.links.forEach(link => {
    const sourceId = link.source && link.source.id !== undefined ? link.source.id : link.source;
    const targetId = link.target && link.target.id !== undefined ? link.target.id : link.target;
    const weight = link.weight || 1;

    const sourceCommunity = communityAssignments.get(sourceId);
    const targetCommunity = communityAssignments.get(targetId);

    if (sourceCommunity !== undefined && sourceCommunity === targetCommunity) {
      const ki = degrees.get(sourceId) || 0;
      const kj = degrees.get(targetId) || 0;
      const expectedEdges = (ki * kj) / (2 * totalWeight);
      modularity += weight - expectedEdges;
    }
  });

  return modularity / (2 * totalWeight);
}
