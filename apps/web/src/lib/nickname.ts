const KEY = 'anonyma.nickname';
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function randomTag(length = 4): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

/**
 * This browser's nickname: the last one used, or a random "anon-xxxx". Everyone
 * used to start as "anon", so people in one room could not tell each other apart.
 */
export function defaultNickname(): string {
  try {
    const saved = localStorage.getItem(KEY)?.trim();
    if (saved) return saved;
  } catch {
    /* storage blocked: still give a random one */
  }
  const nick = `anon-${randomTag()}`;
  rememberNickname(nick);
  return nick;
}

export function rememberNickname(nickname: string): void {
  const value = nickname.trim();
  if (!value) return;
  try {
    localStorage.setItem(KEY, value);
  } catch {
    /* ignore */
  }
}
