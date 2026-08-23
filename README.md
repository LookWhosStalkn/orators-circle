# 🗣️ The Orator's Circle — Live Debate Chamber

A complete LiveKit-powered video website for a debating club: real-time rooms,
hosting permissions & moderation, **recording**, **chat**, **screen share**, a
**speaking floor queue** and a **debate timer** synced to everyone.

No frontend build step — plain HTML/CSS/JS served by a small Node/Express
backend that issues LiveKit tokens and manages rooms/recording via the
LiveKit Server SDK.

## Features

| Area | What you get |
|---|---|
| 🎥 Video | HD camera + mic, adaptive stream, speaking-ring highlight, pin the current speaker |
| 🖥️ Screen share | One click; viewers see a "Presenting screen" banner |
| 💬 Chat | Real-time chat with history (late joiners see prior messages), host can clear it |
| 🎙️ Speaking floor | Participants **raise hand** → queue → host **grants the floor** (pinned + ribbon) |
| ⏱️ Debate timer | Presets (1:00/2:00/3:00/5:00) or custom, start/pause/reset, synced to everyone, red pulse under 30s, "Time's up!" alert |
| ⏺️ Recording | One-click session recording via LiveKit Egress (S3 on Cloud, file on self-hosted); REC badge shown to everyone |
| ⚖️ Hosting perms | Host passcode gates room creation; hosts can: mute individuals, **mute all**, demote to Audience (no publishing), remove participants, end the room |
| 👥 Roles | **Host** (full control) · **Speaker** (publish + hand) · **Audience** (watch + chat only) |
| 🔗 Invites | Copy deep link `?room=code`; URL params prefill the join form |
| 🛠️ Admin panel | On the join screen: list all active rooms, inspect participants, kick, end rooms |
| 📊 Robustness | Server-side authoritative moderation via RoomServiceClient; kicked/ended users get a clear message |

## Quick start

1. **Get a LiveKit server** (2 minutes):
   - [cloud.livekit.io](https://cloud.livekit.io) → create a project → copy the
     **URL (wss://…)**, **API Key**, **API Secret**. Recording on Cloud requires
     an S3 bucket — add S3 vars to `.env` (see below).
   - Or self-host with [livekit-server](https://github.com/livekit/livekit).

2. **Configure & run**

   ```bash
   cd orators-circle
   npm install
   cp .env.example .env      # fill in your LiveKit keys + change HOST_PASSCODE
   npm start
   ```

   Open **http://localhost:3000**.

3. **Host a debate**: pick role **⚖️ Host**, enter a room code + the host
   passcode (`host` by default — change it!). Share the invite link
   (🔗 button) with your club. Speakers/audience join with the same room code.

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `LIVEKIT_URL` | ✅ | e.g. `wss://your-project.livekit.cloud` |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | ✅ | from your LiveKit project |
| `HOST_PASSCODE` | ⚠️ change | used by hosts and the admin panel |
| `PORT` | – | default `3000` |
| `S3_ACCESS_KEY`, `S3_SECRET`, `S3_BUCKET`, `S3_REGION`, `S3_KEY_PREFIX` | for Cloud recording | recordings land in S3 as `recordings/<room>-<ts>.mp4` |
| `LIVEKIT_WEBHOOK_SECRET` | – | enables `/webhook` cleanup (set the URL in LiveKit console) |

## API

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/token` | passcode for host | issue join token + create room if host |
| `GET /api/rooms` | host passcode header | list active rooms |
| `GET /api/rooms/:room/participants` | host passcode | list participants |
| `DELETE /api/rooms/:room` | host passcode | end room (disconnects all) |
| `DELETE /api/rooms/:room/participants/:id` | host passcode | kick |
| `POST …/participants/:id/mute` | host passcode | mute one |
| `POST …/mute-all` | host passcode | mute everyone |
| `POST …/participants/:id/role` | host passcode | change role (e.g. → audience) |
| `GET/POST …/record`, `POST …/record/start|stop` | host passcode | recording status / start / stop |
| `GET/POST/DELETE …/chat` | – | chat history store |

Admin calls send `x-admin-password: <host passcode>`.

## Deploying

The app is a single Node process — deploy to **Render**, **Railway**, **Fly.io**,
or a VPS. Render example: new *Web Service* → repo root → build `npm install`,
start `npm start`, add the env vars. Remember HTTPS is required for camera/mic
in production (Render/Railway give you it for free).

## Security notes (read before going public)

- **Change `HOST_PASSCODE`** — it gates hosting and all admin endpoints.
- Anyone with the passcode can manage rooms; keep it club-internal.
- The chat history endpoint is intentionally open (needed for late joiners);
  messages are capped at 300/room and cleared when the room ends.
- Token TTL is 6h. Production hardening ideas: rate-limit `/api/token`,
  add real auth (e.g. magic links), switch chat history to a database.
