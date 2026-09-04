import type { PlayerInfo } from '@funfair/shared';
import type { ControllerView } from '@funfair/shared/client';
import {
  AIM_UNITS,
  HOLES,
  MIN_POWER,
  ROLL_COOLDOWN_MS,
  ROWS,
  ZONE_LABEL,
  ZONE_POINTS,
  clamp,
  ordinal,
  resolveRoll,
  type RollABallInput,
  type RollABallPlayerState,
  type RollKind,
  type RollResult,
  type Zone,
} from './logic';

export const ZONE_COLORS: Record<Zone, string> = { walk: '#5ce07a', trot: '#ffb547', gallop: '#ff5c5c' };

/** Flick speed (canvas heights per second) that counts as full power. */
const POWER_SCALE = 8;
/** Horizontal/vertical drag ratio that counts as fully off-centre. */
const AIM_SCALE = 0.35;
const MIN_FLICK_PX = 24;
const VELOCITY_WINDOW_MS = 120;
const BALL_TRAVEL_MS = 450;
const BALL_REST_MS = 500;
const POPUP_MS = 900;

interface Sample {
  x: number;
  y: number;
  t: number;
}

interface Flight {
  startedAt: number;
  power: number;
  aim: number;
  /** Client-side prediction of where the ball lands (same rules as the server). */
  landing: RollResult;
  rollsBefore: number;
  /** Set once the server confirms the roll. */
  confirmed: { points: number; kind: RollKind; zone: Zone | null } | null;
  popupAt: number | null;
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
        <div class="rab-ctl-score">0 / 40</div>
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
  let lastSentAt = -Infinity;
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

  // ---- geometry -----------------------------------------------------------
  // Top-down view: legend, then the pyramid board (apex at the back), the ramp
  // lip, the ramp, and the ball's rest position at the bottom.
  const legendY = () => H * 0.045;
  const boardBack = () => H * 0.15; // apex row
  const boardFront = () => H * 0.6; // front row
  const lipY = () => H * 0.67;
  const rampBottom = () => H * 0.82;
  const restY = () => H * 0.9;
  const cx = () => W / 2;
  const rowSpacing = () => (boardFront() - boardBack()) / (ROWS - 1);
  /** Half-width of the board at a given y – narrower towards the back for a little perspective. */
  const halfWidthAt = (y: number) => {
    const t = clamp((rampBottom() - y) / (rampBottom() - boardBack()), 0, 1);
    return W * (0.44 - 0.14 * t);
  };
  const yForRow = (row: number) => boardFront() - row * rowSpacing();
  /** Canvas x for a lateral position in board units at a given y. */
  const xAt = (units: number, y: number) => cx() + (units / AIM_UNITS) * halfWidthAt(y);
  const holeR = () => Math.min((halfWidthAt(boardFront()) / AIM_UNITS) * 0.38, rowSpacing() * 0.38);
  const ballR = () => Math.max(12, holeR() * 0.85);
  /** Where a roll comes to rest on the canvas. */
  const restingPoint = (r: RollResult, power: number) => {
    switch (r.kind) {
      case 'hit': {
        const y = yForRow(r.row!);
        return { x: xAt(r.x, y), y };
      }
      case 'wide': {
        const y = yForRow(r.row!);
        return { x: xAt(clamp(r.x, -AIM_UNITS, AIM_UNITS), y), y };
      }
      case 'short': {
        const y = rampBottom() - (clamp(power, 0, MIN_POWER) / MIN_POWER) * (rampBottom() - lipY());
        return { x: xAt(r.x, y), y };
      }
      case 'gutter': {
        const y = boardBack() - rowSpacing() * 0.8;
        return { x: xAt(r.x * 0.6, y), y };
      }
    }
  };

