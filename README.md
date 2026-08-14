# JS Joust

## Run it
```
npm install
node server.js
```

- **Host screen** (TV/laptop, on WiFi): open `http://localhost:3000/host.html` — it generates a room code and QR automatically.
- **Players**: scan the QR code with their phones (same WiFi network). The room code is baked into the QR link, so they just tap Join.
  - No QR reader handy? Players can go to `http://<host-ip>:3000/controller.html`, type in the 4-character room code shown on the host screen, and enter a name.

## What's implemented

| Requirement | Where |
|---|---|
| Game room other players can join | `server.js` — `rooms{}` keyed by a generated 4-char code; unlimited concurrent rooms, empty rooms are cleaned up on disconnect |
| Cellphones as controllers | `controller.html` — `DeviceMotion` streamed to the server on every event |
| Real-time communication | `ws` WebSocket server, per-room broadcast |
| Music/tempo-driven gameplay | `server.js` `computeGameplay()` + `host.html` Web Audio — see below |
| Multi-device sync as core challenge | server is sole source of truth per room; state + tempo broadcast to every socket in that room |

## The music/tempo mechanic
This was the missing piece last time — now:
- The game runs through 5 **tempo stages** (100 → 160 BPM), each lasting 20s. Movement tolerance tightens as BPM climbs (`STAGES` array in `server.js`).
- Within each stage, there's a **freeze window** every 10 seconds (1.2s long) where the tolerance drops to almost nothing (`FREEZE_THRESHOLD = 5`) — this is the classic JS Joust "the music stops, don't move" beat.
- The **host page** plays this live: a soft click on every beat (Web Audio oscillator, no external audio files needed) and a dissonant sting the instant a freeze window starts, so the audio *is* the rule change, not just a decoration.
- The **server** independently computes the same threshold from `gameStartedAt` + elapsed time, so cheating by ignoring the audio doesn't help — the elimination logic is authoritative server-side regardless of what the client renders/plays.
- Controller phones flash red and show "FREEZE!" the instant a freeze window starts, so players get a visual cue too (useful if they can't hear the host speaker well).

## Known limitations / next steps
- **HTTPS required for iOS motion permission** in production — deploy behind ngrok/Caddy for a real TLS cert; `DeviceMotionEvent.requestPermission()` needs a secure context on iOS 13+.
- **No reconnect handling** — a WiFi blip drops a player from the room permanently.
- **Audio timing is client-scheduled, not sample-accurate** — fine for gameplay pacing, but it's not a tight DAW-style beat clock. If you want a driving/DJ-quality track under it, swap the Web Audio clicks for a looping audio file synced to the same `tempo` broadcast.
- **Threshold values are untested against real phones** — different devices report different accelerometer scales; playtest and tune `STAGES` / `FREEZE_THRESHOLD` in `server.js`.
