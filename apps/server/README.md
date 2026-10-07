# Public preview and voice downloads

Link previews and voice transcription use [publicFetch.ts](src/services/publicFetch.ts) for remote
GETs. Every URL and redirect must use HTTP(S) without URL credentials. All DNS
answers must be public; loopback, private, link-local, shared-address and special
IP ranges (including IPv4-mapped IPv6) are refused. The full validated address
set is pinned to a fresh, unpooled connection, allowing fallback among those
addresses without resolving DNS again; HTTPS retains the original hostname for
certificate validation. No app credential is forwarded.

Each download has a single deadline (5 seconds for previews, 20 seconds for
audio), including DNS, up to five redirects and response streaming. Previews are
limited to 5 MiB and audio to the existing 10 MiB upload limit; chunked and
compressed responses cannot bypass these limits. Failed downloads remain
best-effort: no preview or transcript is produced. Public redirects, supported
audio URLs and the existing transcription provider fallback remain supported.

The executable download and consumer regressions are in
[publicFetch.test.ts](test/publicFetch.test.ts).
