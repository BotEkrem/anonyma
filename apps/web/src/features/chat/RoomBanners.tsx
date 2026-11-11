import type { RoomMemberView } from '@anonyma/contracts';

/** "Who's here": the members, with the online count when it differs. */
export function WhoHere({
  members,
  online,
  isSelf,
}: {
  members: RoomMemberView[];
  online: number;
  isSelf: (m: RoomMemberView) => boolean;
}) {
  return (
    <details className="who-here">
      <summary>
        Who&apos;s here · {members.length}
        {online > 0 && online !== members.length ? ` · ${online} online` : ''}
      </summary>
      <ul>
        {members.map((m) => (
          <li key={m.sessionId}>
            {m.nickname}
            {isSelf(m) ? ' (you)' : ''}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The other person of a two-person room left. */
export function PeerLeftBanner({
  isMatch,
  onFindNext,
  onLeave,
}: {
  isMatch: boolean;
  onFindNext: () => void;
  onLeave: () => void;
}) {
  return (
    <div className="peer-left-banner" role="status">
      <div>
        <strong>Peer left</strong>
        <p className="muted">
          {isMatch
            ? 'This match ended. Find someone new or leave.'
            : 'They left this private room. Invite is rotated — share the new code if you want them back.'}
        </p>
      </div>
      <div className="cta-row">
        {isMatch ? (
          <button type="button" className="btn btn-primary" onClick={onFindNext}>
            Find next
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost" onClick={onLeave}>
          Leave
        </button>
      </div>
    </div>
  );
}

/** A match whose other person has no live connection right now. */
export function PeerAbsentBanner({ onFindNext }: { onFindNext: () => void }) {
  return (
    <div className="peer-left-banner soft" role="status">
      <div>
        <strong>Your match isn&apos;t connected</strong>
        <p className="muted">
          They may have closed the page. You can wait a little or find someone new.
        </p>
      </div>
      <div className="cta-row">
        <button type="button" className="btn btn-primary" onClick={onFindNext}>
          Find next
        </button>
      </div>
    </div>
  );
}
