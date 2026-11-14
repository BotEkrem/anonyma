import { useEffect, useState } from 'react';
import { slideCommit } from '../../ui/pieces';

const PHONE = '(max-width: 640px)';
// On phones the slide sits between the brand and the theme switch, which leave
// less room the narrower the screen: 100px from 381px up, then shorter so it
// never runs into the switch (a 320px screen has about 80px for it).
const NARROW = '(max-width: 380px)';
const NARROWEST = '(max-width: 340px)';

function useMatch(query: string): boolean {
  const [match, setMatch] = useState(
    () => typeof window !== 'undefined' && (window.matchMedia?.(query).matches ?? false),
  );
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return undefined;
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

/**
 * End session in the header: slide the grip to the end (or press → / End) to
 * confirm (React Bits Slide Commit). `onEnd` ends the session; `onEnded` runs a
 * moment after the tick shows, to leave the page. The plain button shows until
 * the piece has loaded, and stays if it cannot load.
 */
export function EndSessionSlide({
  onEnd,
  onEnded,
}: {
  onEnd: () => Promise<void>;
  onEnded: () => void;
}) {
  const phone = useMatch(PHONE);
  const narrow = useMatch(NARROW);
  const narrowest = useMatch(NARROWEST);
  const phoneWidth = narrowest ? 72 : narrow ? 88 : 100;
  useEffect(() => {
    void slideCommit.preload();
  }, []);
  return (
    <slideCommit.Piece
      fallback={
        <button
          type="button"
          className="btn btn-ghost btn-compact nav-logout"
          onClick={() => void onEnd().then(onEnded)}
        >
          End session
        </button>
      }
      className="end-slide"
      label={phone ? 'End' : 'End session'}
      ariaLabel="End session"
      doneLabel="Ended"
      errorLabel="Try again"
      width={phone ? phoneWidth : 170}
      height={40}
      radius={20}
      trackColor="var(--surface-sunken)"
      handleColor="var(--canvas)"
      handleInk="var(--ink)"
      successColor="var(--danger)"
      successInk="var(--canvas)"
      dangerColor="var(--danger)"
      dangerInk="var(--canvas)"
      holdMs={1500}
      onConfirm={onEnd}
      onDone={() => window.setTimeout(onEnded, 650)}
    />
  );
}
