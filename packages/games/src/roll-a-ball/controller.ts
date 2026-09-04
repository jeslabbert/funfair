import type { PlayerInfo } from '@funfair/shared';
import type { ControllerView } from '@funfair/shared/client';
import {
  BOARD,
  HOLES,
  PHYSICS,
  ZONE_LABEL,
  ZONE_POINTS,
  clamp,
  clampLaunch,
  clampLaunchPosition,
  ordinal,
  simulateRoll,
  type BallAtRest,
  type BallView,
  type RollABallInput,
  type RollABallPlayerState,
  type RollEvent,
  type RollKind,
  type RollSimulation,
  type Zone,
} from './logic';
import { QUAT_IDENTITY, createBallRenderer, quatFromAxisAngle, quatMultiply, quatNormalize, type Quat } from './ball3d';

export const ZONE_COLORS: Record<Zone, string> = { walk: '#5ce07a', trot: '#ffb547', gallop: '#ff5c5c' };

/** Flick speed (canvas heights per second) that counts as a full-power snap. */
const POWER_SCALE = 8;
/** Swipe length, as a fraction of the canvas height, that counts as a full-power pull. */
const DISTANCE_SCALE = 0.75;
const MIN_FLICK_PX = 24;
const VELOCITY_WINDOW_MS = 180;
const POPUP_MS = 900;
const LABEL_MS = 650;
const SINK_MS = 340;
const HOP_MS = 160;
const APPEAR_MS = 260;
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
  /** True when the roll never left the ramp: the server won't count it, so don't wait for it to. */
  isDrop: boolean;
  /** Set once the server confirms the roll. */
  confirmed: { points: number; kind: RollKind; zone: Zone | null } | null;
  popupAt: number | null;
  /** Index into sim.events of the next event to announce. */
  nextEvent: number;
  /** Only the first skip of a roll gets a label; the rest would just stack up. */
  skipShown: boolean;
}

interface Drag {
  ballId: number;
  pointerId: number;
  /** Board units. */
  x: number;
  y: number;
  samples: Sample[];
}

interface BallPose {
  id: number;
  x: number;
  y: number;
  scale: number;
  alpha: number;
  lifted: boolean;
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

interface Spin2D {
  spin: number;
  dirX: number;
  dirY: number;
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
      <div class="rab-ctl-hint">Grab a ball and flick it up the ramp</div>
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
  let drag: Drag | null = null;
  let labels: FloatingLabel[] = [];
  let raf = 0;
  let W = 0;
  let H = 0;

  /** Per-ball rolling state, by ball id. */
  const orientation = new Map<number, Quat>();
  const spin2d = new Map<number, Spin2D>();
  const prevBoard = new Map<number, { x: number; y: number }>();
  const lastHopAt = new Map<number, number>();
  /** When each ball last (re)appeared on the table, for a fade-in. */
  const appearedAt = new Map<number, number>();
  const ball3d = createBallRenderer();

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

  // ---- board units ↔ canvas -------------------------------------------
  // y = 0 is the bottom of the ramp, y = gutterY the back edge.
  const legendY = () => H * 0.04;
  const topY = () => H * 0.12;
  const bottomY = () => H * 0.94;
  const cx = () => W / 2;
  const yTo = (by: number) => bottomY() - (by / BOARD.gutterY) * (bottomY() - topY());
  const yFrom = (cy: number) => ((bottomY() - cy) / (bottomY() - topY())) * BOARD.gutterY;
  /** Half-width of the board at a canvas y – narrower towards the back for a little perspective. */
  const halfWidthAt = (cy: number) => {
    const t = clamp((bottomY() - cy) / (bottomY() - topY()), 0, 1);
    return W * (0.47 - 0.16 * t);
  };
  const unitAt = (cy: number) => halfWidthAt(cy) / BOARD.halfWidth;
  const toCanvas = (bx: number, by: number) => {
    const cy = yTo(by);
    return { x: cx() + bx * unitAt(cy), y: cy };
  };
  const fromCanvas = (px: number, py: number) => {
    const by = yFrom(py);
    return { x: (px - cx()) / unitAt(py), y: by };
  };
  const ballPx = (cy: number) => unitAt(cy) * PHYSICS.ballRadius * 1.15;

  // ---- what's on the table right now ---------------------------------
  /** Balls at rest, from the live roll's final positions once it has settled, else the server's view. */
  function restingBalls(): BallView[] {
    if (flight) {
      return flight.sim.final.map((b) => ({ ...b, status: 'resting' as const }));
    }
    return state?.me.balls.filter((b) => b.status === 'resting') ?? [];
  }

