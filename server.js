import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import { AccessToken, RoomServiceClient, EgressClient, WebhookReceiver } from 'livekit-server-sdk';

const PORT = process.env.PORT || 3000;
const LIVEKIT_URL = (process.env.LIVEKIT_URL || '').trim();
const API_KEY = process.env.LIVEKIT_API_KEY || '';
const API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const HOST_PASSCODE = process.env.HOST_PASSCODE || 'host';
const WEBHOOK_SECRET = process.env.LIVEKIT_WEBHOOK_SECRET || '';

const S3 = process.env.S3_ACCESS_KEY
  ? {
      accessKey: process.env.S3_ACCESS_KEY,
      secret: process.env.S3_SECRET,
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION || 'us-east-1',
      keyPrefix: process.env.S3_KEY_PREFIX || 'recordings/',
    }
  : null;

// never crash on async route errors (Express 4 doesn't catch them)
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));

const app = express();
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.static('public'));

const ready = Boolean(LIVEKIT_URL && API_KEY && API_SECRET);
const roomsClient = ready ? new RoomServiceClient(LIVEKIT_URL, API_KEY, API_SECRET) : null;
const egressClient = ready ? new EgressClient(LIVEKIT_URL, API_KEY, API_SECRET) : null;

// In-memory chat history per room (late joiners see prior messages)
const chatLogs = new Map();
const ROOM_RE = /^[A-Za-z0-9_-]{2,48}$/;
const ROLES = new Set(['host', 'participant', 'audience']);
const ACTIVE_EGRESS = ['EGRESS_STARTING', 'EGRESS_ACTIVE', 'EGRESS_ENDING'];

/* ── helpers ─────────────────────────────────────────────── */

const requireLk = (req, res, next) => {
  if (!ready) {
    return res.status(503).json({
      error:
        'LiveKit is not configured. Copy .env.example to .env, fill in LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET, then restart.',
    });
  }
  next();
};

const requireAdmin = (req, res, next) => {
  if ((req.get('x-admin-password') || '') !== HOST_PASSCODE) {
    return res.status(403).json({ error: 'Invalid host passcode.' });
  }
  next();
};

const roomName = (v) => (typeof v === 'string' && ROOM_RE.test(v) ? v : null);

function permissionFor(role) {
  if (role === 'host') {
    return {
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canPublishSources: [1, 2, 3], // TrackSource: CAMERA=1, MICROPHONE=2, SCREEN_SHARE=3
      canUpdateOwnMetadata: true,
      roomAdmin: true,
    };
  }
  if (role === 'participant') {
    return {
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canPublishSources: [1, 2, 3], // TrackSource: CAMERA=1, MICROPHONE=2, SCREEN_SHARE=3
    };
  }
  // audience: watch + chat, cannot publish media
  return { canPublish: false, canSubscribe: true, canPublishData: true, canPublishSources: [] };
}

async function issueToken(room, name, role, identity) {
  const at = new AccessToken(API_KEY, API_SECRET, { identity, name, ttl: '6h' });
  const g = permissionFor(role);
  at.addGrant({ roomJoin: true, room, ...g });
  return await at.toJwt(); // toJwt() is async in livekit-server-sdk >= 2.13
}

async function muteIdentity(room, identity) {
  const p = await roomsClient.getParticipant(room, identity);
  const audio = (p.tracks || []).filter((t) => t.kind === 'audio');
  for (const t of audio) await roomsClient.mutePublishedTrack(room, identity, t.sid, true);
  return audio.length;
}

/* ── health & token ──────────────────────────────────────── */

app.get('/health', (_req, res) => res.json({ ok: true, livekit: ready, time: Date.now() }));

