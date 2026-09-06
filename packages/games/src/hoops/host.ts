import type { PlayerInfo } from '@funfair/shared';
import type { HostView } from '@funfair/shared/client';
import { COURT, ordinal, type FeedEntry, type RacerState, type HoopsHostState } from './logic';
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

export function mountHoopsHost(root: HTMLElement): HostView<HoopsHostState> {
  root.innerHTML = `
    <div class="hp-host">
      <div class="hp-arena">
        <div class="hp-cards"></div>
        <canvas class="hp-overlay"></canvas>
      </div>
      <aside class="hp-side">
        <h2>Hoops Shootout</h2>
        <div class="hp-clock">0:45</div>
        <p class="hp-side-hint">Forty-five seconds, four balls each and they keep coming back. Flick at the hoop: through the net is 2, a clean swish is 3, and the rim, the glass and the cage all play. Most points at the buzzer wins.</p>
        <ol class="hp-feed"></ol>
      </aside>
    </div>`;

  const arena = root.querySelector<HTMLElement>('.hp-arena')!;
  const cardsEl = root.querySelector<HTMLElement>('.hp-cards')!;
  const overlay = root.querySelector<HTMLCanvasElement>('.hp-overlay')!;
  const clockEl = root.querySelector<HTMLElement>('.hp-clock')!;
  const feedEl = root.querySelector<HTMLOListElement>('.hp-feed')!;
  const octx = overlay.getContext('2d')!;

  let state: HoopsHostState | null = null;
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
    el.className = 'hp-card';
    el.style.setProperty('--c', p?.color ?? '#fff');
    el.innerHTML = `
      <div class="hp-card-head">
        <span class="hp-card-avatar">${p?.avatar ?? ''}</span>
        <span class="hp-card-name">${escapeHtml(p?.name ?? '?')}</span>
        <span class="hp-card-rank"></span>
      </div>
      <div class="hp-card-score">0</div>
      <div class="hp-card-stats"><span class="hp-card-made">0/0</span><span class="hp-card-streak"></span></div>
      <canvas class="hp-card-board"></canvas>`;
    c = {
      el,
      score: el.querySelector('.hp-card-score')!,
      pips: el.querySelector('.hp-card-stats')!,
      rank: el.querySelector('.hp-card-rank')!,
      board: el.querySelector('.hp-card-board')!,
      drawn: -1,
      shownScore: 0,
    };
    cards.set(r.playerId, c);
    cardsEl.appendChild(el);
    return c;
  }

  /** A top-down shot chart: the hoop and where every ball came down. */
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
    const depth = COURT.backY + 0.6;
    const scale = Math.min(w / (COURT.halfWidth * 2 + 0.4), h / depth);
    const X = (x: number) => w / 2 + x * scale;
    const Y = (y: number) => h - 4 - (y + 0.3) * scale;
    // Court and the backboard line
    ctx.fillStyle = '#5a3a1e';
    ctx.fillRect(X(-COURT.halfWidth), Y(COURT.backY), COURT.halfWidth * 2 * scale, COURT.backY * scale + 4);
    ctx.fillStyle = '#e9ecf5';
    ctx.fillRect(X(-COURT.boardHalfWidth), Y(COURT.boardY) - 2, COURT.boardHalfWidth * 2 * scale, 3);
    // Rim
    ctx.beginPath();
    ctx.arc(X(0), Y(COURT.hoopY), COURT.rimR * scale, 0, Math.PI * 2);
    ctx.strokeStyle = '#ff7a2a';
    ctx.lineWidth = 3;
    ctx.stroke();
    // Shots: gold for swishes, green for makes, red for misses
    r.shots.forEach((s, i) => {
      const fresh = i === r.shots.length - 1;
      ctx.beginPath();
      ctx.arc(X(s.x), Y(s.y), fresh ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = s.points > 0 ? (s.points >= 3 ? '#ffe74c' : '#5ce07a') : '#ff5c5c';
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
      c.el.classList.toggle('hp-card-lead', i === 0 && r.score > 0);
      c.rank.textContent = state!.phase === 'countdown' ? '' : ordinal(r.rank);
      if (r.score !== c.shownScore) {
        c.shownScore = r.score;
        c.score.textContent = String(r.score);
        c.score.classList.remove('hp-bump');
        void c.score.offsetWidth;
        c.score.classList.add('hp-bump');
      }
      c.pips.querySelector('.hp-card-made')!.textContent = `${r.makes}/${r.attempts}`;
      c.pips.querySelector('.hp-card-streak')!.textContent = r.streak >= 2 ? `🔥 ${r.streak}` : r.bestStreak >= 2 ? `best ${r.bestStreak}` : '';
      if (c.drawn !== r.shots.length) {
        drawBoard(c, r);
        c.drawn = r.shots.length;
      }
      const flash = r.lastScore && state!.raceMs - r.lastScore.at < 900 ? r.lastScore.points : null;
      c.el.style.setProperty('--flash', flash !== null && flash > 0 ? hexToRgba(flash >= 3 ? '#ffe74c' : '#5ce07a', 0.25) : 'transparent');
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
    clockEl.classList.toggle('hp-clock-low', state.phase === 'playing' && secs <= 10);
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
        li.className = 'hp-feed-item';
        li.innerHTML = `<span class="hp-feed-avatar">${p?.avatar ?? ''}</span><span class="hp-feed-name">${escapeHtml(p?.name ?? '?')}</span><span class="hp-feed-result" style="color:${f.points >= 3 ? '#ffe74c' : f.points > 0 ? '#5ce07a' : 'rgba(255,255,255,0.55)'}">${feedLabel(f)}</span>`;
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
  if (f.points === 0) return 'miss';
  return f.swish ? `swish! +${f.points}` : `+${f.points}`;
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
