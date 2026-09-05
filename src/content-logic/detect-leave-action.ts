const COLORS = {
  brand: "#f97316",
  danger: "#dc2626",
  dangerHover: "#b91c1c",
  ink: "#1f2937",
  muted: "#6b7280",
  surface: "#ffffff",
  line: "#e5e7eb",
  overlay: "rgba(0, 0, 0, 0.5)",
  chipBg: "#fff7ed",
  chipText: "#c2410c",
} as const;

const HOST_ID = "onestudy-leave-confirm-dialog";

const LEAVE_ARIA_LABEL_KEYWORDS = [
  "rời cuộc gọi",
  "rời khỏi cuộc gọi",
  "leave call",
  "leave meeting",
];

/**
 * Meet's DOM for the hangup button (jsname, aria-label, container class) can
 * differ across locales and deploys — no single attribute is trusted. Each of
 * the 4 signals below stands in for the others; matching >=2 calls it the
 * button, matching only 1 is treated as coincidence.
 */
export function findLeaveButton(root: ParentNode): HTMLButtonElement | null {
  const icons = root.querySelectorAll("i.google-symbols");
  for (const icon of icons) {
    if (icon.textContent?.trim() !== "call_end") continue;
    const button = icon.closest("button");
    if (!button) continue;

    let score = 1;
    if (button.getAttribute("jsname") === "CQylAd") score++;
    if (button.closest(".NHaLPe[data-should-confirm-hangup]")) score++;
    const ariaLabel =
      button.getAttribute("aria-label")?.trim().toLowerCase() ?? "";
    if (
      LEAVE_ARIA_LABEL_KEYWORDS.some((keyword) => ariaLabel.includes(keyword))
    )
      score++;

    if (score >= 2) return button;
  }
  return null;
}

const DIALOG_STYLE = `
  :host { all: initial; }
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    background: ${COLORS.overlay};
    font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }
  .card {
    width: 100%;
    max-width: 380px;
    padding: 24px;
    border-radius: 12px;
    background: ${COLORS.surface};
    color: ${COLORS.ink};
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.3);
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-sizing: border-box;
  }
  .title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: ${COLORS.ink};
    line-height: 1.4;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    padding: 4px 10px;
    border-radius: 999px;
    background: ${COLORS.chipBg};
    color: ${COLORS.chipText};
    font-size: 12px;
    font-weight: 500;
  }
  .message {
    margin: 0;
    font-size: 14px;
    font-weight: 500;
    color: ${COLORS.ink};
    line-height: 1.5;
  }
  .disclaimer {
    margin: 0;
    font-size: 13px;
    color: ${COLORS.muted};
    line-height: 1.4;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 8px;
  }
  button {
    font: inherit;
    font-size: 14px;
    padding: 8px 16px;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.15s ease, opacity 0.15s ease;
  }
  .cancel {
    border: 1px solid ${COLORS.line};
    background: ${COLORS.surface};
    color: ${COLORS.ink};
  }
  .cancel:hover {
    background: #f9fafb;
  }
  .cancel:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .confirm {
    border: none;
    background: ${COLORS.danger};
    color: #ffffff;
    font-weight: 600;
  }
  .confirm:hover {
    background: ${COLORS.dangerHover};
  }
  .confirm:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`;

export class LeaveConfirmDialog {
  private host: HTMLDivElement | undefined;
  private confirmButton: HTMLButtonElement | undefined;
  private cancelButton: HTMLButtonElement | undefined;
  private isLoading = false;

  show(elapsedMs: number): Promise<boolean> {
    this.unmount();
    this.isLoading = false;

    return new Promise<boolean>((resolve) => {
      const host = document.createElement("div");
      host.id = HOST_ID;
      // Shadow root: CSS của Meet không chọc vào được, kể cả quy tắc !important.
      const root = host.attachShadow({ mode: "closed" });

      const style = document.createElement("style");
      style.textContent = DIALOG_STYLE;

      const overlay = document.createElement("div");
      overlay.className = "overlay";

      const card = document.createElement("div");
      card.className = "card";

      const title = document.createElement("h2");
      title.className = "title";
      title.textContent = "Kết thúc lớp học";

      const minutes = Math.floor(elapsedMs / 60_000);
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.textContent = `Thời gian đã ghi: ${minutes} phút`;

      const message = document.createElement("p");
      message.className = "message";
      message.textContent =
        "Bạn có chắc muốn kết thúc lớp học ngay lúc này không?";

      const disclaimer = document.createElement("p");
      disclaimer.className = "disclaimer";
      disclaimer.textContent =
        "Hệ thống sẽ kết thúc cuộc gọi cho tất cả học sinh và hoàn tất bản ghi hình.";

      const actions = document.createElement("div");
      actions.className = "actions";

      const cancelButton = document.createElement("button");
      cancelButton.className = "cancel";
      cancelButton.textContent = "Huỷ";

      const confirmButton = document.createElement("button");
      confirmButton.className = "confirm";
      confirmButton.textContent = "Kết thúc lớp";

      overlay.addEventListener("click", (event) => {
        if (this.isLoading) return;
        if (event.target === overlay) {
          this.unmount();
          resolve(false);
        }
      });
      cancelButton.addEventListener("click", () => {
        if (this.isLoading) return;
        this.unmount();
        resolve(false);
      });
      confirmButton.addEventListener("click", () => {
        if (this.isLoading) return;
        resolve(true);
      });

      actions.append(cancelButton, confirmButton);
      card.append(title, chip, message, disclaimer, actions);
      overlay.append(card);
      root.append(style, overlay);
      document.body.appendChild(host);

      this.host = host;
      this.confirmButton = confirmButton;
      this.cancelButton = cancelButton;
    });
  }

  setLoading(loading: boolean): void {
    this.isLoading = loading;
    if (this.confirmButton) {
      this.confirmButton.disabled = loading;
      this.confirmButton.textContent = loading
        ? "Đang kết thúc..."
        : "Kết thúc lớp";
    }
    if (this.cancelButton) {
      this.cancelButton.disabled = loading;
    }
  }

  unmount(): void {
    this.host?.remove();
    this.host = undefined;
    this.confirmButton = undefined;
    this.cancelButton = undefined;
    this.isLoading = false;
  }
}
