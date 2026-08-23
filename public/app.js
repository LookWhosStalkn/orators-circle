/* ═════════════ The Orator's Circle — client ═════════════ */

const LK = window.LivekitClient;
const $ = (s) => document.querySelector(s);
const ROLE_LABEL = { host: 'HOST', participant: 'SPEAKER', audience: 'AUDIENCE' };

/* ── state ── */
const state = {
  room: null,
  roomName: '',
  identity: '',
  name: '',
  role: 'participant',
  url: '',
  token: '',
  connected: false,
  participants: new Map(), // identity -> { p, hand }
  pinned: null, // identity on the floor
  queue: [], // [{identity, name, ts}]
  hand: false,
  timer: { state: 'stopped', dur: 180, remaining: 180, at: 0, label: '' },
  rec: { on: false, since: 0 },
  kicked: false,
  ended: false,
  adminPass: sessionStorage.getItem('oc_pass') || '',
};

/* ── DOM refs ── */
const els = {
  join: $('#join'), room: $('#room'),
  joinForm: $('#join-form'), fName: $('#f-name'), fRoom: $('#f-room'),
  passWrap: $('#pass-wrap'), fPass: $('#f-pass'), joinError: $('#join-error'),
  roleBtns: [...document.querySelectorAll('.role-btn')],
  roomName: $('#room-name'), connDot: $('#conn-dot'), connTxt: $('#conn-txt'), pcount: $('#pcount'),
  grid: $('#grid'), sidebar: $('#sidebar'),
  recBadge: $('#rec-badge'), recTime: $('#rec-time'),
  timerWrap: $('#timer-wrap'), timer: $('#timer'), timerLabel: $('#timer-label'),
  tabs: [...document.querySelectorAll('.tab')], qcount: $('#qcount'),
  tabChat: $('#tab-chat'), tabFloor: $('#tab-floor'), tabPeople: $('#tab-people'),
  chatList: $('#chat-list'), chatInput: $('#chat-input'), chatSend: $('#chat-send'),
  queueList: $('#queue-list'), queueHint: $('#queue-hint'), queueTools: $('#queue-tools'),
  peopleList: $('#people-list'), roomTools: $('#room-tools'),
  btnMic: $('#btn-mic'), btnCam: $('#btn-cam'), btnScreen: $('#btn-screen'), btnHand: $('#btn-hand'),
  btnTimer: $('#btn-timer'), btnRec: $('#btn-rec'), timerPop: $('#timer-pop'),
  timerChips: [...document.querySelectorAll('#timer-chips button')], timerCustom: $('#timer-custom'),
  timerSet: $('#timer-set'), timerStart: $('#timer-start'), timerPause: $('#timer-pause'), timerReset: $('#timer-reset'),
  btnCopy: $('#btn-copy'), btnPanel: $('#btn-panel'), btnLeave: $('#btn-leave'),
  toasts: $('#toasts'),
  aPass: $('#a-pass'), aLogin: $('#a-login'), aRooms: $('#a-rooms'),
};

/* ── api helper ── */
async function api(path, method = 'GET', body, admin = false) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  if (admin) opts.headers['x-admin-password'] = state.adminPass || els.aPass.value || '';
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ── toasts ── */
function toast(msg, type = 'info', ms = 4200) {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  els.toasts.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ═══════════ JOIN FLOW ═══════════ */

els.roleBtns.forEach((b) => b.addEventListener('click', () => {
  els.roleBtns.forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  els.passWrap.classList.toggle('hidden', b.dataset.role !== 'host');
}));

function showJoinError(msg) { els.joinError.textContent = msg; els.joinError.classList.remove('hidden'); }
function clearJoinError() { els.joinError.classList.add('hidden'); }

els.joinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearJoinError();
  const role = els.roleBtns.find((b) => b.classList.contains('active'))?.dataset.role || 'participant';
  const name = els.fName.value.trim();
  const room = els.fRoom.value.trim();
  if (!name) return showJoinError('Enter a display name.');
  if (!/^[A-Za-z0-9_-]{2,48}$/.test(room)) return showJoinError('Room code: 2–48 chars, letters/digits/-/_.');
  if (role === 'host' && !els.fPass.value.trim()) return showJoinError('Host passcode required to host.');

  els.joinBtn.disabled = true; els.joinBtn.textContent = 'Connecting…';
  try {
    const data = await api('/api/token', 'POST', { room, name, role, passcode: els.fPass.value.trim() });
    if (els.fPass.value.trim()) {
      state.adminPass = els.fPass.value.trim();
      sessionStorage.setItem('oc_pass', state.adminPass);
    }
    await enterRoom(data);
  } catch (err) {
    showJoinError(err.message);
  } finally {
    els.joinBtn.disabled = false; els.joinBtn.textContent = 'Enter the chamber';
  }
});

