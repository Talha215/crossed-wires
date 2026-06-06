// client.js — Crossed Wires browser client.
// The client only ever knows: room summaries, its own hint (when it's the
// active player), and the final reveal. It never receives prior story text.

/* global io */
const socket = io();

const $ = id => document.getElementById(id);
const screens = ['home', 'lobby', 'game', 'reveal'];

let session = null;       // { code, token, name } — persisted for reconnects
let summary = null;       // latest room_update
let myTurn = null;        // payload of last your_turn (valid while turnIndex matches)
let revealData = null;    // full reveal payload (only after the performance ends)
let perf = null;          // { steps: [], total } while the host unveils passages
let voteState = { voted: 0, eligible: 0 };
let myVote = null;        // index I voted for
let voteResult = null;    // { counts, winners } once tallied
let speaking = false;

// ---------------------------------------------------------------------------
// Session persistence (survives refresh + server restart)
// ---------------------------------------------------------------------------

const SESSION_KEY = 'crossed-wires-session';

function saveSession(s) {
  session = s;
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); }
  catch { return null; }
}

// ---------------------------------------------------------------------------
// Sounds (synthesized — no audio files needed)
// ---------------------------------------------------------------------------

let audioCtx = null;

// Browsers only allow audio after a user gesture; arm/resume the context on
// any tap or keypress so the sound can play when someone later joins.
function ensureAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  startMusic();
}
document.addEventListener('pointerdown', ensureAudio);
document.addEventListener('keydown', ensureAudio);

// Cheerful two-note "ding" (C5 → G5) when a player joins.
function playJoinSound() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t = audioCtx.currentTime;
  for (const [freq, dt] of [[523.25, 0], [783.99, 0.09]]) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t + dt);
    gain.gain.exponentialRampToValueAtTime(0.22, t + dt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.32);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t + dt);
    osc.stop(t + dt + 0.35);
  }
}

// ---------------------------------------------------------------------------
// Turn alerts — players are usually tabbed into Discord when their turn
// arrives. Chime + flashing tab title always; browser notifications are
// opt-in via the bell button (they reach a fully hidden tab).
// ---------------------------------------------------------------------------

const NOTIFY_KEY = 'crossed-wires-notify';
const BASE_TITLE = document.title;
let notifyPref = localStorage.getItem(NOTIFY_KEY) === '1';
let titleFlashTimer = null;
let lastAlertedTurn = -1; // alert once per turn, not on every re-render

// Three rising notes (E5 → G5 → C6) — unmissable next to the join ding.
function playTurnChime() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t = audioCtx.currentTime;
  for (const [freq, dt] of [[659.25, 0], [783.99, 0.12], [1046.5, 0.24]]) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t + dt);
    gain.gain.exponentialRampToValueAtTime(0.3, t + dt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.4);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t + dt);
    osc.stop(t + dt + 0.45);
  }
}

function startTitleFlash() {
  if (titleFlashTimer) return;
  let on = false;
  titleFlashTimer = setInterval(() => {
    on = !on;
    document.title = on ? '🔔 YOUR TURN!' : BASE_TITLE;
  }, 900);
}

function stopTitleFlash() {
  if (!titleFlashTimer) return;
  clearInterval(titleFlashTimer);
  titleFlashTimer = null;
  document.title = BASE_TITLE;
}

// Coming back to the tab acknowledges the alert.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) stopTitleFlash();
});

function fireTurnAlert() {
  playTurnChime();
  if (document.hidden) {
    startTitleFlash();
    if (notifyPref && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification('Crossed Wires', { body: "It's your turn to write!" });
      n.onclick = () => { window.focus(); n.close(); };
    }
  }
}

function updateNotifyButton() {
  const btn = $('btn-notify');
  if (!('Notification' in window)) return; // stays hidden (e.g. iOS Safari)
  btn.hidden = false;
  const active = notifyPref && Notification.permission === 'granted';
  btn.textContent = active ? '🔔' : '🔕';
  btn.title = active
    ? 'Turn notifications are on'
    : "Notify me when it's my turn";
}

$('btn-notify').addEventListener('click', async () => {
  if (notifyPref && Notification.permission === 'granted') {
    notifyPref = false;
    toast('Turn notifications off.');
  } else {
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      notifyPref = true;
      toast("You'll get a notification when it's your turn.");
    } else {
      notifyPref = false;
      toast('Notifications are blocked in your browser settings.');
    }
  }
  localStorage.setItem(NOTIFY_KEY, notifyPref ? '1' : '0');
  updateNotifyButton();
});

