import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLUR_STALL_MS,
  MASK_STALE_MS,
  guardFrames,
  parseBlur,
  type GuardedTransformer,
} from './cameraBlur.ts';

/**
 * A stand-in for LiveKit's BackgroundTransformer, doing what the real one
 * does with frames: the very first one goes out as it is (a clone), then
 * each frame is segmented (the mask lands through updateMask) and the drawn
 * result goes out; while disabled, frames go out untouched.
 */
class FakeTransformer {
  isFirstFrame = true;
  disabled = false;
  /** The segmenter answers (false: it has stopped working). */
  segmenting = true;
  async init() {
    this.isFirstFrame = true;
  }
  updateMask(mask: unknown): void {
    void mask;
  }
  transform(frame: Frame, controller: { enqueue(f: Frame): void }) {
    if (this.disabled) {
      controller.enqueue(frame);
      return;
    }
    if (this.isFirstFrame) controller.enqueue(new Frame(`${frame.name}:raw-clone`));
    this.isFirstFrame = false;
    if (this.segmenting) this.updateMask({ mask: frame.name });
    controller.enqueue(new Frame(`${frame.name}:drawn`));
    frame.close();
  }
}
const made: Frame[] = [];
class Frame {
  closed = false;
  name: string;
  constructor(name: string) {
    this.name = name;
    made.push(this);
  }
  close() {
    this.closed = true;
  }
}

function setup() {
  let clock = 1000;
  const t = new FakeTransformer();
  const guard = guardFrames(t as unknown as GuardedTransformer, () => clock);
  const sent: string[] = [];
  const feed = (name: string) => {
    void (t as unknown as GuardedTransformer).transform(new Frame(name), {
      enqueue: (f) => sent.push((f as Frame).name),
    });
  };
  return {
    t,
    guard,
    sent,
    feed,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

test('the stored blur reads back as one of the three, else off', () => {
  assert.equal(parseBlur('light'), 'light');
  assert.equal(parseBlur('strong'), 'strong');
  assert.equal(parseBlur('heavy'), 'off');
  assert.equal(parseBlur(null), 'off');
});

test("the camera's first frame never goes out unblurred", () => {
  const { feed, sent } = setup();
  feed('f1');
  assert.ok(!sent.some((n) => n.endsWith(':raw-clone')), `sent ${sent.join(', ')}`);
  assert.deepEqual(sent, ['f1:drawn']);
});

test('nothing goes out before the first mask, and the held frames are closed', () => {
  const { t, guard, feed, sent } = setup();
  t.segmenting = false;
  made.length = 0;
  feed('f1');
  feed('f2');
  assert.deepEqual(sent, []);
  assert.equal(guard.health(), 'loading');
  // Every frame made along the way was given back (none left open).
  assert.ok(made.every((f) => f.closed), made.filter((f) => !f.closed).map((f) => f.name).join());
  t.segmenting = true;
  feed('f3');
  assert.deepEqual(sent, ['f3:drawn']);
  assert.equal(guard.health(), 'ok');
});

test('a mask that stops coming stops the frames, and then reads as failed', () => {
  const { t, guard, feed, sent, tick } = setup();
  feed('f1');
  t.segmenting = false;
  tick(MASK_STALE_MS / 2);
  feed('f2');
  tick(MASK_STALE_MS);
  feed('f3');
  assert.deepEqual(sent, ['f1:drawn', 'f2:drawn']);
  assert.equal(guard.health(), 'ok');
  tick(BLUR_STALL_MS);
  feed('f4');
  assert.equal(guard.health(), 'failed');
});

test('blur that never makes a mask reads as failed after the stall time', () => {
  const { t, guard, feed, tick } = setup();
  t.segmenting = false;
  feed('f1');
  tick(BLUR_STALL_MS - 1);
  assert.equal(guard.health(), 'loading');
  tick(2);
  assert.equal(guard.health(), 'failed');
});

test('a restart (camera switched or back on) forgets the old mask', async () => {
  const { t, guard, feed, sent } = setup();
  feed('f1');
  assert.deepEqual(sent, ['f1:drawn']);
  t.segmenting = false;
  await (t as unknown as GuardedTransformer).init();
  feed('f2');
  assert.deepEqual(sent, ['f1:drawn']);
  assert.equal(guard.health(), 'loading');
});

test('off passes frames as they are; back on, it waits for a fresh mask', () => {
  const { t, guard, feed, sent } = setup();
  feed('f1');
  guard.setPassThrough(true);
  t.disabled = true;
  feed('f2');
  assert.deepEqual(sent, ['f1:drawn', 'f2']);
  assert.equal(guard.health(), 'off');
  // Turning a level back on: the guard holds frames before the blur is even on.
  guard.setPassThrough(false);
  guard.reset();
  feed('f3'); // still disabled in the transformer for this frame
  assert.deepEqual(sent, ['f1:drawn', 'f2']);
  t.disabled = false;
  feed('f4');
  assert.deepEqual(sent, ['f1:drawn', 'f2', 'f4:drawn']);
});
