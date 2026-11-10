/**
 * What a shared link is, and what to call it (OpenChat-c8to.3).
 *
 * Pure functions: URL normalisation, a kind guess, suggested tags and tag
 * validation. The guess reads only the address and the page's public title and
 * description, never message text, and is a starting point every member can
 * edit. Nothing here talks to the network or the database.
 */

export const RESOURCE_KINDS = [
  'paper', 'article', 'reference', 'person', 'tool', 'organization', 'community',
  'code', 'video', 'document', 'post', 'event', 'link',
] as const;
export type ResourceKind = typeof RESOURCE_KINDS[number];

export const RESOURCE_LIMITS = { tags: 12, tag: 40, urlsPerMessage: 10, url: 2000 } as const;

export class ResourceInputError extends Error {}

const URL_RE = /https?:\/\/[^\s)\]'"<>]+/g;
const TRACKING = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|igshid|si|ref_src|ref_url)$/i;

/** Every distinct http(s) address in a message, in order, up to a small cap. */
export function extractResourceUrls(text: string | null | undefined): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(/[.,!?:;]+$/, '');
    if (url.length <= RESOURCE_LIMITS.url && !found.includes(url)) found.push(url);
    if (found.length >= RESOURCE_LIMITS.urlsPerMessage) break;
  }
  return found;
}

export interface NormalizedUrl { url: string; urlKey: string; host: string; path: string }

/**
 * One resource per page: `http`/`https`, `www.`, a trailing slash, a fragment
 * and tracking parameters do not make a different resource. Returns null for
 * anything that is not a public-looking http(s) address.
 */
export function normalizeResourceUrl(raw: string): NormalizedUrl | null {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!host.includes('.')) return null;
  const params = [...parsed.searchParams.entries()].filter(([name]) => !TRACKING.test(name)).sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  const port = parsed.port ? `:${parsed.port}` : '';
  parsed.hash = '';
  parsed.search = query;
  return { url: parsed.toString(), urlKey: `${host}${port}${path}${query}`, host, path };
}

const slug = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, RESOURCE_LIMITS.tag);

const TAG = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u;

/**
 * Tags a member typed: trimmed, a leading `#` dropped, NFKC, lower-cased,
 * inner spaces turned into hyphens, duplicates removed. Throws on anything
 * that is still not a plain tag, so nothing odd is stored.
 */
export function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) throw new ResourceInputError('tags must be a list');
  if (input.length > RESOURCE_LIMITS.tags * 2) throw new ResourceInputError(`At most ${RESOURCE_LIMITS.tags} tags`);
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') throw new ResourceInputError('Each tag must be text');
    const tag = raw.normalize('NFKC').trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-');
    if (!tag) continue;
    if (tag.length > RESOURCE_LIMITS.tag || !TAG.test(tag)) throw new ResourceInputError(`"${raw.slice(0, 60)}" is not a usable tag. Use letters, numbers, hyphens or underscores, up to ${RESOURCE_LIMITS.tag} characters.`);
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > RESOURCE_LIMITS.tags) throw new ResourceInputError(`At most ${RESOURCE_LIMITS.tags} tags`);
  return out;
}

export function isResourceKind(value: unknown): value is ResourceKind {
  return typeof value === 'string' && (RESOURCE_KINDS as readonly string[]).includes(value);
}

const PAPER_HOSTS = /(^|\.)(doi\.org|dl\.acm\.org|arxiv\.org|openreview\.net|semanticscholar\.org|ieeexplore\.ieee\.org|link\.springer\.com|nature\.com|sciencedirect\.com|jstor\.org|pubmed\.ncbi\.nlm\.nih\.gov|biorxiv\.org|ssrn\.com|aclanthology\.org|pnas\.org|science\.org)$/;
const REFERENCE_HOSTS = /(^|\.)(wikipedia\.org|wiktionary\.org|wikidata\.org|britannica\.com|plato\.stanford\.edu|developer\.mozilla\.org)$/;
const CODE_HOSTS = /(^|\.)(github\.com|gitlab\.com|codeberg\.org|bitbucket\.org|npmjs\.com|pypi\.org|crates\.io)$/;
const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|loom\.com|twitch\.tv)$/;
const DOCUMENT_HOSTS = /(^|\.)(docs\.google\.com|drive\.google\.com|notion\.so|notion\.site|dropbox\.com|figma\.com|airtable\.com)$/;
const POST_HOSTS = /(^|\.)(x\.com|twitter\.com|bsky\.app|threads\.net|mastodon\.social|news\.ycombinator\.com|reddit\.com)$/;
const EVENT_HOSTS = /(^|\.)(lu\.ma|luma\.com|eventbrite\.com|partiful\.com|meetup\.com)$/;
const ARTICLE_HOSTS = /(^|\.)(substack\.com|medium\.com|nytimes\.com|theatlantic\.com|newyorker\.com|wired\.com|lesswrong\.com)$/;
const ACADEMIC_HOST = /\.(edu|ac\.[a-z]{2})$/;

