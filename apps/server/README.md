
### Public preview and voice downloads

Link previews and voice transcription use `services/publicFetch.ts` for remote
GETs. Every URL and redirect must use HTTP(S) without URL credentials. All DNS
answers must be public; loopback, private, link-local, shared-address and special
IP ranges (including IPv4-mapped IPv6) are refused. The approved address is pinned
to the actual connection with a fresh, unpooled request; HTTPS retains the
original hostname for certificate validation. No app credential is forwarded.

The single deadline includes DNS, redirects and response streaming. Previews are
limited to 5 MiB and audio to the existing 10 MiB upload limit; chunked and
compressed responses cannot bypass these limits. Failed downloads remain
best-effort: no preview or transcript is produced. Public redirects, supported
audio URLs and the existing transcription provider fallback remain supported.
