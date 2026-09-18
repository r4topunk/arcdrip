// localStorage can be missing (server render), disabled (private mode, blocked site data) or throw on any access,
// including reading the `window.localStorage` getter itself. Every access goes through these helpers.

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function safeGet(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Returns true only when the value was written. */
export function safeSet(key: string, value: string): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeRemove(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // Nothing to do: storage is unavailable.
  }
}
