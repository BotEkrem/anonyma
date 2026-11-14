import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeToolbar, type ToolbarPlacement } from './toolbarPlacement.ts';

// A side chat next to a call: the list shows 221–713, toolbars are 37 px tall.
const view = { top: 221, bottom: 713 };
const base = { view, height: 37, gap: 4, beside: false, preferBelow: false };
const at = (p: Partial<ToolbarPlacement> & { main: ToolbarPlacement['main'] }) =>
  p.main.top + placeToolbar({ ...base, ...p });

test('narrow: a short message in the middle gets its toolbar above it', () => {
  assert.equal(at({ main: { top: 473, bottom: 512 } }), 473 - 4 - 37);
});

test('narrow: the first message of a run keeps its toolbar below', () => {
  assert.equal(at({ main: { top: 421, bottom: 461 }, preferBelow: true }), 461 + 4);
});

test('narrow: no room above (top row on screen) → below', () => {
  assert.equal(at({ main: { top: 230, bottom: 270 } }), 270 + 4);
});

test('narrow: no room below (last row on screen) → above, even for a run start', () => {
  assert.equal(at({ main: { top: 660, bottom: 700 }, preferBelow: true }), 660 - 4 - 37);
});

test('narrow: a long message whose top is off screen → below it when its end shows', () => {
  // The 30-line message measured in the preview: −724 to 599 while the list shows 221–713.
  assert.equal(at({ main: { top: -724, bottom: 599 } }), 599 + 4);
});

test('narrow: a message taller than the list → on the bubble at the top of the list', () => {
  assert.equal(at({ main: { top: -724, bottom: 1400 } }), 221);
});

test('narrow: a long message whose top is on screen but no room above it', () => {
  assert.equal(at({ main: { top: 225, bottom: 1400 } }), 221);
});

test('wide: centred beside a message that is fully on screen', () => {
  assert.equal(at({ main: { top: 400, bottom: 440 }, beside: true }), 420 - 18.5 + 0.5);
});

test('wide: beside a tall message, centred on the part that is on screen', () => {
  // Only the bottom 150 px of a 670 px bubble shows.
  const y = at({ main: { top: -299, bottom: 371 }, beside: true });
  assert.ok(y >= 221 && y + 37 <= 371, `toolbar at ${y} should sit beside 221–371`);
});

test('wide: never leaves the list at the edges', () => {
  assert.equal(at({ main: { top: 215, bottom: 235 }, beside: true }), 221);
  assert.equal(at({ main: { top: 700, bottom: 720 }, beside: true }), 713 - 37);
});

test('a list shorter than the toolbar does not throw and keeps the side choice', () => {
  const tiny = { top: 100, bottom: 120 };
  assert.equal(at({ view: tiny, main: { top: 105, bottom: 115 } }), 105 - 4 - 37);
});
