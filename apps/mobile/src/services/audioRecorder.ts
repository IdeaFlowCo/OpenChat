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
 * Request microphone permission if needed, then start recording.
 * Throws if permission is denied.
 */
export async function startRecording(): Promise<Recording> {
  const { status } = await Audio.requestPermissionsAsync();
  if (status !== 'granted') {
    throw new Error('Microphone permission denied');
  }

  // Allow recording to work when the device is in silent mode (iOS).
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
    // JS is OTA-safe; iOS honors this after the matching build-90 background
    // audio entitlement ships, while Android can keep recording immediately.
    staysActiveInBackground: true,
  });

  try {
    const { recording } = await Audio.Recording.createAsync(RECORDING_OPTIONS);
    return recording;
  } catch (err) {
    // "Only one Recording object can be prepared at a given time" — a prior
    // recording was left prepared (app backgrounded mid-recording, edit flow,
    // etc). expo-av cleans its singleton up as part of throwing, so one
    // immediate retry succeeds — without this the FIRST mic press after a
    // wedge always failed and the second worked (OpenChat 2026-09-02 iPad).
    if (err instanceof Error && /only one recording/i.test(err.message)) {
      const { recording } = await Audio.Recording.createAsync(RECORDING_OPTIONS);
      return recording;
    }
    throw err;
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
