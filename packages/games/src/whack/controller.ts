import type { PlayerInfo } from '@funfair/shared';
import type { ControllerView } from '@funfair/shared/client';
import {
  FIELD,
  MOLE,
  RULES,
  clamp,
  holeCount,
  holePos,
  ordinal,
  stunned,
  tableRules,
  type MoleKind,
  type MoleState,
  type TableEvent,
  type TableState,
  type WhackInput,
  type WhackPlayerState,
} from './logic';
import { QUAT_IDENTITY, quatFromAxisAngle, type Quat } from '../render/ball3d';
import {
  GROUND,
  MeshBuilder,
  createScene,
  mat4Compose,
  mat4Invert,
  mat4LookAt,
  mat4Multiply,
  mat4Perspective,
  mat4Transform,
  sceneError,
  type GpuMesh,
  type Mat4,
  type Vec3,
} from '../render/scene3d';
import { buzz, fitFont, shade } from '../render/util';
import { Prediction } from '../lockstep/client';

const POPUP_MS = 800;
const LABEL_MS = 700;
/** How long a point of the blade trail lives. */
const TRAIL_MS = 180;
/** Send a stroke once the finger has moved this far, in world units. */
const SLICE_STEP = 0.34;
const CAMERA_EYE: Vec3 = [0, -4.6, 7.3];
const CAMERA_TARGET: Vec3 = [0, 3.2, 0.2];
/** Half of the horizontal field of view. */
const HALF_HFOV = (19.5 * Math.PI) / 180;
const LIGHT: Vec3 = [-0.3, -0.5, 0.81];

const KIND_COLOR: Record<MoleKind, string> = { mole: '#a9713f', gold: '#ffcc33', bomb: '#575d78' };

