import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger } from './logger';

describe('createLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prefixes messages with the scope', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createLogger('test-scope', 'debug').info('hello');
    expect(spy).toHaveBeenCalledWith('[test-scope] hello', '');
  });

  it('filters out messages below the minimum level', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createLogger('test-scope', 'warn').info('should not appear');
    expect(spy).not.toHaveBeenCalled();
  });

  it('routes error level to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createLogger('test-scope', 'debug').error('bad thing', { code: 1 });
    expect(spy).toHaveBeenCalledWith('[test-scope] bad thing', { code: 1 });
  });
});
