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
  regionAt,
  tableRules,
  type BallState,
  type SkeeBallInput,
  type SkeeBallPlayerState,
  type TableEvent,
  type TableState,
} from './logic';
import { QUAT_IDENTITY, quatFromAxisAngle, quatMultiply, quatNormalize, type Quat } from '../render/ball3d';
import {
  GROUND,
  MeshBuilder,
  createScene,
  sceneError,
  framePoint,
  hexToRgbTuple,
  mat4Compose,
  mat4FromAxes,
  mat4Invert,
  mat4LookAt,
  mat4Multiply,
  mat4Perspective,
  mat4Transform,
  v3,
  type Frame,
  type GpuMesh,
  type Mat4,
  type Scene3D,
  type Vec3,
} from '../render/scene3d';
import { buzz, fitFont, readFlick, shade, type Sample } from '../render/util';
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
const SINK_MS = 420;
const MISS_MS = 450;
const FLASH_MS = 600;

/** Cup geometry: a raised rim around a recessed hole. */
const LIP_W = 0.16;
const LIP_H = 0.18;
const CUP_DEPTH = 0.34;
/** The pit between ramp and board sits this far below the lane. */
const PIT_DEPTH = 0.6;
const RAIL_H = 0.32;
const RAMP_LIP_Z = 0.55;
/** The ball tray in front of the bumper. */
const TRAY_Y = -0.55;
const TRAY_Z = -0.2;
const TRAY_GAP = 0.6;
const R = PHYSICS.ballRadius;

/** The board face as a surface frame: x across, u up the face, n out towards the player. */
const BOARD: Frame = {
  o: [0, LANE.boardBaseY, 0],
  ex: [1, 0, 0],
  eu: [0, LANE.boardCos, LANE.boardSin],
  en: [0, -LANE.boardSin, LANE.boardCos],
};
const CAMERA_EYE: Vec3 = [0, -10.2, 26.4];
const CAMERA_TARGET: Vec3 = [0, 5.4, 0.8];
/** Half of the horizontal field of view. */
const HALF_HFOV = (8.6 * Math.PI) / 180;
const LIGHT: Vec3 = [-0.35, -0.5, 0.78];

interface Drag {
  ballId: number;
  pointerId: number;
  /** Lane units, clamped to the run-up. */
  x: number;
  y: number;
  /** Where the finger is on the table plane (unclamped), for drawing. */
  hx: number;
  hy: number;
  samples: Sample[];
}

interface Sink {
  id: number;
  kind: 'cup' | 'drop' | 'miss';
  x: number;
  y: number;
  z: number;
  u: number;
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
  pos: Vec3;
  at: number;
}

interface Flash {
  cup: number; // index into cupFlashes
  at: number;
}

interface Shadow {
  frame: Frame;
  x: number;
  u: number;
  h: number;
  scale: number;
  alpha: number;
}

interface BallPose {
  id: number;
  pos: Vec3;
  r: number;
  alpha: number;
  dim: number;
  shadow: Shadow | null;
}

