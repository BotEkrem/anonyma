import { useCallback, useEffect, useRef, useState } from 'react';
import { getPublicConfig } from '../api/client';
import { renderTurnstile, type TurnstileWidget } from './turnstile';

type UseTurnstileOptions = {
  /** When false, skip widget load (session already exists / page does not need challenge). */
  enabled?: boolean;
};

export function useTurnstile(opts?: UseTurnstileOptions) {
  const enabled = opts?.enabled !== false;
  const tokenRef = useRef<string | null>(null);
  const readyRef = useRef(false);
  const requiredRef = useRef(false);
  const configuredRef = useRef(false);
  const [token, setToken] = useState<string | null>(null);
  const [required, setRequired] = useState(false);
  const [ready, setReady] = useState(!enabled);
  const [error, setError] = useState<string | null>(null);
  /** The element the widget lives in; pages may swap it when their layout changes. */
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const hostElRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<TurnstileWidget | undefined>(undefined);
  /** The current token went out with a request; the next take needs a fresh one. */
  const spentRef = useRef(false);

  const dropWidget = useCallback(() => {
    widgetRef.current?.remove();
    widgetRef.current = undefined;
  }, []);

  // Callback ref: React detaches it before taking the element out of the
  // document, so the widget is removed while Turnstile can still find it.
  // Removing it later (a passive cleanup, or a page that re-renders its slot
  // in another layout) made Turnstile warn "Cannot find Widget …".
  const hostRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (el === hostElRef.current) {
        return;
      }
      if (hostElRef.current) {
        dropWidget();
      }
      hostElRef.current = el;
      setHost(el);
    },
    [dropWidget],
  );

  useEffect(() => {
    let disposed = false;

    configuredRef.current = false;
    tokenRef.current = null;
    readyRef.current = false;
    spentRef.current = false;
    setToken(null);
    setError(null);

    if (!enabled) {
      requiredRef.current = false;
      setRequired(false);
      readyRef.current = true;
      setReady(true);
      configuredRef.current = true;
      return;
    }

    setReady(false);

    void (async () => {
      try {
        const cfg = await getPublicConfig();
        if (disposed) {
          return;
        }
        if (!cfg.turnstileRequired) {
          requiredRef.current = false;
          setRequired(false);
          readyRef.current = true;
          setReady(true);
          configuredRef.current = true;
          return;
        }
        if (!cfg.turnstileSiteKey) {
          requiredRef.current = true;
          setRequired(true);
          configuredRef.current = true;
          setError('Verification is required but not configured');
          return;
        }
        requiredRef.current = true;
        setRequired(true);
        if (!host) {
          // Runs again once the page mounts its slot.
          return;
        }
        const widget = await renderTurnstile(host, cfg.turnstileSiteKey, (next) => {
          tokenRef.current = next;
          readyRef.current = Boolean(next);
          if (next) spentRef.current = false;
          setToken(next);
          setReady(Boolean(next));
        });
        // Host swapped or page left while the script was loading.
        if (disposed || hostElRef.current !== host) {
          widget.remove();
          return;
        }
        widgetRef.current = widget;
        configuredRef.current = true;
      } catch (err) {
        if (!disposed) {
          configuredRef.current = true;
          setError((err as Error).message);
        }
      }
    })();

    return () => {
      disposed = true;
      dropWidget();
    };
  }, [enabled, host, dropWidget]);

  async function waitConfigured(timeoutMs = 30_000): Promise<void> {
    if (configuredRef.current) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const id = window.setInterval(() => {
        if (configuredRef.current) {
          window.clearInterval(id);
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          window.clearInterval(id);
          reject(new Error('Verification is taking too long'));
        }
      }, 50);
    });
  }

  async function waitReady(timeoutMs = 120_000): Promise<void> {
    await waitConfigured(Math.min(timeoutMs, 30_000));
    if (!requiredRef.current) {
      return;
    }
    if (readyRef.current) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const id = window.setInterval(() => {
        if (readyRef.current) {
          window.clearInterval(id);
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          window.clearInterval(id);
          reject(new Error('Complete the verification challenge'));
        }
      }, 100);
    });
  }

  async function takeToken(): Promise<string | undefined> {
    await waitConfigured();
    if (!requiredRef.current) {
      return undefined;
    }
    if (spentRef.current) {
      // Ask for a fresh token when one is needed, not the moment the last one
      // went out: the page usually navigates right after (create / join), and
      // a reset still running when the widget was removed made Turnstile warn.
      spentRef.current = false;
      tokenRef.current = null;
      readyRef.current = false;
      setToken(null);
      setReady(false);
      widgetRef.current?.reset();
    }
    await waitReady();
    const value = tokenRef.current;
    if (!value) {
      throw new Error('Complete the verification challenge');
    }
    tokenRef.current = null;
    spentRef.current = true;
    return value;
  }

  return { hostRef, token, required, ready: required ? ready : true, error, takeToken, waitReady };
}
