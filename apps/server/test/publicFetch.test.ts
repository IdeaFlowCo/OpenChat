import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { gzipSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));
import { publicGet } from '../src/services/publicFetch.js';
import { fetchPreview } from '../src/services/linkPreview.js';
import { transcribeAudio } from '../src/services/transcribeVoice.js';

let server: http.Server, port: number;
const sockets = new Set<net.Socket>();
const hits: string[] = [], pins: string[] = [];
const opts = { timeoutMs: 500, maxBytes: 1024 };
beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url!);
    const requestUrl = new URL(req.url!, 'http://fixture.test');
    if (requestUrl.pathname === '/sized') {
      const size = Number(requestUrl.searchParams.get('bytes'));
      const html = requestUrl.searchParams.get('html') === '1';
      const prefix = html ? '<title>Boundary preview</title>' : '';
      const body = Buffer.concat([Buffer.from(prefix), Buffer.alloc(size - prefix.length, 32)]);
      res.writeHead(200, { 'content-type': html ? 'text/html' : 'audio/webm', 'content-encoding': 'gzip' });
      res.end(gzipSync(body)); return;
    }
    if (req.url === '/redirect-private') { res.writeHead(302, { location: 'http://metadata.test/secret' }).end(); return; }
    if (req.url === '/redirect-literal') { res.writeHead(307, { location: 'http://[::ffff:7f00:1]/secret' }).end(); return; }
    if (req.url === '/redirect-public') { res.writeHead(301, { location: 'http://cdn.test/html' }).end(); return; }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }).end(); return; }
    if (req.url === '/large') { res.writeHead(200); res.write(Buffer.alloc(800)); res.end(Buffer.alloc(800)); return; }
    if (req.url === '/compressed') { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(gzipSync(Buffer.alloc(5000))); return; }
    if (req.url === '/slow') { res.writeHead(200); res.write('partial'); return; }
    if (req.url === '/html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Public preview</title><meta property="og:image" content="/picture.png">'); return; }
    res.writeHead(200, { 'content-type': 'audio/webm' }); res.end('synthetic audio');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  port = (server.address() as net.AddressInfo).port;
});
afterAll(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(done => server.close(() => done())); });
afterEach(() => { vi.restoreAllMocks(); dns.lookup.mockReset(); hits.length = 0; pins.length = 0; });

// A synthetic public-network fixture: use Node's real HTTP request/response and
// socket lifecycle, but map the already-pinned destination to our local server.
// No production opt-in permits private addresses. The resolver remains distinct
// from the connection's lookup so a second DNS resolution is observable.
function publicNetwork() {
  dns.lookup.mockImplementation(async (host: string) => [{ address: host === 'metadata.test' ? '169.254.169.254' : '93.184.216.34', family: 4 }]);
  vi.spyOn(http.Agent.prototype, 'createConnection').mockImplementation((options: any, callback: any) => {
    options.lookup(options.host, {}, (error: Error | null, address: string) => {
      if (error) throw error;
      pins.push(address);
    });
    return net.createConnection({ host: '127.0.0.1', port }, callback);
  });
}

