/**
 * The microphone's chain in a call: an optional noise filter, then the input
 * sensitivity gate, as ONE LiveKit track processor (LiveKit takes one per
 * track): microphone -> filter -> gate -> sent.
 *
 * - Input sensitivity: a good microphone hears breathing, typing and the
 *   room, and sends all of it. Each person can set a level under which
 *   nothing of theirs goes out (sendGate.worklet.js).
 * - Noise suppression: light (RNNoise) or medium (GTCRN), on top of the
 *   browser's own, from @sapphi-red/web-noise-suppressor. Medium also clears
 *   noise while somebody speaks, at a little more delay.
 *
 * Both are remembered in this browser (sensitivity.ts). With both off nothing
 * is put on the microphone at all: the call sends exactly what it always did.
 * LiveKit carries the chain across a microphone change and ends it with the
 * track. A filter change swaps the filter inside the running chain, so the
 * sender keeps one track throughout.
 *
 * It fails open. If its audio context stops running (a browser that pauses
 * sound, a phone call taking the audio over) or its track dies, the chain
 * comes off and the microphone goes out as it is until it can go back on: a
 * chain stuck sending silence would leave somebody talking to nobody, with
 * nothing to say so.
 *
 * Lessons from Echo's chain (the same parts, measured there in Nov 2026):
 * its own 48 kHz context (the models are made for that rate; the room's runs
 * at the device's), one channel end to end with the extra one dropped rather
 * than mixed in (a silent second channel averaged in sent every voice 6 dB
 * quieter), models and worklets fetched before LiveKit's track lock is taken
 * and the steps inside it bounded, and a refused stop reopens the microphone
 * (stopSafely).
 *
 * A browser that will not take a microphone into a context of another rate
 * (Firefox, on a 44.1 kHz device) refuses the 48 kHz one: the page then runs
 * the gate at the device's own rate and offers no filter (they need 48 kHz).
 */
import type {
  AudioCaptureOptions,
  AudioProcessorOptions,
  LocalAudioTrack,
  LocalTrack,
  Track,
  TrackProcessor,
} from 'livekit-client';
import gateWorkletUrl from './sendGate.worklet.js?url';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import gtcrnWorkletUrl from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url';
import gtcrnWasmUrl from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url';
import type { NoiseLevel } from './sensitivity';

/** This browser can run the chain (an AudioWorklet); without it neither setting is offered. */
export const canChainVoice =
  typeof window !== 'undefined' &&
  typeof AudioWorkletNode !== 'undefined' &&
  typeof AudioContext !== 'undefined';

const SAMPLE_RATE = 48000;
const CHAIN_NAME = 'anonyma-voice-chain';
/** How long a stalled chain, or one waiting for a click, waits before it is tried again (ms). */
const RETRY_MS = 3000;
/** A chain that broke while starting waits longer each time, up to this (ms). */
const RETRY_MAX_MS = 60_000;
/** The longest a step inside LiveKit's track lock may take (ms). */
const STEP_MS = 2000;

/** The capture LiveKit opens for the call (MediaCall), for a reopen with no device named. */
const PLAIN_CAPTURE: AudioCaptureOptions = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

// ---- The audio context: one for the page while a call runs. ----

let sharedContext: AudioContext | null = null;
/** This browser refused the microphone into a 48 kHz context: the device's rate, no filters. */
let rateLocked = false;

function voiceAudio(): AudioContext | null {
  if (!canChainVoice) return null;
  if (!sharedContext || sharedContext.state === 'closed') {
    try {
      sharedContext = rateLocked
        ? new AudioContext({ latencyHint: 'interactive' })
        : new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    } catch {
      sharedContext = null;
    }
  }
  return sharedContext;
}

/** Fails a step that takes longer than `ms` (inside LiveKit's lock nothing may hang). */
function within<T>(step: Promise<T>, ms = STEP_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('voice chain step timed out')), ms);
    step.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Makes (or wakes) the chain's audio context. Called from the call's own
 * buttons: a browser that lets sound start only from a click lets it there.
 */
export function wakeVoiceAudio(): void {
  const ctx = voiceAudio();
  if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => undefined);
}

