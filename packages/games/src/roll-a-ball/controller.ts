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
const SINK_MS = 340;
const HOP_MS = 160;
/** Vertical squash of circles on the receding table (viewing angle). */
const SQUASH = 0.68;

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
  /** Only the first skip of a roll gets a label; the rest would just stack up. */
  skipShown: boolean;
}

interface BallPose {
  x: number;
  y: number;
  scale: number;
  alpha: number;
  /** Hole the ball is sinking into, once caught. */
  sinkingInto: { x: number; y: number; zone: Zone } | null;
  sink: number; // 0..1
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
  let lastHopAt = -Infinity;
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
    return W * (0.47 - 0.16 * t);
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
    flight = { sim, launchedAt, rollsBefore, confirmed: null, popupAt: null, nextEvent: 0, skipShown: false };
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
    const bottom = bottomY() + H * 0.02;
    const thickness = H * 0.014;

    // Front face of the table (its thickness)
    ctx.beginPath();
    ctx.moveTo(cx() - halfWidthAt(bottom) - 6, bottom);
    ctx.lineTo(cx() + halfWidthAt(bottom) + 6, bottom);
    ctx.lineTo(cx() + halfWidthAt(bottom) + 6, bottom + thickness);
    ctx.lineTo(cx() - halfWidthAt(bottom) - 6, bottom + thickness);
    ctx.closePath();
    ctx.fillStyle = '#2a1708';
    ctx.fill();