// ---------------------------------------------------------------------------
// Background music — a procedural lo-fi loop, synthesized live.
// Four-chord progression with soft pads, a gentle bass, and sparse plucks.
// ---------------------------------------------------------------------------

const MUSIC_KEY = 'crossed-wires-music';
const musicPrefs = { vol: 35, muted: false };
try { Object.assign(musicPrefs, JSON.parse(localStorage.getItem(MUSIC_KEY)) || {}); } catch {}

let musicVolGain = null;   // user volume + mute
let musicDuckGain = null;  // dipped while "Read aloud" speaks
let musicTimer = null;
let nextBarTime = 0;
let barIndex = 0;

const BPM = 72;
const BAR_LEN = (60 / BPM) * 4; // 4 beats per bar
const midiHz = m => 440 * Math.pow(2, (m - 69) / 12);

const CHORDS = [ // Cmaj7 → Am7 → Fmaj7 → G7
  { pad: [60, 64, 67, 71], bass: 36 },
  { pad: [57, 60, 64, 67], bass: 45 },
  { pad: [53, 57, 60, 64], bass: 41 },
  { pad: [55, 59, 62, 65], bass: 43 },
];
const MELODY = [72, 74, 76, 79, 81, 84]; // C major pentatonic

function musicGainValue() {
  // squared for a perceptually even slider
  return musicPrefs.muted ? 0 : Math.pow(musicPrefs.vol / 100, 2) * 0.9;
}

function applyMusicVolume() {
  if (musicVolGain) {
    musicVolGain.gain.setTargetAtTime(musicGainValue(), audioCtx.currentTime, 0.05);
  }
  $('btn-mute').textContent = musicPrefs.muted || musicPrefs.vol === 0 ? '🔇' : '🎵';
  localStorage.setItem(MUSIC_KEY, JSON.stringify(musicPrefs));
}

function note(freq, type, start, peak, attack, end) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  osc.connect(gain).connect(musicDuckGain);
  osc.start(start);
  osc.stop(end + 0.05);
}

function scheduleBar(t, i) {
  const chord = CHORDS[i % CHORDS.length];
  const beat = BAR_LEN / 4;

  for (const m of chord.pad) {                       // slow warm pad
    note(midiHz(m), 'triangle', t, 0.045, 0.8, t + BAR_LEN + 0.6);
  }
  for (const b of [0, 2]) {                          // bass on beats 1 & 3
    note(midiHz(chord.bass), 'sine', t + b * beat, 0.16, 0.04, t + b * beat + 1.4);
  }
  for (let s = 0; s < 8; s++) {                      // sparse random plucks
    if (Math.random() < 0.3) {
      const m = MELODY[Math.floor(Math.random() * MELODY.length)];
      note(midiHz(m), 'sine', t + s * (beat / 2), 0.09, 0.01, t + s * (beat / 2) + 0.5);
    }
  }
}

// Look-ahead scheduler: keep ~2.5s of music queued so timer throttling in
// background tabs doesn't cause gaps.
function startMusic() {
  if (musicTimer || !audioCtx) return;
  musicDuckGain = audioCtx.createGain();
  musicVolGain = audioCtx.createGain();
  musicVolGain.gain.value = musicGainValue();
  musicDuckGain.connect(musicVolGain).connect(audioCtx.destination);

  nextBarTime = audioCtx.currentTime + 0.1;
  musicTimer = setInterval(() => {
    while (nextBarTime < audioCtx.currentTime + 2.5) {
      scheduleBar(nextBarTime, barIndex++);
      nextBarTime += BAR_LEN;
    }
  }, 300);
}

function duckMusic(ducked) {
  if (musicDuckGain) {
    musicDuckGain.gain.setTargetAtTime(ducked ? 0.2 : 1, audioCtx.currentTime, 0.4);
  }
}

$('btn-mute').addEventListener('click', () => {
  musicPrefs.muted = !musicPrefs.muted;
  applyMusicVolume();
});

$('music-volume').addEventListener('input', () => {
  musicPrefs.vol = +$('music-volume').value;
  if (musicPrefs.vol > 0) musicPrefs.muted = false; // dragging up implies unmute
  applyMusicVolume();
});

// ---------------------------------------------------------------------------
// Communal doodle canvas — shown on waiting screens, synced through the
// server. Coordinates are normalized to [0,1] so every device sees the same
// picture regardless of screen size (the canvas keeps a fixed 4:3 ratio).
// ---------------------------------------------------------------------------

