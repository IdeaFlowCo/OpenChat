import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: mocks.create }; } }));
import { extractNoteSuggestions } from '../src/services/privateNoteReview.js';
const note = 'Knows, family offices in Bay Area\nAlso, he’s advisor to some bank.';
const proposal = { kind: 'connection', text: 'Knows family offices', relation: 'knows', target: { kind: 'company', name: 'Family offices in Bay Area' }, evidence: 'Knows family offices in Bay Area' };
const response = (evidenceIndex: number) => ({ content: [{ type: 'tool_use', id: 'proposal-1', name: 'propose', input: { suggestions: [{ ...proposal, evidenceIndex }] } }] });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('ANTHROPIC_API_KEY', 'test-only'); });
afterEach(() => vi.unstubAllEnvs());
describe('private note extraction repair', () => {
  it('repairs an invalid passage index and attaches verbatim source despite model paraphrasing', async () => {
    mocks.create.mockResolvedValueOnce(response(-1)).mockResolvedValueOnce(response(0));
    const suggestions = await extractNoteSuggestions(note, 'Contact');
    expect(suggestions?.[0].evidence).toBe('Knows, family offices in Bay Area');
    expect(mocks.create).toHaveBeenCalledTimes(2);
    const retry = mocks.create.mock.calls[1][0];
    expect(retry.messages[0].content).toBe(JSON.stringify({ subjectName: 'Contact', note, evidencePassages: note.split('\n').map((text, index) => ({ index, text })) }));
    expect(retry.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'proposal-1', is_error: true });
  });
  it('still rejects invented evidence after one repair attempt', async () => {
    mocks.create.mockResolvedValue(response(99));
    await expect(extractNoteSuggestions(note, 'Contact')).rejects.toThrow('evidenceIndex');
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });
  it('does not repeat a valid result or a provider error', async () => {
    mocks.create.mockResolvedValueOnce(response(0));
    await expect(extractNoteSuggestions(note, 'Contact')).resolves.toHaveLength(1);
    mocks.create.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(extractNoteSuggestions(note, 'Contact')).rejects.toThrow('provider unavailable');
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });
  it('returns unavailable without a provider credential', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(await extractNoteSuggestions(note, 'Contact')).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