  // ---- input --------------------------------------------------------------
  function canRoll(now: number) {
    return !!state && state.phase === 'racing' && state.me.finishedAt === null && now - lastSentAt >= ROLL_COOLDOWN_MS;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!canRoll(performance.now())) return;
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
    if (!canRoll(now)) return;
    lastSentAt = now;
    flight = {
      startedAt: now,
      power: gesture.power,
      aim: gesture.aim,
      landing: resolveRoll(gesture.power, gesture.aim),
      rollsBefore: state!.me.rolls,
      confirmed: null,
      popupAt: null,
    };
    send({ type: 'roll', power: gesture.power, aim: gesture.aim });
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // ---- drawing ------------------------------------------------------------
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    if (!W || !H) return;
    draw(now);
  }

  function draw(now: number) {
    ctx.clearRect(0, 0, W, H);
    drawBoard();
    drawHoles();
    drawBall(now);
    drawPopup(now);
    drawOverlay(now);
  }

  function drawBoard() {
    const bb = boardBack();
    const rb = rampBottom();
    const top = bb - rowSpacing() * 1.3;
    // Ramp + board as one trapezoid
    ctx.beginPath();
    ctx.moveTo(cx() - halfWidthAt(rb) - 12, H * 0.98);
    ctx.lineTo(cx() + halfWidthAt(rb) + 12, H * 0.98);
    ctx.lineTo(cx() + halfWidthAt(top), top);
    ctx.lineTo(cx() - halfWidthAt(top), top);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, top, 0, H);
    g.addColorStop(0, '#3a2412');
    g.addColorStop(0.55, '#5a3a1c');
    g.addColorStop(1, '#7a5230');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 220, 160, 0.35)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Gutter trough behind the apex
    const gy = bb - rowSpacing() * 0.8;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(cx() - halfWidthAt(gy), gy - rowSpacing() * 0.22, halfWidthAt(gy) * 2, rowSpacing() * 0.44);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = `600 ${Math.max(10, W * 0.028)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('GUTTER', cx(), gy);

    // Ramp lip
    ctx.strokeStyle = 'rgba(255, 220, 160, 0.25)';
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(cx() - halfWidthAt(lipY()), lipY());
    ctx.lineTo(cx() + halfWidthAt(lipY()), lipY());
    ctx.stroke();
    ctx.setLineDash([]);

    // Legend
    const zones: Zone[] = ['walk', 'trot', 'gallop'];
    ctx.font = `700 ${Math.max(11, W * 0.034)}px system-ui, sans-serif`;
    const gap = W * 0.06;
    const widths = zones.map((z) => ctx.measureText(`${ZONE_LABEL[z]} +${ZONE_POINTS[z]}`).width + holeR() * 1.2);
    let x = cx() - (widths.reduce((a, b) => a + b, 0) + gap * (zones.length - 1)) / 2;
    zones.forEach((z, i) => {
      ctx.beginPath();
      ctx.arc(x + holeR() * 0.4, legendY(), holeR() * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = ZONE_COLORS[z];
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${ZONE_LABEL[z]} +${ZONE_POINTS[z]}`, x + holeR() * 1.2, legendY());
      x += widths[i]! + gap;
    });
  }

  function drawHoles() {
    const r = holeR();
    for (const h of HOLES) {
      const y = yForRow(h.row);
      const x = xAt(h.x, y);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#120a06';
      ctx.fill();
      ctx.lineWidth = Math.max(2, r * 0.22);
      ctx.strokeStyle = ZONE_COLORS[h.zone];
      ctx.stroke();
    }
  }

  function ballPosition(now: number): { x: number; y: number; scale: number } {
    if (!flight) return { x: cx(), y: restY(), scale: 1 };
    const t = now - flight.startedAt;
    if (t >= BALL_TRAVEL_MS + BALL_REST_MS) return { x: cx(), y: restY(), scale: 1 };
    const target = restingPoint(flight.landing, flight.power);
    const u = clamp(t / BALL_TRAVEL_MS, 0, 1);
    const eased = 1 - Math.pow(1 - u, 3);
    const x = cx() + (target.x - cx()) * eased;
    const y = restY() + (target.y - restY()) * eased;
    // Sink into the hole (or the gutter) once landed.
    const sink = u >= 1 ? clamp((t - BALL_TRAVEL_MS) / 200, 0, 1) : 0;
    const kind = flight.landing.kind;
    const scale = kind === 'hit' ? 1 - sink * 0.45 : kind === 'gutter' ? 1 - sink * 0.6 : 1;
    return { x, y, scale };
  }

  function drawBall(now: number) {
    const { x, y, scale } = ballPosition(now);
    const r = ballR() * scale;
    const color = me?.color ?? '#fff';
    const cooling = !canRoll(now) && !!state && state.phase === 'racing' && state.me.finishedAt === null;

    // Cooldown ring around the rest position
    if (cooling && !flight) {
      const frac = clamp((now - lastSentAt) / ROLL_COOLDOWN_MS, 0, 1);
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 4;
      ctx.arc(cx(), restY(), ballR() + 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.25, color);
    g.addColorStop(1, shade(color, -0.45));
    ctx.fillStyle = g;
    ctx.globalAlpha = cooling && !flight ? 0.5 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;

    if (!flight && canRoll(now)) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = `600 ${Math.max(12, W * 0.035)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('▲ flick', cx(), restY() - ballR() - 16 + Math.sin(now / 250) * 3);
    }
  }

  function drawPopup(now: number) {
    if (!flight) return;
    const settled = now - flight.startedAt >= BALL_TRAVEL_MS;
    if (settled && flight.confirmed && flight.popupAt === null) {
      flight.popupAt = now;
      buzz(flight.confirmed.kind);
    }
    if (flight.popupAt === null) {
      if (now - flight.startedAt > BALL_TRAVEL_MS + BALL_REST_MS + 1500) flight = null;
      return;
    }
    const t = now - flight.popupAt;
    if (t > POPUP_MS) {
      flight = null;
      return;
    }
    const u = t / POPUP_MS;
    const { kind, points, zone } = flight.confirmed!;
    const text =
      kind === 'hit' && zone ? `${ZONE_LABEL[zone].toUpperCase()} +${points}` : kind === 'wide' ? 'WIDE' : kind === 'short' ? 'SHORT' : 'GUTTER';
    // Popups live in the empty ramp area so they never cover the board or legend.
    const y = (lipY() + restY()) / 2 - u * 40;
    ctx.globalAlpha = 1 - u * u;
    ctx.fillStyle = kind === 'hit' && zone ? ZONE_COLORS[zone] : '#ff8a8a';
    fitFont(ctx, text, 900, Math.max(26, W * 0.12), W * 0.85);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.strokeText(text, cx(), y);
    ctx.fillText(text, cx(), y);
    ctx.globalAlpha = 1;
  }

  function drawOverlay(now: number) {
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
    void now;
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
      rankEl.textContent = next.phase === 'countdown' ? 'Ready?' : `${ordinal(next.me.rank)} of ${next.playerCount}`;
      scoreEl.textContent = `${next.me.progress} / ${next.trackLength}`;
      meBar.style.width = `${(next.me.progress / next.trackLength) * 100}%`;
      meBar.style.background = meInfo.color;
      leaderBar.style.width = `${(next.leaderProgress / next.trackLength) * 100}%`;
      hintEl.textContent =
        next.phase === 'racing'
          ? next.me.progress >= next.leaderProgress
            ? "You're leading — keep flicking!"
            : `${next.leaderProgress - next.me.progress} behind the leader`
          : next.phase === 'countdown'
            ? 'Flick the ball up the ramp. Aim straight for the small holes.'
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

/** Turn a pointer trace into power (0..1) and aim (-1..1), or null if it wasn't a flick. */
export function readFlick(samples: Sample[], canvasHeight: number): { power: number; aim: number } | null {
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
  const power = clamp(speed / POWER_SCALE, 0, 1);

  const dx = last.x - first.x;
  const aim = clamp(dx / Math.max(1, totalDy) / AIM_SCALE, -1, 1);
  return { power, aim };
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

function buzz(kind: RollKind) {
  try {
    navigator.vibrate?.(kind === 'hit' ? [30, 40, 30] : 15);
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
