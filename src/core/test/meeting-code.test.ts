import { describe, it, expect } from 'vitest';
import { extractMeetingCode, isMeetUrl } from '../meeting-code';

describe('extractMeetingCode', () => {
  it('extracts the code from a plain Meet URL', () => {
    expect(extractMeetingCode('https://meet.google.com/abc-defg-hij')).toBe('abc-defg-hij');
  });

  it('extracts the code when the URL has a query string or hash', () => {
    expect(extractMeetingCode('https://meet.google.com/abc-defg-hij?authuser=0')).toBe('abc-defg-hij');
    expect(extractMeetingCode('https://meet.google.com/abc-defg-hij#foo')).toBe('abc-defg-hij');
  });

  it('normalizes the code to lowercase', () => {
    expect(extractMeetingCode('https://meet.google.com/ABC-DEFG-HIJ')).toBe('abc-defg-hij');
  });

  it('returns null for a non-Meet URL', () => {
    expect(extractMeetingCode('https://youtube.com/watch?v=abc')).toBeNull();
  });

  it('returns null for the Meet landing page with no room code', () => {
    expect(extractMeetingCode('https://meet.google.com/')).toBeNull();
    expect(extractMeetingCode('https://meet.google.com/landing')).toBeNull();
  });
});

describe('isMeetUrl', () => {
  it('is true for any meet.google.com URL', () => {
    expect(isMeetUrl('https://meet.google.com/abc-defg-hij')).toBe(true);
  });

  it('is false for other domains', () => {
    expect(isMeetUrl('https://youtube.com/')).toBe(false);
  });
});
