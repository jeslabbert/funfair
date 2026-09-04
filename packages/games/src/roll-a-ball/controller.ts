import type { PlayerInfo } from '@funfair/shared';
import type { ControllerView } from '@funfair/shared/client';
import {
  BOARD,
  HOLES,
  PHYSICS,
  RETURN_DELAY_MS,
  ZONE_LABEL,
  ZONE_POINTS,
  clamp,
  clampLaunch,
  ordinal,
  simulateRoll,
  type RollABallInput,
  type RollABallPlayerState,
  type RollEvent,
  type RollKind,
  type RollSimulation,
  type Zone,
} from './logic';

export const ZONE_COLORS: Record<Zone, string> = { walk: '#5ce07a', trot: '#ffb547', gallop: '#ff5c5c' };

/** Flick speed (canvas heights per second) that counts as a full-power snap. */
const POWER_SCALE = 8;
/** Swipe length, as a fraction of the canvas height, that counts as a full-power pull. */
const DISTANCE_SCALE = 0.75;
const MIN_FLICK_PX = 24;
const VELOCITY_WINDOW_MS = 120;
const POPUP_MS = 900;
const LABEL_MS = 650;
const SINK_MS = 220;

interface Sample {
  x: number;
  y: number;
  t: number;
}

interface Flight {
  sim: RollSimulation;
  /** performance.now() at launch. */
  launchedAt: number;
  rollsBefore: number;
  /** Set once the server confirms the roll. */
  confirmed: { points: number; kind: RollKind; zone: Zone | null } | null;
  popupAt: number | null;
  /** Index into sim.events of the next event to announce. */
  nextEvent: number;
}

interface FloatingLabel {
  text: string;
  color: string;
  x: number; // board units
  y: number;
  at: number;
}

