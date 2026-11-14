import { INVITE_CODE_LENGTH } from '@anonyma/contracts';

import { codeSlots } from '../../ui/pieces';

// The code slots load on their own (the lobby preloads them); until then the
// plain field does the same job.

/** The 12-character invite code: one slot per character, paste and autofill work. */
export function InviteCodeInput({
  value,
  onChange,
  invalid,
}: {
  value: string;
  onChange: (code: string) => void;
  invalid: boolean;
}) {
  const fallback = (
    <input
      id="invite"
      value={value}
      placeholder="ABCD2345EFGH"
      maxLength={INVITE_CODE_LENGTH}
      onChange={(e) => onChange(e.target.value.toUpperCase())}
    />
  );
  return (
    <codeSlots.Piece
      fallback={fallback}
      className="invite-slots"
      length={INVITE_CODE_LENGTH}
      value={value}
      onChange={onChange}
      status={invalid ? 'error' : 'idle'}
      slotSize={24}
      gap={3}
      radius={8}
      accentColor="var(--accent)"
      inkColor="var(--ink)"
      slotColor="var(--surface-sunken)"
      digitColor="var(--ink)"
      dangerColor="var(--danger)"
      ariaLabel="Invite code"
    />
  );
}