let canvasStrokes = [];   // authoritative strokes from the server
let pendingStrokes = [];  // sent, awaiting the server's echo
let currentStroke = null; // being drawn right now
let drawMode = 'draw';    // 'draw' | 'erase'

const dCanvas = $('doodle-canvas');
const dCtx = dCanvas.getContext('2d');
const STROKE_WIDTH = 0.006;
const ERASE_R = 0.02;     // eraser radius (normalized)
let erasePos = null;      // eraser ring position while in erase mode
const liveStrokes = new Map(); // other players' in-progress strokes, by name|tag

function myColor() {
  const p = summary && session && summary.players.find(p => p.name === session.name);
  return (p && p.color) || '#aaa';
}

function strokePath(ctx, s, W, H) {
  const w = Math.max(1.5, s.width * W);
  ctx.strokeStyle = ctx.fillStyle = s.color;
  ctx.lineWidth = w;
  ctx.lineCap = ctx.lineJoin = 'round';
  const pts = s.points;
  if (pts.length === 1) { // a single tap = a dot
    ctx.beginPath();
    ctx.arc(pts[0][0] * W, pts[0][1] * H, w / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0][0] * W, pts[0][1] * H);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * W, pts[i][1] * H);
  ctx.stroke();
}

function redrawDoodle() {
  dCtx.clearRect(0, 0, dCanvas.width, dCanvas.height);
  for (const s of [...canvasStrokes, ...pendingStrokes]) {
    strokePath(dCtx, s, dCanvas.width, dCanvas.height);
  }
  for (const [key, live] of liveStrokes) {
    // drop live strokes whose final commit never arrived (drawer vanished)
    if (performance.now() - live.ts > 10000) { liveStrokes.delete(key); continue; }
    strokePath(dCtx, live, dCanvas.width, dCanvas.height);
  }
  if (currentStroke) strokePath(dCtx, currentStroke, dCanvas.width, dCanvas.height);
  if (drawMode === 'erase' && erasePos) { // eraser ring cursor
    dCtx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    dCtx.lineWidth = 1.5;
    dCtx.beginPath();
    dCtx.arc(erasePos[0] * dCanvas.width, erasePos[1] * dCanvas.height,
      ERASE_R * dCanvas.width, 0, Math.PI * 2);
    dCtx.stroke();
  }
}

// Size the canvas to the largest 4:3 box that fits the viewport. A fixed
// aspect ratio keeps the picture identical on every device — a full-bleed
// canvas would stretch everyone's drawings differently.
function sizeDoodle() {
  if (!dCanvas.offsetParent) return; // not visible right now
  const avail = Math.max(260, window.innerHeight - dCanvas.getBoundingClientRect().top - 86);
  const cssW = Math.min(dCanvas.parentElement.clientWidth, avail * (4 / 3));
  dCanvas.style.width = cssW + 'px';
  const dpr = window.devicePixelRatio || 1;
  const pxW = Math.round(dCanvas.clientWidth * dpr);
  if (dCanvas.width !== pxW) {
    dCanvas.width = pxW;
    dCanvas.height = Math.round(dCanvas.clientHeight * dpr);
  }
  redrawDoodle();
}
window.addEventListener('resize', sizeDoodle);

// Returns normalized [x, y], clamped to the canvas; null if the canvas has
// no size (e.g. a pointer event straggling in after the screen switched).
function evtPos(e) {
  const r = dCanvas.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return [
    Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  ];
}

let lastEraseSent = 0;
function sendErase(p) {
  if (performance.now() - lastEraseSent < 25) return; // ~40Hz cap
  lastEraseSent = performance.now();
  socket.emit('erase_at', { x: p[0], y: p[1], r: ERASE_R });
}

// Live streaming: batch the points drawn since the last flush (~every 50ms)
// so other players watch the stroke appear in real time. These packets are
// ephemeral — the draw_stroke commit on pointerup is what actually persists.
let progressBuf = [];
let lastProgressSent = 0;

function flushProgress() {
  if (!currentStroke || !progressBuf.length) return;
  socket.emit('stroke_progress', {
    tag: currentStroke.tag,
    width: currentStroke.width,
    points: progressBuf,
  });
  progressBuf = [];
  lastProgressSent = performance.now();
}

dCanvas.addEventListener('pointerdown', e => {
  e.preventDefault();
  dCanvas.setPointerCapture(e.pointerId);
  const p = evtPos(e);
  if (!p) return;
  if (drawMode === 'erase') {
    erasePos = p;
    sendErase(p);
    redrawDoodle();
    return;
  }
  currentStroke = {
    color: myColor(),
    width: STROKE_WIDTH,
    points: [p],
    tag: Math.random().toString(36).slice(2, 10),
  };
  progressBuf = [p];
  flushProgress(); // others see the stroke start immediately
  redrawDoodle();
});

