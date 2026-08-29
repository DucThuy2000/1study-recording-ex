import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { watchCallEnded } from '../call-end-watcher';

/** MutationObserver delivers asynchronously; let the microtask queue drain. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('watchCallEnded', () => {
  let stop: (() => void) | undefined;

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  it('fires when the post-call screen is added to the page', async () => {
    const onEnded = vi.fn();
    stop = watchCallEnded(onEnded);

    const screen = document.createElement('div');
    screen.setAttribute('data-call-ended', 'true');
    document.body.appendChild(screen);
    await flush();

    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('fires immediately when the page already shows the post-call screen', () => {
    // Reloading the tab after leaving the call: the marker is there before the
    // content script ever runs, so waiting for a mutation would wait forever.
    document.body.innerHTML = '<div data-call-ended="true"></div>';
    const onEnded = vi.fn();
    stop = watchCallEnded(onEnded);

    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('fires only once even as Meet keeps re-rendering that screen', async () => {
    const onEnded = vi.fn();
    stop = watchCallEnded(onEnded);

    for (let i = 0; i < 3; i += 1) {
      const screen = document.createElement('div');
      screen.setAttribute('data-call-ended', 'true');
      document.body.appendChild(screen);
      await flush();
    }

    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('ignores an element that carries the attribute set to false', async () => {
    const onEnded = vi.fn();
    stop = watchCallEnded(onEnded);

    const notEnded = document.createElement('div');
    notEnded.setAttribute('data-call-ended', 'false');
    document.body.appendChild(notEnded);
    await flush();

    expect(onEnded).not.toHaveBeenCalled();
  });

  it('stays silent through ordinary in-call DOM churn', async () => {
    const onEnded = vi.fn();
    stop = watchCallEnded(onEnded);

    for (let i = 0; i < 5; i += 1) {
      document.body.appendChild(document.createElement('div'));
      await flush();
    }

    expect(onEnded).not.toHaveBeenCalled();
  });

  it('stops reporting once the returned disposer is called', async () => {
    const onEnded = vi.fn();
    const dispose = watchCallEnded(onEnded);
    dispose();

    const screen = document.createElement('div');
    screen.setAttribute('data-call-ended', 'true');
    document.body.appendChild(screen);
    await flush();

    expect(onEnded).not.toHaveBeenCalled();
  });
});
