/**
 * Who is speaking, decided in this browser from the sound itself. This is the
 * pure part (no Web Audio), so `node --test` covers it; voiceMeter.ts feeds it.
 *
 * LiveKit's own active-speaker list is made on the server from windows of a
 * few hundred milliseconds, smoothed over several of them: it lights up most
 * of a second late and misses a one-word reply altogether.
 */

/** RMS level of a block of samples (-1..1) in dBFS; silence reads -100. */
export function rmsDb(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  return rms > 1e-5 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
}

export interface SpeechGateOptions {
  /** Never opens on anything quieter than this (dBFS). */
  minDb?: number;
  /** Opens this far above the room's noise floor (dB). */
  aboveFloorDb?: number;
  /** Once open, a level this far under the opening line still counts as voice (dB). */
  closeBelowDb?: number;
  /** Loud reads in a row before it opens (one stray click does not). */
  attackReads?: number;
  /** Stays open this long after the last voiced read (ms): the gaps between words. */
  holdMs?: number;
  /** A voice counts only if within this much of what the others sent lately (dB). */
  echoMarginDb?: number;
}

export interface SpeechGate {
  /**
   * One level read (dBFS) at `now` (ms); says whether the person is speaking.
   * `othersPeak`: the loudest the others sent lately (dBFS), which this
   * microphone may be hearing back as an echo.
   */
  push(db: number, now: number, othersPeak?: number): boolean;
  readonly open: boolean;
  readonly floor: number;
  /** When it last read voice while open (ms; -Infinity before). */
  readonly lastVoiced: number;
  /** It read real sound (not digital silence) in the last three seconds. */
  readonly hearing: boolean;
}

/** The noise floor is the quietest read of this long a stretch. */
const FLOOR_SPAN_MS = 3000;
const FLOOR_STEP_MS = 250;

export function createSpeechGate(options: SpeechGateOptions = {}): SpeechGate {
  const minDb = options.minDb ?? -48;
  const aboveFloor = options.aboveFloorDb ?? 12;
  const closeBelow = options.closeBelowDb ?? 6;
  const attackReads = Math.max(1, options.attackReads ?? 2);
  const holdMs = options.holdMs ?? 500;
  const echoMargin = options.echoMarginDb ?? 8;
  // The room's noise: the quietest read of the last three seconds (kept as
  // the quietest of each quarter second). Speech always has gaps between its
  // words that fall back to the room, so this tracks the room while someone
  // talks, follows a louder room (a fan coming on) within three seconds, and
  // never climbs to a voice that goes on and on.
  const steps: { at: number; min: number }[] = [];
  let floor = -100;
  let open = false;
  let loud = 0;
  let lastVoiced = -Infinity;
  return {
    get open() {
      return open;
    },
    get floor() {
      return floor;
    },
    get lastVoiced() {
      return lastVoiced;
    },
    get hearing() {
      return steps.length > 0;
    },
    push(db, now, othersPeak) {
      // Pure digital silence is no room at all (a microphone still starting,
      // a muted or paused sender): it would hold the floor at the bottom for
      // three seconds and let the room's own noise open the gate.
      if (db > -100) {
        const step = steps[steps.length - 1];
        if (step && now - step.at < FLOOR_STEP_MS) step.min = Math.min(step.min, db);
        else steps.push({ at: now, min: db });
      }
      while (steps.length > 0 && now - steps[0].at > FLOOR_SPAN_MS) steps.shift();
      floor = steps.length ? Math.min(-40, Math.max(-100, Math.min(...steps.map((s) => s.min)))) : -100;
      // Someone else's voice leaks into a microphone (their own sound from
      // this person's speakers, or a second device in the same room) and
      // comes back as a quieter, later copy of what they sent. So a voice
      // counts only if it is close to the loudest the others sent lately
      // (within echoMargin), both to open and to stay open: a reply or an
      // interruption is about as loud as them (the browsers' gain control
      // levels voices), the echo of their words is not.
      const quietAt = Math.max(minDb, floor + aboveFloor);
      const echoAt = othersPeak === undefined ? -Infinity : othersPeak - echoMargin;
      const openAt = Math.max(quietAt, echoAt);
      loud = db >= openAt ? loud + 1 : 0;
      if (open) {
        if (db >= Math.max(quietAt - closeBelow, echoAt)) lastVoiced = now;
        else if (now - lastVoiced > holdMs) open = false;
      } else if (loud >= attackReads) {
        open = true;
        lastVoiced = now;
      }
      return open;
    },
  };
}

export interface VoiceRoom {
  /**
   * Everyone's level read (dBFS, by identity) at `now` (ms). Says who is
   * speaking by ear, and whose meter hears real sound at all (for one that
   * does not, the caller may trust LiveKit's list instead).
   */
  push(levels: ReadonlyMap<string, number>, now: number): { speaking: Set<string>; hearing: Set<string> };
}

/**
 * How far back "the loudest the others sent lately" reaches: the echo of a
 * voice comes back one round trip later (to the far side and back, with
 * both sides' buffers).
 */
const ECHO_WINDOW_MS = 600;

/** One speech gate per person, each told how loud the others were lately. */
export function createVoiceRoom(options: SpeechGateOptions = {}): VoiceRoom {
  const gates = new Map<string, SpeechGate>();
  const recent = new Map<string, { at: number; db: number }[]>();
  return {
    push(levels, now) {
      // Each person's loudest lately, from reads before this one (so the
      // order of people in `levels` does not matter).
      const peaks = new Map<string, number>();
      for (const [id, reads] of recent) peaks.set(id, Math.max(-100, ...reads.map((r) => r.db)));
      const speaking = new Set<string>();
      const hearing = new Set<string>();
      for (const [id, db] of levels) {
        let gate = gates.get(id);
        if (!gate) {
          gate = createSpeechGate(options);
          gates.set(id, gate);
        }
        let othersPeak: number | undefined;
        for (const [other, peak] of peaks) {
          if (other !== id) othersPeak = Math.max(othersPeak ?? -100, peak);
        }
        if (gate.push(db, now, othersPeak)) speaking.add(id);
        if (gate.hearing) hearing.add(id);
        const reads = recent.get(id) ?? [];
        reads.push({ at: now, db });
        while (reads.length && now - reads[0].at > ECHO_WINDOW_MS) reads.shift();
        recent.set(id, reads);
      }
      for (const id of [...gates.keys()]) {
        if (levels.has(id)) continue;
        gates.delete(id);
        recent.delete(id);
      }
      return { speaking, hearing };
    },
  };
}
