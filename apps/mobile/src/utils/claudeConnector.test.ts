import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Linking: { openURL: vi.fn() } }));

import { claudeConnectorUrl, IDEAFLOW_MCP_URL, openInSystemBrowser, systemBrowserTargets } from './claudeConnector';

describe('Connect Claude deep link', () => {
  it('opens Claude\'s Add custom connector dialog prefilled with the Ideaflow connector', () => {
    expect(claudeConnectorUrl()).toBe('https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Ideaflow&connectorUrl=https%3A%2F%2Fid.ideaflow.app%2Fmcp');
    const parsed = new URL(claudeConnectorUrl());
    expect(parsed.origin).toBe('https://claude.ai');
    expect(parsed.searchParams.get('connectorUrl')).toBe(IDEAFLOW_MCP_URL);
    expect([...parsed.searchParams.keys()]).toEqual(['modal', 'connectorName', 'connectorUrl']);
  });

  it('percent-encodes names and URLs (spaces as %20, never +)', () => {
    expect(claudeConnectorUrl('Ideaflow Ecosystem', 'https://example.test/mcp?a=1&b=2')).toBe('https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Ideaflow%20Ecosystem&connectorUrl=https%3A%2F%2Fexample.test%2Fmcp%3Fa%3D1%26b%3D2');
  });
});

describe('system browser on phones', () => {
  const url = claudeConnectorUrl();
  it('asks Safari directly on iOS, then falls back to the plain link', () => {
    expect(systemBrowserTargets(url, 'ios')).toEqual([`x-safari-${url}`, url]);
    expect(systemBrowserTargets(url, 'android')).toEqual([url]);
    expect(systemBrowserTargets(url, 'web')).toEqual([url]);
    expect(systemBrowserTargets('http://example.test/', 'ios')).toEqual(['http://example.test/']);
  });

  it('falls back when Safari\'s scheme is refused, and reports when nothing opened', async () => {
    const tried: string[] = [];
    const refuseSafari = async (target: string) => { tried.push(target); if (target.startsWith('x-safari-')) throw new Error('unsupported'); };
    await expect(openInSystemBrowser(url, 'ios', refuseSafari)).resolves.toBe(true);
    expect(tried).toEqual([`x-safari-${url}`, url]);
    await expect(openInSystemBrowser(url, 'web', async () => { throw new Error('blocked'); })).resolves.toBe(false);
    const both: string[] = [];
    await expect(openInSystemBrowser(url, 'ios', async target => { both.push(target); throw new Error('blocked'); })).resolves.toBe(false);
    expect(both).toEqual([`x-safari-${url}`, url]);
  });
});
