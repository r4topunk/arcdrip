'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';

/** False during the static render and the first client render, true after mount (avoids hydration mismatches). */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/**
 * Seconds to add to the local clock to get the chain's clock (latest block timestamp minus local time). Accrual
 * is decided by `block.timestamp`, so the ticking claimable follows the chain when the two disagree. 0 by default.
 */
export const ClockOffsetContext = createContext(0);

/**
 * Current time in unix seconds on the chain's clock, as a bigint, updated once a second.
 *
 * PRD 6 asks for a value that ticks with `requestAnimationFrame` throttled to 1 Hz rather than a bare interval:
 * the frame loop is what keeps a background tab from queueing work, and the second only advances when the wall
 * clock says it has, so the number never jumps twice in the same second or stalls after a long throttle.
 *
 * Null until mounted, so the static HTML and the first client render agree.
 */
export function useNow(): bigint | null {
  const [now, setNow] = useState<bigint | null>(null);
  const offset = useContext(ClockOffsetContext);
  const last = useRef(-1);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      const seconds = Math.floor(Date.now() / 1000);
      if (seconds !== last.current) {
        last.current = seconds;
        setNow(BigInt(seconds));
      }
    };
    const tick = () => {
      update();
      frame = requestAnimationFrame(tick);
    };
    // A hidden tab gets no frames; this keeps the value fresh for when it comes back and for jsdom, which has
    // requestAnimationFrame but no real paint loop.
    const interval = setInterval(update, 1_000);
    update();
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(interval);
    };
  }, []);

  return now === null ? null : now + BigInt(offset);
}
