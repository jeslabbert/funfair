import type { GameResults, PlayerInfo } from '@funfair/shared';

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((ev: Event) => void)> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, '').toLowerCase(), v);
    else if (typeof v === 'boolean') {
      if (v) el.setAttribute(k, '');
    } else if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function playerChip(p: PlayerInfo, opts: { large?: boolean; me?: boolean } = {}): HTMLElement {
  return h(
    'div',
    {
      class: `chip${opts.large ? ' chip-large' : ''}${p.connected ? '' : ' chip-away'}${opts.me ? ' chip-me' : ''}`,
      style: `--c:${p.color}`,
    },
    h('span', { class: 'chip-avatar' }, p.avatar),
    h('span', { class: 'chip-name' }, p.name),
    p.isVip ? h('span', { class: 'chip-vip', title: 'VIP – starts the games' }, '👑') : null,
  );
}

export function standingsList(results: GameResults, players: PlayerInfo[], meId?: string): HTMLElement {
  const byId = new Map(players.map((p) => [p.id, p]));
  return h(
    'ol',
    { class: 'standings' },
    ...results.standings.map((s, i) => {
      const p = byId.get(s.playerId);
      return h(
        'li',
        { class: `standing${i === 0 ? ' standing-winner' : ''}${s.playerId === meId ? ' standing-me' : ''}`, style: `--c:${p?.color ?? '#fff'}` },
        h('span', { class: 'standing-place' }, i === 0 ? '🏆' : `${i + 1}`),
        h('span', { class: 'standing-avatar' }, p?.avatar ?? ''),
        h('span', { class: 'standing-name' }, p?.name ?? 'Player'),
        h('span', { class: 'standing-label' }, s.label),
      );
    }),
  );
}

export function statusPill(status: 'connecting' | 'open' | 'closed'): HTMLElement {
  const text = status === 'open' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  return h('div', { class: `status status-${status}` }, text);
}
