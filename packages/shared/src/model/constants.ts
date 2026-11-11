export const MESSAGE_TTL_SECONDS = 600;
/** After the last member leaves, keep the room joinable this long (WS blips ≠ leave). */
export const EMPTY_ROOM_GRACE_SECONDS = 90;
export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_NICKNAME_LENGTH = 24;
export const MIN_NICKNAME_LENGTH = 2;
export const SESSION_TTL_SECONDS = 86_400;
/** Characters in a private room's invite code (the join form accepts 4–24). */
export const INVITE_CODE_LENGTH = 12;
export const RATE_LIMIT_MESSAGES_PER_MINUTE = 30;
export const RATE_LIMIT_ROOMS_PER_HOUR = 10;
export const RATE_LIMIT_WS_TICKETS_PER_MINUTE = 30;
export const RATE_LIMIT_READS_PER_MINUTE = 60;
export const MATCH_QUEUE_TTL_SECONDS = 600;
export const REPLY_PREVIEW_MAX = 120;

export const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '👏'] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export const RMQ_EXCHANGE = 'anonyma.events';
export const CORE_RPC_QUEUE = 'core.rpc';
export const MATCH_RPC_QUEUE = 'match.rpc';

/** Longest a service waits to hand an event to RabbitMQ before giving up on it. */
export const BUS_PUBLISH_TIMEOUT_MS = 5_000;

/** A matched pair's room lives this long before activity extends it. */
export const MATCH_ROOM_TTL_SECONDS = 30 * 60;
