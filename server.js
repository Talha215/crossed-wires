// server.js — Crossed Wires: a telephone + mad libs story game.
//
// Single Node process, one port. All game state lives in memory (`rooms`)
// and is mirrored to game-state.json after every mutation so an in-progress
// game survives a server restart.
//
// PRIVACY INVARIANT: story text and hints are NEVER sent to any client
// before the reveal. Broadcasts only ever contain roomSummary() (names,
// status, turn counts). The current hint goes to exactly one socket — the
// active player's. The full story is serialized to clients exactly once,
// in the 'reveal' event.

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { generateHint, generateTitle } = require('./aiWorker');

const PORT = 3000;
const STATE_FILE = path.join(__dirname, 'game-state.json');
const DEFAULT_TURNS = 8;
const MAX_TEXT_LEN = 500;

const STARTER_PROMPT =
  'You are starting the story! Write the opening 1–3 sentences. ' +
  'Set a scene, introduce someone or something — anything goes.';

const FALLBACK_HINT =
  'Something strange just happened in the story, and everyone involved is mildly alarmed.\n' +
  'Must include: a rubber chicken.';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * rooms: Map<code, room>
 * room = {
 *   code, hostToken,
 *   status: 'lobby' | 'playing' | 'thinking' | 'titling' | 'reveal',
 *   turnsTotal, turnIndex,
 *   players: [{ token, name, connected, socketId }],   // socketId not persisted
 *   order: [token, ...],          // turn rotation; late joiners are appended
 *   orderPos,                     // index into order of the active player
 *   contributions: [{ token, name, text, hint }],      // hint = what they saw
 *   currentHint,                  // hint for the active player (null on turn 1)
 *   title,
 * }
 */
const rooms = new Map();

function save() {
  const plain = [...rooms.values()].map(room => ({
    ...room,
    players: room.players.map(({ socketId, ...p }) => ({ ...p, connected: false })),
  }));
  fs.writeFileSync(STATE_FILE, JSON.stringify(plain, null, 2));
}