async function enterRoom(data) {
  state.roomName = data.room;
  state.identity = data.identity;
  state.name = data.name;
  state.role = data.role;
  state.url = data.url;
  state.token = data.token;
  els.roomName.textContent = data.room;
  els.join.classList.add('hidden');
  els.room.classList.remove('hidden');
  if (state.role === 'host') {
    document.body.classList.add('is-host');
    els.btnTimer.classList.remove('hidden'); els.btnRec.classList.remove('hidden');
  } else {
    els.btnHand.classList.remove('hidden');
  }
  if (state.role === 'audience') {
    els.btnMic.disabled = true; els.btnCam.disabled = true; els.btnScreen.disabled = true;
  }
  await connect();
}

/* ═══════════ LIVEKIT ═══════════ */

async function connect() {
  const room = new LK.Room({ adaptiveStream: true, dynacast: true });
  state.room = room;
  wireRoom(room);
  try {
    await room.connect(state.url, state.token);
    state.connected = true;
    setConn('connected', 'ok');
    addParticipant(room.localParticipant);
    if (state.role !== 'audience') {
      try { await room.localParticipant.setCameraEnabled(true); } catch {}
      try { await room.localParticipant.setMicrophoneEnabled(true); } catch {}
    }
    sendData({ t: 'hello', role: state.role, name: state.name });
    sendData({ t: 'timer_sync' });
    sendData({ t: 'rec_sync' });
    loadChatHistory();
    toast(state.role === 'host' ? `You are hosting "${state.roomName}". Share the invite link!` : `Welcome to ${state.roomName} — debate on!`, 'good');
  } catch (err) {
    setConn('connection failed', 'bad');
    toast('Could not connect: ' + err.message, 'bad');
  }
}

function setConn(txt, cls) { els.connTxt.textContent = txt; els.connDot.className = `dot ${cls}`; }

function wireRoom(room) {
  const E = LK.RoomEvent;

  room.on(E.TrackSubscribed, (track, pub, participant) => attachTrack(track, participant, pub.source === LK.Track.Source.ScreenShare));
  room.on(E.TrackUnsubscribed, (track, pub, participant) => detachTrack(track, participant, pub.source === LK.Track.Source.ScreenShare));
  room.on(E.TrackMuted, (pub, participant) => trackMutedUI(pub, participant));
  room.on(E.TrackUnmuted, (pub, participant) => trackMutedUI(pub, participant));

  room.on(E.ParticipantConnected, (p) => { addParticipant(p); updatePeople(); });
  room.on(E.ParticipantDisconnected, (p) => { removeParticipant(p); });

  room.on(E.ActiveSpeakersChanged, (speakers) => {
    const set = new Set(speakers.map((s) => s.identity));
    for (const [id, entry] of state.participants) {
      entry.el.classList.toggle('speaking', set.has(id));
    }
  });

  room.on(E.DataReceived, (payload, participant) => {
    try { handleData(JSON.parse(new TextDecoder().decode(payload)), participant); } catch {}
  });

  room.on(E.ParticipantMetadataChanged, (p) => { updatePeople(); });
  room.on(E.ParticipantPermissionsChanged, (p) => {
    if (p.identity === state.identity) {
      const canPub = p.permission?.canPublish ?? false;
      state.role = canPub ? 'participant' : 'audience';
      els.btnMic.disabled = !canPub; els.btnCam.disabled = !canPub; els.btnScreen.disabled = !canPub;
      if (!canPub) toast('The host set you to Audience — you can watch and chat, not publish.', 'info');
      else toast('The host restored your speaking permissions.', 'good');
    }
    updatePeople();
  });

  room.on(E.Disconnected, (reason) => {
    state.connected = false;
    setConn('disconnected', 'bad');
    const why = state.kicked ? 'You were removed by the host.' : state.ended ? 'The room was ended by the host.' : 'You left the room.';
    resetToLobby(why);
  });

  const lp = room.localParticipant;
  lp.on(LK.LocalParticipantEvent.TrackPublished, (pub) => {
    if (pub.track) attachTrack(pub.track, lp, pub.source === LK.Track.Source.ScreenShare);
    updateControlState();
  });
  lp.on(LK.LocalParticipantEvent.TrackUnpublished, (pub) => {
    detachTrack(pub.track, lp, pub.source === LK.Track.Source.ScreenShare);
    updateControlState();
  });
  lp.on(LK.LocalParticipantEvent.TrackMuted, () => updateControlState());
  lp.on(LK.LocalParticipantEvent.TrackUnmuted, () => updateControlState());
}

/* ── tiles ── */

function addParticipant(p) {
  if (state.participants.has(p.identity)) return;
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.id = p.identity;
  tile.innerHTML = `
    <div class="no-video">🎭</div>
    <video class="video-main" autoplay playsinline></video>
    <video class="video-screen" autoplay playsinline></video>
    <div class="screen-banner">Presenting screen</div>
    <div class="hand-badge">✋</div>
    <div class="floor-ribbon">On the floor</div>
    <div class="tile-info">
      <span class="tile-role"></span>
      <span class="tile-name"></span>
      <span class="tile-state"></span>
    </div>`;
  els.grid.appendChild(tile);
  state.participants.set(p.identity, { p, el: tile, hand: false, role: p.identity === state.identity ? state.role : null });

  // attach already-published tracks (local + late remote)
  p.videoTracks.forEach((pub) => { if (pub.track) attachTrack(pub.track, p, false); });
  p.screenShareTracks.forEach((pub) => { if (pub.track) attachTrack(pub.track, p, true); });
  updateTile(p);
  updatePeople();
  updateCount();
}

