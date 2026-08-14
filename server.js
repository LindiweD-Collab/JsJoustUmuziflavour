const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const qrcode = require('qrcode');
const os = require('os');

const PORT = process.env.PORT || 3000;

// --- Tempo/difficulty stages: bpm climbs, base threshold tightens ---
const STAGES = [
  { bpm: 100, threshold: 20 },
  { bpm: 115, threshold: 17 },
  { bpm: 130, threshold: 14 },
  { bpm: 145, threshold: 11 },
  { bpm: 160, threshold: 9 },
];
const STAGE_DURATION_MS = 20000;   // how long each tempo stage lasts
const FREEZE_WINDOW_MS = 1200;     // duration of each "freeze" beat
const FREEZE_SUBCYCLE_MS = 10000;  // a freeze happens every N ms within a stage
const FREEZE_THRESHOLD = 5;        // ultra-strict tolerance during freeze
const GRACE_MS = 2000;             // immunity window after game start
const COUNTDOWN_MS = 3000;

function computeGameplay(elapsedMs) {
  const stageIdx = Math.min(Math.floor(elapsedMs / STAGE_DURATION_MS), STAGES.length - 1);
  const stage = STAGES[stageIdx];
  const subElapsed = elapsedMs % FREEZE_SUBCYCLE_MS;
  const freezeActive = subElapsed >= (FREEZE_SUBCYCLE_MS - FREEZE_WINDOW_MS);
  return {
    bpm: stage.bpm,
    threshold: freezeActive ? FREEZE_THRESHOLD : stage.threshold,
    freezeActive,
    stageIdx
  };
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

// --- Room state ---
// rooms[code] = { players: {id: {name, alive, ws}}, sockets: Set<ws>,
//                  gameState, gameStartedAt, tempoTimer }
let rooms = {};

function broadcastRoom(code) {
  const room = rooms[code];
  if (!room) return;
  const payload = JSON.stringify({
    type: 'state',
    gameState: room.gameState,
    players: Object.entries(room.players).map(([id, p]) => ({
      id, name: p.name, alive: p.alive
    }))
  });
  for (const ws of room.sockets) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function broadcastTempo(code) {
  const room = rooms[code];
  if (!room || room.gameState !== 'live') return;
  const elapsed = Date.now() - room.gameStartedAt;
  const g = computeGameplay(elapsed);
  const payload = JSON.stringify({ type: 'tempo', ...g, elapsed });
  for (const ws of room.sockets) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function startTempoLoop(code) {
  const room = rooms[code];
  if (!room) return;
  if (room.tempoTimer) clearInterval(room.tempoTimer);
  room.tempoTimer = setInterval(() => {
    if (!rooms[code] || rooms[code].gameState !== 'live') {
      clearInterval(rooms[code]?.tempoTimer);
      return;
    }
    broadcastTempo(code);
  }, 150);
}

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/qr')) {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const room = u.searchParams.get('room') || '';
    const url = `http://${getLocalIP()}:${PORT}/controller.html?room=${room}`;
    const png = await qrcode.toBuffer(url);
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(png);
    return;
  }

  let filePath = req.url === '/' ? '/host.html' : req.url.split('?')[0];
  filePath = path.join(__dirname, 'public', filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let roomCode = null;
  let playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // --- Host creates a fresh room ---
    if (msg.type === 'create_room') {
      roomCode = makeRoomCode();
      rooms[roomCode] = {
        players: {}, sockets: new Set([ws]),
        gameState: 'lobby', gameStartedAt: 0, tempoTimer: null
      };
      ws.send(JSON.stringify({ type: 'room_created', code: roomCode }));
    }

    // --- Player joins an existing room ---
    if (msg.type === 'join') {
      const code = (msg.room || '').toUpperCase();
      const room = rooms[code];
      if (!room) {
        ws.send(JSON.stringify({ type: 'join_error', message: 'Room not found' }));
        return;
      }
      roomCode = code;
      playerId = Math.random().toString(36).slice(2, 9);
      room.players[playerId] = { name: msg.name || `Player ${Object.keys(room.players).length + 1}`, alive: true, ws };
      room.sockets.add(ws);
      ws.send(JSON.stringify({ type: 'joined', id: playerId, code }));
      broadcastRoom(roomCode);
    }

    // --- Motion data from a player ---
    if (msg.type === 'motion' && roomCode && playerId) {
      const room = rooms[roomCode];
      if (!room) return;
      const p = room.players[playerId];
      if (room.gameState === 'live' && p && p.alive) {
        const elapsed = Date.now() - room.gameStartedAt;
        if (elapsed > GRACE_MS) {
          const { threshold } = computeGameplay(elapsed);
          if (msg.magnitude > threshold) {
            p.alive = false;
            broadcastRoom(roomCode);
          }
        }
      }
    }

    // --- Host controls ---
    if (msg.type === 'start_game' && roomCode) {
      const room = rooms[roomCode];
      if (!room) return;
      room.gameState = 'countdown';
      broadcastRoom(roomCode);
      setTimeout(() => {
        if (!rooms[roomCode]) return;
        for (const p of Object.values(room.players)) p.alive = true;
        room.gameState = 'live';
        room.gameStartedAt = Date.now();
        broadcastRoom(roomCode);
        startTempoLoop(roomCode);
      }, COUNTDOWN_MS);
    }

    if (msg.type === 'reset_game' && roomCode) {
      const room = rooms[roomCode];
      if (!room) return;
      room.gameState = 'lobby';
      if (room.tempoTimer) clearInterval(room.tempoTimer);
      for (const p of Object.values(room.players)) p.alive = true;
      broadcastRoom(roomCode);
    }
  });

  ws.on('close', () => {
    if (!roomCode || !rooms[roomCode]) return;
    const room = rooms[roomCode];
    room.sockets.delete(ws);
    if (playerId && room.players[playerId]) {
      delete room.players[playerId];
      broadcastRoom(roomCode);
    }
    // clean up empty rooms
    if (room.sockets.size === 0) {
      if (room.tempoTimer) clearInterval(room.tempoTimer);
      delete rooms[roomCode];
    }
  });
});

server.listen(PORT, () => {
  console.log(`JS Joust running at http://localhost:${PORT}`);
  console.log(`Host screen: http://localhost:${PORT}/host.html`);
  console.log(`Local IP for QR/join links: ${getLocalIP()}`);
});
