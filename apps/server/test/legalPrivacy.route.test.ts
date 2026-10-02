import express from 'express';
import request from 'supertest';
import { load } from 'cheerio';
import { readFileSync, writeFileSync } from 'node:fs';
import { marked } from 'marked';
import { describe, expect, it } from 'vitest';
import legalRouter from '../src/routes/legal.js';

// The emitted public policy and release-owner guide are owned text contracts.
// Exercise the HTTP renderer rather than inspecting its implementation.
describe('privacy disclosure output', () => {
  it('serves the voice, storage and diagnostic disclosures without sign-in', async () => {
    const app = express();
    app.use('/legal', legalRouter);
    const response = await request(app).get('/legal/privacy').expect(200);
    expect(response.headers['content-type']).toContain('text/html');
    const $ = load(response.text);
    expect($('title').text()).toBe('Privacy Policy — OpenChat');
    const paragraphs = $('p').map((_, element) => $(element).text()).get();
    const voice = paragraphs.find(text => text.startsWith('When you send a voice message'));
    expect(voice).toContain('Deepgram');
    expect(voice).toContain('OpenAI as a fallback');
    expect(voice).toContain('human-only conversations');
    expect(voice).toContain('store the transcript with the message');
    const storage = paragraphs.find(text => text.startsWith('Messages and attachments.'));
    expect(storage).toContain('uploaded photos, voice recordings and their transcripts');
    expect(storage).toContain('servers and storage services');
    const diagnostics = paragraphs.find(text => text.startsWith('Diagnostics.'));
    for (const disclosure of ['fatal uncaught errors', 'unhandled promise rejections', 'stack traces', 'app version', 'device platform', 'IP addresses', 'user-agent']) {
      expect(diagnostics).toContain(disclosure);
    }
    const links = $('a').map((_, element) => $(element).attr('href')).get();
    expect(links).toContain('https://deepgram.com/privacy');
    expect(links).toContain('https://openai.com/policies/privacy-policy/');
    expect(links).toContain('https://www.anthropic.com/privacy');
    expect(response.text).toContain('support@ideaflow.app');
    expect(response.text).not.toContain('support@chat.globalbr.ai');
    if (process.env.PRIVACY_TEST_EVIDENCE_DIR) {
      writeFileSync(`${process.env.PRIVACY_TEST_EVIDENCE_DIR}/privacy-policy.html`, response.text);
    }
  });

  it('renders the release-owner guide with conservative diagnostic and presence classifications', () => {
    const markdown = readFileSync(new URL('../../../docs/app-store-privacy-labels.md', import.meta.url), 'utf8');
    const html = marked.parse(markdown, { async: false });
    const $ = load(html);
    // Normalize the guide's questionnaire tables into data-type records.
    const rows = $('table tbody tr').map((_, element) => ({
      cells: $(element).find('td').map((_, cell) => $(cell).text()).get(),
    })).get();
    const classification = (name: string) => rows.find(row => row.cells[0].startsWith(name))?.cells.slice(1);
    expect(classification('Crash Data')).toEqual(['YES', 'YES (conservative; see notes)', 'NO', 'App Functionality (debugging)']);
    expect(classification('Other Diagnostic Data')).toEqual(['YES (/api/client-logs mobile/web errors and warnings)', 'YES (conservative; see notes)', 'NO', 'App Functionality (debugging)']);
    expect(classification('Other Usage Data')).toEqual(['YES', 'YES', 'NO', 'App Functionality (presence)']);
    expect(classification('Deepgram')).toEqual(['Uploaded voice-message audio', 'App Functionality (generating transcripts, including in human-only chats)']);
    expect(classification('OpenAI')).toEqual(['Uploaded voice-message audio when the primary transcription path does not return text', 'App Functionality (generating transcripts)']);
    if (process.env.PRIVACY_TEST_EVIDENCE_DIR) {
      writeFileSync(`${process.env.PRIVACY_TEST_EVIDENCE_DIR}/app-store-privacy-guide.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><title>App Store Privacy Labels — OpenChat</title><body>${html}</body></html>`);
    }
  });
});
