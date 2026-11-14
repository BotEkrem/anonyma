import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BINDING,
  bindingFromEvent,
  describeBinding,
  isRelease,
  isTypingTarget,
  matchesPress,
  parseBinding,
  parseMicMode,
  reservedReason,
  serializeBinding,
  typesText,
  type KeyBinding,
  type KeyLike,
} from './shortcutKeys.ts';

const press = (code: string, key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  code,
  key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});
const combo = (b: Partial<KeyBinding>): KeyBinding => ({ ...DEFAULT_BINDING, ...b });

test('M is the default, in Toggle mode', () => {
  assert.equal(parseMicMode(null), 'toggle');
  assert.equal(parseMicMode('hold'), 'hold');
  assert.equal(parseMicMode('push'), 'toggle');
  assert.deepEqual(parseBinding(null), DEFAULT_BINDING);
  assert.equal(DEFAULT_BINDING.code, 'KeyM');
});

test('a chosen key reads back as it was stored; a broken or reserved one falls back to M', () => {
  const ctrlShiftM = combo({ ctrl: true, shift: true });
  assert.deepEqual(parseBinding(serializeBinding(ctrlShiftM)), ctrlShiftM);
  assert.deepEqual(parseBinding('{'), DEFAULT_BINDING);
  assert.deepEqual(parseBinding('{"code":"ShiftLeft","key":"Shift"}'), DEFAULT_BINDING);
  assert.deepEqual(parseBinding(serializeBinding(combo({ code: 'KeyW', meta: true }))), DEFAULT_BINDING);
});

test('the key matches by its place on the keyboard, with exactly its modifiers', () => {
  // A Turkish layout: the key that types ö is still where it is.
  const b = combo({ code: 'Comma', key: 'ö' });
  assert.ok(matchesPress(press('Comma', 'ö'), b));
  assert.ok(matchesPress(press('Comma', ','), b));
  assert.ok(!matchesPress(press('Comma', 'Ö', { shiftKey: true }), b));
  const m = DEFAULT_BINDING;
  assert.ok(matchesPress(press('KeyM', 'm'), m));
  assert.ok(!matchesPress(press('KeyM', 'm', { ctrlKey: true }), m));
  assert.ok(!matchesPress(press('KeyN', 'n'), m));
});

test('letting go of the key or any of its modifiers ends push to talk', () => {
  const cmdShiftM = combo({ meta: true, shift: true });
  assert.ok(isRelease({ code: 'KeyM' }, cmdShiftM));
  // On a Mac the letter's keyup never comes while ⌘ is held: ⌘ going up is the release.
  assert.ok(isRelease({ code: 'MetaLeft' }, cmdShiftM));
  assert.ok(isRelease({ code: 'ShiftRight' }, cmdShiftM));
  assert.ok(!isRelease({ code: 'ControlLeft' }, cmdShiftM));
  assert.ok(!isRelease({ code: 'ShiftLeft' }, DEFAULT_BINDING));
});

test('a key that types is left to text fields; a Ctrl / ⌘ combo works there too', () => {
  assert.ok(typesText(DEFAULT_BINDING));
  assert.ok(typesText(combo({ shift: true })));
  assert.ok(!typesText(combo({ ctrl: true, shift: true })));
  assert.ok(isTypingTarget({ tagName: 'TEXTAREA' }));
  assert.ok(isTypingTarget({ tagName: 'INPUT', type: 'text' }));
  assert.ok(isTypingTarget({ tagName: 'INPUT' }));
  assert.ok(isTypingTarget({ tagName: 'DIV', isContentEditable: true }));
  // The sensitivity slider and buttons are not typing.
  assert.ok(!isTypingTarget({ tagName: 'INPUT', type: 'range' }));
  assert.ok(!isTypingTarget({ tagName: 'BUTTON' }));
  assert.ok(!isTypingTarget(null));
});

test('the recorder waits past modifiers and refuses keys the browser or page keep', () => {
  assert.equal(bindingFromEvent(press('ShiftLeft', 'Shift', { shiftKey: true })), null);
  assert.deepEqual(
    bindingFromEvent(press('KeyM', 'M', { ctrlKey: true, shiftKey: true })),
    combo({ key: 'M', ctrl: true, shift: true }),
  );
  assert.ok(reservedReason(combo({ code: 'KeyW', meta: true })));
  assert.ok(reservedReason(combo({ code: 'KeyT', ctrl: true })));
  assert.ok(reservedReason(combo({ code: 'Tab', ctrl: true })));
  assert.ok(reservedReason(combo({ code: 'Tab' })));
  assert.ok(reservedReason(combo({ code: 'Escape' })));
  assert.ok(reservedReason(combo({ code: 'F4', alt: true })));
  assert.equal(reservedReason(DEFAULT_BINDING), null);
  assert.equal(reservedReason(combo({ code: 'Space', key: ' ' })), null);
  assert.equal(reservedReason(combo({ code: 'F8', key: 'F8' })), null);
});

test('keys are named as they read on the keyboard', () => {
  assert.equal(describeBinding(DEFAULT_BINDING, false), 'M');
  assert.equal(describeBinding(combo({ key: 'M', ctrl: true, shift: true }), false), 'Ctrl + Shift + M');
  assert.equal(describeBinding(combo({ key: 'M', meta: true, shift: true }), true), '⇧ ⌘ M');
  assert.equal(describeBinding(combo({ code: 'Space', key: ' ' }), false), 'Space');
  assert.equal(describeBinding(combo({ code: 'F8', key: 'F8' }), false), 'F8');
  assert.equal(describeBinding(combo({ code: 'Comma', key: 'ö' }), false), 'Ö');
  assert.equal(describeBinding(combo({ code: 'Backquote', key: 'Dead' }), false), 'Dead');
});