export function mountSkeeBallController(
  root: HTMLElement,
  send: (input: SkeeBallInput) => void,
): ControllerView<SkeeBallPlayerState> {
  root.innerHTML = `
    <div class="skb-ctl">
      <div class="skb-ctl-bar">
        <div class="skb-ctl-pips" aria-label="balls left"></div>
        <div class="skb-ctl-timer">1:00</div>
      </div>
      <div class="skb-stage">
        <canvas class="skb-gl"></canvas>
        <canvas class="skb-lane"></canvas>
      </div>
    </div>`;

  const el = root.querySelector<HTMLElement>('.skb-ctl')!;
  const stage = root.querySelector<HTMLElement>('.skb-stage')!;
  const glCanvas = root.querySelector<HTMLCanvasElement>('.skb-gl')!;
  const canvas = root.querySelector<HTMLCanvasElement>('.skb-lane')!;
  const timerEl = root.querySelector<HTMLElement>('.skb-ctl-timer')!;
  const pipsEl = root.querySelector<HTMLElement>('.skb-ctl-pips')!;
  const ctx = canvas.getContext('2d')!;
  const scene = createScene(glCanvas);
  /** Anything that stops the 3D scene from drawing, shown on the overlay. */
  let problem = scene ? '' : sceneError || 'WebGL is not available';
  let framesDrawn = 0;

  let state: SkeeBallPlayerState | null = null;
  let me: PlayerInfo | null = null;
  let players = new Map<string, PlayerInfo>();
  const pred = new Prediction<TableState, SkeeBallInput, TableEvent>(tableRules);
  let drag: Drag | null = null;
  let labels: FloatingLabel[] = [];
  let sinks: Sink[] = [];
  let flashes: Flash[] = [];
  let popup: Popup | null = null;
  let shownScore = 0;
  let scoreBumpAt = -Infinity;
  let raf = 0;
  let W = 0;
  let H = 0;
  let viewProj: Mat4 | null = null;
  let viewProjInv: Mat4 | null = null;

  const orientation = new Map<number, Quat>();
  const prevPos = new Map<number, Vec3>();
  const trails = new Map<number, Vec3[]>();
  const lastLipAt = new Map<number, number>();
  /** How far each ball is lifted onto a cup's rim (eased, visual only). */
  const cupLift = new Map<number, number>();
  let lastFrame = 0;

  // ---- the table, built once ----------------------------------------------
  const table = scene ? scene.upload(buildTable()) : null;
  const cupFlashes: GpuMesh[] = scene ? buildCupFlashes().map((b) => scene.upload(b)) : [];

  const ro = new ResizeObserver(() => resize());
  ro.observe(stage);

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    W = stage.clientWidth;
    H = stage.clientHeight;
    canvas.width = Math.max(1, Math.floor(W * dpr));
    canvas.height = Math.max(1, Math.floor(H * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scene?.resize(W, H, dpr);
    if (W && H) {
      // A fixed horizontal field of view: the table always fits across, taller screens just see more.
      const vFov = 2 * Math.atan(Math.tan(HALF_HFOV) / (W / H));
      const proj = mat4Perspective(vFov, W / H, 0.5, 80);
      const view = mat4LookAt(CAMERA_EYE, CAMERA_TARGET, [0, 0, 1]);
      viewProj = mat4Multiply(proj, view);
      viewProjInv = mat4Invert(viewProj);
    }
  }

  // ---- world ↔ screen -----------------------------------------------------
  function project(p: Vec3): { x: number; y: number; depth: number } {
    if (!viewProj) return { x: 0, y: 0, depth: 1 };
    const c = mat4Transform(viewProj, p[0], p[1], p[2]);
    const w = c[3] || 1e-6;
    return { x: ((c[0] / w + 1) / 2) * W, y: ((1 - c[1] / w) / 2) * H, depth: c[2] / w };
  }

  /** The point on the table plane (z = 0) under a screen position. */
  function unproject(px: number, py: number): { x: number; y: number } {
    if (!viewProjInv) return { x: 0, y: 0 };
    const nx = (px / W) * 2 - 1;
    const ny = 1 - (py / H) * 2;
    const a = mat4Transform(viewProjInv, nx, ny, -1);
    const b = mat4Transform(viewProjInv, nx, ny, 1);
    const p0: Vec3 = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
    const p1: Vec3 = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
    const dz = p1[2] - p0[2];
    const t = Math.abs(dz) < 1e-9 ? 0 : (0 - p0[2]) / dz;
    return { x: p0[0] + (p1[0] - p0[0]) * t, y: p0[1] + (p1[1] - p0[1]) * t };
  }

  /** Pixels per world unit around a point. */
  function pxPerUnit(p: Vec3): number {
    const a = project(p);
    const b = project([p[0] + 0.5, p[1], p[2]]);
    return Math.abs(b.x - a.x) * 2;
  }

  const traySlot = (id: number): Vec3 => [(id - (BALLS_PER_PLAYER - 1) / 2) * TRAY_GAP, TRAY_Y, TRAY_Z + R];

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

  function ballWorld(b: BallState): Vec3 {
    if (b.status === 'racked') return traySlot(b.id);
    if (b.status === 'board') return framePoint(BOARD, b.x, b.u, R + (cupLift.get(b.id) ?? 0));
    return [b.x, b.y, b.status === 'flying' ? b.z : R];
  }

  function ballScreen(b: BallState): { x: number; y: number } {
    const p = project(ballWorld(b));
    return { x: p.x, y: p.y };
  }

  // ---- input --------------------------------------------------------------
  function pointerPos(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function dragTo(px: number, py: number) {
    if (!drag) return;
    const hit = unproject(px, py);
    const at = clampLaunchPosition(hit.x, hit.y);
    drag.x = at.x;
    drag.y = at.y;
    drag.hx = clamp(hit.x, -(LANE.halfWidth - R), LANE.halfWidth - R);
    drag.hy = clamp(hit.y, TRAY_Y - 0.4, LANE.placeMaxY);
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
    const hit = unproject(p.x, p.y);
    const start = best.status === 'racked' ? clampLaunchPosition(hit.x, LANE.ballStartY) : clampLaunchPosition(best.x, best.y);
    drag = { ballId: best.id, pointerId: e.pointerId, x: start.x, y: start.y, hx: hit.x, hy: hit.y, samples: [{ x: e.clientX, y: e.clientY, t: performance.now() }] };
    dragTo(p.x, p.y);
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
    drag.samples.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (drag.samples.length > 64) drag.samples.splice(0, drag.samples.length - 64);
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.samples.push({ x: e.clientX, y: e.clientY, t: performance.now() });
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
        cupLift.delete(ev.ball);
        break;
      case 'jump':
        labels.push({ text: 'jump!', color: '#fff', pos: [ev.x, ev.y, ev.z + 0.5], at: now });
        buzz(12);
        break;
      case 'hop':
        labels.push({ text: 'bounce!', color: '#ffb547', pos: [ev.x, ev.y, ev.z + 0.5], at: now });
        buzz(10);
        break;
      case 'land':
        buzz(8);
        break;
      case 'lip': {
        const last = lastLipAt.get(ev.ball) ?? -Infinity;
        if (now - last > 350) {
          labels.push({ text: 'lip!', color: pointColor(ev.points ?? 10), pos: [ev.x, ev.y, ev.z + 0.5], at: now });
          buzz(6);
        }
        lastLipAt.set(ev.ball, now);
        break;
      }
      case 'skip':
        labels.push({ text: 'skipped', color: 'rgba(255,255,255,0.8)', pos: [ev.x, ev.y, ev.z + 0.5], at: now });
        break;
      case 'rail':
      case 'bumper':
      case 'ball':
      case 'wall':
        buzz(6);
        break;
      case 'score': {
        const points = ev.points ?? 0;
        const onBoard = (ev.u ?? 0) > 0 || ev.y >= LANE.boardBaseY - 0.6;
        const u = ev.u ?? 0;
        sinks.push({ id: ev.ball, kind: onBoard && u > 0 ? 'cup' : 'drop', x: ev.x, y: ev.y, z: ev.z, u, at: now });
        const cupIndex = cupIndexFor(points, ev.x);
        if (cupIndex >= 0) flashes.push({ cup: cupIndex, at: now });
        popup = { text: points >= 100 ? `POCKET +${points}` : `+${points}`, color: pointColor(points), at: now };
        buzz(points >= 50 ? [30, 40, 30] : points >= 20 ? [20, 30] : 15);
        break;
      }
      case 'miss':
        sinks.push({ id: ev.ball, kind: 'miss', x: ev.x, y: ev.y, z: ev.z, u: 0, at: now });
        popup = { text: 'OVER THE TOP', color: 'rgba(255,255,255,0.75)', at: now };
        buzz(15);
        break;
      case 'settle':
        break;
    }
  }

  /** Which flash mesh lights up for a score: rings 0..3, pockets 4 (left) and 5 (right). */
  function cupIndexFor(points: number, x: number): number {
    if (points === 100) return x < 0 ? 4 : 5;
    const i = RINGS.findIndex((r) => r.points === points);
    return i;
  }

  /** Advance each moving ball's spin, trail and rim lift by how it moved since the last frame. */
  function updateMotion(dt: number) {
    if (!pred.state) return;
    for (const b of pred.state.balls) {
      const moving = b.status === 'rolling' || b.status === 'resting' || b.status === 'flying' || b.status === 'board';
      if (!moving) {
        prevPos.delete(b.id);
        continue;
      }
      // Ease the ball up onto a rim while it's over a cup
      if (b.status === 'board') {
        const target = regionAt(b.x, b.u).id >= 0 ? LIP_H : 0;
        const cur = cupLift.get(b.id) ?? target;
        cupLift.set(b.id, cur + (target - cur) * Math.min(1, dt * 18));
      }
      const pos: Vec3 = b.status === 'board' ? framePoint(BOARD, b.x, b.u, R) : [b.x, b.y, b.status === 'flying' ? b.z : R];
      const prev = prevPos.get(b.id);
      if (prev) {
        const d = v3.sub(pos, prev);
        const ds = Math.hypot(d[0], d[1], d[2]);
        if (ds > 1e-4) {
          const normal: Vec3 = b.status === 'board' ? BOARD.en : [0, 0, 1];
          const axis = v3.cross(normal, d);
          const q = orientation.get(b.id) ?? QUAT_IDENTITY;
          orientation.set(b.id, quatNormalize(quatMultiply(quatFromAxisAngle(axis[0], axis[1], axis[2], ds / R), q)));
        }
      }
      prevPos.set(b.id, pos);
      const trail = trails.get(b.id) ?? [];
      trail.push(pos);
      if (trail.length > 12) trail.shift();
      trails.set(b.id, trail);
    }
  }

  // ---- drawing ------------------------------------------------------------
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    if (!W || !H) return;
    const dt = Math.min(0.1, (now - lastFrame) / 1000) || 0.016;
    lastFrame = now;
    ctx.clearRect(0, 0, W, H);
    advanceLocal(now);
    updateMotion(dt);
    if (scene && table && viewProj && !problem) {
      try {
        scene.begin(viewProj, CAMERA_EYE, LIGHT);
        scene.draw(table, mat4Compose([0, 0, 0], QUAT_IDENTITY, 1));
        drawBalls3D(now);
        drawFlashes(now);
        if (framesDrawn++ < 3) {
          const err = scene.error();
          if (err) problem = err;
        }
      } catch (e) {
        problem = `Render failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    if (problem) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.font = `600 ${Math.max(13, W * 0.036)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      wrapText(ctx, `3D view unavailable · ${problem}`, W / 2, H * 0.45, W * 0.85, Math.max(16, W * 0.045));
    }
    drawCupLabels();
    drawHud(now);
    drawHint(now);
    drawLabels(now);
    drawPopup(now);
    drawOverlay();
  }

  /** Where every ball is this frame, with its shadow. */
  function poses(now: number): BallPose[] {
    const out: BallPose[] = [];
    if (!pred.state) return out;
    for (const b of pred.state.balls) {
      if (drag && drag.ballId === b.id) {
        const lifted: Vec3 = [drag.hx, drag.hy, R + 0.45];
        const onTray = drag.hy < -0.15;
        out.push({
          id: b.id,
          pos: lifted,
          r: R,
          alpha: 1,
          dim: 0,
          shadow: { frame: GROUND, x: drag.hx, u: drag.hy, h: onTray ? TRAY_Z + 0.01 : 0.01, scale: 1.2, alpha: 0.22 },
        });
        continue;
      }
      if (b.status === 'done') continue;
      if (b.status === 'racked') {
        const p = traySlot(b.id);
        out.push({ id: b.id, pos: p, r: R, alpha: 1, dim: 0, shadow: { frame: GROUND, x: p[0], u: p[1], h: TRAY_Z + 0.01, scale: 1, alpha: 0.35 } });
        continue;
      }
      const pos = ballWorld(b);
      out.push({ id: b.id, pos, r: R, alpha: 1, dim: 0, shadow: shadowFor(b, pos) });
    }
    sinks = sinks.filter((k) => now - k.at < (k.kind === 'miss' ? MISS_MS : SINK_MS));
    for (const k of sinks) {
      const s = clamp((now - k.at) / (k.kind === 'miss' ? MISS_MS : SINK_MS), 0, 1);
      const eased = s * s;
      if (k.kind === 'cup') {
        const pos = framePoint(BOARD, k.x, k.u, R + LIP_H - eased * (LIP_H + CUP_DEPTH + R * 1.4));
        out.push({ id: k.id, pos, r: R, alpha: 1 - clamp((s - 0.8) / 0.2, 0, 1), dim: s * 0.7, shadow: null });
      } else if (k.kind === 'drop') {
        const pos: Vec3 = [k.x, Math.max(k.y, LANE.launchY + 0.2), R - eased * (PIT_DEPTH + R * 1.6)];
        out.push({ id: k.id, pos, r: R, alpha: 1 - clamp((s - 0.8) / 0.2, 0, 1), dim: s * 0.7, shadow: null });
      } else {
        const pos: Vec3 = [k.x, k.y + s * 0.6, k.z + s * 0.8];
        out.push({ id: k.id, pos, r: R * (1 - s * 0.3), alpha: 1 - s, dim: s * 0.5, shadow: null });
      }
    }
    return out;
  }

  /** The blob shadow under a ball on the lane, in the air or on the board. */
  function shadowFor(b: BallState, pos: Vec3): Shadow | null {
    if (b.status === 'board') {
      return { frame: BOARD, x: b.x, u: b.u, h: 0.01 + (cupLift.get(b.id) ?? 0), scale: 1.05, alpha: 0.35 };
    }
    if (b.status !== 'flying') return { frame: GROUND, x: b.x, u: b.y, h: 0.01, scale: 1.05, alpha: 0.35 };
    // In flight: onto whatever is below
    let frame: Frame = GROUND;
    let x = b.x;
    let u = b.y;
    let h = 0.01;
    let surfaceZ = 0;
    if (b.y >= LANE.boardBaseY) {
      const uu = (b.y - LANE.boardBaseY) / LANE.boardCos;
      if (uu > LANE.boardLength) return null;
      frame = BOARD;
      u = uu;
      surfaceZ = uu * LANE.boardSin;
      h = 0.01 + (regionAt(x, uu).id >= 0 ? LIP_H : 0);
    } else if (b.y > LANE.launchY) {
      h = -PIT_DEPTH + 0.01;
      surfaceZ = -PIT_DEPTH;
    } else if (b.y > LANE.rampY) {
      return null;
    }
    const height = Math.max(0, pos[2] - surfaceZ);
    if (pos[2] < surfaceZ - 0.05) return null;
    return { frame, x, u, h, scale: 1.05 * clamp(1 - height / 8, 0.45, 1), alpha: 0.35 * clamp(1 - height / 6, 0.25, 1) };
  }

  function drawBalls3D(now: number) {
    if (!scene) return;
    const color = hexToRgbTuple(me?.color ?? '#ffffff');
    const spot: Vec3 = [1, 0.96, 0.86];
    const list = poses(now);
    // Shadows first (translucent, no depth write)
    for (const p of list) {
      if (!p.shadow) continue;
      const s = p.shadow;
      const rr = p.r * s.scale;
      const o = framePoint(s.frame, s.x, s.u, s.h);
      const model = mat4FromAxes(v3.scale(s.frame.ex, rr), v3.scale(s.frame.eu, rr), s.frame.en, o);
      scene.draw(scene.disc, model, { unlit: true, alpha: s.alpha * p.alpha, noDepthWrite: true });
    }
    // Trails: ghosts behind quick balls
    if (pred.state) {
      for (const b of pred.state.balls) {
        if (b.status !== 'rolling' && b.status !== 'flying' && b.status !== 'board') continue;
        const trail = trails.get(b.id);
        if (!trail || trail.length < 6) continue;
        const speed = Math.hypot(b.vx, b.vy, b.vz);
        const strength = clamp((speed - 3) / 9, 0, 1);
        if (strength <= 0) continue;
        for (let g = 1; g <= 3; g++) {
          const p = trail[trail.length - 1 - g * 2];
          if (!p) break;
          scene.draw(scene.sphere, mat4Compose(p, orientation.get(b.id) ?? QUAT_IDENTITY, R * (1 - g * 0.12)), {
            ball: { color, spot, dim: 0 },
            alpha: strength * (0.22 - g * 0.05),
            noDepthWrite: true,
          });
        }
      }
    }
    // Balls
    for (const p of list) {
      scene.draw(scene.sphere, mat4Compose(p.pos, orientation.get(p.id) ?? QUAT_IDENTITY, p.r), {
        ball: { color, spot, dim: p.dim },
        alpha: p.alpha,
        noDepthWrite: p.alpha < 1,
      });
    }
  }

  function drawFlashes(now: number) {
    if (!scene) return;
    flashes = flashes.filter((f) => now - f.at < FLASH_MS);
    for (const f of flashes) {
      const mesh = cupFlashes[f.cup];
      if (!mesh) continue;
      const a = 1 - (now - f.at) / FLASH_MS;
      scene.draw(mesh, mat4Compose([0, 0, 0], QUAT_IDENTITY, 1), { unlit: true, alpha: 0.7 * a, noDepthWrite: true });
    }
  }

  /** Point values painted on the board, in the overlay so they stay crisp. */
  function drawCupLabels() {
    if (!viewProj) return;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = (text: string, pos: Vec3, color: string, size: number) => {
      const p = project(pos);
      if (p.depth > 1) return;
      ctx.font = `800 ${Math.max(8, size)}px system-ui, sans-serif`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.strokeText(text, p.x, p.y);
      ctx.fillStyle = color;
      ctx.fillText(text, p.x, p.y);
    };
    const unitPx = pxPerUnit(framePoint(BOARD, 0, LANE.ringU, 0));
    RINGS.forEach((ring, i) => {
      const inner = i > 0 ? RINGS[i - 1]!.r + LIP_W : 0;
      const u = i === 0 ? LANE.ringU : LANE.ringU - (ring.r + inner) / 2;
      // Sized to the hole band it sits in (foreshortened on the tilted face)
      const band = (i === 0 ? ring.r * 1.6 : ring.r - inner) * unitPx * 0.55;
      label(String(ring.points), framePoint(BOARD, 0, u, -CUP_DEPTH + 0.02), pointColor(ring.points), Math.min(band, W * 0.034));
    });
    for (const side of [-1, 1]) {
      label('100', framePoint(BOARD, side * LANE.pocketX, LANE.pocketU - LANE.pocketR - 0.3, LIP_H), pointColor(100), Math.min(unitPx * 0.26, W * 0.03));
    }
    // The plain face is worth 10
    for (const side of [-1, 1]) label('10', framePoint(BOARD, side * (LANE.boardHalfWidth - 0.5), 0.45, 0.02), 'rgba(255,255,255,0.45)', Math.min(unitPx * 0.26, W * 0.03));
  }

  /** Score and standing in the top corners of the view. */
  function drawHud(now: number) {
    if (!state || !me) return;
    const pop = 1 + 0.35 * Math.max(0, 1 - (now - scoreBumpAt) / 350);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    const big = Math.max(26, W * 0.11) * pop;
    ctx.font = `900 ${big}px system-ui, sans-serif`;
    ctx.fillStyle = me.color;
    ctx.strokeText(String(state.me.score), 12, 8);
    ctx.fillText(String(state.me.score), 12, 8);
    const small = Math.max(11, W * 0.034);
    ctx.font = `700 ${small}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 3;
    const standing = state.phase === 'countdown' ? 'Ready?' : `${ordinal(state.me.rank)} of ${state.playerCount}`;
    ctx.strokeText(standing, 13, 10 + big);
    ctx.fillText(standing, 13, 10 + big);
    if (state.phase === 'playing' && state.playerCount > 1) {
      const gap = state.leaderScore - state.me.score;
      const note = gap <= 0 ? 'leading' : `${gap} behind`;
      ctx.textAlign = 'right';
      ctx.fillStyle = gap <= 0 ? '#5ce07a' : 'rgba(255,255,255,0.75)';
      ctx.strokeText(note, W - 12, 10);
      ctx.fillText(note, W - 12, 10);
    }
  }

  function drawHint(now: number) {
    if (!canGrab() || !pred.state) return;
    const next = grabbable()[0];
    if (!next) return;
    const c = ballScreen(next);
    const r = pxPerUnit(ballWorld(next)) * R;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = `600 ${Math.max(12, W * 0.035)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('▲ grab & flick', clamp(c.x, W * 0.2, W * 0.8), c.y - r - 16 + Math.sin(now / 250) * 3);
  }

  function drawLabels(now: number) {
    labels = labels.filter((l) => now - l.at < LABEL_MS);
    for (const l of labels) {
      const u = (now - l.at) / LABEL_MS;
      const p = project(l.pos);
      ctx.globalAlpha = 1 - u * u;
      ctx.fillStyle = l.color;
      ctx.font = `800 ${Math.max(11, W * 0.036)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(l.text, p.x, p.y - u * 14);
      ctx.fillText(l.text, p.x, p.y - u * 14);
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
    const y = project([0, LANE.placeMaxY, 0]).y - u * 40;
    ctx.globalAlpha = 1 - u * u;
    ctx.fillStyle = popup.color;
    fitFont(ctx, popup.text, 900, Math.max(26, W * 0.13), W * 0.85);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.strokeText(popup.text, W / 2, y);
    ctx.fillText(popup.text, W / 2, y);
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
      small = `${BALLS_PER_PLAYER} balls, ${Math.round(state.roundMsLeft / 1000)} seconds. Grab from the tray, flick up the lane.`;
    } else if (state.phase === 'finished') {
      const winner = state.winnerId ? players.get(state.winnerId) : null;
      const iWon = state.winnerId === me?.id;
      big = iWon ? '🏆 You win!' : `${winner?.name ?? 'Someone'} wins`;
      small = `${state.me.score} points · ${ordinal(state.me.rank)} of ${state.playerCount}`;
    } else if (state.me.ballsLeft === 0 && pred.state && !pred.state.balls.some((b) => b.status === 'flying' || b.status === 'rolling' || b.status === 'board')) {
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
  const dbg = window as unknown as { __skbTable?: () => TableState | null; __skbScreen?: (id: number) => { x: number; y: number } | null };
  dbg.__skbTable = () => pred.state;
  dbg.__skbScreen = (id) => {
    const b = pred.state?.balls.find((k) => k.id === id);
    return b ? ballScreen(b) : null;
  };

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

      if (next.me.score !== shownScore) {
        shownScore = next.me.score;
        scoreBumpAt = performance.now();
      }
      const secs = Math.ceil(next.roundMsLeft / 1000);
      timerEl.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      timerEl.classList.toggle('skb-ctl-timer-low', next.phase === 'playing' && secs <= 10);
      renderPips(next.me.ballsLeft);
      for (const pip of Array.from(pipsEl.children)) (pip as HTMLElement).style.background = meInfo.color;
      el.classList.toggle('skb-ctl-finished', next.phase === 'finished');
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      root.innerHTML = '';
    },
  };
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number) {
  const words = text.split(' ');
  let line = '';
  let yy = y;
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > maxWidth && line) {
      ctx.fillText(line, x, yy);
      line = w;
      yy += lineHeight;
    } else line = next;
  }
  if (line) ctx.fillText(line, x, yy);
}

// ---- the table geometry -----------------------------------------------------

/** Everything that doesn't move: lane, rails, bumper, ramp, pit, cabinet, board with cups, tray. */
function buildTable(): MeshBuilder {
  const m = new MeshBuilder();
  const hw = LANE.halfWidth;
  const laneY0 = -0.2;

  // Lane surface in one-unit bands for a little perspective texture
  for (let y = laneY0; y < LANE.rampY; y += 1) {
    const y1 = Math.min(LANE.rampY, y + 1);
    m.color(Math.floor(y + 1) % 2 === 0 ? '#6f4a26' : '#684522').rect(GROUND, -hw, y, hw, y1, 0);
  }
  // Placement line
  m.color('#8a6a45').rect(GROUND, -hw, LANE.placeMaxY - 0.02, hw, LANE.placeMaxY + 0.02, 0.004);
  // Rails along the lane, up over the ramp
  for (const side of [-1, 1]) {
    const x0 = side < 0 ? -hw - 0.28 : hw;
    const x1 = side < 0 ? -hw : hw + 0.28;
    m.color('#3a2210').box(GROUND, x0, laneY0 - 0.1, x1, LANE.rampY, -0.1, RAIL_H);
    // Rail top highlight strip
    m.color('#7a5535').rect(GROUND, side < 0 ? -hw - 0.2 : hw + 0.06, laneY0, side < 0 ? -hw - 0.06 : hw + 0.2, LANE.rampY, RAIL_H + 0.003);
    // Over the ramp
    const rampRail: Frame = { o: [0, LANE.rampY, 0], ex: [1, 0, 0], eu: v3.normalize([0, LANE.launchY - LANE.rampY, RAMP_LIP_Z]), en: v3.normalize([0, -RAMP_LIP_Z, LANE.launchY - LANE.rampY]) };
    const rampLen = Math.hypot(LANE.launchY - LANE.rampY, RAMP_LIP_Z);
    m.color('#3a2210').box(rampRail, x0, 0, x1, rampLen, -0.1, RAIL_H);
  }
  // Bumper the balls rest against
  m.color('#2a1708').box(GROUND, -hw, laneY0 - 0.02, hw, LANE.ballStartY - R, -0.05, 0.16);
  m.color('#c8a070').rect(GROUND, -hw, laneY0, hw, LANE.ballStartY - R - 0.02, 0.163);

  // Jump ramp: a wedge from the lane to its lip
  const rampFrame: Frame = { o: [0, LANE.rampY, 0], ex: [1, 0, 0], eu: v3.normalize([0, LANE.launchY - LANE.rampY, RAMP_LIP_Z]), en: v3.normalize([0, -RAMP_LIP_Z, LANE.launchY - LANE.rampY]) };
  const rampLen = Math.hypot(LANE.launchY - LANE.rampY, RAMP_LIP_Z);
  m.color('#8a5f35').rect(rampFrame, -hw, 0, hw, rampLen, 0);
  m.color('#c9a070').rect(rampFrame, -hw, rampLen - 0.06, hw, rampLen, 0.004);
  // Its front face down into the pit
  m.color('#2a1708').quad([-hw, LANE.launchY, RAMP_LIP_Z], [-hw, LANE.launchY, -PIT_DEPTH], [hw, LANE.launchY, -PIT_DEPTH], [hw, LANE.launchY, RAMP_LIP_Z], [0, 1, 0]);

  // Pit floor (drains to the 10 trough) and the cabinet
  const backY = LANE.boardBaseY + LANE.boardLength * LANE.boardCos + 0.35;
  const wallH = LANE.boardLength * LANE.boardSin + 0.9;
  m.color('#0f0a1c').rect(GROUND, -hw, LANE.launchY, hw, LANE.boardBaseY + 0.05, -PIT_DEPTH);
  // Grate lines across the pit floor
  for (let x = -hw + 0.4; x < hw; x += 0.5) m.color('#1a1233').rect(GROUND, x - 0.02, LANE.launchY, x + 0.02, LANE.boardBaseY, -PIT_DEPTH + 0.004);
  m.color('#161031').quad([-hw, backY, -PIT_DEPTH], [hw, backY, -PIT_DEPTH], [hw, backY, wallH], [-hw, backY, wallH], [0, -1, 0]);
  for (const side of [-1, 1]) {
    const x = side * hw;
    const inward: Vec3 = [-side, 0, 0];
    m.color(side < 0 ? '#251a4a' : '#1f1540');
    if (side < 0) m.quad([x, LANE.launchY, -PIT_DEPTH], [x, backY, -PIT_DEPTH], [x, backY, wallH], [x, LANE.launchY, wallH], inward);
    else m.quad([x, backY, -PIT_DEPTH], [x, LANE.launchY, -PIT_DEPTH], [x, LANE.launchY, wallH], [x, backY, wallH], inward);
    // Wall top edge
    m.color('#3a2c66').box(GROUND, side < 0 ? x - 0.28 : x, LANE.launchY, side < 0 ? x : x + 0.28, backY, wallH, wallH + 0.12);
  }

  // The board: a slab with a lip at its foot (the trough edge) and side borders
  const bhw = LANE.boardHalfWidth;
  const L = LANE.boardLength;
  m.color('#3b2a5e').rect(BOARD, -bhw, 0, bhw, L, 0);
  m.color('#2a1d45').box(BOARD, -bhw, 0, bhw, L, -0.25, -0.001);
  for (const side of [-1, 1]) m.color('#241840').box(BOARD, side < 0 ? -hw : bhw, -0.2, side < 0 ? -bhw : hw, L, -0.25, 0.12);
  // Trough at the foot: a dark slot the ball drops into
  m.color('#08050f').rect(GROUND, -hw, LANE.boardBaseY - 0.55, hw, LANE.boardBaseY - 0.05, -PIT_DEPTH + 0.006);
  m.color('#c9a070').box(GROUND, -bhw, LANE.boardBaseY - 0.06, bhw, LANE.boardBaseY + 0.02, -0.05, 0.06);

  // Cups: raised rims around recessed holes, outermost first
  const cup = (cx: number, cu: number, rIn: number, rOut: number, points: number) => {
    const color = pointColor(points);
    // Hole floor and its walls
    m.color('#0b0714').ring(BOARD, cx, cu, rIn > 0 ? rIn + LIP_W : 0, rOut, -CUP_DEPTH, 48);
    m.color(shade(color, -0.6)).wall(BOARD, cx, cu, rOut, -CUP_DEPTH, 0, true, 48);
    if (rIn > 0) m.color(shade(color, -0.7)).wall(BOARD, cx, cu, rIn + LIP_W, -CUP_DEPTH, 0, false, 48);
    // Raised rim just outside the hole
    m.color(color).ring(BOARD, cx, cu, rOut, rOut + LIP_W, LIP_H, 48);
    m.color(shade(color, -0.25)).wall(BOARD, cx, cu, rOut + LIP_W, 0, LIP_H, false, 48);
    m.color(shade(color, 0.15)).wall(BOARD, cx, cu, rOut, -0.001, LIP_H, true, 48);
  };
  for (let i = RINGS.length - 1; i >= 0; i--) cup(0, LANE.ringU, i > 0 ? RINGS[i - 1]!.r : 0, RINGS[i]!.r, RINGS[i]!.points);
  for (const side of [-1, 1]) cup(side * LANE.pocketX, LANE.pocketU, 0, LANE.pocketR, 100);

  // Ball tray in front of the bumper
  m.color('#1c1230').box(GROUND, -hw - 0.28, TRAY_Y - 0.55, hw + 0.28, laneY0 - 0.02, TRAY_Z - 0.2, TRAY_Z);
  m.color('#2a1d45').box(GROUND, -hw - 0.28, TRAY_Y - 0.62, hw + 0.28, TRAY_Y - 0.55, TRAY_Z - 0.2, TRAY_Z + 0.1);
  for (let i = 0; i < BALLS_PER_PLAYER; i++) {
    const x = (i - (BALLS_PER_PLAYER - 1) / 2) * TRAY_GAP;
    m.color('#0d0818').ring(GROUND, x, TRAY_Y, 0, R * 0.9, TRAY_Z + 0.004, 24);
  }
  return m;
}

/** A white ring over each cup's rim, drawn translucent when that cup scores. Order: rings 0..3, pockets left, right. */
function buildCupFlashes(): MeshBuilder[] {
  const out: MeshBuilder[] = [];
  for (const ring of RINGS) out.push(new MeshBuilder().color('#ffffff').ring(BOARD, 0, LANE.ringU, Math.max(0, ring.r - LIP_W * 1.5), ring.r + LIP_W * 1.3, LIP_H + 0.02, 48));
  for (const side of [-1, 1]) out.push(new MeshBuilder().color('#ffffff').ring(BOARD, side * LANE.pocketX, LANE.pocketU, 0, LANE.pocketR + LIP_W * 1.3, LIP_H + 0.02, 32));
  return out;
}
