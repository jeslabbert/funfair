import type { PlayerInfo } from '@funfair/shared';
import type { HostView } from '@funfair/shared/client';
import { FIELD, holeCount, holePos, ordinal, type FeedEntry, type RacerState, type WhackHostState } from './logic';
import { escapeHtml, fitFont, hexToRgba } from '../render/util';

interface Card {
  el: HTMLElement;
  score: HTMLElement;
  pips: HTMLElement;
  rank: HTMLElement;
  board: HTMLCanvasElement;
  drawn: number;
  shownScore: number;
}

export function mountWhackHost(root: HTMLElement): HostView<WhackHostState> {
  root.innerHTML = `
    <div class="wm-host">
      <div class="wm-arena">
        <div class="wm-cards"></div>
        <canvas class="wm-overlay"></canvas>
      </div>
      <aside class="wm-side">
        <h2>Mole Mayhem</h2>
        <div class="wm-clock">0:45</div>
        <p class="wm-side-hint">Forty-five seconds. Moles pop out of nine holes and duck straight back down, and every swipe is a blade: whatever it passes through gets whacked. Chain hits for a combo worth more each time, and keep the blade off the bombs. Everyone gets the same moles.</p>
        <ol class="wm-feed"></ol>
      </aside>
    </div>`;

  const arena = root.querySelector<HTMLElement>('.wm-arena')!;
  const cardsEl = root.querySelector<HTMLElement>('.wm-cards')!;
  const overlay = root.querySelector<HTMLCanvasElement>('.wm-overlay')!;
  const clockEl = root.querySelector<HTMLElement>('.wm-clock')!;
  const feedEl = root.querySelector<HTMLOListElement>('.wm-feed')!;
  const octx = overlay.getContext('2d')!;

  let state: WhackHostState | null = null;
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
    el.className = 'wm-card';
    el.style.setProperty('--c', p?.color ?? '#fff');
    el.innerHTML = `
      <div class="wm-card-head">
        <span class="wm-card-avatar">${p?.avatar ?? ''}</span>
        <span class="wm-card-name">${escapeHtml(p?.name ?? '?')}</span>
        <span class="wm-card-rank"></span>
      </div>
      <div class="wm-card-score">0</div>
      <div class="wm-card-stats"><span class="wm-card-made">0 whacked</span><span class="wm-card-streak"></span></div>
      <canvas class="wm-card-board"></canvas>`;
    c = {
      el,
      score: el.querySelector('.wm-card-score')!,
      pips: el.querySelector('.wm-card-stats')!,
      rank: el.querySelector('.wm-card-rank')!,
      board: el.querySelector('.wm-card-board')!,
      drawn: -1,
      shownScore: 0,
    };
    cards.set(r.playerId, c);
    cardsEl.appendChild(el);
    return c;
  }

  /** The field from above, with the holes this player has just whacked lit up. */
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
    const spanX = (FIELD.cols - 1) * FIELD.gapX + FIELD.holeR * 4;
    const spanY = (FIELD.rows - 1) * FIELD.gapY + FIELD.holeR * 4;
    const scale = Math.min(w / spanX, h / spanY);
    const midY = FIELD.frontY + ((FIELD.rows - 1) * FIELD.gapY) / 2;
    const X = (x: number) => w / 2 + x * scale;
    const Y = (y: number) => h / 2 + (y - midY) * scale;
    ctx.fillStyle = '#2f5c2c';
    ctx.fillRect(0, 0, w, h);
    const color = players.get(r.playerId)?.color ?? '#fff';
    for (let hole = 0; hole < holeCount; hole++) {
      const p = holePos(hole);
      const seen = r.recent.lastIndexOf(hole);
      const heat = seen < 0 ? 0 : (seen + 1) / r.recent.length;
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y), FIELD.holeR * scale, 0, Math.PI * 2);
      ctx.fillStyle = '#160f06';
      ctx.fill();
      if (heat > 0) {
        ctx.fillStyle = hexToRgba(color, 0.25 + 0.6 * heat);
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(120, 90, 55, 0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  function render() {
    if (!state) return;
    const racers = state.racers;
    const seen = new Set<string>();
    racers.forEach((r, i) => {
      const c = card(r);
      seen.add(r.playerId);
      cardsEl.appendChild(c.el); // keeps DOM order = standings order
      c.el.classList.toggle('wm-card-lead', i === 0 && r.score > 0);
      c.rank.textContent = state!.phase === 'countdown' ? '' : ordinal(r.rank);
      if (r.score !== c.shownScore) {
        c.shownScore = r.score;
        c.score.textContent = String(r.score);
        c.score.classList.remove('wm-bump');
        void c.score.offsetWidth;
        c.score.classList.add('wm-bump');
      }
      c.pips.querySelector('.wm-card-made')!.textContent = `${r.whacked} whacked${r.bombs ? ` · ${r.bombs} 💣` : ''}`;
      c.pips.querySelector('.wm-card-streak')!.textContent = r.combo >= 2 ? `⚡ ×${r.combo}` : r.bestCombo >= 2 ? `best ×${r.bestCombo}` : '';
      const key = r.whacked + r.bombs;
      if (c.drawn !== key) {
        drawBoard(c, r);
        c.drawn = key;
      }
      const flash = r.lastScore && state!.raceMs - r.lastScore.at < 900 ? r.lastScore.points : null;
      c.el.style.setProperty('--flash', flash === null ? 'transparent' : flash > 0 ? hexToRgba(flash >= 3 ? '#ffe74c' : '#5ce07a', 0.25) : hexToRgba('#ff5c5c', 0.25));
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
    clockEl.classList.toggle('wm-clock-low', state.phase === 'playing' && secs <= 10);
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
        li.className = 'wm-feed-item';
        li.innerHTML = `<span class="wm-feed-avatar">${p?.avatar ?? ''}</span><span class="wm-feed-name">${escapeHtml(p?.name ?? '?')}</span><span class="wm-feed-result" style="color:${f.kind === 'bomb' ? '#ff5c5c' : f.kind === 'gold' ? '#ffe74c' : '#5ce07a'}">${feedLabel(f)}</span>`;
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
  if (f.kind === 'bomb') return `💣 ${f.points}`;
  const combo = f.combo >= 2 ? ` ×${f.combo}` : '';
  return `${f.kind === 'gold' ? '✨ ' : ''}+${f.points}${combo}`;
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