function updateTile(p) {
  const entry = state.participants.get(p.identity);
  if (!entry) return;
  const el = entry.el;
  el.querySelector('.tile-name').textContent = p.name || p.identity;
  const role = entry.role;
  if (role) {
    const chip = el.querySelector('.tile-role');
    chip.textContent = ROLE_LABEL[role] || role;
    chip.className = `tile-role ${role}`;
  }
  // mic/cam state
  const micOff = [...p.audioTracks.values()].some((pub) => pub.isMuted) && p.audioTracks.size > 0;
  const camOff = [...p.videoTracks.values()].every((pub) => pub.isMuted) && p.videoTracks.size > 0;
  const hasCam = p.videoTracks.size > 0;
  el.classList.toggle('cam-off', hasCam && camOff);
  el.querySelector('.no-video').style.display = hasCam && !camOff ? 'none' : 'flex';
  const st = el.querySelector('.tile-state');
  st.innerHTML = '';
  if (micOff) st.innerHTML = '<span class="off" title="muted">🔇</span>';
  else if (p.audioTracks.size) st.innerHTML = '<span title="live audio">🎙️</span>';
  if (entry.hand) el.classList.add('hand-up'); else el.classList.remove('hand-up');
  const pinned = state.pinned === p.identity;
  el.classList.toggle('pinned', pinned);
  updateCount();
}

function attachTrack(track, participant, isScreen) {
  const entry = state.participants.get(participant.identity);
  if (!entry) return;
  const el = entry.el;
  const sel = isScreen ? '.video-screen' : '.video-main';
  try {
    const media = track.attach(el.querySelector(sel));
    media.play().catch(() => {});
  } catch {}
  if (isScreen) el.classList.add('showing-screen');
  if (track.kind === 'audio') LocalRecorder.connectTrack(track);
  updateTile(participant);
}

function detachTrack(track, participant, isScreen) {
  const entry = state.participants.get(participant.identity);
  if (!entry) return;
  const el = entry.el;
  if (isScreen) {
    const v = el.querySelector('.video-screen');
    v.srcObject = null; v.removeAttribute('src');
    el.classList.remove('showing-screen');
  } else {
    const v = el.querySelector('.video-main');
    v.srcObject = null; v.removeAttribute('src');
  }
  if (track.kind === 'audio') LocalRecorder.disconnectTrack(track);
  updateTile(participant);
}

function trackMutedUI(pub, participant) { updateTile(participant); }

function removeParticipant(p) {
  for (const pub of p.audioTracks.values()) if (pub.track) LocalRecorder.disconnectTrack(pub.track);
  const entry = state.participants.get(p.identity);
  if (entry) entry.el.remove();
  state.participants.delete(p.identity);
  state.queue = state.queue.filter((q) => q.identity !== p.identity);
  if (state.pinned === p.identity) { state.pinned = null; toast(`${p.name || 'A participant'} left — floor cleared.`, 'info'); }
  renderQueue();
  updatePeople();
  updateCount();
}

function updateCount() { els.pcount.textContent = state.participants.size; }

/* ── data channel ── */

function sendData(obj) {
  if (!state.room || !state.connected) return;
  try { state.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(obj)), { reliable: true }); } catch {}
}

function handleData(m, from) {
  if (m.t === 'hello' && from) {
    const entry = state.participants.get(from.identity);
    if (entry) entry.role = m.role;
    updateTile(from); updatePeople();
    return;
  }
  if (m.t === 'chat') {
    appendChat(m.name, m.text, m.ts || Date.now(), false);
    return;
  }
  if (m.t === 'hand') {
    const entry = state.participants.get(m.identity);
    if (entry) { entry.hand = !!m.on; updateTile(entry.p); renderQueue(); }
    if (state.role === 'host' && m.on) toast(`${m.name} raised a hand ✋`, 'info');
    return;
  }
  if (m.t === 'hand_off') {
    if (m.identity === state.identity) { state.hand = false; updateHandBtn(); }
    const entry = state.participants.get(m.identity);
    if (entry) { entry.hand = false; updateTile(entry.p); }
    renderQueue();
    return;
  }
  if (m.t === 'floor') {
    state.pinned = m.identity || null;
    for (const [, e] of state.participants) updateTile(e.p);
    if (m.identity === state.identity) toast('You have the floor! 🎙️', 'good');
    else if (m.name) toast(`${m.name} now has the floor.`, 'info');
    renderQueue();
    return;
  }
  if (m.t === 'floor_clear') {
    state.pinned = null;
    for (const [, e] of state.participants) updateTile(e.p);
    return;
  }
  if (m.t === 'timer') { applyTimer(m); return; }
  if (m.t === 'rec') { setRec(m.on, m.since || Date.now()); return; }
  if (m.t === 'timer_sync' && state.role === 'host') { sendTimer(state.timer.state, true); return; }
  if (m.t === 'rec_sync' && state.role === 'host' && state.rec.on) { sendData({ t: 'rec', on: true, since: state.rec.since }); return; }
  if (m.t === 'toast') { toast(m.m, 'info'); return; }
  if (m.t === 'muted_all') { toast('Host muted all microphones 🔇', 'info'); return; }
  if (m.t === 'chat_clear') { els.chatList.innerHTML = ''; return; }
  if (m.t === 'kick' && m.identity === state.identity) { state.kicked = true; return; }
  if (m.t === 'end') { state.ended = true; return; }
}