    // Playing surface: one trapezoid for ramp + board, lit from the top
    ctx.beginPath();
    ctx.moveTo(cx() - halfWidthAt(bottom), bottom);
    ctx.lineTo(cx() + halfWidthAt(bottom), bottom);
    ctx.lineTo(cx() + halfWidthAt(top), top);
    ctx.lineTo(cx() - halfWidthAt(top), top);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, top, 0, bottom);
    g.addColorStop(0, '#4a2e15');
    g.addColorStop(0.5, '#5e3d1e');
    g.addColorStop(1, '#7c5330');
    ctx.fillStyle = g;
    ctx.fill();

    // Receding stripes every board unit sell the perspective
    ctx.strokeStyle = 'rgba(255, 235, 200, 0.045)';
    ctx.lineWidth = 1;
    for (let by = 1; by < BOARD.gutterY; by += 1) {
      const y = yTo(by);
      ctx.beginPath();
      ctx.moveTo(cx() - halfWidthAt(y), y);
      ctx.lineTo(cx() + halfWidthAt(y), y);
      ctx.stroke();
    }

    // Rails: raised edges with a lit inner face
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#2a1708';
    ctx.beginPath();
    ctx.moveTo(cx() - halfWidthAt(bottom), bottom);
    ctx.lineTo(cx() - halfWidthAt(top), top);
    ctx.moveTo(cx() + halfWidthAt(bottom), bottom);
    ctx.lineTo(cx() + halfWidthAt(top), top);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 220, 160, 0.55)';
    ctx.beginPath();
    ctx.moveTo(cx() - halfWidthAt(bottom) + 3, bottom);
    ctx.lineTo(cx() - halfWidthAt(top) + 3, top);
    ctx.moveTo(cx() + halfWidthAt(bottom) - 3, bottom);
    ctx.lineTo(cx() + halfWidthAt(top) - 3, top);
    ctx.stroke();

    // Back gutter: a trough with a shadowed far wall
    const gy = yTo(BOARD.gutterY);
    const tg = ctx.createLinearGradient(0, top, 0, gy);
    tg.addColorStop(0, 'rgba(0,0,0,0.75)');
    tg.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = tg;
    ctx.beginPath();
    ctx.moveTo(cx() - halfWidthAt(gy), gy);
    ctx.lineTo(cx() + halfWidthAt(gy), gy);
    ctx.lineTo(cx() + halfWidthAt(top), top);
    ctx.lineTo(cx() - halfWidthAt(top), top);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 220, 160, 0.3)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx() - halfWidthAt(gy), gy);
    ctx.lineTo(cx() + halfWidthAt(gy), gy);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = `600 ${Math.max(10, W * 0.028)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('GUTTER', cx(), (gy + top) / 2);

    // Ramp lip
    const ly = yTo(BOARD.rampLength);
    ctx.strokeStyle = 'rgba(255, 220, 160, 0.22)';
    ctx.setLineDash([6, 8]);
    ctx.lineWidth = 2;
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

  /** Hole radii on screen: rx across, ry foreshortened. */
  function holeSize(y: number) {
    const rx = unitAt(y) * 0.4;
    return { rx, ry: rx * SQUASH, lip: unitAt(y) * 0.12 };
  }

  function drawHoles() {
    for (const h of HOLES) {
      const { x, y } = toCanvas(h.x, h.y);
      drawHole(x, y, h.zone);
    }
  }

  function drawHole(x: number, y: number, zone: Zone) {
    const { rx, ry, lip } = holeSize(y);
    // Raised lip: a ring in the zone colour, lit from the top, shaded at the bottom
    ctx.beginPath();
    ctx.ellipse(x, y, rx + lip, ry + lip * SQUASH, 0, 0, Math.PI * 2);
    ctx.fillStyle = ZONE_COLORS[zone];
    ctx.fill();
    const lg = ctx.createLinearGradient(0, y - ry - lip, 0, y + ry + lip);
    lg.addColorStop(0, 'rgba(255,255,255,0.45)');
    lg.addColorStop(0.5, 'rgba(255,255,255,0)');
    lg.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = lg;
    ctx.fill();
    // Ground shadow under the lip's near side
    ctx.beginPath();
    ctx.ellipse(x, y + lip * 0.6, rx + lip, ry + lip * SQUASH, 0, 0, Math.PI);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fill();
    // The opening
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#0a0503';
    ctx.fill();
    // Lit far wall inside the hole
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.beginPath();
    ctx.ellipse(x, y - ry * 0.55, rx * 0.9, ry * 0.9, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(120, 78, 40, 0.55)';
    ctx.fill();
    ctx.restore();
  }

  /** Redraw the near half of a hole's lip, so a sinking ball disappears behind it. */
  function drawHoleFront(x: number, y: number, zone: Zone) {
    const { rx, ry, lip } = holeSize(y);
    ctx.beginPath();
    ctx.ellipse(x, y, rx + lip, ry + lip * SQUASH, 0, 0, Math.PI);
    ctx.lineTo(x - rx, y);
    ctx.ellipse(x, y, rx, ry, 0, Math.PI, 0, true);
    ctx.closePath();
    ctx.fillStyle = shade(ZONE_COLORS[zone], -0.35);
    ctx.fill();
  }

  function holeFor(row: number, col: number): { x: number; y: number; zone: Zone } {
    const h = HOLES.find((k) => k.row === row && k.col === col)!;
    return { ...toCanvas(h.x, h.y), zone: h.zone };
  }

  function ballAt(now: number): BallPose | null {
    if (!flight) return null;
    const { sim } = flight;
    const t = now - flight.launchedAt;
    const ended = sim.outcome.endedAt;
    if (t >= ended + RETURN_DELAY_MS) return null; // back in hand – drawn at rest
    const last = sim.frames.length / 2 - 1;
    const i = clamp(Math.floor(t / PHYSICS.stepMs), 0, last);
    const { x, y } = toCanvas(sim.frames[i * 2]!, sim.frames[i * 2 + 1]!);
    if (t < ended) return { x, y, scale: 1, alpha: 1, sinkingInto: null, sink: 0 };

    const s = clamp((t - ended) / SINK_MS, 0, 1);
    if (sim.outcome.kind === 'hit') {
      // Slide from where the lip caught it to the centre, then drop through the opening.
      const hole = holeFor(sim.outcome.row!, sim.outcome.col!);
      const slide = clamp(s / 0.45, 0, 1);
      const eased = 1 - Math.pow(1 - slide, 2);
      const drop = clamp((s - 0.3) / 0.7, 0, 1);
      const { ry } = holeSize(hole.y);
      return {
        x: x + (hole.x - x) * eased,
        y: y + (hole.y - y) * eased + drop * drop * ry * 2.4,
        scale: 1 - drop * 0.25,
        alpha: 1 - clamp((s - 0.75) / 0.25, 0, 1),
        sinkingInto: hole,
        sink: drop,
      };
    }
    if (sim.outcome.kind === 'gutter') return { x, y: y - s * H * 0.02, scale: 1 - s * 0.6, alpha: 1 - s, sinkingInto: null, sink: 0 };
    return { x, y, scale: 1, alpha: 1, sinkingInto: null, sink: 0 };
  }

  function drawSphere(x: number, y: number, r: number, color: string, alpha: number, dim: number) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    const g = ctx.createRadialGradient(x - r * 0.38, y - r * 0.42, r * 0.08, x, y, r);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.22, color);
    g.addColorStop(0.85, shade(color, -0.5));
    g.addColorStop(1, shade(color, -0.7));
    ctx.fillStyle = g;
    ctx.globalAlpha = alpha;
    ctx.fill();
    if (dim > 0) {
      ctx.fillStyle = `rgba(0,0,0,${dim})`;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawBall(now: number) {
    const color = me?.color ?? '#fff';
    const ready = ballReady(now);
    const inHand = !flight || now - flight.launchedAt >= flight.sim.outcome.endedAt + RETURN_DELAY_MS;
    const pose: BallPose = inHand
      ? { ...restPoint(), scale: 1, alpha: ready ? 1 : 0.45, sinkingInto: null, sink: 0 }
      : ballAt(now)!;

    // A little hop when it bumps a lip
    const hopT = (now - lastHopAt) / HOP_MS;
    const hop = !inHand && hopT >= 0 && hopT < 1 ? Math.sin(hopT * Math.PI) : 0;

    const r = unitAt(pose.y) * PHYSICS.ballRadius * 1.15 * pose.scale * (1 + hop * 0.12);
    const bx = pose.x;
    const by = pose.y - hop * r * 0.8;

    // Contact shadow (drifts away as the ball hops)
    if (!pose.sinkingInto || pose.sink < 0.5) {
      ctx.beginPath();
      ctx.ellipse(bx + r * 0.2, pose.y + r * 0.45, r * (1 + hop * 0.2), r * 0.55, 0, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,0,0,${0.35 * pose.alpha * (1 - hop * 0.4)})`;
      ctx.fill();
    }

    if (pose.sinkingInto) {
      // Visible where it's still above the table, or seen down inside the opening.
      const { rx, ry } = holeSize(pose.sinkingInto.y);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, pose.sinkingInto.y);
      ctx.ellipse(pose.sinkingInto.x, pose.sinkingInto.y, rx, ry, 0, 0, Math.PI * 2);
      ctx.clip();
      drawSphere(bx, by, r, color, pose.alpha, pose.sink * 0.7);
      ctx.restore();
      drawHoleFront(pose.sinkingInto.x, pose.sinkingInto.y, pose.sinkingInto.zone);
    } else {
      drawSphere(bx, by, r, color, pose.alpha, 0);
    }

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
      if (label && !(ev.type === 'skip' && flight.skipShown)) labels.push({ ...label, x: ev.x, y: ev.y, at: now });
      if (ev.type === 'skip') flight.skipShown = true;
      if (ev.type === 'lip' || ev.type === 'skip') buzz(10);
      if (ev.type === 'lip' || ev.type === 'skip') lastHopAt = now;
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