/** Words in a page's own title or description that name a topic worth a tag. */
const TOPICS: Array<[RegExp, string]> = [
  [/\bknowledge[- ]graphs?\b/i, 'knowledge-graph'],
  [/\b(semantic web|linked data|giant global graph)\b/i, 'semantic-web'],
  [/\b(tools? for thought|note[- ]?taking|second brain|personal knowledge)\b/i, 'tools-for-thought'],
  [/\b(hci|human[- ]computer interaction|user interfaces?)\b/i, 'hci'],
  [/\b(ai|llms?|language models?|machine learning|artificial intelligence)\b/i, 'ai'],
  [/\b(research(ers?)?|professor|ph\.?d|laboratory)\b/i, 'research'],
  [/\bopen[- ]source\b/i, 'open-source'],
  [/\b(communit(y|ies)|collective)\b/i, 'community'],
  [/\barchives?\b/i, 'archive'],
  [/\b(chat|messaging|messenger)\b/i, 'messaging'],
  [/\b(networking|introductions?|connect(ing)? people|superconnector)\b/i, 'networking'],
  [/\b(education|learning|teaching|pedagog)/i, 'learning'],
  [/\b(design|designer)\b/i, 'design'],
  [/\b(startups?|founders?)\b/i, 'startups'],
  [/\b(organi[sz](e|ation|ing) tool|productivity|workflow)\b/i, 'productivity'],
  [/\bengelbart\b/i, 'engelbart'],
];

export interface ResourceEvidence { url: string; title?: string | null; description?: string | null; siteName?: string | null }
export interface ResourceGuess { kind: ResourceKind; suggestedTags: string[] }

/** A best guess at what the link is, with up to five suggested tags. */
export function inferResource(evidence: ResourceEvidence): ResourceGuess {
  const normalized = normalizeResourceUrl(evidence.url);
  if (!normalized) return { kind: 'link', suggestedTags: [] };
  const { host, path } = normalized;
  const labels = host.split('.');
  const segments = path.split('/').filter(Boolean);
  const text = [evidence.title, evidence.description, evidence.siteName].filter(Boolean).join(' · ');
  const tags: string[] = [];
  const add = (...values: Array<string | null | undefined>) => { for (const value of values) { const tag = value ? slug(value) : ''; if (tag && !tags.includes(tag)) tags.push(tag); } };
  let kind: ResourceKind = 'link';

  if (PAPER_HOSTS.test(host) || /(^|\/)doi\/|\/abs\/\d/.test(path) || (/\.pdf$/i.test(path) && ACADEMIC_HOST.test(host))) {
    kind = 'paper'; add('paper', 'research');
    if (/acm\.org$/.test(host)) add('acm');
    if (/arxiv\.org$/.test(host)) add('arxiv');
  } else if (REFERENCE_HOSTS.test(host) || (host === 'w3.org' && /^\/(designissues|tr)\b/i.test(path))) {
    kind = 'reference';
    if (/wikipedia\.org$/.test(host)) { add('wikipedia'); if (segments[0] === 'wiki' && segments[1]) add(decodeURIComponentSafe(segments[1]).replace(/_/g, ' ')); }
    if (host === 'w3.org') add('w3c', 'web-architecture');
  } else if (host === 'linkedin.com' && segments[0] === 'in') {
    kind = 'person'; add('linkedin');
  } else if (CODE_HOSTS.test(host)) {
    kind = 'code'; add('code'); if (segments[1]) add(segments[1]);
  } else if (VIDEO_HOSTS.test(host)) {
    kind = 'video'; add('video');
  } else if (DOCUMENT_HOSTS.test(host) || /\.(pdf|docx?|pptx?|xlsx?)$/i.test(path)) {
    kind = 'document'; add('document');
  } else if (POST_HOSTS.test(host)) {
    kind = 'post'; add('post');
  } else if (EVENT_HOSTS.test(host)) {
    kind = 'event'; add('event');
  } else if (ARTICLE_HOSTS.test(host) || /\/(blog|posts?|articles?|essays?|news)\//i.test(`${path}/`)) {
    kind = 'article'; add('article');
  } else if (segments.length <= 1 && (/\.github\.io$/.test(host) || (ACADEMIC_HOST.test(host) && labels.length >= 3))) {
    // A person's own page: name.github.io, or name.university.edu.
    kind = 'person'; add(ACADEMIC_HOST.test(host) ? 'researcher' : 'homepage');
    if (ACADEMIC_HOST.test(host)) add(labels[labels.length - 2]);
  } else if (/\b(communit(y|ies)|collective|commons)\b/i.test(`${host} ${text}`) || /(^|[-.])(community|commons)([-.]|$)/.test(host)) {
    kind = 'community';
  } else if (/\.(app|ai|dev|tools|so|io)$/.test(host) || /^(app|chat|beta|try)\./.test(host) || segments.some(part => /^(beta|app|download|pricing|signup)$/i.test(part))
    || /\b(app|beta|platform|software|tool|sign up|get started|download)\b/i.test(text)) {
    kind = 'tool';
    if (segments.some(part => /^beta$/i.test(part)) || /\bbeta\b/i.test(text)) add('beta');
  } else if (/\b(labs?|inc|company|institute|foundation|studio)\b/i.test(`${labels[0]} ${text}`) || /labs?$/.test(labels[0] ?? '')) {
    kind = 'organization';
  }

  if (kind === 'community') add('community');
  if (kind === 'tool') add('tool');
  for (const [pattern, tag] of TOPICS) if (pattern.test(text) || pattern.test(`${host} ${segments.join(' ')}`.replace(/[-_.]/g, ' '))) add(tag);
  return { kind, suggestedTags: tags.slice(0, 5) };
}

/** The DOI an address names (doi.org/10.x/y, or a publisher's /doi/10.x/y), or null. */
export function doiFromUrl(raw: string): string | null {
  const normalized = normalizeResourceUrl(raw);
  if (!normalized) return null;
  const match = /(?:^|\/)(10\.\d{4,9}\/[^\s?#]+)$/.exec(decodeURIComponentSafe(normalized.path));
  if (!match) return null;
  if (!/(^|\.)doi\.org$/.test(normalized.host) && !/\/doi\/(?:abs\/|full\/|pdf\/|epdf\/)?10\./.test(normalized.path)) return null;
  return match[1]!.replace(/\.pdf$/i, '');
}

function decodeURIComponentSafe(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}