/* ── chat ── */

async function loadChatHistory() {
  try {
    const { messages } = await api(`/api/rooms/${encodeURIComponent(state.roomName)}/chat`);
    els.chatList.innerHTML = '';
    (messages || []).forEach((m) => appendChat(m.name, m.text, m.ts, m.name === state.name));
    scrollChat();
  } catch {}
}

function appendChat(name, text, ts, self) {
  const div = document.createElement('div');
  div.className = `msg ${self ? 'self' : ''}`;
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = `<div class="m-head"><span class="m-name">${esc(name)}</span><span class="m-time">${time}</span></div><div class="m-text">${esc(text)}</div>`;
  els.chatList.appendChild(div);
  while (els.chatList.children.length > 200) els.chatList.firstChild.remove();
  scrollChat();
}

function scrollChat() { els.chatList.scrollTop = els.chatList.scrollHeight; }

async function sendChat() {
  const text = els.chatInput.value.trim();
  if (!text) return;
  els.chatInput.value = '';
  appendChat(state.name, text, Date.now(), true);
  sendData({ t: 'chat', name: state.name, text, ts: Date.now() });
  try { await api(`/api/rooms/${encodeURIComponent(state.roomName)}/chat`, 'POST', { name: state.name, text }); } catch {}
}

els.chatSend.addEventListener('click', sendChat);
els.chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

/* ── raise hand / floor queue ── */

function toggleHand() {
  state.hand = !state.hand;
  updateHandBtn();
  sendData({ t: 'hand', identity: state.identity, name: state.name, on: state.hand });
  if (state.hand) toast('Hand raised — the host has been notified.', 'info', 2500);
}
function updateHandBtn() {
  els.btnHand.classList.toggle('pulse', state.hand);
  els.btnHand.querySelector('.ctl-label').textContent = state.hand ? 'Down' : 'Hand';
}

function renderQueue() {
  const host = state.role === 'host';
  els.qcount.classList.toggle('hidden', state.queue.length === 0);
  els.qcount.textContent = state.queue.length;
  if (!host && state.queue.length === 0) {
    els.queueList.innerHTML = '<div class="q-empty">No speakers in queue.</div>';
    els.queueHint.textContent = 'Raise your hand to join the speaking queue — the host grants the floor.';
    return;
  }
  els.queueList.innerHTML = '';
  if (!host) els.queueHint.textContent = state.hand ? 'Your hand is raised. Wait for the host to grant the floor.' : 'The host manages the speaking order.';
  state.queue.forEach((q, i) => {
    const item = document.createElement('div');
    item.className = 'q-item';
    item.innerHTML = `<span class="q-num">${i + 1}</span><span class="q-name">${esc(q.name)}</span>`;
    if (host) {
      const g = document.createElement('button'); g.className = 'secondary'; g.textContent = 'Grant';
      g.onclick = () => grantFloor(q.identity, q.name);
      const r = document.createElement('button'); r.className = 'danger'; r.textContent = '✕';
      r.onclick = () => { state.queue = state.queue.filter((x) => x.identity !== q.identity); sendData({ t: 'hand_off', identity: q.identity }); renderQueue(); };
      item.appendChild(g); item.appendChild(r);
    }
    els.queueList.appendChild(item);
  });
  if (host && state.queue.length === 0) els.queueList.innerHTML = '<div class="q-empty">Queue is empty — waiting for raised hands.</div>';
}

function grantFloor(identity, name) {
  state.pinned = identity;
  state.queue = state.queue.filter((q) => q.identity !== identity);
  sendData({ t: 'floor', identity, name });
  sendData({ t: 'hand_off', identity });
  renderQueue();
  for (const [, e] of state.participants) updateTile(e.p);
}

els.btnHand.addEventListener('click', toggleHand);
els.queueTools && (els.queueTools.querySelector('#q-next').onclick = () => { if (state.queue.length) { const q = state.queue[0]; grantFloor(q.identity, q.name); } else toast('Queue is empty.', 'info', 2000); });
els.queueTools && (els.queueTools.querySelector('#q-clear').onclick = () => {
  state.queue.forEach((q) => sendData({ t: 'hand_off', identity: q.identity }));
  state.queue = [];
  renderQueue();
});

/* ── timer ── */

function applyTimer(m) {
  state.timer = { state: m.state, dur: m.dur, remaining: m.remaining, at: m.at, label: m.label || '' };
  els.timerLabel.textContent = state.timer.label;
  renderTimer();
}

