import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { MessagingStorageAdapter } from '../messaging-storage';
import type { Message } from '../../shared/messages';

describe('MessagingStorageAdapter', () => {
  beforeEach(() => fakeBrowser.reset());

  /** Mirrors background.ts's real STORAGE_GET/STORAGE_SET handler shape. */
  function registerFakeBackgroundStore(store: Map<string, unknown>): void {
    fakeBrowser.runtime.onMessage.addListener(
      (message: Message, _sender, sendResponse: (response?: unknown) => void) => {
        if (message.type === 'STORAGE_GET') {
          sendResponse({ value: store.get(message.key) });
          return true;
        }
        if (message.type === 'STORAGE_SET') {
          store.set(message.key, message.value);
          return false;
        }
        return undefined;
      },
    );
  }

  it('get() sends STORAGE_GET and returns the responder-supplied value', async () => {
    registerFakeBackgroundStore(new Map([['foo', { a: 1 }]]));
    const adapter = new MessagingStorageAdapter();
    expect(await adapter.get('foo')).toEqual({ a: 1 });
  });

  it('get() returns undefined for a key the responder does not have', async () => {
    registerFakeBackgroundStore(new Map());
    const adapter = new MessagingStorageAdapter();
    expect(await adapter.get('missing')).toBeUndefined();
  });

  it('set() sends STORAGE_SET, observable by whatever responds to it', async () => {
    const store = new Map<string, unknown>();
    registerFakeBackgroundStore(store);
    const adapter = new MessagingStorageAdapter();
    await adapter.set('foo', { a: 1 });
    expect(store.get('foo')).toEqual({ a: 1 });
  });
});
