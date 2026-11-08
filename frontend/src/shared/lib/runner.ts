import { useCallback, useRef, useState } from 'react';

/**
 * Runs one async action at a time. While running, `busy` is true (every button disables).
 * Errors are reported through `onError` and kept in `error`, like the original run()/work().
 */
export function useAsyncRunner(onError: (error: Error & { status?: number }) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);
  const run = useCallback(async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await action();
    } catch (e) {
      const err = e as Error & { status?: number };
      setError(err.message);
      onError(err);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [onError]);
  return { busy, error, setError, run };
}