interface Blade {
  pointerId: number;
  /** The last point sent, in world units. */
  wx: number;
  wy: number;
  points: { x: number; y: number; at: number }[];
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

export function mountWhackController(root: HTMLElement, send: (input: WhackInput) => void): ControllerView<WhackPlayerState> {
  root.innerHTML = `
    <div class="wm-ctl">
      <div class="wm-ctl-bar">
        <div class="wm-ctl-combo"></div>
        <div class="wm-ctl-timer">0:45</div>
      </div>
      <div class="wm-stage">
        <canvas class="wm-gl"></canvas>
        <canvas class="wm-lane"></canvas>
      </div>
    </div>`;

  const el = root.querySelector<HTMLElement>('.wm-ctl')!;
  const stage = root.querySelector<HTMLElement>('.wm-stage')!;
  const glCanvas = root.querySelector<HTMLCanvasElement>('.wm-gl')!;
  const canvas = root.querySelector<HTMLCanvasElement>('.wm-lane')!;
  const timerEl = root.querySelector<HTMLElement>('.wm-ctl-timer')!;
  const comboEl = root.querySelector<HTMLElement>('.wm-ctl-combo')!;
  const ctx = canvas.getContext('2d')!;
  const scene = createScene(glCanvas);
  let problem = scene ? '' : sceneError || 'WebGL is not available';
  let framesDrawn = 0;

  let state: WhackPlayerState | null = null;
  let me: PlayerInfo | null = null;
  let players = new Map<string, PlayerInfo>();
  const pred = new Prediction<TableState, WhackInput, TableEvent>(tableRules);
  let blade: Blade | null = null;
  let labels: FloatingLabel[] = [];
  let popup: Popup | null = null;
  let shownScore = 0;
  let scoreBumpAt = -Infinity;
  let celebrated = 0;
  let boomAt = -Infinity;
  let raf = 0;
  let W = 0;
  let H = 0;
  let viewProj: Mat4 | null = null;
  let viewProjInv: Mat4 | null = null;

  const field = scene ? scene.upload(buildField()) : null;
  const moleMesh: Record<MoleKind, GpuMesh | null> = {
    mole: scene ? scene.upload(buildMole('mole')) : null,
    gold: scene ? scene.upload(buildMole('gold')) : null,
    bomb: scene ? scene.upload(buildMole('bomb')) : null,
  };

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
  function project(p: Vec3): { x: number; y: number } {
    if (!viewProj) return { x: 0, y: 0 };
    const c = mat4Transform(viewProj, p[0], p[1], p[2]);
    const w = c[3] || 1e-6;
    return { x: ((c[0] / w + 1) / 2) * W, y: ((1 - c[1] / w) / 2) * H };
  }

  /** Where a screen point lands on the field, at the height the moles are cut. */
  function unproject(px: number, py: number): { x: number; y: number } {
    if (!viewProjInv) return { x: 0, y: 0 };
    const nx = (px / W) * 2 - 1;
    const ny = 1 - (py / H) * 2;
    const a = mat4Transform(viewProjInv, nx, ny, -1);
    const b = mat4Transform(viewProjInv, nx, ny, 1);
    const p0: Vec3 = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
    const p1: Vec3 = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
    const dz = p1[2] - p0[2];
    const t = Math.abs(dz) < 1e-9 ? 0 : (MOLE.up - p0[2]) / dz;
    return { x: p0[0] + (p1[0] - p0[0]) * t, y: p0[1] + (p1[1] - p0[1]) * t };
  }

  const playing = () => !!state && (state.phase === 'playing' || state.phase === 'finished');
  const canSwing = () => !!state && state.phase === 'playing' && !!pred.state;

  // ---- input --------------------------------------------------------------
  function pointerPos(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Send the stroke from the last point to here, and remember it. */
  function stroke(wx: number, wy: number) {
    if (!blade || !pred.state) return;
    const dx = wx - blade.wx;
    const dy = wy - blade.wy;
    if (dx * dx + dy * dy < SLICE_STEP * SLICE_STEP) return;
    const x0 = blade.wx;
    const y0 = blade.wy;
    blade.wx = wx;
    blade.wy = wy;
    const input = pred.input((tick) => ({ type: 'slice', x0, y0, x1: wx, y1: wy, tick }), (ev) => onEvent(ev, performance.now()));
    if (input) send(input);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!canSwing()) return;
    const p = pointerPos(e);
    const w = unproject(p.x, p.y);
    blade = { pointerId: e.pointerId, wx: w.x, wy: w.y, points: [{ x: p.x, y: p.y, at: performance.now() }] };
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!blade || e.pointerId !== blade.pointerId) return;
    const p = pointerPos(e);
    blade.points.push({ x: p.x, y: p.y, at: performance.now() });
    if (blade.points.length > 24) blade.points.shift();
    const w = unproject(p.x, p.y);
    stroke(w.x, w.y);
  });
  const endBlade = (e: PointerEvent) => {
    if (!blade || e.pointerId !== blade.pointerId) return;
    blade = null;
  };
  canvas.addEventListener('pointerup', endBlade);
  canvas.addEventListener('pointercancel', endBlade);

  function celebrate(points: number, kind: MoleKind, combo: number, pos: Vec3, now: number) {
    celebrated += 1;
    labels.push({ text: `+${points}`, color: kind === 'gold' ? '#ffe74c' : '#5ce07a', pos, at: now });
    if (combo >= 2) popup = { text: `COMBO ×${combo}`, color: combo >= 4 ? '#ffe74c' : '#5ce07a', at: now };
    buzz(kind === 'gold' ? [20, 30] : 18);
  }

  function onEvent(ev: TableEvent, now: number) {
    const pos: Vec3 = [ev.x, ev.y, MOLE.up + 0.4];
    switch (ev.type) {
      case 'whack':
        celebrate(ev.points ?? 1, ev.kind, ev.combo ?? 1, pos, now);
        break;
      case 'bomb':
        popup = { text: 'BOOM!', color: '#ff5c5c', at: now };
        labels.push({ text: `−${Math.abs(ev.points ?? 0)}`, color: '#ff5c5c', pos, at: now });
        boomAt = now;
        buzz([60, 40, 60]);
        break;
      case 'spawn':
        if (ev.kind === 'gold') buzz(4);
        break;
      case 'escape':
      case 'stun':
        break;
    }
  }

  // ---- drawing ------------------------------------------------------------
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);
    if (playing()) pred.advance(now, (ev) => onEvent(ev, now));
    if (scene && field && viewProj && !problem) {
      try {
        scene.begin(viewProj, CAMERA_EYE, LIGHT);
        scene.draw(field, mat4Compose([0, 0, 0], QUAT_IDENTITY, 1));
        drawMoles();
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
    drawBlade(now);
    drawHud(now);
    drawLabels(now);
    drawPopup(now);
    drawOverlay(now);
  }

  function drawMoles() {
    if (!scene || !pred.state) return;
    // Farthest first, so the near ones sit in front.
    const moles = pred.state.moles.filter((m) => m.status !== 'gone').sort((a, b) => holePos(b.hole).y - holePos(a.hole).y);
    for (const m of moles) {
      const mesh = moleMesh[m.kind];
      if (!mesh) continue;
      const p = holePos(m.hole);
      const rot: Quat = m.status === 'hit' ? quatFromAxisAngle(1, 0.4, 0, (pred.state.tick - m.hitTick) * 0.09) : QUAT_IDENTITY;
      const x = m.status === 'hit' ? p.x + m.vx * ((pred.state.tick - m.hitTick) / 120) : p.x;
      scene.draw(mesh, mat4Compose([x, p.y, m.z], rot, 1));
    }
  }

  /** The blade: a bright tapering streak behind the finger. */
  function drawBlade(now: number) {
    if (!blade) return;
    blade.points = blade.points.filter((p) => now - p.at < TRAIL_MS);
    if (blade.points.length < 2) return;
    const dead = !!pred.state && stunned(pred.state);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < blade.points.length; i++) {
        const a = blade.points[i - 1]!;
        const b = blade.points[i]!;
        const age = (now - b.at) / TRAIL_MS;
        const w = (1 - age) * (pass === 0 ? 22 : 8);
        if (w <= 0.5) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineWidth = w;
        ctx.strokeStyle = dead ? `rgba(255,92,92,${(1 - age) * (pass === 0 ? 0.12 : 0.3)})` : pass === 0 ? `rgba(120, 220, 255, ${(1 - age) * 0.25})` : `rgba(240, 252, 255, ${(1 - age) * 0.85})`;
        ctx.stroke();
      }
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
    const standing = state.phase === 'countdown' ? 'Ready?' : `${ordinal(state.me.rank)} of ${state.playerCount} · ${state.me.whacked} whacked`;
    ctx.strokeText(standing, 13, 10 + big);
    ctx.fillText(standing, 13, 10 + big);
    ctx.textAlign = 'right';
    if (state.phase === 'playing' && state.playerCount > 1) {
      const gap = state.leaderScore - state.me.score;
      ctx.fillStyle = gap <= 0 ? '#5ce07a' : 'rgba(255,255,255,0.75)';
      const note = gap <= 0 ? 'leading' : `${gap} behind`;
      ctx.strokeText(note, W - 12, 10);
      ctx.fillText(note, W - 12, 10);
    }
    // Stunned: the blade is dead for a beat after a bomb.
    if (pred.state && stunned(pred.state)) {
      const left = (pred.state.stunUntilTick - pred.state.tick) / RULES.stunTicks;
      ctx.fillStyle = `rgba(255,92,92,${0.12 + 0.1 * left})`;
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ff8a8a';
      ctx.font = `800 ${Math.max(14, W * 0.05)}px system-ui, sans-serif`;
      ctx.fillText('blade jammed!', W / 2, H * 0.14);
    }
  }

  function drawLabels(now: number) {
    labels = labels.filter((l) => now - l.at < LABEL_MS);
    for (const l of labels) {
      const u = (now - l.at) / LABEL_MS;
      const p = project(l.pos);
      ctx.globalAlpha = 1 - u * u;
      ctx.fillStyle = l.color;
      ctx.font = `900 ${Math.max(13, W * 0.045)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(l.text, p.x, p.y - u * 28);
      ctx.fillText(l.text, p.x, p.y - u * 28);
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
    ctx.globalAlpha = 1 - u * u;
    ctx.fillStyle = popup.color;
    fitFont(ctx, popup.text, 900, Math.max(26, W * 0.12), W * 0.85);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.strokeText(popup.text, W / 2, H * 0.3 - u * 30);
    ctx.fillText(popup.text, W / 2, H * 0.3 - u * 30);
    ctx.globalAlpha = 1;
  }

  function drawOverlay(now: number) {
    if (!state) return;
    // A bomb going off flashes the whole view.
    const boom = 1 - clamp((now - boomAt) / 260, 0, 1);
    if (boom > 0) {
      ctx.fillStyle = `rgba(255, 120, 80, ${0.5 * boom})`;
      ctx.fillRect(0, 0, W, H);
    }
    let big = '';
    let small = '';
    if (state.phase === 'countdown') {
      const secs = Math.ceil(state.countdownMs / 1000);
      big = secs > 0 ? String(secs) : 'GO!';
      small = 'Swipe through the moles. Chain them for combos, dodge the bombs!';
    } else if (state.phase === 'finished') {
      const winner = state.winnerId ? players.get(state.winnerId) : null;
      const iWon = state.winnerId === me?.id;
      big = iWon ? '🏆 You win!' : `${winner?.name ?? 'Someone'} wins`;
      small = `${state.me.score} points · ${state.me.whacked} whacked · best combo ×${state.me.bestCombo}`;
    } else return;
    ctx.fillStyle = 'rgba(8, 10, 28, 0.6)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const bigPx = fitFont(ctx, big, 800, Math.max(36, W * 0.16), W * 0.9);
    ctx.fillText(big, W / 2, H * 0.42);
    ctx.font = `500 ${fitFont(ctx, small, 500, Math.max(14, W * 0.042), W * 0.9)}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(small, W / 2, H * 0.42 + bigPx * 0.9);
  }

  resize();
  raf = requestAnimationFrame(frame);
  const dbg = window as unknown as { __wmTable?: () => TableState | null; __wmScreen?: (hole: number) => { x: number; y: number } };
  dbg.__wmTable = () => pred.state;
  dbg.__wmScreen = (hole) => {
    const p = holePos(hole);
    return project([p.x, p.y, MOLE.up]);
  };

  return {
    update(next, meInfo, playerList) {
      state = next;
      me = meInfo;
      players = new Map(playerList.map((p) => [p.id, p]));
      pred.sampleClock(next.raceMs, next.phase === 'playing' || next.phase === 'finished');
      pred.reconcile(next.table, undefined, (ev) => onEvent(ev, performance.now()));
      if (next.me.score !== shownScore) {
        // A whack the local field never announced: say it now, so nothing scores in silence.
        if (next.me.whacked > celebrated && next.me.score > shownScore) {
          celebrate(next.me.score - shownScore, 'mole', next.me.combo, [0, FIELD.frontY + FIELD.gapY, MOLE.up + 0.4], performance.now());
        }
        celebrated = Math.max(celebrated, next.me.whacked);
        shownScore = next.me.score;
        scoreBumpAt = performance.now();
      }
      const secs = Math.ceil(next.roundMsLeft / 1000);
      timerEl.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      timerEl.classList.toggle('wm-ctl-timer-low', next.phase === 'playing' && secs <= 10);
      const combo = pred.state?.combo ?? 0;
      comboEl.textContent = combo >= 2 ? `combo ×${combo}` : '';
      comboEl.style.color = combo >= 4 ? '#ffe74c' : '#5ce07a';
      el.classList.toggle('wm-ctl-finished', next.phase === 'finished');
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      root.innerHTML = '';
    },
  };
}

