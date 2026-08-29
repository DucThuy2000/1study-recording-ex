import { formatClock } from "../core/badge-format";
import { CONFIG } from "../shared/config";

const COLORS = {
  brand: "#f97316",
  danger: "#dc2626",
  ok: "#16a34a",
  ink: "#1f2937",
  surface: "#ffffff",
} as const;

const HOST_ID = "onestudy-recorder-pill";

const STYLE = `
  :host { all: initial; }
  .pill {
    position: fixed;
    left: 16px;
    bottom: 16px;
    z-index: 2147483647;
    /* R12: không bao giờ chắn thao tác của giáo viên trong lớp. */
    pointer-events: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 320px;
    padding: 9px 14px;
    border-radius: 999px;
    border: 1px solid ${COLORS.brand};
    background: ${COLORS.surface};
    color: ${COLORS.ink};
    font: 13px/1.35 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.16);
  }
  .pill[data-warn='true'] { border-color: ${COLORS.danger}; border-radius: 14px; }
  .pill[data-stopped='true'] { border-color: ${COLORS.ok}; }

  .row { display: flex; align-items: center; gap: 8px; white-space: nowrap; }

  .dot {
    width: 8px; height: 8px; flex: none;
    border-radius: 50%;
    background: ${COLORS.brand};
  }
  .pill[data-warn='true'] .dot { background: ${COLORS.danger}; }
  .pill[data-stopped='true'] .dot { background: ${COLORS.ok}; }

  .label { font-weight: 600; letter-spacing: 0.4px; }
  .clock { font-variant-numeric: tabular-nums; }

  .warn { color: ${COLORS.danger}; white-space: normal; }
  .warn:empty { display: none; }
`;

export class StatusPill {
  private host: HTMLDivElement | undefined;
  private pill: HTMLDivElement | undefined;
  private clockNode: Text | undefined;
  private warnEl: HTMLDivElement | undefined;
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private dismissTimeoutId: ReturnType<typeof setTimeout> | undefined;
  private labelEl: HTMLSpanElement | undefined;

  mount(startedAtMs: number): void {
    this.cancelDismiss();
    if (this.host) {
      this.resetToRecording();
      this.startClock(startedAtMs);
      return;
    }

    const host = document.createElement("div");
    host.id = HOST_ID;
    // Shadow root: CSS của Meet không chọc vào được, kể cả quy tắc !important.
    const root = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = STYLE;

    const pill = document.createElement("div");
    pill.className = "pill";
    pill.dataset.warn = "false";

    const row = document.createElement("div");
    row.className = "row";

    const dot = document.createElement("span");
    dot.className = "dot";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = "ĐANG GHI";

    const clock = document.createElement("span");
    clock.className = "clock";
    const clockNode = document.createTextNode("00:00");
    clock.appendChild(clockNode);

    const warn = document.createElement("div");
    warn.className = "warn";

    row.append(dot, label, clock);
    pill.append(row, warn);
    root.append(style, pill);
    document.body.appendChild(host);

    this.host = host;
    this.pill = pill;
    this.clockNode = clockNode;
    this.warnEl = warn;
    this.labelEl = label;

    this.startClock(startedAtMs);
  }

  setWarning(text: string | null): void {
    if (!this.warnEl || !this.pill) return;
    this.warnEl.textContent = text ?? "";
    this.pill.dataset.warn = String(text !== null);
  }

  /**
   * Xác nhận đã dừng rồi tự biến mất. Đóng tab thì pill chết theo tab và không
   * ai thấy lời này — badge và popup lo phần đó.
   */
  showStopped(): void {
    if (!this.pill || !this.labelEl) return;
    this.stopClock();
    this.setWarning(null);
    this.pill.dataset.stopped = 'true';
    this.labelEl.textContent = 'ĐÃ DỪNG GHI · ĐÃ LƯU';
    this.cancelDismiss();
    this.dismissTimeoutId = setTimeout(
      () => this.unmount(),
      CONFIG.STOPPED_NOTICE_MS,
    );
  }

  unmount(): void {
    this.cancelDismiss();
    this.stopClock();
    this.host?.remove();
    this.host = undefined;
    this.pill = undefined;
    this.clockNode = undefined;
    this.warnEl = undefined;
    this.labelEl = undefined;
  }

  /** Đưa pill về hình dạng "đang ghi" — cần khi một phiên mới bắt đầu trong lúc lời xác nhận cũ còn hiện. */
  private resetToRecording(): void {
    if (!this.pill || !this.labelEl) return;
    this.pill.dataset.stopped = 'false';
    this.labelEl.textContent = 'ĐANG GHI';
    this.setWarning(null);
  }

  private cancelDismiss(): void {
    if (this.dismissTimeoutId !== undefined) clearTimeout(this.dismissTimeoutId);
    this.dismissTimeoutId = undefined;
  }

  private startClock(startedAtMs: number): void {
    this.stopClock();
    const tick = (): void => {
      // Chỉ ghi vào text node, không dựng lại cây DOM — và không có quyết định
      // nào nằm ở đây, vì tab nền có thể bị bóp còn 1 lần/phút (R13).
      if (this.clockNode)
        this.clockNode.data = formatClock(Date.now() - startedAtMs);
    };
    tick();
    this.intervalId = setInterval(tick, 1000);
  }

  private stopClock(): void {
    if (this.intervalId !== undefined) clearInterval(this.intervalId);
    this.intervalId = undefined;
  }
}
