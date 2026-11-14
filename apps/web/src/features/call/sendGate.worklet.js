/* global AudioWorkletProcessor, registerProcessor, sampleRate */
/**
 * Input sensitivity: what your microphone sends, cut below the level you chose.
 *
 * Runs on the audio thread (voiceChain.ts loads it into the call's audio
 * context), so a call in a background tab is cut as well as one in front:
 * timers there run once a second, the audio thread does not slow down.
 *
 * - The level is the RMS of the last ~10 ms, in dBFS: the number the settings
 *   bar shows and the thumb is compared with.
 * - It opens on the first block at or above the threshold. The sound itself
 *   goes out LOOKAHEAD_MS late, so the opening is ready before the first
 *   syllable leaves and no word loses its start.
 * - Once open, it stays open while the level is within CLOSE_BELOW_DB of the
 *   threshold (a word's tail), and HOLD_MS after that: the gaps between words.
 * - The gain moves in short straight ramps (ATTACK_MS up, RELEASE_MS down),
 *   never in a step: no clicks, and closed means exactly zero.
 *
 * Every ~10 ms it posts { db, open }: the loudest level since the last post
 * (for the settings bar) and whether it lets sound out now.
 */
const QUANTUM = 128;
const WINDOW_MS = 10;
const LOOKAHEAD_MS = 12;
const HOLD_MS = 400;
const CLOSE_BELOW_DB = 6;
const ATTACK_MS = 3;
const RELEASE_MS = 60;
const POST_MS = 10;

function toDb(meanSquare) {
  const rms = Math.sqrt(meanSquare);
  return rms > 1e-5 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
}

class SendGate extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.threshold = typeof opts.thresholdDb === 'number' ? opts.thresholdDb : null;
    // The level window, as the sums of squares of its last few blocks.
    this.blocks = new Float64Array(Math.max(1, Math.ceil((sampleRate * WINDOW_MS) / 1000 / QUANTUM)));
    this.block = 0;
    // The delay line the sound goes out through.
    this.delay = Math.round((sampleRate * LOOKAHEAD_MS) / 1000);
    this.ring = new Float32Array(this.delay + QUANTUM);
    this.write = 0;
    this.open = false;
    this.lastVoiced = -Infinity;
    this.gain = 0;
    this.attack = 1 / ((sampleRate * ATTACK_MS) / 1000);
    this.release = 1 / ((sampleRate * RELEASE_MS) / 1000);
    this.now = 0;
    this.postEvery = Math.max(1, Math.round((sampleRate * POST_MS) / 1000 / QUANTUM));
    this.sincePost = 0;
    this.peak = -100;
    this.port.onmessage = (event) => {
      const next = event.data && event.data.thresholdDb;
      this.threshold = typeof next === 'number' ? next : null;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    const n = output ? output.length : QUANTUM;
    let sum = 0;
    if (input) for (let i = 0; i < input.length; i += 1) sum += input[i] * input[i];
    this.blocks[this.block] = sum;
    this.block = (this.block + 1) % this.blocks.length;
    let total = 0;
    for (let i = 0; i < this.blocks.length; i += 1) total += this.blocks[i];
    const db = toDb(total / (this.blocks.length * QUANTUM));
    this.now += (n / sampleRate) * 1000;

    if (this.threshold === null) {
      this.open = true;
      this.lastVoiced = this.now;
    } else if (db >= this.threshold) {
      this.open = true;
      this.lastVoiced = this.now;
    } else if (this.open && db >= this.threshold - CLOSE_BELOW_DB) {
      this.lastVoiced = this.now;
    } else if (this.open && this.now - this.lastVoiced > HOLD_MS) {
      this.open = false;
    }

    const size = this.ring.length;
    for (let i = 0; i < n; i += 1) {
      this.ring[this.write] = input ? input[i] : 0;
      const read = (this.write - this.delay + size) % size;
      this.write = (this.write + 1) % size;
      this.gain = this.open
        ? Math.min(1, this.gain + this.attack)
        : Math.max(0, this.gain - this.release);
      if (output) output[i] = this.ring[read] * this.gain;
    }

    this.peak = Math.max(this.peak, db);
    this.sincePost += 1;
    if (this.sincePost >= this.postEvery) {
      this.port.postMessage({ db: this.peak, open: this.open });
      this.sincePost = 0;
      this.peak = -100;
    }
    return true;
  }
}

registerProcessor('anonyma-send-gate', SendGate);
