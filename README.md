# 🔌 Crossed Wires

A self-hosted party game: **telephone meets mad libs**. Players take turns
writing a story 1–3 sentences at a time — but nobody sees what was written
before them. Instead, an AI game master reads the story so far and whispers
each writer a deliberately vague hint (plus one mandatory element they must
work in). At the end, the AI titles the masterpiece and the full story is
revealed — alongside the hint each player was given.

While waiting for their turn, players doodle together on a shared canvas.
The communal artwork is unveiled with the story.

Built for game nights over Discord: works great on phones and desktops,
players can join mid-game, and disconnects/rejoins are seamless.

## How it works

- One person hosts a room and shares the 4-letter code
- Players join with the code and a name, host picks the number of turns and starts
- Turn 1 writes from a starter prompt; every later turn writes **blind**,
  guided only by the AI's hint about tone and momentum
- The server never sends story text to any player until the reveal —
  enforced server-side, not hidden in the browser
- The reveal shows the title, the story as flowing prose, per-passage
  hints on hover/tap, the communal doodle, read-aloud, and a markdown download

## Requirements

| Thing | Why | Get it |
|---|---|---|
| **Node.js 18+** | Runs the game server | [nodejs.org](https://nodejs.org) |
| **Claude Code CLI, logged in** | Generates the hints and titles (uses your Claude subscription — **no API keys needed**) | `npm install -g @anthropic-ai/claude-code`, then run `claude` once and log in |

That's it. No database, no external services. All game state lives in memory
and in a local `game-state.json`, so in-progress games survive restarts.

## Install & run

```bash
git clone https://github.com/Talha215/crossed-wires.git
cd crossed-wires
npm install
npm start
```

Open **http://localhost:3000** — you're hosting.

On Windows you can also just double-click `launch.cmd`.

## Letting friends join

Pick whichever fits:

**Same wifi (zero setup):** friends browse to `http://<your-LAN-IP>:3000`
(find your IP with `ipconfig` / `ifconfig`).

**Quick link (no account):** install
[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
and run:

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints a public `https://….trycloudflare.com` URL. Random URL each launch.

**Permanent link (recommended):** install [Tailscale](https://tailscale.com)
(free), log in, then:

```bash
tailscale funnel --bg 3000
```

You get a stable `https://<machine>.<tailnet>.ts.net` URL that survives
reboots — pin it in your Discord once and it never changes. (The first run
prints a link to enable Funnel for your account; it persists as part of the
Tailscale service after that.)

## Good to know

- **Restarts are safe.** Game state persists to `game-state.json`; players
  are auto-rejoined when they reopen the page — even mid-turn, even if the
  server restarted while the AI was thinking.
- **Mid-game joins are fair.** Late joiners go to the back of the turn
  rotation — since everyone writes blind, they're at no disadvantage.
- **Host powers:** skip a stuck player, end the story early, start a new
  game with the same crew.
- **Multiple rooms** run concurrently and independently; stale rooms are
  swept automatically (finished games after ~6h idle, anything else after ~24h).
- **Port:** 3000, set at the top of `server.js`.
- The AI calls shell out to the `claude` CLI with the Haiku model —
  fast and cheap, a few seconds per hint.

## License

[MIT](LICENSE)
