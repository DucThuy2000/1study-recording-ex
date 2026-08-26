import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ChromeStorageAdapter, InMemoryStore } from './storage';

describe('InMemoryStore', () => {
  it('round-trips a value', async () => {
    const store = new InMemoryStore();
    await store.set('key', { a: 1 });
    expect(await store.get('key')).toEqual({ a: 1 });
  });

  it('returns undefined for a missing key', async () => {
    const store = new InMemoryStore();
    expect(await store.get('missing')).toBeUndefined();
  });
});

describe('ChromeStorageAdapter', () => {
  beforeEach(() => fakeBrowser.reset());

  it('round-trips a value through browser.storage.local', async () => {
    const store = new ChromeStorageAdapter();
    await store.set('key', { a: 1 });
    expect(await store.get('key')).toEqual({ a: 1 });
  });
});
