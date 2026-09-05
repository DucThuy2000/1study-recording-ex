import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { findLeaveButton, LeaveConfirmDialog } from '../detect-leave-action';

const HOST = '#onestudy-leave-confirm-dialog';

const REAL_MEET_HANGUP_HTML = `
  <div jslog="211198; track:JIbuQc;" jscontroller="m1IMT" class="NHaLPe" data-should-confirm-hangup="false">
    <span data-is-tooltip-wrapper="true">
      <button class="hk9qKe" jscontroller="PIVayb" jsname="CQylAd" aria-label="Rời khỏi cuộc gọi">
        <i class="quRWN-Bz112c google-symbols notranslate" aria-hidden="true">call_end</i>
      </button>
    </span>
  </div>
`;

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
  if (!host?.shadowRoot) throw new Error('dialog is not mounted');
  return host.shadowRoot;
}

describe('findLeaveButton', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('finds the button from the exact markup Meet ships today', () => {
    document.body.innerHTML = REAL_MEET_HANGUP_HTML;
    expect(findLeaveButton(document)?.getAttribute('jsname')).toBe('CQylAd');
  });

  it('still finds it when only the aria-label is in English', () => {
    document.body.innerHTML = REAL_MEET_HANGUP_HTML.replace(
      'aria-label="Rời khỏi cuộc gọi"',
      'aria-label="Leave call"',
    );
    expect(findLeaveButton(document)).not.toBeNull();
  });

  it('still finds it when jsname is missing (icon + container agree)', () => {
    document.body.innerHTML = REAL_MEET_HANGUP_HTML.replace(
      ' jsname="CQylAd"',
      '',
    );
    expect(findLeaveButton(document)).not.toBeNull();
  });

  it('ignores a call_end icon with no other matching signal', () => {
    document.body.innerHTML = `
      <button aria-label="Some other button">
        <i class="google-symbols">call_end</i>
      </button>
    `;
    expect(findLeaveButton(document)).toBeNull();
  });

  it('returns null when there is no call_end icon at all', () => {
    document.body.innerHTML = '<button jsname="CQylAd">Leave</button>';
    expect(findLeaveButton(document)).toBeNull();
  });
});

describe('LeaveConfirmDialog', () => {
  let dialog: LeaveConfirmDialog;

  beforeEach(() => {
    document.body.innerHTML = '';
    openShadowRoots();
    dialog = new LeaveConfirmDialog();
  });

  afterEach(() => {
    dialog.unmount();
    vi.restoreAllMocks();
  });

  it('renders the title, elapsed minutes chip, message, and disclaimer', () => {
    void dialog.show(45 * 60_000 + 30_000);
    const root = shadow();

    expect(root.querySelector('.title')?.textContent).toBe('Kết thúc lớp học');
    expect(root.querySelector('.chip')?.textContent).toBe(
      'Thời gian đã ghi: 45 phút',
    );
    expect(root.querySelector('.message')?.textContent).toBe(
      'Bạn có chắc muốn kết thúc lớp học ngay lúc này không?',
    );
    expect(root.querySelector('.disclaimer')?.textContent).toBe(
      'Hệ thống sẽ kết thúc cuộc gọi cho tất cả học sinh và hoàn tất bản ghi hình.',
    );
  });

  it('resolves true when Kết thúc lớp is clicked and keeps mounted for loading', async () => {
    const result = dialog.show(0);
    const confirmBtn = shadow().querySelector<HTMLButtonElement>('.confirm');
    expect(confirmBtn?.textContent).toBe('Kết thúc lớp');

    confirmBtn?.click();

    await expect(result).resolves.toBe(true);
    expect(document.querySelector(HOST)).not.toBeNull();
  });

  it('resolves false and unmounts when Huỷ is clicked', async () => {
    const result = dialog.show(0);
    const cancelBtn = shadow().querySelector<HTMLButtonElement>('.cancel');
    expect(cancelBtn?.textContent).toBe('Huỷ');

    cancelBtn?.click();

    await expect(result).resolves.toBe(false);
    expect(document.querySelector(HOST)).toBeNull();
  });

  it('resolves false and unmounts when the backdrop is clicked', async () => {
    const result = dialog.show(0);
    shadow().querySelector<HTMLDivElement>('.overlay')?.click();

    await expect(result).resolves.toBe(false);
    expect(document.querySelector(HOST)).toBeNull();
  });

  it('updates button state when setLoading is called', () => {
    void dialog.show(0);
    const confirmBtn = shadow().querySelector<HTMLButtonElement>('.confirm');
    const cancelBtn = shadow().querySelector<HTMLButtonElement>('.cancel');
    expect(confirmBtn?.disabled).toBe(false);
    expect(confirmBtn?.textContent).toBe('Kết thúc lớp');
    expect(cancelBtn?.disabled).toBe(false);

    dialog.setLoading(true);
    expect(confirmBtn?.disabled).toBe(true);
    expect(confirmBtn?.textContent).toBe('Đang kết thúc...');
    expect(cancelBtn?.disabled).toBe(true);

    dialog.setLoading(false);
    expect(confirmBtn?.disabled).toBe(false);
    expect(confirmBtn?.textContent).toBe('Kết thúc lớp');
    expect(cancelBtn?.disabled).toBe(false);
  });

  it('ignores clicks while loading', async () => {
    let settled = false;
    const result = dialog.show(0).then((val) => {
      settled = true;
      return val;
    });

    dialog.setLoading(true);
    shadow().querySelector<HTMLDivElement>('.overlay')?.click();
    shadow().querySelector<HTMLButtonElement>('.cancel')?.click();
    shadow().querySelector<HTMLButtonElement>('.confirm')?.click();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    dialog.setLoading(false);
    shadow().querySelector<HTMLButtonElement>('.cancel')?.click();
    await expect(result).resolves.toBe(false);
  });

  it('unmounts cleanly from DOM', () => {
    void dialog.show(0);
    expect(document.querySelector(HOST)).not.toBeNull();
    dialog.unmount();
    expect(document.querySelector(HOST)).toBeNull();
  });
});