export function mountRollABallController(
  root: HTMLElement,
  send: (input: RollABallInput) => void,
): ControllerView<RollABallPlayerState> {
  root.innerHTML = `
    <div class="rab-ctl">
      <div class="rab-ctl-top">
        <div class="rab-ctl-rank">—</div>
        <div class="rab-ctl-bar" aria-hidden="true">
          <div class="rab-ctl-bar-leader"></div>
          <div class="rab-ctl-bar-me"></div>
        </div>
        <div class="rab-ctl-score">0 / 30</div>
      </div>
      <canvas class="rab-ramp"></canvas>
      <div class="rab-ctl-hint">Flick the ball up the ramp</div>
    </div>`;

  const el = root.querySelector<HTMLElement>('.rab-ctl')!;
  const canvas = root.querySelector<HTMLCanvasElement>('.rab-ramp')!;
  const rankEl = root.querySelector<HTMLElement>('.rab-ctl-rank')!;
  const scoreEl = root.querySelector<HTMLElement>('.rab-ctl-score')!;
  const meBar = root.querySelector<HTMLElement>('.rab-ctl-bar-me')!;
  const leaderBar = root.querySelector<HTMLElement>('.rab-ctl-bar-leader')!;
  const hintEl = root.querySelector<HTMLElement>('.rab-ctl-hint')!;
  const ctx = canvas.getContext('2d')!;

  let state: RollABallPlayerState | null = null;
  let me: PlayerInfo | null = null;
  let players = new Map<string, PlayerInfo>();
  let flight: Flight | null = null;
  let labels: FloatingLabel[] = [];
  let samples: Sample[] = [];
  let dragging = false;
  let raf = 0;
  let W = 0;
  let H = 0;

  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas);

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.max(1, Math.floor(W * dpr));
    canvas.height = Math.max(1, Math.floor(H * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---- board units → canvas --------------------------------------------
  // y = 0 is the bottom of the ramp (ball in hand), y = gutterY the back edge.
  const legendY = () => H * 0.04;
  const topY = () => H * 0.12;
  const bottomY = () => H * 0.94;
  const cx = () => W / 2;
  const yTo = (by: number) => bottomY() - (by / BOARD.gutterY) * (bottomY() - topY());
  /** Half-width of the board at a canvas y – narrower towards the back for a little perspective. */
  const halfWidthAt = (cy: number) => {
    const t = clamp((bottomY() - cy) / (bottomY() - topY()), 0, 1);
    return W * (0.47 - 0.15 * t);
  };
  const unitAt = (cy: number) => halfWidthAt(cy) / BOARD.halfWidth;
  const xTo = (bx: number, cy: number) => cx() + bx * unitAt(cy);
  const toCanvas = (bx: number, by: number) => {
    const cy = yTo(by);
    return { x: xTo(bx, cy), y: cy };
  };
  const restPoint = () => toCanvas(0, BOARD.ballStartY);

  // ---- input --------------------------------------------------------------
  function ballReady(now: number) {
    if (!state || state.phase !== 'racing' || state.me.finishedAt !== null) return false;
    if (flight) return now - flight.launchedAt >= flight.sim.outcome.endedAt + RETURN_DELAY_MS;
    return state.cooldownMs === 0;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!ballReady(performance.now())) return;
    dragging = true;
    samples = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }];
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    if (samples.length > 64) samples.splice(0, samples.length - 64);
  });
  const endDrag = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    const gesture = readFlick(samples, H);
    samples = [];
    if (!gesture) return;
    const now = performance.now();
    if (!ballReady(now)) return;
    const speed = gesture.power * PHYSICS.maxLaunchSpeed;
    const launch = clampLaunch(speed * gesture.dirX, speed * gesture.dirY);
    startFlight(simulateRoll(launch.vx, launch.vy), now, state!.me.rolls);
    send({ type: 'roll', vx: launch.vx, vy: launch.vy });
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  function startFlight(sim: RollSimulation, launchedAt: number, rollsBefore: number) {
    flight = { sim, launchedAt, rollsBefore, confirmed: null, popupAt: null, nextEvent: 0 };
    labels = [];
  }

  // ---- drawing ------------------------------------------------------------
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);
    drawBoard();
    drawHoles();
    announceEvents(now);
    drawBall(now);
    drawLabels(now);
    drawPopup(now);
    drawOverlay();
  }

  function drawBoard() {
    const top = topY() - H * 0.06;
    const bottom = bottomY() + H * 0.03;
    // Rails: one trapezoid for ramp + board
    ctx.beginPath();
    ctx.moveTo(cx() - halfWidthAt(bottom), bottom);
    ctx.lineTo(cx() + halfWidthAt(bottom), bottom);
    ctx.lineTo(cx() + halfWidthAt(top), top);
    ctx.lineTo(cx() - halfWidthAt(top), top);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, top, 0, bottom);
    g.addColorStop(0, '#3a2412');
    g.addColorStop(0.55, '#5a3a1c');
    g.addColorStop(1, '#7a5230');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 220, 160, 0.45)';
    ctx.lineWidth = 4;
    ctx.stroke();

    // Back gutter
    const gy = yTo(BOARD.gutterY);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.moveTo(cx() - halfWidthAt(gy), gy);
    ctx.lineTo(cx() + halfWidthAt(gy), gy);
    ctx.lineTo(cx() + halfWidthAt(top), top);
    ctx.lineTo(cx() - halfWidthAt(top), top);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = `600 ${Math.max(10, W * 0.028)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('GUTTER', cx(), (gy + top) / 2);

    // Ramp lip
    const ly = yTo(BOARD.rampLength);
    ctx.strokeStyle = 'rgba(255, 220, 160, 0.25)';
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(cx() - halfWidthAt(ly), ly);
    ctx.lineTo(cx() + halfWidthAt(ly), ly);
    ctx.stroke();
    ctx.setLineDash([]);

    // Legend
    const zones: Zone[] = ['walk', 'trot', 'gallop'];
    ctx.font = `700 ${Math.max(11, W * 0.034)}px system-ui, sans-serif`;
    const dot = Math.max(4, W * 0.014);
    const gap = W * 0.06;
    const widths = zones.map((z) => ctx.measureText(`${ZONE_LABEL[z]} +${ZONE_POINTS[z]}`).width + dot * 3);
    let x = cx() - (widths.reduce((a, b) => a + b, 0) + gap * (zones.length - 1)) / 2;
    zones.forEach((z, i) => {
      ctx.beginPath();
      ctx.arc(x + dot, legendY(), dot, 0, Math.PI * 2);
      ctx.fillStyle = ZONE_COLORS[z];
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${ZONE_LABEL[z]} +${ZONE_POINTS[z]}`, x + dot * 3, legendY());
      x += widths[i]! + gap;
    });
  }

  function drawHoles() {
    for (const h of HOLES) {
      const { x, y } = toCanvas(h.x, h.y);
      const u = unitAt(y);
      const r = u * 0.4;
      // Raised lip: a soft light ring outside the rim
      ctx.beginPath();
      ctx.arc(x, y, r + u * 0.1, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 230, 190, 0.14)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#120a06';
      ctx.fill();
      ctx.lineWidth = Math.max(2, u * 0.09);
      ctx.strokeStyle = ZONE_COLORS[h.zone];
      ctx.stroke();
    }
  }

  function ballAt(now: number): { x: number; y: number; scale: number; alpha: number } | null {
    if (!flight) return null;
    const { sim } = flight;
    const t = now - flight.launchedAt;
    const ended = sim.outcome.endedAt;
    if (t >= ended + RETURN_DELAY_MS) return null; // back in hand – drawn at rest
    const last = sim.frames.length / 2 - 1;
    const i = clamp(Math.floor(t / PHYSICS.stepMs), 0, last);
    const bx = sim.frames[i * 2]!;
    const by = sim.frames[i * 2 + 1]!;
    const { x, y } = toCanvas(bx, by);
    if (t < ended) return { x, y, scale: 1, alpha: 1 };
    // Settled: sink into the hole / drop into the gutter / arrive home.
    const s = clamp((t - ended) / SINK_MS, 0, 1);
    if (sim.outcome.kind === 'hit') return { x, y, scale: 1 - s * 0.55, alpha: 1 - s * 0.6 };
    if (sim.outcome.kind === 'gutter') return { x, y: y - s * H * 0.02, scale: 1 - s * 0.6, alpha: 1 - s };
    return { x, y, scale: 1, alpha: 1 };
  }

  function drawBall(now: number) {
    const color = me?.color ?? '#fff';
    const ready = ballReady(now);
    const inHand = !flight || now - flight.launchedAt >= flight.sim.outcome.endedAt + RETURN_DELAY_MS;
    const pos = inHand ? { ...restPoint(), scale: 1, alpha: ready ? 1 : 0.45 } : ballAt(now)!;
    const r = unitAt(pos.y) * PHYSICS.ballRadius * 1.15 * pos.scale;

    // Shadow
    ctx.beginPath();
    ctx.ellipse(pos.x + r * 0.15, pos.y + r * 0.35, r * 1.05, r * 0.6, 0, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(0,0,0,${0.35 * pos.alpha})`;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    const g = ctx.createRadialGradient(pos.x - r * 0.35, pos.y - r * 0.35, r * 0.1, pos.x, pos.y, r);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.25, color);
    g.addColorStop(1, shade(color, -0.45));
    ctx.fillStyle = g;
    ctx.globalAlpha = pos.alpha;
    ctx.fill();
    ctx.globalAlpha = 1;

    if (inHand && ready) {
      const rest = restPoint();
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = `600 ${Math.max(12, W * 0.035)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('▲ flick', rest.x, rest.y - r - 16 + Math.sin(now / 250) * 3);
    }
  }

  /** Turn simulation events into little on-board labels and haptics as the ball reaches them. */
  function announceEvents(now: number) {
    if (!flight) return;
    const t = now - flight.launchedAt;
    const events = flight.sim.events;
    while (flight.nextEvent < events.length && events[flight.nextEvent]!.t <= t) {
      const ev = events[flight.nextEvent++]!;
      const label = eventLabel(ev);
      if (label) labels.push({ ...label, x: ev.x, y: ev.y, at: now });
      if (ev.type === 'lip' || ev.type === 'skip') buzz(10);
      if (ev.type === 'rail') buzz(6);
    }
  }

  function drawLabels(now: number) {
    labels = labels.filter((l) => now - l.at < LABEL_MS);
    for (const l of labels) {
      const u = (now - l.at) / LABEL_MS;
      const { x, y } = toCanvas(l.x, l.y);
      ctx.globalAlpha = 1 - u * u;
      ctx.fillStyle = l.color;
      ctx.font = `800 ${Math.max(11, W * 0.036)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(l.text, x, y - unitAt(y) * 0.6 - u * 14);
      ctx.fillText(l.text, x, y - unitAt(y) * 0.6 - u * 14);
    }
    ctx.globalAlpha = 1;
  }

  function drawPopup(now: number) {
    if (!flight) return;
    const t = now - flight.launchedAt;
    const settled = t >= flight.sim.outcome.endedAt;
    if (settled && flight.confirmed && flight.popupAt === null) {
      flight.popupAt = now;
      buzz(flight.confirmed.kind === 'hit' ? [30, 40, 30] : 15);
    }
    if (flight.popupAt === null) {
      // Server never confirmed (e.g. it rejected the roll): let the flight expire quietly.
      if (t > flight.sim.outcome.endedAt + RETURN_DELAY_MS + 2000) flight = null;
      return;
    }
    const u = (now - flight.popupAt) / POPUP_MS;
    if (u > 1) {
      if (t >= flight.sim.outcome.endedAt + RETURN_DELAY_MS) flight = null;
      return;
    }
    const { kind, points, zone } = flight.confirmed!;
    const text = kind === 'hit' && zone ? `${ZONE_LABEL[zone].toUpperCase()} +${points}` : kind === 'gutter' ? 'GUTTER' : 'ROLLED BACK';
    // Popups live in the ramp area so they never cover the board or legend.
    const y = (yTo(BOARD.rampLength) + restPoint().y) / 2 - u * 40;
    ctx.globalAlpha = 1 - u * u;
    ctx.fillStyle = kind === 'hit' && zone ? ZONE_COLORS[zone] : 'rgba(255,255,255,0.75)';
    fitFont(ctx, text, 900, Math.max(26, W * 0.12), W * 0.85);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.strokeText(text, cx(), y);
    ctx.fillText(text, cx(), y);
    ctx.globalAlpha = 1;
  }

  function drawOverlay() {
    if (!state) return;
    let big = '';
    let small = '';
    if (state.phase === 'countdown') {
      const secs = Math.ceil(state.countdownMs / 1000);
      big = secs > 0 ? String(secs) : 'GO!';
      small = 'Flick up when the race starts';
    } else if (state.phase === 'finished') {
      const winner = state.winnerId ? players.get(state.winnerId) : null;
      const iWon = state.winnerId === me?.id;
      big = iWon ? '🏆 You win!' : state.me.finishedAt !== null ? `${ordinal(state.me.rank)} place` : `${winner?.name ?? 'Someone'} wins`;
      small = iWon ? 'Champion of the derby' : `You finished ${ordinal(state.me.rank)}`;
    } else if (state.me.finishedAt !== null) {
      big = '🏁';
      small = `You crossed the line in ${ordinal(state.me.rank)}`;
    } else {
      return;
    }
    ctx.fillStyle = 'rgba(8, 10, 28, 0.6)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const bigPx = fitFont(ctx, big, 800, Math.max(36, W * 0.16), W * 0.9);
    ctx.fillText(big, W / 2, H * 0.42);
    ctx.font = `500 ${fitFont(ctx, small, 500, Math.max(14, W * 0.045), W * 0.9)}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(small, W / 2, H * 0.42 + bigPx * 0.9);
  }

  resize();
  raf = requestAnimationFrame(frame);

  return {
    update(next, meInfo, playerList) {
      state = next;
      me = meInfo;
      players = new Map(playerList.map((p) => [p.id, p]));

      if (flight && !flight.confirmed && next.me.rolls > flight.rollsBefore && next.me.lastRoll) {
        flight.confirmed = { points: next.me.lastRoll.points, kind: next.me.lastRoll.kind, zone: next.me.lastRoll.zone };
      }
      // Ball in play on the server but not here (reconnect / reload mid-roll): pick it up in progress.
      if (!flight && next.me.ball) {
        const elapsed = next.raceMs - next.me.ball.launchedAt;
        const sim = simulateRoll(next.me.ball.vx, next.me.ball.vy);
        if (elapsed < sim.outcome.endedAt + RETURN_DELAY_MS) startFlight(sim, performance.now() - elapsed, next.me.rolls);
      }

      rankEl.textContent = next.phase === 'countdown' ? 'Ready?' : `${ordinal(next.me.rank)} of ${next.playerCount}`;
      scoreEl.textContent = `${next.me.progress} / ${next.trackLength}`;
      meBar.style.width = `${(next.me.progress / next.trackLength) * 100}%`;
      meBar.style.background = meInfo.color;
      leaderBar.style.width = `${(next.leaderProgress / next.trackLength) * 100}%`;
      hintEl.textContent =
        next.phase === 'racing'
          ? next.me.progress >= next.leaderProgress
            ? "You're leading — keep rolling!"
            : `${next.leaderProgress - next.me.progress} behind the leader`
          : next.phase === 'countdown'
            ? 'Too soft rolls back. Too hard skips the lip. Angle it off the rails.'
            : 'Race over!';
      el.classList.toggle('rab-ctl-finished', next.phase === 'finished');
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      root.innerHTML = '';
    },
  };
}

function eventLabel(ev: RollEvent): { text: string; color: string } | null {
  switch (ev.type) {
    case 'lip':
      return { text: 'lip!', color: '#ffb547' };
    case 'skip':
      return { text: 'too fast', color: 'rgba(255,255,255,0.8)' };
    default:
      return null;
  }
}

/**
 * Turn a pointer trace into a launch: power (0..1) from the flick's snap speed
 * and its length, plus a unit direction from the drag; null if it wasn't a flick.
 */
export function readFlick(samples: Sample[], canvasHeight: number): { power: number; dirX: number; dirY: number } | null {
  if (samples.length < 2 || canvasHeight <= 0) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const totalDy = first.y - last.y; // up is positive
  if (totalDy < MIN_FLICK_PX) return null;

  // Velocity from the final window of the gesture, so a slow wind-up
  // followed by a snap still counts as a snap.
  let ref = first;
  for (const s of samples) {
    if (last.t - s.t <= VELOCITY_WINDOW_MS) {
      ref = s;
      break;
    }
  }
  const dt = Math.max(16, last.t - ref.t);
  const dy = Math.max(0, ref.y - last.y);
  const speed = dy / canvasHeight / (dt / 1000); // canvas heights per second
  // Half from how hard you snap, half from how far you pull: a long swipe is a hard roll.
  const power = clamp(0.5 * (speed / POWER_SCALE) + 0.5 * (totalDy / canvasHeight / DISTANCE_SCALE), 0, 1);

  const dx = last.x - first.x;
  const len = Math.sqrt(dx * dx + totalDy * totalDy);
  return { power, dirX: dx / len, dirY: totalDy / len };
}

/** Sets ctx.font at the largest size (≤ max) where `text` fits in `maxWidth`; returns the size. */
export function fitFont(ctx: CanvasRenderingContext2D, text: string, weight: number, max: number, maxWidth: number): number {
  let size = max;
  ctx.font = `${weight} ${size}px system-ui, sans-serif`;
  const width = ctx.measureText(text).width;
  if (width > maxWidth) {
    size = Math.max(12, Math.floor((max * maxWidth) / width));
    ctx.font = `${weight} ${size}px system-ui, sans-serif`;
  }
  return size;
}

function buzz(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not supported */
  }
}

function shade(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const f = (c: string) => {
    const v = parseInt(c, 16);
    const n = amount < 0 ? Math.round(v * (1 + amount)) : Math.round(v + (255 - v) * amount);
    return clamp(n, 0, 255).toString(16).padStart(2, '0');
  };
  return `#${f(m[1]!)}${f(m[2]!)}${f(m[3]!)}`;
}