app.post('/api/token', requireLk, async (req, res) => {
  const room = roomName(req.body?.room);
  const name = String(req.body?.name || '').trim().slice(0, 40);
  const role = req.body?.role;
  if (!room) return res.status(400).json({ error: 'Room code: 2–48 characters, letters/digits/-/_.' });
  if (!name) return res.status(400).json({ error: 'Display name is required.' });
  if (!ROLES.has(role)) return res.status(400).json({ error: 'Unknown role.' });
  if (role === 'host' && (req.body?.passcode || '') !== HOST_PASSCODE) {
    return res.status(403).json({ error: 'Wrong host passcode.' });
  }

  const identity = `${role[0]}_${crypto.randomBytes(5).toString('hex')}`;
  try {
    if (role === 'host') {
      const rooms = await roomsClient.listRooms();
      if (!rooms.some((r) => r.name === room)) {
        await roomsClient.createRoom({ name: room, emptyTimeout: 600, maxParticipants: 60 });
      }
    }
    const token = await issueToken(room, name, role, identity);
    return res.json({ token, url: LIVEKIT_URL, role, identity, room });
  } catch (e) {
    console.error('token error', e);
    return res.status(500).json({ error: 'Could not create/join room: ' + e.message });
  }
});

/* ── room management (admin) ─────────────────────────────── */

