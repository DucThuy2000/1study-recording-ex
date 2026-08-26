import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChromeTabCaptureApi, ChromeOffscreenApi } from '../chrome-api';

describe('ChromeTabCaptureApi', () => {
  it('resolves the stream id returned by chrome.tabCapture.getMediaStreamId', async () => {
    const getMediaStreamId = vi.fn().mockResolvedValue('stream-123');
    vi.stubGlobal('chrome', { tabCapture: { getMediaStreamId } });

    const api = new ChromeTabCaptureApi();
    const result = await api.getMediaStreamId(42);

    expect(result).toBe('stream-123');
    expect(getMediaStreamId).toHaveBeenCalledWith({ targetTabId: 42 });
  });
});

describe('ChromeOffscreenApi', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('creates a document only when none exists', async () => {
    const hasDocument = vi.fn().mockResolvedValue(false);
    const createDocument = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', { offscreen: { hasDocument, createDocument } });

    await new ChromeOffscreenApi().ensureDocument('/offscreen.html', ['USER_MEDIA'], 'test');

    expect(createDocument).toHaveBeenCalledWith({
      url: '/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'test',
    });
  });

  it('skips creation when a document already exists', async () => {
    const hasDocument = vi.fn().mockResolvedValue(true);
    const createDocument = vi.fn();
    vi.stubGlobal('chrome', { offscreen: { hasDocument, createDocument } });

    await new ChromeOffscreenApi().ensureDocument('/offscreen.html', ['USER_MEDIA'], 'test');

    expect(createDocument).not.toHaveBeenCalled();
  });

  it('closes an existing document', async () => {
    const hasDocument = vi.fn().mockResolvedValue(true);
    const closeDocument = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', { offscreen: { hasDocument, closeDocument } });

    await new ChromeOffscreenApi().closeDocument();

    expect(closeDocument).toHaveBeenCalled();
  });
});
