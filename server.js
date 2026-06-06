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
const STORIES_FILE = path.join(__dirname, 'stories.json');
const DEFAULT_TURNS = 8;
const MAX_TEXT_LEN = 500;

const STARTER_PROMPT =
  'You are starting the story! Write the opening 1–3 sentences. ' +
  'Set a scene, introduce someone or something — anything goes.';

// Story themes: the starter seeds turn 1, the flavor seasons every AI hint.
const THEMES = {
  classic: {
    label: '🎲 Anything goes',
    starter: STARTER_PROMPT,
    flavor: null,
  },
  noir: {
    label: '🕵️ Film noir',
    starter: 'Start a hard-boiled detective story: a rain-soaked city, a narrator with regrets, trouble about to walk through the door. Write the opening 1–3 sentences.',
    flavor: 'a hard-boiled film noir detective story (moody narration, questionable choices)',
  },
  fantasy: {
    label: '🐉 Fantasy quest',
    starter: 'Start an epic fantasy quest: a hero (loosely defined), a land in peril, a prophecy nobody read carefully. Write the opening 1–3 sentences.',
    flavor: 'an epic and increasingly ridiculous fantasy quest',
  },
  naturedoc: {
    label: '🦁 Nature documentary',
    starter: 'Start a nature documentary: narrate someone or something as if a hushed documentary crew is observing it in the wild. Write the opening 1–3 sentences.',
    flavor: 'a hushed, dramatic nature documentary narration of its subjects',
  },
  office: {
    label: '📎 Office drama',
    starter: 'Start a petty workplace drama: an office, a grievance, stakes that are both tiny and enormous. Write the opening 1–3 sentences.',
    flavor: 'a petty workplace drama where tiny stakes feel enormous',
  },
  scifi: {
    label: '🚀 Space opera',
    starter: 'Start a melodramatic space opera: a ship, a crew, something blinking red that should not be blinking red. Write the opening 1–3 sentences.',
    flavor: 'a melodramatic space opera',
  },
  horror: {
    label: '🕯️ Campfire horror',
    starter: 'Start a campfire horror story: somewhere dark, someone who should not be there, a sound that has no business existing. Write the opening 1–3 sentences.',
    flavor: 'a campfire horror story — spooky but ultimately silly',
  },
  fairytale: {
    label: '🏰 Fractured fairy tale',
    starter: 'Start a fairy tale that is about to go off the rails: once upon a time, somewhere enchanted, something is not quite right. Write the opening 1–3 sentences.',
    flavor: 'a classic fairy tale going progressively off the rails',
  },
  heist: {
    label: '💰 The heist',
    starter: 'Start a heist story: a crew, a target, a plan with at least one obvious flaw nobody mentions. Write the opening 1–3 sentences.',
    flavor: 'a high-stakes heist executed by overconfident incompetents',
  },
};

function resolveTheme(id) {
  if (id === 'surprise') {
    const pool = Object.keys(THEMES).filter(k => k !== 'classic');
    return pool[crypto.randomInt(pool.length)];
  }
  return THEMES[id] ? id : 'classic';
}

function themeStarter(room) {
  return (THEMES[room.theme] || THEMES.classic).starter;
}

// Doodle canvas: bright colors that read well on the dark canvas background.
const COLORS = [
  '#ff6b6b', '#ffb454', '#ffe066', '#7ee08a', '#4ecdc4', '#76d7ea',
  '#5da9ff', '#b39dff', '#ff8ad8', '#f4a261', '#a0e8af', '#e07be0',
];
const MAX_STROKES = 2000;
const MAX_STROKE_POINTS = 600;

const FALLBACK_HINT =
  'Something strange just happened in the story, and everyone involved is mildly alarmed.\n' +
  'Must include: a rubber chicken.';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Story archive — finished stories are kept forever (rooms get swept, but
// the stories your group wrote shouldn't vanish with them).
// ---------------------------------------------------------------------------

let archive = [];

function loadStories() {
  try {
    archive = JSON.parse(fs.readFileSync(STORIES_FILE, 'utf8'));
  } catch { /* no archive yet */ }
}

function archiveStory(room) {
  const id = crypto.randomBytes(8).toString('hex');
  room.archiveId = id; // so the vote result can be attached later
  archive.unshift({
    id,
    title: room.title,
    theme: room.theme,
    finishedAt: Date.now(),
    players: room.players.map(p => p.name),
    contributions: room.contributions.map(c => ({ name: c.name, text: c.text, hint: c.hint })),
    strokes: publicStrokes(room),
  });
  atomicWrite(STORIES_FILE, JSON.stringify(archive, null, 2));
}

app.get('/stories', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'stories.html')));