dCanvas.addEventListener('pointermove', e => {
  const p = evtPos(e);
  if (!p) return;
  if (drawMode === 'erase') {
    erasePos = p;
    if (e.buttons) sendErase(p);
    redrawDoodle(); // keeps the ring under the cursor
    return;
  }
  if (!e.buttons || !currentStroke) return;
  const last = currentStroke.points[currentStroke.points.length - 1];
  if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.004) return;
  currentStroke.points.push(p);
  progressBuf.push(p);
  if (performance.now() - lastProgressSent > 50) flushProgress();
  // draw just the new segment — no full redraw per move
  const W = dCanvas.width, H = dCanvas.height;
  dCtx.strokeStyle = currentStroke.color;
  dCtx.lineWidth = Math.max(1.5, currentStroke.width * W);
  dCtx.lineCap = 'round';
  dCtx.beginPath();
  dCtx.moveTo(last[0] * W, last[1] * H);
  dCtx.lineTo(p[0] * W, p[1] * H);
  dCtx.stroke();
});

dCanvas.addEventListener('pointerleave', () => { erasePos = null; redrawDoodle(); });

function finishStroke() {
  if (!currentStroke) return;
  const stroke = currentStroke;
  pendingStrokes.push(stroke); // keep it on screen until the server echoes it
  socket.emit('draw_stroke', { points: stroke.points, width: stroke.width, tag: stroke.tag });
  currentStroke = null;
  progressBuf = [];
}
dCanvas.addEventListener('pointerup', finishStroke);
dCanvas.addEventListener('pointercancel', finishStroke);

socket.on('canvas_state', strokes => {
  canvasStrokes = strokes;
  pendingStrokes = [];
  liveStrokes.clear();
  redrawDoodle();
});

// Another player's pen is moving — extend their live stroke segment by segment.
socket.on('stroke_progress', s => {
  const key = `${s.name}|${s.tag}`;
  let live = liveStrokes.get(key);
  if (!live) {
    live = { color: s.color, width: s.width, points: [] };
    liveStrokes.set(key, live);
  }
  live.ts = performance.now();
  const W = dCanvas.width, H = dCanvas.height;
  dCtx.strokeStyle = live.color;
  dCtx.lineWidth = Math.max(1.5, live.width * W);
  dCtx.lineCap = 'round';
  for (const pt of s.points) {
    const prev = live.points[live.points.length - 1];
    if (prev) {
      dCtx.beginPath();
      dCtx.moveTo(prev[0] * W, prev[1] * H);
      dCtx.lineTo(pt[0] * W, pt[1] * H);
      dCtx.stroke();
    }
    live.points.push(pt);
  }
});

socket.on('stroke_added', stroke => {
  if (stroke.tag) {
    pendingStrokes = pendingStrokes.filter(p => p.tag !== stroke.tag);
    liveStrokes.delete(`${stroke.name}|${stroke.tag}`); // commit replaces the live preview
  }
  canvasStrokes.push(stroke);
  strokePath(dCtx, stroke, dCanvas.width, dCanvas.height);
});

socket.on('stroke_removed', ({ id }) => {
  canvasStrokes = canvasStrokes.filter(s => s.id !== id);
  redrawDoodle();
});

socket.on('strokes_removed', ({ ids }) => {
  const gone = new Set(ids);
  canvasStrokes = canvasStrokes.filter(s => !gone.has(s.id));
  redrawDoodle();
});

function setDrawMode(mode) {
  drawMode = mode;
  $('btn-tool-draw').classList.toggle('active', mode === 'draw');
  $('btn-tool-erase').classList.toggle('active', mode === 'erase');
}
$('btn-tool-draw').addEventListener('click', () => setDrawMode('draw'));
$('btn-tool-erase').addEventListener('click', () => setDrawMode('erase'));
$('btn-clear-mine').addEventListener('click', () => socket.emit('clear_my_strokes'));

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function show(name) {
  for (const s of screens) $(`screen-${s}`).hidden = s !== name;
  // The reveal gets a wider layout so hints fit in a side column on desktop.
  document.body.classList.toggle('reveal-wide', name === 'reveal');
  if (name !== 'game') document.body.classList.remove('doodle-wide');
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 3000);
}

