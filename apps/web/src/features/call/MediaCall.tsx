import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AudioPresets,
  ConnectionQuality,
  ConnectionState,
  DisconnectReason,
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
import { wakeSlider } from '../../ui/pieces';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import {
  deviceOptions,
  gridCountClass,
  permissionHint,
  pickDeviceId,
  type MediaDeviceOption,
} from './media';
import { LogOut, Mic, MicOff, Settings, Video, VideoOff, iconStroke } from '../../ui/icons';

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
  return (
    <div className="media-device-fields">
      {mics.length > 0 ? (
        <label className="media-device-field">
          <span>Microphone</span>
          <select
            value={micId}
            disabled={disabled || mics.length < 2}
            onChange={(e) => onMic(e.target.value)}
          >
            {mics.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {mode === 'video' && cams.length > 0 ? (
        <label className="media-device-field">
          <span>Camera</span>
          <select
            value={camId}
            disabled={disabled || cams.length < 2}
            onChange={(e) => onCam(e.target.value)}
          >
            {cams.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
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
  const [linkHint, setLinkHint] = useState<string | null>(null);
  /** The browser blocked sound until the person interacts (autoplay policy). */
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [mics, setMics] = useState<MediaDeviceOption[]>([]);
  const [cams, setCams] = useState<MediaDeviceOption[]>([]);
  const [micId, setMicId] = useState(() => readPref(MIC_PREF_KEY));
  const [camId, setCamId] = useState(() => readPref(CAM_PREF_KEY));
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [previewTick, setPreviewTick] = useState(0);
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const [previewReady, setPreviewReady] = useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const speakingIdsRef = useRef<Set<string>>(new Set());
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
  }, []);

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

    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      attachRemote(track, publication, participant);
      refreshPeers(room);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach();
    });
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
      const ids = new Set(speakers.map((s) => s.identity));
      speakingIdsRef.current = ids;
      setLocalSpeaking(ids.has(room.localParticipant.identity));
      refreshPeers(room);
    });
    room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (participant.isLocal) {
        const hint = qualityLabel(quality);
        setLinkHint(hint);
      } else {
        refreshPeers(room);
      }
    });
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
      if (!cancelledRef.current) {
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
      if (publication.source !== Track.Source.Camera) return;
      setCameraOff(false);
      if (localVideoRef.current && publication.track) {
        attachTrackToVideo(publication.track, localVideoRef.current);
        watchLocalCamFrames(localVideoRef.current);
        releaseOwned('video');
      }
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
        await room.localParticipant.setMicrophoneEnabled(true, {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          ...(micId ? { deviceId: micId } : {}),
        });
        setMuted(false);
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
            await room.localParticipant.setCameraEnabled(
              true,
              camId ? { deviceId: camId } : undefined,
            );
          } catch {
            // Some browsers won't allow two cameras — release preview video, then reacquire.
            releaseOwned('video');
            await new Promise((r) => window.setTimeout(r, 200));
            await room.localParticipant.setCameraEnabled(
              true,
              camId ? { deviceId: camId } : undefined,
            );
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

  async function toggleMute() {
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) return;
    const next = !muted;
    try {
      await room.localParticipant.setMicrophoneEnabled(
        !next,
        micId ? { deviceId: micId } : undefined,
      );
      setMuted(next);
    } catch (err) {
      if (!cancelledRef.current) setError(permissionHint(err, mode));
    }
  }

  async function toggleCamera() {
    if (mode !== 'video') return;
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) return;
    const next = !cameraOff;
    try {
      await room.localParticipant.setCameraEnabled(!next, camId ? { deviceId: camId } : undefined);
      setCameraOff(next);
      if (next) {
        setLocalCamLive(false);
        stopLocalCamWatch();
      } else {
        // cameraOff state updates async — attach with the track directly.
        const cam = [...room.localParticipant.trackPublications.values()].find(
          (p) => p.source === Track.Source.Camera,
        );
        if (cam?.track && localVideoRef.current) {
          attachTrackToVideo(cam.track, localVideoRef.current);
          watchLocalCamFrames(localVideoRef.current);
        } else {
          setLocalCamLive(false);
          window.setTimeout(() => attachLocalCamToEl(localVideoRef.current), 80);
        }
      }
    } catch (err) {
      // Keep prior cameraOff; surface a friendly hint instead of a raw SDK stack message.
      if (!cancelledRef.current) setError(permissionHint(err, 'video'));
    }
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
    <div className={`media-stage mode-${mode} state-${state}`}>
      {linkHint || state === 'reconnecting' || state === 'connecting' ? (
        <div className="media-toast-row" aria-live="polite">
          {state === 'connecting' ? <span className="media-toast">Connecting…</span> : null}
          {state === 'reconnecting' ? (
            <span className="media-toast warn">Reconnecting…</span>
          ) : null}
          {linkHint ? <span className="media-toast warn">{linkHint}</span> : null}
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

      {waiting ? (
        <div className="media-waiting-hint" aria-live="polite">
          {statusLabel}
        </div>
      ) : null}

      {devicesOpen ? <div className="media-device-panel">{deviceSelects}</div> : null}

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

      <div className="media-dock" role="toolbar" aria-label="Call controls">
        {!controlsLive && state === 'connecting' ? (
          <p className="media-dock-hint muted" role="status">
            Connecting — controls unlock in a moment.
          </p>
        ) : null}
        <button
          type="button"
          className={`media-dock-btn ${muted ? 'is-off' : ''}`.trim()}
          disabled={!controlsLive}
          onClick={() => void toggleMute()}
          aria-pressed={muted}
          aria-label="Mute microphone"
          title={
            !controlsLive ? 'Connecting — controls unlock in a moment' : muted ? 'Unmute' : 'Mute'
          }
        >
          {muted ? (
            <MicOff aria-hidden="true" strokeWidth={iconStroke} />
          ) : (
            <Mic aria-hidden="true" strokeWidth={iconStroke} />
          )}
        </button>
        {mode === 'video' ? (
          <button
            type="button"
            className={`media-dock-btn ${cameraOff ? 'is-off' : ''}`.trim()}
            disabled={!controlsLive}
            onClick={() => void toggleCamera()}
            aria-pressed={cameraOff}
            aria-label="Turn camera off"
            title={
              !controlsLive
                ? 'Connecting — controls unlock in a moment'
                : cameraOff
                  ? 'Camera on'
                  : 'Camera off'
            }
          >
            {cameraOff ? (
              <VideoOff aria-hidden="true" strokeWidth={iconStroke} />
            ) : (
              <Video aria-hidden="true" strokeWidth={iconStroke} />
            )}
          </button>
        ) : null}
        <button
          type="button"
          className={`media-dock-btn ${devicesOpen ? 'is-active' : ''}`.trim()}
          disabled={!controlsLive}
          onClick={() => setDevicesOpen((v) => !v)}
          aria-pressed={devicesOpen}
          aria-label="Choose microphone or camera"
          title={
            !controlsLive
              ? 'Connecting — controls unlock in a moment'
              : 'Choose microphone or camera'
          }
        >
          <Settings aria-hidden="true" strokeWidth={iconStroke} />
        </button>
        <button
          type="button"
          className="media-dock-btn leave"
          onClick={() => void leave()}
          aria-label="Leave room"
          title="Leave room"
        >
          <LogOut aria-hidden="true" strokeWidth={iconStroke} />
        </button>
      </div>
      {error ? <p className="error media-stage-error">{error}</p> : null}
      {leaveModal}
    </div>
  );
}
