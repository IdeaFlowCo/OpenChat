import { ApiError } from '../api/errors';
/** Exact alert props used by the uncertain-save UI. Never treat a missing search hit as nonexecution. */
export function uncertainVisionAlert(reason?: string): {title: string; message: string} {
  return {title: 'Save outcome unknown', message: 'The earlier note may already exist. Check Vision first. Creating a new copy can duplicate it.\n\n' + (reason || 'No search marker was returned. Check the selected content in Vision; absence is not proof that nothing was saved.')};
}

/** Shared by the real Save catch path and its executable response-to-alert regression. */
export function presentVisionSaveFailure(error: unknown, alert: (title: string, message: string) => void): void {
  if (error instanceof ApiError && error.status === 503) {
    try {
      const body: unknown = JSON.parse(error.body);
      if (body && typeof body === 'object' && 'status' in body && body.status === 'uncertain') {
        const reason = 'reason' in body && typeof body.reason === 'string' ? body.reason : undefined;
        const props = uncertainVisionAlert(reason);
        alert(props.title, props.message);
        return;
      }
    } catch { /* Missing/unparseable receipt still never implies nonexecution. */ }
  }
  alert('Save receipt unavailable', 'Vision may have saved this. Your selection stays here. Check Vision before creating another save.');
}
