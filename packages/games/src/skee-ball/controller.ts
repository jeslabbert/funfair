import type { PlayerInfo } from '@funfair/shared';
import type { ControllerView } from '@funfair/shared/client';
import {
  BALLS_PER_PLAYER,
  LANE,
  PHYSICS,
  RINGS,
  clamp,
  clampLaunch,
  clampLaunchPosition,
  grabBall,
  ordinal,
  tableRules,
  type BallState,
  type SkeeBallInput,
  type SkeeBallPlayerState,
  type TableEvent,
  type TableState,
} from './logic';
import { QUAT_IDENTITY, createBallRenderer, quatFromAxisAngle, quatMultiply, quatNormalize, type Quat } from '../render/ball3d';
import { buzz, fitFont, hexToRgb, hexToRgba, readFlick, shade, type Sample } from '../render/util';
import { Prediction } from '../lockstep/client';

/** Colours for each score, used on the board, in popups and on the host. */
export const POINT_COLORS: Record<number, string> = {
  0: '#9aa0b4',
  10: '#e9e4d6',
  20: '#5ce07a',
  30: '#4fb8ff',
  40: '#ffb547',
  50: '#ff5c5c',
  100: '#ffe74c',
};
export const pointColor = (p: number) => POINT_COLORS[p] ?? '#fff';

const POPUP_MS = 900;
const LABEL_MS = 650;
const SINK_MS = 380;
const MISS_MS = 450;
const FLASH_MS = 600;
/** Width of a cup's raised lip, in world units. */
const LIP_WIDTH = 0.12;
/** How far back the lane's perspective reaches: larger = flatter. */
const PERSPECTIVE = 8;
/** Vertical pixels per world unit of height, as a fraction of the lane's unit size. */
const Z_LIFT = 0.8;

interface Drag {
  ballId: number;
  pointerId: number;
  /** Lane units. */
  x: number;
  y: number;
  /** Finger, in canvas pixels. */
  px: number;
  py: number;
  samples: Sample[];
}

interface Sink {
  id: number;
  x: number;
  y: number;
  z: number;
  at: number;
}

interface Miss {
  id: number;
  x: number;
  y: number;
  z: number;
  at: number;
}

interface Popup {
  text: string;
  color: string;
  at: number;
}

interface FloatingLabel {
  text: string;
  color: string;
  x: number;
  y: number;
  z: number;
  at: number;
}

interface Flash {
  points: number;
  x: number;
  at: number;
}

interface BallPose {
  id: number;
  x: number;
  y: number;
  /** Where its shadow sits (ground), if any. */
  gx: number;
  gy: number;
  height: number; // 0..1 how far off the ground the shadow should drift
  r: number;
  alpha: number;
  dim: number;
  lifted: boolean;
}