app.get('/api/rooms', requireLk, requireAdmin, async (_req, res) => {
  try {
    const rooms = await roomsClient.listRooms();
    const out = rooms
      .map((r) => ({ name: r.name, numParticipants: r.numParticipants, createdAt: Number(r.creationTime) * 1000 }))
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json({ rooms: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/rooms/:room/participants', requireLk, requireAdmin, async (req, res) => {
  const room = roomName(req.params.room);
  if (!room) return res.status(400).json({ error: 'Bad room code.' });
  try {
    const ps = await roomsClient.listParticipants(room);
    res.json({
      participants: ps.map((p) => ({
        identity: p.identity,
        name: p.name || p.identity,
        canPublish: p.permission?.canPublish ?? false,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/rooms/:room', requireLk, requireAdmin, async (req, res) => {
  const room = roomName(req.params.room);
  if (!room) return res.status(400).json({ error: 'Bad room code.' });
  try {
    await roomsClient.deleteRoom(room); // disconnects everyone
    chatLogs.delete(room);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/rooms/:room/participants/:identity', requireLk, requireAdmin, async (req, res) => {
  const room = roomName(req.params.room);
  if (!room) return res.status(400).json({ error: 'Bad room code.' });
  try {
    await roomsClient.removeParticipant(room, req.params.identity);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/rooms/:room/participants/:identity/mute', requireLk, requireAdmin, async (req, res) => {
  const room = roomName(req.params.room);
  if (!room) return res.status(400).json({ error: 'Bad room code.' });
  try {
    const n = await muteIdentity(room, req.params.identity);
    res.json({ ok: true, muted: n });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/rooms/:room/mute-all', requireLk, requireAdmin, async (req, res) => {
  const room = roomName(req.params.room);
  if (!room) return res.status(400).json({ error: 'Bad room code.' });
  try {
    const ps = await roomsClient.listParticipants(room);
    let muted = 0;
    for (const p of ps) {
      try {
        muted += await muteIdentity(room, p.identity);
      } catch {}
    }
    res.json({ ok: true, muted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/rooms/:room/participants/:identity/role', requireLk, requireAdmin, async (req, res) => {
  const room = roomName(req.params.room);
  if (!room) return res.status(400).json({ error: 'Bad room code.' });
  const role = req.body?.role;
  if (!ROLES.has(role)) return res.status(400).json({ error: 'Bad role.' });
  try {
    await roomsClient.updateParticipant(room, req.params.identity, { permission: permissionFor(role) });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── recording (egress) ──────────────────────────────────── */

app.get('/api/rooms/:room/record', requireLk, requireAdmin, async (req, res) => {
  const room = roomName(req.params.room);
  if (!room) return res.status(400).json({ error: 'Bad room code.' });
  try {
    const all = await egressClient.listEgress({ roomName: room });
    res.json({
      active: all.some((e) => ACTIVE_EGRESS.includes(e.status)),
      egresses: all.map((e) => ({
        egressId: e.egressId,
        status: e.status,
        startedAt: Number(e.startedAt) * 1000,
        endedAt: e.endedAt ? Number(e.endedAt) * 1000 : null,
        error: e.error || null,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/rooms/:room/record/start', requireLk, requireAdmin, async (req, res) => {
  const room = roomName(req.params.room);
  if (!room) return res.status(400).json({ error: 'Bad room code.' });
  try {
    const all = await egressClient.listEgress({ roomName: room });
    const running = all.find((e) => ACTIVE_EGRESS.includes(e.status));
    if (running) return res.json({ ok: true, egressId: running.egressId, already: true });

    const stamp = Date.now();
    const output = S3
      ? { s3: { accessKey: S3.accessKey, secret: S3.secret, bucket: S3.bucket, region: S3.region, key: `${S3.keyPrefix}${room}-${stamp}.mp4` } }
      : { file: { filepath: `recordings/${room}-${stamp}.mp4` } };
    const info = await egressClient.startRoomCompositeEgress(room, output, { layout: 'speaker' });
    res.json({ ok: true, egressId: info.egressId });
  } catch (e) {
    res.status(500).json({ error: 'Could not start recording: ' + e.message });
  }
});

app.post('/api/rooms/:room/record/stop', requireLk, requireAdmin, async (req, res) => {
  const room = roomName(req.params.room);
  if (!room) return res.status(400).json({ error: 'Bad room code.' });
  try {
    const all = await egressClient.listEgress({ roomName: room });
    const running = all.filter((e) => ACTIVE_EGRESS.includes(e.status));
    for (const e of running) await egressClient.stopEgress(e.egressId);
    res.json({ ok: true, stopped: running.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── chat history ────────────────────────────────────────── */

app.get('/api/rooms/:room/chat', (req, res) => {
  const room = roomName(req.params.room);
  if (!room) return res.status(400).json({ error: 'Bad room code.' });
  res.json({ messages: chatLogs.get(room) || [] });
});

app.post('/api/rooms/:room/chat', (req, res) => {
  const room = roomName(req.params.room);
  if (!room) return res.status(400).json({ error: 'Bad room code.' });
  const name = String(req.body?.name || '').trim().slice(0, 40);
  const text = String(req.body?.text || '').trim().slice(0, 500);
  if (!name || !text) return res.status(400).json({ error: 'Missing fields.' });
  const log = chatLogs.get(room) || [];
  log.push({ name, text, ts: Date.now() });
  while (log.length > 300) log.shift();
  chatLogs.set(room, log);
  res.json({ ok: true });
});

app.delete('/api/rooms/:room/chat', requireAdmin, (req, res) => {
  const room = roomName(req.params.room);
  if (!room) return res.status(400).json({ error: 'Bad room code.' });
  chatLogs.delete(room);
  res.json({ ok: true });
});

/* ── webhook (optional) ──────────────────────────────────── */

if (WEBHOOK_SECRET && ready) {
  const receiver = new WebhookReceiver(API_KEY, API_SECRET);
  app.post('/webhook', async (req, res) => {
    try {
      const event = await receiver.receive(req.rawBody, req.headers.authorization || '');
      if (event.event === 'room_finished') {
        chatLogs.delete(event.room?.name);
        console.log('[webhook] room finished:', event.room?.name);
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('bad webhook', e);
      res.status(400).json({ error: 'invalid' });
    }
  });
}

app.listen(PORT, () => {
  console.log('┌─────────────────────────────────────────────────┐');
  console.log('│  🗣️  The Orator\'s Circle — debate chamber        │');
  console.log(`│  http://localhost:${PORT}                          │`);
  console.log(ready ? '│  LiveKit: connected ✔                      │' : '│  LiveKit: NOT CONFIGURED (see .env) ✘        │');
  console.log('└─────────────────────────────────────────────────┘');
});
