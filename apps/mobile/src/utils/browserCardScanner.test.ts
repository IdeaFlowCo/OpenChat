import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jsQR from 'jsqr';
import { BrowserCardScanner, cardTokenFromScan } from './browserCardScanner';

vi.mock('jsqr', () => ({ default: vi.fn() }));

const token = 'AbCdEfGhIjKlMnOpQrStUvWx';

describe('cardTokenFromScan', () => {
  it('accepts allowlisted card URLs and rejects other destinations and malformed tokens', () => {
    expect(cardTokenFromScan(`https://chat.globalbr.ai/c/${token}`)).toBe(token);
    expect(cardTokenFromScan(`https://chat.ideaflow.app/c/${token}`)).toBe(token);
    expect(cardTokenFromScan(`openchat://card/${token}`)).toBe(token);
    expect(cardTokenFromScan(`https://chat.globalbr.ai/app/?intent=card&token=${token}`)).toBe(token);
    expect(cardTokenFromScan(`https://evil.example/c/${token}`)).toBeNull();
    expect(cardTokenFromScan('https://chat.globalbr.ai/u/someone')).toBeNull();
    expect(cardTokenFromScan('https://chat.globalbr.ai/c/rotated')).toBeNull();
    expect(cardTokenFromScan(`https://chat.globalbr.ai/c/${token}/go`)).toBeNull();
  });
});

describe('BrowserCardScanner', () => {
  let stopTrack: ReturnType<typeof vi.fn>;
  let frame: FrameRequestCallback | null;
  let video: Record<string, unknown>;
  let canvas: Record<string, unknown>;
  let host: { appendChild: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    stopTrack = vi.fn();
    frame = null;
    host = { appendChild: vi.fn() };
    video = {
      readyState: 0,
      videoWidth: 0,
      videoHeight: 0,
      style: {},
      setAttribute: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      remove: vi.fn(),
    };
    canvas = { getContext: vi.fn(() => ({
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })),
    })) };
    vi.mocked(jsQR).mockReset();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }) } });
    vi.stubGlobal('document', { createElement: vi.fn((tag: string) => tag === 'video' ? video : canvas) });
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1; }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => vi.unstubAllGlobals());

  it('does not request the camera until start, stops tracks on exit, and does not reschedule', async () => {
    const scanner = new BrowserCardScanner(host as unknown as HTMLElement, { onCard: vi.fn(), onUnsupportedCode: vi.fn() });
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    await scanner.start();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: false, video: { facingMode: 'environment' } });
    expect(host.appendChild).toHaveBeenCalledWith(video);
    scanner.stop();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(video.remove).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    frame?.(0);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  });

  it('opens one card and rejects unsupported frames without navigation', async () => {
    const onCard = vi.fn();
    const onUnsupportedCode = vi.fn();
    const scanner = new BrowserCardScanner(host as unknown as HTMLElement, { onCard, onUnsupportedCode });
    await scanner.start();
    scanner.acceptValue('https://example.com/unsafe');
    scanner.acceptValue('https://example.com/unsafe');
    expect(onUnsupportedCode).toHaveBeenCalledOnce();
    expect(onCard).not.toHaveBeenCalled();
    scanner.acceptValue(`https://chat.globalbr.ai/c/${token}`);
    scanner.acceptValue(`https://chat.globalbr.ai/c/${token}`);
    expect(onCard).toHaveBeenCalledExactlyOnceWith(token);
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('decodes a camera frame and navigates only once', async () => {
    const onCard = vi.fn();
    video.readyState = 2;
    video.videoWidth = 1;
    video.videoHeight = 1;
    vi.mocked(jsQR).mockReturnValue({ data: `https://chat.globalbr.ai/c/${token}` } as ReturnType<typeof jsQR>);
    const scanner = new BrowserCardScanner(host as unknown as HTMLElement, { onCard, onUnsupportedCode: vi.fn() });
    await scanner.start();
    frame?.(0);
    frame?.(1);
    expect(jsQR).toHaveBeenCalledOnce();
    expect(onCard).toHaveBeenCalledExactlyOnceWith(token);
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('stops a camera stream that resolves after the screen exits', async () => {
    let resolveStream!: (stream: MediaStream) => void;
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(() => new Promise<MediaStream>(resolve => { resolveStream = resolve; })) } });
    const scanner = new BrowserCardScanner(host as unknown as HTMLElement, { onCard: vi.fn(), onUnsupportedCode: vi.fn() });
    const starting = scanner.start();
    scanner.stop();
    resolveStream({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
    await starting;
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(host.appendChild).not.toHaveBeenCalled();
  });

  it('surfaces denied permission so the screen can use its paste fallback', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(new Error('NotAllowedError')) } });
    const scanner = new BrowserCardScanner(host as unknown as HTMLElement, { onCard: vi.fn(), onUnsupportedCode: vi.fn() });
    await expect(scanner.start()).rejects.toThrow('NotAllowedError');
    expect(host.appendChild).not.toHaveBeenCalled();
  });

  it('reports browsers without camera access while card-link parsing remains usable', async () => {
    vi.stubGlobal('navigator', {});
    const scanner = new BrowserCardScanner(host as unknown as HTMLElement, { onCard: vi.fn(), onUnsupportedCode: vi.fn() });
    await expect(scanner.start()).rejects.toThrow('Camera is unavailable');
    expect(cardTokenFromScan(`https://chat.globalbr.ai/c/${token}`)).toBe(token);
  });
});