function me() {
  return summary && summary.players.find(p => p.name === session.name);
}

function render() {
  if (!summary || !session) { show('home'); return; }

  switch (summary.status) {
    case 'lobby': renderLobby(); break;
    case 'playing':
    case 'thinking':
    case 'titling': renderGame(); break;
    case 'reveal':
      if (revealData || perf) renderReveal();
      else renderGame(); // reveal_begin is on its way
      break;
  }
}

function renderLobby() {
  show('lobby');
  lastAlertedTurn = -1; // fresh game, fresh alerts
  stopTitleFlash();
  $('lobby-code').textContent = summary.code;

  const list = $('lobby-players');
  list.innerHTML = '';
  for (const p of summary.players) {
    const li = document.createElement('li');
    if (!p.connected) li.className = 'offline';
    const dot = document.createElement('span');
    dot.className = 'dot';
    if (p.color) dot.style.background = p.color; // their doodle color
    const name = document.createElement('span');
    name.textContent = p.name + (p.name === session.name ? ' (you)' : '');
    li.append(dot, name);
    if (p.isHost) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'host';
      li.append(badge);
    }
    list.append(li);
  }

  const host = !!(me() && me().isHost);
  $('host-controls').hidden = !host;
  $('guest-wait').hidden = host;
}

function renderGame() {
  show('game');
  $('turn-label').textContent =
    `Turn ${Math.min(summary.turnIndex + 1, summary.turnsTotal)} of ${summary.turnsTotal}` +
    (summary.themeLabel ? ` · ${summary.themeLabel}` : '');
  updateCountdown();

  const amActive = !!(me() && me().isActive);
  const isMyTurn = summary.status === 'playing' &&
    myTurn && myTurn.turnIndex === summary.turnIndex && amActive;
  // Active player goes straight to the your-turn screen while the AI is
  // still writing their hint, instead of watching the generic waiting view.
  const hintPending = summary.status === 'thinking' && amActive;

  $('game-write').hidden = !(isMyTurn || hintPending);
  $('game-waiting').hidden = isMyTurn || hintPending;
  $('story-input').disabled = hintPending;
  $('btn-submit').disabled = hintPending;
  $('btn-submit').textContent = hintPending ? 'Waiting for your hint…' : 'Submit ➤';

  if (isMyTurn) {
    $('prompt-box').textContent = myTurn.promptType === 'starter'
      ? myTurn.prompt
      : `Your secret hint:\n\n${myTurn.prompt}`;
  } else if (hintPending) {
    $('prompt-box').textContent = '🤖 The AI is writing your secret hint — get ready…';
  } else if (summary.status === 'thinking') {
    $('waiting-text').textContent = `🤖 The AI is whispering a hint to ${summary.activeName}…`;
  } else if (summary.status === 'titling') {
    $('waiting-text').textContent = '🎬 The story is done! Coming up with a title…';
  } else if (summary.activeName) {
    $('waiting-text').textContent = `✍️ ${summary.activeName} is writing…`;
  } else {
    $('waiting-text').textContent = '🎬 Getting the reveal ready…';
  }

  const host = !!(me() && me().isHost);
  $('game-host-controls').hidden = !host || summary.status !== 'playing';
  $('btn-skip').hidden = !!isMyTurn; // can't skip yourself mid-write, just submit

  // Alert the player the moment their turn begins (including the get-ready
  // phase while their hint generates) — once per turn.
  if (isMyTurn || hintPending) {
    if (lastAlertedTurn !== summary.turnIndex) {
      lastAlertedTurn = summary.turnIndex;
      fireTurnAlert();
    }
  } else {
    stopTitleFlash(); // turn passed (e.g. skipped) while we were away
  }

  const showDoodle = !(isMyTurn || hintPending);
  // Your turn arrived mid-stroke: commit the ink drawn so far instead of
  // letting stray pointer events corrupt it while the canvas is hidden.
  if (!showDoodle && currentStroke) finishStroke();
  document.body.classList.toggle('doodle-wide', showDoodle);
  if (showDoodle) {
    $('my-color').style.background = myColor();
    requestAnimationFrame(sizeDoodle); // canvas just became visible — size it
  }
}

function hostName() {
  const h = summary && summary.players.find(p => p.isHost);
  return h ? h.name : 'The host';
}

