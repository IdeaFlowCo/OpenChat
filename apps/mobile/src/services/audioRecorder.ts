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
  });

  const { recording } = await Audio.Recording.createAsync(RECORDING_OPTIONS);
  return recording;
}

/**
 * Stop an active recording and return its local URI and duration.
 */
export async function stopRecording(
  recording: Recording
): Promise<{ uri: string; durationMs: number }> {
  await recording.stopAndUnloadAsync();

  // Restore audio mode so playback works after recording.
  await Audio.setAudioModeAsync({ allowsRecordingIOS: false });

  const status = await recording.getStatusAsync();
  // RecordingStatus always has durationMillis (it's not optional in the type).
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
