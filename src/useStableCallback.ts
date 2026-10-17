import { useCallback, useInsertionEffect, useRef } from "react";

/** Keep renderer callbacks current before child layout effects without changing their identity. */
export function useStableCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result): (...args: Args) => Result {
  const latest = useRef(callback);
  // Pierre renders in a child layout effect; a parent layout effect would update too late.
  useInsertionEffect(() => { latest.current = callback; });
  return useCallback((...args: Args) => latest.current(...args), []);
}
