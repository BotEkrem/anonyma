/**
 * The microphone's keyboard shortcut: the pure part (the call's key listener,
 * the settings' key recorder and the tests use it).
 *
 * - Toggle: a press mutes or unmutes.
 * - Push to talk: the microphone is muted, and open while the key is held.
 *
 * Keys are matched by their physical place (KeyboardEvent.code), so a Turkish
 * or any other layout works; the label shows what the key types (key).
 * A browser only hears keys while its tab is in front: there is no global
 * shortcut for a web page.
 */
export type MicShortcutMode = 'toggle' | 'hold';
export const MIC_MODE_PREF_KEY = 'anonyma.micShortcutMode';
export const MIC_KEY_PREF_KEY = 'anonyma.micShortcutKey';

export interface KeyBinding {
  /** KeyboardEvent.code: where the key is. */
  code: string;
  /** KeyboardEvent.key when it was chosen: what it types, for the label. */
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export const DEFAULT_BINDING: KeyBinding = {
  code: 'KeyM',
  key: 'm',
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
};

/** The parts of a KeyboardEvent this file reads. */
export interface KeyLike {
  code: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export function parseMicMode(raw: string | null | undefined): MicShortcutMode {
  return raw === 'hold' ? 'hold' : 'toggle';
}

export function parseBinding(raw: string | null | undefined): KeyBinding {
  if (!raw) return DEFAULT_BINDING;
  try {
    const b = JSON.parse(raw) as Partial<KeyBinding>;
    if (typeof b.code !== 'string' || !b.code || MODIFIER_CODES.has(b.code)) return DEFAULT_BINDING;
    const binding: KeyBinding = {
      code: b.code,
      key: typeof b.key === 'string' ? b.key : '',
      ctrl: b.ctrl === true,
      alt: b.alt === true,
      shift: b.shift === true,
      meta: b.meta === true,
    };
    return reservedReason(binding) ? DEFAULT_BINDING : binding;
  } catch {
    return DEFAULT_BINDING;
  }
}

export function serializeBinding(b: KeyBinding): string {
  return JSON.stringify(b);
}

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
  'CapsLock',
  'Fn',
]);

export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

/**
 * Why a binding cannot be used, or null. The browser or the system takes some
 * keys before the page sees them (close tab, new window, switch tab, quit),
 * and Tab / Escape move focus and close panels here.
 */
export function reservedReason(b: KeyBinding): string | null {
  const plain = !b.ctrl && !b.alt && !b.meta;
  if (plain && !b.shift && (b.code === 'Tab' || b.code === 'Escape')) {
    return 'Tab and Esc move around the page, pick another key.';
  }
  if (b.code === 'Tab' && (b.ctrl || b.alt || b.meta)) return 'Your system switches with that, pick another key.';
  const cmd = b.ctrl || b.meta;
  if (cmd && !b.alt && ['KeyW', 'KeyT', 'KeyN', 'KeyQ', 'KeyR', 'KeyL', 'KeyH'].includes(b.code)) {
    return 'Your browser keeps that one, pick another key.';
  }
  if (b.alt && b.code === 'F4') return 'Your system keeps that one, pick another key.';
  return null;
}

/** A binding from a key press (the recorder), or null while only modifiers are down. */
export function bindingFromEvent(e: KeyLike): KeyBinding | null {
  if (!e.code || isModifierCode(e.code)) return null;
  return {
    code: e.code,
    key: e.key,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    meta: e.metaKey,
  };
}

/** The bound key pressed, with exactly its modifiers. */
export function matchesPress(e: KeyLike, b: KeyBinding): boolean {
  return (
    e.code === b.code &&
    e.ctrlKey === b.ctrl &&
    e.altKey === b.alt &&
    e.shiftKey === b.shift &&
    e.metaKey === b.meta
  );
}

/**
 * Letting go of the bound key or of any modifier in it ends push to talk: on a
 * Mac the letter's keyup never comes while ⌘ is held.
 */
export function isRelease(e: Pick<KeyLike, 'code'>, b: KeyBinding): boolean {
  if (e.code === b.code) return true;
  if (b.ctrl && (e.code === 'ControlLeft' || e.code === 'ControlRight')) return true;
  if (b.alt && (e.code === 'AltLeft' || e.code === 'AltRight')) return true;
  if (b.shift && (e.code === 'ShiftLeft' || e.code === 'ShiftRight')) return true;
  if (b.meta && ['MetaLeft', 'MetaRight', 'OSLeft', 'OSRight'].includes(e.code)) return true;
  return false;
}

/** A key that types (no Ctrl / Alt / ⌘) is left to text fields: it is someone writing. */
export function typesText(b: KeyBinding): boolean {
  return !b.ctrl && !b.alt && !b.meta;
}

const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** Whether the key press lands where someone is typing. */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: string; type?: string; isContentEditable?: boolean };
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((el.type ?? 'text').toLowerCase());
  return false;
}

const KEY_NAMES: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Home: 'Home',
  End: 'End',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Insert: 'Insert',
};

/** What a key is called on screen: 'M', 'Ctrl + Shift + M', '⌘ ⇧ M', 'F8', 'Space'. */
export function describeBinding(b: KeyBinding, mac: boolean): string {
  let name = KEY_NAMES[b.code];
  if (!name) {
    if (/^F\d{1,2}$/.test(b.code)) name = b.code;
    else if (b.key && b.key.length === 1 && b.key !== ' ') name = b.key.toLocaleUpperCase();
    else if (/^Key[A-Z]$/.test(b.code)) name = b.code.slice(3);
    else if (/^Digit\d$/.test(b.code)) name = b.code.slice(5);
    else if (/^Numpad\d$/.test(b.code)) name = `Num ${b.code.slice(6)}`;
    else name = b.key && b.key.length > 1 ? b.key : b.code;
  }
  const parts = mac
    ? [b.ctrl ? '⌃' : '', b.alt ? '⌥' : '', b.shift ? '⇧' : '', b.meta ? '⌘' : '']
    : [b.ctrl ? 'Ctrl' : '', b.alt ? 'Alt' : '', b.shift ? 'Shift' : '', b.meta ? 'Win' : ''];
  return [...parts.filter(Boolean), name].join(mac ? ' ' : ' + ');
}

/** Whether keys are worth offering: a mouse or trackpad means a keyboard is likely. */
export function hasKeyboardLikely(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(any-pointer: fine)').matches;
}

export function isMacPlatform(ua: string): boolean {
  return /Mac OS X|Macintosh/.test(ua) && !/iPhone|iPad/.test(ua);
}
