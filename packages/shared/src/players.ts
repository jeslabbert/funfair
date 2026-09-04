export const MAX_PLAYERS = 8;
export const MAX_NAME_LENGTH = 12;

export const PLAYER_COLORS = [
  '#ff5c5c', // red
  '#ffb547', // orange
  '#ffe74c', // yellow
  '#5ce07a', // green
  '#4fc3f7', // sky
  '#7c83ff', // indigo
  '#e57cff', // purple
  '#ff8ac2', // pink
] as const;

export const PLAYER_AVATARS = ['🐎', '🦄', '🐢', '🐇', '🦊', '🐸', '🐙', '🦖'] as const;

export function sanitizeName(raw: string): string | null {
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return name.length > 0 ? name : null;
}
