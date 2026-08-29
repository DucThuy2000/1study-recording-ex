import { describe, it, expect } from 'vitest';
import { withAlert, isDegraded, type AlertKey } from '../alert-set';

describe('withAlert', () => {
  it('adds an alert that was not present', () => {
    expect(withAlert([], 'mic', true)).toEqual(['mic']);
  });

  it('does not duplicate an alert that is already raised', () => {
    expect(withAlert(['mic'], 'mic', true)).toEqual(['mic']);
  });

  it('removes an alert when it clears', () => {
    expect(withAlert(['mic', 'video'], 'mic', false)).toEqual(['video']);
  });

  it('clearing an alert that was never raised is a no-op', () => {
    expect(withAlert(['video'], 'mic', false)).toEqual(['video']);
  });

  it('tracks the four sources independently', () => {
    let alerts: AlertKey[] = [];
    alerts = withAlert(alerts, 'mic', true);
    alerts = withAlert(alerts, 'storage', true);
    alerts = withAlert(alerts, 'mic', false);
    expect(alerts).toEqual(['storage']);
  });

  it('does not mutate the array it was given', () => {
    const original: AlertKey[] = ['mic'];
    withAlert(original, 'video', true);
    expect(original).toEqual(['mic']);
  });
});

describe('isDegraded', () => {
  it('is false with no alerts and true with any', () => {
    expect(isDegraded([])).toBe(false);
    expect(isDegraded(['tab'])).toBe(true);
    expect(isDegraded(['mic', 'video'])).toBe(true);
  });
});
