export type RoomType = 'public' | 'private' | 'match';

/** Random-match queues — text / voice / video are separate pools. */
export const MATCH_MODES = ['text', 'voice', 'video'] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

export interface AnonymousSessionView {
  id: string;
  createdAt: string;
  expiresAt: string;
}

export interface RoomView {
  id: string;
  slug: string;
  type: RoomType;
  /** Communication layer: text-only, voice+text, or video+text. */
  mode: MatchMode;
  inviteCode?: string;
  memberCount: number;
  createdAt: string;
  expiresAt?: string | null;
  /** This session's per-room pseudonym; only on a member's own room read. */
  selfId?: string;
}

export interface RoomMemberView {
  /** The member's per-room pseudonym (the same id messages, reads and events use). */
  sessionId: string;
  nickname: string;
  joinedAt: string;
  /** True for the session that asked. Identity is the session, never the nickname. */
  isSelf?: boolean;
}

/** sessionId → last-read messageId */
export type RoomReadMap = Record<string, string>;

export interface MessageView {
  id: string;
  roomId: string;
  /** The author's per-room pseudonym (compare with RoomView.selfId). */
  senderSessionId: string;
  nickname: string;
  content: string;
  createdAt: string;
  expiresAt: string;
  replyToId?: string;
  replyPreview?: string;
  reactions: Record<string, string[]>;
  editedAt?: string | null;
  deleted?: boolean;
}

export interface MatchPairView {
  roomId: string;
  inviteCode?: string;
  peerNickname: string;
  mode: MatchMode;
}
