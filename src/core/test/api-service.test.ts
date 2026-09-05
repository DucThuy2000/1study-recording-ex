import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ApiService,
  ApiNetworkError,
  ApiAuthError,
  ApiHttpError,
} from '../api-service';

describe('ApiService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('performs GET request with query parameters', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { id: 123 } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const api = new ApiService({ baseUrl: 'https://api.example.com/' });
    const result = await api.get<{ success: boolean; data: { id: number } }>('test', {
      foo: 'bar',
      num: 42,
    });

    expect(result).toEqual({ success: true, data: { id: 123 } });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/test?foo=bar&num=42',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Accept: 'application/json' }),
      }),
    );
  });

  it('performs POST request with body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const api = new ApiService({ baseUrl: 'https://api.example.com/' });
    const result = await api.post<{ success: boolean }>('submit', { name: 'test' });

    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/submit',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'test' }),
        headers: expect.objectContaining({
          Accept: 'application/json',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('performs POST request without body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const api = new ApiService({ baseUrl: 'https://api.example.com' });
    const result = await api.post<{ success: boolean }>('empty');

    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/empty',
      expect.objectContaining({
        method: 'POST',
        body: undefined,
      }),
    );
  });

  it('throws ApiAuthError on 401 or 403', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({ message: 'NOT_LOGGED_IN' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const api = new ApiService();
    await expect(api.get('https://api.example.com/auth')).rejects.toThrow(ApiAuthError);

    try {
      await api.get('https://api.example.com/auth');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiAuthError);
      const authErr = err as ApiAuthError;
      expect(authErr.status).toBe(403);
      expect(authErr.responseBody).toEqual({ message: 'NOT_LOGGED_IN' });
    }

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ message: 'TOKEN_EXPIRED' }),
    });
    await expect(api.get('https://api.example.com/auth-401')).rejects.toThrow(ApiAuthError);
  });

  it('throws ApiHttpError on 500 with response body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ error: 'server broke' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const api = new ApiService();
    await expect(api.get('https://api.example.com/fail')).rejects.toThrow(ApiHttpError);

    try {
      await api.get('https://api.example.com/fail');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiHttpError);
      const httpErr = err as ApiHttpError;
      expect(httpErr.status).toBe(500);
      expect(httpErr.responseBody).toEqual({ error: 'server broke' });
    }
  });

  it('throws ApiNetworkError when fetch rejects or aborts', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', mockFetch);

    const api = new ApiService();
    await expect(api.get('https://api.example.com/network-error')).rejects.toThrow(
      ApiNetworkError,
    );

    try {
      await api.get('https://api.example.com/network-error');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiNetworkError);
      const netErr = err as ApiNetworkError;
      expect(netErr.message).toBe('Failed to fetch');
      expect(netErr.cause).toBeInstanceOf(TypeError);
    }
  });

  it('handles non-Error rejection in fetch', async () => {
    const mockFetch = vi.fn().mockRejectedValue('network died');
    vi.stubGlobal('fetch', mockFetch);

    const api = new ApiService();
    await expect(api.get('https://api.example.com/unknown-error')).rejects.toThrow(
      ApiNetworkError,
    );
  });

  it('passes credentials and custom defaultHeaders to fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const api = new ApiService({
      baseUrl: 'https://api.example.com',
      credentials: 'include',
      defaultHeaders: {
        'X-Custom-Header': 'custom-value',
      },
    });

    await api.get('test');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/test',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({
          Accept: 'application/json',
          'X-Custom-Header': 'custom-value',
        }),
      }),
    );
  });

  it('defaults credentials to omit when not provided in options', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const api = new ApiService({ baseUrl: 'https://api.example.com' });
    await api.get('test');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/test',
      expect.objectContaining({
        credentials: 'omit',
      }),
    );
  });

  it('handles string and FormData request bodies in POST without double stringifying', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const api = new ApiService({ baseUrl: 'https://api.example.com' });

    // String body
    await api.post('raw', 'raw-string-content');
    expect(mockFetch).toHaveBeenLastCalledWith(
      'https://api.example.com/raw',
      expect.objectContaining({
        body: 'raw-string-content',
      }),
    );

    // FormData body
    const formData = new FormData();
    formData.append('key', 'value');
    await api.post('form', formData);
    expect(mockFetch).toHaveBeenLastCalledWith(
      'https://api.example.com/form',
      expect.objectContaining({
        body: formData,
      }),
    );
  });

  it('handles text/plain response when content-type is not JSON', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => 'hello plain text',
    });
    vi.stubGlobal('fetch', mockFetch);

    const api = new ApiService({ baseUrl: 'https://api.example.com' });
    const result = await api.get<string>('text-endpoint');

    expect(result).toBe('hello plain text');
  });

  it('normalizes URL construction with various trailing/leading slash combinations', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', mockFetch);

    // 1. baseUrl with trailing slash + endpoint with leading slash -> no double slash
    const api1 = new ApiService({ baseUrl: 'https://api.example.com/' });
    await api1.get('/users');
    expect(mockFetch).toHaveBeenLastCalledWith('https://api.example.com/users', expect.anything());

    // 2. baseUrl without trailing slash + endpoint without leading slash -> slash inserted
    const api2 = new ApiService({ baseUrl: 'https://api.example.com' });
    await api2.get('users');
    expect(mockFetch).toHaveBeenLastCalledWith('https://api.example.com/users', expect.anything());

    // 3. absolute endpoint ignores baseUrl
    await api2.get('https://other.example.com/data');
    expect(mockFetch).toHaveBeenLastCalledWith('https://other.example.com/data', expect.anything());
  });

  it('aborts request on timeout and throws ApiNetworkError', async () => {
    vi.useFakeTimers();

    const mockFetch = vi.fn().mockImplementation((_url, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    const api = new ApiService({ timeoutMs: 1000 });
    const reqPromise = api.get('https://api.example.com/slow');

    vi.advanceTimersByTime(1001);

    await expect(reqPromise).rejects.toThrow(ApiNetworkError);

    vi.useRealTimers();
  });
});
