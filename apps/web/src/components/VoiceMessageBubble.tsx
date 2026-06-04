import { useEffect, useRef, useState } from 'react';

interface Props {
  url: string;
  durationMs: number;
  messageId: string;
  isOwn: boolean;
}

const BAR_COUNT = 30;

// Deterministic seeded waveform — same approach as mobile's VoiceMessageBubble
// (no FFT; bars derived from the message id). (OpenChat-xxc / bmp.7)
function strToSeed(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
function waveform(id: string): number[] {
  let s = strToSeed(id) >>> 0 || 1;
  const next = () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
  return Array.from({ length: BAR_COUNT }, () => 0.25 + next() * 0.75);
}

function fmt(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function VoiceMessageBubble({ url, durationMs, messageId, isOwn }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1
  const bars = useRef(waveform(messageId)).current;

  useEffect(() => {
    const audio = new Audio(url);
    audioRef.current = audio;
    const onTime = () => {
      if (audio.duration && isFinite(audio.duration)) setProgress(audio.currentTime / audio.duration);
    };
    const onEnd = () => { setPlaying(false); setProgress(0); };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnd);
    return () => {
      audio.pause();
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('ended', onEnd);
    };
  }, [url]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) { audio.pause(); setPlaying(false); }
    else { void audio.play(); setPlaying(true); }
  };

  const barOn = isOwn ? 'bg-white' : 'bg-blue-500';
  const barOff = isOwn ? 'bg-white/40' : 'bg-gray-300 dark:bg-slate-600';

  return (
    <div className="flex items-center gap-2 py-0.5">
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${isOwn ? 'bg-white/20 text-white' : 'bg-blue-500 text-white'}`}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <div className="flex h-8 items-center gap-[2px]">
        {bars.map((h, i) => (
          <span
            key={i}
            className={`w-[3px] rounded-full ${i / BAR_COUNT <= progress ? barOn : barOff}`}
            style={{ height: `${Math.round(h * 100)}%` }}
          />
        ))}
      </div>
      <span className={`text-xs tabular-nums ${isOwn ? 'text-blue-100' : 'text-gray-500 dark:text-slate-400'}`}>
        {fmt(durationMs)}
      </span>
    </div>
  );
}
