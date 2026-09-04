# 🎪 Funfair

Carnival-style party games in the spirit of Jackbox: one big screen (TV, laptop, projector)
runs the **host**, everyone else joins from their **phone**, which becomes the controller.
The phone app is an installable PWA; a small Node server connects everyone.

First game: **Roll-a-Ball Derby** – flick balls up a ramp into the 10/20/30/50 holes to
race your horse down the track. More carnival games (skee ball, hoops, …) plug into the
same framework.

## Quick start

```sh
pnpm install
pnpm dev          # server on :3000 + Vite dev server on :5173
```

Open <http://localhost:5173> on the big screen. It shows a room code, the join URL and a
QR code. Phones on the same Wi-Fi open the URL (Vite is started with `--host`, and the
host page swaps `localhost` for your LAN address automatically), enter the code and join.
The first player to join is the **VIP** 👑 and starts games from their phone.

Production build (server serves the built web app itself):

```sh
pnpm build
pnpm start        # http://0.0.0.0:3000
```

Other scripts: `pnpm typecheck`, `pnpm test`.

### Installing the phone app

Open `/play/` on the phone and use *Add to Home Screen*. The manifest and service worker
live in `apps/web/public`. Install prompts and haptics need HTTPS in the field; on a LAN,
plain HTTP works for playing (put the server behind a TLS proxy such as Caddy for the full
PWA experience).

## Layout

```
packages/shared   Protocol + game contracts shared by server and browser
packages/games    One folder per game: rules, server instance, host view, phone view
apps/server       Node + ws: rooms, sessions, reconnects, the game loop, static hosting
apps/web          Vite app: /  = host screen,  /play/ = phone controller (PWA)
```

### How a session works

1. Host page connects to `/ws` and sends `host:create` → gets a 4-letter room code.
2. Phones send `player:join {roomCode, name}` → get a `playerId` + `token`, stored in
   `localStorage` so a refresh or a dropped connection resumes the same seat
   (`player:resume`). The host keeps its own token in `sessionStorage`.
3. The VIP sends `player:start {gameId}`. The room creates the game's server instance and
   ticks it 20×/s, sending `game:host` state to the big screen and a per-player
   `game:player` state to each phone. Phones send `player:input` messages; the server is
   authoritative and validates everything.
4. When the instance reports `isFinished()`, the room switches to `results`, shows the
   standings on every screen, and the VIP can play again or return to the lobby.

Rooms with nobody connected expire after 10 minutes.

### Adding a game

Each game is a folder under `packages/games/src/<game>/` with:

| file            | runs on | purpose                                                      |
| --------------- | ------- | ------------------------------------------------------------ |
| `meta.ts`       | both    | `GameMeta`: id, name, tagline, min/max players               |
| `logic.ts`      | both    | Pure rules + state/input types. No DOM, no side effects.     |
| `server.ts`     | server  | `GameServerDefinition`: creates a `GameInstance`             |
| `host.ts`       | browser | `mountHost(root)` → `HostView` for the big screen            |
| `controller.ts` | browser | `mountController(root, send)` → `ControllerView` for phones  |
| `client.ts`     | browser | Bundles meta + views into a `GameClientDefinition`           |

Register the server definition in `packages/games/src/server.ts` and the client
definition in `packages/games/src/client.ts`. That's it – the lobby lists it, the room
runs it, both screens mount it.

The `GameInstance` contract (in `packages/shared/src/game.ts`):

```ts
onInput(playerId, input)   // validate! inputs come straight from phones
tick(dtMs)                 // advance timers / physics
hostState()                // what the big screen renders
playerState(playerId)      // what one phone renders (keep it small, it's sent 20×/s)
isFinished()
results()                  // ordered standings, shown by the generic results screen
```

Keep rules in `logic.ts` so the phone can predict outcomes for instant feedback
(Roll-a-Ball animates the ball with the same `resolveRoll` the server uses) and so they
can be unit-tested with `node:test` (`pnpm test`).

## Roll-a-Ball Derby

- Phones show a top-down ramp. A flick gesture's **speed** sets the distance
  (short → 10 → 20 → 30 → 50 → gutter) and its **angle** sets the aim; the higher holes are
  smaller, so an off-centre flick that had the right power still misses ("wide").
- Every point moves the player's horse one unit along a 40-unit track on the big screen.
  First across the line wins; the rest are ranked by distance.
- Rolls are rate-limited server-side (0.9 s), so it's about aim rather than tapping speed.
- Tuning knobs: `HOLES`, `TRACK_LENGTH`, `ROLL_COOLDOWN_MS` in `logic.ts`;
  `POWER_SCALE` / `AIM_SCALE` (gesture feel) at the top of `controller.ts`. These were
  set from desk testing – expect to tweak `POWER_SCALE` after a round on real phones.

## Roadmap

- More games: skee ball, hoops, …
- Sound on the host screen, a little more juice (confetti, crowd noise).
- Match-long scoreboard across several games.
- Deploy recipe (single container, TLS) for playing away from home.
