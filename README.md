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
packages/games    One folder per game: rules, server instance, host view, phone view;
                  lockstep/ (rewind + prediction) and render/ (WebGL scene, sphere, helpers) shared
                  + lockstep/ (shared rewind/prediction netcode) and render/ (sphere, flick, canvas helpers)
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
  sinks behind the near lip. The ball itself is a real WebGL sphere (`ball3d.ts`): a lit
  mesh with a spot pattern whose orientation is a quaternion driven by the distance rolled,
  composited into the 2D scene so the hole clipping still applies. Painted fallback when
  WebGL is unavailable. The pyramid's stagger means a dead-straight roll threads
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
- Each player has **three balls** on the table and can keep all of them going at once: grab
  the one nearest your finger, drag it anywhere on the ramp, flick, and grab the next while
  the first is still rolling. The closer to the lip you let go, the less power you need.
  A ball that comes back bounces off the front bumper and **stays where it settles**;
  letting go without a flick just drops it (it rolls back down and doesn't count as a
  roll). Balls that drop into a hole come back through the chute a moment later. The whole
  table is one simulation, so balls knock each other about.
- The table is a **continuously stepped, deterministic simulation** (120 steps/s, fixed
  timestep, no trig, no randomness) that runs on the phone and the server alike. Grabs and
  flicks are inputs stamped with the tick they happened on. The server keeps 300 ms of
  table history and rewinds to apply a late-arriving input at its real tick, so what the
  player saw is what gets scored; the phone runs ahead of the server, keeps its own short
  history, and only adopts a server snapshot when the two disagree (then replays its
  newer inputs on top). Reloading mid-race picks the table up from the next snapshot.
- **Obstacle waves** are a per-race option: the room can pass `options.obstacles`, otherwise
  the server flips a coin when the game starts (the practice page decides on load, with
  `?obstacles=on|off` to force it). When on, after a six-second grace, nine-second waves roll
  through in a seed-dependent order: a *sweeper* post sliding across the lane, a *double
  sweeper* on two rows, a *windmill* turning in the middle of the pyramid, and *lids* that
  cover one zone's holes at a time. Waves fade in intangible so they never land on a ball,
  the phone flashes a warning and the big screen shows a banner. Obstacles are a pure
  function of the tick and the race seed (with an arithmetic-only sine), so both sides
  agree on them without sending anything.
- Every point moves the player's horse one unit along a 30-unit track on the big screen.
  First across the line wins; the rest are ranked by distance.
- Tuning knobs, all in `logic.ts`: `BOARD` (geometry), `PHYSICS` (`slope`, `friction`,
  `lipSpeed`, `captureSpeed`, `skipDamping`, rail/lip restitution, `maxLaunchSpeed`, launch
  angle limit), zone layout (`ROWS`, `GALLOP_FROM_ROW`, `TROT_ROW`, `ZONE_POINTS`) and
  `TRACK_LENGTH`. Gesture feel sits at the top of `controller.ts`: power is half snap speed
  (`POWER_SCALE`) and half swipe length (`DISTANCE_SCALE`). Expect to tweak those two,
  `lipSpeed` and `captureSpeed` after a round on real phones.

## Skee-Ball Alley

- Nine balls each, sixty seconds. The phone renders the whole alley as a **WebGL scene**
  (`render/scene3d.ts`: a small lit-mesh renderer, no libraries): a tray of balls in front
  of the bumper, the lane and its rails, the run-up (drag a ball anywhere up to the line
  before you let go), the **jump ramp**, a sunken pit, the cabinet, and the **ring board**
  tilted back behind it. The rings are real geometry: **raised rims around recessed holes**
  – 20/30/40/50 from the outside in, and two top-corner **pockets for 100** – so a ball
  visibly climbs a rim, rattles inside the cup and drops out of sight into the hole. A ball
  that rolls off the foot of the board drops into the 10 trough; over the top is a miss.
  The pit between ramp and board also drains into the 10. Touches are mapped back onto the
  table by unprojecting the finger onto the lane plane; only text (cup values, popups,
  the countdown) is drawn on a 2D overlay.
- Same feel as the Derby: grab, drag, flick. The lane leans back so a weak roll comes back
  to the bumper and stays where it settles (grab it again); a ball that reaches the ramp
  faster than `minJumpSpeed` takes off at 37° and flies (plain ballistics, bouncing off the
  cabinet walls).
- **The board is simulated too.** Hitting the face harder than `hopSpeed` makes the ball
  **bounce** (it comes down again a little lower); then it **rolls on the face**, which is
  a 25° slope, so gravity pulls it back down towards the trough. Every cup has a lip: it
  takes `lipSpeed` towards a cup to climb in and `escapeSpeed` to climb back out, so a ball
  rattles around inside a cup, bouncing off the lip, until it is slower than
  `captureSpeed` (and has been on the board for `settleTicks`, so it always rolls first) and drops in – or it climbs out and tumbles down into the next cup or the
  trough. Faster than `skipSpeed` over a lip and the ball skips the cup. A ball that lands
  above the rings rolls down into the 20 (or a pocket) rather than scoring where it
  touched.
- Everything is the same deterministic lockstep table as the Derby (`lockstep/`): the phone
  predicts, the server rewinds, both step at 120 Hz with arithmetic and sqrt only. Board
  geometry is `LANE` (`boardBaseY`, `boardCos/boardSin`, `boardLength`, ring and pocket
  layout); `regionAt(x, u)` says which cup a spot on the face belongs to.
- The big screen shows one card per player: score, ball pips, and a top-down board with a
  dot for every ball's final resting cup (a cross above it for a miss), sorted by standing,
  plus a feed and the round clock. Round ends when the clock runs out or everyone is out of
  balls; highest total wins.
- Tuning: `LANE`, `RINGS`, `PHYSICS` (lane: `slope`, `friction`, `minJumpSpeed`, `rampKeep`;
  flight: `gravity`, `hopSpeed`, `hopRestitution`; board: `faceFriction`, `cupDrag`,
  `lipSpeed`, `escapeSpeed`, `skipSpeed`, `captureSpeed`, `lipRestitution`, `skipDamping`),
  `BALLS_PER_PLAYER` and `ROUND_MS`, all in `skee-ball/logic.ts`. A straight throw from the
  bumper climbs 10 → 20 → 40 → 50 over flick power 0.55 → 0.75, holds the 50 to about 0.85,
  rolls back into the 30 or 20 beyond that, and sails over the top at full power; the
  pockets take angle. The phone looks down on the alley from a steep, distant camera so the
  run-up takes most of the screen.

## Roadmap

- More games: hoops, …
- Sound on the host screen, a little more juice (confetti, crowd noise).
- Match-long scoreboard across several games.
- Deploy recipe (single container, TLS) for playing away from home.
