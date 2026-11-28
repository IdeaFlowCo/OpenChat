const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i;

export function websiteDraft(input: string) {
  const text = input.trim();
  const scheme = text.match(/^https?:\/\//i)?.[0];
  const address = text.slice(scheme?.length ?? 0);
  const authority = address.split(/[/?#]/, 1)[0];
  if (!scheme && !domainPattern.test(authority.replace(/:\d+$/, ''))) return null;
  if (!domainPattern.test(authority) || address.length > 2048 || /[\\\s\u0000-\u001f]/.test(address)) {
    return { domain: 'Website', url: null };
  }
  const domain = authority.toLowerCase();
  // Drop these before contacting OpenChat too. React Native's URL has getter-only fields.
  const path = address.slice(authority.length).split(/[?#]/, 1)[0];
  return { domain, url: `https://${domain}${path}` };
}
