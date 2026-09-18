import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());

// Node >= 25 ships its own global `localStorage` (Web Storage without a backing file), which shadows jsdom's and
// has no methods. Install a spec-shaped in-memory Storage when that happens; Node 22 (CI) keeps jsdom's.
if (typeof window !== 'undefined' && typeof window.localStorage?.clear !== 'function') {
  class MemoryStorage implements Storage {
    #data = new Map<string, string>();
    get length() {
      return this.#data.size;
    }
    clear() {
      this.#data.clear();
    }
    getItem(key: string) {
      return this.#data.get(String(key)) ?? null;
    }
    key(index: number) {
      return [...this.#data.keys()][index] ?? null;
    }
    removeItem(key: string) {
      this.#data.delete(String(key));
    }
    setItem(key: string, value: string) {
      this.#data.set(String(key), String(value));
    }
  }
  Object.defineProperty(window, 'localStorage', { configurable: true, value: new MemoryStorage() });
}
