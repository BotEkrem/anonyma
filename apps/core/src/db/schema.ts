import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const roomTypeEnum = pgEnum('room_type', ['public', 'private', 'match']);
export const roomModeEnum = pgEnum('room_mode', ['text', 'voice', 'video']);

export const anonymousSessions = pgTable(
  'anonymous_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Constraint names match the live database (Postgres' own `_key` names).
    sessionHash: varchar('session_hash', { length: 64 })
      .notNull()
      .unique('anonymous_sessions_session_hash_key'),
    reputation: integer('reputation').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('anonymous_sessions_expires_idx').on(table.expiresAt)],
);

export const rooms = pgTable(
  'rooms',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    slug: varchar('slug', { length: 32 }).notNull().unique('rooms_slug_key'),
    type: roomTypeEnum('type').notNull(),
    mode: roomModeEnum('mode').notNull().default('text'),
    inviteHash: varchar('invite_hash', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    index('rooms_type_idx').on(table.type),
    index('rooms_mode_idx').on(table.mode),
    index('rooms_expires_idx').on(table.expiresAt),
  ],
);

export const roomMembers = pgTable(
  'room_members',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    sessionHash: varchar('session_hash', { length: 64 }).notNull(),
    // Sealed AES-GCM blob (plaintext nick still capped at MAX_NICKNAME_LENGTH).
    nickname: varchar('nickname', { length: 128 }).notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('room_members_room_idx').on(table.roomId),
    index('room_members_session_idx').on(table.sessionHash),
    // One row per session per room; a rejoin updates it (see isUniqueViolation).
    uniqueIndex('room_members_room_session_uidx').on(table.roomId, table.sessionHash),
  ],
);

export const moderationEvents = pgTable(
  'moderation_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionHash: varchar('session_hash', { length: 64 }).notNull(),
    roomId: uuid('room_id'),
    action: varchar('action', { length: 32 }).notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('moderation_events_expires_idx').on(table.expiresAt)],
);

export type AnonymousSession = typeof anonymousSessions.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type RoomMember = typeof roomMembers.$inferSelect;
