/**
 * VoiceMessageBubble — plays back a voice message attachment (OpenChat-xxc).
 *
 * Renders:
 *   ▶/❚❚  [waveform bars with progress dot]  0:14
 *
 * Waveform: N fixed bars of seeded-random heights — deterministic from the
 * message id, no FFT required.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Audio } from 'expo-av';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { AppIcon } from './AppIcon';

// ── Seeded waveform ───────────────────────────────────────────────────────────

const BAR_COUNT = 30;

/** Simple xorshift32 for deterministic pseudo-random bars. */
function xorshift(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
}

/** Turn a string id into a 32-bit seed. */
function strToSeed(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = (Math.imul(h, 0x01000193) >>> 0);
  }
  return h;
}

function buildBars(id: string): number[] {
  const rand = xorshift(strToSeed(id));
  return Array.from({ length: BAR_COUNT }, () => 0.25 + rand() * 0.75);
}

// ── Duration helpers ──────────────────────────────────────────────────────────

function fmtMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  messageId: string;
  url: string;
  durationMs: number;
  isOwn: boolean;
  /** Compact row — used when the transcript renders as the message text and
   *  the audio is secondary (first-class transcripts, 2026-09-02). */
  compact?: boolean;
}

type PlayState = 'idle' | 'loading' | 'playing' | 'paused';

export function VoiceMessageBubble({ messageId, url, durationMs, isOwn, compact }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);

  const bars = useRef(buildBars(messageId)).current;

  const [playState, setPlayState] = useState<PlayState>('idle');
  const [progressMs, setProgressMs] = useState(0);
  const soundRef = useRef<Audio.Sound | null>(null);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      soundRef.current?.unloadAsync().catch(() => {});
    };
  }, []);

  const handlePlayPause = useCallback(async () => {
    if (playState === 'loading') return;

    // ── Resume paused ─────────────────────────────────────────────────────
    if (playState === 'paused' && soundRef.current) {
      await soundRef.current.playAsync();
      setPlayState('playing');
      return;
    }

    // ── Pause playing ─────────────────────────────────────────────────────
    if (playState === 'playing' && soundRef.current) {
      await soundRef.current.pauseAsync();
      setPlayState('paused');
      return;
    }

    // ── Start / replay ────────────────────────────────────────────────────
    setPlayState('loading');
    setProgressMs(0);

    // Unload previous instance if replaying.
    if (soundRef.current) {
      await soundRef.current.unloadAsync().catch(() => {});
      soundRef.current = null;
    }

    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      });

      const { sound } = await Audio.Sound.createAsync(
        { uri: url },
        { shouldPlay: true },
        (status) => {
          if (!status.isLoaded) return;
          if (status.isPlaying) {
            setProgressMs(status.positionMillis ?? 0);
          }
          if (status.didJustFinish) {
            setPlayState('idle');
            setProgressMs(0);
          }
        }
      );

      soundRef.current = sound;
      setPlayState('playing');
    } catch {
      setPlayState('idle');
    }
  }, [playState, url]);

  // ── Colours ───────────────────────────────────────────────────────────────
  // Own-bubble overlays derive from the bubble text color (Ink & Paper: own
  // bubbles are ink-on-paper light / paper-on-ink dark).
  const ownRgb = (() => {
    const hex = c.bubbleOwnText.replace('#', '');
    return `${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)}`;
  })();
  const tint = isOwn ? `rgba(${ownRgb},0.9)` : c.primary;
  const barBase = isOwn ? `rgba(${ownRgb},0.4)` : c.border;
  const barActive = isOwn ? `rgba(${ownRgb},0.9)` : c.primary;
  const textColor = isOwn ? `rgba(${ownRgb},0.8)` : c.textSecondary;

  // Progress ratio (0–1).
  const total = durationMs > 0 ? durationMs : 1;
  const ratio = Math.min(progressMs / total, 1);

  const barsShown = compact ? bars.slice(0, 16) : bars;
  const barCount = barsShown.length;

  return (
    <View style={[styles.container, compact && styles.containerCompact]}>
      {/* Play / pause button */}
      <TouchableOpacity onPress={() => void handlePlayPause()} style={styles.playBtn} hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}>
        <AppIcon name={playState === 'playing' ? 'pause' : 'play'} color={tint} size={compact ? 14 : 18} />
      </TouchableOpacity>

      {/* Waveform + progress dot */}
      <View style={[styles.waveWrap, compact && styles.waveWrapCompact]}>
        <View style={[styles.wave, compact && styles.waveWrapCompact]}>
          {barsShown.map((h, i) => {
            const barRatio = (i + 0.5) / barCount;
            const isActive = barRatio <= ratio;
            return (
              <View
                key={i}
                style={[
                  styles.bar,
                  {
                    height: compact ? 3 + h * 10 : 4 + h * 20,
                    backgroundColor: isActive ? barActive : barBase,
                  },
                ]}
              />
            );
          })}
        </View>
        {/* Progress dot positioned along the waveform */}
        <View
          style={[
            styles.dot,
            {
              backgroundColor: tint,
              left: `${ratio * 100}%` as unknown as number,
            },
          ]}
          pointerEvents="none"
        />
      </View>

      {/* Duration / elapsed label */}
      <Text style={[styles.duration, { color: textColor }]}>
        {playState === 'playing' || playState === 'paused'
          ? fmtMs(progressMs)
          : fmtMs(durationMs)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 180,
    paddingVertical: 4,
  },
  containerCompact: {
    minWidth: 130,
    maxWidth: 190,
    paddingVertical: 1,
  },
  waveWrapCompact: {
    height: 16,
  },
  playBtn: {
    width: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  waveWrap: {
    flex: 1,
    height: 28,
    position: 'relative',
    justifyContent: 'center',
  },
  wave: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    height: 28,
  },
  bar: {
    flex: 1,
    borderRadius: 2,
  },
  dot: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5,
    top: '50%',
    marginTop: -5,
    marginLeft: -5,
  },
  duration: {
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    minWidth: 30,
    textAlign: 'right',
  },
});
