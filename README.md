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

`/practice/` runs any single-player-capable game locally in the browser – no room, no
server round-trips – handy for learning the controls or tuning the feel on a real phone.

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
apps/web          Vite app: / = host screen, /play/ = phone controller (PWA), /practice/ = solo range
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

- Phones show a table in perspective: the bottom half is runway for the swipe, the top half
  holds a **pyramid of holes** (5 rows, 15 holes), the classic Kentucky Derby board. Holes
  are drawn with raised lips and a lit far wall, and a caught ball slides to the hole and
  sinks behind the near lip. The pyramid's stagger means a dead-straight roll threads
  between the holes of every other row – aim matters.
  - **Back triangle = gallop (+3)** – the three holes at the apex.
  - **Middle arrow = trot (+2)** – the full row under the triangle plus the outside edges
    of the front rows, forming a chevron.
  - **Front = walk (+1)** – everything inside the arrow.
- The ball is **simulated**, not looked up. The whole board is inclined: gravity along the
  slope slows the ball on the way up and pulls it back down, with rolling friction on top.
  A flick sets a launch velocity with a real angle, and the side rails bounce, so bank
  shots exist.
- Every hole has a **lip**. Arrive too slowly and the ball can't climb it – it bounces back
  and rolls downhill. Arrive too fast and it skips straight over (losing a little speed).
  In between, it drops in. A ball that skips on the way up can still be caught by a hole on
  the way back down, or roll all the way back to your hand for nothing. Off the top edge is
  the back gutter.
- There is no fixed cooldown: your next ball is ready when the current one drops in or
  comes home, so a timid roll costs time rather than points.
- The simulation is deterministic (fixed timestep, no trig, no randomness), so the phone
  runs the same `simulateRoll` the server does to animate the ball and show lip/skip
  moments as they happen, while the server stays authoritative for the score. Reloading
  mid-roll picks the ball up in flight from the server's launch record.
- Every point moves the player's horse one unit along a 30-unit track on the big screen.
  First across the line wins; the rest are ranked by distance.
- Tuning knobs, all in `logic.ts`: `BOARD` (geometry), `PHYSICS` (`slope`, `friction`,
  `lipSpeed`, `captureSpeed`, `skipDamping`, rail/lip restitution, `maxLaunchSpeed`, launch
  angle limit), zone layout (`ROWS`, `GALLOP_FROM_ROW`, `TROT_ROW`, `ZONE_POINTS`) and
  `TRACK_LENGTH`. Gesture feel sits at the top of `controller.ts`: power is half snap speed
  (`POWER_SCALE`) and half swipe length (`DISTANCE_SCALE`). Expect to tweak those two,
  `lipSpeed` and `captureSpeed` after a round on real phones.

## Roadmap

- More games: skee ball, hoops, …
- Sound on the host screen, a little more juice (confetti, crowd noise).
- Match-long scoreboard across several games.
- Deploy recipe (single container, TLS) for playing away from home.
