import type { PlayerInfo } from '@funfair/shared';
import type { HostView } from '@funfair/shared/client';
import { BALLS_PER_PLAYER, LANE, RINGS, ordinal, type FeedEntry, type RacerState, type SkeeBallHostState } from './logic';
import { pointColor } from './controller';
import { escapeHtml, fitFont, hexToRgba, shade } from '../render/util';

interface Card {
  el: HTMLElement;
  score: HTMLElement;
  pips: HTMLElement;
  rank: HTMLElement;
  board: HTMLCanvasElement;
  drawn: number;
  shownScore: number;
}

export function mountSkeeBallHost(root: HTMLElement): HostView<SkeeBallHostState> {
  root.innerHTML = `
    <div class="skb-host">
      <div class="skb-arena">
        <div class="skb-cards"></div>
        <canvas class="skb-overlay"></canvas>
      </div>
      <aside class="skb-side">
        <h2>Skee-Ball Alley</h2>
        <div class="skb-clock">1:00</div>
        <p class="skb-side-hint">Nine balls each. Roll up the lane, over the jump and into the rings: 10 anywhere, 20–50 in the rings, 100 in the corner pockets. Too hard and the ball hops. Highest total wins.</p>
        <ol class="skb-feed"></ol>
      </aside>
    </div>`;

  const arena = root.querySelector<HTMLElement>('.skb-arena')!;
  const cardsEl = root.querySelector<HTMLElement>('.skb-cards')!;
  const overlay = root.querySelector<HTMLCanvasElement>('.skb-overlay')!;
  const clockEl = root.querySelector<HTMLElement>('.skb-clock')!;
  const feedEl = root.querySelector<HTMLOListElement>('.skb-feed')!;
  const octx = overlay.getContext('2d')!;

  let state: SkeeBallHostState | null = null;
  let players = new Map<string, PlayerInfo>();
  const cards = new Map<string, Card>();
  let raf = 0;
  let goShownUntil = 0;
  let lastFeedKey = '';

  const ro = new ResizeObserver(() => resize());
  ro.observe(arena);

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    overlay.width = Math.max(1, Math.floor(arena.clientWidth * dpr));
    overlay.height = Math.max(1, Math.floor(arena.clientHeight * dpr));
    overlay.style.width = `${arena.clientWidth}px`;
    overlay.style.height = `${arena.clientHeight}px`;
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const c of cards.values()) c.drawn = -1;
  }

  function card(r: RacerState): Card {
    let c = cards.get(r.playerId);
    if (c) return c;
    const p = players.get(r.playerId);
    const el = document.createElement('div');
    el.className = 'skb-card';
    el.style.setProperty('--c', p?.color ?? '#fff');
    el.innerHTML = `
      <div class="skb-card-head">
        <span class="skb-card-avatar">${p?.avatar ?? ''}</span>
        <span class="skb-card-name">${escapeHtml(p?.name ?? '?')}</span>
        <span class="skb-card-rank"></span>
      </div>
      <div class="skb-card-score">0</div>
      <div class="skb-card-pips">${'<i></i>'.repeat(BALLS_PER_PLAYER)}</div>
      <canvas class="skb-card-board"></canvas>`;
    c = {
      el,
      score: el.querySelector('.skb-card-score')!,
      pips: el.querySelector('.skb-card-pips')!,
      rank: el.querySelector('.skb-card-rank')!,
      board: el.querySelector('.skb-card-board')!,
      drawn: -1,
      shownScore: 0,
    };
    cards.set(r.playerId, c);
    cardsEl.appendChild(el);
    return c;
  }

  /** A top-down picture of the board with every landing so far. */
  function drawBoard(c: Card, r: RacerState) {
    const canvas = c.board;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const scale = Math.min(w / (LANE.boardHalfWidth * 2), h / (LANE.boardLength + 0.3));
    const ox = w / 2;
    const oy = h - 4;
    const X = (x: number) => ox + x * scale;
    const U = (u: number) => oy - u * scale;
    // Face
    ctx.fillStyle = '#2f2150';
    ctx.beginPath();
    ctx.roundRect(X(-LANE.boardHalfWidth), U(LANE.boardLength), LANE.boardHalfWidth * 2 * scale, LANE.boardLength * scale, 6);
    ctx.fill();
    // Rings
    for (let i = RINGS.length - 1; i >= 0; i--) {
      const ring = RINGS[i]!;
      ctx.beginPath();
      ctx.arc(X(0), U(LANE.ringU), ring.r * scale, 0, Math.PI * 2);
      ctx.fillStyle = shade(pointColor(ring.points), i % 2 === 0 ? -0.15 : -0.35);
      ctx.fill();
    }
    // Pockets
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(X(side * LANE.pocketX), U(LANE.pocketU), LANE.pocketR * 1.3 * scale, 0, Math.PI * 2);
      ctx.fillStyle = pointColor(100);
      ctx.fill();
    }
    // Landings: dots on the board, misses as crosses above it
    r.landings.forEach((l, i) => {
      const fresh = i === r.landings.length - 1;
      if (l.u < 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 2;
        const x = X(l.x);
        const y = U(LANE.boardLength) - 6;
        ctx.beginPath();
        ctx.moveTo(x - 4, y - 4);
        ctx.lineTo(x + 4, y + 4);
        ctx.moveTo(x + 4, y - 4);
        ctx.lineTo(x - 4, y + 4);
        ctx.stroke();
        return;
      }
      ctx.beginPath();
      ctx.arc(X(l.x), U(l.u), fresh ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = players.get(r.playerId)?.color ?? '#fff';
      ctx.fill();
      ctx.lineWidth = fresh ? 2.5 : 1.5;
      ctx.strokeStyle = fresh ? '#fff' : 'rgba(0,0,0,0.6)';
      ctx.stroke();
    });
  }

  function render() {
    if (!state) return;
    const racers = state.racers;
    const seen = new Set<string>();
    racers.forEach((r, i) => {
      const c = card(r);
      seen.add(r.playerId);
      cardsEl.appendChild(c.el); // keeps DOM order = standings order
      c.el.classList.toggle('skb-card-lead', i === 0 && r.score > 0);
      c.el.classList.toggle('skb-card-out', r.ballsLeft === 0);
      c.rank.textContent = state!.phase === 'countdown' ? '' : ordinal(r.rank);
      if (r.score !== c.shownScore) {
        c.shownScore = r.score;
        c.score.textContent = String(r.score);
        c.score.classList.remove('skb-bump');
        void c.score.offsetWidth;
        c.score.classList.add('skb-bump');
      }
      Array.from(c.pips.children).forEach((pip, k) => pip.classList.toggle('skb-pip-used', k >= r.ballsLeft));
      if (c.drawn !== r.landings.length) {
        drawBoard(c, r);
        c.drawn = r.landings.length;
      }
      const flash = r.lastScore && state!.raceMs - r.lastScore.at < 900 ? r.lastScore.points : null;
      c.el.style.setProperty('--flash', flash !== null && flash >= 20 ? hexToRgba(pointColor(flash), 0.25) : 'transparent');
    });
    for (const [id, c] of cards) {
      if (!seen.has(id)) {
        c.el.remove();
        cards.delete(id);
      }
    }
    cardsEl.dataset.count = String(Math.min(racers.length, 8));
    const secs = Math.ceil(state.roundMsLeft / 1000);
    clockEl.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    clockEl.classList.toggle('skb-clock-low', state.phase === 'playing' && secs <= 10);
  }

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    if (!state) return;
    const W = arena.clientWidth;
    const H = arena.clientHeight;
    octx.clearRect(0, 0, W, H);
    if (state.phase === 'countdown') {
      const secs = Math.ceil(state.countdownMs / 1000);
      drawOverlay(octx, W, H, secs > 0 ? String(secs) : 'GO!', 'Get your phones ready…');
      goShownUntil = now + 900;
    } else if (state.phase === 'playing' && now < goShownUntil) {
      drawOverlay(octx, W, H, 'GO!', '', 0.25);
    } else if (state.phase === 'finished') {
      const winner = state.winnerId ? players.get(state.winnerId) : null;
      const top = state.racers[0];
      drawOverlay(octx, W, H, `🏆 ${winner?.name ?? 'Someone'} wins!`, top ? `${top.score} points · results coming up…` : '', 0.45);
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
        li.className = 'skb-feed-item';
        li.innerHTML = `<span class="skb-feed-avatar">${p?.avatar ?? ''}</span><span class="skb-feed-name">${escapeHtml(p?.name ?? '?')}</span><span class="skb-feed-result" style="color:${pointColor(f.points)}">${feedLabel(f)}</span>`;
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
      render();
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
  if (f.points === 0) return 'over the top';
  if (f.points >= 100) return `pocket! +${f.points}`;
  return `+${f.points}`;
}

function drawOverlay(ctx: CanvasRenderingContext2D, W: number, H: number, big: string, small: string, alpha = 0.55) {
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
