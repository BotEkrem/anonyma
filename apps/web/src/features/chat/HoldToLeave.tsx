import HoldButton from '../../ui/reactbits/HoldButton';

/**
 * Leaving a room is a hold, not a dialog: the button fills while pressed
 * (mouse, touch, or Enter / Space held) and snaps back if released early.
 */
export function HoldToLeave({ onLeave }: { onLeave: () => void | Promise<void> }) {
  return (
    <HoldButton
      className="hold-leave"
      size="md"
      holdTime={1000}
      radius={16}
      glow={false}
      backgroundColor="var(--canvas)"
      fillColor="var(--danger)"
      textColor="var(--ink)"
      fillTextColor="var(--canvas)"
      doneLabel="Leaving"
      onHold={() => void onLeave()}
    >
      Hold to leave
    </HoldButton>
  );
}
