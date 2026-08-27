import { browser } from 'wxt/browser';
import type { KeyValueStore } from './storage';
import type { Message, StorageGetResponse } from '../shared/messages';

/**
 * Offscreen documents can use only `chrome.runtime` — no other extension API,
 * including `chrome.storage`, exists there at all (confirmed against Chrome's
 * own reference: "The runtime API is the only extensions API supported by
 * offscreen documents"). `ChromeStorageAdapter` throws immediately if
 * constructed here. This proxies every read/write through background, which
 * does have full API access — exactly the pattern Chrome's own docs recommend
 * for moving data in and out of an offscreen document.
 */
export class MessagingStorageAdapter implements KeyValueStore {
  async get<T>(key: string): Promise<T | undefined> {
    const response = await browser.runtime.sendMessage<Message, StorageGetResponse | undefined>({
      type: 'STORAGE_GET',
      key,
    });
    return response?.value as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await browser.runtime.sendMessage({ type: 'STORAGE_SET', key, value } satisfies Message);
  }
}
