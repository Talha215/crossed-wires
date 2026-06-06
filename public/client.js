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
let revealData = null;    // payload of reveal
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
// Rendering
// ---------------------------------------------------------------------------

function show(name) {
  for (const s of screens) $(`screen-${s}`).hidden = s !== name;
  // The reveal gets a wider layout so hints fit in a side column on desktop.
  document.body.classList.toggle('reveal-wide', name === 'reveal');
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
      if (revealData) renderReveal();
      else renderGame(); // reveal payload is on its way
      break;
  }
}

function renderLobby() {
  show('lobby');
  $('lobby-code').textContent = summary.code;

  const list = $('lobby-players');
  list.innerHTML = '';
  for (const p of summary.players) {
    const li = document.createElement('li');
    if (!p.connected) li.className = 'offline';
    const dot = document.createElement('span');
    dot.className = 'dot';
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
  $('turn-counter').textContent =
    `Turn ${Math.min(summary.turnIndex + 1, summary.turnsTotal)} of ${summary.turnsTotal}`;

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
    $('waiting-emoji').textContent = '🤖';
    $('waiting-text').textContent = `The AI is whispering a hint to ${summary.activeName}…`;
  } else if (summary.status === 'titling') {
    $('waiting-emoji').textContent = '🎬';
    $('waiting-text').textContent = 'The story is done! Coming up with a title…';
  } else if (summary.activeName) {
    $('waiting-emoji').textContent = '✍️';
    $('waiting-text').textContent = `${summary.activeName} is writing…`;
  } else {
    $('waiting-emoji').textContent = '🎬';
    $('waiting-text').textContent = 'Getting the reveal ready…';
  }

  const host = !!(me() && me().isHost);
  $('game-host-controls').hidden = !host || summary.status !== 'playing';
  $('btn-skip').hidden = !!isMyTurn; // can't skip yourself mid-write, just submit
}

function renderReveal() {
  show('reveal');
  $('reveal-title').textContent = revealData.title;

  const story = $('reveal-story');
  story.innerHTML = '';
  clearHintPanel();
  revealData.contributions.forEach((c, i) => {
    const seg = document.createElement('span');
    seg.className = 'seg';
    seg.textContent = c.text;
    seg.addEventListener('mouseenter', () => showHintPanel(i, seg));
    seg.addEventListener('click', e => { e.stopPropagation(); showHintPanel(i, seg); });
    story.append(seg);
    if (i < revealData.contributions.length - 1) story.append(' ');
  });

  $('btn-new-game').hidden = !(me() && me().isHost);
}

// Highlight one contribution's sentences and show its author + hint in the
// side panel (a bottom sheet on phones). The selection sticks until another
// passage is hovered/tapped, so the panel never flickers mid-read.
function showHintPanel(i, seg) {
  const c = revealData.contributions[i];
  for (const el of document.querySelectorAll('.seg.lit')) el.classList.remove('lit');
  seg.classList.add('lit');
  $('hint-placeholder').hidden = true;
  $('hint-detail').hidden = false;
  $('hint-author').textContent = `Turn ${i + 1} — written by ${c.name}`;
  $('hint-text').textContent = c.hint;
  $('hint-panel').classList.add('active');
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
  if (s.status !== 'reveal') revealData = null;
  render();
});

socket.on('your_turn', payload => {
  myTurn = payload;
  $('story-input').value = '';
  updateCharCount();
  render();
});

socket.on('reveal', payload => {
  revealData = payload;
  stopSpeaking();
  render();
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
  socket.emit('start_game', { turns: $('turns-input').value });
});

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

// ---------------------------------------------------------------------------

$('music-volume').value = musicPrefs.vol;
applyMusicVolume();
render();
