import type { PlayerInfo } from '@funfair/shared';
import type { HostView } from '@funfair/shared/client';
import type { FeedEntry, RollABallHostState } from './logic';
import { fitFont } from './controller';

const LERP_RATE = 7; // higher = snappier catch-up to the server position

export function mountRollABallHost(root: HTMLElement): HostView<RollABallHostState> {
  root.innerHTML = `
    <div class="rab-host">
      <div class="rab-track-wrap"><canvas class="rab-track"></canvas></div>
      <aside class="rab-side">
        <h2>Roll-a-Ball Derby</h2>
        <p class="rab-side-hint">Flick the ball up the ramp. Land it in a hole to move your horse: 10, 20, 30 or the tiny 50. First to the finish wins.</p>
        <ol class="rab-feed"></ol>
      </aside>
    </div>`;

  const canvas = root.querySelector<HTMLCanvasElement>('.rab-track')!;
  const wrap = root.querySelector<HTMLElement>('.rab-track-wrap')!;
  const feedEl = root.querySelector<HTMLOListElement>('.rab-feed')!;
  const ctx = canvas.getContext('2d')!;

  let state: RollABallHostState | null = null;
  let players = new Map<string, PlayerInfo>();
  const display = new Map<string, number>();
  let lastFrame = performance.now();
  let raf = 0;
  let goShownUntil = 0;
  let lastFeedKey = '';

  const ro = new ResizeObserver(() => resize());
  ro.observe(wrap);

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (!state) return;
    for (const r of state.racers) {
      const cur = display.get(r.playerId) ?? 0;
      display.set(r.playerId, cur + (r.progress - cur) * Math.min(1, dt * LERP_RATE));
    }
    draw(now);
  }

  function draw(now: number) {
    if (!state) return;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    ctx.clearRect(0, 0, W, H);

    const racers = [...state.racers].sort((a, b) => a.playerId.localeCompare(b.playerId));
    const n = Math.max(1, racers.length);
    const top = 24;
    const bottom = 24;
    const laneH = (H - top - bottom) / n;
    const startX = 130;
    const finishX = W - 90;
    const trackW = finishX - startX;

    // Lanes
    racers.forEach((r, i) => {
      const y0 = top + i * laneH;
      ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.07)';
      ctx.fillRect(0, y0, W, laneH);
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.setLineDash([12, 14]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(startX, y0 + laneH / 2);
      ctx.lineTo(finishX, y0 + laneH / 2);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // Start & finish lines
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(startX - 2, top, 3, H - top - bottom);
    drawCheckers(ctx, finishX, top, 22, H - top - bottom);

    // Racers
    racers.forEach((r, i) => {
      const p = players.get(r.playerId);
      const color = p?.color ?? '#fff';
      const yc = top + i * laneH + laneH / 2;
      const prog = display.get(r.playerId) ?? 0;
      const x = startX + (prog / state!.trackLength) * trackW;
      const size = Math.min(56, laneH * 0.7);

      // Name tag on the left
      ctx.fillStyle = color;
      ctx.font = `700 ${Math.min(22, laneH * 0.32)}px system-ui, sans-serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(truncate(p?.name ?? '?', 12), startX - 14, yc);

      // Trail
      const grad = ctx.createLinearGradient(startX, 0, x, 0);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, hexToRgba(color, 0.35));
      ctx.fillStyle = grad;
      ctx.fillRect(startX, yc - 4, Math.max(0, x - startX), 8);

      // Horse (emoji) with a coloured disc behind it
      ctx.beginPath();
      ctx.fillStyle = hexToRgba(color, 0.25);
      ctx.arc(x, yc, size * 0.62, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `${size}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const bob = r.finishedAt === null && state!.phase !== 'countdown' ? Math.sin(now / 90 + i) * 2 : 0;
      ctx.fillText(p?.avatar ?? '🐎', x, yc + bob);

      // Points bubble
      const label = r.finishedAt !== null ? '🏁' : `${r.progress}`;
      ctx.font = `700 ${Math.min(18, laneH * 0.26)}px system-ui, sans-serif`;
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(label, x, yc - size * 0.72);
    });

    // Overlays
    if (state.phase === 'countdown') {
      const secs = Math.ceil(state.countdownMs / 1000);
      overlay(ctx, W, H, secs > 0 ? String(secs) : 'GO!', 'Get your phones ready…');
      goShownUntil = now + 900;
    } else if (state.phase === 'racing' && now < goShownUntil) {
      overlay(ctx, W, H, 'GO!', '', 0.25);
    } else if (state.phase === 'finished') {
      const winner = state.winnerId ? players.get(state.winnerId) : null;
      overlay(ctx, W, H, `🏆 ${winner?.name ?? 'Someone'} wins!`, 'Results coming up…', 0.45);
    }
  }

  function renderFeed() {
    if (!state) return;
    const key = state.feed.map((f) => `${f.playerId}:${f.seq}`).join('|');
    if (key === lastFeedKey) return;
    lastFeedKey = key;
    feedEl.replaceChildren(
      ...state.feed.map((f) => {
        const li = document.createElement('li');
        const p = players.get(f.playerId);
        li.style.setProperty('--c', p?.color ?? '#fff');
        li.className = `rab-feed-item rab-feed-${f.kind}`;
        li.innerHTML = `<span class="rab-feed-avatar">${p?.avatar ?? ''}</span><span class="rab-feed-name">${escapeHtml(p?.name ?? '?')}</span><span class="rab-feed-result">${feedLabel(f)}</span>`;
        return li;
      }),
    );
  }

  resize();
  raf = requestAnimationFrame(frame);

  return {
    update(next, playerList) {
      state = next;
      players = new Map(playerList.map((p) => [p.id, p]));
      renderFeed();
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      root.innerHTML = '';
    },
  };
}

function feedLabel(f: FeedEntry): string {
  switch (f.kind) {
    case 'hit':
      return `+${f.points}`;
    case 'wide':
      return 'wide';
    case 'short':
      return 'short';
    case 'gutter':
      return 'gutter!';
  }
}

function overlay(ctx: CanvasRenderingContext2D, W: number, H: number, big: string, small: string, alpha = 0.55) {
  ctx.fillStyle = `rgba(10, 12, 30, ${alpha})`;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fitFont(ctx, big, 800, Math.min(120, W * 0.09), W * 0.9);
  ctx.fillText(big, W / 2, H / 2 - 10);
  if (small) {
    ctx.font = `500 ${Math.min(28, W * 0.022)}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(small, W / 2, H / 2 + Math.min(70, W * 0.06));
  }
}

function drawCheckers(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const cell = w / 2;
  const rows = Math.ceil(h / cell);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < 2; c++) {
      ctx.fillStyle = (r + c) % 2 === 0 ? '#fff' : '#222';
      ctx.fillRect(x + c * cell, y + r * cell, cell, Math.min(cell, y + h - (y + r * cell)));
    }
  }
}

function hexToRgba(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return `rgba(255,255,255,${a})`;
  return `rgba(${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)},${a})`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
