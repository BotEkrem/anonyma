/**
 * The call's sound meters (Web Audio), one per voice: yours and each person's.
 * All of them share one AudioContext, closed when the call ends.
 *
 * Each meter taps its track twice. A long window (2048 samples, about 43 ms)
 * feeds the speech gates (voice.ts); it is longer than the 30 ms between reads,
 * so no syllable falls between two of them. A short one gives React Bits' Voice
 * Pill its level, read the way LiveKit's createAudioAnalyser read it before
 * (512 samples, smoothing 0.5, -100 to -80 dB), so the bars look the same.
 */
import { rmsDb } from './voice';

export interface VoiceMeter {
  /** The Voice Pill's level, 0 to 1. */
  level(): number;
  /** The voice's level now (dBFS, the last ~43 ms), for the speech gate. */
  db(): number;
  /**
   * The level of the newest ~10 ms (dBFS): the measure the input sensitivity
   * gate compares (sendGate.worklet.js), for its bar while no gate is on.
   */
  recentDb(): number;
}

export interface VoiceMeters {
  /** The meter for `key`, built again when its track changed; null without Web Audio. */
  get(key: string, track: MediaStreamTrack): VoiceMeter | null;
  /** The meter for `key` if one is up (never builds one). */
  peek(key: string): VoiceMeter | null;
  /** Close every meter whose key is not in `keep`. */
  keepOnly(keep: Set<string>): void;
  /** Close every meter and the AudioContext. */
  close(): void;
}

type Entry = { track: MediaStreamTrack; meter: VoiceMeter | null; stop: () => void };

export function createVoiceMeters(): VoiceMeters {
  let ctx: AudioContext | null = null;
  let noAudio = false;
  let lastResume = -Infinity;
  const entries = new Map<string, Entry>();

  const context = (): AudioContext | null => {
    if (noAudio) return null;
    if (!ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      try {
        ctx = Ctor ? new Ctor() : null;
      } catch {
        ctx = null;
      }
      if (!ctx) {
        noAudio = true;
        return null;
      }
    }
    // A context made before the browser allowed sound reads silence until it
    // runs: ask again now and then (the call's own buttons are gestures).
    if (ctx.state === 'suspended' && performance.now() - lastResume > 1000) {
      lastResume = performance.now();
      void ctx.resume().catch(() => undefined);
    }
    return ctx;
  };

  const build = (track: MediaStreamTrack): Entry => {
    const audio = context();
    if (!audio) return { track, meter: null, stop: () => undefined };
    try {
      const source = audio.createMediaStreamSource(new MediaStream([track]));
      const gateTap = audio.createAnalyser();
      gateTap.fftSize = 2048;
      const barsTap = audio.createAnalyser();
      barsTap.fftSize = 512;
      barsTap.smoothingTimeConstant = 0.5;
      barsTap.minDecibels = -100;
      barsTap.maxDecibels = -80;
      source.connect(gateTap);
      source.connect(barsTap);
      const wave = new Float32Array(gateTap.fftSize);
      const recent = Math.min(wave.length, Math.round(audio.sampleRate / 100));
      const bins = new Uint8Array(barsTap.frequencyBinCount);
      return {
        track,
        meter: {
          level() {
            barsTap.getByteFrequencyData(bins);
            let sum = 0;
            for (const amplitude of bins) sum += (amplitude / 255) ** 2;
            return Math.sqrt(sum / bins.length);
          },
          db() {
            gateTap.getFloatTimeDomainData(wave);
            return rmsDb(wave);
          },
          recentDb() {
            gateTap.getFloatTimeDomainData(wave);
            return rmsDb(wave.subarray(wave.length - recent));
          },
        },
        stop: () => {
          try {
            source.disconnect();
          } catch {
            // Already gone with its context.
          }
        },
      };
    } catch {
      // This track cannot be metered (the call then goes by LiveKit's list).
      return { track, meter: null, stop: () => undefined };
    }
  };

  const drop = (key: string) => {
    entries.get(key)?.stop();
    entries.delete(key);
  };

  return {
    get(key, track) {
      if (entries.get(key)?.track !== track) {
        drop(key);
        entries.set(key, build(track));
      } else {
        context(); // keeps asking a suspended context to run
      }
      return entries.get(key)?.meter ?? null;
    },
    peek(key) {
      return entries.get(key)?.meter ?? null;
    },
    keepOnly(keep) {
      for (const key of [...entries.keys()]) if (!keep.has(key)) drop(key);
    },
    close() {
      for (const key of [...entries.keys()]) drop(key);
      void ctx?.close().catch(() => undefined);
      ctx = null;
    },
  };
}
