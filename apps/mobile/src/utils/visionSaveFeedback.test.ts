import { describe, expect, it } from 'vitest';
import { uncertainVisionAlert } from './visionSaveFeedback';
describe('uncertain Vision alert presented props',()=>{
 it('shows the opaque search marker from the receipt and keeps the duplication warning',()=>{
  const marker='openchat-save:'+'a'.repeat(64);
  const props=uncertainVisionAlert('Vision may have saved this. Check Vision for '+marker);
  expect(props.title).toBe('Save outcome unknown');expect(props.message).toContain(marker);expect(props.message).toContain('duplicate');
 });
 it('missing marker does not claim failed execution or promise safe retry',()=>{expect(uncertainVisionAlert().message).toContain('absence is not proof');});
});
