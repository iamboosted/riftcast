/** localStorage wrapper: every access is guarded (Safari private mode, blocked storage, quota). */
export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`riftcast:${key}`);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return typeof fallback === 'object' && fallback !== null && !Array.isArray(fallback) ? { ...fallback, ...v } : (v as T);
  } catch {
    return fallback;
  }
}

export function save<T>(key: string, value: T): void {
  try {
    localStorage.setItem(`riftcast:${key}`, JSON.stringify(value));
  } catch {
    /* storage unavailable: progress is session-only */
  }
}
