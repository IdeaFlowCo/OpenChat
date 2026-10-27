import { ApiError, errorFromResponse } from '../api/errors';
import { describe, expect, it } from 'vitest';
import { uncertainVisionAlert, presentVisionSaveFailure } from './visionSaveFeedback';
describe('uncertain Vision alert presented props',()=>{
 it('shows the opaque search marker from the receipt and keeps the duplication warning',()=>{
  const marker='openchat-save:'+'a'.repeat(64);
  const props=uncertainVisionAlert('Vision may have saved this. Check Vision for '+marker);
  expect(props.title).toBe('Save outcome unknown');expect(props.message).toContain(marker);expect(props.message).toContain('duplicate');
 });
 it('missing marker does not claim failed execution or promise safe retry',()=>{expect(uncertainVisionAlert().message).toContain('absence is not proof');});
});

describe('real non-2xx response through Save catch presenter', () => {
 it('preserves the uncertain marker from an actual 503 Response into Alert props', async () => {
  const marker = 'openchat-save:' + 'b'.repeat(64);
  const response = new Response(JSON.stringify({status: 'uncertain', reason: 'Check Vision for ' + marker}), {status: 503});
  const failure = await errorFromResponse(response);
  expect(failure).toBeInstanceOf(ApiError);
  const displayed: string[] = [];
  try { throw failure; } catch (error) { presentVisionSaveFailure(error, (title, message) => displayed.push(title, message)); }
  expect(displayed[0]).toBe('Save outcome unknown');
  expect(displayed[1]).toContain(marker); expect(displayed[1]).toContain('duplicate');
 });
 it.each([new ApiError(503, 'bad payload', 'not-json'), new ApiError(400, 'rejected', '{"status":"uncertain"}'), new Error('connection lost')])('keeps unknown transport fallback conservative', error => {
  const displayed: string[] = []; presentVisionSaveFailure(error, (title, message) => displayed.push(title, message));
  expect(displayed[0]).toBe('Save receipt unavailable');expect(displayed[1]).toContain('may have saved');
 });
});