/** Closes the context when the call ends (a chain still on comes off by itself). */
export function releaseVoiceAudio(): void {
  const ctx = sharedContext;
  sharedContext = null;
  void ctx?.close().catch(() => undefined);
}

const loadedModules = new WeakMap<BaseAudioContext, Map<string, Promise<void>>>();

function loadModule(ctx: AudioContext, url: string): Promise<void> {
  let modules = loadedModules.get(ctx);
  if (!modules) {
    modules = new Map();
    loadedModules.set(ctx, modules);
  }
  let loading = modules.get(url);
  if (!loading) {
    loading = ctx.audioWorklet.addModule(url);
    modules.set(url, loading);
    loading.catch(() => modules.delete(url));
  }
  return loading;
}

// ---- The noise models: fetched once a page, outside LiveKit's lock. ----

const models = new Map<Exclude<NoiseLevel, 'off'>, Promise<ArrayBuffer>>();

function prepareModel(level: Exclude<NoiseLevel, 'off'>): Promise<ArrayBuffer> {
  let ready = models.get(level);
  if (!ready) {
    ready = import('@sapphi-red/web-noise-suppressor').then((lib) =>
      level === 'light'
        ? lib.loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl })
        : lib.loadGtcrn({ url: gtcrnWasmUrl }),
    );
    models.set(level, ready);
    ready.catch(() => models.delete(level));
  }
  return ready;
}

type ModelNode = AudioWorkletNode & { destroy?: () => void };

/** One channel in and out; a second one is dropped, never averaged in. */
function mono(node: AudioNode) {
  node.channelCount = 1;
  node.channelCountMode = 'explicit';
  node.channelInterpretation = 'discrete';
}

const modelWorklet = (level: Exclude<NoiseLevel, 'off'>) =>
  level === 'light' ? rnnoiseWorkletUrl : gtcrnWorkletUrl;

/**
 * Everything a chain at `noise` loads, loaded now, outside LiveKit's lock:
 * the model, the library and the worklets in the page's context.
 */
async function warm(noise: NoiseLevel): Promise<ArrayBuffer | null> {
  const ctx = voiceAudio();
  if (!ctx) throw new Error('no audio context');
  if (noise === 'off') {
    await loadModule(ctx, gateWorkletUrl);
    return null;
  }
  if (rateLocked || ctx.sampleRate !== SAMPLE_RATE) throw new FilterUnavailable();
  const [model] = await Promise.all([
    prepareModel(noise),
    import('@sapphi-red/web-noise-suppressor'),
    loadModule(ctx, gateWorkletUrl),
    loadModule(ctx, modelWorklet(noise)),
  ]);
  return model;
}

async function makeModel(
  ctx: AudioContext,
  level: Exclude<NoiseLevel, 'off'>,
  wasmBinary: ArrayBuffer,
): Promise<ModelNode> {
  // The models are made for 48 kHz: at another rate they remove the wrong things.
  if (ctx.sampleRate !== SAMPLE_RATE) throw new FilterUnavailable();
  const lib = await within(import('@sapphi-red/web-noise-suppressor'));
  await within(loadModule(ctx, modelWorklet(level)));
  const options = { wasmBinary, maxChannels: 1 };
  const node: ModelNode =
    level === 'light'
      ? new lib.RnnoiseWorkletNode(ctx, options)
      : new lib.GtcrnWorkletNode(ctx, options);
  mono(node);
  return node;
}

function dropModel(node: ModelNode | undefined) {
  if (!node) return;
  try {
    node.disconnect();
  } catch {
    // Already gone with its context.
  }
  node.destroy?.();
}

/**
 * Takes the chain off `track`. LiveKit re-applies the capture's constraints
 * before it hands the sender the raw microphone again; if the browser
 * refuses, the stop throws and the sender is left on the chain's stopped
 * track: silence, with nothing to say so (seen in Echo). The microphone is
 * then opened again, by its own constraints and failing that with none.
 */