function currentRemaining() {
  if (state.timer.state === 'run') return Math.max(0, state.timer.remaining - (Date.now() - state.timer.at) / 1000);
  return state.timer.remaining;
}

function sendTimer(stateName, force = false) {
  if (!force && stateName === state.timer.state && stateName !== 'stop') return;
  const remaining = stateName === 'reset' || stateName === 'run' ? state.timer.dur : currentRemaining();
  const m = { t: 'timer', state: stateName, dur: state.timer.dur, remaining, at: Date.now(), label: state.timer.label };
  applyTimer(m);
  sendData(m);
}

function renderTimer() {
  const t = state.timer;
  if (t.state === 'stop') { els.timerWrap.classList.add('hidden'); return; }
  els.timerWrap.classList.remove('hidden');
  const rem = Math.ceil(currentRemaining());
  const mm = String(Math.floor(rem / 60)).padStart(2, '0');
  const ss = String(rem % 60).padStart(2, '0');
  els.timer.textContent = `${mm}:${ss}`;
  els.timer.className = `timer ${t.state === 'pause' ? 'paused' : rem <= 30 && t.state === 'run' ? 'urgent' : ''}`;
}

setInterval(() => {
  if (state.timer.state === 'run') {
    if (currentRemaining() <= 0) {
      state.timer.state = 'stop';
      renderTimer();
      toast("⏰ Time's up!", 'bad');
    } else renderTimer();
  }
  if (state.rec.on) els.recTime.textContent = fmtElapsed((Date.now() - state.rec.since) / 1000);
}, 250);

const fmtElapsed = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

els.btnTimer.addEventListener('click', () => els.timerPop.classList.toggle('hidden'));
els.timerChips.forEach((b) => b.addEventListener('click', () => {
  els.timerChips.forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  state.timer.dur = Number(b.dataset.s);
  state.timer.remaining = state.timer.dur;
  renderTimer();
}));
els.timerSet.addEventListener('click', () => {
  const v = Math.min(3600, Math.max(5, Number(els.timerCustom.value) || 180));
  state.timer.dur = v; state.timer.remaining = v;
  els.timerChips.forEach((x) => x.classList.remove('on'));
  renderTimer();
});
els.timerStart.addEventListener('click', () => sendTimer('run'));
els.timerPause.addEventListener('click', () => sendTimer(state.timer.state === 'run' ? 'pause' : 'run'));
els.timerReset.addEventListener('click', () => sendTimer('reset'));
document.addEventListener('click', (e) => {
  if (!els.timerPop.classList.contains('hidden') && !els.timerPop.contains(e.target) && e.target !== els.btnTimer) els.timerPop.classList.add('hidden');
});

/* ── recording (local, straight to this laptop) ── */

