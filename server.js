const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const qrcode = require('qrcode');
const os = require('os');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const STAGES = [
  { bpm: 100, threshold: 5.5 },
  { bpm: 115, threshold: 4.0 },
  { bpm: 130, threshold: 3.0 },
  { bpm: 145, threshold: 2.2 },
  { bpm: 160, threshold: 1.6 },
];
const STAGE_DURATION_MS = 20000;
const FREEZE_WINDOW_MS = 1200;
const FREEZE_SUBCYCLE_MS = 10000;
const FREEZE_THRESHOLD = 0.9;
const GRACE_MS = 2000;
const COUNTDOWN_MS = 3000;
const CLASH_WINDOW_MS = 80;
const ORB_COLORS = [
  '#00f3ff', '#39ff14', '#ff2bd6', '#ff9f1c',
  '#3b82f6', '#facc15', '#ff003c', '#bc13fe',
];

let rooms = {};

function computeGameplay(elapsedMs, suddenDeath) {
  let stageIdx = Math.min(Math.floor(elapsedMs / STAGE_DURATION_MS), STAGES.length - 1);
  let freezeEvery = FREEZE_SUBCYCLE_MS;
  let freezeWin = FREEZE_WINDOW_MS;
  if (suddenDeath) {
    stageIdx = STAGES.length - 1;
    freezeEvery = 6000;
    freezeWin = 1500;
  }
  const stage = STAGES[stageIdx];
  const subElapsed = elapsedMs % freezeEvery;
  const freezeActive = subElapsed >= (freezeEvery - freezeWin);
  return {
    bpm: stage.bpm,
    threshold: freezeActive ? (suddenDeath ? 0.7 : FREEZE_THRESHOLD) : stage.threshold,
    freezeActive,
    stageIdx,
    suddenDeath: !!suddenDeath
  };
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function createRoom(hostWs) {
  return {
    players: {},
    sockets: new Set([hostWs]),
    gameState: 'lobby',
    gameStartedAt: 0,
    tempoTimer: null,
    teamsEnabled: false,
    suddenDeath: false,
    winner: null,
    winnerTeam: null,
    ghostsWin: false,
    spikes: [],
    clashTimer: null,
    nextBeatAt: 0,
    beatIndex: 0
  };
}

function stopRoomTimers(room) {
  if (room.tempoTimer) clearInterval(room.tempoTimer);
  if (room.clashTimer) clearTimeout(room.clashTimer);
  room.tempoTimer = null;
  room.clashTimer = null;
}

function resetRoundFlags(room) {
  room.winner = null;
  room.winnerTeam = null;
  room.ghostsWin = false;
  room.suddenDeath = false;
  room.spikes = [];
}

function revivePlayers(room, ready = false) {
  for (const p of Object.values(room.players)) {
    p.alive = true;
    p.ghost = false;
    p.ready = ready;
  }
}

function assignColor(room) {
  const used = new Set(Object.values(room.players).map(p => p.color));
  return ORB_COLORS.find(c => !used.has(c)) || ORB_COLORS[Object.keys(room.players).length % ORB_COLORS.length];
}

function assignTeam(room) {
  if (!room.teamsEnabled) return null;
  const red = Object.values(room.players).filter(p => p.team === 'red').length;
  const blue = Object.values(room.players).filter(p => p.team === 'blue').length;
  return red <= blue ? 'red' : 'blue';
}

function rebalanceTeams(room) {
  Object.values(room.players).forEach((p, i) => {
    p.team = room.teamsEnabled ? (i % 2 === 0 ? 'red' : 'blue') : null;
  });
}

function serializePlayer(id, p) {
  return {
    id,
    name: p.name,
    alive: p.alive,
    ghost: !!p.ghost,
    color: p.color,
    team: p.team,
    wins: p.wins || 0,
    ready: !!p.ready
  };
}

function broadcast(code, payload) {
  const room = rooms[code];
  if (!room) return;
  const raw = JSON.stringify(payload);
  for (const ws of room.sockets) {
    if (ws.readyState === 1) ws.send(raw);
  }
}

function broadcastRoom(code) {
  const room = rooms[code];
  if (!room) return;
  broadcast(code, {
    type: 'state',
    gameState: room.gameState,
    teamsEnabled: room.teamsEnabled,
    suddenDeath: room.suddenDeath,
    winner: room.winner,
    winnerTeam: room.winnerTeam,
    ghostsWin: room.ghostsWin,
    players: Object.entries(room.players).map(([id, p]) => serializePlayer(id, p))
  });
}

function livingEntries(room) {
  return Object.entries(room.players).filter(([, p]) => p.alive);
}

function finishVictory(code) {
  const room = rooms[code];
  if (!room || room.gameState !== 'live') return;
  room.gameState = 'victory';
  room.suddenDeath = false;
  stopRoomTimers(room);
  room.spikes = [];
  broadcastRoom(code);
}

function declareGhostsWin(code) {
  const room = rooms[code];
  room.ghostsWin = true;
  room.winner = null;
  room.winnerTeam = null;
  finishVictory(code);
}

function checkWin(code) {
  const room = rooms[code];
  if (!room || room.gameState !== 'live') return;
  if (Object.keys(room.players).length < 2) return;
  const living = livingEntries(room);

  if (room.teamsEnabled) {
    if (living.length === 0) return declareGhostsWin(code);
    const teams = new Set(living.map(([, p]) => p.team));
    if (teams.size !== 1) return;
    room.ghostsWin = false;
    room.winnerTeam = living[0][1].team;
    room.winner = {
      id: living[0][0],
      name: living[0][1].name,
      color: living[0][1].color,
      team: living[0][1].team
    };
    living.forEach(([, p]) => { p.wins = (p.wins || 0) + 1; });
    return finishVictory(code);
  }

  if (living.length === 0) return declareGhostsWin(code);
  if (living.length !== 1) return;
  const [id, p] = living[0];
  p.wins = (p.wins || 0) + 1;
  room.ghostsWin = false;
  room.winnerTeam = null;
  room.winner = { id, name: p.name, color: p.color, team: p.team };
  finishVictory(code);
}

function makeGhost(p) {
  if (!p || !p.alive) return false;
  p.alive = false;
  p.ghost = true;
  return true;
}

function resolveCluster(code) {
  const room = rooms[code];
  if (!room) return;
  room.clashTimer = null;
  const spikes = room.spikes;
  room.spikes = [];
  if (room.gameState !== 'live' || spikes.length === 0) return;

  const byId = {};
  for (const s of spikes) {
    if (!byId[s.id] || s.mag > byId[s.id].mag) byId[s.id] = s;
  }
  const unique = Object.values(byId);
  const elapsed = Date.now() - room.gameStartedAt;
  const g = computeGameplay(elapsed, room.suddenDeath);
  const livingSpikes = unique.filter(s => room.players[s.id]?.alive);
  const ghostedIds = [];
  let clash = false;

  if (unique.length >= 2 && !g.freezeActive && livingSpikes.length > 0) {
    clash = true;
    livingSpikes.sort((a, b) => a.mag - b.mag);
    if (makeGhost(room.players[livingSpikes[0].id])) ghostedIds.push(livingSpikes[0].id);
  } else {
    for (const s of unique) {
      if (makeGhost(room.players[s.id])) ghostedIds.push(s.id);
    }
  }

  if (ghostedIds.length === 0) return;
  broadcast(code, {
    type: 'fx',
    kind: clash ? 'clash' : 'ghosted',
    ids: unique.map(s => s.id),
    loserIds: ghostedIds
  });
  broadcastRoom(code);
  checkWin(code);
}

function noteSpike(code, playerId, magnitude) {
  const room = rooms[code];
  if (!room) return;
  room.spikes.push({ id: playerId, mag: magnitude, at: Date.now() });
  if (!room.clashTimer) {
    room.clashTimer = setTimeout(() => resolveCluster(code), CLASH_WINDOW_MS);
  }
}

function broadcastTempo(code) {
  const room = rooms[code];
  if (!room || room.gameState !== 'live') return;
  const aliveCount = livingEntries(room).length;
  room.suddenDeath = aliveCount === 2 && Object.keys(room.players).length >= 2;
  const elapsed = Date.now() - room.gameStartedAt;
  const g = computeGameplay(elapsed, room.suddenDeath);
  const stepMs = 60000 / g.bpm / 2;
  let beat = false;
  let downbeat = false;
  if (Date.now() >= room.nextBeatAt) {
    beat = !g.freezeActive;
    downbeat = beat && room.beatIndex % 2 === 0;
    if (beat) room.beatIndex += 1;
    room.nextBeatAt += stepMs;
    if (room.nextBeatAt < Date.now() - stepMs) room.nextBeatAt = Date.now() + stepMs;
  }
  broadcast(code, { type: 'tempo', ...g, elapsed, beat, downbeat });
}

function startTempoLoop(code) {
  const room = rooms[code];
  if (!room) return;
  if (room.tempoTimer) clearInterval(room.tempoTimer);
  room.nextBeatAt = Date.now();
  room.beatIndex = 0;
  room.tempoTimer = setInterval(() => {
    if (!rooms[code] || rooms[code].gameState !== 'live') {
      clearInterval(rooms[code]?.tempoTimer);
      return;
    }
    broadcastTempo(code);
  }, 40);
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

function getPublicOrigin(req) {
  const xfProto = req.headers['x-forwarded-proto'];
  const proto = (typeof xfProto === 'string' ? xfProto.split(',')[0].trim() : '') || 'http';
  const host = req.headers.host || `localhost:${PORT}`;
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (proto === 'https') return `https://${host}`;
  return `http://${getLocalIP()}:${PORT}`;
}

function servePublic(req, res) {
  const urlPath = req.url === '/' ? '/host.html' : req.url.split('?')[0];
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.url.startsWith('/qr')) {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const room = u.searchParams.get('room') || '';
    const png = await qrcode.toBuffer(`${getPublicOrigin(req)}/controller.html?room=${room}`);
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(png);
    return;
  }

  servePublic(req, res);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let roomCode = null;
  let playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create_room') {
      roomCode = makeRoomCode();
      rooms[roomCode] = createRoom(ws);
      ws.send(JSON.stringify({ type: 'room_created', code: roomCode }));
    }

    if (msg.type === 'join') {
      const code = (msg.room || '').toUpperCase();
      const room = rooms[code];
      if (!room) {
        ws.send(JSON.stringify({ type: 'join_error', message: 'Room not found' }));
        return;
      }
      roomCode = code;
      playerId = Math.random().toString(36).slice(2, 9);
      room.players[playerId] = {
        name: msg.name || `Player ${Object.keys(room.players).length + 1}`,
        alive: true,
        ghost: false,
        ws,
        color: assignColor(room),
        team: assignTeam(room),
        wins: 0,
        ready: false
      };
      room.sockets.add(ws);
      ws.send(JSON.stringify({
        type: 'joined',
        id: playerId,
        code,
        color: room.players[playerId].color,
        team: room.players[playerId].team
      }));
      broadcastRoom(roomCode);
    }

    if (msg.type === 'ready' && roomCode && playerId) {
      const room = rooms[roomCode];
      const p = room?.players[playerId];
      if (!p || room.gameState !== 'lobby') return;
      const next = !!msg.ready;
      if (p.ready === next) return;
      p.ready = next;
      broadcastRoom(roomCode);
    }

    if (msg.type === 'motion' && roomCode && playerId) {
      const room = rooms[roomCode];
      const p = room?.players[playerId];
      if (!p || room.gameState !== 'live') return;
      const elapsed = Date.now() - room.gameStartedAt;
      if (elapsed <= GRACE_MS) return;
      const g = computeGameplay(elapsed, room.suddenDeath);
      if (msg.magnitude > g.threshold) noteSpike(roomCode, playerId, msg.magnitude);
    }

    if (msg.type === 'toggle_teams' && roomCode) {
      const room = rooms[roomCode];
      if (!room || room.gameState !== 'lobby') return;
      room.teamsEnabled = !room.teamsEnabled;
      rebalanceTeams(room);
      broadcastRoom(roomCode);
    }

    if (msg.type === 'start_game' && roomCode) {
      const room = rooms[roomCode];
      if (!room || room.gameState !== 'lobby') return;
      room.gameState = 'countdown';
      resetRoundFlags(room);
      broadcastRoom(roomCode);
      setTimeout(() => {
        if (!rooms[roomCode]) return;
        revivePlayers(room, false);
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
      resetRoundFlags(room);
      stopRoomTimers(room);
      revivePlayers(room, false);
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
      if (room.gameState === 'live') checkWin(roomCode);
    }
    if (room.sockets.size === 0) {
      stopRoomTimers(room);
      delete rooms[roomCode];
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`JS Joust running at http://localhost:${PORT}`);
  console.log(`Host screen: http://localhost:${PORT}/host.html`);
  console.log(`Local IP for QR/join links: ${getLocalIP()}`);
});