// ---- the field geometry -----------------------------------------------------

/** Grass, the holes the moles come out of, and a fence around the back. */
function buildField(): MeshBuilder {
  const m = new MeshBuilder();
  const hw = ((FIELD.cols - 1) / 2) * FIELD.gapX + 1.35;
  const front = FIELD.frontY - 4.0;
  const back = FIELD.frontY + (FIELD.rows - 1) * FIELD.gapY + 1.5;
  // Grass in stripes
  for (let i = 0; i < 14; i++) {
    const y0 = front + i * 0.8;
    if (y0 >= back) break;
    m.color(i % 2 === 0 ? '#3e7d3a' : '#376f34').rect(GROUND, -hw, y0, hw, Math.min(back, y0 + 0.8), 0);
  }
  // Holes: a raised earth rim around a dark opening. The opening is a disc laid
  // over the grass, so a mole below it is hidden until it climbs out.
  for (let h = 0; h < holeCount; h++) {
    const p = holePos(h);
    m.color('#553a20').wall(GROUND, p.x, p.y, FIELD.holeR + 0.24, 0, 0.1, false, 28);
    m.color('#7a5533').ring(GROUND, p.x, p.y, FIELD.holeR, FIELD.holeR + 0.24, 0.1, 28);
    m.color('#43301c').wall(GROUND, p.x, p.y, FIELD.holeR, 0.006, 0.1, true, 28);
    m.color('#120c05').ring(GROUND, p.x, p.y, 0, FIELD.holeR, 0.006, 24);
  }
  // Fence around the back and sides
  const fh = 0.85;
  m.color('#8a6a45');
  for (let x = -hw; x <= hw + 0.01; x += 0.7) m.box(GROUND, x - 0.07, back - 0.07, x + 0.07, back + 0.07, 0, fh);
  m.box(GROUND, -hw - 0.1, back - 0.04, hw + 0.1, back + 0.04, fh * 0.45, fh * 0.6);
  m.box(GROUND, -hw - 0.1, back - 0.04, hw + 0.1, back + 0.04, fh * 0.78, fh * 0.93);
  for (const side of [-1, 1]) {
    for (let y = front + 0.4; y < back; y += 0.7) m.box(GROUND, side * hw - 0.07, y - 0.07, side * hw + 0.07, y + 0.07, 0, fh);
    m.box(GROUND, side * hw - 0.04, front + 0.4, side * hw + 0.04, back, fh * 0.45, fh * 0.6);
    m.box(GROUND, side * hw - 0.04, front + 0.4, side * hw + 0.04, back, fh * 0.78, fh * 0.93);
  }
  return m;
}

