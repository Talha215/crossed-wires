// simulate.js — AI playtesting: simulated players play full games against a
// RUNNING server (npm start first). Each writer is a real socket client and
// only ever sees the hint the server sends them — blind, like a human player.
// Finished stories land in the archive/gallery exactly like real games.
//
// Usage: npm run simulate
const { io } = require('socket.io-client');
const { spawn } = require('child_process');

const URL = 'http://localhost:3000';

// A cast of regulars with distinct voices, so games read like a friend group.
const PERSONAS = [
  { name: 'Margo', style: 'wholesome retiree energy; gentle absurdity; insists on naming every side character' },
  { name: 'Dex', style: 'chaotic gremlin; escalates everything; occasional sound effects in caps' },
  { name: 'Quill', style: 'failed novelist; overwrought purple prose delivered completely straight' },
  { name: 'Bert', style: 'deadpan; treats even impossible events as mundane paperwork' },
  { name: 'Nia', style: 'genre-savvy; lampshades tropes while secretly trying to give the story a real plot' },
  { name: 'Goose', style: 'wild card; introduces inexplicable new characters with total confidence' },
];

const GAMES = [
  { turns: 4, players: 3, theme: 'surprise' },
  { turns: 6, players: 4, theme: 'noir' },
  { turns: 8, players: 3, theme: 'classic' },
  { turns: 10, players: 4, theme: 'naturedoc' },
  { turns: 14, players: 5, theme: 'heist' },
  { turns: 20, players: 6, theme: 'fantasy' },
];
const CONCURRENCY = 2;

// --- claude helper (haiku, thinking off — same setup the game itself uses) --
function ask(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '-p', prompt, '--model', 'haiku', '--max-turns', '1', '--output-format', 'json',
    ], { env: { ...process.env, MAX_THINKING_TOKENS: '0' } });
    child.stdin.end();
    let out = '', err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('close', code => {
      if (code !== 0) return reject(new Error(err || `claude exited ${code}`));
      try { resolve((JSON.parse(out).result || '').trim()); }
      catch { reject(new Error('bad claude output')); }
    });
  });
}

function writePrompt(persona, themeLabel, turn, total, hint) {
  return `You are a player in "Crossed Wires", a party game where players take turns adding 1-3 sentences to a story NOBODY can see. You only get the game master's hint about the story so far.

Your persona as a writer: ${persona.style}

Story theme: ${themeLabel || 'anything goes'}
This is turn ${turn} of ${total}.

The game master's hint:
"""
${hint}
"""

Write your 1-3 sentence contribution in your persona's voice. Obey the hint's "Must include" requirement. Stay under 400 characters. Output ONLY your sentences — no preamble, no quotes.`;
}

function votePrompt(persona, contributions, ownIndexes) {
  const lines = contributions.map((c, i) => `${i + 1}. (${c.name}) ${c.text}`).join('\n');
  return `You are ${persona.name}, judging a party-game story for its funniest line. Here is the full story, line by line:

${lines}

You may NOT pick your own lines (numbers ${ownIndexes.map(i => i + 1).join(', ') || 'none'}).
Reply with ONLY the number of the funniest line.`;
}

const emitCb = (s, ev, data) => new Promise(res => s.emit(ev, data, res));
const once = (s, ev) => new Promise(res => s.once(ev, res));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function playGame(cfg, gameNo) {
  const cast = PERSONAS.slice(0, cfg.players);
  const log = msg => console.log(`[game ${gameNo}] ${msg}`);

  // connect everyone; first persona hosts
  const sockets = [];
  for (const p of cast) {
    const s = io(URL, { forceNew: true });
    await once(s, 'connect');
    sockets.push(s);
  }
  const created = await emitCb(sockets[0], 'create_room', { name: cast[0].name });
  for (let i = 1; i < cast.length; i++) {
    await emitCb(sockets[i], 'join_room', { code: created.code, name: cast[i].name });
  }
  log(`room ${created.code}: ${cfg.players} players, ${cfg.turns} turns, theme=${cfg.theme}`);

  let themeLabel = '';
  sockets[0].on('room_update', s => { themeLabel = s.themeLabel || themeLabel; });

  // every player answers their own your_turn — they only ever see the hint
  for (let i = 0; i < cast.length; i++) {
    const persona = cast[i], sock = sockets[i];
    sock.on('your_turn', async t => {
      try {
        let text = await ask(writePrompt(persona, themeLabel, t.turnIndex + 1, t.turnsTotal, t.prompt));
        text = text.replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 480);
        log(`turn ${t.turnIndex + 1}/${t.turnsTotal} — ${persona.name}: ${text.slice(0, 70)}…`);
        sock.emit('submit_turn', { text });
      } catch (e) {
        log(`${persona.name} writer failed (${e.message}); improvising`);
        sock.emit('submit_turn', { text: 'And then, somehow, things got even weirder.' });
      }
    });
  }

  // host skips the performance, then everyone votes for the funniest line
  const revealed = once(sockets[0], 'reveal_complete');
  sockets[0].on('reveal_begin', () => sockets[0].emit('reveal_all'));
  sockets[0].emit('start_game', { turns: cfg.turns, theme: cfg.theme });

  const full = await revealed;
  log(`finished: "${full.title}"`);

  const result = once(sockets[0], 'vote_result');
  await Promise.all(cast.map(async (persona, i) => {
    const own = full.contributions.flatMap((c, ci) => (c.name === persona.name ? [ci] : []));
    let pick;
    try {
      pick = parseInt(await ask(votePrompt(persona, full.contributions, own)), 10) - 1;
    } catch { /* fall through to random */ }
    if (!(pick >= 0 && pick < full.contributions.length) || own.includes(pick)) {
      const options = full.contributions.map((_, ci) => ci).filter(ci => !own.includes(ci));
      pick = options[Math.floor(Math.random() * options.length)];
    }
    sockets[i].emit('cast_vote', { index: pick });
  }));
  const votes = await result;
  log(`crowned line(s): ${votes.winners.map(w => w + 1).join(', ')}`);

  for (const s of sockets) { s.emit('leave_room'); s.close(); }
  return { code: created.code, title: full.title, turns: cfg.turns, theme: cfg.theme };
}

(async () => {
  console.log(`Simulating ${GAMES.length} games (${CONCURRENCY} at a time)…\n`);
  const results = [];
  const queue = GAMES.map((cfg, i) => () => playGame(cfg, i + 1));
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const job = queue.shift();
      try { results.push(await job()); }
      catch (e) { console.error('game failed:', e.message); }
      await sleep(500);
    }
  });
  await Promise.all(workers);

  console.log('\n=== DONE ===');
  for (const r of results) {
    console.log(`(${String(r.turns).padStart(2)} turns, ${r.theme}) "${r.title}"`);
  }
  console.log(`\nBrowse them at ${URL}/stories`);
  process.exit(0);
})();