app.get('/patch-notes', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'patch-notes.html')));

app.get('/api/stories', (req, res) =>
  res.json(archive.map(({ id, title, finishedAt, players, contributions }) =>
    ({ id, title, finishedAt, players, turns: contributions.length }))));

app.get('/api/stories/:id', (req, res) => {
  const story = archive.find(s => s.id === req.params.id);
  if (!story) return res.status(404).json({ error: 'not found' });
  res.json(story);
});

// Deleting is host-machine-only. Internet traffic proxied in by Tailscale
// Funnel / cloudflared also arrives via loopback, but always carries an
// X-Forwarded-For header — a bare loopback request can only be a browser
// on the machine running the server.
function isLocalAdmin(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    && !req.headers['x-forwarded-for'];
}

app.delete('/api/stories/:id', (req, res) => {
  if (!isLocalAdmin(req)) {
    return res.status(403).json({
      error: 'Stories can only be deleted from the host machine — open http://localhost:3000/stories on the PC running the server.',
    });
  }
  const before = archive.length;
  archive = archive.filter(s => s.id !== req.params.id);
  if (archive.length === before) return res.status(404).json({ error: 'not found' });
  atomicWrite(STORIES_FILE, JSON.stringify(archive, null, 2));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * rooms: Map<code, room>
 * room = {
 *   code, hostToken,
 *   status: 'lobby' | 'playing' | 'thinking' | 'titling' | 'reveal',
 *   turnsTotal, turnIndex,
 *   players: [{ token, name, color, connected, socketId }], // socketId not persisted
 *   order: [token, ...],          // turn rotation; late joiners are appended
 *   orderPos,                     // index into order of the active player
 *   canvas: { strokes: [{ id, token, name, color, width, points }], nextId },
 *   lastActivity,                 // ms epoch; stale rooms get swept
 *   timerSecs,                    // host-set turn timer; 0 = off
 *   turnDeadline,                 // ms epoch when the active turn auto-skips
 *   contributions: [{ token, name, text, hint }],      // hint = what they saw
 *   currentHint,                  // hint for the active player (null on turn 1)
 *   title,
 * }
 */
const rooms = new Map();

let saveTimer = null;

// Write-then-rename so a crash mid-write can never corrupt the existing
// file — the rename is atomic, so we always have either old or new state.
function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function save() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const plain = [...rooms.values()].map(room => ({
    ...room,
    players: room.players.map(({ socketId, ...p }) => ({ ...p, connected: false })),
  }));
  atomicWrite(STATE_FILE, JSON.stringify(plain, null, 2));
}

// Doodle strokes arrive far more often than game events — batch their writes.
function saveSoon() {
  if (!saveTimer) saveTimer = setTimeout(save, 1500);
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
      // Migrate saves from before the doodle canvas existed.
      if (!room.canvas) room.canvas = { strokes: [], nextId: 1 };
      room.players.forEach(p => { if (!p.color) p.color = pickColor(room); });
      // Pre-sweep saves have no timestamp — give them a fresh grace period.
      if (!room.lastActivity) room.lastActivity = Date.now();
      // Migrate saves from before the turn timer existed.
      if (room.timerSecs === undefined) { room.timerSecs = 0; room.turnDeadline = null; }
      room.hostAwolSince = null; // never migrate just because we rebooted
      // Migrate saves from before themes / paced reveal / voting existed.
      if (!room.theme) room.theme = 'classic';
      if (room.revealDone === undefined) {
        room.revealed = room.contributions.length;
        room.revealDone = room.status === 'reveal';
        room.votes = {};
        room.voteResult = null;
        room.archiveId = null;
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

function pickColor(room) {
  const used = new Set(room.players.map(p => p.color));
  const free = COLORS.filter(c => !used.has(c));
  const pool = free.length ? free : COLORS;
  return pool[crypto.randomInt(pool.length)];
}

/** Strokes as sent to clients — owner identified by public name, not token. */
function publicStrokes(room) {
  return room.canvas.strokes.map(({ token, ...s }) => s);
}

const round3 = v => Math.round(v * 1000) / 1000;

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

function nearStroke(stroke, x, y, r) {
  const pts = stroke.points;
  if (pts.length === 1) return Math.hypot(pts[0][0] - x, pts[0][1] - y) <= r;
  for (let i = 1; i < pts.length; i++) {
    if (distToSeg(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= r) return true;
  }
  return false;
}

/**
 * Rub out the part of a stroke near (x, y) like a real eraser: resample the
 * line (fast flicks leave big gaps between recorded points), drop everything
 * inside the eraser radius, and return the surviving pieces.
 */
function eraseFromStroke(points, x, y, r) {
  if (points.length === 1) return []; // a dot inside the radius just disappears

  const step = 0.006;
  const resampled = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1], [bx, by] = points[i];
    const n = Math.min(40, Math.floor(Math.hypot(bx - ax, by - ay) / step));
    if (n <= 1) { resampled.push(points[i]); continue; }
    for (let k = 1; k <= n; k++) {
      resampled.push([round3(ax + ((bx - ax) * k) / n), round3(ay + ((by - ay) * k) / n)]);
    }
  }

  const fragments = [];
  let run = [];
  for (const pt of resampled) {
    if (Math.hypot(pt[0] - x, pt[1] - y) <= r) {
      if (run.length >= 2) fragments.push(run);
      run = [];
    } else {
      run.push(pt);
    }
  }
  if (run.length >= 2) fragments.push(run);

  // keep fragments under the point cap by thinning, never by cutting
  return fragments.map(f => {
    while (f.length > MAX_STROKE_POINTS) f = f.filter((_, i) => i % 2 === 0);
    return f;
  });
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
    timerSecs: room.timerSecs || 0,
    turnDeadline: room.status === 'playing' ? room.turnDeadline : null,
    themeLabel: room.status === 'lobby' ? null : (THEMES[room.theme] || THEMES.classic).label,
    players: room.players.map(p => ({
      name: p.name,
      color: p.color,
      connected: p.connected,
      isHost: p.token === room.hostToken,
      isActive: active ? p.token === active.token : false,
    })),
  };
}

function broadcast(room) {
  touch(room); // every state change broadcasts, so this tracks liveness
  io.to(room.code).emit('room_update', roomSummary(room));
}

/** Private payload for the active player only. */
function turnPayload(room) {
  return {
    turnIndex: room.turnIndex,
    turnsTotal: room.turnsTotal,
    promptType: room.turnIndex === 0 ? 'starter' : 'hint',
    prompt: room.turnIndex === 0 ? themeStarter(room) : room.currentHint,
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
// Stale-room sweep — rooms never expire on their own, so without this the
// state file becomes a graveyard of abandoned lobbies.
// ---------------------------------------------------------------------------

const SWEEP_INTERVAL = 10 * 60 * 1000;
const REVEAL_TTL = 6 * 60 * 60 * 1000;  // finished games linger a few hours
const IDLE_TTL = 24 * 60 * 60 * 1000;   // anything else gets a full day

function touch(room) {
  room.lastActivity = Date.now();
}

function sweepStaleRooms() {
  const now = Date.now();
  let removed = 0;
  for (const room of [...rooms.values()]) {
    if (room.players.some(p => p.connected)) continue; // someone's still here
    const ttl = room.status === 'reveal' ? REVEAL_TTL : IDLE_TTL;
    if (now - room.lastActivity > ttl) {
      clearTurnDeadline(room);
      rooms.delete(room.code);
      removed++;
    }
  }
  if (removed) {
    console.log(`Swept ${removed} stale room(s); ${rooms.size} remain`);
    save();
  }
}

// ---------------------------------------------------------------------------
// Host migration — a room must never be bricked because the host's phone
// died. If the host stays disconnected while others are present, the
// longest-tenured connected player inherits the crown.
// ---------------------------------------------------------------------------

const HOST_AWOL_MS = 60 * 1000;

function migrateHost(room, newHost) {
  room.hostToken = newHost.token;
  room.hostAwolSince = null;
  save();
  broadcast(room);
  io.to(room.code).emit('error_msg', `👑 ${newHost.name} is now the host.`);
}

function checkHostMigration(room) {
  const host = findPlayer(room, room.hostToken);
  const fallback = room.players.find(p => p.connected && p.token !== room.hostToken);
  if ((host && host.connected) || !fallback) {
    room.hostAwolSince = null;
    return;
  }
  if (!room.hostAwolSince) {
    room.hostAwolSince = Date.now(); // start the clock; maybe they're refreshing
  } else if (Date.now() - room.hostAwolSince > HOST_AWOL_MS) {
    migrateHost(room, fallback);
  }
}

setInterval(() => {
  for (const room of rooms.values()) checkHostMigration(room);
}, 20 * 1000);

// ---------------------------------------------------------------------------
// Turn timer — host opt-in. When the deadline passes, the turn auto-skips
// to the next player (the hint passes along, same as a manual skip).
// Deadlines persist with the room; the setTimeout handles live in this Map.
// ---------------------------------------------------------------------------

const turnTimers = new Map(); // room code → Timeout

function setTurnDeadline(room) {
  room.turnDeadline = room.timerSecs ? Date.now() + room.timerSecs * 1000 : null;
  armTurnTimer(room);
}

function clearTurnDeadline(room) {
  room.turnDeadline = null;
  const t = turnTimers.get(room.code);
  if (t) { clearTimeout(t); turnTimers.delete(room.code); }
}

function armTurnTimer(room) {
  const t = turnTimers.get(room.code);
  if (t) clearTimeout(t);
  if (!room.turnDeadline) return;
  turnTimers.set(room.code, setTimeout(() => {
    turnTimers.delete(room.code);
    autoSkipTurn(room);
  }, Math.max(0, room.turnDeadline - Date.now())));
}

function autoSkipTurn(room) {
  if (!rooms.has(room.code) || room.status !== 'playing' || !room.turnDeadline) return;
  if (room.turnDeadline > Date.now() + 500) return armTurnTimer(room); // deadline moved
  const skipped = findPlayer(room, activeToken(room));
  room.orderPos = (room.orderPos + 1) % room.order.length;
  setTurnDeadline(room); // fresh clock for the next player
  save();
  broadcast(room);
  sendTurnToActivePlayer(room);
  if (skipped) {
    io.to(room.code).emit('error_msg', `⏰ ${skipped.name} ran out of time — passing the turn!`);
  }
}

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------

async function prepareTurn(room) {
  if (room.turnIndex === 0) {
    room.status = 'playing';
    room.currentHint = null;
    setTurnDeadline(room);
    save();
    broadcast(room);
    sendTurnToActivePlayer(room);
    return;
  }

  room.status = 'thinking';
  save();
  broadcast(room);

  const hintOpts = {
    isFinalTurn: room.turnIndex === room.turnsTotal - 1,
    turnIndex: room.turnIndex,
    turnsTotal: room.turnsTotal,
    theme: (THEMES[room.theme] || THEMES.classic).flavor,
  };
  let hint;
  try {
    hint = await generateHint(fullStory(room), hintOpts);
  } catch (err) {
    console.error('generateHint failed, retrying once:', err.message);
    try {
      hint = await generateHint(fullStory(room), hintOpts);
    } catch (err2) {
      console.error('generateHint failed again, using fallback:', err2.message);
      hint = FALLBACK_HINT;
    }
  }

  // The room may have been reset/ended while we waited on the AI.
  if (room.status !== 'thinking') return;

  room.currentHint = hint;
  room.status = 'playing';
  setTurnDeadline(room); // the clock starts when the player gets their hint
  save();
  broadcast(room);
  sendTurnToActivePlayer(room);
}

async function finishStory(room) {
  room.status = 'titling';
  clearTurnDeadline(room);
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
  // Performance mode: nothing is revealed yet — the host unveils passage by
  // passage. Text is only sent to clients as each step is revealed, so the
  // no-peeking guarantee holds right up to the moment each line is shown.
  room.revealed = 0;
  room.revealDone = false;
  room.votes = {};
  room.voteResult = null;
  archiveStory(room);
  save();
  broadcast(room);
  io.to(room.code).emit('reveal_begin', { total: room.contributions.length });
}

function revealStep(room, i) {
  const c = room.contributions[i];
  return { index: i, total: room.contributions.length, name: c.name, text: c.text, hint: c.hint };
}

function completeReveal(room) {
  room.revealDone = true;
  room.revealed = room.contributions.length;
  save();
  io.to(room.code).emit('reveal_complete', revealPayload(room));
  broadcastVoteProgress(room);
}

// ---------------------------------------------------------------------------
// Funniest-line vote — runs on the reveal screen once everything is shown.
// ---------------------------------------------------------------------------

function eligibleVoters(room) {
  return room.players.filter(p => p.connected);
}

function broadcastVoteProgress(room) {
  if (room.voteResult) return;
  io.to(room.code).emit('vote_update', {
    voted: Object.keys(room.votes).length,
    eligible: eligibleVoters(room).length,
  });
}

function maybeTallyVotes(room) {
  const eligible = eligibleVoters(room);
  if (eligible.length && eligible.every(p => room.votes[p.token] !== undefined)) {
    tallyVotes(room);
  }
}

function tallyVotes(room) {
  if (room.voteResult) return;
  const counts = room.contributions.map(() => 0);
  for (const idx of Object.values(room.votes)) counts[idx]++;
  const max = Math.max(0, ...counts);
  const winners = max > 0 ? counts.flatMap((c, i) => (c === max ? [i] : [])) : [];
  room.voteResult = { counts, winners };
  // crown the winners in the permanent archive too
  if (room.archiveId) {
    const entry = archive.find(s => s.id === room.archiveId);
    if (entry) {
      entry.voteWinners = winners;
      entry.voteCounts = counts;
      atomicWrite(STORIES_FILE, JSON.stringify(archive, null, 2));
    }
  }
  save();
  io.to(room.code).emit('vote_result', room.voteResult);
}

// Resume any AI work that was in flight when the server last stopped.
function resumePendingWork() {
  for (const room of rooms.values()) {
    if (room.status === 'thinking') prepareTurn(room);
    else if (room.status === 'titling') finishStory(room);
    else if (room.status === 'playing' && room.turnDeadline) {
      // Give the active player a grace window after a restart instead of
      // skipping them the instant the server comes back.
      room.turnDeadline = Math.max(room.turnDeadline, Date.now() + 30 * 1000);
      armTurnTimer(room);
    }
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
      players: [{ token, name, color: COLORS[crypto.randomInt(COLORS.length)], connected: true, socketId: socket.id }],
      order: [],
      orderPos: 0,
      canvas: { strokes: [], nextId: 1 },
      contributions: [],
      currentHint: null,
      title: null,
      lastActivity: Date.now(),
      timerSecs: 0,
      turnDeadline: null,
      theme: 'classic',
      revealed: 0,
      revealDone: false,
      votes: {},
      voteResult: null,
      archiveId: null,
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
    room.players.push({ token, name: finalName, color: pickColor(room), connected: true, socketId: socket.id });
    // Mid-game joiners go to the back of the turn rotation. They write blind
    // like everyone else, so joining late is perfectly fair.
    if (room.status !== 'lobby') room.order.push(token);
    attach(room, token);
    save();
    broadcast(room);
    cb({ ok: true, code: room.code, token, name: finalName, canvas: publicStrokes(room) });
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

    const view = {
      ok: true,
      name: player.name,
      summary: roomSummary(room),
      canvas: publicStrokes(room),
    };
    if (room.status === 'playing' && activeToken(room) === token) {
      view.yourTurn = turnPayload(room); // private — only this socket
    }
    if (room.status === 'reveal') {
      if (room.revealDone) {
        view.reveal = revealPayload(room);
        view.voteState = {
          voted: Object.keys(room.votes).length,
          eligible: eligibleVoters(room).length,
          myVote: room.votes[token] !== undefined ? room.votes[token] : null,
          result: room.voteResult,
        };
      } else {
        // mid-performance: only the passages revealed so far
        view.revealProgress = {
          total: room.contributions.length,
          steps: room.contributions.slice(0, room.revealed)
            .map((c, i) => revealStep(room, i)),
        };
      }
    }
    cb(view);
  });

  socket.on('start_game', ({ turns, timerSecs, theme }) => {
    const room = getRoom();
    if (!room || !isHost(room) || room.status !== 'lobby') return;
    if (room.players.length < 2) {
      return socket.emit('error_msg', 'You need at least 2 players.');
    }
    room.turnsTotal = Math.min(30, Math.max(2, parseInt(turns, 10) || DEFAULT_TURNS));
    room.timerSecs = [0, 60, 90, 120].includes(+timerSecs) ? +timerSecs : 0;
    room.theme = resolveTheme(theme);
    room.turnIndex = 0;
    room.contributions = [];
    room.title = null;
    // Shuffle the turn order every game — otherwise the host always opens
    // and the rotation is just join order.
    room.order = room.players.map(p => p.token);
    for (let i = room.order.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [room.order[i], room.order[j]] = [room.order[j], room.order[i]];
    }
    room.orderPos = 0;
    room.canvas = { strokes: [], nextId: 1 };
    io.to(room.code).emit('canvas_state', []);
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
      hint: room.turnIndex === 0 ? themeStarter(room) : room.currentHint,
    });
    room.turnIndex++;
    room.orderPos = (room.orderPos + 1) % room.order.length;
    clearTurnDeadline(room); // prepareTurn starts a fresh clock with the hint

    if (room.turnIndex >= room.turnsTotal) finishStory(room);
    else prepareTurn(room);
  });

  // Host can skip a stuck/disconnected player; the hint just passes to the
  // next player in the rotation. The skipped player keeps their seat.
  socket.on('skip_turn', () => {
    const room = getRoom();
    if (!room || !isHost(room) || room.status !== 'playing') return;
    room.orderPos = (room.orderPos + 1) % room.order.length;
    setTurnDeadline(room); // fresh clock for the next player
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

  // ---- paced reveal + voting ----------------------------------------------

  socket.on('reveal_next', () => {
    const room = getRoom();
    if (!room || !isHost(room) || room.status !== 'reveal' || room.revealDone) return;
    if (room.revealed < room.contributions.length) {
      const step = revealStep(room, room.revealed++);
      save();
      io.to(room.code).emit('reveal_step', step);
    } else {
      completeReveal(room); // one tap past the last passage = the title finale
    }
  });

  socket.on('reveal_all', () => {
    const room = getRoom();
    if (!room || !isHost(room) || room.status !== 'reveal' || room.revealDone) return;
    completeReveal(room);
  });

  socket.on('cast_vote', ({ index }) => {
    const room = getRoom();
    if (!room || room.status !== 'reveal' || !room.revealDone || room.voteResult) return;
    const player = findPlayer(room, socket.data.token);
    if (!player) return;
    index = parseInt(index, 10);
    const c = room.contributions[index];
    if (!c || c.token === player.token) return; // no voting for your own line
    room.votes[player.token] = index; // re-votes allowed until the tally
    save();
    broadcastVoteProgress(room);
    maybeTallyVotes(room);
  });

  socket.on('end_vote', () => {
    const room = getRoom();
    if (!room || !isHost(room) || room.status !== 'reveal' || !room.revealDone) return;
    tallyVotes(room);
  });

  // Host resets the room to the lobby; players stay, story is wiped.
  socket.on('new_game', () => {
    const room = getRoom();
    if (!room || !isHost(room) || room.status !== 'reveal') return;
    clearTurnDeadline(room);
    Object.assign(room, {
      status: 'lobby', turnIndex: 0, order: [], orderPos: 0,
      contributions: [], currentHint: null, title: null,
      canvas: { strokes: [], nextId: 1 },
      revealed: 0, revealDone: false, votes: {}, voteResult: null, archiveId: null,
    });
    save();
    broadcast(room);
    io.to(room.code).emit('canvas_state', []);
  });

  // ---- communal doodle canvas (waiting screens) ----------------------------

  socket.on('draw_stroke', ({ points, width, tag }) => {
    const room = getRoom();
    if (!room || !['playing', 'thinking', 'titling'].includes(room.status)) return;
    const player = findPlayer(room, socket.data.token);
    if (!player || !Array.isArray(points)) return;
    if (room.canvas.strokes.length >= MAX_STROKES) {
      return socket.emit('error_msg', 'The doodle canvas is full!');
    }

    // Truncate at the first invalid point rather than filtering it out —
    // filtering would stitch the points around a glitch into a phantom
    // straight line the player never drew.
    // NB: typeof check matters — Infinity from a glitched client serializes
    // to null over JSON, and +null would silently coerce to 0 (the corner!).
    const pts = [];
    for (const p of points.slice(0, MAX_STROKE_POINTS)) {
      if (!Array.isArray(p) || typeof p[0] !== 'number' || typeof p[1] !== 'number') break;
      const x = round3(p[0]), y = round3(p[1]);
      if (![x, y].every(v => Number.isFinite(v) && v >= -0.05 && v <= 1.05)) break;
      pts.push([x, y]);
    }
    if (!pts.length) return;

    const stroke = {
      id: room.canvas.nextId++,
      token: player.token,            // ownership — never sent to clients
      name: player.name,
      color: player.color,            // server-assigned; client can't spoof it
      width: Math.min(0.02, Math.max(0.002, +width || 0.006)),
      points: pts,
    };
    room.canvas.strokes.push(stroke);
    touch(room); // doodling doesn't broadcast room_update, so track it here
    saveSoon();
    const { token, ...pub } = stroke;
    pub.tag = typeof tag === 'string' ? tag.slice(0, 16) : undefined;
    io.to(room.code).emit('stroke_added', pub);
  });

  // Live preview while someone draws: relay point batches to everyone else
  // in the room. Ephemeral — nothing is stored; the draw_stroke commit on
  // pointerup is the authoritative version.
  socket.on('stroke_progress', ({ tag, points, width }) => {
    const room = getRoom();
    if (!room || !['playing', 'thinking', 'titling'].includes(room.status)) return;
    const player = findPlayer(room, socket.data.token);
    if (!player || !Array.isArray(points)) return;

    const pts = [];
    for (const p of points.slice(0, 60)) {
      if (!Array.isArray(p) || typeof p[0] !== 'number' || typeof p[1] !== 'number') break;
      const x = round3(p[0]), y = round3(p[1]);
      if (![x, y].every(v => Number.isFinite(v) && v >= -0.05 && v <= 1.05)) break;
      pts.push([x, y]);
    }
    if (!pts.length) return;

    socket.to(room.code).emit('stroke_progress', {
      name: player.name,
      color: player.color, // server-assigned, same as committed strokes
      width: Math.min(0.02, Math.max(0.002, +width || 0.006)),
      tag: typeof tag === 'string' ? tag.slice(0, 16) : '',
      points: pts,
    });
  });

  // Real-eraser semantics: rub out only the area under the cursor. Affected
  // strokes are split into surviving fragments. Own ink only, enforced here.
  socket.on('erase_at', ({ x, y, r }) => {
    const room = getRoom();
    if (!room || !['playing', 'thinking', 'titling'].includes(room.status)) return;
    x = +x; y = +y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    r = Math.min(0.06, Math.max(0.01, +r || 0.025));

    const hit = room.canvas.strokes.filter(s =>
      s.token === socket.data.token && nearStroke(s, x, y, r));
    if (!hit.length) return;

    for (const stroke of hit) {
      room.canvas.strokes = room.canvas.strokes.filter(s => s.id !== stroke.id);
      io.to(room.code).emit('stroke_removed', { id: stroke.id });
      for (const pts of eraseFromStroke(stroke.points, x, y, r)) {
        const frag = { ...stroke, id: room.canvas.nextId++, points: pts };
        room.canvas.strokes.push(frag);
        const { token, ...pub } = frag;
        io.to(room.code).emit('stroke_added', pub);
      }
    }
    touch(room);
    saveSoon();
  });

  socket.on('clear_my_strokes', () => {
    const room = getRoom();
    if (!room) return;
    const ids = room.canvas.strokes
      .filter(s => s.token === socket.data.token)
      .map(s => s.id);
    if (!ids.length) return;
    room.canvas.strokes = room.canvas.strokes.filter(s => s.token !== socket.data.token);
    touch(room);
    saveSoon();
    io.to(room.code).emit('strokes_removed', { ids });
  });

  socket.on('leave_room', () => {
    const room = getRoom();
    if (!room) return;
    const idx = room.players.findIndex(p => p.token === socket.data.token);
    if (idx === -1) return;
    const wasHost = room.players[idx].token === room.hostToken;
    if (room.status === 'lobby') room.players.splice(idx, 1);
    else room.players[idx].connected = false;
    socket.leave(room.code);
    socket.data.code = socket.data.token = undefined;
    // An explicit departure hands the crown over immediately.
    if (wasHost && room.players.length) {
      const heir = room.players.find(p => p.connected) || room.players[0];
      migrateHost(room, heir);
    }
    if (room.players.length === 0) {
      clearTurnDeadline(room);
      rooms.delete(room.code);
    } else {
      broadcast(room);
    }
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
      // a vote may now be unanimous among those still here
      if (room.status === 'reveal' && room.revealDone && !room.voteResult) {
        broadcastVoteProgress(room);
        maybeTallyVotes(room);
      }
    }
  });
});

// ---------------------------------------------------------------------------

load();
loadStories();
sweepStaleRooms();
setInterval(sweepStaleRooms, SWEEP_INTERVAL);
server.listen(PORT, () => {
  console.log(`Crossed Wires running at http://localhost:${PORT}`);
  resumePendingWork();
});
