/** Registers the service worker in production builds only. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('sw registration failed', err));
  });
}

let wakeLock: WakeLockSentinel | null = null;

/** Keeps the phone screen on while a game is running. Best effort. */
export async function holdWakeLock(hold: boolean): Promise<void> {
  try {
    if (hold && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!hold && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    /* not available (e.g. low battery) */
  }
}
