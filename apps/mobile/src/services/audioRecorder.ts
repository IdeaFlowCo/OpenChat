/**
 * audioRecorder.ts — voice message recording helpers (OpenChat-xxc).
 *
 * Thin wrappers around expo-av Audio.Recording.
 *
 * Max recording duration: 5 minutes (enforced by the caller via a timer;
 * the module just exposes start/stop/cancel primitives).
 */

import { Audio } from 'expo-av';
import type { RecordingOptions } from 'expo-av/build/Audio/Recording.types';

export type Recording = Audio.Recording;

const RECORDING_OPTIONS: RecordingOptions = {
  // High-quality preset gives us M4A/AAC on iOS, WebM/Opus on Android.
  ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
  // Override to ensure consistent M4A container on iOS.
  ios: {
    extension: '.m4a',
    outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
    audioQuality: Audio.IOSAudioQuality.HIGH,
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 128000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  android: {
    extension: '.m4a',
    outputFormat: Audio.AndroidOutputFormat.MPEG_4,
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 128000,
  },
  web: {
    mimeType: 'audio/webm',
    bitsPerSecond: 128000,
  },
};

/**
 * Thrown when the press that asked to record is the one that GRANTED the
 * microphone permission. The system prompt interrupts the press-and-hold and
 * leaves the app inactive, so a recording started from that same press either
 * fails to start or is cut off at once. Callers ask for a fresh press instead.
 */
export class MicrophoneJustEnabledError extends Error {
  constructor() {
    super('Microphone permission was just granted');
    this.name = 'MicrophoneJustEnabledError';
  }
}

const START_RETRY_DELAY_MS = 300;

async function prepareRecording(): Promise<Recording> {
  // Allow recording to work when the device is in silent mode (iOS).
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
    // JS is OTA-safe; iOS honors this after the matching build-90 background
    // audio entitlement ships, while Android can keep recording immediately.
    staysActiveInBackground: true,
  });
  const { recording } = await Audio.Recording.createAsync(RECORDING_OPTIONS);
  return recording;
}

/**
 * Request microphone permission if needed, then start recording.
 * Throws if permission is denied, and MicrophoneJustEnabledError if this call
 * is the one that granted it.
 */
export async function startRecording(): Promise<Recording> {
  const existing = await Audio.getPermissionsAsync();
  if (existing.status !== 'granted') {
    const { status } = await Audio.requestPermissionsAsync();
    if (status !== 'granted') {
      throw new Error('Microphone permission denied');
    }
    throw new MicrophoneJustEnabledError();
  }

  try {
    return await prepareRecording();
  } catch (err) {
    // The first attempt can fail transiently: "Only one Recording object can
    // be prepared at a given time" when a prior recording was left prepared
    // (app backgrounded mid-recording, edit flow; expo-av cleans its singleton
    // up as part of throwing — OpenChat 2026-09-02 iPad), or the audio session
    // not activating because another app or a call had it a moment ago. One
    // retry after a short pause clears both; a second failure is real.
    const immediate = err instanceof Error && /only one recording/i.test(err.message);
    if (!immediate) await new Promise((resolve) => setTimeout(resolve, START_RETRY_DELAY_MS));
    return prepareRecording();
  }
}

/**
 * Stop an active recording and return its local URI and duration.
 *
 * Duration comes from stopAndUnloadAsync's OWN return status — after unload,
 * getStatusAsync only echoes a cached `_finalDurationMillis` that is 0 when
 * the native stop result omits durationMillis (seen on iOS 26), which made
 * every recording look sub-500ms and get silently discarded (OpenChat-7nu).
 * Callers should still fall back to wall-clock elapsed time if this is 0.
 */
export async function stopRecording(
  recording: Recording
): Promise<{ uri: string; durationMs: number }> {
  const status = await recording.stopAndUnloadAsync();

  // Restore audio mode so playback works after recording.
  await Audio.setAudioModeAsync({ allowsRecordingIOS: false });

  const durationMs = status.durationMillis ?? 0;

  const uri = recording.getURI();
  if (!uri) throw new Error('Recording URI is null after stop');

  return { uri, durationMs };
}

/**
 * Cancel a recording in progress (discards the audio file).
 */
export async function cancelRecording(recording: Recording): Promise<void> {
  try {
    await recording.stopAndUnloadAsync();
  } catch {
    // Ignore errors during cancel — the recording might already be stopped.
  }
  await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
}
