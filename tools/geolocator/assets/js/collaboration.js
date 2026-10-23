(function() {
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
  const MAX_MESSAGE = 20 * 1024 * 1024;
  const CHUNK_SIZE = 12000;
  const POLL_INTERVAL = 700;
  const KINDS = ['images', 'drawings', 'mapDrawings', 'notes', 'imageOrder'];
  const $ = (id) => document.getElementById(id);
  const dialog = $('collabDialog');
  const status = $('collabStatus');
  let role = null;
  let peer = null;
  let channel = null;
  let localDescription = null;
  let remoteDescription = null;
  let localConfirmed = false;
  let remoteConfirmed = false;
  let ready = false;
  let sendingSnapshot = false;
  let pollTimer = null;
  let sendQueue = Promise.resolve();
  let receiveQueue = Promise.resolve();
  let incoming = null;
  let known = new Map();
  let revisions = new Map();
  let pending = new Map();

  function setStatus(message) {
    status.textContent = message;
  }

  function key(kind, id) {
    return `${kind}:${id}`;
  }

  function itemHash(kind, item) {
    if (kind === 'images') return JSON.stringify({ ...item, order: undefined, src: item.src.length });
    return JSON.stringify(item);
  }

  function projectItems(project) {
    const items = new Map();
    KINDS.filter((kind) => kind !== 'imageOrder').forEach((kind) => project[kind].forEach((item) => items.set(key(kind, item.id), { kind, id: item.id, data: item, hash: itemHash(kind, item) })));
    const imageOrder = { id: 'all', list: project.images.map((item) => item.id) };
    items.set(key('imageOrder', 'all'), { kind: 'imageOrder', id: 'all', data: imageOrder, hash: itemHash('imageOrder', imageOrder) });
    return items;
  }

  function readItem(kind, id) {
    return projectItems(GeolocatorProject.build()).get(key(kind, id)) || null;
  }

  function transferData(kind, data, existing) {
    return kind === 'images' && data && existing ? { ...data, src: null } : data;
  }

  function resetState() {
    if (pollTimer) clearInterval(pollTimer);
    if (peer) peer.close();
    role = null;
    peer = null;
    channel = null;
    localDescription = null;
    remoteDescription = null;
    localConfirmed = false;
    remoteConfirmed = false;
    ready = false;
    sendingSnapshot = false;
    pollTimer = null;
    sendQueue = Promise.resolve();
    receiveQueue = Promise.resolve();
    incoming = null;
    known = new Map();
    revisions = new Map();
    pending = new Map();
    $('collabHostFlow').hidden = true;
    $('collabJoinFlow').hidden = true;
    $('collabVerify').hidden = true;
    $('collabDisconnect').hidden = true;
    $('collabHost').disabled = false;
    $('collabJoin').disabled = false;
    ['collabOfferOut', 'collabOfferIn', 'collabAnswerOut', 'collabAnswerIn'].forEach((id) => { $(id).value = ''; });
    $('collabConfirm').disabled = false;
    setStatus('Choose how to start.');
  }

  function encodeCode(description) {
    return btoa(JSON.stringify({ type: description.type, sdp: description.sdp }));
  }

  function decodeCode(code, expected) {
    if (code.length > 128000) throw new Error('The connection code is too large.');
    const value = JSON.parse(atob(code.trim()));
    if (!value || value.type !== expected || typeof value.sdp !== 'string' || value.sdp.length > 100000 || !value.sdp.startsWith('v=0')) {
      throw new Error('The connection code is invalid.');
    }
    return value;
  }

  async function waitForIce(connection) {
    if (connection.iceGatheringState === 'complete') return;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        connection.removeEventListener('icegatheringstatechange', check);
        if (connection.localDescription?.sdp.includes('a=candidate:')) resolve();
        else reject(new Error('Network discovery timed out. Try again.'));
      }, 15000);
      function check() {
        if (connection.iceGatheringState !== 'complete') return;
        clearTimeout(timeout);
        connection.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
      connection.addEventListener('icegatheringstatechange', check);
      check();
    });
  }

  async function showVerification() {
    if (!crypto.subtle) throw new Error('Verification requires HTTPS or localhost.');
    const offer = role === 'host' ? localDescription : remoteDescription;
    const answer = role === 'host' ? remoteDescription : localDescription;
    const bytes = new TextEncoder().encode(JSON.stringify({ offer: offer.sdp, answer: answer.sdp }));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const code = Array.from(digest.slice(0, 5), (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
    $('collabVerifyCode').textContent = `${code.slice(0, 5)} ${code.slice(5)}`;
    $('collabVerify').hidden = false;
    setStatus('Compare the verification number through a trusted second channel.');
  }

  function connectPeer() {
    const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    connection.addEventListener('connectionstatechange', () => {
      if (connection.connectionState === 'failed') setStatus('Direct connection failed on this network. End the session and exchange a saved project file instead.');
      if (connection.connectionState === 'disconnected' || connection.connectionState === 'closed') {
        if (ready) {
          ready = false;
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = null;
          setStatus('Session disconnected. Save your project file to preserve your work.');
        }
      }
    });
    return connection;
  }

  function setupChannel(dataChannel) {
    channel = dataChannel;
    channel.addEventListener('open', () => {
      if (localConfirmed) enqueue({ type: 'confirmed' });
      if (!localConfirmed) setStatus('Connected. Compare the verification number before sharing.');
    });
    channel.addEventListener('close', () => {
      if (ready) {
        ready = false;
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        setStatus('Session ended. Save your project file to preserve your work.');
      }
    });
    channel.addEventListener('message', (event) => {
      receiveQueue = receiveQueue.then(() => receivePacket(event.data)).catch((error) => {
        console.error('Collaboration receive failed:', error);
        setStatus(`Shared edit failed: ${error.message}. End this session and save your project.`);
        ready = false;
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
      });
    });
  }

  function enqueue(message) {
    sendQueue = sendQueue.then(() => sendMessage(message)).then(() => true).catch((error) => {
      console.error('Collaboration send failed:', error);
      setStatus(`Could not send an edit: ${error.message}. Save your project and reconnect.`);
      ready = false;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      return false;
    });
    return sendQueue;
  }

  async function waitForBuffer() {
    if (channel.bufferedAmount < 1024 * 1024) return;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        channel.removeEventListener('bufferedamountlow', drain);
        reject(new Error('Transfer stalled.'));
      }, 30000);
      function drain() {
        if (channel.bufferedAmount >= 1024 * 1024) return;
        clearTimeout(timeout);
        channel.removeEventListener('bufferedamountlow', drain);
        resolve();
      }
      channel.bufferedAmountLowThreshold = 512 * 1024;
      channel.addEventListener('bufferedamountlow', drain);
      drain();
    });
  }

  async function sendMessage(message) {
    if (!channel || channel.readyState !== 'open') throw new Error('Connection is not open.');
    const payload = JSON.stringify(message);
    if (payload.length > MAX_MESSAGE) throw new Error('Project or edit is over the 20 MB live-session limit.');
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const total = Math.max(1, Math.ceil(payload.length / CHUNK_SIZE));
    for (let index = 0; index < total; index++) {
      await waitForBuffer();
      channel.send(JSON.stringify({ id, index, total, part: payload.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE) }));
    }
  }

  async function receivePacket(raw) {
    if (typeof raw !== 'string' || raw.length > CHUNK_SIZE * 2 + 400) throw new Error('Invalid transfer packet.');
    const packet = JSON.parse(raw);
    if (!packet || typeof packet.id !== 'string' || packet.id.length > 100 || !Number.isSafeInteger(packet.index) || !Number.isSafeInteger(packet.total) || packet.total < 1 || packet.total > Math.ceil(MAX_MESSAGE / CHUNK_SIZE) || typeof packet.part !== 'string' || packet.part.length > CHUNK_SIZE) {
      throw new Error('Invalid transfer packet.');
    }
    if (!incoming) incoming = { id: packet.id, total: packet.total, next: 0, parts: [], size: 0 };
    if (packet.id !== incoming.id || packet.total !== incoming.total || packet.index !== incoming.next) throw new Error('Transfer packets arrived out of order.');
    incoming.parts.push(packet.part);
    incoming.size += packet.part.length;
    incoming.next++;
    if (incoming.size > MAX_MESSAGE) throw new Error('Incoming project exceeds the live-session limit.');
    if (incoming.next !== incoming.total) return;
    const message = JSON.parse(incoming.parts.join(''));
    incoming = null;
    await handleMessage(message);
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (ready && !sendingSnapshot) {
        try {
          scanLocal();
        } catch (error) {
          console.error('Collaboration scan failed:', error);
          ready = false;
          clearInterval(pollTimer);
          pollTimer = null;
          setStatus(`Could not read project changes: ${error.message}. Save your project file.`);
        }
      }
    }, POLL_INTERVAL);
  }

  function scanLocal() {
    const current = projectItems(GeolocatorProject.build());
    const imageSetChanged = [...new Set([...known.keys(), ...current.keys()])].some((entryKey) => entryKey.startsWith('images:') && known.has(entryKey) !== current.has(entryKey));
    const keys = new Set([...known.keys(), ...current.keys()]);
    keys.forEach((entryKey) => {
      const item = current.get(entryKey);
      const hash = item ? item.hash : null;
      if (known.get(entryKey) === hash) return;
      const old = known.get(entryKey);
      known.set(entryKey, hash);
      if (entryKey === 'imageOrder:all' && imageSetChanged) return;
      if (old == null && hash == null) return;
      const [kind, id] = entryKey.split(':');
      const data = item ? item.data : null;
      if (role === 'host') {
        const rev = (revisions.get(entryKey) || 0) + 1;
        revisions.set(entryKey, rev);
        enqueue({ type: 'commit', kind, id, data: transferData(kind, data, old != null), rev, actor: 'host' });
      } else if (!pending.has(entryKey)) {
        pending.set(entryKey, { kind, id, data, hash });
        enqueue({ type: 'op', kind, id, data: transferData(kind, data, old != null), base: revisions.get(entryKey) || 0 });
      }
    });
  }

  async function acceptOp(message) {
    if (role !== 'host' || !ready) return;
    scanLocal();
    if (!KINDS.includes(message.kind) || typeof message.id !== 'string' || message.id.length > 100 || !Number.isSafeInteger(message.base)) throw new Error('Invalid shared edit.');
    const entryKey = key(message.kind, message.id);
    const currentRev = revisions.get(entryKey) || 0;
    if (message.base !== currentRev) {
      const current = readItem(message.kind, message.id);
      enqueue({ type: 'reject', kind: message.kind, id: message.id, data: current ? current.data : null, rev: currentRev });
      return;
    }
    const existed = readItem(message.kind, message.id);
    await GeolocatorProject.applyEntity(message.kind, message.id, message.data, message.kind === 'images');
    drawingRouter.undoStack = [];
    drawingRouter.redoStack = [];
    const rev = currentRev + 1;
    revisions.set(entryKey, rev);
    const applied = readItem(message.kind, message.id);
    known.set(entryKey, applied ? applied.hash : null);
    if (message.kind === 'images') {
      const order = readItem('imageOrder', 'all');
      known.set('imageOrder:all', order.hash);
    }
    enqueue({ type: 'commit', kind: message.kind, id: message.id, data: transferData(message.kind, applied ? applied.data : null, Boolean(existed)), rev, actor: 'guest' });
    scanLocal();
  }

  async function acceptCommit(message) {
    if (role !== 'guest' || !ready || !KINDS.includes(message.kind) || typeof message.id !== 'string' || !Number.isSafeInteger(message.rev)) return;
    const entryKey = key(message.kind, message.id);
    const previousRev = revisions.get(entryKey) || 0;
    if (message.rev <= previousRev) return;
    const localBefore = readItem(message.kind, message.id);
    if (message.kind === 'images' && message.data && message.data.src == null && localBefore) message.data = { ...message.data, src: localBefore.data.src };
    if (!pending.has(entryKey) && message.actor === 'host' && (localBefore ? localBefore.hash : null) !== (known.get(entryKey) || null)) {
      known.set(entryKey, localBefore ? localBefore.hash : null);
      pending.set(entryKey, { kind: message.kind, id: message.id, data: localBefore ? localBefore.data : null, hash: localBefore ? localBefore.hash : null });
      enqueue({ type: 'op', kind: message.kind, id: message.id, data: localBefore ? localBefore.data : null, base: previousRev });
    }
    revisions.set(entryKey, message.rev);
    if (pending.has(entryKey) && message.actor === 'guest') {
      const sent = pending.get(entryKey);
      pending.delete(entryKey);
      const local = readItem(message.kind, message.id);
      const confirmedHash = message.data ? itemHash(message.kind, message.data) : null;
      known.set(entryKey, confirmedHash);
      if ((local ? local.hash : null) === sent.hash && ((local ? local.hash : null) !== confirmedHash || (message.kind === 'images' && local && local.data.order !== message.data.order))) {
        await GeolocatorProject.applyEntity(message.kind, message.id, message.data);
        drawingRouter.undoStack = [];
        drawingRouter.redoStack = [];
        const applied = readItem(message.kind, message.id);
        known.set(entryKey, applied ? applied.hash : null);
      }
      if (message.kind === 'images') known.set('imageOrder:all', readItem('imageOrder', 'all').hash);
      return;
    }
    if (pending.has(entryKey)) return;
    await GeolocatorProject.applyEntity(message.kind, message.id, message.data);
    drawingRouter.undoStack = [];
    drawingRouter.redoStack = [];
    const applied = readItem(message.kind, message.id);
    known.set(entryKey, applied ? applied.hash : null);
    if (message.kind === 'images') known.set('imageOrder:all', readItem('imageOrder', 'all').hash);
  }

  async function acceptReject(message) {
    if (role !== 'guest' || !KINDS.includes(message.kind) || typeof message.id !== 'string' || !Number.isSafeInteger(message.rev)) return;
    const entryKey = key(message.kind, message.id);
    if (!pending.has(entryKey)) return;
    pending.delete(entryKey);
    revisions.set(entryKey, message.rev);
    const keep = window.confirm('Both people edited the same item. Keep your edit? Cancel to use the other person\'s edit.');
    if (keep) {
      const local = readItem(message.kind, message.id);
      pending.set(entryKey, { kind: message.kind, id: message.id, data: local ? local.data : null, hash: local ? local.hash : null });
      enqueue({ type: 'op', kind: message.kind, id: message.id, data: transferData(message.kind, local ? local.data : null, Boolean(message.data)), base: message.rev });
    } else {
      await GeolocatorProject.applyEntity(message.kind, message.id, message.data);
      drawingRouter.undoStack = [];
      drawingRouter.redoStack = [];
      const applied = readItem(message.kind, message.id);
      known.set(entryKey, applied ? applied.hash : null);
      if (message.kind === 'images') known.set('imageOrder:all', readItem('imageOrder', 'all').hash);
    }
  }

  async function handleMessage(message) {
    if (!message || typeof message.type !== 'string') throw new Error('Invalid shared message.');
    if (message.type === 'confirmed') {
      remoteConfirmed = true;
      if (localConfirmed && role === 'host' && !ready && !sendingSnapshot) await shareSnapshot();
      return;
    }
    if (!localConfirmed || !remoteConfirmed) throw new Error('Project data arrived before verification.');
    if (message.type === 'snapshot' && role === 'guest' && !ready) {
      GeolocatorProject.validate(message.project);
      const existing = GeolocatorProject.build();
      if (existing.images.length || existing.drawings.length || existing.mapDrawings.length || existing.notes.length) downloadProject(true);
      await GeolocatorProject.apply(message.project);
      const items = projectItems(GeolocatorProject.build());
      known = new Map([...items].map(([entryKey, item]) => [entryKey, item.hash]));
      revisions = new Map([...items].map(([entryKey]) => [entryKey, 0]));
      ready = true;
      startPolling();
      enqueue({ type: 'snapshotAck' });
      setStatus('Live session active. Both people can edit. Save a project file when finished.');
      $('collabDisconnect').hidden = false;
      return;
    }
    if (message.type === 'snapshotAck' && role === 'host') {
      ready = true;
      sendingSnapshot = false;
      startPolling();
      setStatus('Live session active. Both people can edit. Save a project file when finished.');
      $('collabDisconnect').hidden = false;
      return;
    }
    if (message.type === 'op') await acceptOp(message);
    if (message.type === 'commit') await acceptCommit(message);
    if (message.type === 'reject') await acceptReject(message);
  }

  async function shareSnapshot() {
    sendingSnapshot = true;
    const project = GeolocatorProject.build();
    const items = projectItems(project);
    known = new Map([...items].map(([entryKey, item]) => [entryKey, item.hash]));
    revisions = new Map([...items].map(([entryKey]) => [entryKey, 0]));
    setStatus('Sending project to the other person…');
    if (await enqueue({ type: 'snapshot', project })) setStatus('Project sent. Waiting for the other person to load it…');
  }

  async function startHost() {
    resetState();
    role = 'host';
    $('collabHost').disabled = true;
    $('collabJoin').disabled = true;
    $('collabHostFlow').hidden = false;
    setStatus('Finding direct connection paths…');
    try {
      if (JSON.stringify({ type: 'snapshot', project: GeolocatorProject.build() }).length > MAX_MESSAGE) throw new Error('This project exceeds the 20 MB live-session limit. Share a saved project file instead.');
      peer = connectPeer();
      setupChannel(peer.createDataChannel('geolocator-project', { ordered: true }));
      await peer.setLocalDescription(await peer.createOffer());
      await waitForIce(peer);
      localDescription = peer.localDescription;
      $('collabOfferOut').value = encodeCode(localDescription);
      setStatus('Invite ready. Send it to the other person.');
    } catch (error) {
      resetState();
      setStatus(error.message);
    }
  }

  async function joinOffer() {
    try {
      role = 'guest';
      $('collabHost').disabled = true;
      $('collabJoin').disabled = true;
      remoteDescription = decodeCode($('collabOfferIn').value, 'offer');
      peer = connectPeer();
      peer.addEventListener('datachannel', (event) => setupChannel(event.channel));
      await peer.setRemoteDescription(remoteDescription);
      await peer.setLocalDescription(await peer.createAnswer());
      await waitForIce(peer);
      localDescription = peer.localDescription;
      $('collabAnswerOut').value = encodeCode(localDescription);
      await showVerification();
      setStatus('Reply ready. Send it back, then compare the verification number.');
    } catch (error) {
      resetState();
      $('collabJoinFlow').hidden = false;
      setStatus(error.message);
    }
  }

  async function hostAnswer() {
    try {
      remoteDescription = decodeCode($('collabAnswerIn').value, 'answer');
      await peer.setRemoteDescription(remoteDescription);
      await showVerification();
    } catch (error) {
      setStatus(error.message);
    }
  }

  function confirmVerification() {
    if (!channel || !localDescription || !remoteDescription) return;
    localConfirmed = true;
    $('collabConfirm').disabled = true;
    setStatus('Verification confirmed. Waiting for the other person.');
    if (channel.readyState === 'open') enqueue({ type: 'confirmed' });
    if (remoteConfirmed && role === 'host' && !sendingSnapshot) shareSnapshot();
  }

  async function copyCode(id) {
    try {
      await navigator.clipboard.writeText($(id).value);
      setStatus('Code copied.');
    } catch (error) {
      setStatus('Copy failed. Select and copy the code manually.');
    }
  }

  $('collabHost').addEventListener('click', startHost);
  $('collabJoin').addEventListener('click', () => {
    resetState();
    $('collabJoinFlow').hidden = false;
    setStatus('Paste the invite code you received.');
  });
  $('collabAcceptOffer').addEventListener('click', joinOffer);
  $('collabAcceptAnswer').addEventListener('click', hostAnswer);
  $('collabConfirm').addEventListener('click', confirmVerification);
  $('collabCopyOffer').addEventListener('click', () => copyCode('collabOfferOut'));
  $('collabCopyAnswer').addEventListener('click', () => copyCode('collabAnswerOut'));
  $('collabDisconnect').addEventListener('click', resetState);
  $('collabClose').addEventListener('click', () => dialog.close());
  window.openCollaboration = () => dialog.showModal();
  window.GeolocatorCollaboration = { active: () => ready };
})();
