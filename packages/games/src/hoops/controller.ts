import type { PlayerInfo } from '@funfair/shared';
import type { ControllerView } from '@funfair/shared/client';
import {
  BALLS_PER_PLAYER,
  COURT,
  PHYSICS,
  RETURN_TICKS,
  clamp,
  clampLaunch,
  clampLaunchX,
  grabBall,
  ordinal,
  tableRules,
  type BallState,
  type HoopsInput,
  type HoopsPlayerState,
  type TableEvent,
  type TableState,
} from './logic';
import { QUAT_IDENTITY, quatFromAxisAngle, quatMultiply, quatNormalize, type Quat } from '../render/ball3d';
import {
  GROUND,
  MeshBuilder,
  createScene,
  hexToRgbTuple,
  mat4Compose,
  mat4FromAxes,
  mat4Invert,
  mat4LookAt,
  mat4Multiply,
  mat4Perspective,
  mat4Transform,
  sceneError,
  v3,
  type Frame,
  type GpuMesh,
  type Mat4,
  type Vec3,
} from '../render/scene3d';
import { buzz, fitFont, readFlick, shade, type Sample } from '../render/util';
import { Prediction } from '../lockstep/client';

const POPUP_MS = 900;
const LABEL_MS = 600;
const FLASH_MS = 600;
const R = PHYSICS.ballRadius;
/** The ball rack in front of the player. */
const RACK_Y = COURT.launchY;
const RACK_Z = 0.55;
const RACK_GAP = 0.95;
const CAMERA_EYE: Vec3 = [0, -8.2, 4.6];
const CAMERA_TARGET: Vec3 = [0, 3.8, 2.1];
/** Half of the horizontal field of view. */
const HALF_HFOV = (12.2 * Math.PI) / 180;
const LIGHT: Vec3 = [-0.35, -0.45, 0.82];
/** How far above the touch point the held ball floats, as a fraction of the view height. */
const HOLD_LIFT = 0.09;