async function stopSafely(track: LocalTrack | undefined, mine: object) {
  if (!track || track.getProcessor() !== mine) return;
  try {
    await track.stopProcessor();
  } catch {
    const audio = track as LocalAudioTrack;
    try {
      await audio.restartTrack();
    } catch {
      await audio.restartTrack(PLAIN_CAPTURE).catch(() => undefined);
    }
  }
}

/** The audio context would not run (no click yet): try again later, nothing is broken. */
class NotRunning extends Error {
  constructor() {
    super('audio context not running');
  }
}

/** The browser refused the microphone at 48 kHz: built again at the device's rate. */
class RateRefused extends Error {
  constructor() {
    super('microphone refused at 48 kHz');
  }
}

/** No filter on this page (its context is not at 48 kHz). */
class FilterUnavailable extends Error {
  constructor() {
    super('noise filters need a 48 kHz context');
  }
}

class VoiceChain implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = CHAIN_NAME;
  processedTrack?: MediaStreamTrack;
  /** The filter running now. */
  noise: NoiseLevel;
  private ctx?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private model?: ModelNode;
  private gate?: AudioWorkletNode;
  private sink?: MediaStreamAudioDestinationNode;
  private localTrack?: LocalTrack;
  private threshold: number | null;
  /** The filter's model for the next init. */
  private model0: ArrayBuffer | null;
  private peak: number | null = null;
  private passing = true;
  /** Told when the chain took itself off. */
  onStall: () => void = () => undefined;

  constructor(threshold: number | null, noise: NoiseLevel, model: ArrayBuffer | null) {
    this.threshold = threshold;
    this.noise = model ? noise : 'off';
    this.model0 = model;
  }

  // Fails open by itself, whoever put it on: a context that stopped running
  // sends silence, so the chain comes off the microphone at once.
  private readonly watchState = () => {
    if (!this.ctx || this.ctx.state === 'running') return;
    void stopSafely(this.localTrack, this);
    this.onStall();
  };

  async init({ track, localTrack }: AudioProcessorOptions) {
    this.localTrack = localTrack;
    const ctx = voiceAudio();
    if (!ctx) throw new Error('no audio context');
    if (ctx.state !== 'running') {
      await Promise.race([
        ctx.resume().catch(() => undefined),
        new Promise((done) => window.setTimeout(done, 300)),
      ]);
    }
    // A context that is not running sends silence: never put the chain on one.
    if (ctx.state !== 'running') throw new NotRunning();
    try {
      await within(loadModule(ctx, gateWorkletUrl));
      const model =
        this.noise !== 'off' && this.model0 ? await makeModel(ctx, this.noise, this.model0) : undefined;
      const gate = new AudioWorkletNode(ctx, 'anonyma-send-gate', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { thresholdDb: this.threshold },
      });
      mono(gate);
      gate.port.onmessage = (event: MessageEvent<{ db: number; open: boolean }>) => {
        this.peak = Math.max(this.peak ?? -100, event.data.db);
        this.passing = event.data.open;
      };
      const sink = ctx.createMediaStreamDestination();
      mono(sink);
      if (model) model.connect(gate);
      gate.connect(sink);
      this.ctx = ctx;
      this.model = model;
      this.gate = gate;
      this.sink = sink;
      this.plug(track);
      this.processedTrack = sink.stream.getAudioTracks()[0];
      ctx.addEventListener('statechange', this.watchState);
    } catch (error) {
      await this.destroy();
      // The microphone refused into a 48 kHz context: from now on this page
      // builds at the device's rate (the gate works there; the filters not).
      if (
        error instanceof DOMException &&
        error.name === 'NotSupportedError' &&
        ctx.sampleRate === SAMPLE_RATE &&
        !rateLocked
      ) {
        rateLocked = true;
        releaseVoiceAudio();
        throw new RateRefused();
      }
      throw error;
    }
  }

  /** Feeds `track` into the chain (a new microphone: only the input changes). */
  private plug(track: MediaStreamTrack) {
    const ctx = this.ctx;
    const first = this.model ?? this.gate;
    if (!ctx || !first) throw new Error('voice chain not running');
    try {
      this.source?.disconnect();
    } catch {
      // Already gone.
    }
    this.source = ctx.createMediaStreamSource(new MediaStream([track]));
    this.source.connect(first);
  }

  async restart(opts: AudioProcessorOptions) {
    this.localTrack = opts.localTrack ?? this.localTrack;
    // The chain keeps its own context (LiveKit may pass the room's new one
    // after a reconnect: not ours). If ours was closed, it is built again.
    if (this.ctx && this.ctx.state !== 'closed' && this.gate) {
      this.plug(opts.track);
      return;
    }
    const model = this.noise !== 'off' ? await prepareModel(this.noise) : null;
    await this.destroy();
    this.model0 = model;
    await this.init(opts);
  }

  async destroy() {
    this.ctx?.removeEventListener('statechange', this.watchState);
    try {
      this.source?.disconnect();
      this.gate?.disconnect();
      this.sink?.disconnect();
    } catch {
      // Already gone with its context.
    }
    dropModel(this.model);
    if (this.gate) this.gate.port.onmessage = null;
    this.processedTrack?.stop();
    this.ctx = undefined;
    this.source = undefined;
    this.model = undefined;
    this.gate = undefined;
    this.sink = undefined;
    this.processedTrack = undefined;
    this.peak = null;
    this.passing = true;
  }

  setThreshold(db: number | null) {
    if (db === this.threshold) return;
    this.threshold = db;
    this.gate?.port.postMessage({ thresholdDb: db });
  }

  /** Swaps the filter inside the running chain; false if the chain went meanwhile. */
  async setNoise(level: NoiseLevel, model: ArrayBuffer | null): Promise<boolean> {
    const ctx = this.ctx;
    if (!ctx || !this.gate) return false;
    const next = level !== 'off' && model ? await makeModel(ctx, level, model) : undefined;
    if (this.ctx !== ctx || !this.gate) {
      dropModel(next);
      return false;
    }
    try {
      this.source?.disconnect();
    } catch {
      // Already gone.
    }
    if (next) {
      next.connect(this.gate);
      this.source?.connect(next);
    } else {
      this.source?.connect(this.gate);
    }
    dropModel(this.model);
    this.model = next;
    this.noise = next ? level : 'off';
    return true;
  }

  /** It is sending: its track is live and its context runs. */
  get healthy(): boolean {
    return this.processedTrack?.readyState === 'live' && this.ctx?.state === 'running';
  }

  /** The loudest level since the last call (dBFS); null before the first report. */
  takePeak(): number | null {
    const peak = this.peak;
    if (peak !== null) this.peak = -100;
    return peak;
  }

  get open(): boolean {
    return this.passing;
  }
}

