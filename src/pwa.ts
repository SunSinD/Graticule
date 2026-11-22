export function registerPwa(): void {
  if (!import.meta.env.PROD || typeof window === 'undefined' || typeof navigator === 'undefined') return;
  if (location.protocol === 'file:' || !('serviceWorker' in navigator)) return;

  try {
    void navigator.serviceWorker.register('./sw.js')
      .then((registration) => registration.update().catch(() => undefined))
      .catch(() => undefined);
  } catch {
    // Service workers are unavailable in some private or restricted contexts.
  }
}
