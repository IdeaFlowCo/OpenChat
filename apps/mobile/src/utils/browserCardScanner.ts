import jsQR from 'jsqr';
import { parseOpenChatUrl } from './parseOpenChatUrl';

const CARD_TOKEN = /^[0-9A-Za-z]{24}$/;

/** Only an allowlisted OpenChat card URL with a server-shaped token can open a card. */
export function cardTokenFromScan(value: string): string | null {
  const parsed = parseOpenChatUrl(value.trim());
  return parsed.type === 'card' && CARD_TOKEN.test(parsed.token) ? parsed.token : null;
}

type ScannerCallbacks = {
  onCard: (token: string) => void;
  onUnsupportedCode: () => void;
};

/** Owns browser media tracks, preview and frame loop for one scanner visit. */
export class BrowserCardScanner {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private frame: number | null = null;
  private stopped = false;
  private navigated = false;
  private lastUnsupported: string | null = null;

  constructor(private host: HTMLElement, private callbacks: ScannerCallbacks) {}

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera is unavailable in this browser.');
    if (typeof document === 'undefined') throw new Error('Camera is unavailable in this browser.');

    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment' } });
    if (this.stopped) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    this.stream = stream;
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('aria-label', 'Camera preview for scanning an OpenChat card');
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.objectFit = 'cover';
    video.srcObject = stream;
    this.video = video;
    this.host.appendChild(video);
    try {
      await video.play();
      if (!this.stopped) this.frame = requestAnimationFrame(this.scanFrame);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  private scanFrame = () => {
    if (this.stopped || !this.video) return;
    const video = this.video;
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      const canvas = this.canvas ?? (this.canvas = document.createElement('canvas'));
      const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context) {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'dontInvert' });
        if (code) this.acceptValue(code.data);
      }
    }
    if (!this.stopped) this.frame = requestAnimationFrame(this.scanFrame);
  };

  acceptValue(value: string): void {
    if (this.stopped || this.navigated) return;
    const token = cardTokenFromScan(value);
    if (token) {
      this.navigated = true;
      this.stop();
      this.callbacks.onCard(token);
    } else if (this.lastUnsupported !== value) {
      this.lastUnsupported = value;
      this.callbacks.onUnsupportedCode();
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach(track => track.stop());
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video.remove();
    }
    this.stream = null;
    this.video = null;
    this.canvas = null;
  }
}