const LocalRecorder = {
  active: false, canvas: null, ctx: null, audioCtx: null, dest: null,
  trackSources: new Map(), recorder: null, chunks: [], timer: null, startedAt: 0,

  connectTrack(track) {
    if (!this.active || !this.audioCtx || this.trackSources.has(track)) return;
    try {
      const src = this.audioCtx.createMediaStreamSource(new MediaStream([track]));
      src.connect(this.dest);
      this.trackSources.set(track, src);
    } catch {}
  },
  disconnectTrack(track) {
    const src = this.trackSources.get(track);
    if (src) { try { src.disconnect(); } catch {} this.trackSources.delete(track); }
  },

  start() {
    if (this.active) return;
    const W = 1280, H = 720;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W; this.canvas.height = H;
    this.canvas.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.dest = this.audioCtx.createMediaStreamDestination();
    this.trackSources = new Map();
    for (const [, e] of state.participants) {
      for (const pub of e.p.audioTracks.values()) if (pub.track) this.connectTrack(pub.track);
    }
    const stream = this.canvas.captureStream(15);
    stream.addTrack(this.dest.stream.getAudioTracks()[0]);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm';
    this.recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 3_000_000 });
    this.chunks = [];
    this.recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) this.chunks.push(ev.data); };
    this.recorder.onstop = () => this.save();
    this.recorder.start(1000);
    this.active = true;
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.draw(W, H), 100);
  },

  draw(W, H) {
    const ctx = this.ctx; if (!ctx) return;
    ctx.fillStyle = '#070b16';
    ctx.fillRect(0, 0, W, H);
    const entries = [...state.participants.values()].sort((a, b) => {
      const rank = (x) => (x.p.identity === state.pinned ? 0 : x.el.classList.contains('speaking') ? 1 : 2);
      return rank(a) - rank(b);
    });
    const n = entries.length;
    if (n === 0) { this.drawHeader(W); return; }
    const cols = n === 1 ? 1 : n <= 4 ? 2 : 3;
    const rows = Math.ceil(n / cols);
    const cw = W / cols, ch = H / rows;
    entries.forEach((e, i) => {
      const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
      const tile = e.el;
      const vid = tile.classList.contains('showing-screen') ? tile.querySelector('.video-screen') : tile.querySelector('.video-main');
      ctx.fillStyle = '#141b30';
      ctx.fillRect(x, y, cw, ch);
      if (vid && vid.videoWidth > 0) {
        const vw = vid.videoWidth, vh = vid.videoHeight;
        const scale = Math.max(cw / vw, ch / vh);
        const sw = cw / scale, sh = ch / scale;
        ctx.drawImage(vid, (vw - sw) / 2, (vh - sh) / 2, sw, sh, x, y, cw, ch);
      } else {
        ctx.fillStyle = '#1a2240';
        ctx.fillRect(x, y, cw, ch);
        ctx.fillStyle = '#8b94ad';
        ctx.font = '64px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('🎭', x + cw / 2, y + ch / 2 + 22);
        ctx.textAlign = 'left';
      }
      const name = (e.p.name || e.p.identity) + (e.p.identity === state.identity ? ' (you)' : '');
      ctx.font = '600 15px Inter, sans-serif';
      const tw = ctx.measureText(name).width + 22;
      ctx.fillStyle = 'rgba(7,11,22,.72)';
      ctx.fillRect(x + 8, y + ch - 34, tw, 26);
      ctx.fillStyle = '#e8ecf8';
      ctx.fillText(name, x + 19, y + ch - 15);
      if (e.p.identity === state.pinned) {
        ctx.strokeStyle = '#e3b34c'; ctx.lineWidth = 4;
        ctx.strokeRect(x + 2, y + 2, cw - 4, ch - 4);
      }
    });
    this.drawHeader(W);
  },

  drawHeader(W) {
    const ctx = this.ctx;
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const t = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
    ctx.fillStyle = 'rgba(7,11,22,.85)';
    ctx.fillRect(0, 0, W, 44);
    ctx.fillStyle = '#ff5c6c';
    ctx.beginPath(); ctx.arc(20, 22, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e8ecf8';
    ctx.font = '600 16px Inter, sans-serif';
    ctx.fillText(`REC ${t}  ·  ${state.roomName}  ·  ${new Date().toLocaleString()}`, 36, 29);
  },

  stop() {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.timer);
    try { this.recorder.stop(); } catch {}
    this.trackSources.forEach((src) => { try { src.disconnect(); } catch {} });
    this.trackSources.clear();
    try { this.audioCtx.close(); } catch {}
    this.audioCtx = null;
    if (this.canvas) { this.canvas.remove(); this.canvas = null; }
  },

  save() {
    if (!this.chunks.length) { toast('Recording was empty — nothing saved.', 'bad'); return; }
    const blob = new Blob(this.chunks, { type: 'video/webm' });
    const a = document.createElement('a');
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}-${String(d.getMinutes()).padStart(2, '0')}`;
    a.href = URL.createObjectURL(blob);
    a.download = `orators-circle_${state.roomName}_${stamp}.webm`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`Recording saved: ${a.download} (${(blob.size / 1048576).toFixed(1)} MB)`, 'good', 7000);
  },
};

function setRec(on, since) {
  state.rec = { on, since: since || Date.now() };
  els.recBadge.classList.toggle('hidden', !on);
  if (on) els.recTime.textContent = fmtElapsed(0);
  els.btnRec.classList.toggle('on', on);
  els.btnRec.querySelector('.ctl-label').textContent = on ? 'Stop' : 'Record';
}

els.btnRec.addEventListener('click', () => {
  if (!state.rec.on) {
    LocalRecorder.start();
    const since = Date.now();
    setRec(true, since);
    sendData({ t: 'rec', on: true, since });
    toast('Recording on THIS laptop — the file downloads when you stop. ⏺️', 'good');
  } else {
    LocalRecorder.stop();
    setRec(false);
    sendData({ t: 'rec', on: false, since: 0 });
  }
});

/* ── controls ── */

function updateControlState() {
  const lp = state.room?.localParticipant;
  if (!lp) return;
  const mic = lp.isMicrophoneEnabled;
  const cam = lp.isCameraEnabled;
  const scr = lp.isScreenShareEnabled;
  els.btnMic.classList.toggle('on', mic); els.btnMic.classList.toggle('off', !mic);
  els.btnCam.classList.toggle('on', cam); els.btnCam.classList.toggle('off', !cam);
  els.btnScreen.classList.toggle('on', scr); els.btnScreen.classList.toggle('off', scr);
  els.btnMic.querySelector('.ctl-label').textContent = mic ? 'Mic' : 'Muted';
  els.btnCam.querySelector('.ctl-label').textContent = cam ? 'Cam' : 'Off';
  els.btnScreen.querySelector('.ctl-label').textContent = scr ? 'Stop' : 'Share';
}

els.btnMic.addEventListener('click', async () => { try { await state.room.localParticipant.setMicrophoneEnabled(!state.room.localParticipant.isMicrophoneEnabled); } catch {} updateControlState(); });
els.btnCam.addEventListener('click', async () => { try { await state.room.localParticipant.setCameraEnabled(!state.room.localParticipant.isCameraEnabled); } catch {} updateControlState(); });
els.btnScreen.addEventListener('click', async () => { try { await state.room.localParticipant.setScreenShareEnabled(!state.room.localParticipant.isScreenShareEnabled); } catch {} updateControlState(); });

/* ── people / moderation ── */

function updatePeople() {
  els.peopleList.innerHTML = '';
  const entries = [...state.participants.values()].sort((a, b) => {
    const r = (x) => (x.role === 'host' ? 0 : x.role === 'participant' ? 1 : 2);
    return r(a) - r(b) || a.p.name.localeCompare(b.p.name);
  });
  for (const { p, role } of entries) {
    const row = document.createElement('div');
    row.className = 'p-item';
    const micOff = [...p.audioTracks.values()].some((pub) => pub.isMuted) && p.audioTracks.size > 0;
    const rl = role || (p.identity === state.identity ? state.role : null);
    row.innerHTML = `
      <div class="p-avatar">${esc((p.name || '?')[0].toUpperCase())}</div>
      <div class="p-info">
        <div class="p-name">${esc(p.name || p.identity)}${p.identity === state.identity ? ' <span style="color:var(--muted)">(you)</span>' : ''}</div>
        <div class="p-sub"><span class="tile-role ${rl || ''}">${rl ? ROLE_LABEL[rl] || rl : '…'}</span>${micOff ? '<span style="color:var(--red)">🔇 muted</span>' : ''}${state.pinned === p.identity ? '<span style="color:var(--gold)">🎙️ on floor</span>' : ''}</div>
      </div>`;
    if (state.role === 'host' && p.identity !== state.identity) {
      const acts = document.createElement('div');
      acts.className = 'p-actions';
      const mk = (txt, cls, fn) => { const b = document.createElement('button'); b.className = cls; b.textContent = txt; b.onclick = fn; return b; };
      acts.appendChild(mk('🔇', 'secondary', async () => { try { await api(`/api/rooms/${encodeURIComponent(state.roomName)}/participants/${encodeURIComponent(p.identity)}/mute`, 'POST', {}, true); toast(`Muted ${p.name}`, 'info'); } catch (e) { toast(e.message, 'bad'); } }));
      acts.appendChild(mk('🎙️', 'secondary', () => grantFloor(p.identity, p.name)));
      acts.appendChild(mk('👀', 'secondary', async () => { try { await api(`/api/rooms/${encodeURIComponent(state.roomName)}/participants/${encodeURIComponent(p.identity)}/role`, 'POST', { role: 'audience' }, true); toast(`${p.name} set to Audience`, 'info'); } catch (e) { toast(e.message, 'bad'); } }));
      acts.appendChild(mk('⛔', 'danger', async () => {
        if (!confirm(`Remove ${p.name} from the room?`)) return;
        sendData({ t: 'kick', identity: p.identity });
        try { await api(`/api/rooms/${encodeURIComponent(state.roomName)}/participants/${encodeURIComponent(p.identity)}`, 'DELETE', undefined, true); toast(`${p.name} removed`, 'info'); } catch (e) { toast(e.message, 'bad'); }
      }));
      row.appendChild(acts);
    }
    els.peopleList.appendChild(row);
  }
}

els.roomTools && (els.roomTools.querySelector('#rt-muteall').onclick = async () => {
  try {
    const { muted } = await api(`/api/rooms/${encodeURIComponent(state.roomName)}/mute-all`, 'POST', {}, true);
    sendData({ t: 'muted_all' });
    toast(`Muted ${muted} audio track(s)`, 'info');
  } catch (e) { toast(e.message, 'bad'); }
});
els.roomTools && (els.roomTools.querySelector('#rt-clearchat').onclick = async () => {
  els.chatList.innerHTML = '';
  sendData({ t: 'chat_clear' });
  try { await api(`/api/rooms/${encodeURIComponent(state.roomName)}/chat`, 'DELETE', undefined, true); } catch {}
  toast('Chat cleared.', 'info');
});
els.roomTools && (els.roomTools.querySelector('#rt-end').onclick = async () => {
  if (!confirm('End the room for everyone? This disconnects all participants.')) return;
  sendData({ t: 'end' });
  try { await api(`/api/rooms/${encodeURIComponent(state.roomName)}`, 'DELETE', undefined, true); } catch {}
  state.ended = true;
  leaveRoom();
});

/* ── misc UI ── */

els.tabs.forEach((t) => t.addEventListener('click', () => {
  els.tabs.forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  const tab = t.dataset.tab;
  els.tabChat.classList.toggle('hidden', tab !== 'chat');
  els.tabFloor.classList.toggle('hidden', tab !== 'floor');
  els.tabPeople.classList.toggle('hidden', tab !== 'people');
  if (tab === 'floor') renderQueue();
  if (tab === 'people') updatePeople();
}));

els.btnPanel.addEventListener('click', () => els.sidebar.classList.toggle('closed'));

els.btnCopy.addEventListener('click', async () => {
  const link = `${location.origin}${location.pathname}?room=${encodeURIComponent(state.roomName)}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied — share it with your club! 🔗', 'good');
  } catch { prompt('Copy this invite link:', link); }
});

