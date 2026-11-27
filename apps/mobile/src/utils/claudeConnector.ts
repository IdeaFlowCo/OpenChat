import { Linking } from 'react-native';

/** The shared Ideaflow connector: one connection for OpenChat, Unlinked and Notestream Vision. */
export const IDEAFLOW_MCP_URL = 'https://id.ideaflow.app/mcp';
export const IDEAFLOW_CONNECTOR_NAME = 'Ideaflow';

/**
 * Claude's documented "Add custom connector" deep link, prefilled with the
 * Ideaflow connector (https://claude.com/docs/connectors/building/directory-vs-custom).
 * The person still reviews and clicks Add in Claude, then approves on Ideaflow ID.
 */
export function claudeConnectorUrl(name: string = IDEAFLOW_CONNECTOR_NAME, url: string = IDEAFLOW_MCP_URL): string {
  const query = new URLSearchParams({ modal: 'add-custom-connector', connectorName: name, connectorUrl: url });
  return `https://claude.ai/customize/connectors?${query.toString().replace(/\+/g, '%20')}`;
}

/**
 * Where to send a link so it opens in the phone's browser. Claude's iOS and
 * Android apps cannot add connectors, and a plain https link to claude.ai may be
 * handed to them, so iOS asks Safari directly (x-safari-https, iOS 17+) and
 * falls back to the plain link. Android and the web open the plain link: on
 * Android the Claude app may still claim it (there is no reliable way to force
 * the browser without pinning a browser package), so the error copy gives the
 * manual path.
 */
export function systemBrowserTargets(url: string, os: string): string[] {
  if (os === 'ios' && url.startsWith('https://')) return [`x-safari-${url}`, url];
  return [url];
}

/** Tries each target in order; resolves false only when none could be opened. */
export async function openInSystemBrowser(url: string, os: string, open: (target: string) => Promise<unknown> = target => Linking.openURL(target)): Promise<boolean> {
  for (const target of systemBrowserTargets(url, os)) {
    try { await open(target); return true; } catch { /* try the next target */ }
  }
  return false;
}
