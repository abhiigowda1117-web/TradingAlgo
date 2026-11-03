/** Small API client. Cookies carry the session; state-changing requests also send the CSRF token. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export const setCsrfToken = (t: string | null) => {
  csrfToken = t;
};
export const setUnauthorizedHandler = (fn: (() => void) | null) => {
  onUnauthorized = fn;
};

export async function api<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.method === 'POST' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(path, { method: init.method ?? 'GET', headers, credentials: 'same-origin', body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Is it running?');
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized?.();
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Request failed (HTTP ${res.status})`);
  return body as T;
}