export function mountSkeeBallController(
  root: HTMLElement,
  send: (input: SkeeBallInput) => void,
): ControllerView<SkeeBallPlayerState> {
  root.innerHTML = `
    <div class="skb-ctl">
      <div class="skb-ctl-top">
        <div class="skb-ctl-rank">—</div>
        <div class="skb-ctl-score">0</div>
        <div class="skb-ctl-timer">1:00</div>
      </div>
      <div class="skb-ctl-pips" aria-label="balls left"></div>
      <canvas class="skb-lane"></canvas>
      <div class="skb-ctl-hint">Grab a ball from the tray and flick it up the lane</div>
    </div>`;

  const el = root.querySelector<HTMLElement>('.skb-ctl')!;
  const canvas = root.querySelector<HTMLCanvasElement>('.skb-lane')!;
  const rankEl = root.querySelector<HTMLElement>('.skb-ctl-rank')!;
  const scoreEl = root.querySelector<HTMLElement>('.skb-ctl-score')!;
  const timerEl = root.querySelector<HTMLElement>('.skb-ctl-timer')!;
  const pipsEl = root.querySelector<HTMLElement>('.skb-ctl-pips')!;
  const hintEl = root.querySelector<HTMLElement>('.skb-ctl-hint')!;
  const ctx = canvas.getContext('2d')!;

  let state: SkeeBallPlayerState | null = null;
  let me: PlayerInfo | null = null;
  let players = new Map<string, PlayerInfo>();
  const pred = new Prediction<TableState, SkeeBallInput, TableEvent>(tableRules);
  let drag: Drag | null = null;
  let labels: FloatingLabel[] = [];
  let sinks: Sink[] = [];
  let misses: Miss[] = [];
  let flashes: Flash[] = [];
  let popup: Popup | null = null;
  let shownScore = 0;
  let raf = 0;
  let W = 0;
  let H = 0;

  const orientation = new Map<number, Quat>();
  const spin2d = new Map<number, { spin: number; dirX: number; dirY: number }>();
  const prevPos = new Map<number, { x: number; y: number; z: number }>();
  const trails = new Map<number, { x: number; y: number; z: number }[]>();
  const lastLipAt = new Map<number, number>();
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

  // ---- world ↔ canvas -----------------------------------------------------
  // Ground plane: y runs away from the player; the far end recedes with a
  // little perspective. Height (z) lifts a point straight up on screen.
  const Y_MAX = LANE.boardBaseY + LANE.boardLength * LANE.boardCos + 0.6;
  const bottom = () => H * 0.85;
  const top = () => H * 0.3;
  const trayY = () => H * 0.935;
  const cx = () => W / 2;
  const depth = (y: number) => (y / (y + PERSPECTIVE)) / (Y_MAX / (Y_MAX + PERSPECTIVE));
  const yTo = (y: number) => bottom() - (bottom() - top()) * depth(y);
  const yFrom = (cy: number) => {
    const p = clamp(((bottom() - cy) / (bottom() - top())) * (Y_MAX / (Y_MAX + PERSPECTIVE)), 0, 0.98);
    return (p * PERSPECTIVE) / (1 - p);
  };
  const halfWidthAt = (cy: number) => {
    const t = clamp((bottom() - cy) / (bottom() - top()), 0, 1);
    return W * (0.47 - 0.17 * t);
  };
  const unitAt = (cy: number) => halfWidthAt(cy) / LANE.halfWidth;
  /** Screen position of a world point, plus where its shadow falls. */
  const project = (x: number, y: number, z: number) => {
    const gy = yTo(y);
    const u = unitAt(gy);
    return { x: cx() + x * u, y: gy - z * u * Z_LIFT, gx: cx() + x * u, gy, unit: u };
  };
  const toCanvas = (x: number, y: number) => {
    const p = project(x, y, 0);
    return { x: p.x, y: p.y };
  };
  const fromCanvas = (px: number, py: number) => ({ x: (px - cx()) / unitAt(clamp(py, top(), bottom())), y: yFrom(py) });
  const ballPx = (unit: number) => unit * PHYSICS.ballRadius * 1.15;
  /** A point on the board face. */
  const facePt = (x: number, u: number) => project(x, LANE.boardBaseY + u * LANE.boardCos, u * LANE.boardSin);
  /** Screen radii of a circle of radius r drawn on the face around (x, u). */
  const faceRadii = (x: number, u: number, r: number) => {
    const c = facePt(x, u);
    const up = facePt(x, u + 0.05);
    return { rx: r * c.unit, ry: (r * Math.abs(c.y - up.y)) / 0.05 };
  };
  const traySlot = (id: number) => {
    const gap = Math.min(W * 0.1, (W * 0.92) / BALLS_PER_PLAYER);
    return { x: cx() + (id - (BALLS_PER_PLAYER - 1) / 2) * gap, y: trayY(), r: gap * 0.4 };
  };

  // ---- local simulation ---------------------------------------------------
  const playing = () => !!state && (state.phase === 'playing' || state.phase === 'finished');

  function advanceLocal(now: number) {
    if (!playing()) return;
    pred.advance(now, (ev) => onEvent(ev, now));
  }

  function grabbable(): BallState[] {
    return pred.state?.balls.filter((b) => b.status === 'racked' || b.status === 'resting') ?? [];
  }

  function canGrab() {
    return !!state && state.phase === 'playing' && !drag && !!pred.state;
  }

  function ballScreen(b: BallState): { x: number; y: number } {
    if (b.status === 'racked') {
      const s = traySlot(b.id);
      return { x: s.x, y: s.y };
    }
    return toCanvas(b.x, b.y);
  }

  // ---- input --------------------------------------------------------------
  function pointerPos(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function dragTo(px: number, py: number) {
    if (!drag) return;
    const lane = fromCanvas(px, py);
    const at = clampLaunchPosition(lane.x, lane.y);
    drag.x = at.x;
    drag.y = at.y;
    drag.px = px;
    drag.py = py;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!canGrab()) return;
    const p = pointerPos(e);
    let best: BallState | null = null;
    let bestD = Math.max(60, W * 0.3);
    for (const b of grabbable()) {
      const c = ballScreen(b);
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    if (!best || !pred.state) return;
    const start = best.status === 'racked' ? clampLaunchPosition(fromCanvas(p.x, bottom()).x, LANE.ballStartY) : clampLaunchPosition(best.x, best.y);
    drag = { ballId: best.id, pointerId: e.pointerId, x: start.x, y: start.y, px: p.x, py: p.y, samples: [{ x: e.clientX, y: e.clientY, t: e.timeStamp }] };
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    const id = best.id;
    const input = pred.input((tick) => ({ type: 'grab', ball: id, tick }));
    if (input) send(input);
    buzz(8);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const p = pointerPos(e);
    dragTo(p.x, p.y);
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
    drag = null;
    if (!pred.state || !state || state.phase !== 'playing') return;
    const input = pred.input((tick) => ({ type: 'roll', ...launch, tick }));
    if (input) send(input);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /** Something happened on the table: labels, haptics, animations, popups. */
  function onEvent(ev: TableEvent, now: number) {
    switch (ev.type) {
      case 'launch':
        trails.delete(ev.ball);
        break;
      case 'jump':
        labels.push({ text: 'jump!', color: '#fff', x: ev.x, y: ev.y, z: ev.z, at: now });
        buzz(12);
        break;
      case 'hop':
        labels.push({ text: 'bounce!', color: '#ffb547', x: ev.x, y: ev.y, z: ev.z, at: now });
        buzz(10);
        break;
      case 'land':
        buzz(8);
        break;
      case 'lip': {
        const last = lastLipAt.get(ev.ball) ?? -Infinity;
        if (now - last > 350) {
          labels.push({ text: 'lip!', color: pointColor(ev.points ?? 10), x: ev.x, y: ev.y, z: ev.z, at: now });
          buzz(6);
        }
        lastLipAt.set(ev.ball, now);
        break;
      }
      case 'skip':
        labels.push({ text: 'skipped', color: 'rgba(255,255,255,0.8)', x: ev.x, y: ev.y, z: ev.z, at: now });
        break;
      case 'rail':
      case 'bumper':
      case 'ball':
      case 'wall':
        buzz(6);
        break;
      case 'score': {
        const points = ev.points ?? 0;
        sinks.push({ id: ev.ball, x: ev.x, y: ev.y, z: ev.z, at: now });
        flashes.push({ points, x: ev.x, at: now });
        popup = { text: points >= 100 ? `POCKET +${points}` : `+${points}`, color: pointColor(points), at: now };
        buzz(points >= 50 ? [30, 40, 30] : points >= 20 ? [20, 30] : 15);
        break;
      }
      case 'miss':
        misses.push({ id: ev.ball, x: ev.x, y: ev.y, z: ev.z, at: now });
        popup = { text: 'OVER THE TOP', color: 'rgba(255,255,255,0.75)', at: now };
        buzz(15);
        break;
      case 'settle':
        break;
    }
  }

  /** Advance each moving ball's spin and trail by how far it moved since the last frame. */
  function updateSpins() {
    if (!pred.state) return;
    for (const b of pred.state.balls) {
      if (b.status !== 'rolling' && b.status !== 'resting' && b.status !== 'flying' && b.status !== 'board') {
        prevPos.delete(b.id);
        continue;
      }
      const prev = prevPos.get(b.id);
      if (prev) {
        const dx = b.x - prev.x;
        const dy = b.y - prev.y;
        const dz = b.z - prev.z;
        const ds = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const flat = Math.sqrt(dx * dx + dy * dy);
        if (ds > 1e-4 && flat > 1e-6) {
          const angle = ds / PHYSICS.ballRadius;
          const s = spin2d.get(b.id) ?? { spin: 0, dirX: 0, dirY: -1 };
          spin2d.set(b.id, { spin: s.spin + angle, dirX: dx / flat, dirY: -dy / flat });
          const q = orientation.get(b.id) ?? QUAT_IDENTITY;
          orientation.set(b.id, quatNormalize(quatMultiply(quatFromAxisAngle(-dy / flat, dx / flat, 0, angle), q)));
        }
      }
      prevPos.set(b.id, { x: b.x, y: b.y, z: b.z });
      const trail = trails.get(b.id) ?? [];
      trail.push({ x: b.x, y: b.y, z: b.z });
      if (trail.length > 12) trail.shift();
      trails.set(b.id, trail);
    }
  }

  // ---- drawing ------------------------------------------------------------
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);
    advanceLocal(now);
    updateSpins();
    drawCabinet();
    drawBoard(now);
    drawLane();
    drawTray();
    drawBalls(now);
    drawLabels(now);
    drawPopup(now);
    drawOverlay();
  }

  /** The back of the machine: walls either side of the pit and behind the board. */
  function drawCabinet() {
    const wallH = LANE.boardLength * LANE.boardSin + 0.5;
    const backTop = project(0, Y_MAX, wallH).y;
    const backBase = yTo(Y_MAX);
    // Back wall
    ctx.fillStyle = '#1a1035';
    ctx.beginPath();
    ctx.moveTo(cx() - halfWidthAt(backBase), backTop);
    ctx.lineTo(cx() + halfWidthAt(backBase), backTop);
    ctx.lineTo(cx() + halfWidthAt(backBase), backBase);
    ctx.lineTo(cx() - halfWidthAt(backBase), backBase);
    ctx.closePath();
    ctx.fill();
    // Side walls from the ramp back
    for (const side of [-1, 1]) {
      const a = project(side * LANE.halfWidth, LANE.launchY, 0);
      const b = project(side * LANE.halfWidth, Y_MAX, 0);
      const c = project(side * LANE.halfWidth, Y_MAX, wallH);
      const d = project(side * LANE.halfWidth, LANE.launchY, wallH);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
      ctx.closePath();
      ctx.fillStyle = side < 0 ? '#2b1c4f' : '#241744';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // The pit floor between the ramp and the board (all of it scores 10)
    const p0 = project(-LANE.halfWidth, LANE.launchY, 0);
    const p1 = project(LANE.halfWidth, LANE.launchY, 0);
    const p2 = project(LANE.halfWidth, LANE.boardBaseY, 0);
    const p3 = project(-LANE.halfWidth, LANE.boardBaseY, 0);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.closePath();
    ctx.fillStyle = '#120c26';
    ctx.fill();
  }

  function drawBoard(now: number) {
    const hw = LANE.boardHalfWidth;
    const L = LANE.boardLength;
    const bl = facePt(-hw, 0);
    const br = facePt(hw, 0);
    const tr = facePt(hw, L);
    const tl = facePt(-hw, L);
    // Face
    ctx.beginPath();
    ctx.moveTo(bl.x, bl.y);
    ctx.lineTo(br.x, br.y);
    ctx.lineTo(tr.x, tr.y);
    ctx.lineTo(tl.x, tl.y);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, tl.y, 0, bl.y);
    g.addColorStop(0, '#3b2a5e');
    g.addColorStop(1, '#2a1d45');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 220, 160, 0.4)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // The "10" everywhere else
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = `700 ${Math.max(10, W * 0.03)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const side of [-1, 1]) {
      const p = facePt(side * (hw - 0.45), 0.35);
      ctx.fillText('10', p.x, p.y);
    }

    // Cups: each ring is a raised lip around a dark opening, largest first
    const fresh = (points: number, x: number) => {
      const f = flashes.find((k) => k.points === points && (points !== 100 || Math.sign(k.x) === Math.sign(x)));
      return f ? 1 - clamp((now - f.at) / FLASH_MS, 0, 1) : 0;
    };
    const cup = (x: number, u: number, r: number, points: number, label: string, labelU: number) => {
      const c = facePt(x, u);
      const { rx, ry } = faceRadii(x, u, r);
      const lipRx = rx * (LIP_WIDTH / r);
      const lipRy = ry * (LIP_WIDTH / r);
      const color = pointColor(points);
      // Lip: lit along the top, in shadow along the bottom
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI * 2);
      const lg = ctx.createLinearGradient(0, c.y - ry, 0, c.y + ry);
      lg.addColorStop(0, shade(color, 0.3));
      lg.addColorStop(0.5, color);
      lg.addColorStop(1, shade(color, -0.45));
      ctx.fillStyle = lg;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Shadow the lip throws down the face
      ctx.beginPath();
      ctx.ellipse(c.x, c.y + lipRy * 0.8, rx, ry, 0, 0, Math.PI);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fill();
      // Opening
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, rx - lipRx, ry - lipRy, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#0b0714';
      ctx.fill();
      // Lit far wall inside
      ctx.save();
      ctx.clip();
      ctx.beginPath();
      ctx.ellipse(c.x, c.y - ry * 0.35, (rx - lipRx) * 0.95, (ry - lipRy) * 0.95, 0, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(shade(color, -0.6), 0.6);
      ctx.fill();
      ctx.restore();
      const flash = fresh(points, x);
      if (flash > 0) {
        ctx.beginPath();
        ctx.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${0.55 * flash})`;
        ctx.fill();
      }
      const lp = facePt(x, labelU);
      ctx.fillStyle = color;
      ctx.font = `800 ${Math.max(8, Math.min(W * 0.032, lipRy * 3.2))}px system-ui, sans-serif`;
      ctx.fillText(label, lp.x, lp.y);
    };
    for (let i = RINGS.length - 1; i >= 0; i--) {
      const ring = RINGS[i]!;
      const inner = i > 0 ? RINGS[i - 1]!.r : 0;
      cup(0, LANE.ringU, ring.r, ring.points, String(ring.points), i === 0 ? LANE.ringU : LANE.ringU - (ring.r + inner) / 2 + LIP_WIDTH / 2);
    }
    for (const side of [-1, 1]) cup(side * LANE.pocketX, LANE.pocketU, LANE.pocketR, 100, '100', LANE.pocketU - LANE.pocketR - 0.28);
    flashes = flashes.filter((k) => now - k.at < FLASH_MS);
  }

  function drawLane() {
    const b = bottom();
    const rampTop = yTo(LANE.rampY);
    // Lane surface up to the ramp
    ctx.beginPath();
    ctx.moveTo(cx() - halfWidthAt(b), b);
    ctx.lineTo(cx() + halfWidthAt(b), b);
    ctx.lineTo(cx() + halfWidthAt(rampTop), rampTop);
    ctx.lineTo(cx() - halfWidthAt(rampTop), rampTop);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, rampTop, 0, b);
    g.addColorStop(0, '#4a2e15');
    g.addColorStop(0.5, '#5e3d1e');
    g.addColorStop(1, '#7c5330');
    ctx.fillStyle = g;
    ctx.fill();
    // Receding stripes
    ctx.strokeStyle = 'rgba(255, 235, 200, 0.05)';
    ctx.lineWidth = 1;
    for (let y = 1; y < LANE.rampY; y += 1) {
      const cy = yTo(y);
      ctx.beginPath();
      ctx.moveTo(cx() - halfWidthAt(cy), cy);
      ctx.lineTo(cx() + halfWidthAt(cy), cy);
      ctx.stroke();
    }
    // Placement zone marker
    const py = yTo(LANE.placeMaxY);
    ctx.strokeStyle = 'rgba(255, 220, 160, 0.22)';
    ctx.setLineDash([6, 8]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx() - halfWidthAt(py), py);
    ctx.lineTo(cx() + halfWidthAt(py), py);
    ctx.stroke();
    ctx.setLineDash([]);

    // The jump ramp: a wedge rising from the lane to its lip
    const lipZ = 0.55;
    const r0 = project(-LANE.halfWidth, LANE.rampY, 0);
    const r1 = project(LANE.halfWidth, LANE.rampY, 0);
    const r2 = project(LANE.halfWidth, LANE.launchY, lipZ);
    const r3 = project(-LANE.halfWidth, LANE.launchY, lipZ);
    ctx.beginPath();
    ctx.moveTo(r0.x, r0.y);
    ctx.lineTo(r1.x, r1.y);
    ctx.lineTo(r2.x, r2.y);
    ctx.lineTo(r3.x, r3.y);
    ctx.closePath();
    const rg = ctx.createLinearGradient(0, r2.y, 0, r0.y);
    rg.addColorStop(0, '#a87a4a');
    rg.addColorStop(1, '#5e3d1e');
    ctx.fillStyle = rg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 220, 160, 0.6)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(r3.x, r3.y);
    ctx.lineTo(r2.x, r2.y);
    ctx.stroke();

    // Front bumper
    const by0 = yTo(LANE.ballStartY - PHYSICS.ballRadius);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(cx() - halfWidthAt(by0), by0 - 2, halfWidthAt(by0) * 2, 6);
    ctx.fillStyle = 'rgba(255, 220, 160, 0.35)';
    ctx.fillRect(cx() - halfWidthAt(by0), by0 - 4, halfWidthAt(by0) * 2, 2);

    // Rails
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#2a1708';
    ctx.beginPath();
    ctx.moveTo(cx() - halfWidthAt(b), b);
    ctx.lineTo(cx() - halfWidthAt(rampTop), rampTop);
    ctx.moveTo(cx() + halfWidthAt(b), b);
    ctx.lineTo(cx() + halfWidthAt(rampTop), rampTop);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 220, 160, 0.55)';
    ctx.beginPath();
    ctx.moveTo(cx() - halfWidthAt(b) + 3, b);
    ctx.lineTo(cx() - halfWidthAt(rampTop) + 3, rampTop);
    ctx.moveTo(cx() + halfWidthAt(b) - 3, b);
    ctx.lineTo(cx() + halfWidthAt(rampTop) - 3, rampTop);
    ctx.stroke();
  }

  /** The ball tray under the lane. */
  function drawTray() {
    const y = trayY();
    const h = H * 0.11;
    ctx.fillStyle = '#1c1230';
    ctx.beginPath();
    ctx.roundRect(W * 0.02, y - h / 2, W * 0.96, h, 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Empty slots
    for (let id = 0; id < BALLS_PER_PLAYER; id++) {
      const s = traySlot(id);
      ctx.beginPath();
      ctx.ellipse(s.x, s.y + s.r * 0.3, s.r * 0.9, s.r * 0.35, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fill();
    }
  }

  /** Where every ball is on screen this frame. */
  function poses(now: number): BallPose[] {
    const out: BallPose[] = [];
    if (!pred.state) return out;
    for (const b of pred.state.balls) {
      if (drag && drag.ballId === b.id) {
        // Held: under the finger while it's below the lane, on the lane otherwise.
        const lane = toCanvas(drag.x, drag.y);
        const belowLane = drag.py > yTo(LANE.ballStartY);
        const x = belowLane ? clamp(drag.px, cx() - halfWidthAt(bottom()), cx() + halfWidthAt(bottom())) : lane.x;
        const y = belowLane ? Math.min(drag.py, trayY()) : lane.y;
        const unit = unitAt(clamp(y, top(), bottom()));
        out.push({ id: b.id, x, y, gx: x, gy: y, height: 1, r: ballPx(unit) * 1.12, alpha: 1, dim: 0, lifted: true });
        continue;
      }
      if (b.status === 'done') continue;
      if (b.status === 'racked') {
        const s = traySlot(b.id);
        out.push({ id: b.id, x: s.x, y: s.y, gx: s.x, gy: s.y, height: 0, r: s.r, alpha: 1, dim: 0, lifted: false });
        continue;
      }
      const p = project(b.x, b.y, b.z);
      if (b.status === 'board') {
        // On the face: its shadow sits on the face just below it.
        const f = facePt(b.x, b.u);
        out.push({ id: b.id, x: p.x, y: p.y, gx: f.x, gy: f.y, height: 0, r: ballPx(p.unit), alpha: 1, dim: 0, lifted: false });
        continue;
      }
      out.push({ id: b.id, x: p.x, y: p.y, gx: p.gx, gy: p.gy, height: clamp(b.z / 2, 0, 1), r: ballPx(p.unit), alpha: 1, dim: 0, lifted: false });
    }
    sinks = sinks.filter((k) => now - k.at < SINK_MS);
    for (const k of sinks) {
      const s = clamp((now - k.at) / SINK_MS, 0, 1);
      const p = project(k.x, k.y, k.z);
      out.push({ id: k.id, x: p.x, y: p.y + s * p.unit * 0.25, gx: p.gx, gy: p.gy, height: 0, r: ballPx(p.unit) * (1 - s * 0.55), alpha: 1 - clamp((s - 0.6) / 0.4, 0, 1), dim: s * 0.8, lifted: false });
    }
    misses = misses.filter((k) => now - k.at < MISS_MS);
    for (const k of misses) {
      const s = clamp((now - k.at) / MISS_MS, 0, 1);
      const p = project(k.x, k.y, k.z);
      out.push({ id: k.id, x: p.x, y: p.y - s * H * 0.05, gx: p.gx, gy: p.gy, height: 1, r: ballPx(p.unit) * (1 - s * 0.5), alpha: 1 - s, dim: s * 0.5, lifted: false });
    }
    return out;
  }

  function drawSphere(x: number, y: number, r: number, color: string, alpha: number, dim: number, id: number) {
    const s = spin2d.get(id) ?? { spin: 0, dirX: 0, dirY: -1 };
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
    for (const ring of [-0.5, 0.5]) {
      const ringR = Math.sqrt(1 - ring * ring);
      for (let k = 0; k < 4; k++) {
        const th = s.spin + (k * Math.PI) / 2 + (ring > 0 ? Math.PI / 4 : 0);
        const d = Math.cos(th);
        if (d <= 0.05) continue;
        const along = Math.sin(th) * ringR;
        ctx.beginPath();
        ctx.ellipse(x + (ax * ring + s.dirX * along) * r, y + (ay * ring + s.dirY * along) * r, r * 0.2 * Math.max(0.15, d), r * 0.2, Math.atan2(s.dirY, s.dirX), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 244, 220, ${0.35 + 0.55 * d})`;
        ctx.fill();
      }
    }
    const spec = ctx.createRadialGradient(x - r * 0.4, y - r * 0.45, 0, x - r * 0.4, y - r * 0.45, r * 0.55);
    spec.addColorStop(0, 'rgba(255,255,255,0.95)');
    spec.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = spec;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    if (dim > 0) {
      ctx.fillStyle = `rgba(0,0,0,${dim})`;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  function paintBall(id: number, x: number, y: number, r: number, color: string, alpha: number, dim: number) {
    if (ball3d) {
      const img = ball3d.render(hexToRgb(color), [1, 0.96, 0.86], orientation.get(id) ?? QUAT_IDENTITY, dim);
      const half = r / ball3d.radiusFraction;
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, x - half, y - half, half * 2, half * 2);
      ctx.globalAlpha = 1;
    } else {
      drawSphere(x, y, r, color, alpha, dim, id);
    }
  }

  function drawTrail(b: BallState, color: string) {
    const trail = trails.get(b.id);
    if (!trail || trail.length < 6) return;
    const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
    const strength = clamp((speed - 3) / 9, 0, 1);
    if (strength <= 0) return;
    for (let g = 1; g <= 3; g++) {
      const p = trail[trail.length - 1 - g * 2];
      if (!p) break;
      const s = project(p.x, p.y, p.z);
      ctx.beginPath();
      ctx.arc(s.x, s.y, ballPx(s.unit) * (1 - g * 0.12), 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(color, strength * (0.28 - g * 0.07));
      ctx.fill();
    }
  }

  function drawBalls(now: number) {
    const color = me?.color ?? '#fff';
    const list = poses(now).sort((a, b) => a.gy - b.gy);
    if (pred.state) for (const b of pred.state.balls) if (b.status === 'rolling' || b.status === 'flying' || b.status === 'board') drawTrail(b, color);
    for (const pose of list) {
      const lift = pose.lifted ? 1 : pose.height;
      // Contact shadow, drifting off and softening as the ball rises
      ctx.beginPath();
      ctx.ellipse(pose.gx + pose.r * (0.2 + lift * 0.3), pose.gy + pose.r * 0.45, pose.r * (1 + lift * 0.3), pose.r * 0.5, 0, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,0,0,${(0.35 - lift * 0.2) * pose.alpha})`;
      ctx.fill();
      paintBall(pose.id, pose.x, pose.y - (pose.lifted ? pose.r * 0.8 : 0), pose.r, color, pose.alpha, pose.dim);
    }

    if (canGrab() && pred.state) {
      const next = grabbable()[0];
      if (next) {
        const c = ballScreen(next);
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.font = `600 ${Math.max(12, W * 0.035)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const r = next.status === 'racked' ? traySlot(next.id).r : ballPx(unitAt(c.y));
        ctx.fillText('▲ grab & flick', clamp(c.x, W * 0.2, W * 0.8), c.y - r - 16 + Math.sin(now / 250) * 3);
      }
    }
  }

  function drawLabels(now: number) {
    labels = labels.filter((l) => now - l.at < LABEL_MS);
    for (const l of labels) {
      const u = (now - l.at) / LABEL_MS;
      const p = project(l.x, l.y, l.z);
      ctx.globalAlpha = 1 - u * u;
      ctx.fillStyle = l.color;
      ctx.font = `800 ${Math.max(11, W * 0.036)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(l.text, p.x, p.y - p.unit * 0.6 - u * 14);
      ctx.fillText(l.text, p.x, p.y - p.unit * 0.6 - u * 14);
    }
    ctx.globalAlpha = 1;
  }

  function drawPopup(now: number) {
    if (!popup) return;
    const u = (now - popup.at) / POPUP_MS;
    if (u > 1) {
      popup = null;
      return;
    }
    const y = (yTo(LANE.rampY) + yTo(LANE.ballStartY)) / 2 - u * 40;
    ctx.globalAlpha = 1 - u * u;
    ctx.fillStyle = popup.color;
    fitFont(ctx, popup.text, 900, Math.max(26, W * 0.13), W * 0.85);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.strokeText(popup.text, cx(), y);
    ctx.fillText(popup.text, cx(), y);
    ctx.globalAlpha = 1;
  }

  function drawOverlay() {
    if (!state) return;
    let big = '';
    let small = '';
    let alpha = 0.6;
    if (state.phase === 'countdown') {
      const secs = Math.ceil(state.countdownMs / 1000);
      big = secs > 0 ? String(secs) : 'GO!';
      small = `${BALLS_PER_PLAYER} balls, ${Math.round(state.roundMsLeft / 1000)} seconds. Aim for the rings!`;
    } else if (state.phase === 'finished') {
      const winner = state.winnerId ? players.get(state.winnerId) : null;
      const iWon = state.winnerId === me?.id;
      big = iWon ? '🏆 You win!' : `${winner?.name ?? 'Someone'} wins`;
      small = `${state.me.score} points · ${ordinal(state.me.rank)} of ${state.playerCount}`;
    } else if (state.me.ballsLeft === 0 && pred.state && !pred.state.balls.some((b) => b.status === 'flying' || b.status === 'rolling')) {
      big = `${state.me.score}`;
      small = 'Out of balls — waiting for the others';
      alpha = 0.35;
    } else {
      return;
    }
    ctx.fillStyle = `rgba(8, 10, 28, ${alpha})`;
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

  function renderPips(left: number) {
    if (pipsEl.childElementCount !== BALLS_PER_PLAYER) {
      pipsEl.replaceChildren(...Array.from({ length: BALLS_PER_PLAYER }, () => document.createElement('i')));
    }
    Array.from(pipsEl.children).forEach((pip, i) => pip.classList.toggle('skb-pip-used', i >= left));
  }

  resize();
  raf = requestAnimationFrame(frame);
  (window as unknown as { __skbTable?: () => TableState | null }).__skbTable = () => pred.state;

  return {
    update(next, meInfo, playerList) {
      state = next;
      me = meInfo;
      players = new Map(playerList.map((p) => [p.id, p]));

      pred.sampleClock(next.raceMs, next.phase === 'playing' || next.phase === 'finished');
      pred.reconcile(next.table, (t) => {
        if (drag) {
          const held = t.balls.find((b) => b.id === drag!.ballId);
          if (held && (held.status === 'resting' || held.status === 'racked')) grabBall(t, held.id);
        }
      });

      rankEl.textContent = next.phase === 'countdown' ? 'Ready?' : `${ordinal(next.me.rank)} of ${next.playerCount}`;
      if (next.me.score !== shownScore) {
        shownScore = next.me.score;
        scoreEl.textContent = String(next.me.score);
        scoreEl.classList.remove('skb-bump');
        void scoreEl.offsetWidth;
        scoreEl.classList.add('skb-bump');
      }
      scoreEl.style.color = meInfo.color;
      const secs = Math.ceil(next.roundMsLeft / 1000);
      timerEl.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      timerEl.classList.toggle('skb-ctl-timer-low', next.phase === 'playing' && secs <= 10);
      renderPips(next.me.ballsLeft);
      for (const pip of Array.from(pipsEl.children)) (pip as HTMLElement).style.background = meInfo.color;
      hintEl.textContent =
        next.phase === 'playing'
          ? next.me.ballsLeft === 0
            ? 'All balls thrown!'
            : next.me.score >= next.leaderScore
              ? "You're leading — keep them coming!"
              : `${next.leaderScore - next.me.score} behind the leader`
          : next.phase === 'countdown'
            ? 'Drag a ball onto the lane, flick it up the ramp'
            : 'Round over!';
      el.classList.toggle('skb-ctl-finished', next.phase === 'finished');
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      root.innerHTML = '';
    },
  };
}
