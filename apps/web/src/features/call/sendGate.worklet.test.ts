import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SENSITIVITY_MAX_DB,
  isApplePhoneOrTablet,
  parseNoise,
  parseSensitivity,
  sensitivityShare,
} from './sensitivity.ts';

// The worklet itself, run here the way the audio thread runs it: 128-sample
// blocks at 48 kHz, its port recording what it posts.
const RATE = 48000;
const BLOCK = 128;
type Posted = { db: number; open: boolean };
class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  posted: Posted[] = [];
  postMessage(message: Posted) {
    this.posted.push(message);
  }
}
interface Gate {
  port: FakePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
type GateClass = new (options: { processorOptions: { thresholdDb: number | null } }) => Gate;
const scope = globalThis as unknown as Record<string, unknown>;
let Registered: GateClass | undefined;
scope.sampleRate = RATE;
scope.AudioWorkletProcessor = class {
  port = new FakePort();
};
scope.registerProcessor = (_name: string, cls: GateClass) => {
  Registered = cls;
};
await import('./sendGate.worklet.js');

const ms = (n: number) => Math.round((RATE * n) / 1000);
/** A sine at `db` dBFS (RMS), `length` samples. */
const tone = (db: number, length: number) => {
  const amp = Math.SQRT2 * 10 ** (db / 20);
  return Float32Array.from({ length }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / RATE));
};
let seed = 7;
/** Room noise around `db` dBFS (RMS). */
const noise = (db: number, length: number) => {
  const amp = Math.sqrt(3) * 10 ** (db / 20);
  return Float32Array.from({ length }, () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return amp * ((seed / 2147483648) * 2 - 1);
  });
};
const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
/** Runs `input` through a gate at `thresholdDb`; returns what goes out. */
function run(input: Float32Array, thresholdDb: number | null, gate?: Gate) {
  const g = gate ?? new Registered!({ processorOptions: { thresholdDb } });
  const out = new Float32Array(input.length);
  for (let at = 0; at + BLOCK <= input.length; at += BLOCK) {
    const block = new Float32Array(BLOCK);
    g.process([[input.subarray(at, at + BLOCK)]], [[block]]);
    out.set(block, at);
  }
  return { out, gate: g };
}
const energy = (a: Float32Array, from: number, to: number) => {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += a[i] * a[i];
  return sum;
};
const LOOKAHEAD = ms(12);

test('the quiet room under the line is not sent at all', () => {
  const { out } = run(noise(-55, ms(1000)), -40);
  assert.equal(energy(out, 0, out.length), 0);
});

test('a voice over the line goes out whole, its first syllable included', () => {
  const onset = ms(300);
  const input = join(noise(-55, onset), tone(-20, ms(400)));
  const { out } = run(input, -40);
  // The sound leaves LOOKAHEAD late: what left in the first 5 ms of the
  // voice is the voice's first 5 ms, at full strength.
  const sent = energy(out, onset + LOOKAHEAD, onset + LOOKAHEAD + ms(5));
  const said = energy(input, onset, onset + ms(5));
  assert.ok(sent > 0.95 * said, `first 5 ms sent ${(sent / said).toFixed(3)} of it`);
  // Nothing of the room before it (before the block the voice starts in).
  assert.equal(energy(out, 0, onset - BLOCK), 0);
});

test('it holds open through the gap between words, then closes softly', () => {
  const input = join(tone(-20, ms(300)), noise(-55, ms(250)), tone(-20, ms(200)), noise(-55, ms(1000)));
  const { out } = run(input, -40);
  const gapStart = ms(300) + LOOKAHEAD;
  // The 250 ms gap is shorter than the hold: the room in it is still sent.
  assert.ok(energy(out, gapStart + ms(50), gapStart + ms(240)) > 0);
  // Well after the last word (hold 400 ms + the release) nothing goes out.
  const lastEnd = ms(750) + LOOKAHEAD;
  assert.equal(energy(out, lastEnd + ms(900), out.length), 0);
  // No step: the last sent samples fade (each at most a fraction of the room's level).
  const tail = out.subarray(lastEnd + ms(400), lastEnd + ms(700));
  assert.ok(Math.max(...tail.map(Math.abs)) < 10 ** (-55 / 20) * 2);
});

test('a word that fades under the line keeps its tail', () => {
  // 6 dB under the threshold still counts as the same word.
  const input = join(tone(-30, ms(200)), tone(-44, ms(150)), noise(-80, ms(800)));
  const { out } = run(input, -40);
  const tailStart = ms(200) + LOOKAHEAD;
  const tailSent = energy(out, tailStart, tailStart + ms(150));
  const tailSaid = energy(input, ms(200), ms(350));
  assert.ok(tailSent > 0.9 * tailSaid);
});

test('a new line from the settings bar applies at once', () => {
  const quiet = noise(-50, ms(400));
  const first = run(quiet, -40);
  assert.equal(energy(first.out, 0, first.out.length), 0);
  first.gate.port.onmessage?.({ data: { thresholdDb: -60 } });
  const second = run(noise(-50, ms(400)), null, first.gate);
  assert.ok(energy(second.out, ms(50), second.out.length) > 0);
});

test('it tells the bar its level about every 10 ms, measured as the gate measures it', () => {
  const { gate } = run(tone(-24, ms(500)), -40);
  const posts = gate.port.posted;
  assert.ok(posts.length >= 45 && posts.length <= 55, `${posts.length} posts in 500 ms`);
  const last = posts[posts.length - 1];
  assert.ok(Math.abs(last.db - -24) < 0.5, `level ${last.db}`);
  assert.equal(last.open, true);
});

test('no input is silence, not a crash', () => {
  const g = new Registered!({ processorOptions: { thresholdDb: -40 } });
  const block = new Float32Array(BLOCK).fill(1);
  assert.equal(g.process([[]], [[block]]), true);
  assert.ok(block.every((v) => v === 0));
});

test('the stored setting reads back as a level on the bar or off', () => {
  assert.equal(parseSensitivity(null), null);
  assert.equal(parseSensitivity(''), null);
  assert.equal(parseSensitivity('loud'), null);
  assert.equal(parseSensitivity('-70'), null);
  assert.equal(parseSensitivity('-90'), null);
  assert.equal(parseSensitivity('-44.6'), -45);
  assert.equal(parseSensitivity('-3'), SENSITIVITY_MAX_DB);
  assert.equal(sensitivityShare(-70), 0);
  assert.equal(sensitivityShare(-10), 1);
  assert.equal(sensitivityShare(-40), 0.5);
  assert.equal(sensitivityShare(-100), 0);
});

test('the stored noise level reads back as one of the three, else off', () => {
  assert.equal(parseNoise('light'), 'light');
  assert.equal(parseNoise('medium'), 'medium');
  assert.equal(parseNoise('strong'), 'off');
  assert.equal(parseNoise(''), 'off');
  assert.equal(parseNoise(null), 'off');
});

test('iPhone and iPad (an iPad says Mac, with touch) are told apart from a Mac', () => {
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
  assert.equal(isApplePhoneOrTablet('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5), true);
  assert.equal(isApplePhoneOrTablet(mac, 5), true);
  assert.equal(isApplePhoneOrTablet(mac, 0), false);
  assert.equal(isApplePhoneOrTablet('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 10), false);
});
