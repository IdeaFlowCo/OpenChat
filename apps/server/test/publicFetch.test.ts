import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { gzipSync } from 'node:zlib';
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
});