export interface VoiceSettings {
  /** Input sensitivity (dBFS); null: off. */
  thresholdDb: number | null;
  noise: NoiseLevel;
}

export interface VoiceChainStatus {
  /** A chain is on the microphone now. */
  on: boolean;
  /** The filter running now. */
  noise: NoiseLevel;
  /** A filter being fetched and put in. */
  loading: NoiseLevel | null;
  /** A filter that would not start (the microphone goes without it until chosen again). */
  failed: NoiseLevel | null;
}

export interface VoiceChainControl {
  /**
   * Keep the chain on `track` as `settings` say (nothing on it with both
   * off). Cheap: call it as often as the call's state is read.
   */
  sync(track: LocalAudioTrack | undefined, settings: VoiceSettings): void;
  status(): VoiceChainStatus;
  /**
   * Your microphone's loudest level since the last call (dBFS), as the gate
   * measures it (after the filter, before cutting); null before its first
   * report or with no chain.
   */
  takeInputDb(): number | null;
  /** Whether the gate lets your voice out now; null while no chain is on. */
  passing(): boolean | null;
  /** Stop following the microphone (LiveKit ends the chain with the track). */
  close(): void;
}

export function createVoiceChain(): VoiceChainControl {
  let chain: VoiceChain | null = null;
  let chainTrack: LocalAudioTrack | undefined;
  let busy = false;
  let retryAt = 0;
  let closed = false;
  let loading: NoiseLevel | null = null;
  let failed: NoiseLevel | null = null;
  /** Starts that broke in a row (not a context waiting for a click): the wait grows. */
  let broken = 0;

  const backOff = (error: unknown) => {
    if (error instanceof RateRefused) {
      retryAt = 0; // built again at once, at the device's rate
      return;
    }
    if (error instanceof NotRunning) {
      retryAt = performance.now() + RETRY_MS;
      return;
    }
    broken += 1;
    retryAt = performance.now() + Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (broken - 1));
  };

  const follow = (track: LocalAudioTrack, mine: VoiceChain) => {
    chain = mine;
    chainTrack = track;
    mine.onStall = () => {
      // Off now (it took itself off); back on once the context runs again.
      retryAt = performance.now() + RETRY_MS;
      if (chain === mine) {
        chain = null;
        chainTrack = undefined;
      }
    };
  };

  const installed = (track: LocalAudioTrack | undefined): VoiceChain | null => {
    if (!track) return null;
    const current = track.getProcessor();
    if (chain && track === chainTrack && current === chain) return chain;
    // A chain this call put on before (the call's state was set up again):
    // follow it rather than stack another or leave it on forgotten.
    if (current instanceof VoiceChain) {
      follow(track, current);
      return current;
    }
    return null;
  };

  const takeOff = (track: LocalAudioTrack, mine: VoiceChain) => {
    busy = true;
    chain = null;
    chainTrack = undefined;
    void stopSafely(track, mine).finally(() => (busy = false));
  };

  return {
    sync(track, settings) {
      if (closed || busy) return;
      // A filter that would not start stays out until it is chosen again.
      if (failed !== null && failed !== settings.noise) failed = null;
      const noise: NoiseLevel = failed === settings.noise ? 'off' : settings.noise;
      const wanted = settings.thresholdDb !== null || noise !== 'off';
      const on = installed(track);
      // On, but not sending (a restart that failed, a context that stopped
      // without saying so): off now, so the microphone goes out as it is.
      if (on && track && !on.healthy) {
        retryAt = performance.now() + RETRY_MS;
        takeOff(track, on);
        return;
      }
      if (on && track && !wanted) {
        takeOff(track, on);
        return;
      }
      if (on) {
        on.setThreshold(settings.thresholdDb);
        if (on.noise !== noise) {
          busy = true;
          loading = noise === 'off' ? null : noise;
          warm(noise)
            .then((model) => on.setNoise(noise, model))
            .catch(() => {
              failed = noise;
            })
            .finally(() => {
              busy = false;
              loading = null;
            });
        }
        return;
      }
      // LiveKit ended the chain with its track (left, retried, republished).
      if (chain) {
        chain = null;
        chainTrack = undefined;
      }
      if (!track || !wanted || !canChainVoice || performance.now() < retryAt) return;
      busy = true;
      loading = noise === 'off' ? null : noise;
      warm(noise)
        .catch((error: unknown) => {
          // A filter that cannot load here stays out until chosen again; the
          // gate alone may still go on (the next sync).
          if (noise !== 'off') {
            failed = noise;
            retryAt = 0;
            throw new FilterUnavailable();
          }
          throw error;
        })
        .then(async (model) => {
          const next = new VoiceChain(settings.thresholdDb, noise, model);
          try {
            await track.setProcessor(next);
          } catch (error) {
            await next.destroy();
            // A filter that would not build (not a context waiting for a
            // click) is left out until chosen again; the gate alone may go on.
            if (noise !== 'off' && !(error instanceof NotRunning)) failed = noise;
            throw error;
          }
          if (closed) {
            await stopSafely(track, next);
            return;
          }
          broken = 0;
          follow(track, next);
        })
        .catch((error: unknown) => {
          if (error instanceof FilterUnavailable) return;
          backOff(error);
        })
        .finally(() => {
          busy = false;
          loading = null;
        });
    },
    status() {
      return { on: chain !== null, noise: chain?.noise ?? 'off', loading, failed };
    },
    takeInputDb() {
      return chain ? chain.takePeak() : null;
    },
    passing() {
      return chain ? chain.open : null;
    },
    close() {
      closed = true;
      chain = null;
      chainTrack = undefined;
    },
  };
}
