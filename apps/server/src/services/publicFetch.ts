/** Public GETs only. Resolve every hop, reject mixed/private DNS answers, and
 * pin the checked address to the actual socket while retaining HTTPS SNI/Host.
 * No cookies, authorization, proxy environment, or reusable connection pool. */
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { isBlockedAddress } from './webhookDispatch.js';

interface Options { timeoutMs: number; maxBytes: number; headers?: Record<string, string> }
export interface PublicResponse { status: number; headers: http.IncomingHttpHeaders; body: Buffer; url: string }

async function resolveTarget(url: URL, signal: AbortSignal) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported public URL');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostname.endsWith('.localhost') || hostname === 'localhost') throw new Error('Blocked public target');
  const abort = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const entries = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await Promise.race([lookup(hostname, { all: true, verbatim: true }), abort]);
  if (!entries.length || entries.some(entry => isBlockedAddress(entry.address))) throw new Error('Blocked public target');
  return entries[0] as { address: string; family: 4 | 6 };
}

function getHop(url: URL, target: { address: string; family: 4 | 6 }, signal: AbortSignal, options: Options): Promise<PublicResponse> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', agent: false, signal, family: target.family,
      headers: { ...options.headers, 'Accept-Encoding': 'identity' },
      lookup: (_host, lookupOptions, callback) => {
        // Node can request all addresses; either form returns only the pinned one.
        if (lookupOptions.all) callback(null, [target]);
        else callback(null, target.address, target.family);
      },
    }, res => {
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.destroy();
        resolve({ status, headers: res.headers, body: Buffer.alloc(0), url: url.href });
        return;
      }
      if (Number(res.headers['content-length']) > options.maxBytes) {
        reject(new Error('Public response exceeds size limit')); res.destroy(); return;
      }
      const encoding = res.headers['content-encoding']?.toLowerCase();
      const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
      if (encoding && encoding !== 'identity' && !decoder) {
        res.destroy(); reject(new Error('Unsupported public response encoding')); return;
      }
      const stream = decoder ? res.pipe(decoder) : res;
      const chunks: Buffer[] = [];
      let bytes = 0, wireBytes = 0;
      const fail = (error: Error) => { reject(error); res.destroy(); decoder?.destroy(); };
      signal.addEventListener('abort', () => fail(new Error('Public fetch timed out')), { once: true });
      res.on('error', fail);
      res.on('aborted', () => fail(new Error('Public response aborted')));
      if (decoder) res.on('data', (chunk: Buffer) => {
        wireBytes += chunk.length;
        if (wireBytes > options.maxBytes) fail(new Error('Public response exceeds size limit'));
      });
      stream.on('error', fail);
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > options.maxBytes) fail(new Error('Public response exceeds size limit'));
        else chunks.push(chunk);
      });
      stream.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks), url: url.href }));
    });
    req.on('error', reject);
    req.end();
  });
}

export async function publicGet(rawUrl: string, options: Options): Promise<PublicResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Public fetch timed out')), options.timeoutMs);
  try {
    let url = new URL(rawUrl);
    for (let hop = 0; hop <= 5; hop++) {
      controller.signal.throwIfAborted();
      const target = await resolveTarget(url, controller.signal);
      controller.signal.throwIfAborted();
      const response = await getHop(url, target, controller.signal, options);
      if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.location) return response;
      url = new URL(response.headers.location, url);
    }
    throw new Error('Public fetch redirect limit exceeded');
  } finally { clearTimeout(timer); }
}
