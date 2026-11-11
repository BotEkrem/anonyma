/**
 * The message list as pure functions: what each realtime frame and each fetch
 * does to it. ChatPage keeps the side effects (toasts, resync, timers, typing)
 * and only hands these the list. Type-only imports, so `node --test` can run
 * the tests without the bundler's alias.
 */
import type { MessageView, RoomMemberView, RoomReadMap } from '@anonyma/contracts';

export function normalizeMessage(raw: MessageView): MessageView {
  return {
    ...raw,
    reactions: raw.reactions ?? {},
    deleted: Boolean(raw.deleted),
    editedAt: raw.editedAt ?? null,
  };
}

/**
 * Merge a fresh "latest page" into what is on screen: pages loaded with
 * "Load earlier" stay, the overlapping range takes the server's version
 * (edits, deletions). Replacing the list dropped those older pages.
 */
export function mergeLatest(
  prev: MessageView[],
  fresh: MessageView[],
  now: number = Date.now(),
): MessageView[] {
  if (fresh.length === 0) {
    return prev.filter((m) => !m.expiresAt || new Date(m.expiresAt).getTime() > now);
  }
  const oldestFresh = fresh[0]!.id;
  const newestFresh = fresh[fresh.length - 1]!.id;
  const freshIds = new Set(fresh.map((m) => m.id));
  const older = prev.filter((m) => m.id < oldestFresh);
  // Messages that arrived over the socket after the server answered this page
  // stay too: dropping them lost exactly the message the fetch was meant to save.
  const newer = prev.filter((m) => m.id > newestFresh && !freshIds.has(m.id));
  return [...older, ...fresh, ...newer];
}

/** The member is this browser's session (server flag; nickname only for old servers). */
export function isSelfMember(m: RoomMemberView, nickname: string): boolean {
  return m.isSelf ?? m.nickname === nickname;
}

/** How many other people have read up to (or past) this message. */
export function peerSeenCount(
  message: MessageView,
  isSelfId: (id: string) => boolean,
  reads: RoomReadMap,
): number {
  let n = 0;
  for (const [sid, lastId] of Object.entries(reads)) {
    if (isSelfId(sid)) continue;
    if (lastId >= message.id) n += 1;
  }
  return n;
}

/** A `message` frame: appended once (the sender also has it from its POST answer). */
export function applyNewMessage(prev: MessageView[], raw: MessageView): MessageView[] {
  const msg = normalizeMessage(raw);
  return prev.some((m) => m.id === msg.id) ? prev : [...prev, msg];
}

/** The quote shown on replies to an edited parent. */
export function replyPreviewOf(msg: MessageView): string {
  if (msg.deleted) return 'Message deleted';
  return msg.content.length > 120 ? `${msg.content.slice(0, 120)}…` : msg.content;
}

/**
 * A `message_updated` or `message_deleted` frame: the message is replaced, and
 * replies to it get their quote patched (the server's own fan-out to them can
 * arrive later).
 */
export function applyMessageChange(
  prev: MessageView[],
  raw: MessageView,
  kind: 'message_updated' | 'message_deleted',
): MessageView[] {
  const msg = normalizeMessage(raw);
  const next = prev.map((m) => (m.id === msg.id ? msg : m));
  if (kind === 'message_updated' && msg.content != null && !msg.replyToId) {
    const preview = replyPreviewOf(msg);
    return next.map((m) => (m.replyToId === msg.id ? { ...m, replyPreview: preview } : m));
  }
  if (kind === 'message_deleted') {
    return next.map((m) =>
      m.replyToId === msg.id ? { ...m, replyPreview: 'Message deleted' } : m,
    );
  }
  return next;
}

/** A `reaction` frame: the message's reactions are replaced as a whole. */
export function applyReaction(
  prev: MessageView[],
  messageId: string,
  reactions: Record<string, string[]>,
): MessageView[] {
  return prev.map((m) => (m.id === messageId ? { ...m, reactions } : m));
}