// Builds one story passage span with hint-panel (and voting) behavior.
function buildSeg(story, i, c, isLast) {
  const seg = document.createElement('span');
  seg.className = 'seg';
  if (voteResult && voteResult.winners.includes(i)) {
    seg.classList.add('winner');
    const crown = document.createElement('span');
    crown.textContent = '👑 ';
    seg.append(crown);
  }
  if (myVote === i && !voteResult) seg.classList.add('my-vote');
  seg.append(document.createTextNode(c.text));
  seg.addEventListener('mouseenter', () => showHintPanel(i, seg, c));
  seg.addEventListener('click', e => { e.stopPropagation(); showHintPanel(i, seg, c); });
  story.append(seg);
  if (!isLast) story.append(' ');
  return seg;
}

function renderReveal() {
  show('reveal');
  stopTitleFlash();
  if (revealData) renderFullReveal();
  else renderPerformance();
}

// Performance mode: the host unveils one passage at a time; the client only
// ever has the passages the server has sent so far.
function renderPerformance() {
  const steps = perf ? perf.steps.filter(Boolean) : [];
  const total = perf ? perf.total : 0;

  $('reveal-title').textContent = '🤫 . . .';
  $('reveal-tip').hidden = true;
  $('vote-bar').hidden = true;
  $('reveal-doodle').hidden = true;
  document.querySelector('.reveal-actions').hidden = true;

  const story = $('reveal-story');
  story.innerHTML = '';
  clearHintPanel();
  let lastSeg = null;
  steps.forEach((s, i) => { lastSeg = buildSeg(story, i, s, i === steps.length - 1); });
  // Spotlight the newest passage (auto-open only where the panel is a
  // sidebar, not the mobile bottom sheet).
  if (lastSeg && window.matchMedia('(min-width: 720px)').matches) {
    showHintPanel(steps.length - 1, lastSeg, steps[steps.length - 1]);
  }

  $('perform-bar').hidden = false;
  const isHost = !!(me() && me().isHost);
  $('perform-controls').hidden = !isHost;
  if (isHost) {
    $('perform-status').textContent = steps.length === 0
      ? 'The story is done! Unveil it passage by passage — read them aloud as you go.'
      : '';
    $('btn-reveal-next').textContent = steps.length < total
      ? `▶ Reveal next passage (${steps.length}/${total})`
      : '🎬 Reveal the title!';
  } else {
    $('perform-status').textContent = `🎭 ${hostName()} is unveiling the story (${steps.length}/${total})…`;
  }
}

function renderFullReveal() {
  $('reveal-title').textContent = revealData.title;
  $('reveal-tip').hidden = false;
  $('perform-bar').hidden = true;
  document.querySelector('.reveal-actions').hidden = false;

  const story = $('reveal-story');
  story.innerHTML = '';
  clearHintPanel();
  revealData.contributions.forEach((c, i) =>
    buildSeg(story, i, c, i === revealData.contributions.length - 1));

  renderVoteBar();
  $('btn-new-game').hidden = !(me() && me().isHost);

  // The communal masterpiece, if anyone actually doodled.
  $('reveal-doodle').hidden = canvasStrokes.length === 0;
  if (canvasStrokes.length) {
    requestAnimationFrame(() => {
      const rc = $('reveal-canvas');
      if (!rc.clientWidth) return;
      const dpr = window.devicePixelRatio || 1;
      rc.width = Math.round(rc.clientWidth * dpr);
      rc.height = Math.round(rc.clientHeight * dpr);
      const ctx = rc.getContext('2d');
      for (const s of canvasStrokes) strokePath(ctx, s, rc.width, rc.height);
    });
  }
}

function renderVoteBar() {
  const bar = $('vote-bar');
  if (!revealData) { bar.hidden = true; return; }
  bar.hidden = false;
  if (voteResult) {
    const { counts, winners } = voteResult;
    $('vote-status').textContent = winners.length
      ? '👑 Best line: ' + winners.map(i =>
          `${revealData.contributions[i].name} (turn ${i + 1}, ${counts[i]} vote${counts[i] === 1 ? '' : 's'})`
        ).join(' & ')
      : 'No votes were cast — the real winner was the chaos along the way.';
    $('btn-end-vote').hidden = true;
  } else {
    $('vote-status').textContent =
      `👑 Vote for the best line — tap a passage, then “Vote” on its hint card (${voteState.voted}/${voteState.eligible} voted)`;
    $('btn-end-vote').hidden = !(me() && me().isHost);
  }
}

