// Shared by the website and authentication forms; never retries a mutation.
export async function requestJson<T>(url: string, options: {
  method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number;
} = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const readOnly = method === 'GET' || method === 'HEAD';
  const signal = AbortSignal.timeout(options.timeoutMs ?? 180000);
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method, redirect: 'error', signal,
      headers: { ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    text = await response.text();
  } catch {
    throw new Error(!readOnly ? 'REQUEST_UNCONFIRMED' : signal.aborted ? 'REQUEST_TIMEOUT' : 'OFFLINE');
  }
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new Error(readOnly ? 'SERVER_RESPONSE_INVALID' : 'REQUEST_UNCONFIRMED');
  let data: T & { error?: unknown; code?: string };
  try { data = JSON.parse(text); }
  catch { throw new Error(readOnly ? 'SERVER_RESPONSE_INVALID' : 'REQUEST_UNCONFIRMED'); }
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : data?.code ?? `HTTP_${response.status}`);
  return data;
}
