import {
  cloneElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import {
  AudioPresets,
  ConnectionQuality,
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type Participant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type TrackPublication,
} from 'livekit-client';
import { api, errorStatus, type MatchMode } from '../../api/client';
import { PeerVolume } from './PeerVolume';
import { createVoiceMeters, type VoiceMeters } from './voiceMeter';
import { createVoiceRoom } from './voice';
import { InputSensitivity } from './InputSensitivity';
import { NoiseSuppression } from './NoiseSuppression';
import {
  canChainVoice,
  createVoiceChain,
  releaseVoiceAudio,
  wakeVoiceAudio,
  type VoiceChainControl,
  type VoiceChainStatus,
} from './voiceChain';
import {
  NOISE_PREF_KEY,
  SENSITIVITY_PREF_KEY,
  isApplePhoneOrTablet,
  parseNoise,
  parseSensitivity,
  type NoiseLevel,
} from './sensitivity';
import { BackgroundBlur, type BlurStatus } from './BackgroundBlur';
import { BLUR_PREF_KEY, canBlurBackground, parseBlur, type BlurLevel } from './cameraBlur';
import {
  createCameraBlur,
  preloadCameraBlur,
  setCameraBlurLevel,
  type CameraBlurHandle,
} from './blurProcessor';
import { MicShortcut } from './MicShortcut';
import {
  MIC_KEY_PREF_KEY,
  MIC_MODE_PREF_KEY,
  describeBinding,
  hasKeyboardLikely,
  isMacPlatform,
  isRelease,
  isTypingTarget,
  matchesPress,
  parseBinding,
  parseMicMode,
  serializeBinding,
  typesText,
  type KeyBinding,
  type MicShortcutMode,
} from './shortcutKeys';
import { wakeSlider, warmTooltip, warmTooltipGroup } from '../../ui/pieces';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import GlideSelect from '../../ui/reactbits/GlideSelect';
import VoicePill, { voicePillWaveWidth } from '../../ui/reactbits/VoicePill';
import BorderGlow from '../../ui/reactbits/BorderGlow';
import { usePageTheme } from '../../lib/usePageTheme';
import {
  SHARE_QUALITIES,
  canShareScreen,
  deviceOptions,
  gridCountClass,
  permissionHint,
  pickDeviceId,
  shareErrorHint,
  shareQuality,
  type MediaDeviceOption,
  type ShareQualityId,
} from './media';
import {
  LogOut,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  ScreenShare,
  ScreenShareOff,
  Settings,
  Video,
  VideoOff,
  iconStroke,
} from '../../ui/icons';

/** A dock button's tip: React Bits Warm Tooltip in the page's overlay colours;
 *  until the tooltip has loaded, the button keeps a plain title. */
function DockTip({
  label,
  children,
}: {
  label: string;
  children: ReactElement<{ title?: string }>;
}) {
  return (
    <warmTooltip.Piece
      fallback={cloneElement(children, { title: label })}
      content={label}
      side="top"
      size="sm"
      radius={10}
      gap={10}
      surfaceColor="var(--surface-overlay)"
      inkColor="var(--ink)"
    >
      {children}
    </warmTooltip.Piece>
  );
}

type CallState = 'preflight' | 'connecting' | 'live' | 'reconnecting' | 'error';

type PeerSnap = {
  identity: string;
  name: string;
  muted: boolean;
  cameraOff: boolean;
  speaking: boolean;
  quality: ConnectionQuality;
};

const MIC_PREF_KEY = 'anonyma.micDeviceId';
const CAM_PREF_KEY = 'anonyma.camDeviceId';
const SHARE_PREF_KEY = 'anonyma.shareQuality';

/** A screen someone is sharing (at most one per person). */
type ShareSnap = {
  /** The sharer's identity. */
  key: string;
  name: string;
  local: boolean;
  /** The track's id: sharing again is a new share. */
  sid: string;
};

/** Everyone's shared screens, in the order they began (the newest last). */
function listShares(room: Room, order: Map<string, number>): ShareSnap[] {
  const out: ShareSnap[] = [];
  const own = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
  if (own?.track && !own.isMuted) {
    out.push({ key: room.localParticipant.identity, name: 'You', local: true, sid: own.trackSid });
  }
  for (const p of room.remoteParticipants.values()) {
    const pub = p.getTrackPublication(Track.Source.ScreenShare);
    if (!pub?.track || pub.isMuted) continue;
    const name = p.name?.trim() || p.identity.slice(0, 8) || 'Peer';
    out.push({ key: p.identity, name, local: false, sid: pub.trackSid });
  }
  const seen = new Set(out.map((s) => s.sid));
  for (const sid of [...order.keys()]) if (!seen.has(sid)) order.delete(sid);
  let next = Math.max(0, ...order.values()) + 1;
  for (const s of out) if (!order.has(s.sid)) order.set(s.sid, next++);
  return out.sort((a, b) => (order.get(a.sid) ?? 0) - (order.get(b.sid) ?? 0));
}

function qualityLabel(q: ConnectionQuality): string | null {
  if (q === ConnectionQuality.Poor) return 'Weak link';
  // Lost is often transient during ICE; keep copy mild and avoid "can't connect" panic.
  if (q === ConnectionQuality.Lost) return 'Link unstable';
  return null;
}

function snapFromRemote(p: RemoteParticipant, speakingIds: Set<string>): PeerSnap {
  return {
    identity: p.identity,
    name: p.name?.trim() || p.identity.slice(0, 8) || 'Peer',
    muted: !p.isMicrophoneEnabled,
    cameraOff: !p.isCameraEnabled,
    speaking: speakingIds.has(p.identity),
    quality: p.connectionQuality,
  };
}

function peerQualityHint(q: ConnectionQuality): string | null {
  if (q === ConnectionQuality.Poor) return 'Weak';
  if (q === ConnectionQuality.Lost) return 'Lost';
  return null;
}

function readPref(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writePref(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function DeviceSelects(props: {
  mode: 'voice' | 'video';
  mics: MediaDeviceOption[];
  cams: MediaDeviceOption[];
  micId: string;
  camId: string;
  onMic: (id: string) => void;
  onCam: (id: string) => void;
  disabled?: boolean;
}) {
  const { mode, mics, cams, micId, camId, onMic, onCam, disabled } = props;
  if (mics.length === 0 && (mode !== 'video' || cams.length === 0)) return null;
  // React Bits Glide Select: a highlight glides to the option under the pointer
  // (or the keys). Colours are the theme's, so it follows the stage tokens.
  const look = {
    size: 'lg' as const,
    showTags: false,
    accentColor: 'var(--accent)',
    surfaceColor: 'var(--surface-overlay)',
    highlightColor: 'color-mix(in srgb, var(--accent) 18%, var(--surface-overlay))',
    textColor: 'var(--ink)',
    className: 'media-device-glide',
  };
  return (
    <div className="media-device-fields">
      {mics.length > 0 ? (
        <div className="media-device-field">
          <span aria-hidden="true">Microphone</span>
          <GlideSelect
            {...look}
            ariaLabel="Microphone"
            options={mics.map((d) => ({ value: d.deviceId, label: d.label }))}
            value={micId}
            disabled={disabled || mics.length < 2}
            onChange={(v) => onMic(v)}
          />
        </div>
      ) : null}
      {mode === 'video' && cams.length > 0 ? (
        <div className="media-device-field">
          <span aria-hidden="true">Camera</span>
          <GlideSelect
            {...look}
            ariaLabel="Camera"
            options={cams.map((d) => ({ value: d.deviceId, label: d.label }))}
            value={camId}
            disabled={disabled || cams.length < 2}
            onChange={(v) => onCam(v)}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The element is showing a camera track that still delivers frames. */
function hasLiveVideo(el: HTMLVideoElement): boolean {
  const stream = el.srcObject;
  return (
    stream instanceof MediaStream && stream.getVideoTracks().some((t) => t.readyState === 'live')
  );
}

/** Background blur would not start: the camera stays off (nothing unblurred is sent). */
class BlurFailed extends Error {}
/**
 * How long turning blur on may take: the first time loads its runtime and
 * model (~3 MB compressed) on what may be a slow link. Nothing is sent meanwhile.
 */
const BLUR_SETUP_MS = 45_000;
function within<T>(step: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('timed out')), ms);
    step.then(
      (v) => {
        window.clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        window.clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function attachTrackToVideo(
  track: { attach: (el: HTMLMediaElement) => HTMLMediaElement },
  el: HTMLVideoElement,
): void {
  track.attach(el);
  el.muted = true;
  el.playsInline = true;
  void el.play().catch(() => undefined);
}

export function MediaCall(props: {
  roomId: string;
  mode: Extract<MatchMode, 'voice' | 'video'>;
  nickname: string;
  peerNickname?: string;
  /** Re-join chat membership if voice token fails with "not a room member". */
  ensureMember?: () => Promise<void>;
  onLeave: () => void | Promise<void>;
  /** Notify parent of call connection state (soft chat toast when live). */
  onCallStateChange?: (state: CallState) => void;
}) {
  const { roomId, mode, nickname, peerNickname, ensureMember, onLeave, onCallStateChange } = props;
  // Per-person volume sliders, ready before the first tile.
  useEffect(() => void wakeSlider.preload(), []);
  const [state, setState] = useState<CallState>('preflight');
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(mode === 'voice');
  /** True once local self-tile has real frames (videoWidth > 0), not merely attach(). */
  const [localCamLive, setLocalCamLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [peers, setPeers] = useState<PeerSnap[]>([]);
  const [localSpeaking, setLocalSpeaking] = useState(false);
  const pageTheme = usePageTheme();
  const [linkHint, setLinkHint] = useState<string | null>(null);
  /** The browser blocked sound until the person interacts (autoplay policy). */
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [mics, setMics] = useState<MediaDeviceOption[]>([]);
  const [cams, setCams] = useState<MediaDeviceOption[]>([]);
  const [micId, setMicId] = useState(() => readPref(MIC_PREF_KEY));
  const [camId, setCamId] = useState(() => readPref(CAM_PREF_KEY));
  const [devicesOpen, setDevicesOpen] = useState(false);
  /** Input sensitivity (dBFS): your sound under it is not sent; null is off (voiceChain.ts). */
  const [sensitivity, setSensitivity] = useState(() =>
    parseSensitivity(readPref(SENSITIVITY_PREF_KEY)),
  );
  /** Noise suppression on top of the browser's own (voiceChain.ts). */
  const [noise, setNoise] = useState(() => parseNoise(readPref(NOISE_PREF_KEY)));
  // Not offered on iPhone / iPad (sensitivity.ts): a stored choice is ignored there.
  const [noiseOffered] = useState(
    () =>
      canChainVoice &&
      (typeof navigator === 'undefined' ||
        !isApplePhoneOrTablet(navigator.userAgent, navigator.maxTouchPoints)),
  );
  /** Background blur on your camera (blurProcessor.ts); not on iPhone / iPad. */
  const [blurOffered] = useState(
    () =>
      mode === 'video' &&
      canBlurBackground() &&
      (typeof navigator === 'undefined' ||
        !isApplePhoneOrTablet(navigator.userAgent, navigator.maxTouchPoints)),
  );
  const [blur, setBlur] = useState(() => parseBlur(readPref(BLUR_PREF_KEY)));
  // A video call opening with blur on fetches it during the preflight.
  useEffect(() => {
    if (blurOffered && parseBlur(readPref(BLUR_PREF_KEY)) !== 'off') preloadCameraBlur();
  }, [blurOffered]);
  /** The microphone's keyboard shortcut (shortcutKeys.ts): only with a keyboard about. */
  const [shortcutOffered] = useState(() => hasKeyboardLikely());
  const [onMac] = useState(
    () => typeof navigator !== 'undefined' && isMacPlatform(navigator.userAgent),
  );
  const [micMode, setMicMode] = useState(() => parseMicMode(readPref(MIC_MODE_PREF_KEY)));
  const [micKey, setMicKey] = useState(() => parseBinding(readPref(MIC_KEY_PREF_KEY)));
  const [previewTick, setPreviewTick] = useState(0);
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const [previewReady, setPreviewReady] = useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  // Screen sharing: everyone's shared screens, the one on the big stage, and
  // the share panel (quality, start / stop).
  const shareSupported = canShareScreen(
    typeof navigator === 'undefined' ? undefined : navigator.mediaDevices,
  );
  const [shares, setShares] = useState<ShareSnap[]>([]);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareQualityId, setShareQualityId] = useState<ShareQualityId>(
    () => shareQuality(readPref(SHARE_PREF_KEY)).id,
  );
  const [shareVideoEl, setShareVideoEl] = useState<HTMLVideoElement | null>(null);
  const [shareFull, setShareFull] = useState(false);
  const roomRef = useRef<Room | null>(null);
  /** Who is speaking now: heard here (heardRef) or on LiveKit's list. */
  const speakingIdsRef = useRef<Set<string>>(new Set());
  /** LiveKit's active speakers (the server's list: late, but works anywhere). */
  const serverSpeakersRef = useRef<Set<string>>(new Set());
  /** Who this browser hears speaking, from the sound itself (voiceMeter.ts). */
  const heardRef = useRef<Set<string>>(new Set());
  /** Whose meter hears real sound at all (theirs is the verdict, not LiveKit's). */
  const hearingRef = useRef<Set<string>>(new Set());
  const metersRef = useRef<VoiceMeters | null>(null);
  const voiceChainRef = useRef<VoiceChainControl | null>(null);
  const sensitivityRef = useRef(sensitivity);
  sensitivityRef.current = sensitivity;
  const noiseRef = useRef<NoiseLevel>(noiseOffered ? noise : 'off');
  noiseRef.current = noiseOffered ? noise : 'off';
  const blurRef = useRef<BlurLevel>(blurOffered ? blur : 'off');
  blurRef.current = blurOffered ? blur : 'off';
  /** The blur on the camera track now, and that track (a new track needs a new one). */
  const cameraBlurRef = useRef<{ track: LocalVideoTrack; handle: CameraBlurHandle } | null>(null);
  /** Blur would not run: the camera was turned off for it, until it is tried again. */
  const blurFailedRef = useRef(false);
  /** Blur being turned on right now (its script or model still loading). */
  const blurBusyRef = useRef(0);
  /** Camera changes, one at a time (button, blur level, blur failing). */
  const cameraOpsRef = useRef<Promise<void>>(Promise.resolve());
  const micModeRef = useRef<MicShortcutMode>(shortcutOffered ? micMode : 'toggle');
  micModeRef.current = shortcutOffered ? micMode : 'toggle';
  const micKeyRef = useRef<KeyBinding>(micKey);
  micKeyRef.current = micKey;
  /** The settings' key recorder is listening: the shortcut stands aside. */
  const recordingKeyRef = useRef(false);
  /** Microphone on/off wished for and not yet applied (the last wish wins). */
  const micWantRef = useRef<boolean | null>(null);
  const micBusyRef = useRef(false);
  /** Push to talk: the key is held now. */
  const holdingRef = useRef(false);
  /** The key press the shortcut took, so its keyup is not a click as well. */
  const pressedCodeRef = useRef<string | null>(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const volumesRef = useRef<Record<string, number>>({});
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);
  /**
   * Every camera/mic track this component opened itself (the preflight
   * preview). The preview's video keeps painting the self tile while LiveKit
   * opens its own camera, so it outlives previewStreamRef: without this set it
   * was dropped from bookkeeping still live, and the camera stayed on after
   * leaving the call.
   */
  const ownedTracksRef = useRef(new Set<MediaStreamTrack>());
  const remoteVideoEls = useRef(new Map<string, HTMLVideoElement>());
  const remoteAudioEls = useRef(new Map<string, HTMLAudioElement>());
  /** The sound of a shared tab, one element per sharer. */
  const shareAudioEls = useRef(new Map<string, HTMLAudioElement>());
  const sharesRef = useRef<ShareSnap[]>([]);
  const shareOrderRef = useRef(new Map<string, number>());
  const shareQualityRef = useRef(shareQualityId);
  const shareStageRef = useRef<HTMLDivElement | null>(null);
  const leavingRef = useRef(false);
  const cancelledRef = useRef(false);
  const autoJoinStarted = useRef(false);
  const localCamWatchRef = useRef<number | null>(null);
  const micIdRef = useRef(micId);
  const camIdRef = useRef(camId);
  micIdRef.current = micId;
  camIdRef.current = camId;
  volumesRef.current = volumes;

  useEffect(() => {
    onCallStateChange?.(state);
  }, [state, onCallStateChange]);

  /** Stop tracks this component opened (all, or one kind). */
  const releaseOwned = useCallback((kind?: 'audio' | 'video') => {
    for (const track of ownedTracksRef.current) {
      if (kind && track.kind !== kind) continue;
      track.stop();
      ownedTracksRef.current.delete(track);
    }
  }, []);

  const stopLocalCamWatch = useCallback(() => {
    if (localCamWatchRef.current != null) {
      window.clearInterval(localCamWatchRef.current);
      localCamWatchRef.current = null;
    }
  }, []);

  const watchLocalCamFrames = useCallback(
    (el: HTMLVideoElement) => {
      stopLocalCamWatch();
      const mark = () => {
        if (el.videoWidth > 0 && el.srcObject) {
          setLocalCamLive(true);
          stopLocalCamWatch();
        }
      };
      mark();
      el.addEventListener('loadeddata', mark);
      el.addEventListener('playing', mark);
      localCamWatchRef.current = window.setInterval(mark, 200);
      window.setTimeout(() => {
        el.removeEventListener('loadeddata', mark);
        el.removeEventListener('playing', mark);
        stopLocalCamWatch();
      }, 8_000);
    },
    [stopLocalCamWatch],
  );

  const attachLocalCamToEl = useCallback(
    (el: HTMLVideoElement | null): boolean => {
      if (!el) return false;
      const room = roomRef.current;
      if (!room || cameraOff) return false;
      const cam = [...room.localParticipant.trackPublications.values()].find(
        (p) => p.source === Track.Source.Camera,
      );
      if (!cam?.track || cam.isMuted) {
        // Not published yet: leave the preview mirror painting. Covering it with
        // the avatar on every retry made the self tile flash while connecting.
        if (cam?.isMuted || !hasLiveVideo(el)) setLocalCamLive(false);
        return false;
      }
      attachTrackToVideo(cam.track, el);
      watchLocalCamFrames(el);
      // LiveKit's camera paints the tile now: the preview camera is done.
      releaseOwned('video');
      return true;
    },
    [cameraOff, watchLocalCamFrames, releaseOwned],
  );

  const bindLocalVideo = useCallback(
    (el: HTMLVideoElement | null) => {
      localVideoRef.current = el;
      if (!el) {
        stopLocalCamWatch();
        return;
      }
      attachLocalCamToEl(el);
    },
    [attachLocalCamToEl, stopLocalCamWatch],
  );

  const refreshPeers = useCallback((room: Room) => {
    const list = [...room.remoteParticipants.values()].map((p) =>
      snapFromRemote(p, speakingIdsRef.current),
    );
    setPeers(list);
    // Shared screens: a new one takes the stage; when the one on it ends, the
    // newest left takes over.
    const next = listShares(room, shareOrderRef.current);
    const prev = sharesRef.current;
    const same =
      next.length === prev.length &&
      next.every((s, i) => s.sid === prev[i]?.sid && s.name === prev[i]?.name);
    if (same) return;
    const fresh = next.filter((s) => !prev.some((p) => p.sid === s.sid));
    sharesRef.current = next;
    setShares(next);
    setFocusKey((cur) =>
      fresh.length
        ? fresh[fresh.length - 1]!.key
        : next.some((s) => s.key === cur)
          ? cur
          : (next[next.length - 1]?.key ?? null),
    );
  }, []);

  // Someone speaks when this browser hears them speak. LiveKit's list only
  // stands in for a person whose meter hears no sound at all (no Web Audio, a
  // browser still holding sound back): a meter that hears decides, so the
  // server cannot light up a voice the ear here judged an echo.
  const applySpeaking = useCallback(
    (room: Room) => {
      const ids = new Set(heardRef.current);
      for (const id of serverSpeakersRef.current) if (!hearingRef.current.has(id)) ids.add(id);
      const prev = speakingIdsRef.current;
      if (ids.size === prev.size && [...ids].every((id) => prev.has(id))) return;
      speakingIdsRef.current = ids;
      setLocalSpeaking(ids.has(room.localParticipant.identity));
      refreshPeers(room);
    },
    [refreshPeers],
  );

  const attachRemote = useCallback(
    (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (publication.source === Track.Source.Camera) {
        const el = remoteVideoEls.current.get(participant.identity);
        if (el) track.attach(el);
      }
      if (publication.source === Track.Source.Microphone) {
        const el = remoteAudioEls.current.get(participant.identity);
        if (el) {
          track.attach(el);
          el.volume = volumesRef.current[participant.identity] ?? 1;
        }
      }
      // A shared tab's sound plays from its own element, at the sharer's volume.
      if (publication.source === Track.Source.ScreenShareAudio) {
        const el = track.attach() as HTMLAudioElement;
        el.volume = volumesRef.current[participant.identity] ?? 1;
        shareAudioEls.current.set(participant.identity, el);
      }
    },
    [],
  );

  const bindRemoteVideo = useCallback((identity: string, el: HTMLVideoElement | null) => {
    if (!el) {
      remoteVideoEls.current.delete(identity);
      return;
    }
    remoteVideoEls.current.set(identity, el);
    const room = roomRef.current;
    const participant = room?.remoteParticipants.get(identity);
    if (!participant) return;
    participant.trackPublications.forEach((pub) => {
      if (pub.source === Track.Source.Camera && pub.track) {
        pub.track.attach(el);
      }
    });
  }, []);

  const bindRemoteAudio = useCallback((identity: string, el: HTMLAudioElement | null) => {
    if (!el) {
      remoteAudioEls.current.delete(identity);
      return;
    }
    remoteAudioEls.current.set(identity, el);
    el.volume = volumesRef.current[identity] ?? 1;
    const room = roomRef.current;
    const participant = room?.remoteParticipants.get(identity);
    if (!participant) return;
    participant.trackPublications.forEach((pub) => {
      if (pub.source === Track.Source.Microphone && pub.track) {
        pub.track.attach(el);
      }
    });
  }, []);

  function setPeerVolume(identity: string, value: number) {
    const next = Math.min(1, Math.max(0, value));
    setVolumes((prev) => ({ ...prev, [identity]: next }));
    const el = remoteAudioEls.current.get(identity);
    if (el) el.volume = next;
    const tab = shareAudioEls.current.get(identity);
    if (tab) tab.volume = next;
  }

  function stopPreview() {
    previewStreamRef.current?.getTracks().forEach((t) => t.stop());
    releaseOwned();
    previewStreamRef.current = null;
    if (previewRef.current) previewRef.current.srcObject = null;
    setPreviewReady(false);
  }

  async function refreshDeviceLists() {
    try {
      const { mics: nextMics, cams: nextCams } = deviceOptions(
        await navigator.mediaDevices.enumerateDevices(),
      );
      setMics(nextMics);
      setCams(nextCams);
      setMicId((prev) => {
        const next = pickDeviceId(nextMics, prev || readPref(MIC_PREF_KEY));
        if (next) writePref(MIC_PREF_KEY, next);
        return next;
      });
      if (mode === 'video') {
        setCamId((prev) => {
          const next = pickDeviceId(nextCams, prev || readPref(CAM_PREF_KEY));
          if (next) writePref(CAM_PREF_KEY, next);
          return next;
        });
      }
    } catch {
      /* ignore enumerate failures */
    }
  }

  useEffect(() => {
    cancelledRef.current = false;
    let active = true;

    async function startPreview() {
      try {
        const audioConstraint: MediaTrackConstraints = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          ...(micIdRef.current ? { deviceId: { ideal: micIdRef.current } } : {}),
        };
        const videoConstraint: MediaTrackConstraints | boolean =
          mode === 'video'
            ? camIdRef.current
              ? { deviceId: { ideal: camIdRef.current }, facingMode: 'user' }
              : { facingMode: 'user' }
            : false;
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraint,
          video: videoConstraint,
        });
        if (!active || cancelledRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        stopPreview();
        previewStreamRef.current = stream;
        stream.getTracks().forEach((t) => ownedTracksRef.current.add(t));
        if (previewRef.current && mode === 'video') {
          previewRef.current.srcObject = stream;
        }
        const usedMic = stream.getAudioTracks()[0]?.getSettings().deviceId;
        const usedCam = stream.getVideoTracks()[0]?.getSettings().deviceId;
        if (usedMic) {
          setMicId(usedMic);
          writePref(MIC_PREF_KEY, usedMic);
        }
        if (usedCam && mode === 'video') {
          setCamId(usedCam);
          writePref(CAM_PREF_KEY, usedCam);
        }
        await refreshDeviceLists();
        // Don't wipe a connection failure while restarting preview on error state.
        if (state === 'preflight') setError(null);
        if (active) setPreviewReady(true);
      } catch (err) {
        if (active) {
          setPreviewReady(false);
          setError(permissionHint(err, mode));
        }
      }
    }

    if (state === 'preflight' || state === 'error') {
      void startPreview();
    }

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- previewTick forces restart on device change
  }, [mode, state, attempt, previewTick]);

  useEffect(() => {
    function onDeviceChange() {
      void refreshDeviceLists();
    }
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Auto-join once mic/camera preview is ready so peers aren't stuck waiting on text-only.
  useEffect(() => {
    if (state !== 'preflight' || error || !previewReady) return;
    if (autoJoinStarted.current) return;
    autoJoinStarted.current = true;
    const t = window.setTimeout(() => {
      if (!cancelledRef.current) void connectCall();
    }, 450);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, error, previewReady]);

  useEffect(() => {
    // The maps live as long as the component; take them now for the cleanup.
    const videoEls = remoteVideoEls.current;
    const audioEls = remoteAudioEls.current;
    return () => {
      cancelledRef.current = true;
      stopPreview();
      void roomRef.current?.disconnect();
      roomRef.current = null;
      videoEls.clear();
      audioEls.clear();
    };
    // Unmount only. stopPreview reads refs (and a setter), so the first one is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!devicesOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setDevicesOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [devicesOpen]);

  // Attach local camera after the live <video> mounts (connectCall often runs while ref is null).
  useEffect(() => {
    if (mode !== 'video') return;
    if (cameraOff) {
      setLocalCamLive(false);
      stopLocalCamWatch();
      return;
    }
    if (state !== 'live' && state !== 'reconnecting' && state !== 'connecting') return;

    if (attachLocalCamToEl(localVideoRef.current)) return;
    const raf = requestAnimationFrame(() => {
      attachLocalCamToEl(localVideoRef.current);
    });
    const t1 = window.setTimeout(() => attachLocalCamToEl(localVideoRef.current), 120);
    const t2 = window.setTimeout(() => attachLocalCamToEl(localVideoRef.current), 500);
    const t3 = window.setTimeout(() => attachLocalCamToEl(localVideoRef.current), 1500);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, [state, cameraOff, mode, attempt, attachLocalCamToEl, stopLocalCamWatch]);

  async function selectMic(id: string) {
    setMicId(id);
    writePref(MIC_PREF_KEY, id);
    const room = roomRef.current;
    if (room && (state === 'live' || state === 'reconnecting')) {
      try {
        await room.switchActiveDevice('audioinput', id);
      } catch (err) {
        setError(permissionHint(err, mode));
      }
      return;
    }
    if (state === 'preflight' || state === 'error') setPreviewTick((n) => n + 1);
  }

  async function selectCam(id: string) {
    setCamId(id);
    writePref(CAM_PREF_KEY, id);
    const room = roomRef.current;
    if (room && (state === 'live' || state === 'reconnecting')) {
      try {
        await room.switchActiveDevice('videoinput', id);
        attachLocalCamToEl(localVideoRef.current);
      } catch (err) {
        setError(permissionHint(err, mode));
      }
      return;
    }
    if (state === 'preflight' || state === 'error') setPreviewTick((n) => n + 1);
  }

  function mirrorPreviewToSelfTile() {
    if (mode !== 'video' || cameraOff) return;
    const el = localVideoRef.current;
    const preview = previewStreamRef.current;
    const vt = preview?.getVideoTracks().find((t) => t.readyState === 'live');
    if (!el || !vt) return;
    // Already painting (this preview, or LiveKit's camera): a new stream object
    // would reload the element, and the retries made the tile flash.
    if (hasLiveVideo(el)) return;
    el.srcObject = new MediaStream([vt]);
    el.muted = true;
    el.playsInline = true;
    void el.play().catch(() => undefined);
    watchLocalCamFrames(el);
  }

  async function connectCall() {
    // Keep preview video on the self tile until LiveKit camera publish attaches (FN-14).
    setLocalCamLive(false);
    setError(null);
    setState('connecting');
    setPeers([]);
    setLinkHint(null);
    setDevicesOpen(false);
    // Live grid mounts on this state change — mirror preview as soon as the el exists.
    requestAnimationFrame(() => mirrorPreviewToSelfTile());
    window.setTimeout(() => mirrorPreviewToSelfTile(), 50);
    window.setTimeout(() => mirrorPreviewToSelfTile(), 200);

    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        ...(micId ? { deviceId: micId } : {}),
      },
      publishDefaults: {
        // Speech-optimized Opus; DTX/RED help on lossy links.
        audioPreset: AudioPresets.speech,
        dtx: true,
        red: true,
      },
      videoCaptureDefaults: mode === 'video' && camId ? { deviceId: camId } : undefined,
    });
    roomRef.current = room;
    cameraBlurRef.current = null;
    // A new connection (first join or Retry) starts with no shared screens.
    sharesRef.current = [];
    setShares([]);
    setFocusKey(null);

    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      attachRemote(track, publication, participant);
      refreshPeers(room);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      track.detach();
      if (publication.source === Track.Source.ScreenShareAudio) {
        shareAudioEls.current.delete(participant.identity);
      }
      refreshPeers(room);
    });
    // A second word that a screen is gone (the publication has left the list
    // by now), in case the unsubscribe came first or not at all.
    room.on(RoomEvent.TrackUnpublished, () => refreshPeers(room));
    room.on(RoomEvent.TrackMuted, (publication: TrackPublication, participant: Participant) => {
      if (participant.isLocal) {
        if (publication.source === Track.Source.Microphone) setMuted(true);
        if (publication.source === Track.Source.Camera) {
          setCameraOff(true);
          setLocalCamLive(false);
          stopLocalCamWatch();
        }
        return;
      }
      refreshPeers(room);
    });
    room.on(RoomEvent.TrackUnmuted, (publication: TrackPublication, participant: Participant) => {
      if (participant.isLocal) {
        if (publication.source === Track.Source.Microphone) setMuted(false);
        if (publication.source === Track.Source.Camera) {
          setCameraOff(false);
          if (publication.track && localVideoRef.current) {
            attachTrackToVideo(publication.track, localVideoRef.current);
            watchLocalCamFrames(localVideoRef.current);
          }
        }
        return;
      }
      refreshPeers(room);
    });
    room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
      refreshPeers(room);
      participant.trackPublications.forEach((pub) => {
        if (pub.track) attachRemote(pub.track, pub, participant);
      });
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      setVolumes((prev) => {
        if (!(participant.identity in prev)) return prev;
        const next = { ...prev };
        delete next[participant.identity];
        return next;
      });
      refreshPeers(room);
    });
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      serverSpeakersRef.current = new Set(speakers.map((s) => s.identity));
      applySpeaking(room);
    });
    room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (participant.isLocal) {
        const hint = qualityLabel(quality);
        setLinkHint(hint);
      } else {
        refreshPeers(room);
      }
    });
    // LiveKit says Connected inside room.connect(), before the microphone (and
    // camera) are published below; the call only turns live once they are, or
    // the controls (and the dock's level meter) would act on a call without them.
    let settingUp = true;
    let reconnectFlashTimer: number | null = null;
    const armReconnecting = () => {
      if (cancelledRef.current) return;
      // Debounce brief SignalReconnecting blips during mute/track renegotiation.
      if (reconnectFlashTimer != null) window.clearTimeout(reconnectFlashTimer);
      reconnectFlashTimer = window.setTimeout(() => {
        reconnectFlashTimer = null;
        if (cancelledRef.current) return;
        if (room.state === ConnectionState.Reconnecting) setState('reconnecting');
      }, 400);
    };
    const clearReconnecting = () => {
      if (reconnectFlashTimer != null) {
        window.clearTimeout(reconnectFlashTimer);
        reconnectFlashTimer = null;
      }
      if (!cancelledRef.current && !settingUp) {
        setLinkHint(null);
        setState('live');
      }
    };
    room.on(RoomEvent.Reconnecting, armReconnecting);
    room.on(RoomEvent.SignalReconnecting, armReconnecting);
    room.on(RoomEvent.Reconnected, clearReconnecting);
    // Authoritative sync — mute/track renegotiation can fire SignalReconnecting without Reconnected.
    room.on(RoomEvent.ConnectionStateChanged, (cs) => {
      if (cancelledRef.current) return;
      if (cs === ConnectionState.Connected) {
        clearReconnecting();
      } else if (cs === ConnectionState.Reconnecting) {
        armReconnecting();
      }
    });
    // LiveKit gave up (server ended the room, network lost for good, kicked by a
    // second tab). Before, the call kept looking live or stuck on "Reconnecting…"
    // with no way out; now it shows the error state with Retry.
    room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (cancelledRef.current || reason === DisconnectReason.CLIENT_INITIATED) return;
      if (roomRef.current !== room) return;
      roomRef.current = null;
      releaseOwned();
      setLinkHint(null);
      setError(
        reason === DisconnectReason.DUPLICATE_IDENTITY
          ? 'This call opened in another tab. Retry to bring it back here.'
          : reason === DisconnectReason.PARTICIPANT_REMOVED
            ? 'You left this room, so the call ended.'
            : 'The call dropped. Retry to reconnect.',
      );
      setState('error');
    });
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      setAudioBlocked(!room.canPlaybackAudio);
    });
    room.on(RoomEvent.LocalTrackPublished, (publication) => {
      if (publication.source === Track.Source.ScreenShare) {
        // Also after a reconnect publishes it again: keep the chosen quality.
        void applyShareQuality();
        refreshPeers(room);
        return;
      }
      if (publication.source !== Track.Source.Camera) return;
      setCameraOff(false);
      if (localVideoRef.current && publication.track) {
        attachTrackToVideo(publication.track, localVideoRef.current);
        watchLocalCamFrames(localVideoRef.current);
        releaseOwned('video');
      }
    });

    room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
      if (publication.source === Track.Source.ScreenShare) refreshPeers(room);
    });

    try {
      let creds: { url: string; token: string; roomName: string };
      try {
        creds = await api.joinVoice(roomId, nickname);
      } catch (voiceErr) {
        const voiceMsg = (voiceErr as Error).message || '';
        // Branch on the status: the message is already humanized ("Join this room
        // to continue."), so the old text match never fired.
        const notMember =
          errorStatus(voiceErr) === 403 || /not a room member|join this room/i.test(voiceMsg);
        if (ensureMember && notMember) {
          await ensureMember();
          if (cancelledRef.current) return;
          creds = await api.joinVoice(roomId, nickname);
        } else {
          throw voiceErr;
        }
      }
      if (cancelledRef.current) {
        stopPreview();
        return;
      }
      // Left (unmounted / Leave) while a step was in flight: close what that
      // step opened, or a camera started after leaving stays on.
      const abandon = async () => {
        for (const pub of room.localParticipant.trackPublications.values()) pub.track?.stop();
        try {
          await room.disconnect();
        } catch {
          /* ignore */
        }
        stopPreview();
      };
      await room.connect(creds.url, creds.token);
      if (cancelledRef.current) {
        await abandon();
        return;
      }
      mirrorPreviewToSelfTile();
      // Free the preview mic so LiveKit can acquire audio without an exclusive-device clash.
      releaseOwned('audio');
      try {
        const micOptions = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          ...(micId ? { deviceId: micId } : {}),
        };
        if (micModeRef.current === 'hold') {
          // Push to talk: published already muted, so not even the first
          // moment of the room goes out before the key is held.
          const [mic] = await room.localParticipant.createTracks({ audio: micOptions });
          if (!mic) throw new Error('No microphone');
          try {
            await mic.mute();
            await room.localParticipant.publishTrack(mic);
          } catch (err) {
            mic.stop();
            throw err;
          }
          setMuted(true);
        } else {
          await room.localParticipant.setMicrophoneEnabled(true, micOptions);
          setMuted(false);
        }
      } catch (micErr) {
        setMuted(true);
        if (!cancelledRef.current) {
          setError(permissionHint(micErr, mode));
        }
      }
      if (cancelledRef.current) {
        await abandon();
        return;
      }
      if (mode === 'video') {
        try {
          // Prefer a second camera open while preview video still paints the self tile.
          try {
            await cameraOp(() => startCamera(room));
          } catch (firstErr) {
            if (firstErr instanceof BlurFailed) throw firstErr;
            // Some browsers won't allow two cameras — release preview video, then reacquire.
            releaseOwned('video');
            await new Promise((r) => window.setTimeout(r, 200));
            await cameraOp(() => startCamera(room));
          }
          setCameraOff(false);
          const cam = [...room.localParticipant.trackPublications.values()].find(
            (p: LocalTrackPublication) => p.source === Track.Source.Camera,
          );
          if (cancelledRef.current) {
            await abandon();
            return;
          }
          if (cam?.track && localVideoRef.current) {
            attachTrackToVideo(cam.track, localVideoRef.current);
            watchLocalCamFrames(localVideoRef.current);
            releaseOwned('video');
          } else {
            mirrorPreviewToSelfTile();
            window.setTimeout(() => attachLocalCamToEl(localVideoRef.current), 80);
            window.setTimeout(() => attachLocalCamToEl(localVideoRef.current), 400);
          }
        } catch (camErr) {
          if (cancelledRef.current) {
            await abandon();
            return;
          }
          if (camErr instanceof BlurFailed) {
            // Blur would not start: no camera at all rather than the room unblurred.
            noteBlurFailed();
          } else {
            // Stay in the call with audio — keep preview mirror if it still has frames.
            mirrorPreviewToSelfTile();
            if (!localVideoRef.current?.srcObject) {
              setCameraOff(true);
              setLocalCamLive(false);
            }
            if (!cancelledRef.current) {
              setError(permissionHint(camErr, 'video'));
            }
          }
        }
      }
      // The preview stream object is done; any of its tracks still painting the
      // self tile stay in ownedTracksRef until LiveKit's camera replaces them or
      // the call ends.
      previewStreamRef.current = null;
      if (previewRef.current) previewRef.current.srcObject = null;
      setPreviewReady(false);
      for (const p of room.remoteParticipants.values()) {
        p.trackPublications.forEach((pub) => {
          if (pub.track) attachRemote(pub.track, pub, p);
        });
      }
      refreshPeers(room);
      void refreshDeviceLists();
      settingUp = false;
      if (!cancelledRef.current) {
        setLinkHint(null);
        setAudioBlocked(!room.canPlaybackAudio);
        setState('live');
      }
    } catch (err) {
      try {
        await room.disconnect();
      } catch {
        /* ignore */
      }
      releaseOwned();
      roomRef.current = null;
      if (!cancelledRef.current) {
        setError(permissionHint(err, mode));
        setState('error');
      }
    }
  }

  function retry() {
    void roomRef.current?.disconnect();
    roomRef.current = null;
    autoJoinStarted.current = false;
    setPreviewReady(false);
    setAttempt((n) => n + 1);
    setState('preflight');
    setError(null);
  }

  /**
   * Turns your microphone on or off, one change at a time: the button, the
   * shortcut and push to talk all come here, and the last wish wins (a key
   * tapped quickly ends muted, never stuck open).
   */
  async function setMicOn(on: boolean) {
    micWantRef.current = on;
    if (micBusyRef.current) return;
    micBusyRef.current = true;
    try {
      for (;;) {
        const room = roomRef.current;
        const want: boolean | null = micWantRef.current;
        if (!room || room.state !== ConnectionState.Connected || want === null) break;
        await room.localParticipant.setMicrophoneEnabled(
          want,
          micIdRef.current ? { deviceId: micIdRef.current } : undefined,
        );
        mutedRef.current = !want;
        if (!cancelledRef.current) setMuted(!want);
        if (micWantRef.current === want) break;
      }
    } catch (err) {
      if (!cancelledRef.current) setError(permissionHint(err, mode));
    } finally {
      micWantRef.current = null;
      micBusyRef.current = false;
    }
  }

  function toggleMute() {
    const on = micWantRef.current ?? !mutedRef.current;
    void setMicOn(!on);
  }

  /** Runs camera changes one after another (button, blur level, blur failing). */
  function cameraOp(op: () => Promise<void>): Promise<void> {
    const run = cameraOpsRef.current.then(op, op);
    cameraOpsRef.current = run.catch(() => undefined);
    return run;
  }

  /** The blur running on `track`, if this component set it up. */
  function blurOn(track: LocalVideoTrack | undefined): CameraBlurHandle | null {
    const cur = cameraBlurRef.current;
    return track && cur && cur.track === track && track.getProcessor() === cur.handle.processor
      ? cur.handle
      : null;
  }

  /**
   * Turns your camera on (joining, the camera button). With blur chosen, the
   * track is made and blurred before it is published, so its first frame out
   * is already blurred; a camera turned off with another setting is made anew
   * rather than unmuted (its restart would send it as it was first).
   */
  async function startCamera(room: Room) {
    const options = camIdRef.current ? { deviceId: camIdRef.current } : {};
    const level = blurRef.current;
    const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
    const old = pub?.track instanceof LocalVideoTrack ? pub.track : undefined;
    if (old) {
      const handle = blurOn(old);
      if (handle ? handle.level === level : level === 'off') {
        await room.localParticipant.setCameraEnabled(true, options);
        return;
      }
      await room.localParticipant.unpublishTrack(old, true);
      cameraBlurRef.current = null;
    }
    if (level === 'off') {
      await room.localParticipant.setCameraEnabled(true, options);
      return;
    }
    blurBusyRef.current += 1;
    try {
      let handle: CameraBlurHandle;
      try {
        handle = await createCameraBlur(level);
      } catch {
        throw new BlurFailed('blur did not load');
      }
      // The camera's own errors (permission, busy) stay camera errors.
      const [made] = await room.localParticipant.createTracks({ video: options });
      if (!(made instanceof LocalVideoTrack)) {
        made?.stop();
        throw new Error('No camera');
      }
      try {
        await within(made.setProcessor(handle.processor), BLUR_SETUP_MS);
      } catch {
        made.stop();
        throw new BlurFailed('blur did not start');
      }
      if (cancelledRef.current || blurRef.current === 'off') {
        // Left meanwhile, or blur was turned off while it loaded: start again plain.
        made.stop();
        if (!cancelledRef.current) await room.localParticipant.setCameraEnabled(true, options);
        return;
      }
      try {
        await room.localParticipant.publishTrack(made);
      } catch (err) {
        made.stop();
        throw err;
      }
      cameraBlurRef.current = { track: made, handle };
      blurFailedRef.current = false;
      if (handle.level !== blurRef.current) await setCameraBlurLevel(handle, blurRef.current);
    } finally {
      blurBusyRef.current -= 1;
    }
  }

  /** Blur would not run: the camera stays off and says why (nothing unblurred went out). */
  function noteBlurFailed() {
    blurFailedRef.current = true;
    releaseOwned('video');
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    setCameraOff(true);
    setLocalCamLive(false);
    stopLocalCamWatch();
    if (!cancelledRef.current) {
      setError('Background blur would not start, so your camera is off. Turn blur off to show it.');
    }
  }

  /** Blur stopped working mid-call: take the camera away, not the blur. */
  async function failBlurClosed(room: Room) {
    const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
    cameraBlurRef.current = null;
    if (pub?.track) {
      try {
        await room.localParticipant.unpublishTrack(pub.track, true);
      } catch {
        pub.track.stop();
      }
    }
    noteBlurFailed();
  }

  async function toggleCamera() {
    if (mode !== 'video') return;
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) return;
    await cameraOp(async () => {
      // What the camera is doing now (the state may be a step behind a queued change).
      const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
      const turnOff = !!pub?.track && !pub.isMuted;
      try {
        if (turnOff) {
          await room.localParticipant.setCameraEnabled(false);
          setCameraOff(true);
          setLocalCamLive(false);
          stopLocalCamWatch();
          return;
        }
        setError(null);
        await startCamera(room);
        setCameraOff(false);
        // cameraOff state updates async — attach with the track directly.
        const cam = room.localParticipant.getTrackPublication(Track.Source.Camera);
        if (cam?.track && localVideoRef.current) {
          attachTrackToVideo(cam.track, localVideoRef.current);
          watchLocalCamFrames(localVideoRef.current);
        } else {
          setLocalCamLive(false);
          window.setTimeout(() => attachLocalCamToEl(localVideoRef.current), 80);
        }
      } catch (err) {
        if (cancelledRef.current) return;
        if (err instanceof BlurFailed) noteBlurFailed();
        // Keep prior cameraOff; surface a friendly hint instead of a raw SDK stack message.
        else setError(permissionHint(err, 'video'));
      }
    });
  }

  /**
   * A blur level chosen in the settings, applied now when the camera is on:
   * the running blur changes level in place; a camera without one gets it
   * (what it sent until now was unblurred anyway). Off camera, the next
   * startCamera applies it.
   */
  async function applyBlurNow() {
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) return;
    const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
    const track = pub?.track instanceof LocalVideoTrack ? pub.track : undefined;
    if (!track || pub?.isMuted) return;
    const level = blurRef.current;
    const handle = blurOn(track);
    blurBusyRef.current += 1;
    try {
      if (handle) {
        if (handle.level !== level) await setCameraBlurLevel(handle, level);
        return;
      }
      if (level === 'off') return;
      const made = await createCameraBlur(level);
      await within(track.setProcessor(made.processor), BLUR_SETUP_MS);
      cameraBlurRef.current = { track, handle: made };
      if (made.level !== blurRef.current) await setCameraBlurLevel(made, blurRef.current);
    } catch {
      if (!cancelledRef.current) await failBlurClosed(room);
    } finally {
      blurBusyRef.current -= 1;
    }
  }

  // ---- Screen sharing ----

  /**
   * Put the chosen quality on your shared screen now, on the same capture (no
   * new picker): the capture's size limit and frame rate (a browser fits a
   * screen into the limit in its own shape), what the encoder keeps when the
   * link is tight, and its frame-rate and bit-rate caps.
   */
  async function applyShareQuality() {
    const track = roomRef.current?.localParticipant.getTrackPublication(Track.Source.ScreenShare)
      ?.track;
    if (!(track instanceof LocalVideoTrack)) return;
    const q = shareQuality(shareQualityRef.current);
    const media = track.mediaStreamTrack;
    if ('contentHint' in media) media.contentHint = q.hint;
    await media
      .applyConstraints({
        width: { ideal: q.width, max: q.width },
        height: { ideal: q.height, max: q.height },
        frameRate: { ideal: q.fps, max: q.fps },
      })
      .catch(() => undefined);
    await track.setDegradationPreference(q.degradation).catch(() => undefined);
    const sender = track.sender;
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    for (const enc of params.encodings) {
      enc.maxBitrate = q.bitrate;
      enc.maxFramerate = q.fps;
    }
    await sender.setParameters(params).catch(() => undefined);
  }

  function pickShareQuality(id: string) {
    const q = shareQuality(id);
    shareQualityRef.current = q.id;
    setShareQualityId(q.id);
    writePref(SHARE_PREF_KEY, q.id);
    void applyShareQuality();
  }

  async function startShare() {
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected || shareBusy) return;
    const q = shareQuality(shareQualityRef.current);
    setShareBusy(true);
    setShareError(null);
    try {
      // Captured at up to 1080p / 30 fps, so every preset can be reached
      // later by rescaling; the chosen one is applied once it is published.
      await room.localParticipant.setScreenShareEnabled(
        true,
        {
          audio: true,
          resolution: { width: 1920, height: 1080, frameRate: 30 },
          contentHint: q.hint,
          // Not this tab (a mirror of itself), and not the whole computer's
          // sound (it would carry the call back into the call).
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include',
          systemAudio: 'exclude',
        },
        {
          simulcast: false,
          screenShareEncoding: { maxBitrate: q.bitrate, maxFramerate: q.fps },
          degradationPreference: q.degradation,
          // Only the tab's sound reads these: music quality, and no dropping
          // of quiet passages (the call's own speech settings would).
          audioPreset: AudioPresets.musicHighQuality,
          dtx: false,
        },
      );
      if (cancelledRef.current) return;
      setShareOpen(false);
      await applyShareQuality();
    } catch (err) {
      if (!cancelledRef.current) setShareError(shareErrorHint(err));
    } finally {
      if (!cancelledRef.current) setShareBusy(false);
    }
  }

  async function stopShare() {
    const room = roomRef.current;
    if (!room) return;
    setShareBusy(true);
    try {
      await room.localParticipant.setScreenShareEnabled(false);
    } catch {
      // Already stopped (the browser's own Stop sharing bar).
    } finally {
      if (!cancelledRef.current) {
        setShareBusy(false);
        setShareOpen(false);
      }
    }
  }

  function toggleShareFull() {
    const el = shareStageRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void el.requestFullscreen?.().catch(() => undefined);
  }

  async function leave(opts?: { confirm?: boolean }) {
    if (leavingRef.current) return;
    if (opts?.confirm !== false && (state === 'live' || state === 'reconnecting')) {
      setLeaveConfirmOpen(true);
      return;
    }
    setLeaveConfirmOpen(false);
    leavingRef.current = true;
    stopPreview();
    const localEl = localVideoRef.current;
    if (localEl?.srcObject instanceof MediaStream) {
      localEl.srcObject.getTracks().forEach((t) => t.stop());
      localEl.srcObject = null;
    }
    try {
      await roomRef.current?.disconnect();
    } catch {
      // ignore
    }
    await onLeave();
  }

  const totalTiles = peers.length + 1;
  const waiting = peers.length === 0 && state === 'live';
  const statusLabel =
    state === 'preflight'
      ? mode === 'video'
        ? 'Check camera & mic'
        : 'Check microphone'
      : state === 'connecting'
        ? 'Connecting…'
        : state === 'reconnecting'
          ? 'Reconnecting…'
          : state === 'error'
            ? 'Connection failed'
            : waiting
              ? peerNickname
                ? `Waiting for ${peerNickname}…`
                : 'Waiting for others…'
              : peers.length === 1
                ? `With ${peers[0]!.name}`
                : `${peers.length + 1} in call`;

  const controlsLive = state === 'live' || state === 'reconnecting';
  const sharing = shares.some((s) => s.local);
  const focusedShare = shares.find((s) => s.key === focusKey) ?? null;
  const focusedSid = focusedShare?.sid ?? null;

  // The big stage shows the focused shared screen (yours too: what others see).
  useEffect(() => {
    const room = roomRef.current;
    if (!shareVideoEl || !room || !focusKey) return undefined;
    const pub =
      focusKey === room.localParticipant.identity
        ? room.localParticipant.getTrackPublication(Track.Source.ScreenShare)
        : room.remoteParticipants.get(focusKey)?.getTrackPublication(Track.Source.ScreenShare);
    const track = pub?.track;
    if (!track) return undefined;
    attachTrackToVideo(track, shareVideoEl);
    return () => {
      track.detach(shareVideoEl);
    };
  }, [shareVideoEl, focusKey, focusedSid]);

  useEffect(() => {
    const onChange = () =>
      setShareFull(!!shareStageRef.current && document.fullscreenElement === shareStageRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    if (!controlsLive) setShareOpen(false);
  }, [controlsLive]);

  // Listen to every voice in the call (yours and each person's) every 30 ms
  // and decide here who is speaking (voiceMeter.ts / voice.ts). A muted or
  // missing microphone is not listened to; leaving the call closes it all.
  useEffect(() => {
    if (!controlsLive) return undefined;
    const meters = createVoiceMeters();
    metersRef.current = meters;
    const gate = createVoiceChain();
    voiceChainRef.current = gate;
    const voices = createVoiceRoom();
    const tick = () => {
      const room = roomRef.current;
      if (!room) return;
      // The microphone's chain (noise filter, input sensitivity) goes on, off
      // or follows a new microphone here; the sound itself runs on the audio
      // thread.
      const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
      gate.sync(mic instanceof LocalAudioTrack ? mic : undefined, {
        thresholdDb: sensitivityRef.current,
        noise: noiseRef.current,
      });
      const levels = new Map<string, number>();
      const listening = new Set<string>();
      const listen = (identity: string, pub: TrackPublication | undefined) => {
        const track = pub && !pub.isMuted ? pub.track?.mediaStreamTrack : undefined;
        if (!track || track.readyState === 'ended') return;
        listening.add(identity);
        const meter = meters.get(identity, track);
        if (meter) levels.set(identity, meter.db());
      };
      listen(
        room.localParticipant.identity,
        room.localParticipant.getTrackPublication(Track.Source.Microphone),
      );
      for (const p of room.remoteParticipants.values()) {
        listen(p.identity, p.getTrackPublication(Track.Source.Microphone));
      }
      meters.keepOnly(listening);
      const { speaking, hearing } = voices.push(levels, performance.now());
      // With a gate on, you glow only while it lets your voice out.
      if (gate.passing() === false) speaking.delete(room.localParticipant.identity);
      heardRef.current = speaking;
      hearingRef.current = hearing;
      applySpeaking(room);
    };
    const timer = window.setInterval(tick, 30);
    return () => {
      window.clearInterval(timer);
      metersRef.current = null;
      meters.close();
      voiceChainRef.current = null;
      gate.close();
      releaseVoiceAudio();
      heardRef.current = new Set();
      hearingRef.current = new Set();
      // A retry starts a new connection: the last one's list is not news.
      serverSpeakersRef.current = new Set();
      const room = roomRef.current;
      if (room) applySpeaking(room);
    };
  }, [controlsLive, applySpeaking]);
  // The Voice Pill's bars: your microphone's level from the same meter.
  const readMicLevel = useCallback(() => {
    const room = roomRef.current;
    if (!room) return 0;
    return metersRef.current?.peek(room.localParticipant.identity)?.level() ?? 0;
  }, []);
  // The input sensitivity bar's level: before the gate (what your microphone
  // hears), the same 10 ms measure the gate compares with the thumb.
  const readInputDb = useCallback((): number | null => {
    const gate = voiceChainRef.current;
    if (gate?.status().on) return gate.takeInputDb();
    const room = roomRef.current;
    if (!room) return null;
    return metersRef.current?.peek(room.localParticipant.identity)?.recentDb() ?? null;
  }, []);
  const isCuttingInput = useCallback(() => voiceChainRef.current?.status().on ?? false, []);
  const voiceStatus = useCallback(
    (): VoiceChainStatus =>
      voiceChainRef.current?.status() ?? { on: false, noise: 'off', loading: null, failed: null },
    [],
  );
  /** Either chain feature is on: only then does a click wake the chain's audio. */
  const voiceChainWanted = () => sensitivityRef.current !== null || noiseRef.current !== 'off';
  /** Applies the chain's settings now (also each tick); a click may wake its audio. */
  function syncVoiceChain() {
    if (voiceChainWanted()) wakeVoiceAudio();
    const mic = roomRef.current?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    voiceChainRef.current?.sync(mic instanceof LocalAudioTrack ? mic : undefined, {
      thresholdDb: sensitivityRef.current,
      noise: noiseRef.current,
    });
  }
  function changeSensitivity(next: number | null) {
    setSensitivity(next);
    sensitivityRef.current = next;
    writePref(SENSITIVITY_PREF_KEY, next === null ? '' : String(next));
    syncVoiceChain();
  }
  function changeNoise(next: NoiseLevel) {
    setNoise(next);
    noiseRef.current = next;
    writePref(NOISE_PREF_KEY, next === 'off' ? '' : next);
    syncVoiceChain();
  }
  function changeBlur(next: BlurLevel) {
    setBlur(next);
    blurRef.current = next;
    writePref(BLUR_PREF_KEY, next === 'off' ? '' : next);
    if (next !== 'off') preloadCameraBlur();
    if (blurFailedRef.current) {
      // A new choice is a new try; with blur off the camera can be turned on again.
      blurFailedRef.current = false;
      setError(null);
    }
    void cameraOp(applyBlurNow);
  }
  /** What the blur does now, for the settings (BackgroundBlur.tsx). */
  const blurStatus = useCallback((): BlurStatus => {
    if (blurFailedRef.current) return 'failed';
    const pub = roomRef.current?.localParticipant.getTrackPublication(Track.Source.Camera);
    const track = pub?.track instanceof LocalVideoTrack ? pub.track : undefined;
    if (!track || pub?.isMuted) return blurBusyRef.current > 0 ? 'loading' : 'waiting';
    const cur = cameraBlurRef.current;
    if (!cur || cur.track !== track) return 'loading';
    const health = cur.handle.guard.health();
    return health === 'ok' ? 'on' : health === 'failed' ? 'failed' : 'loading';
  }, []);
  function changeMicMode(next: MicShortcutMode) {
    setMicMode(next);
    micModeRef.current = next;
    writePref(MIC_MODE_PREF_KEY, next === 'toggle' ? '' : next);
    // Push to talk starts muted; back to Toggle the microphone stays as it is.
    if (next === 'hold' && !holdingRef.current) void setMicOn(false);
  }
  const changeMicKey = useCallback((next: KeyBinding) => {
    setMicKey(next);
    micKeyRef.current = next;
    writePref(MIC_KEY_PREF_KEY, serializeBinding(next));
  }, []);
  const noteRecordingKey = useCallback((on: boolean) => {
    recordingKeyRef.current = on;
  }, []);

  // The microphone's shortcut, while the call is live: Toggle mutes or
  // unmutes on a press; Push to talk opens the microphone while the key is
  // held and closes it on letting go, leaving the tab or hiding it. A key that
  // types is left alone in text fields (the side chat).
  useEffect(() => {
    if (!controlsLive || !shortcutOffered) return undefined;
    const release = () => {
      if (!holdingRef.current) return;
      holdingRef.current = false;
      void setMicOn(false);
    };
    const onDown = (e: KeyboardEvent) => {
      if (recordingKeyRef.current || e.isComposing) return;
      const key = micKeyRef.current;
      if (!matchesPress(e, key)) return;
      if (typesText(key) && isTypingTarget(e.target)) return;
      e.preventDefault();
      pressedCodeRef.current = e.code;
      if (e.repeat) return;
      if (micModeRef.current === 'hold') {
        holdingRef.current = true;
        void setMicOn(true);
      } else {
        toggleMute();
      }
    };
    const onUp = (e: KeyboardEvent) => {
      // Its keyup is not for the page either (Space would click the focused button).
      if (pressedCodeRef.current === e.code) {
        e.preventDefault();
        pressedCodeRef.current = null;
      }
      if (holdingRef.current && isRelease(e, micKeyRef.current)) {
        e.preventDefault();
        release();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') release();
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', release);
    window.addEventListener('pagehide', release);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', release);
      window.removeEventListener('pagehide', release);
      document.removeEventListener('visibilitychange', onVisibility);
      holdingRef.current = false;
    };
    // setMicOn / toggleMute read only refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlsLive, shortcutOffered]);

  // Blur that stops making masks while the camera runs takes the camera with
  // it (failBlurClosed): its frames are held back meanwhile, never sent plain.
  useEffect(() => {
    if (!controlsLive || !blurOffered) return undefined;
    const timer = window.setInterval(() => {
      const room = roomRef.current;
      const cur = cameraBlurRef.current;
      if (!room || !cur || cur.handle.level === 'off') return;
      const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
      if (!pub || pub.isMuted || pub.track !== cur.track) return;
      if (cur.handle.guard.health() !== 'failed') return;
      void cameraOp(async () => {
        if (cameraBlurRef.current === cur) await failBlurClosed(room);
      });
    }, 1000);
    return () => window.clearInterval(timer);
    // failBlurClosed reads only refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlsLive, blurOffered]);
  // React Bits Border Glow on a speaking tile: an amber edge light turning
  // round it (the stage is light in Mist, so the darker accent there).
  const speakGlow =
    pageTheme === 'light'
      ? { colors: ['#A3520F', '#C8732A', '#F0A35E'], glowColor: '27 83 35', glowIntensity: 1.4 }
      : { colors: ['#F0A35E', '#C8732A', '#F8D9B5'], glowColor: '28 83 65', glowIntensity: 1.4 };
  const keyName = describeBinding(micKey, onMac);
  const micTip = !controlsLive
    ? 'Connecting — controls unlock in a moment'
    : !shortcutOffered
      ? muted
        ? 'Unmute'
        : 'Mute'
      : micMode === 'hold'
        ? muted
          ? `Unmute, or hold ${keyName} to talk`
          : 'Mute'
        : `${muted ? 'Unmute' : 'Mute'} (${keyName})`;
  const dockButtons = (
    <>
      {/* Your microphone (React Bits Voice Pill): widens into live level bars
            while you speak; a tap mutes or unmutes. */}
      <DockTip label={micTip}>
        <VoicePill
          className={`media-dock-btn dock-voice ${muted ? 'is-off' : ''}`.trim()}
          open={controlsLive && !muted && localSpeaking}
          level={readMicLevel}
          onToggle={toggleMute}
          disabled={!controlsLive}
          ariaPressed={muted}
          ariaLabel="Mute microphone"
          accentColor="var(--accent)"
          icon={
            muted ? (
              <MicOff aria-hidden="true" strokeWidth={iconStroke} />
            ) : (
              <Mic aria-hidden="true" strokeWidth={iconStroke} />
            )
          }
        />
      </DockTip>
      {mode === 'video' ? (
        <DockTip
          label={
            !controlsLive
              ? 'Connecting — controls unlock in a moment'
              : cameraOff
                ? 'Camera on'
                : 'Camera off'
          }
        >
          <button
            type="button"
            className={`media-dock-btn ${cameraOff ? 'is-off' : ''}`.trim()}
            disabled={!controlsLive}
            onClick={() => void toggleCamera()}
            aria-pressed={cameraOff}
            aria-label="Turn camera off"
          >
            {cameraOff ? (
              <VideoOff aria-hidden="true" strokeWidth={iconStroke} />
            ) : (
              <Video aria-hidden="true" strokeWidth={iconStroke} />
            )}
          </button>
        </DockTip>
      ) : null}
      {shareSupported ? (
        <DockTip
          label={
            !controlsLive
              ? 'Connecting — controls unlock in a moment'
              : sharing
                ? 'Screen sharing: quality or stop'
                : 'Share your screen'
          }
        >
          <button
            type="button"
            className={`media-dock-btn ${sharing ? 'is-sharing' : ''} ${shareOpen ? 'is-active' : ''}`.trim()}
            disabled={!controlsLive}
            onClick={() => {
              setDevicesOpen(false);
              setShareError(null);
              setShareOpen((v) => !v);
            }}
            aria-pressed={shareOpen}
            aria-label={sharing ? 'Screen sharing options' : 'Share your screen'}
          >
            {sharing ? (
              <ScreenShareOff aria-hidden="true" strokeWidth={iconStroke} />
            ) : (
              <ScreenShare aria-hidden="true" strokeWidth={iconStroke} />
            )}
          </button>
        </DockTip>
      ) : null}
      <DockTip
        label={
          !controlsLive ? 'Connecting — controls unlock in a moment' : 'Microphone and camera settings'
        }
      >
        <button
          type="button"
          className={`media-dock-btn ${devicesOpen ? 'is-active' : ''}`.trim()}
          disabled={!controlsLive}
          onClick={() => {
            setShareOpen(false);
            setDevicesOpen((v) => !v);
            // A click: the moment a browser lets the chain's audio start.
            if (canChainVoice && voiceChainWanted()) wakeVoiceAudio();
          }}
          aria-pressed={devicesOpen}
          aria-label="Microphone and camera settings"
        >
          <Settings aria-hidden="true" strokeWidth={iconStroke} />
        </button>
      </DockTip>
      <DockTip label="Leave room">
        <button
          type="button"
          className="media-dock-btn leave"
          onClick={() => void leave()}
          aria-label="Leave room"
        >
          <LogOut aria-hidden="true" strokeWidth={iconStroke} />
        </button>
      </DockTip>
    </>
  );
  const deviceSelects = (
    <DeviceSelects
      mode={mode}
      mics={mics}
      cams={cams}
      micId={micId}
      camId={camId}
      onMic={(id) => void selectMic(id)}
      onCam={(id) => void selectCam(id)}
      disabled={state === 'connecting'}
    />
  );

  const sharePanel = (
    <div className="media-device-panel media-share-panel" role="group" aria-label="Screen sharing">
      <p className="media-share-note">
        {sharing
          ? 'You’re sharing your screen. A new quality applies at once.'
          : 'Everyone in this call will see what you share.'}
      </p>
      <div className="media-device-fields">
        <div className="media-device-field">
          <span aria-hidden="true">Quality</span>
          <GlideSelect
            size="lg"
            showTags
            accentColor="var(--accent)"
            surfaceColor="var(--surface-overlay)"
            highlightColor="color-mix(in srgb, var(--accent) 18%, var(--surface-overlay))"
            textColor="var(--ink)"
            className="media-device-glide"
            ariaLabel="Screen sharing quality"
            options={SHARE_QUALITIES.map((q) => ({ value: q.id, label: q.label, tag: q.detail }))}
            value={shareQualityId}
            onChange={(v) => pickShareQuality(v)}
          />
        </div>
      </div>
      {shareError ? (
        <p className="error media-share-error" role="alert">
          {shareError}
        </p>
      ) : null}
      <div className="media-share-actions">
        {sharing ? (
          <button
            type="button"
            className="btn btn-primary btn-compact"
            disabled={shareBusy}
            onClick={() => void stopShare()}
          >
            Stop sharing
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-compact" onClick={() => setShareOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn-compact"
              disabled={shareBusy}
              onClick={() => void startShare()}
            >
              {shareBusy ? 'Choosing…' : 'Share screen'}
            </button>
          </>
        )}
      </div>
    </div>
  );

  const leaveModal = (
    <ConfirmDialog
      open={leaveConfirmOpen}
      title="Leave this room?"
      body="You’ll disconnect from the call and leave the room."
      confirmLabel="Leave"
      danger
      onCancel={() => setLeaveConfirmOpen(false)}
      onConfirm={() => void leave({ confirm: false })}
    />
  );

  if (state === 'preflight' || state === 'error') {
    return (
      <div className={`media-stage mode-${mode} state-${state}`}>
        {leaveModal}
        <div className="media-preflight">
          {mode === 'video' ? (
            <video
              ref={previewRef}
              className="media-preflight-video mirror"
              autoPlay
              playsInline
              muted
            />
          ) : (
            <div className="media-tile-fallback voice preflight">
              <div className="media-voice-orb self" aria-hidden="true">
                <span className="media-voice-ring" />
                <span className="media-voice-ring delay" />
                <span className="media-voice-initial">
                  {(nickname || 'Y').slice(0, 1).toUpperCase()}
                </span>
              </div>
            </div>
          )}
          <div className="media-preflight-copy">
            <p>{statusLabel}</p>
            <p className="muted">
              {error
                ? /member|forbidden|403|token|network|connect/i.test(error)
                  ? 'Check the error below, then retry.'
                  : mode === 'video'
                    ? 'Fix permissions or devices, then retry.'
                    : 'Fix microphone permission, then retry.'
                : 'Joining automatically — change devices if you need to.'}
            </p>
            {deviceSelects}
            {/* Chosen here (while the browser asks for the camera, say), the
                blur is on from the first frame you send. */}
            {blurOffered ? (
              <BackgroundBlur value={blur} onChange={changeBlur} status={blurStatus} />
            ) : null}
            {error ? (
              <p className="error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="cta-row">
              <button type="button" className="btn btn-primary" onClick={() => void connectCall()}>
                {state === 'error' ? 'Retry' : mode === 'video' ? 'Join video' : 'Join voice'}
              </button>
              {state === 'error' ? (
                <button type="button" className="btn btn-ghost" onClick={() => retry()}>
                  Reset preview
                </button>
              ) : null}
              <button type="button" className="btn btn-ghost" onClick={() => void leave()}>
                Leave room
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`media-stage mode-${mode} state-${state} ${focusedShare ? 'has-share' : ''}`.trim()}
    >
      {linkHint || state === 'reconnecting' || state === 'connecting' ? (
        <div className="media-toast-row" aria-live="polite">
          {state === 'connecting' ? <span className="media-toast">Connecting…</span> : null}
          {state === 'reconnecting' ? (
            <span className="media-toast warn">Reconnecting…</span>
          ) : null}
          {linkHint ? <span className="media-toast warn">{linkHint}</span> : null}
        </div>
      ) : null}

      {focusedShare ? (
        <div className="media-share-stage" ref={shareStageRef}>
          <video
            ref={setShareVideoEl}
            className="media-share-video"
            autoPlay
            playsInline
            muted
          />
          <div className="media-chip share-chip">
            <span className="media-chip-name">
              {focusedShare.local ? 'Your screen' : `${focusedShare.name}’s screen`}
            </span>
            {/* Alone in the call: the waiting line sits here, not over the screen. */}
            {waiting ? (
              <span className="media-chip-note" aria-live="polite">
                · {statusLabel}
              </span>
            ) : null}
          </div>
          {shares.length > 1 ? (
            <div className="media-share-picks" role="group" aria-label="Shared screens">
              {shares.map((s) => (
                <button
                  key={s.sid}
                  type="button"
                  className="media-share-pick"
                  aria-pressed={s.key === focusKey}
                  onClick={() => setFocusKey(s.key)}
                >
                  {s.local ? 'You' : s.name}
                </button>
              ))}
            </div>
          ) : null}
          {typeof document !== 'undefined' && document.fullscreenEnabled ? (
            <button
              type="button"
              className="media-share-full"
              onClick={toggleShareFull}
              aria-label={shareFull ? 'Exit full screen' : 'Full screen'}
              title={shareFull ? 'Exit full screen' : 'Full screen'}
            >
              {shareFull ? (
                <Minimize2 aria-hidden="true" strokeWidth={iconStroke} />
              ) : (
                <Maximize2 aria-hidden="true" strokeWidth={iconStroke} />
              )}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className={`media-grid ${gridCountClass(totalTiles)} mode-${mode}`.trim()}>
        {peers.map((peer) => {
          const vol = volumes[peer.identity] ?? 1;
          const qHint = peerQualityHint(peer.quality);
          return (
            <div
              key={peer.identity}
              className={`media-tile ${peer.speaking && !peer.muted ? 'speaking' : ''} ${peer.muted ? 'is-muted' : ''}`.trim()}
            >
              <BorderGlow active={peer.speaking && !peer.muted} {...speakGlow} />
              <audio ref={(el) => bindRemoteAudio(peer.identity, el)} autoPlay playsInline />
              {mode === 'video' ? (
                <>
                  <video
                    ref={(el) => bindRemoteVideo(peer.identity, el)}
                    className={`media-tile-video ${peer.cameraOff ? 'is-off' : ''}`.trim()}
                    autoPlay
                    playsInline
                  />
                  {peer.cameraOff ? (
                    <div className="media-tile-fallback">
                      <span className="media-avatar-initial">
                        {peer.name.slice(0, 1).toUpperCase()}
                      </span>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="media-tile-fallback voice">
                  <div className="media-voice-orb" aria-hidden="true">
                    <span className="media-voice-ring" />
                    <span className="media-voice-ring delay" />
                    <span className="media-voice-initial">
                      {peer.name.slice(0, 1).toUpperCase()}
                    </span>
                  </div>
                </div>
              )}
              <div className="media-chip tile above-volume">
                <span className="media-chip-name">{peer.name}</span>
                {qHint ? (
                  <span className="media-chip-quality" title="Connection quality">
                    {qHint}
                  </span>
                ) : null}
                {peer.muted ? (
                  <span
                    className="media-chip-dot muted"
                    title="Muted"
                    role="img"
                    aria-label="Muted"
                  />
                ) : null}
                {peer.speaking && !peer.muted ? (
                  <span
                    className="media-chip-dot speaking"
                    title="Speaking"
                    role="img"
                    aria-label="Speaking"
                  />
                ) : null}
              </div>
              <PeerVolume
                name={peer.name}
                volume={vol}
                onChange={(v) => setPeerVolume(peer.identity, v)}
              />
            </div>
          );
        })}

        <div
          className={`media-tile self ${localSpeaking && !muted ? 'speaking' : ''} ${muted ? 'is-muted' : ''}`.trim()}
        >
          <BorderGlow active={localSpeaking && !muted} {...speakGlow} />
          {mode === 'video' ? (
            <>
              <video
                ref={bindLocalVideo}
                className={`media-tile-video mirror ${cameraOff ? 'is-off' : ''}`.trim()}
                autoPlay
                playsInline
                muted
              />
              {/* Fallback when cam is off, or on-but-no-frames (denied / not yet attached). */}
              {cameraOff || !localCamLive ? (
                <div className="media-tile-fallback">
                  <span className="media-avatar-initial">
                    {(nickname || 'Y').slice(0, 1).toUpperCase()}
                  </span>
                </div>
              ) : null}
            </>
          ) : (
            <div className="media-tile-fallback voice">
              <div
                className={`media-voice-orb self ${localSpeaking && !muted ? 'is-speaking' : ''}`.trim()}
                aria-hidden="true"
              >
                <span className="media-voice-ring" />
                <span className="media-voice-ring delay" />
                <span className="media-voice-initial">
                  {(nickname || 'Y').slice(0, 1).toUpperCase()}
                </span>
              </div>
            </div>
          )}
          <div className="media-chip tile">
            <span className="media-chip-name">You</span>
            {muted ? (
              <span className="media-chip-dot muted" title="Muted" role="img" aria-label="Muted" />
            ) : null}
            {localSpeaking && !muted ? (
              <span
                className="media-chip-dot speaking"
                title="Speaking"
                role="img"
                aria-label="Speaking"
              />
            ) : null}
          </div>
        </div>
      </div>

      {waiting && !focusedShare ? (
        <div className="media-waiting-hint" aria-live="polite">
          {statusLabel}
        </div>
      ) : null}

      {devicesOpen ? (
        // Two columns on a wide stage (styles.css), one under the other elsewhere.
        <div className="media-device-panel media-settings-panel">
          <div className="media-settings-col">
            {deviceSelects}
            {canChainVoice && controlsLive ? (
              <InputSensitivity
                value={sensitivity}
                onChange={changeSensitivity}
                readDb={readInputDb}
                isCutting={isCuttingInput}
                muted={muted}
              />
            ) : null}
          </div>
          <div className="media-settings-col">
            {noiseOffered && controlsLive ? (
              <NoiseSuppression value={noise} onChange={changeNoise} status={voiceStatus} />
            ) : null}
            {blurOffered && controlsLive ? (
              <BackgroundBlur value={blur} onChange={changeBlur} status={blurStatus} />
            ) : null}
            {shortcutOffered && controlsLive ? (
              <MicShortcut
                mode={micMode}
                onModeChange={changeMicMode}
                binding={micKey}
                onBindingChange={changeMicKey}
                onRecording={noteRecordingKey}
                mac={onMac}
              />
            ) : null}
          </div>
        </div>
      ) : null}
      {shareOpen ? sharePanel : null}

      {audioBlocked && (state === 'live' || state === 'reconnecting') ? (
        <div className="media-toast media-audio-unlock" role="status">
          <span>Your browser paused the sound.</span>
          <button
            type="button"
            className="btn btn-primary btn-compact"
            onClick={() => {
              void roomRef.current
                ?.startAudio()
                .then(() => setAudioBlocked(!roomRef.current?.canPlaybackAudio))
                .catch(() => undefined);
            }}
          >
            Turn on sound
          </button>
        </div>
      ) : null}

      {/* The dock's surface reaches left under the microphone's level bars
          while they are out (is-voice-open), the buttons staying put. */}
      <div
        className={`media-dock ${controlsLive && !muted && localSpeaking ? 'is-voice-open' : ''}`.trim()}
        role="toolbar"
        aria-label="Call controls"
        style={{ '--vp-wave-w': `${voicePillWaveWidth()}px` } as CSSProperties}
      >
        {!controlsLive && state === 'connecting' ? (
          <p className="media-dock-hint muted" role="status">
            Connecting — controls unlock in a moment.
          </p>
        ) : null}
        {/* React Bits Warm Tooltip on every dock button, in one group: once one
            tip is open, moving along the dock swaps it at once. */}
        <warmTooltipGroup.Piece fallback={dockButtons}>{dockButtons}</warmTooltipGroup.Piece>
      </div>
      {error ? <p className="error media-stage-error">{error}</p> : null}
      {leaveModal}
    </div>
  );
}
