/**
 * What the page and the services agree on: API views, limits and error codes.
 * It reaches only files that import nothing (no Node modules, no decorators),
 * so the web app compiles it straight from source (alias `@anonyma/contracts`
 * in apps/web/vite.config.ts and tsconfig.json). Keep it that way.
 */
export * from './model/types';
export {
  INVITE_CODE_LENGTH,
  MATCH_QUEUE_TTL_SECONDS,
  MAX_MESSAGE_LENGTH,
  MAX_NICKNAME_LENGTH,
  MESSAGE_TTL_SECONDS,
  MIN_NICKNAME_LENGTH,
  REACTION_EMOJIS,
  type ReactionEmoji,
} from './model/constants';
export { ErrorCodes, type ErrorCode } from './model/error-codes';
