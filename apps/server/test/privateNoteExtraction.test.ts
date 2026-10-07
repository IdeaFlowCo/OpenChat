import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: mocks.create }; } }));
import { extractNoteSuggestions } from '../src/services/privateNoteReview.js';
const note = 'Knows, family offices in Bay Area. Also, he’s advisor to some bank.';
const proposal = { kind: 'connection', text: 'Knows family offices', relation: 'knows', target: { kind: 'company', name: 'Family offices in Bay Area' }, evidence: 'Knows family offices in Bay Area' };
const response = (evidence: string) => ({ content: [{ type: 'tool_use', id: 'proposal-1', name: 'propose', input: { suggestions: [{ ...proposal, evidence }] } }] });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('ANTHROPIC_API_KEY', 'test-only'); });
afterEach(() => vi.unstubAllEnvs());
describe('private note extraction repair', () => {
  it('repairs a paraphrased quotation without changing the saved source', async () => {
    mocks.create.mockResolvedValueOnce(response(proposal.evidence)).mockResolvedValueOnce(response('Knows, family offices in Bay Area'));
    const suggestions = await extractNoteSuggestions(note, 'Contact');
    expect(suggestions?.[0].evidence).toBe('Knows, family offices in Bay Area');
    expect(mocks.create).toHaveBeenCalledTimes(2);
    const retry = mocks.create.mock.calls[1][0];
    expect(retry.messages[0].content).toBe(JSON.stringify({ subjectName: 'Contact', note }));
    expect(retry.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'proposal-1', is_error: true });
  });
  it('still rejects invented evidence after one repair attempt', async () => {
    mocks.create.mockResolvedValue(response('CEO of the bank'));
    await expect(extractNoteSuggestions(note, 'Contact')).rejects.toThrow('Source excerpt');
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });
  it('does not repeat a valid result or a provider error', async () => {
    mocks.create.mockResolvedValueOnce(response('family offices in Bay Area'));
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