interface Drag {
  ballId: number;
  pointerId: number;
  /** Where along the rack the throw leaves from. */
  x: number;
  /** The held ball, on the vertical plane through the rack: across and up. */
  hx: number;
  hz: number;
  samples: Sample[];
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

interface BallPose {
  id: number;
  pos: Vec3;
  alpha: number;
  dim: number;
  shadow: { x: number; y: number; scale: number; alpha: number } | null;
}

export function mountHoopsController(root: HTMLElement, send: (input: HoopsInput) => void): ControllerView<HoopsPlayerState> {
  root.innerHTML = `
    <div class="hp-ctl">
      <div class="hp-ctl-bar">
        <div class="hp-ctl-pips" aria-label="balls ready"></div>
        <div class="hp-ctl-timer">0:45</div>
      </div>
      <div class="hp-stage">
        <canvas class="hp-gl"></canvas>
        <canvas class="hp-lane"></canvas>
      </div>
    </div>`;

  const el = root.querySelector<HTMLElement>('.hp-ctl')!;
  const stage = root.querySelector<HTMLElement>('.hp-stage')!;
  const glCanvas = root.querySelector<HTMLCanvasElement>('.hp-gl')!;
  const canvas = root.querySelector<HTMLCanvasElement>('.hp-lane')!;
  const timerEl = root.querySelector<HTMLElement>('.hp-ctl-timer')!;
  const pipsEl = root.querySelector<HTMLElement>('.hp-ctl-pips')!;
  const ctx = canvas.getContext('2d')!;
  const scene = createScene(glCanvas);
  let problem = scene ? '' : sceneError || 'WebGL is not available';
  let framesDrawn = 0;

  let state: HoopsPlayerState | null = null;
  let me: PlayerInfo | null = null;
  let players = new Map<string, PlayerInfo>();
  const pred = new Prediction<TableState, HoopsInput, TableEvent>(tableRules);
  let drag: Drag | null = null;
  let labels: FloatingLabel[] = [];
  let popup: Popup | null = null;
  let flashAt = -Infinity;
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
  const lastRimAt = new Map<number, number>();
  const appearedAt = new Map<number, number>();

  const court = scene ? scene.upload(buildCourt()) : null;
  const net = scene ? scene.upload(buildNet()) : null;
  const cage = scene ? scene.upload(buildCage()) : null;
  const rimFlash: GpuMesh | null = scene ? scene.upload(new MeshBuilder().color('#ffffff').torus(GROUND, 0, COURT.hoopY, COURT.hoopZ, COURT.rimR, COURT.rimTube * 2.6, 48, 8)) : null;

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
      const vFov = 2 * Math.atan(Math.tan(HALF_HFOV) / (W / H));
      const proj = mat4Perspective(vFov, W / H, 0.3, 60);
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

  /** The point on the vertical plane y = planeY under a screen position: across and up. */
  function unproject(px: number, py: number, planeY: number): { x: number; z: number } {
    if (!viewProjInv) return { x: 0, z: 0 };
    const nx = (px / W) * 2 - 1;
    const ny = 1 - (py / H) * 2;
    const a = mat4Transform(viewProjInv, nx, ny, -1);
    const b = mat4Transform(viewProjInv, nx, ny, 1);
    const p0: Vec3 = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
    const p1: Vec3 = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
    const dy = p1[1] - p0[1];
    const t = Math.abs(dy) < 1e-9 ? 0 : (planeY - p0[1]) / dy;
    return { x: p0[0] + (p1[0] - p0[0]) * t, z: p0[2] + (p1[2] - p0[2]) * t };
  }

  function pxPerUnit(p: Vec3): number {
    const a = project(p);
    const b = project([p[0] + 0.5, p[1], p[2]]);
    return Math.abs(b.x - a.x) * 2;
  }

  const rackSlot = (id: number): Vec3 => [(id - (BALLS_PER_PLAYER - 1) / 2) * RACK_GAP, RACK_Y, RACK_Z + R];

  // ---- local simulation ---------------------------------------------------
  const playing = () => !!state && (state.phase === 'playing' || state.phase === 'finished');

  function grabbable(): BallState[] {
    return pred.state?.balls.filter((b) => b.status === 'racked') ?? [];
  }

  function canGrab() {
    return !!state && state.phase === 'playing' && !drag && !!pred.state;
  }

  function ballWorld(b: BallState): Vec3 {
    if (b.status === 'racked' || b.status === 'held') return rackSlot(b.id);
    return [b.x, b.y, b.z];
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

  /**
   * The held ball rides just above the finger on the plane through the rack,
   * so it never lags, never stops, and the thumb doesn't hide it.
   */
  function dragTo(px: number, py: number) {
    if (!drag) return;
    const hit = unproject(px, py - H * HOLD_LIFT, RACK_Y);
    drag.x = clampLaunchX(hit.x);
    drag.hx = clamp(hit.x, -COURT.halfWidth + R, COURT.halfWidth - R);
    drag.hz = clamp(hit.z, RACK_Z + R, COURT.ceilingZ - R);
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
    const slot = rackSlot(best.id);
    drag = { ballId: best.id, pointerId: e.pointerId, x: slot[0], hx: slot[0], hz: slot[2], samples: [{ x: e.clientX, y: e.clientY, t: performance.now() }] };
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
    const ballId = drag.ballId;
    const x = drag.x;
    const z = drag.hz;
    drag = null;
    if (!pred.state || !state || state.phase !== 'playing') return;
    // No flick: a lob straight up that drops back in front of you. Cheap, but a throw.
    const speed = gesture ? gesture.power * PHYSICS.maxLaunchSpeed : 2;
    const vel = gesture ? clampLaunch(speed * gesture.dirX, speed * gesture.dirY) : { vx: 0, vy: speed };
    const input = pred.input((tick) => ({ type: 'shoot', ball: ballId, x, z, vx: vel.vx, vy: vel.vy, tick }));
    if (input) send(input);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  function onEvent(ev: TableEvent, now: number) {
    switch (ev.type) {
      case 'launch':
        trails.delete(ev.ball);
        buzz(6);
        break;
      case 'rim': {
        const last = lastRimAt.get(ev.ball) ?? -Infinity;
        if (now - last > 300) {
          labels.push({ text: 'rim!', color: '#ffb547', pos: [ev.x, ev.y, ev.z + 0.5], at: now });
          buzz(8);
        }
        lastRimAt.set(ev.ball, now);
        break;
      }
      case 'board':
        labels.push({ text: 'glass', color: 'rgba(255,255,255,0.85)', pos: [ev.x, ev.y, ev.z + 0.5], at: now });
        buzz(8);
        break;
      case 'wall':
        buzz(5);
        break;
      case 'score': {
        const points = ev.points ?? 2;
        popup = { text: ev.swish ? `SWISH +${points}` : `+${points}`, color: ev.swish ? '#ffe74c' : '#5ce07a', at: now };
        flashAt = now;
        buzz(ev.swish ? [30, 40, 30] : [20, 30]);
        break;
      }
      case 'miss': {
        const b = pred.state?.balls.find((k) => k.id === ev.ball);
        const text = b && b.touched === 0 ? (ev.y < COURT.hoopY - COURT.rimR ? 'SHORT' : 'AIRBALL') : 'NO GOOD';
        popup = { text, color: 'rgba(255,255,255,0.7)', at: now };
        buzz(12);
        break;
      }
      case 'return':
        appearedAt.set(ev.ball, now);
        break;
    }
  }

  function updateMotion() {
    if (!pred.state) return;
    for (const b of pred.state.balls) {
      if (b.status !== 'flying') {
        prevPos.delete(b.id);
        continue;
      }
      const pos: Vec3 = [b.x, b.y, b.z];
      const prev = prevPos.get(b.id);
      if (prev) {
        const d = v3.sub(pos, prev);
        const ds = Math.hypot(d[0], d[1], d[2]);
        if (ds > 1e-4) {
          // Backspin: roll about the axis across the direction of flight.
          const axis = v3.cross([0, 0, 1], [d[0], d[1], 0]);
          if (Math.hypot(axis[0], axis[1], axis[2]) > 1e-6) {
            const q = orientation.get(b.id) ?? QUAT_IDENTITY;
            orientation.set(b.id, quatNormalize(quatMultiply(quatFromAxisAngle(axis[0], axis[1], axis[2], (ds / R) * 0.6), q)));
          }
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
    ctx.clearRect(0, 0, W, H);
    if (playing()) pred.advance(now, (ev) => onEvent(ev, now));
    updateMotion();
    if (scene && court && viewProj && !problem) {
      try {
        scene.begin(viewProj, CAMERA_EYE, LIGHT);
        scene.draw(court, mat4Compose([0, 0, 0], QUAT_IDENTITY, 1));
        drawBalls3D(now);
        if (net) scene.draw(net, mat4Compose([0, 0, 0], QUAT_IDENTITY, 1), { alpha: 0.55, noDepthWrite: true });
        if (cage) scene.draw(cage, mat4Compose([0, 0, 0], QUAT_IDENTITY, 1), { alpha: 0.35, unlit: true, noDepthWrite: true });
        if (rimFlash && now - flashAt < FLASH_MS) scene.draw(rimFlash, mat4Compose([0, 0, 0], QUAT_IDENTITY, 1), { unlit: true, alpha: 0.8 * (1 - (now - flashAt) / FLASH_MS), noDepthWrite: true });
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
      ctx.fillText(`3D view unavailable · ${problem}`, W / 2, H * 0.45, W * 0.9);
    }
    drawHud(now);
    drawHint(now);
    drawLabels(now);
    drawPopup(now);
    drawOverlay();
  }

  function poses(now: number): BallPose[] {
    const out: BallPose[] = [];
    if (!pred.state) return out;
    for (const b of pred.state.balls) {
      if (drag && drag.ballId === b.id) {
        const pos: Vec3 = [drag.hx, RACK_Y, drag.hz];
        const lift = clamp((drag.hz - RACK_Z - R) / 3, 0, 1);
        out.push({ id: b.id, pos, alpha: 1, dim: 0, shadow: { x: drag.hx, y: RACK_Y, scale: 1 + lift * 0.3, alpha: 0.3 - lift * 0.2 } });
        continue;
      }
      if (b.status === 'racked' || b.status === 'held') {
        const seen = appearedAt.get(b.id);
        const fade = seen === undefined ? 1 : clamp((now - seen) / 260, 0, 1);
        const p = rackSlot(b.id);
        out.push({ id: b.id, pos: [p[0], p[1], p[2] + (1 - fade) * 0.4], alpha: fade, dim: 0, shadow: { x: p[0], y: p[1], scale: 1, alpha: 0.3 * fade } });
        continue;
      }
      if (b.status === 'done') {
        const age = (pred.state.tick - b.doneTick) / RETURN_TICKS;
        if (age > 1) continue;
        out.push({ id: b.id, pos: [b.x, b.y, b.z], alpha: 1 - clamp((age - 0.6) / 0.4, 0, 1), dim: 0.25, shadow: { x: b.x, y: b.y, scale: 1, alpha: 0.3 } });
        continue;
      }
      if (b.status !== 'flying') continue;
      const height = Math.max(0, b.z - R);
      out.push({ id: b.id, pos: [b.x, b.y, b.z], alpha: 1, dim: 0, shadow: { x: b.x, y: b.y, scale: clamp(1 - height / 10, 0.4, 1), alpha: 0.32 * clamp(1 - height / 8, 0.25, 1) } });
    }
    return out;
  }

  function drawBalls3D(now: number) {
    if (!scene) return;
    const base = me?.color ?? '#ff8c3a';
    const color = hexToRgbTuple(base);
    const spot = hexToRgbTuple(shade(base, -0.55));
    const list = poses(now);
    for (const p of list) {
      if (!p.shadow) continue;
      const rr = R * p.shadow.scale;
      const model = mat4FromAxes([rr, 0, 0], [0, rr, 0], [0, 0, 1], [p.shadow.x, p.shadow.y, 0.012]);
      scene.draw(scene.disc, model, { unlit: true, alpha: p.shadow.alpha * p.alpha, noDepthWrite: true });
    }
    if (pred.state) {
      for (const b of pred.state.balls) {
        if (b.status !== 'flying') continue;
        const trail = trails.get(b.id);
        if (!trail || trail.length < 6) continue;
        for (let g = 1; g <= 3; g++) {
          const p = trail[trail.length - 1 - g * 2];
          if (!p) break;
          scene.draw(scene.sphere, mat4Compose(p, orientation.get(b.id) ?? QUAT_IDENTITY, R * (1 - g * 0.12)), { ball: { color, spot, dim: 0 }, alpha: 0.2 - g * 0.05, noDepthWrite: true });
        }
      }
    }
    for (const p of list) {
      scene.draw(scene.sphere, mat4Compose(p.pos, orientation.get(p.id) ?? QUAT_IDENTITY, R), { ball: { color, spot, dim: p.dim }, alpha: p.alpha, noDepthWrite: p.alpha < 1 });
    }
  }

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
    const standing = state.phase === 'countdown' ? 'Ready?' : `${ordinal(state.me.rank)} of ${state.playerCount} · ${state.me.makes}/${state.me.attempts}`;
    ctx.strokeText(standing, 13, 10 + big);
    ctx.fillText(standing, 13, 10 + big);
    ctx.textAlign = 'right';
    if (state.me.streak >= 2 && state.phase === 'playing') {
      ctx.fillStyle = '#ffe74c';
      ctx.strokeText(`🔥 ${state.me.streak} in a row`, W - 12, 10);
      ctx.fillText(`🔥 ${state.me.streak} in a row`, W - 12, 10);
    } else if (state.phase === 'playing' && state.playerCount > 1) {
      const gap = state.leaderScore - state.me.score;
      ctx.fillStyle = gap <= 0 ? '#5ce07a' : 'rgba(255,255,255,0.75)';
      const note = gap <= 0 ? 'leading' : `${gap} behind`;
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
    const y = H * 0.55 - u * 40;
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
    if (state.phase === 'countdown') {
      const secs = Math.ceil(state.countdownMs / 1000);
      big = secs > 0 ? String(secs) : 'GO!';
      small = `${Math.round(state.roundMsLeft / 1000)} seconds. Grab a ball, flick it at the hoop. Swish for 3!`;
    } else if (state.phase === 'finished') {
      const winner = state.winnerId ? players.get(state.winnerId) : null;
      const iWon = state.winnerId === me?.id;
      big = iWon ? '🏆 You win!' : `${winner?.name ?? 'Someone'} wins`;
      small = `${state.me.score} points · ${state.me.makes}/${state.me.attempts} made · ${ordinal(state.me.rank)} of ${state.playerCount}`;
    } else return;
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

  function renderPips(ready: number) {
    if (pipsEl.childElementCount !== BALLS_PER_PLAYER) {
      pipsEl.replaceChildren(...Array.from({ length: BALLS_PER_PLAYER }, () => document.createElement('i')));
    }
    Array.from(pipsEl.children).forEach((pip, i) => pip.classList.toggle('hp-pip-used', i >= ready));
  }

  resize();
  raf = requestAnimationFrame(frame);
  const dbg = window as unknown as { __hpTable?: () => TableState | null; __hpScreen?: (id: number) => { x: number; y: number } | null };
  dbg.__hpTable = () => pred.state;
  dbg.__hpScreen = (id) => {
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
          if (held && held.status === 'racked') grabBall(t, held.id);
        }
      });
      if (next.me.score !== shownScore) {
        shownScore = next.me.score;
        scoreBumpAt = performance.now();
      }
      const secs = Math.ceil(next.roundMsLeft / 1000);
      timerEl.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      timerEl.classList.toggle('hp-ctl-timer-low', next.phase === 'playing' && secs <= 10);
      renderPips(next.table.balls.filter((b) => b.status === 'racked').length);
      for (const pip of Array.from(pipsEl.children)) (pip as HTMLElement).style.background = meInfo.color;
      el.classList.toggle('hp-ctl-finished', next.phase === 'finished');
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      root.innerHTML = '';
    },
  };
}

// ---- the court geometry -----------------------------------------------------

/** Floor, rack, backboard, rim and pole: everything solid. */
function buildCourt(): MeshBuilder {
  const m = new MeshBuilder();
  const hw = COURT.halfWidth;
  // Floor: hardwood boards
  for (let i = 0; i < 12; i++) {
    const y = -1.6 + i * 0.8;
    if (y >= COURT.backY) break;
    m.color(i % 2 === 0 ? '#8a5a2b' : '#805327').rect(GROUND, -hw - 0.3, y, hw + 0.3, Math.min(COURT.backY, y + 0.8), 0);
  }
  // Markings: the free-throw line and the hoop line
  m.color('#c9a070').rect(GROUND, -hw, COURT.hoopY - 0.02, hw, COURT.hoopY + 0.02, 0.004);
  m.color('#c9a070').rect(GROUND, -1.2, -0.02, 1.2, 0.02, 0.004);
  // Ball rack: a shelf with cups
  m.color('#1c1230').box(GROUND, -hw - 0.3, RACK_Y - 0.55, hw + 0.3, RACK_Y + 0.45, 0, RACK_Z);
  for (let i = 0; i < BALLS_PER_PLAYER; i++) {
    const x = (i - (BALLS_PER_PLAYER - 1) / 2) * RACK_GAP;
    m.color('#0d0818').ring(GROUND, x, RACK_Y, 0, R * 0.85, RACK_Z + 0.004, 24);
  }
  // Pole and arm
  m.color('#3a3f55').box(GROUND, -0.12, COURT.backY - 0.35, 0.12, COURT.backY - 0.1, 0, COURT.boardTop + 0.3);
  m.color('#3a3f55').box(GROUND, -0.1, COURT.boardY + 0.06, 0.1, COURT.backY - 0.1, COURT.boardTop - 0.3, COURT.boardTop - 0.1);
  // Backboard: white slab with a red target box, facing the player
  const bf: Frame = { o: [0, COURT.boardY, 0], ex: [1, 0, 0], eu: [0, 0, 1], en: [0, -1, 0] };
  m.color('#e9ecf5').box(bf, -COURT.boardHalfWidth, COURT.boardBottom, COURT.boardHalfWidth, COURT.boardTop, -0.08, 0);
  m.color('#d8dbe6').rect(bf, -COURT.boardHalfWidth + 0.06, COURT.boardBottom + 0.06, COURT.boardHalfWidth - 0.06, COURT.boardTop - 0.06, 0.004);
  const sq = 0.62;
  const z0 = COURT.hoopZ + 0.02;
  m.color('#e0432f');
  m.rect(bf, -sq, z0, sq, z0 + 0.06, 0.008);
  m.rect(bf, -sq, z0 + 0.78, sq, z0 + 0.84, 0.008);
  m.rect(bf, -sq, z0, -sq + 0.06, z0 + 0.84, 0.008);
  m.rect(bf, sq - 0.06, z0, sq, z0 + 0.84, 0.008);
  // Rim bracket and the rim itself
  m.color('#e05a1e').box(GROUND, -0.18, COURT.hoopY + COURT.rimR - 0.05, 0.18, COURT.boardY, COURT.hoopZ - 0.08, COURT.hoopZ + 0.02);
  m.color('#ff7a2a').torus(GROUND, 0, COURT.hoopY, COURT.hoopZ, COURT.rimR, COURT.rimTube, 48, 10);
  return m;
}

/** The net: a translucent cone under the rim, seen from both sides. */
function buildNet(): MeshBuilder {
  const m = new MeshBuilder().color('#ffffff');
  m.cone(GROUND, 0, COURT.hoopY, COURT.rimR - 0.02, COURT.hoopZ - 0.03, 0.42, COURT.hoopZ - COURT.netDepth, false, 24);
  m.cone(GROUND, 0, COURT.hoopY, COURT.rimR - 0.02, COURT.hoopZ - 0.03, 0.42, COURT.hoopZ - COURT.netDepth, true, 24);
  return m;
}

/** The cage: side and back panels with posts, drawn translucent. */
function buildCage(): MeshBuilder {
  const m = new MeshBuilder();
  const hw = COURT.halfWidth;
  const zc = COURT.ceilingZ;
  m.color('#5a4a9a');
  m.quad([-hw, COURT.backY, 0], [hw, COURT.backY, 0], [hw, COURT.backY, zc], [-hw, COURT.backY, zc], [0, -1, 0]);
  m.quad([-hw, 0.4, 0], [-hw, COURT.backY, 0], [-hw, COURT.backY, zc], [-hw, 0.4, zc], [1, 0, 0]);
  m.quad([hw, COURT.backY, 0], [hw, 0.4, 0], [hw, 0.4, zc], [hw, COURT.backY, zc], [-1, 0, 0]);
  m.color('#9a8ad8');
  for (const side of [-1, 1]) for (const y of [0.4, 2.2, 4.0, 5.8, COURT.backY]) m.box(GROUND, side * hw - 0.04, y - 0.04, side * hw + 0.04, y + 0.04, 0, zc);
  for (const side of [-1, 1]) m.box(GROUND, side * hw - 0.04, 0.4, side * hw + 0.04, COURT.backY, zc - 0.06, zc);
  return m;
}