function load() {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    for (const room of JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))) {
      room.players.forEach(p => { p.socketId = null; p.connected = false; });
      // Migrate saves from before the orderPos pointer existed.
      if (room.orderPos === undefined) {
        room.orderPos = room.order.length ? room.turnIndex % room.order.length : 0;
      }
      rooms.set(room.code, room);
    }
    console.log(`Restored ${rooms.size} room(s) from ${path.basename(STATE_FILE)}`);
  } catch (err) {
    console.error('Could not restore game-state.json:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O — easy to read aloud

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function fullStory(room) {
  return room.contributions.map(c => c.text).join('\n\n');
}

function activeToken(room) {
  return room.order[room.orderPos];
}

function findPlayer(room, token) {
  return room.players.find(p => p.token === token);
}

/** Public view of a room. Contains NO story text, hints, or title. */
function roomSummary(room) {
  const active = room.status === 'playing' || room.status === 'thinking'
    ? findPlayer(room, activeToken(room)) : null;
  return {
    code: room.code,
    status: room.status,
    turnsTotal: room.turnsTotal,
    turnIndex: room.turnIndex,
    activeName: active ? active.name : null,
    players: room.players.map(p => ({
      name: p.name,
      connected: p.connected,
      isHost: p.token === room.hostToken,
      isActive: active ? p.token === active.token : false,
    })),
  };
}

function broadcast(room) {
  io.to(room.code).emit('room_update', roomSummary(room));
}

/** Private payload for the active player only. */
function turnPayload(room) {
  return {
    turnIndex: room.turnIndex,
    turnsTotal: room.turnsTotal,
    promptType: room.turnIndex === 0 ? 'starter' : 'hint',
    prompt: room.turnIndex === 0 ? STARTER_PROMPT : room.currentHint,
  };
}

function sendTurnToActivePlayer(room) {
  const player = findPlayer(room, activeToken(room));
  if (player && player.socketId) {
    io.to(player.socketId).emit('your_turn', turnPayload(room));
  }
}

/** Sent to everyone, once, at the end. The only place story text leaves the server. */
function revealPayload(room) {
  return {
    title: room.title,
    contributions: room.contributions.map(c => ({
      name: c.name,
      text: c.text,
      hint: c.hint,
    })),
  };
}

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------

async function prepareTurn(room) {
  if (room.turnIndex === 0) {
    room.status = 'playing';
    room.currentHint = null;
    save();
    broadcast(room);
    sendTurnToActivePlayer(room);
    return;
  }

  room.status = 'thinking';
  save();
  broadcast(room);

  const isFinalTurn = room.turnIndex === room.turnsTotal - 1;
  let hint;
  try {
    hint = await generateHint(fullStory(room), { isFinalTurn });
  } catch (err) {
    console.error('generateHint failed, retrying once:', err.message);
    try {
      hint = await generateHint(fullStory(room), { isFinalTurn });
    } catch (err2) {
      console.error('generateHint failed again, using fallback:', err2.message);
      hint = FALLBACK_HINT;
    }
  }

  // The room may have been reset/ended while we waited on the AI.
  if (room.status !== 'thinking') return;

  room.currentHint = hint;
  room.status = 'playing';
  save();
  broadcast(room);
  sendTurnToActivePlayer(room);
}

async function finishStory(room) {
  room.status = 'titling';
  save();
  broadcast(room);

  let title;
  try {
    title = await generateTitle(fullStory(room));
  } catch (err) {
    console.error('generateTitle failed:', err.message);
    title = 'An Untitled Disaster';
  }

  if (room.status !== 'titling') return;

  room.title = title;
  room.status = 'reveal';
  save();
  broadcast(room);
  io.to(room.code).emit('reveal', revealPayload(room));
}

// Resume any AI work that was in flight when the server last stopped.
function resumePendingWork() {
  for (const room of rooms.values()) {
    if (room.status === 'thinking') prepareTurn(room);
    else if (room.status === 'titling') finishStory(room);
  }
}

// ---------------------------------------------------------------------------
// Socket handlers
// ---------------------------------------------------------------------------

io.on('connection', socket => {
  const getRoom = () => rooms.get(socket.data.code);
  const isHost = room => room && socket.data.token === room.hostToken;

  function attach(room, token) {
    socket.data.code = room.code;
    socket.data.token = token;
    socket.join(room.code);
  }

  socket.on('create_room', ({ name }, cb) => {
    name = String(name || '').trim().slice(0, 24);
    if (!name) return cb({ ok: false, error: 'Pick a name first.' });

    const token = crypto.randomBytes(16).toString('hex');
    const room = {
      code: newCode(),
      hostToken: token,
      status: 'lobby',
      turnsTotal: DEFAULT_TURNS,
      turnIndex: 0,
      players: [{ token, name, connected: true, socketId: socket.id }],
      order: [],
      orderPos: 0,
      contributions: [],
      currentHint: null,
      title: null,
    };
    rooms.set(room.code, room);
    attach(room, token);
    save();
    broadcast(room);
    cb({ ok: true, code: room.code, token, name });
  });

  socket.on('join_room', ({ code, name }, cb) => {
    code = String(code || '').trim().toUpperCase();
    name = String(name || '').trim().slice(0, 24);
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'No room with that code.' });
    if (!['lobby', 'playing', 'thinking'].includes(room.status)) {
      return cb({ ok: false, error: 'That story is just wrapping up — ask the host to start a new game.' });
    }
    if (!name) return cb({ ok: false, error: 'Pick a name first.' });

    // De-dupe names so "isActive" etc. are unambiguous on screen.
    let finalName = name, n = 2;
    while (room.players.some(p => p.name === finalName)) finalName = `${name} ${n++}`;

    const token = crypto.randomBytes(16).toString('hex');
    room.players.push({ token, name: finalName, connected: true, socketId: socket.id });
    // Mid-game joiners go to the back of the turn rotation. They write blind
    // like everyone else, so joining late is perfectly fair.
    if (room.status !== 'lobby') room.order.push(token);
    attach(room, token);
    save();
    broadcast(room);
    cb({ ok: true, code: room.code, token, name: finalName });
  });

  // Reconnect after a page refresh, dropped connection, or server restart.
  socket.on('rejoin', ({ code, token }, cb) => {
    const room = rooms.get(String(code || '').toUpperCase());
    const player = room && findPlayer(room, token);
    if (!player) return cb({ ok: false, error: 'That game is gone.' });

    player.connected = true;
    player.socketId = socket.id;
    attach(room, token);
    save();
    broadcast(room);

    const view = { ok: true, name: player.name, summary: roomSummary(room) };
    if (room.status === 'playing' && activeToken(room) === token) {
      view.yourTurn = turnPayload(room); // private — only this socket
    }
    if (room.status === 'reveal') {
      view.reveal = revealPayload(room);
    }
    cb(view);
  });

  socket.on('start_game', ({ turns }) => {
    const room = getRoom();
    if (!room || !isHost(room) || room.status !== 'lobby') return;
    if (room.players.length < 2) {
      return socket.emit('error_msg', 'You need at least 2 players.');
    }
    room.turnsTotal = Math.min(30, Math.max(2, parseInt(turns, 10) || DEFAULT_TURNS));
    room.turnIndex = 0;
    room.contributions = [];
    room.title = null;
    room.order = room.players.map(p => p.token);
    room.orderPos = 0;
    prepareTurn(room);
  });

  socket.on('submit_turn', ({ text }) => {
    const room = getRoom();
    if (!room || room.status !== 'playing') return;
    if (socket.data.token !== activeToken(room)) return; // only the active player

    text = String(text || '').trim().slice(0, MAX_TEXT_LEN);
    if (!text) return socket.emit('error_msg', 'Write something first!');

    const player = findPlayer(room, socket.data.token);
    room.contributions.push({
      token: player.token,
      name: player.name,
      text,
      hint: room.turnIndex === 0 ? STARTER_PROMPT : room.currentHint,
    });
    room.turnIndex++;
    room.orderPos = (room.orderPos + 1) % room.order.length;

    if (room.turnIndex >= room.turnsTotal) finishStory(room);
    else prepareTurn(room);
  });

  // Host can skip a stuck/disconnected player; the hint just passes to the
  // next player in the rotation. The skipped player keeps their seat.
  socket.on('skip_turn', () => {
    const room = getRoom();
    if (!room || !isHost(room) || room.status !== 'playing') return;
    room.orderPos = (room.orderPos + 1) % room.order.length;
    save();
    broadcast(room);
    sendTurnToActivePlayer(room);
  });

  // Host ends early → straight to title + reveal.
  socket.on('end_story', () => {
    const room = getRoom();
    if (!room || !isHost(room)) return;
    if (!['playing', 'thinking'].includes(room.status)) return;
    if (room.contributions.length === 0) {
      return socket.emit('error_msg', 'There is no story yet to end.');
    }
    finishStory(room);
  });

  // Host resets the room to the lobby; players stay, story is wiped.
  socket.on('new_game', () => {
    const room = getRoom();
    if (!room || !isHost(room) || room.status !== 'reveal') return;
    Object.assign(room, {
      status: 'lobby', turnIndex: 0, order: [], orderPos: 0,
      contributions: [], currentHint: null, title: null,
    });
    save();
    broadcast(room);
  });

  socket.on('leave_room', () => {
    const room = getRoom();
    if (!room) return;
    const idx = room.players.findIndex(p => p.token === socket.data.token);
    if (idx === -1) return;
    if (room.status === 'lobby') room.players.splice(idx, 1);
    else room.players[idx].connected = false;
    socket.leave(room.code);
    socket.data.code = socket.data.token = undefined;
    if (room.players.length === 0) rooms.delete(room.code);
    else broadcast(room);
    save();
  });

  socket.on('disconnect', () => {
    const room = getRoom();
    if (!room) return;
    const player = findPlayer(room, socket.data.token);
    if (player && player.socketId === socket.id) {
      player.connected = false;
      player.socketId = null;
      save();
      broadcast(room);
    }
  });
});

// ---------------------------------------------------------------------------

load();
server.listen(PORT, () => {
  console.log(`Crossed Wires running at http://localhost:${PORT}`);
  resumePendingWork();
});