els.btnLeave.addEventListener('click', () => leaveRoom());
window.addEventListener('beforeunload', () => { try { state.room?.disconnect(); } catch {} });

function leaveRoom() {
  try { state.room?.disconnect(); } catch {}
  resetToLobby();
}

function resetToLobby(reason) {
  state.room = null;
  state.connected = false;
  state.participants.clear();
  state.queue = [];
  state.pinned = null;
  state.hand = false;
  state.rec = { on: false, since: 0 };
  state.timer = { state: 'stopped', dur: 180, remaining: 180, at: 0, label: '' };
  state.kicked = false; state.ended = false;
  els.grid.innerHTML = '';
  els.chatList.innerHTML = '';
  els.peopleList.innerHTML = '';
  els.queueList.innerHTML = '';
  els.timerWrap.classList.add('hidden');
  els.recBadge.classList.add('hidden');
  els.timerPop.classList.add('hidden');
  if (LocalRecorder.active) LocalRecorder.stop();
  els.sidebar.classList.add('closed');
  els.tabs[0].click();
  setRec(false);
  document.body.classList.remove('is-host');
  els.btnTimer.classList.add('hidden'); els.btnRec.classList.add('hidden');
  els.btnHand.classList.remove('hidden');
  els.btnMic.disabled = false; els.btnCam.disabled = false; els.btnScreen.disabled = false;
  els.room.classList.add('hidden');
  els.join.classList.remove('hidden');
  if (reason) toast(reason, 'info');
  els.fPass.value = '';
}

