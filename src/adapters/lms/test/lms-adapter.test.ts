import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LmsAdapter } from '../lms-adapter';
import type { ApiService } from '@/src/core/api-service';
import type { ChromeStorageAdapter } from '@/src/adapters/storage';
import type { Logger } from '@/src/core/logger';
import { ApiAuthError, ApiNetworkError, ApiHttpError } from '@/src/core/api-service';

describe('LmsAdapter', () => {
  let store: Record<string, unknown>;
  let mockStorage: ChromeStorageAdapter;
  let mockApi: ApiService;
  let mockLogger: Logger;
  let adapter: LmsAdapter;

  beforeEach(() => {
    store = {};
    mockStorage = {
      get: vi.fn(async (key: string) => store[key]),
      set: vi.fn(async (key: string, value: unknown) => {
        store[key] = value;
      }),
      delete: vi.fn(async (key: string) => {
        delete store[key];
      }),
    } as unknown as ChromeStorageAdapter;

    mockApi = {
      get: vi.fn(),
      post: vi.fn(),
    } as unknown as ApiService;

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    adapter = new LmsAdapter(mockStorage, mockApi, mockLogger);
  });

  it('returns cached context if same meetingCode and within schedule window', async () => {
    const nowSec = 1725000000;
    vi.spyOn(Date, 'now').mockReturnValue(nowSec * 1000);

    store['lmsCachedContext'] = {
      meetingCode: 'abc-defg-hij',
      classroomId: 1,
      className: 'Class 1',
      scheduledStart: nowSec - 300, // started 5 mins ago
      scheduledEnd: nowSec + 3600,
      classroomStatus: 1,
      materials: [],
      cachedAtMs: (nowSec - 300) * 1000,
    };

    const result = await adapter.ensureContext('abc-defg-hij');
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.context.classroomId).toBe(1);
    }
    expect(mockApi.get).not.toHaveBeenCalled();
  });

  it('fetches context from LMS when meetingCode differs from cache', async () => {
    const nowSec = 1725000000;
    vi.spyOn(Date, 'now').mockReturnValue(nowSec * 1000);

    vi.mocked(mockApi.get).mockResolvedValue({
      success: true,
      data: {
        classroomId: 2,
        className: 'Class 2',
        scheduledStart: nowSec - 60,
        scheduledEnd: nowSec + 3600,
        classroomStatus: 1,
        sesskey: 'secret-sesskey',
        recording: { classid: 2, token: 'super-secret-token', skipupload: false },
        materials: [{ name: 'Book 1', links: [{ label: 'Link', url: 'https://...' }] }],
      },
    });

    const result = await adapter.ensureContext('new-room-code');
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.context.classroomId).toBe(2);
      expect(result.context.className).toBe('Class 2');
    }

    // Verify token was NOT cached in storage
    const cached = store['lmsCachedContext'] as Record<string, unknown>;
    expect(cached).toBeDefined();
    expect(cached['token']).toBeUndefined();
    expect(cached['sesskey']).toBeUndefined();
    expect(cached['recording']).toBeUndefined();
  });

  it('rejects OUTSIDE_SCHEDULE when class is more than 10 mins in the future', async () => {
    const nowSec = 1725000000;
    vi.spyOn(Date, 'now').mockReturnValue(nowSec * 1000);

    vi.mocked(mockApi.get).mockResolvedValue({
      success: true,
      data: {
        classroomId: 3,
        className: 'Future Class',
        scheduledStart: nowSec + 15 * 60, // 15 mins away (> 10m)
        scheduledEnd: nowSec + 60 * 60,
        classroomStatus: 1,
        sesskey: 'key',
        recording: null,
        materials: [],
      },
    });

    const result = await adapter.ensureContext('future-room');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('OUTSIDE_SCHEDULE');
    }
  });

  it('rejects OUTSIDE_SCHEDULE when class ended more than 30 mins ago', async () => {
    const nowSec = 1725000000;
    vi.spyOn(Date, 'now').mockReturnValue(nowSec * 1000);

    vi.mocked(mockApi.get).mockResolvedValue({
      success: true,
      data: {
        classroomId: 4,
        className: 'Past Class',
        scheduledStart: nowSec - 90 * 60,
        scheduledEnd: nowSec - 35 * 60, // ended 35 mins ago (> 30m)
        classroomStatus: 1,
        sesskey: 'key',
        recording: null,
        materials: [],
      },
    });

    const result = await adapter.ensureContext('past-room');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('OUTSIDE_SCHEDULE');
    }
  });

  it('maps 403 NO_ACTIVE_CLASS correctly', async () => {
    vi.mocked(mockApi.get).mockRejectedValue(
      new ApiAuthError('Forbidden', 403, { message: 'NO_ACTIVE_CLASS' }),
    );

    const result = await adapter.ensureContext('unknown-room');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('NO_ACTIVE_CLASS');
    }
  });

  it('maps 403 NOT_YOUR_CLASS correctly', async () => {
    vi.mocked(mockApi.get).mockRejectedValue(
      new ApiAuthError('Forbidden', 403, { message: 'NOT_YOUR_CLASS' }),
    );

    const result = await adapter.ensureContext('other-room');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('NOT_YOUR_CLASS');
    }
  });

  it('maps 401 or generic 403 to NOT_LOGGED_IN', async () => {
    vi.mocked(mockApi.get).mockRejectedValue(
      new ApiAuthError('Unauthorized', 401, { message: 'require_login' }),
    );

    const result = await adapter.ensureContext('unauth-room');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('NOT_LOGGED_IN');
    }
  });

  it('maps network errors correctly', async () => {
    vi.mocked(mockApi.get).mockRejectedValue(new ApiNetworkError('Failed to fetch'));

    const result = await adapter.ensureContext('error-room');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('NETWORK_ERROR');
    }
  });

  it('maps ApiHttpError correctly with detail', async () => {
    vi.mocked(mockApi.get).mockRejectedValue(new ApiHttpError('Internal Server Error', 500));

    const result = await adapter.ensureContext('500-room');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('NETWORK_ERROR');
      expect(result.detail).toBe('Internal Server Error');
    }
  });

  it('clears context from storage when clearContext is called', async () => {
    store['lmsCachedContext'] = { classroomId: 1 };
    await adapter.clearContext();
    expect(store['lmsCachedContext']).toBeUndefined();
  });

  it('endClass calls LMS endpoint and returns success', async () => {
    vi.mocked(mockApi.post).mockResolvedValue({
      success: true,
      data: { classroomId: 10, classroomStatus: 2 },
    });

    const result = await adapter.endClass(10);
    expect(result).toEqual({ success: true });
    expect(mockApi.post).toHaveBeenCalledWith(
      expect.stringContaining('meet/end_class.php'),
      expect.any(URLSearchParams),
    );
  });

  it('endClass returns error on failure', async () => {
    vi.mocked(mockApi.post).mockRejectedValue(new Error('Network failure'));

    const result = await adapter.endClass(10);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Network failure');
  });
});
