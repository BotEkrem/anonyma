import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechGate, createVoiceRoom, rmsDb } from './voice.ts';

// The call reads every 30 ms. A level script is a list of [ms, dBFS] runs.
const STEP = 30;
let seed = 1;
const jitter = (spread: number) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return (seed / 2147483648 - 0.5) * 2 * spread;
};
function play(runs: [number, (t: number) => number][]) {
  const gate = createSpeechGate();
  const spans: [number, number][] = [];
  let t = 0;
  let openedAt = -1;
  for (const [ms, level] of runs) {
    for (const end = t + ms; t < end; t += STEP) {
      const open = gate.push(level(t), t);
      if (open && openedAt < 0) openedAt = t;
      if (!open && openedAt >= 0) {
        spans.push([openedAt, t]);
        openedAt = -1;
      }
    }
  }
  if (openedAt >= 0) spans.push([openedAt, t]);
  return spans;
}
const room = (db: number) => () => db + jitter(1.5);
// Syllables: loud and softer in turn, as a word is.
const voice = (db: number) => (t: number) => (Math.floor(t / 90) % 2 ? db - 8 : db) + jitter(2);

test('rmsDb reads silence, full scale and half scale', () => {
  assert.equal(rmsDb(new Float32Array(64)), -100);
  assert.equal(Math.round(rmsDb(new Float32Array(64).fill(1))), 0);
  assert.equal(Math.round(rmsDb(new Float32Array(64).fill(0.5))), -6);
});

test('a short word opens within two reads and closes soon after', () => {
  const spans = play([
    [2000, room(-62)],
    [600, voice(-34)],
    [3000, room(-62)],
  ]);
  assert.equal(spans.length, 1);
  const [on, off] = spans[0];
  assert.ok(on >= 2000 && on <= 2000 + 2 * STEP, `opened at ${on}`);
  assert.ok(off >= 2600 && off <= 2600 + 600, `closed at ${off}`);
});

test('a quiet room never opens it, nor does one click', () => {
  assert.deepEqual(play([[10000, room(-55)]]), []);
  // A microphone that starts with digital silence, then a loud room.
  assert.deepEqual(
    play([
      [300, () => -100],
      [8000, room(-45)],
    ]),
    [],
  );
  assert.deepEqual(
    play([
      [2000, room(-62)],
      [STEP, () => -20],
      [2000, room(-62)],
    ]),
    [],
  );
});

test('a long sentence with gaps between its words stays open', () => {
  const runs: [number, (t: number) => number][] = [[2000, room(-60)]];
  for (let i = 0; i < 12; i += 1) runs.push([600, voice(-33)], [120, room(-60)]);
  runs.push([2000, room(-60)]);
  const spans = play(runs);
  assert.equal(spans.length, 1, JSON.stringify(spans));
});

test('a room that gets louder closes it again within a few seconds', () => {
  const spans = play([
    [3000, room(-70)],
    [8000, room(-45)],
  ]);
  for (const [, off] of spans) assert.ok(off <= 3000 + 4000, `still open at ${off}`);
  // And a voice over that louder room still opens it, if a little later.
  const later = play([
    [6000, room(-46)],
    [600, voice(-30)],
    [2000, room(-46)],
  ]);
  assert.ok(later.some(([on]) => on >= 6000 && on <= 6000 + 200), JSON.stringify(later));
});

// Two people read together every 30 ms; each level script is a function of time.
function talk(ms: number, a: (t: number) => number, b: (t: number) => number) {
  const voices = createVoiceRoom();
  const spans: Record<'A' | 'B', [number, number][]> = { A: [], B: [] };
  const from: Record<'A' | 'B', number> = { A: -1, B: -1 };
  for (let t = 0; t < ms; t += STEP) {
    const { speaking } = voices.push(
      new Map([
        ['A', a(t)],
        ['B', b(t)],
      ]),
      t,
    );
    for (const id of ['A', 'B'] as const) {
      const on = speaking.has(id);
      if (on && from[id] < 0) from[id] = t;
      if (!on && from[id] >= 0) {
        spans[id].push([from[id], t]);
        from[id] = -1;
      }
    }
  }
  for (const id of ['A', 'B'] as const) if (from[id] >= 0) spans[id].push([from[id], ms]);
  return spans;
}
// A talks from 1 s to 4 s; B's microphone hears it back (speakers) one
// round trip later and 12 dB down, over B's own room.
const aTalks = (t: number) => (t >= 1000 && t < 4000 ? voice(-30)(t) : room(-62)());
const echoOfA = (delay: number) => (t: number) => Math.max(room(-60)(), aTalks(t - delay) - 12);

test("the echo of someone's voice does not light the other person up", () => {
  for (const delay of [60, 300, 450]) {
    const spans = talk(6000, aTalks, echoOfA(delay));
    assert.equal(spans.A.length, 1, `delay ${delay}: ${JSON.stringify(spans.A)}`);
    assert.deepEqual(spans.B, [], `delay ${delay}`);
  }
});

test('an interruption over the echo shows, and goes out after it', () => {
  const b = (t: number) => (t >= 2000 && t < 2600 ? voice(-32)(t) : echoOfA(300)(t));
  const spans = talk(6000, aTalks, b);
  assert.equal(spans.B.length, 1, JSON.stringify(spans.B));
  const [on, off] = spans.B[0];
  assert.ok(on >= 2000 && on <= 2000 + 3 * STEP, `opened at ${on}`);
  assert.ok(off <= 2600 + 700, `still open at ${off}`);
});

test('a reply right after the other stops shows at once', () => {
  const b = (t: number) => (t >= 4250 && t < 4700 ? voice(-34)(t) : echoOfA(300)(t));
  const spans = talk(6000, aTalks, b);
  assert.ok(
    // Its first syllable is the softer one: it opens on the second.
    spans.B.some(([on]) => on >= 4250 && on <= 4250 + 150),
    JSON.stringify(spans.B),
  );
});
