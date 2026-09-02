/**
 * App-wide voice recording lifecycle (build-90 pieces 1+2).
 *
 * This stays pure JS so it is OTA-safe. The provider owns expo-av's singleton
 * recorder and survives navigation; native background entitlement changes live
 * separately in app.config.js and only take effect in a new native build.
 */

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Alert, Platform } from 'react-native';
import type { Attachment } from '../api/client';
import { uploadAudio } from '../services/attachments';
import {
  cancelRecording,
  startRecording,
  stopRecording,
} from '../services/audioRecorder';
import type { Recording } from '../services/audioRecorder';
import { hapticSend } from '../services/haptics';
import { logError, logInfo, logWarn } from '../services/clientLogger';

const MAX_RECORDING_MS = 5 * 60 * 1000;
const TAP_THRESHOLD_MS = 350;

export interface RecordingState {
  status: 'idle' | 'recording';
  conversationId: string | null;
  conversationTitle: string | null;
  startedAt: number | null;
  elapsedMs: number;
  locked: boolean;
}

type SendToConversation = (
  conversationId: string,
  content: string,
  replyToId?: string,
  attachments?: Attachment[]
) => Promise<void>;

interface RecordingContextValue extends RecordingState {
  finishing: boolean;
  recentlyCancelled: boolean;
  notice: string | null;
  start: (
    conversationId: string,
    title: string,
    replyToId?: string,
    onSent?: () => void
  ) => Promise<void>;
  beginPress: (
    conversationId: string,
    title: string,
    pageX: number,
    replyToId?: string,
    onSent?: () => void
  ) => Promise<void>;
  endPress: (wasCancelled: boolean) => Promise<void>;
  stopAndSend: () => Promise<boolean>;
  cancel: () => Promise<void>;
  clearNotice: () => void;
  pressStartX: React.MutableRefObject<number>;
}

interface RecordingProviderProps {
  children: ReactNode;
  isAuthed: boolean;
  conversationsLoaded: boolean;
  conversationExists: (conversationId: string) => boolean;
  sendMessage: SendToConversation;
}

const initialState: RecordingState = {
  status: 'idle',
  conversationId: null,
  conversationTitle: null,
  startedAt: null,
  elapsedMs: 0,
  locked: false,
};

const Ctx = createContext<RecordingContextValue | null>(null);

export function useRecording(): RecordingContextValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useRecording must be used inside <RecordingProvider>');
  return value;
}