// Highlight one contribution's sentences and show its author + hint in the
// side panel (a bottom sheet on phones). The selection sticks until another
// passage is hovered/tapped, so the panel never flickers mid-read.
function showHintPanel(i, seg, c) {
  for (const el of document.querySelectorAll('.seg.lit')) el.classList.remove('lit');
  seg.classList.add('lit');
  $('hint-placeholder').hidden = true;
  $('hint-detail').hidden = false;
  $('hint-author').textContent = `Turn ${i + 1} — written by ${c.name}`;
  $('hint-text').textContent = c.hint;
  $('hint-panel').classList.add('active');

  // Voting happens from here: deliberate, and impossible to fat-finger
  // while just browsing hints.
  const voteBtn = $('btn-vote-this');
  const voteActive = revealData && !voteResult;
  const isOwn = session && c.name === session.name;
  voteBtn.hidden = !voteActive || isOwn;
  if (!voteBtn.hidden) {
    voteBtn.textContent = myVote === i ? '✓ Your vote!' : '👑 Vote for this line';
    voteBtn.dataset.index = i;
  }
}

function clearHintPanel() {
  for (const el of document.querySelectorAll('.seg.lit')) el.classList.remove('lit');
  $('hint-placeholder').hidden = false;
  $('hint-detail').hidden = true;
  $('hint-panel').classList.remove('active');
}

// On phones the panel overlays the page — tapping it dismisses it.
// Desktop keeps the sticky panel as-is.
$('hint-panel').addEventListener('click', () => {
  if (window.matchMedia('(max-width: 719.98px)').matches) clearHintPanel();
});

// ---------------------------------------------------------------------------
// Socket events
// ---------------------------------------------------------------------------

socket.on('room_update', s => {
  // A growing player list means someone joined (rejoins/disconnects only
  // flip the connected flag, so they stay silent).
  if (summary && session && s.players.length > summary.players.length) {
    playJoinSound();
  }
  summary = s;
  if (s.status !== 'reveal') {
    revealData = perf = voteResult = myVote = null;
  }
  render();
});

socket.on('your_turn', payload => {
  myTurn = payload;
  $('story-input').value = '';
  updateCharCount();
  render();
});

socket.on('reveal_begin', ({ total }) => {
  perf = { steps: [], total };
  revealData = null;
  myVote = voteResult = null;
  stopSpeaking();
  render();
});

socket.on('reveal_step', step => {
  if (!perf) perf = { steps: [], total: step.total };
  perf.steps[step.index] = step;
  render();
});

socket.on('reveal_complete', payload => {
  revealData = payload;
  perf = null;
  render();
});

socket.on('vote_update', v => {
  voteState = v;
  if (revealData) renderVoteBar();
});

socket.on('vote_result', r => {
  voteResult = r;
  render(); // re-render to crown the winners
});

socket.on('error_msg', toast);

socket.on('connect', () => {
  const saved = session || loadSession();
  if (!saved) return;
  socket.emit('rejoin', saved, res => {
    if (!res.ok) {
      saveSession(null);
      summary = null;
      render();
      return;
    }
    saveSession({ ...saved, name: res.name });
    summary = res.summary;
    if (res.yourTurn) myTurn = res.yourTurn;
    if (res.reveal) revealData = res.reveal;
    if (res.revealProgress) {
      perf = { total: res.revealProgress.total, steps: [] };
      for (const s of res.revealProgress.steps) perf.steps[s.index] = s;
    }
    if (res.voteState) {
      voteState = res.voteState;
      myVote = res.voteState.myVote;
      voteResult = res.voteState.result;
    }
    if (res.canvas) { canvasStrokes = res.canvas; pendingStrokes = []; }
    render();
  });
});

// ---------------------------------------------------------------------------
// Home screen
// ---------------------------------------------------------------------------

function homeError(msg) {
  const el = $('home-error');
  el.textContent = msg;
  el.hidden = !msg;
}

$('btn-create').addEventListener('click', () => {
  const name = $('name-input').value.trim();
  if (!name) return homeError('Enter a name first.');
  socket.emit('create_room', { name }, res => {
    if (!res.ok) return homeError(res.error);
    homeError('');
    saveSession({ code: res.code, token: res.token, name: res.name });
    render(); // room_update may have arrived before this ack, while session was unset
  });
});

$('btn-join').addEventListener('click', () => {
  const name = $('name-input').value.trim();
  const code = $('code-input').value.trim().toUpperCase();
  if (!name) return homeError('Enter a name first.');
  if (code.length !== 4) return homeError('Room codes are 4 letters.');
  socket.emit('join_room', { code, name }, res => {
    if (!res.ok) return homeError(res.error);
    homeError('');
    saveSession({ code, token: res.token, name: res.name });
    if (res.canvas) canvasStrokes = res.canvas; // mid-game joiners get the doodle so far
    render(); // room_update may have arrived before this ack, while session was unset
  });
});