  function tableLive(now: number) {
    return !!flight && now - flight.launchedAt < flight.sim.outcome.endedAt;
  }

  function canGrab(now: number) {
    if (!state || state.phase !== 'racing' || state.me.finishedAt !== null || drag) return false;
    if (flight) return false;
    return state.cooldownMs === 0 && state.me.flight === null;
  }

  // ---- input --------------------------------------------------------------
  function pointerPos(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  canvas.addEventListener('pointerdown', (e) => {
    const now = performance.now();
    if (!canGrab(now)) return;
    const p = pointerPos(e);
    // Nearest resting ball, within a generous reach.
    let best: BallView | null = null;
    let bestD = Math.max(60, W * 0.3);
    for (const b of restingBalls()) {
      const c = toCanvas(b.x, b.y);
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    if (!best) return;
    const at = clampLaunchPosition(best.x, best.y);
    drag = { ballId: best.id, pointerId: e.pointerId, x: at.x, y: at.y, samples: [{ x: e.clientX, y: e.clientY, t: e.timeStamp }] };
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    buzz(8);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const p = pointerPos(e);
    const b = clampLaunchPosition(fromCanvas(p.x, p.y).x, fromCanvas(p.x, p.y).y);
    drag.x = b.x;
    drag.y = b.y;
    drag.samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    if (drag.samples.length > 64) drag.samples.splice(0, drag.samples.length - 64);
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    const gesture = readFlick(drag.samples, H);
    const speed = gesture ? gesture.power * PHYSICS.maxLaunchSpeed : 0;
    const vel = gesture ? clampLaunch(speed * gesture.dirX, speed * gesture.dirY) : { vx: 0, vy: 0 };
    const launch = { ball: drag.ballId, x: drag.x, y: drag.y, vx: vel.vx, vy: vel.vy };
    const atRest: BallAtRest[] = restingBalls().map(({ id, x, y }) => ({ id, x, y }));
    drag = null;
    if (!state || state.phase !== 'racing') return;
    startFlight(simulateRoll(launch, atRest), performance.now(), state.me.rolls);
    send({ type: 'roll', ...launch });
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  function startFlight(sim: RollSimulation, launchedAt: number, rollsBefore: number) {
    const isDrop = sim.outcome.kind === 'back' && sim.outcome.peakY < BOARD.rampLength && sim.captures.length === 0;
    flight = { sim, launchedAt, rollsBefore, isDrop, confirmed: null, popupAt: null, nextEvent: 0, skipShown: false };
    labels = [];
    prevBoard.clear();
  }

  /** Advance each moving ball's spin by how far it rolled since the last frame. */
  function updateSpins(now: number) {
    if (!flight) return;
    const { sim } = flight;
    const n = sim.ids.length;
    const t = now - flight.launchedAt;
    const last = sim.frames.length / (n * 2) - 1;
    const i = clamp(Math.floor(t / PHYSICS.stepMs), 0, last);
    for (let k = 0; k < n; k++) {
      const id = sim.ids[k]!;
      const bx = sim.frames[(i * n + k) * 2]!;
      const by = sim.frames[(i * n + k) * 2 + 1]!;
      if (Number.isNaN(bx)) continue;
      const prev = prevBoard.get(id);
      if (prev) {
        const dx = bx - prev.x;
        const dy = by - prev.y;
        const ds = Math.sqrt(dx * dx + dy * dy);
        if (ds > 1e-4) {
          const angle = ds / PHYSICS.ballRadius;
          const s = spin2d.get(id) ?? { spin: 0, dirX: 0, dirY: -1 };
          spin2d.set(id, { spin: s.spin + angle, dirX: dx / ds, dirY: -dy / ds });
          // A ball rolling along d on a table with normal z turns about z × d.
          const q = orientation.get(id) ?? QUAT_IDENTITY;
          orientation.set(id, quatNormalize(quatMultiply(quatFromAxisAngle(-dy, dx, 0, angle), q)));
        }
      }
      prevBoard.set(id, { x: bx, y: by });
    }
  }

  // ---- drawing ------------------------------------------------------------
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);
    drawBoard();
    drawHoles();
    announceEvents(now);
    updateSpins(now);
    drawBalls(now);
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

    // Front bumper: a raised bar the balls rest against
    const by0 = yTo(BOARD.ballStartY - PHYSICS.ballRadius);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(cx() - halfWidthAt(by0), by0 - 2, halfWidthAt(by0) * 2, 6);
    ctx.fillStyle = 'rgba(255, 220, 160, 0.35)';
    ctx.fillRect(cx() - halfWidthAt(by0), by0 - 4, halfWidthAt(by0) * 2, 2);

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

  /** Where every ball is on screen this frame. */
  function poses(now: number): BallPose[] {
    const out: BallPose[] = [];
    if (flight) {
      const { sim } = flight;
      const n = sim.ids.length;
      const t = now - flight.launchedAt;
      const last = sim.frames.length / (n * 2) - 1;
      const i = clamp(Math.floor(t / PHYSICS.stepMs), 0, last);
      for (let k = 0; k < n; k++) {
        const id = sim.ids[k]!;
        const bx = sim.frames[(i * n + k) * 2]!;
        const by = sim.frames[(i * n + k) * 2 + 1]!;
        if (!Number.isNaN(bx)) {
          const { x, y } = toCanvas(bx, by);
          out.push({ id, x, y, scale: 1, alpha: 1, lifted: false, sinkingInto: null, sink: 0 });
          continue;
        }
        // Off the table: dropping into a hole or the gutter.
        const cap = sim.captures.find((c) => c.ball === k);
        if (cap) {
          const s = clamp((t - cap.t) / SINK_MS, 0, 1);
          if (s >= 1) continue;
          const ev = sim.events.find((e) => e.type === 'hit' && e.ball === k)!;
          const from = toCanvas(ev.x, ev.y);
          const hole = holeFor(cap.hole.row, cap.hole.col);
          const slide = clamp(s / 0.45, 0, 1);
          const eased = 1 - Math.pow(1 - slide, 2);
          const drop = clamp((s - 0.3) / 0.7, 0, 1);
          const { ry } = holeSize(hole.y);
          out.push({
            id,
            x: from.x + (hole.x - from.x) * eased,
            y: from.y + (hole.y - from.y) * eased + drop * drop * ry * 2.4,
            scale: 1 - drop * 0.25,
            alpha: 1 - clamp((s - 0.75) / 0.25, 0, 1),
            lifted: false,
            sinkingInto: hole,
            sink: drop,
          });
          continue;
        }
        const gut = sim.events.find((e) => e.type === 'gutter' && e.ball === k);
        if (gut) {
          const s = clamp((t - gut.t) / SINK_MS, 0, 1);
          if (s >= 1) continue;
          const { x, y } = toCanvas(gut.x, gut.y);
          out.push({ id, x, y: y - s * H * 0.02, scale: 1 - s * 0.6, alpha: 1 - s, lifted: false, sinkingInto: null, sink: 0 });
        }
      }
      return out;
    }

    for (const b of state?.me.balls ?? []) {
      if (b.status !== 'resting') {
        appearedAt.delete(b.id);
        continue;
      }
      if (!appearedAt.has(b.id)) appearedAt.set(b.id, now);
      const fade = clamp((now - appearedAt.get(b.id)!) / APPEAR_MS, 0, 1);
      if (drag && drag.ballId === b.id) {
        const { x, y } = toCanvas(drag.x, drag.y);
        out.push({ id: b.id, x, y, scale: 1.12, alpha: 1, lifted: true, sinkingInto: null, sink: 0 });
      } else {
        const { x, y } = toCanvas(b.x, b.y);
        out.push({ id: b.id, x, y, scale: 0.6 + 0.4 * fade, alpha: fade, lifted: false, sinkingInto: null, sink: 0 });
      }
    }
    return out;
  }

  /**
   * A carnival ball for browsers without WebGL: player colour with cream spots
   * on two rings around the rolling axis, so the spots sweep across the face.
   */
  function drawSphere(x: number, y: number, r: number, color: string, alpha: number, dim: number, s: Spin2D) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.clip();
    const base = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.15, x, y, r);
    base.addColorStop(0, shade(color, 0.25));
    base.addColorStop(0.6, color);
    base.addColorStop(1, shade(color, -0.65));
    ctx.fillStyle = base;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    const ax = -s.dirY;
    const ay = s.dirX;
    const spotR = r * 0.2;
    for (const ring of [-0.5, 0.5]) {
      const ringR = Math.sqrt(1 - ring * ring);
      for (let k = 0; k < 4; k++) {
        const th = s.spin + (k * Math.PI) / 2 + (ring > 0 ? Math.PI / 4 : 0);
        const depth = Math.cos(th);
        if (depth <= 0.05) continue;
        const along = Math.sin(th) * ringR;
        const sx = x + (ax * ring + s.dirX * along) * r;
        const sy = y + (ay * ring + s.dirY * along) * r;
        ctx.beginPath();
        ctx.ellipse(sx, sy, spotR * Math.max(0.15, depth), spotR, Math.atan2(s.dirY, s.dirX), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 244, 220, ${0.35 + 0.55 * depth})`;
        ctx.fill();
      }
    }
    const spec = ctx.createRadialGradient(x - r * 0.4, y - r * 0.45, 0, x - r * 0.4, y - r * 0.45, r * 0.55);
    spec.addColorStop(0, 'rgba(255,255,255,0.95)');
    spec.addColorStop(0.35, 'rgba(255,255,255,0.35)');
    spec.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = spec;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    if (dim > 0) {
      ctx.fillStyle = `rgba(0,0,0,${dim})`;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  /** Draw one ball: the WebGL sphere when available, the painted one otherwise. */
  function paintBall(id: number, x: number, y: number, r: number, color: string, alpha: number, dim: number) {
    if (ball3d) {
      const img = ball3d.render(hexToRgb(color), [1, 0.96, 0.86], orientation.get(id) ?? QUAT_IDENTITY, dim);
      const half = r / ball3d.radiusFraction;
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, x - half, y - half, half * 2, half * 2);
      ctx.globalAlpha = 1;
    } else {
      drawSphere(x, y, r, color, alpha, dim, spin2d.get(id) ?? { spin: 0, dirX: 0, dirY: -1 });
    }
  }

  /** Ghosts behind the rolled ball while it's quick. */
  function drawTrail(now: number, r: number, color: string) {
    if (!flight) return;
    const { sim } = flight;
    const n = sim.ids.length;
    const k = sim.launched;
    const t = now - flight.launchedAt;
    const last = sim.frames.length / (n * 2) - 1;
    const i = clamp(Math.floor(t / PHYSICS.stepMs), 0, last);
    if (i < 2) return;
    const at = (j: number) => ({ x: sim.frames[(j * n + k) * 2]!, y: sim.frames[(j * n + k) * 2 + 1]! });
    const a = at(i);
    const b = at(i - 1);
    if (Number.isNaN(a.x) || Number.isNaN(b.x)) return;
    const speed = Math.hypot(a.x - b.x, a.y - b.y) / (PHYSICS.stepMs / 1000);
    const strength = clamp((speed - 3) / 9, 0, 1);
    if (strength <= 0) return;
    for (let g = 1; g <= 3; g++) {
      const j = i - g * 3;
      if (j < 0) break;
      const p = at(j);
      if (Number.isNaN(p.x)) break;
      const { x, y } = toCanvas(p.x, p.y);
      ctx.beginPath();
      ctx.arc(x, y, r * (1 - g * 0.12), 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(color, strength * (0.28 - g * 0.07));
      ctx.fill();
    }
  }

  function drawBalls(now: number) {
    const color = me?.color ?? '#fff';
    const live = tableLive(now);
    const grab = canGrab(now);
    const list = poses(now).sort((a, b) => a.y - b.y);
    if (flight) {
      const launchedId = flight.sim.ids[flight.sim.launched]!;
      const p = list.find((q) => q.id === launchedId);
      if (p && live) drawTrail(now, ballPx(p.y), color);
    }
    for (const pose of list) {
      const hopT = (now - (lastHopAt.get(pose.id) ?? -Infinity)) / HOP_MS;
      const hop = hopT >= 0 && hopT < 1 ? Math.sin(hopT * Math.PI) : 0;
      const lift = pose.lifted ? 1 : hop;
      const r = ballPx(pose.y) * pose.scale * (1 + hop * 0.12);
      const bx = pose.x;
      const by = pose.y - lift * r * 0.8;
      const dimIdle = !live && !grab && !pose.lifted && !pose.sinkingInto ? 0.35 : 0;

      // Contact shadow: drifts away from a lifted or hopping ball
      if (!pose.sinkingInto || pose.sink < 0.5) {
        ctx.beginPath();
        ctx.ellipse(bx + r * (0.2 + lift * 0.3), pose.y + r * 0.45, r * (1 + lift * 0.25), r * 0.55, 0, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0,0,0,${(0.35 - lift * 0.15) * pose.alpha})`;
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
        paintBall(pose.id, bx, by, r, color, pose.alpha, pose.sink * 0.7);
        ctx.restore();
        drawHoleFront(pose.sinkingInto.x, pose.sinkingInto.y, pose.sinkingInto.zone);
      } else {
        paintBall(pose.id, bx, by, r, color, pose.alpha, dimIdle);
      }
    }

    if (grab && !drag && list.length) {
      // Nudge: point at the nearest ball to the middle of the bumper
      const rest = toCanvas(0, BOARD.ballStartY);
      const p = list.reduce((a, b) => (Math.abs(a.x - rest.x) < Math.abs(b.x - rest.x) ? a : b));
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = `600 ${Math.max(12, W * 0.035)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('▲ grab & flick', p.x, p.y - ballPx(p.y) - 16 + Math.sin(now / 250) * 3);
    }
  }

  /** Turn simulation events into little on-board labels and haptics as the balls reach them. */
  function announceEvents(now: number) {
    if (!flight) return;
    const t = now - flight.launchedAt;
    const events = flight.sim.events;
    while (flight.nextEvent < events.length && events[flight.nextEvent]!.t <= t) {
      const ev = events[flight.nextEvent++]!;
      const id = flight.sim.ids[ev.ball]!;
      const label = eventLabel(ev);
      if (label && !(ev.type === 'skip' && flight.skipShown)) labels.push({ ...label, x: ev.x, y: ev.y, at: now });
      if (ev.type === 'skip') flight.skipShown = true;
      if (ev.type === 'lip' || ev.type === 'skip') {
        buzz(10);
        lastHopAt.set(id, now);
      }
      if (ev.type === 'rail' || ev.type === 'bumper' || ev.type === 'ball') buzz(6);
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
    const serverDone = !!state && state.me.flight === null && state.cooldownMs === 0;

    if (flight.isDrop) {
      if (settled && serverDone) flight = null;
      return;
    }
    if (settled && flight.confirmed && flight.popupAt === null) {
      flight.popupAt = now;
      buzz(flight.confirmed.kind === 'hit' ? [30, 40, 30] : 15);
    }
    if (flight.popupAt === null) {
      // Server never confirmed (e.g. it rejected the roll): let the flight expire quietly.
      if (settled && serverDone && t > flight.sim.outcome.endedAt + 1500) flight = null;
      return;
    }
    const u = (now - flight.popupAt) / POPUP_MS;
    if (u > 1) {
      if (serverDone) flight = null;
      return;
    }
    const { kind, points, zone } = flight.confirmed!;
    const text = kind === 'hit' && zone ? `${ZONE_LABEL[zone].toUpperCase()} +${points}` : kind === 'gutter' ? 'GUTTER' : 'ROLLED BACK';
    // Popups live in the ramp area so they never cover the board or legend.
    const y = (yTo(BOARD.rampLength) + yTo(BOARD.ballStartY)) / 2 - u * 40;
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
      small = 'Grab a ball and flick it when the race starts';
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
      // A roll in progress on the server but not here (reconnect / reload mid-roll): pick it up in progress.
      if (!flight && next.me.flight) {
        const elapsed = next.raceMs - next.me.flight.launchedAt;
        const sim = simulateRoll(next.me.flight.launch, next.me.flight.atRest);
        if (elapsed < sim.outcome.endedAt) startFlight(sim, performance.now() - elapsed, next.me.rolls);
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
            ? 'Grab a ball, drag it up the ramp and flick. Balls stay where they land.'
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
  const last = samples[samples.length - 1]!;
  // Velocity from the final window of the gesture, so a slow wind-up
  // followed by a snap still counts as a snap.
  let ref = samples[0]!;
  for (const s of samples) {
    if (last.t - s.t <= VELOCITY_WINDOW_MS) {
      ref = s;
      break;
    }
  }
  const dx = last.x - ref.x;
  const dy = ref.y - last.y; // up is positive
  if (dy < MIN_FLICK_PX * 0.5) return null;
  const dt = Math.max(16, last.t - ref.t);
  const speed = dy / canvasHeight / (dt / 1000); // canvas heights per second
  // Half from how hard you snap, half from how far the final flick travelled.
  const power = clamp(0.5 * (speed / POWER_SCALE) + 0.5 * (dy / canvasHeight / (DISTANCE_SCALE * 0.5)), 0, 1);
  const len = Math.sqrt(dx * dx + dy * dy);
  return { power, dirX: dx / len, dirY: dy / len };
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

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [1, 1, 1];
  return [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255];
}

function hexToRgba(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return `rgba(255,255,255,${a})`;
  return `rgba(${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)},${a})`;
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