/** A mole (or a bomb) sized to sit in a hole, its centre at the hole's height. */
function buildMole(kind: MoleKind): MeshBuilder {
  const m = new MeshBuilder();
  const c = KIND_COLOR[kind];
  const r = MOLE.r;
  if (kind === 'bomb') {
    m.color(c).ball([0, 0, 0], r, [1, 1, 1], 18, 26);
    m.color('#20232f').ball([0, -r * 0.55, r * 0.5], r * 0.42, [1, 1, 1], 10, 14);
    // Fuse and a spark
    m.color('#8a6a45').box(GROUND, -0.05, -0.05, 0.05, 0.05, r * 0.9, r * 1.5);
    m.color('#ffb547').ball([0, 0, r * 1.62], 0.14, [1, 1, 1], 10, 14);
    // A warning stripe
    m.color('#ff4444').ring({ o: [0, 0, 0], ex: [1, 0, 0], eu: [0, 0, 1], en: [0, -1, 0] }, 0, 0, r * 0.3, r * 0.62, r * 0.84, 22);
    return m;
  }
  const body = kind === 'gold' ? c : c;
  // Body, snout, ears, eyes, nose
  m.color(body).ball([0, 0, 0], r, [1, 0.92, 1.02], 18, 26);
  m.color(shade(body, 0.28)).ball([0, -r * 0.62, -r * 0.1], r * 0.52, [1, 0.85, 0.8], 12, 18);
  m.color(shade(body, -0.3)).ball([-r * 0.62, -r * 0.1, r * 0.6], r * 0.24, [1, 0.5, 1], 10, 14);
  m.color(shade(body, -0.3)).ball([r * 0.62, -r * 0.1, r * 0.6], r * 0.24, [1, 0.5, 1], 10, 14);
  m.color('#20161a').ball([-r * 0.3, -r * 0.78, r * 0.2], r * 0.11, [1, 1, 1], 8, 12);
  m.color('#20161a').ball([r * 0.3, -r * 0.78, r * 0.2], r * 0.11, [1, 1, 1], 8, 12);
  m.color('#e0748a').ball([0, -r * 1.02, -r * 0.06], r * 0.14, [1, 1, 1], 10, 14);
  // Buck teeth
  m.color('#f5f0e4').ball([0, -r * 0.92, -r * 0.34], r * 0.13, [1.1, 0.6, 1], 8, 12);
  return m;
}