$('code-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('btn-join').click();
});

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

$('lobby-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(summary.code);
    toast('Code copied!');
  } catch { /* clipboard unavailable — code is selectable anyway */ }
});

$('btn-start').addEventListener('click', () => {
  socket.emit('start_game', {
    turns: $('turns-input').value,
    timerSecs: $('timer-input').value,
    theme: $('theme-input').value,
  });
});

// Live countdown when the host enabled a turn timer. The server enforces
// the deadline; this is purely display.
function updateCountdown() {
  const el = $('turn-timer');
  if (!summary || summary.status !== 'playing' || !summary.turnDeadline) {
    el.textContent = '';
    el.classList.remove('urgent');
    return;
  }
  const s = Math.max(0, Math.ceil((summary.turnDeadline - Date.now()) / 1000));
  el.textContent = ` · ⏳ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  el.classList.toggle('urgent', s <= 10);
}
setInterval(updateCountdown, 500);

function leave() {
  socket.emit('leave_room');
  saveSession(null);
  summary = myTurn = revealData = null;
  stopSpeaking();
  render();
}
$('btn-leave-lobby').addEventListener('click', leave);
$('btn-leave-reveal').addEventListener('click', leave);

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

function updateCharCount() {
  $('char-count').textContent = `${$('story-input').value.length} / 500`;
}
$('story-input').addEventListener('input', updateCharCount);

$('btn-submit').addEventListener('click', () => {
  const text = $('story-input').value.trim();
  if (!text) return toast('Write something first!');
  socket.emit('submit_turn', { text });
  myTurn = null;
  $('story-input').value = '';
});

$('btn-skip').addEventListener('click', () => socket.emit('skip_turn'));

$('btn-end').addEventListener('click', () => {
  if (confirm('End the story now and reveal it?')) socket.emit('end_story');
});

// ---------------------------------------------------------------------------
// Reveal: read aloud, download, new game
// ---------------------------------------------------------------------------

function stopSpeaking() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  speaking = false;
  duckMusic(false);
  $('btn-read').textContent = '🔊 Read aloud';
}

$('btn-read').addEventListener('click', () => {
  if (!('speechSynthesis' in window)) return toast('Speech is not supported on this browser.');
  if (speaking) return stopSpeaking();

  const text = `${revealData.title}. ` +
    revealData.contributions.map(c => c.text).join(' ');
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.95;
  utterance.onend = stopSpeaking;
  utterance.onerror = stopSpeaking;
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
  speaking = true;
  duckMusic(true); // dip the music under the narration
  $('btn-read').textContent = '⏹ Stop reading';
});

$('btn-download').addEventListener('click', () => {
  const lines = [
    `# ${revealData.title}`,
    '',
    ...revealData.contributions.map(c => c.text + '\n'),
    '---',
    '',
    '## Behind the scenes',
    '',
  ];
  revealData.contributions.forEach((c, i) => {
    lines.push(`### Turn ${i + 1} — ${c.name}`);
    lines.push('');
    lines.push(`> **Hint they saw:** ${c.hint.replace(/\n/g, '\n> ')}`);
    lines.push('');
    lines.push(c.text);
    lines.push('');
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${revealData.title.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'story'}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('btn-new-game').addEventListener('click', () => socket.emit('new_game'));

// ---- paced reveal + voting ----

$('btn-reveal-next').addEventListener('click', () => socket.emit('reveal_next'));

$('btn-reveal-all').addEventListener('click', () => {
  if (confirm('Skip the performance and show the whole story?')) socket.emit('reveal_all');
});

$('btn-vote-this').addEventListener('click', e => {
  e.stopPropagation(); // don't let the mobile bottom sheet swallow the tap
  const i = +e.target.dataset.index;
  myVote = i;
  socket.emit('cast_vote', { index: i });
  e.target.textContent = '✓ Your vote!';
  for (const el of document.querySelectorAll('.seg.my-vote')) el.classList.remove('my-vote');
  const segs = document.querySelectorAll('#reveal-story .seg');
  if (segs[i]) segs[i].classList.add('my-vote');
});

$('btn-end-vote').addEventListener('click', () => {
  if (confirm('Close the vote and crown the winner now?')) socket.emit('end_vote');
});

// ---------------------------------------------------------------------------

$('music-volume').value = musicPrefs.vol;
applyMusicVolume();
updateNotifyButton();
render();
