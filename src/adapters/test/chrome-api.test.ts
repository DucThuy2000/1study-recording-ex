import { describe, it, expect, vi, afterEach } from 'vitest';
import { browser } from 'wxt/browser';
import { ChromeTabCaptureApi, ChromeOffscreenApi } from '../chrome-api';

// These adapters call through WXT's `browser` namespace, which the WxtVitest
// plugin backs with @webext-core/fake-browser. fake-browser has no in-memory
// implementation of tabCapture or offscreen — it throws "not implemented" and
// tells you to mock them yourself — so each test spies on the exact method it
// exercises. Stubbing the `chrome` global instead would not be seen at all.
//
// The spies go through mockImplementation rather than mockResolvedValue
// because these APIs are declared with both a callback and a promise
// overload; spyOn resolves to the callback one, whose return type is void, so
// mockResolvedValue would have nothing to attach a value to. A function
// returning a promise is still assignable to a void-returning signature, which
// keeps the mocks fully typed and free of casts.
afterEach(() => vi.restoreAllMocks());

describe('ChromeTabCaptureApi', () => {
  it('resolves the stream id returned by tabCapture.getMediaStreamId', async () => {
    // No parameter list: a function taking fewer arguments is assignable to the
    // overload's signature, which keeps this free of the GetMediaStreamOptions
    // import. The arguments are asserted below instead.
    const getMediaStreamId = vi.fn(async () => 'stream-123');
    vi.spyOn(browser.tabCapture, 'getMediaStreamId').mockImplementation(getMediaStreamId);

    const result = await new ChromeTabCaptureApi().getMediaStreamId(42);

    expect(result).toBe('stream-123');
    expect(getMediaStreamId).toHaveBeenCalledWith({ targetTabId: 42 });
  });
});

describe('ChromeOffscreenApi', () => {
  function stubHasDocument(exists: boolean): void {
    vi.spyOn(browser.offscreen, 'hasDocument').mockImplementation(async () => exists);
  }

  it('creates a document only when none exists', async () => {
    stubHasDocument(false);
    const createDocument = vi.fn(async () => undefined);
    vi.spyOn(browser.offscreen, 'createDocument').mockImplementation(createDocument);

    await new ChromeOffscreenApi().ensureDocument('/offscreen.html', ['USER_MEDIA'], 'test');

    expect(createDocument).toHaveBeenCalledWith({
      url: '/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'test',
    });
  });

  it('skips creation when a document already exists', async () => {
    stubHasDocument(true);
    const createDocument = vi.fn(async () => undefined);
    vi.spyOn(browser.offscreen, 'createDocument').mockImplementation(createDocument);

    await new ChromeOffscreenApi().ensureDocument('/offscreen.html', ['USER_MEDIA'], 'test');

    expect(createDocument).not.toHaveBeenCalled();
  });

  it('closes an existing document', async () => {
    stubHasDocument(true);
    const closeDocument = vi.fn(async () => undefined);
    vi.spyOn(browser.offscreen, 'closeDocument').mockImplementation(closeDocument);

    await new ChromeOffscreenApi().closeDocument();

    expect(closeDocument).toHaveBeenCalled();
  });

  it('does not try to close a document that is not there', async () => {
    stubHasDocument(false);
    const closeDocument = vi.fn(async () => undefined);
    vi.spyOn(browser.offscreen, 'closeDocument').mockImplementation(closeDocument);

    await new ChromeOffscreenApi().closeDocument();

    expect(closeDocument).not.toHaveBeenCalled();
  });
});