describe('public GET connection and redirect boundary', () => {
  it.each(['http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://10.1.2.3/', 'http://169.254.169.254/', 'http://100.64.1.2/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[fc00::1]/', 'http://[fe80::1]/', 'file:///etc/passwd', 'http://user:password@example.test/'])('rejects %s before connecting', async url => {
    publicNetwork(); await expect(publicGet(url, opts)).rejects.toThrow(); expect(hits).toEqual([]); expect(pins).toEqual([]);
  });
  it('rejects any private DNS answer, including mixed IPv4/IPv6', async () => {
    publicNetwork(); dns.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '::ffff:a00:1', family: 6 }]);
    await expect(publicGet('http://public.test/audio', opts)).rejects.toThrow('Blocked'); expect(pins).toEqual([]);
  });
  it.each(['/redirect-private', '/redirect-literal'])('rejects redirect target %s before a second connection', async path => {
    publicNetwork(); await expect(publicGet('http://public.test' + path, opts)).rejects.toThrow('Blocked'); expect(hits).toEqual([path]); expect(pins).toEqual(['93.184.216.34']);
  });
  it('pins the approved DNS answer rather than resolving again at connection time', async () => {
    publicNetwork(); dns.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    expect((await publicGet('http://public.test/audio', opts)).body.toString()).toBe('synthetic audio'); expect(dns.lookup).toHaveBeenCalledTimes(1); expect(pins).toEqual(['93.184.216.34']);
  });
  it.each([
    { address: '2606:4700:4700::1111', family: 6 },
    { address: '93.184.216.35', family: 4 },
  ])('falls back from an unreachable public IPv$family address without resolving again', async first => {
    const targets = [first, { address: '93.184.216.34', family: 4 }];
    dns.lookup.mockResolvedValueOnce(targets).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const failed: string[] = [];
    vi.spyOn(http.Agent.prototype, 'createConnection').mockImplementation((options: any, callback: any) => {
      const socket = net.createConnection({
        ...options, port,
        lookup: (host: string, lookupOptions: any, done: any) => {
          options.lookup(host, lookupOptions, (error: Error | null, addresses: any, family: number) => {
            queueMicrotask(() => {
              if (error) { done(error); return; }
              const map = (address: string) => address === first.address ? (first.family === 6 ? '::1' : '127.0.0.2') : '127.0.0.1';
              if (lookupOptions.all) {
                pins.push(...addresses.map((entry: any) => entry.address));
                done(null, addresses.map((entry: any) => ({ ...entry, address: map(entry.address) })));
              } else {
                pins.push(addresses);
                done(null, map(addresses), family);
              }
            });
          });
        },
      }, callback);
      socket.on('connectionAttemptFailed', address => failed.push(address));
      socket.on('connectionAttemptTimeout', address => failed.push(address));
      return socket;
    });
    expect((await publicGet('http://public.test/audio', { ...opts, timeoutMs: 2000 })).body.toString()).toBe('synthetic audio');
    expect(failed).toEqual([first.family === 6 ? '::1' : '127.0.0.2']);
    expect(pins).toEqual(targets.map(entry => entry.address));
    expect(hits).toEqual(['/audio']);
    expect(dns.lookup).toHaveBeenCalledTimes(1);
  });
  it('preserves public redirects and preview parsing', async () => {
    publicNetwork(); expect(await fetchPreview('http://public.test/redirect-public')).toMatchObject({ title: 'Public preview', image: 'http://cdn.test/picture.png' }); expect(hits).toEqual(['/redirect-public', '/html']); expect(dns.lookup).toHaveBeenCalledTimes(2);
  });
  it.each(['/large', '/compressed'])('rejects oversized chunked/decompressed body %s', async path => {
    publicNetwork(); await expect(publicGet('http://public.test' + path, opts)).rejects.toThrow('size limit');
  });
  it('bounds redirect loops and stalled bodies with one overall deadline', async () => {
    publicNetwork(); await expect(publicGet('http://public.test/loop', opts)).rejects.toThrow('redirect limit');
    await expect(publicGet('http://public.test/slow', { ...opts, timeoutMs: 40 })).rejects.toThrow();
  });
  it('bounds an unresolved DNS lookup', async () => {
    dns.lookup.mockImplementation(() => new Promise(() => {})); await expect(publicGet('http://never.test/', { ...opts, timeoutMs: 30 })).rejects.toThrow('timed out');
  });
  it('preserves audio bytes sent to the existing provider, and blocks private fetch before provider call', async () => {
    publicNetwork(); vi.stubEnv('DEEPGRAM_API_KEY', 'synthetic-key');
    const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: 'Public voice' }] }] } }), { status: 200 }));
    try {
      expect(await transcribeAudio('http://public.test/audio', 'audio/webm')).toBe('Public voice');
      expect(Buffer.from(provider.mock.calls[0][1]!.body as ArrayBuffer).toString()).toBe('synthetic audio');
      expect(await transcribeAudio('http://169.254.169.254/private', 'audio/webm')).toBeNull(); expect(provider).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllEnvs(); }
  });
  it('enforces the real preview and audio limits after decompression, including accepted boundaries', async () => {
    publicNetwork();
    vi.stubEnv('DEEPGRAM_API_KEY', 'synthetic-key');
    vi.stubEnv('OPENAI_API_KEY', '');
    const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: 'Boundary voice' }] }] } }), { status: 200 }));
    try {
      expect(await fetchPreview('http://public.test/sized?html=1&bytes=' + 5 * 1024 * 1024)).toMatchObject({ title: 'Boundary preview' });
      expect(await fetchPreview('http://public.test/sized?html=1&bytes=' + (5 * 1024 * 1024 + 1))).toBeNull();
      expect(await transcribeAudio('http://public.test/sized?bytes=' + 10 * 1024 * 1024, 'audio/webm')).toBe('Boundary voice');
      expect((provider.mock.calls[0][1]!.body as ArrayBuffer).byteLength).toBe(10 * 1024 * 1024);
      expect(await transcribeAudio('http://public.test/sized?bytes=' + (10 * 1024 * 1024 + 1), 'audio/webm')).toBeNull();
      expect(provider).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllEnvs(); }
  });
  it('preserves provider fallback and records preview/transcript outputs and denied redirect behavior', async () => {
    publicNetwork();
    vi.stubEnv('DEEPGRAM_API_KEY', 'synthetic-key');
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-key');
    const provider = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('temporary provider failure', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: 'Fallback voice transcript' }), { status: 200 }));
    try {
      const preview = await fetchPreview('http://public.test/redirect-public');
      expect(preview).toMatchObject({ title: 'Public preview', image: 'http://cdn.test/picture.png' });
      const transcript = await transcribeAudio('http://public.test/audio', 'audio/webm');
      expect(transcript).toBe('Fallback voice transcript');
      expect(provider.mock.calls.map(call => call[0])).toEqual([
        'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true',
        'https://api.openai.com/v1/audio/transcriptions',
      ]);
      const form = provider.mock.calls[1][1]!.body as FormData;
      const audio = form.get('file') as File;
      expect(await audio.text()).toBe('synthetic audio');
      expect(audio.name).toBe('voice.webm');
      expect(form.get('model')).toBe('whisper-1');
      const blockedPreview = await fetchPreview('http://public.test/redirect-private');
      const blockedTranscript = await transcribeAudio('http://public.test/redirect-literal', 'audio/webm');
      expect(blockedPreview).toBeNull();
      expect(blockedTranscript).toBeNull();
      expect(hits).toEqual(['/redirect-public', '/html', '/audio', '/redirect-private', '/redirect-literal']);
      expect(provider).toHaveBeenCalledTimes(2);
      const evidenceDirectory = process.env.PUBLIC_FETCH_EVIDENCE_DIR;
      if (evidenceDirectory) {
        await mkdir(evidenceDirectory, { recursive: true });
        await writeFile(join(evidenceDirectory, 'download-consumer-responses.json'), JSON.stringify({
          fixture: 'Real HTTP request/body/redirect flows using synthetic public DNS and local socket transport; provider POST responses simulated.',
          preview, transcript,
          providerRequests: provider.mock.calls.map(call => ({ url: call[0], method: call[1]!.method })),
          fallbackAudio: { filename: audio.name, bytes: await audio.text(), model: form.get('model') },
          blockedPreview, blockedTranscript, serverRequests: [...hits], checkedSocketAddresses: [...pins],
        }, null, 2));
      }
      provider.mockResolvedValue(new Response('provider unavailable', { status: 503 }));
      expect(await transcribeAudio('http://public.test/audio', 'audio/webm')).toBeNull();
    } finally { vi.unstubAllEnvs(); }
  });

});
