import type { RefObject } from 'react';
import type { MessageView } from '@anonyma/contracts';
import { MAX_MESSAGE_LENGTH } from '@anonyma/contracts';
import ClickSpark from '../../ui/reactbits/ClickSpark';
import PromptBar from '../../ui/reactbits/PromptBar';

/** The accent as a colour value (the sparks draw on a canvas, which can't read CSS variables). */
function accentColor(): string {
  if (typeof document === 'undefined') return '#a3520f';
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#a3520f'
  );
}

/**
 * The message box with its error line and the "Editing / Replying to" bar.
 * Display only; ChatPage owns the text, the edit/reply state and sending.
 */
export function Composer({
  error,
  editing,
  replyTo,
  text,
  disabled,
  inputRef,
  onTextChange,
  onSubmit,
  onCancelContext,
  onBlur,
}: {
  error: string | null;
  editing: MessageView | null;
  replyTo: MessageView | null;
  text: string;
  /** No one left to talk to (a two-person room the other person left). */
  disabled: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onTextChange: (value: string) => void;
  onSubmit: () => void;
  /** Leave edit / reply mode. */
  onCancelContext: () => void;
  onBlur: () => void;
}) {
  return (
    <>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      {replyTo || editing ? (
        <div className="composer-context">
          <div>
            <strong>{editing ? 'Editing' : 'Replying to'}</strong>
            <span className="muted">
              {' '}
              {editing
                ? editing.content.slice(0, 80)
                : replyTo?.deleted
                  ? 'deleted message'
                  : replyTo?.content.slice(0, 80)}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-compact"
            onClick={() => {
              onCancelContext();
              inputRef.current?.focus();
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}

      {/* React Bits Prompt Bar: grows with the text, Enter sends and Shift+Enter
          starts a new line; the send glyph turns into a tick while editing. */}
      <div className="composer">
        <label className="sr-only" htmlFor="chat-composer">
          Message
        </label>
        <PromptBar
          id="chat-composer"
          className="composer-bar"
          inputRef={inputRef}
          value={text}
          onChange={onTextChange}
          onSubmit={onSubmit}
          mode={editing ? 'save' : 'send'}
          onKeyDown={(e) => {
            // Escape leaves edit / reply mode.
            if (e.key === 'Escape' && (editing || replyTo)) {
              e.preventDefault();
              onCancelContext();
            }
          }}
          onBlur={onBlur}
          placeholder={editing ? 'Edit your message…' : 'Write something that will disappear…'}
          maxLength={MAX_MESSAGE_LENGTH}
          disabled={disabled}
          background="var(--surface-sunken)"
          color="var(--ink)"
          sendColor="var(--accent)"
          sendInk="var(--on-accent)"
          radius={24}
          maxRows={5}
          // Sending throws a few sparks in the accent (React Bits Click Spark);
          // Enter sends through the button, so it sparks too.
          wrapSend={(button) => (
            <ClickSpark
              style={{ width: 'auto', height: 'auto', display: 'inline-flex', flexShrink: 0 }}
              sparkColor={accentColor()}
              sparkCount={10}
              sparkRadius={22}
              sparkSize={9}
              duration={420}
              disabled={!text.trim() || disabled}
            >
              {button}
            </ClickSpark>
          )}
        />
      </div>
    </>
  );
}