export function RecordingProvider({
  children,
  isAuthed,
  conversationsLoaded,
  conversationExists,
  sendMessage,
}: RecordingProviderProps) {
  const [state, setState] = useState<RecordingState>(initialState);
  const [finishing, setFinishing] = useState(false);
  // Synchronous mirror of `finishing` — closes the window between nulling
  // recordingRef and the async setFinishing(true) where a start() from another
  // chat could race the in-flight native stop (review hardening, 2026-09-02).
  const finishingRef = useRef(false);
  const [recentlyCancelled, setRecentlyCancelled] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const recordingRef = useRef<Recording | null>(null);
  const stateRef = useRef(state);
  const startingRef = useRef(false);
  const startGenerationRef = useRef(0);
  const pressStartTimeRef = useRef(0);
  const pendingReleaseRef = useRef<{ atMs: number; cancelled: boolean } | null>(null);
  const replyToIdRef = useRef<string | undefined>(undefined);
  const onSentRef = useRef<(() => void) | undefined>(undefined);
  const tickerRef = useRef<NodeJS.Timeout | null>(null);
  const maxTimerRef = useRef<NodeJS.Timeout | null>(null);
  const cancelFeedbackTimerRef = useRef<NodeJS.Timeout | null>(null);
  const noticeTimerRef = useRef<NodeJS.Timeout | null>(null);
  const finishRef = useRef<(cancelled: boolean) => Promise<boolean>>(async () => false);
  const isAuthedRef = useRef(isAuthed);
  const mountedRef = useRef(true);
  const conversationExistsRef = useRef(conversationExists);
  const sendMessageRef = useRef(sendMessage);
  const pressStartX = useRef(0);

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { isAuthedRef.current = isAuthed; }, [isAuthed]);
  useEffect(() => { conversationExistsRef.current = conversationExists; }, [conversationExists]);
  useEffect(() => { sendMessageRef.current = sendMessage; }, [sendMessage]);

  const clearTimers = useCallback(() => {
    if (tickerRef.current) clearInterval(tickerRef.current);
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
    tickerRef.current = null;
    maxTimerRef.current = null;
  }, []);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 3200);
  }, []);

  const finish = useCallback(async (wasCancelled: boolean): Promise<boolean> => {
    const recording = recordingRef.current;
    if (!recording) {
      // A quick tap can release while createAsync is pending. Retain it so
      // start() can apply tap-vs-hold semantics after the recorder exists.
      if (startingRef.current && pressStartTimeRef.current > 0) {
        pendingReleaseRef.current = { atMs: Date.now(), cancelled: wasCancelled };
      }
      return false;
    }

    clearTimers();
    finishingRef.current = true;
    recordingRef.current = null;
    const originId = stateRef.current.conversationId;
    const originTitle = stateRef.current.conversationTitle;
    const startedAt = stateRef.current.startedAt ?? Date.now();
    const replyToId = replyToIdRef.current;
    const onSent = onSentRef.current;
    replyToIdRef.current = undefined;
    onSentRef.current = undefined;
    stateRef.current = initialState;
    setState(initialState);

    if (wasCancelled) {
      logInfo('[voice] recording cancelled', { conversationId: originId });
      setRecentlyCancelled(true);
      if (cancelFeedbackTimerRef.current) clearTimeout(cancelFeedbackTimerRef.current);
      cancelFeedbackTimerRef.current = setTimeout(() => setRecentlyCancelled(false), 1200);
      await cancelRecording(recording);
      finishingRef.current = false;
      return false;
    }

    // A deleted origin is not retargeted to whichever chat happens to be open.
    if (!originId || !conversationExistsRef.current(originId)) {
      await cancelRecording(recording);
      logWarn('[voice] origin conversation missing; recording cancelled', {
        conversationId: originId,
      });
      showNotice(
        originTitle
          ? `“${originTitle}” is no longer available. Recording cancelled.`
          : 'That chat is no longer available. Recording cancelled.'
      );
      finishingRef.current = false;
      return false;
    }

    let uri: string;
    let durationMs: number;
    try {
      const result = await stopRecording(recording);
      uri = result.uri;
      durationMs = result.durationMs;
    } catch (err) {
      logError('[voice] stopRecording failed', err, { conversationId: originId });
      Alert.alert('Recording failed', 'Could not finish the recording. Please try again.');
      finishingRef.current = false;
      return false;
    }

    const wallMs = Date.now() - startedAt;
    if (durationMs <= 0) durationMs = wallMs;
    if (durationMs < 500) {
      logWarn('[voice] discarded ultra-short recording', {
        conversationId: originId,
        durationMs,
        wallMs,
      });
      finishingRef.current = false;
      return false;
    }

    setFinishing(true);
    try {
      const attachment = await uploadAudio(uri, durationMs);
      // Logout or removal can race the upload after the native recorder has
      // already stopped. Never redirect or attempt an unauthenticated send.
      if (!isAuthedRef.current) {
        logWarn('[voice] auth ended during upload; send cancelled', {
          conversationId: originId,
        });
        return false;
      }
      if (!conversationExistsRef.current(originId)) {
        logWarn('[voice] origin conversation removed during upload; send cancelled', {
          conversationId: originId,
        });
        showNotice(
          originTitle
            ? `“${originTitle}” is no longer available. Recording cancelled.`
            : 'That chat is no longer available. Recording cancelled.'
        );
        return false;
      }
      await sendMessageRef.current(originId, '', replyToId, [attachment]);
      logInfo('[voice] recording sent', { conversationId: originId, durationMs });
      hapticSend();
      onSent?.();
      return true;
    } catch (err) {
      logError('[voice] upload/send failed', err, { conversationId: originId, durationMs });
      Alert.alert('Voice message failed', 'Could not send the voice message. Please try again.');
      return false;
    } finally {
      setFinishing(false);
      finishingRef.current = false;
    }
  }, [clearTimers, showNotice]);

  useEffect(() => { finishRef.current = finish; }, [finish]);

  const start = useCallback(async (
    conversationId: string,
    title: string,
    replyToId?: string,
    onSent?: () => void
  ) => {
    if (
      Platform.OS === 'web'
      || startingRef.current
      || recordingRef.current
      || finishing
      || finishingRef.current
      || !isAuthedRef.current
    ) return;

    startingRef.current = true;
    const generation = ++startGenerationRef.current;
    replyToIdRef.current = replyToId;
    onSentRef.current = onSent;
    setRecentlyCancelled(false);
    const preparingState: RecordingState = {
      status: 'idle',
      conversationId,
      conversationTitle: title,
      startedAt: null,
      elapsedMs: 0,
      locked: false,
    };
    stateRef.current = preparingState;
    setState(preparingState);

    try {
      const recording = await startRecording();
      if (
        generation !== startGenerationRef.current
        || !isAuthedRef.current
        || !mountedRef.current
      ) {
        await cancelRecording(recording);
        return;
      }

      const startedAt = Date.now();
      recordingRef.current = recording;
      const recordingState: RecordingState = {
        status: 'recording',
        conversationId,
        conversationTitle: title,
        startedAt,
        elapsedMs: 0,
        locked: false,
      };
      stateRef.current = recordingState;
      setState(recordingState);
      logInfo('[voice] recording started', { conversationId });

      tickerRef.current = setInterval(() => {
        setState(current => current.status === 'recording'
          ? { ...current, elapsedMs: Date.now() - startedAt }
          : current);
      }, 100);
      maxTimerRef.current = setTimeout(() => {
        void finishRef.current(false);
      }, MAX_RECORDING_MS);

      const release = pendingReleaseRef.current;
      if (release) {
        pendingReleaseRef.current = null;
        const pressMs = release.atMs - pressStartTimeRef.current;
        if (release.cancelled) {
          void finishRef.current(true);
        } else if (pressMs < TAP_THRESHOLD_MS) {
          const lockedState = { ...stateRef.current, locked: true };
          stateRef.current = lockedState;
          setState(lockedState);
        } else {
          void finishRef.current(false);
        }
      }
    } catch (err) {
      logError('[voice] startRecording failed', err, { conversationId });
      setState(initialState);
      const denied = err instanceof Error && /permission/i.test(err.message);
      Alert.alert(
        denied ? 'Microphone access needed' : 'Recording failed',
        denied
          ? 'Enable microphone access in Settings to send voice messages.'
          : 'Could not start recording. Please try again.'
      );
    } finally {
      startingRef.current = false;
    }
  }, [finishing]);

  const beginPress = useCallback(async (
    conversationId: string,
    title: string,
    pageX: number,
    replyToId?: string,
    onSent?: () => void
  ) => {
    if (recordingRef.current && stateRef.current.locked) {
      await finishRef.current(false);
      return;
    }
    if (startingRef.current || recordingRef.current || finishing || finishingRef.current) return;
    pressStartX.current = pageX;
    pressStartTimeRef.current = Date.now();
    pendingReleaseRef.current = null;
    await start(conversationId, title, replyToId, onSent);
  }, [finishing, start]);

  const endPress = useCallback(async (wasCancelled: boolean) => {
    if (!recordingRef.current) {
      if (startingRef.current && pressStartTimeRef.current > 0) {
        pendingReleaseRef.current = { atMs: Date.now(), cancelled: wasCancelled };
      }
      return;
    }
    if (stateRef.current.locked) return;
    const pressMs = Date.now() - pressStartTimeRef.current;
    if (!wasCancelled && pressMs < TAP_THRESHOLD_MS) {
      const lockedState = { ...stateRef.current, locked: true };
      stateRef.current = lockedState;
      setState(lockedState);
      return;
    }
    await finishRef.current(wasCancelled);
  }, []);

  const stopAndSend = useCallback(() => finishRef.current(false), []);
  const cancel = useCallback(async () => {
    if (startingRef.current && !recordingRef.current) {
      startGenerationRef.current += 1;
      pendingReleaseRef.current = null;
      replyToIdRef.current = undefined;
      onSentRef.current = undefined;
      setState(initialState);
      return;
    }
    await finishRef.current(true);
  }, []);

  // Auth expiry/logout must release expo-av's singleton even if navigation is
  // simultaneously tearing down the authenticated screen tree.
  useEffect(() => {
    if (!isAuthed && (startingRef.current || recordingRef.current)) void cancel();
  }, [cancel, isAuthed]);

  // If the origin disappears while recording, discard immediately and explain
  // why. Wait for initial conversation loading so startup does not false-fire.
  useEffect(() => {
    if (
      conversationsLoaded
      && state.status === 'recording'
      && state.conversationId
      && !conversationExists(state.conversationId)
    ) {
      const title = state.conversationTitle;
      void cancel().then(() => {
        showNotice(
          title
            ? `“${title}” is no longer available. Recording cancelled.`
            : 'That chat is no longer available. Recording cancelled.'
        );
      });
    }
  }, [cancel, conversationExists, conversationsLoaded, showNotice, state]);

  // Provider unmount is the only lifecycle boundary that discards a recording;
  // ordinary screen navigation intentionally does not (build-90 pieces 1+2).
  useEffect(() => () => {
    mountedRef.current = false;
    startGenerationRef.current += 1;
    clearTimers();
    if (cancelFeedbackTimerRef.current) clearTimeout(cancelFeedbackTimerRef.current);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    const recording = recordingRef.current;
    recordingRef.current = null;
    if (recording) void cancelRecording(recording);
  }, [clearTimers]);

  const value = useMemo<RecordingContextValue>(() => ({
    ...state,
    finishing,
    recentlyCancelled,
    notice,
    start,
    beginPress,
    endPress,
    stopAndSend,
    cancel,
    clearNotice: () => setNotice(null),
    pressStartX,
  }), [beginPress, cancel, endPress, finishing, notice, recentlyCancelled, start, state, stopAndSend]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
