import { useEffect, useRef } from 'react';
import type { MessageView } from '@anonyma/contracts';
import { REACTION_EMOJIS } from '@anonyma/contracts';
import { Pencil, Reply, Trash2, iconStroke } from '../../ui/icons';
import { shred } from '../../ui/shred';
import PulseHeart from '../../ui/reactbits/PulseHeart';

/** Where the message sits in a run of messages from the same person. */
export interface MessagePlacement {
  stacked: boolean;
  stackStart: boolean;
  stackEnd: boolean;
}

/**
 * One message row: bubble, quote, edited/read marks, the action menu and the
 * reaction chips. Display only; ChatPage owns the state and the handlers.
 */
export function MessageItem({
  m,
  mine,
  seen,
  open,
  placement: { stacked, stackStart, stackEnd },
  isDirect,
  isSelfId,
  onToggleMenu,
  onOpenMenu,
  onReact,
  onReply,
  onEdit,
  onDelete,
  shredding = false,
  onShredDone,
}: {
  m: MessageView;
  mine: boolean;
  /** How many other people have read up to here. */
  seen: number;
  /** The action menu is open on this message. */
  open: boolean;
  placement: MessagePlacement;
  /** A two-person room: read marks are ticks, not counts. */
  isDirect: boolean;
  isSelfId: (id: string) => boolean;
  onToggleMenu: () => void;
  onOpenMenu: () => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** The message reached its time: play the shred, then report back. */
  shredding?: boolean;
  onShredDone?: () => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const doneRef = useRef(onShredDone);
  doneRef.current = onShredDone;

  useEffect(() => {
    const row = rowRef.current;
    const bubble = bubbleRef.current;
    if (!shredding || !row || !bubble) return;
    let reported = false;
    const report = () => {
      if (reported) return;
      reported = true;
      doneRef.current?.();
    };
    void shred(row, bubble)
      .catch(() => undefined)
      .finally(report);
    return () => {
      reported = true;
    };
  }, [shredding]);

  const showRead = mine && !m.deleted && stackEnd;
  const showEdited = Boolean(m.editedAt && !m.deleted);
  const showActions = !m.deleted;
  return (
    <div
      ref={rowRef}
      data-msg-id={m.id}
      className={`msg-row ${shredding ? 'shredding' : ''} ${mine ? 'mine' : ''} ${stacked ? 'stacked' : ''} ${stackStart ? 'stack-start' : ''} ${stackEnd ? 'stack-end' : ''} ${open ? 'menu-open' : ''} ${stackStart ? 'menu-below' : ''}`.trim()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenMenu();
      }}
    >
      {!stacked ? (
        <div className="msg-head">
          <div className="nick">{m.nickname}</div>
        </div>
      ) : null}
      <div className="msg-main">
        <div
          ref={bubbleRef}
          className={`bubble ${mine ? 'mine' : ''} ${m.deleted ? 'deleted' : ''}`.trim()}
          // Focusable so the actions (react, reply, edit, delete) work from the
          // keyboard too: Enter or Space opens them, Escape closes them.
          tabIndex={m.deleted ? undefined : 0}
          aria-haspopup={m.deleted ? undefined : 'true'}
          onClick={(e) => {
            if (m.deleted) return;
            e.stopPropagation();
            onToggleMenu();
          }}
          onKeyDown={(e) => {
            if (m.deleted) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggleMenu();
            }
          }}
        >
          {m.replyToId && !m.deleted ? (
            <div className="reply-quote">{m.replyPreview || 'Original message'}</div>
          ) : null}
          <div className="body">{m.deleted ? 'This message was deleted' : m.content}</div>
        </div>
        {showEdited || showRead ? (
          <div className="msg-meta">
            {showEdited ? <span className="edited-mark">edited</span> : null}
            {showRead ? (
              <span
                className={`read-mark ${seen > 0 ? 'seen' : ''}`.trim()}
                title={seen ? 'Seen' : 'Sent'}
              >
                {isDirect ? (seen > 0 ? '✓✓' : '✓') : seen > 0 ? `Seen · ${seen}` : '✓'}
              </span>
            ) : null}
          </div>
        ) : null}
        {showActions ? (
          <div
            className="msg-actions"
            role="toolbar"
            aria-label="Message actions"
            onClick={(e) => e.stopPropagation()}
          >
            {REACTION_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="msg-action"
                title={emoji}
                aria-label={`React ${emoji}`}
                onClick={() => onReact(emoji)}
              >
                <span aria-hidden="true">{emoji}</span>
              </button>
            ))}
            <span className="msg-actions-sep" aria-hidden="true" />
            <button
              type="button"
              className="msg-action"
              title="Reply"
              aria-label="Reply"
              onClick={onReply}
            >
              <Reply aria-hidden="true" strokeWidth={iconStroke} />
            </button>
            {mine ? (
              <>
                <button
                  type="button"
                  className="msg-action"
                  title="Edit"
                  aria-label="Edit"
                  onClick={onEdit}
                >
                  <Pencil aria-hidden="true" strokeWidth={iconStroke} />
                </button>
                <button
                  type="button"
                  className="msg-action danger"
                  title="Delete"
                  aria-label="Delete"
                  onClick={onDelete}
                >
                  <Trash2 aria-hidden="true" strokeWidth={iconStroke} />
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      {!m.deleted && Object.keys(m.reactions).length > 0 ? (
        <div className="reaction-row">
          {Object.entries(m.reactions).map(([emoji, ids]) =>
            emoji === '❤️' ? (
              // The heart reaction is the one that pulses (React Bits Pulse Heart).
              <PulseHeart
                key={emoji}
                className="reaction-heart"
                liked={ids.some(isSelfId)}
                count={ids.length}
                size={15}
                pillColor="var(--canvas)"
                idleColor="var(--ink-soft)"
                likedColor="var(--danger)"
                textColor="var(--ink)"
                label="React ❤️"
                onChange={() => onReact(emoji)}
              />
            ) : (
              <button
                key={emoji}
                type="button"
                className={`reaction-chip ${ids.some(isSelfId) ? 'active' : ''}`.trim()}
                onClick={(e) => {
                  e.stopPropagation();
                  onReact(emoji);
                }}
              >
                {emoji} {ids.length}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
