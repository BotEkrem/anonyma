declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement | string,
        opts: {
          sitekey: string;
          callback?: (token: string) => void;
          'error-callback'?: () => void;
          'expired-callback'?: () => void;
          theme?: 'auto' | 'light' | 'dark';
          size?: 'normal' | 'compact' | 'flexible';
          appearance?: 'always' | 'execute' | 'interaction-only';
        },
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
      getResponse: (widgetId?: string) => string;
    };
  }
}

let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) {
    return Promise.resolve();
  }
  if (scriptPromise) {
    return scriptPromise;
  }
  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-anonyma-turnstile]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Turnstile script failed')));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.dataset.anonymaTurnstile = '1';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Turnstile script failed'));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export type TurnstileWidget = {
  /** Takes the widget down; call while its host is still in the document. */
  remove: () => void;
  /** Asks this widget for a fresh token. */
  reset: () => void;
};

export async function renderTurnstile(
  host: HTMLElement,
  siteKey: string,
  onToken: (token: string | null) => void,
): Promise<TurnstileWidget> {
  await loadTurnstileScript();
  host.replaceChildren();
  const theme =
    document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const widgetId = window.turnstile!.render(host, {
    sitekey: siteKey,
    theme,
    // Always shown: the site is a showcase, and the Cloudflare box says what
    // guards it. Phones under 360px get the compact box (the normal one is
    // 300px wide and would run past a 320px screen's margins).
    appearance: 'always',
    size: window.innerWidth < 360 ? 'compact' : 'normal',
    callback: (token) => onToken(token),
    'error-callback': () => onToken(null),
    'expired-callback': () => onToken(null),
  });
  return {
    remove: () => {
      try {
        window.turnstile?.remove(widgetId);
      } catch {
        /* ignore */
      }
      host.replaceChildren();
    },
    reset: () => {
      try {
        window.turnstile?.reset(widgetId);
      } catch {
        /* ignore */
      }
    },
  };
}
