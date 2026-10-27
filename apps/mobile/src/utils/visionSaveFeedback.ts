/** Exact alert props used by the uncertain-save UI. Never treat a missing search hit as nonexecution. */
export function uncertainVisionAlert(reason?: string): {title: string; message: string} {
  return {title: 'Save outcome unknown', message: 'The earlier note may already exist. Check Vision first. Creating a new copy can duplicate it.\n\n' + (reason || 'No search marker was returned. Check the selected content in Vision; absence is not proof that nothing was saved.')};
}
