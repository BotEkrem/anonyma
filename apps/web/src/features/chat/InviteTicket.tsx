import { useEffect, useRef, useState } from 'react';
import TearTicket from '../../ui/reactbits/TearTicket';
import { Scissors, iconStroke } from '../../ui/icons';

/**
 * A private room waiting for someone: the invite is a ticket, and pulling its
 * stub (or Enter / Space on it) copies the link. A fresh ticket comes back
 * after a moment so it can be copied again.
 */
export default function InviteTicket({
  code,
  onCopy,
}: {
  code: string;
  /** Resolves true when the link reached the clipboard. */
  onCopy: () => Promise<boolean>;
}) {
  const [round, setRound] = useState(0);
  const [torn, setTorn] = useState(false);
  const [copied, setCopied] = useState<boolean | null>(null);
  const roundRef = useRef(round);
  roundRef.current = round;

  useEffect(() => {
    if (!torn) return;
    const id = window.setTimeout(() => {
      setTorn(false);
      setCopied(null);
      setRound((r) => r + 1);
    }, 2600);
    return () => window.clearTimeout(id);
  }, [torn]);

  return (
    <div className="invite-ticket">
      <TearTicket
        key={round}
        width={420}
        height={150}
        stubSize={112}
        radius={18}
        holes={9}
        holeSize={5}
        rotate={3}
        tiltMax={6}
        background="var(--surface-overlay)"
        stubBackground="var(--accent-tint)"
        color="var(--ink)"
        borderColor="var(--line)"
        ariaLabel={`Copy the invite link (code ${code})`}
        // The copy starts inside the gesture (Safari's rule); the hint changes
        // once the stub has dropped.
        onTorn={() => {
          const mine = round;
          setCopied(null);
          void onCopy().then((ok) => {
            // A result that lands after the ticket was replaced is not this ticket's.
            if (roundRef.current === mine) setCopied(ok);
          });
        }}
        onTear={() => setTorn(true)}
        stub={
          <span className="invite-ticket-stub">
            <Scissors aria-hidden="true" strokeWidth={iconStroke} />
            <span>Copy link</span>
          </span>
        }
      >
        <div className="invite-ticket-body">
          <span className="invite-ticket-label">Private room invite</span>
          <span className="invite-ticket-code">{code}</span>
          <span className="invite-ticket-hint">
            {!torn
              ? 'Pull the stub to copy the link'
              : copied === false
                ? 'Could not copy. Use the address bar.'
                : copied
                  ? 'Link copied'
                  : 'Copying…'}
          </span>
        </div>
      </TearTicket>
    </div>
  );
}
