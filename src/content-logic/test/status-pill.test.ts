import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StatusPill } from '../status-pill';
import { CONFIG } from '../../shared/config';

const HOST = '#onestudy-recorder-pill';

/**
 * The pill lives in a closed shadow root, so tests reach its internals the way
 * the DOM does not: attachShadow is spied to hand back an open root instead.
 * Closed is the right choice in production — Meet's own scripts cannot touch
 * it — and this is the only place that needs to see inside.
 */
function openShadowRoots(): void {
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (
    this: Element,
  ) {
    return attach.call(this, { mode: 'open' });
  });
}

function shadow(): ShadowRoot {
  const host = document.querySelector(HOST);
  if (!host?.shadowRoot) throw new Error('pill is not mounted');
  return host.shadowRoot;
}

describe('StatusPill', () => {
  let pill: StatusPill;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    openShadowRoots();
    pill = new StatusPill();
  });

  afterEach(() => {
    pill.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders the elapsed time from the session start, not from mount', () => {
    vi.setSystemTime(new Date('2026-08-29T10:45:12Z'));
    const startedAtMs = Date.now() - (45 * 60_000 + 12_000);

    pill.mount(startedAtMs);

    expect(shadow().querySelector('.clock')?.textContent).toBe('45:12');
  });

  it('advances the clock every second', () => {
    pill.mount(Date.now());
    vi.advanceTimersByTime(3000);

    expect(shadow().querySelector('.clock')?.textContent).toBe('00:03');
  });

  it('shows a warning line and flags the pill, then clears both', () => {
    pill.mount(Date.now());

    pill.setWarning('⚠ Không nghe thấy giọng bạn');
    expect(shadow().querySelector('.warn')?.textContent).toBe('⚠ Không nghe thấy giọng bạn');
    expect(shadow().querySelector<HTMLElement>('.pill')?.dataset.warn).toBe('true');

    pill.setWarning(null);
    expect(shadow().querySelector('.warn')?.textContent).toBe('');
    expect(shadow().querySelector<HTMLElement>('.pill')?.dataset.warn).toBe('false');
  });

  it('confirms the stop, freezes the clock, then removes itself', () => {
    pill.mount(Date.now());
    vi.advanceTimersByTime(5000);

    pill.showStopped();
    expect(shadow().querySelector<HTMLElement>('.pill')?.dataset.stopped).toBe('true');
    expect(shadow().querySelector('.label')?.textContent).toBe('ĐÃ DỪNG GHI · ĐÃ LƯU');

    // Frozen: the clock must not keep counting past the end of the recording.
    vi.advanceTimersByTime(3000);
    expect(shadow().querySelector('.clock')?.textContent).toBe('00:05');

    vi.advanceTimersByTime(CONFIG.STOPPED_NOTICE_MS);
    expect(document.querySelector(HOST)).toBeNull();
  });

  it('drops the stop confirmation when a new session starts before it fades', () => {
    pill.mount(Date.now());
    pill.showStopped();

    pill.mount(Date.now());
    expect(shadow().querySelector<HTMLElement>('.pill')?.dataset.stopped).toBe('false');
    expect(shadow().querySelector('.label')?.textContent).toBe('ĐANG GHI');

    // The pending dismissal must not fire and tear down the new session's pill.
    vi.advanceTimersByTime(CONFIG.STOPPED_NOTICE_MS * 2);
    expect(document.querySelector(HOST)).not.toBeNull();
  });

  it('is inert to clicks so it can never intercept a Meet control', () => {
    pill.mount(Date.now());
    const style = shadow().querySelector('style')?.textContent ?? '';
    expect(style).toContain('pointer-events: none');
  });

  it('unmount leaves nothing behind and stops the clock', () => {
    pill.mount(Date.now());
    pill.unmount();

    expect(document.querySelector(HOST)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
