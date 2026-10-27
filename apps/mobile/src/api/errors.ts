/** Typed failure emitted by the real request() non-2xx path. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public body: string) {
    super(message);
    this.name = 'ApiError';
  }
}
export async function errorFromResponse(response: Pick<Response, 'status' | 'text'>): Promise<ApiError> {
  const text = await response.text();
  let message = text;
  try { const body = JSON.parse(text); message = body.error || body.message || text; } catch { /* not JSON */ }
  return new ApiError(response.status, `${response.status}: ${message}`, text);
}