/* ═══════════ ADMIN PANEL (lobby) ═══════════ */

els.aLogin.addEventListener('click', async () => {
  state.adminPass = els.aPass.value.trim();
  sessionStorage.setItem('oc_pass', state.adminPass);
  await loadRooms();
});

async function loadRooms() {
  els.aRooms.innerHTML = '';
  try {
    const { rooms } = await api('/api/rooms', 'GET', undefined, true);
    if (!rooms.length) { els.aRooms.innerHTML = '<div class="a-empty">No active rooms.</div>'; return; }
    for (const r of rooms) {
      const box = document.createElement('div');
      box.className = 'a-room';
      const d = new Date(r.createdAt).toLocaleString();
      box.innerHTML = `
        <div class="a-room-head">
          <div><div class="a-room-name">${esc(r.name)} <code>${r.numParticipants} online</code></div>
          <div class="a-room-meta">created ${esc(d)}</div></div>
        </div>
        <div class="a-room-actions">
          <button class="secondary" data-act="parts">👥 Participants</button>
          <button class="danger" data-act="end">⛔ End room</button>
        </div>`;
      box.querySelector('[data-act="parts"]').onclick = async () => {
        try {
          const { participants } = await api(`/api/rooms/${encodeURIComponent(r.name)}/participants`, 'GET', undefined, true);
          const list = document.createElement('div');
          participants.forEach((p) => {
            const row = document.createElement('div');
            row.className = 'a-part';
            row.innerHTML = `<span>${esc(p.name)}</span>`;
            const kick = document.createElement('button');
            kick.className = 'danger'; kick.textContent = 'Kick';
            kick.style.cssText = 'font-size:11px;padding:3px 8px;border-radius:7px;';
            kick.onclick = async () => { try { await api(`/api/rooms/${encodeURIComponent(r.name)}/participants/${encodeURIComponent(p.identity)}`, 'DELETE', undefined, true); kick.remove(); } catch {} };
            row.appendChild(kick);
            list.appendChild(row);
          });
          if (!participants.length) list.innerHTML = '<div class="a-empty">No participants.</div>';
          const old = box.querySelector('.a-part-list');
          if (old) old.remove();
          list.className = 'a-part-list';
          box.appendChild(list);
        } catch (e) { toast(e.message, 'bad'); }
      };
      box.querySelector('[data-act="end"]').onclick = async () => {
        if (!confirm(`End room "${r.name}"? Everyone will be disconnected.`)) return;
        try { await api(`/api/rooms/${encodeURIComponent(r.name)}`, 'DELETE', undefined, true); toast(`Room ${r.name} ended`, 'info'); loadRooms(); } catch (e) { toast(e.message, 'bad'); }
      };
      els.aRooms.appendChild(box);
    }
  } catch (e) { els.aRooms.innerHTML = `<div class="a-empty">${esc(e.message)}</div>`; }
}

/* ═══════════ deep link prefill ═══════════ */

(function () {
  const q = new URLSearchParams(location.search);
  if (q.get('room')) els.fRoom.value = q.get('room');
  if (q.get('name')) els.fName.value = q.get('name');
  if (q.get('role')) {
    const b = els.roleBtns.find((x) => x.dataset.role === q.get('role'));
    if (b) { els.roleBtns.forEach((x) => x.classList.remove('active')); b.classList.add('active'); els.passWrap.classList.toggle('hidden', b.dataset.role !== 'host'); }
  }
  if (q.get('pass')) { els.fPass.value = q.get('pass'); state.adminPass = q.get('pass'); sessionStorage.setItem('oc_pass', state.adminPass); }
})();
