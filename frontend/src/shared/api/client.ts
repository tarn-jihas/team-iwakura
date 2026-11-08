export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  /** Treat an HTTP 403 with `allowed: false` as a valid answer (the Lumen premium gate). */
  allowDenied?: boolean;
}

/**
 * A client restricted to local routes. Each module creates its own client with the
 * prefixes it is allowed to call, so one module cannot reach another module's routes.
 */
export function createClient(prefixes: readonly string[], serverLabel: string) {
  return async function request<T = unknown>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    if (!prefixes.some(p => path.startsWith(p))) throw new Error('Only local mock routes are available.');
    const response = await fetch(
      path,
      body === undefined
        ? { cache: 'no-store' }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    const result = await response.json();
    const denied = options.allowDenied && response.status === 403 && result?.allowed === false;
    if (!response.ok && !denied) throw new ApiError(result?.error || `${serverLabel} returned ${response.status}`, response.status);
    return result as T;
  };
}

export async function fetchText(path: string): Promise<string> {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not read local export.');
  return response.text();
}
