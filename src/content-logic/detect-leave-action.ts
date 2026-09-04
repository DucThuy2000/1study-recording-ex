const COLORS = {
  danger: "#dc2626",
  ink: "#1f2937",
  surface: "#ffffff",
  overlay: "rgba(0, 0, 0, 0.5)",
} as const;

const HOST_ID = "1study-leave-confirm-dialog";

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
    max-width: 360px;
    padding: 20px 24px;
    border-radius: 12px;
    background: ${COLORS.surface};
    color: ${COLORS.ink};
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.3);
  }
  .message { margin: 0 0 16px; white-space: pre-line; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  button {
    font: inherit;
    padding: 8px 16px;
    border-radius: 8px;
    border: none;
    cursor: pointer;
  }
  .cancel { background: #e5e7eb; color: ${COLORS.ink}; }
  .confirm { background: ${COLORS.danger}; color: #fff; }
`;

export class LeaveConfirmDialog {
  private host: HTMLDivElement | undefined;

  show(elapsedMs: number): Promise<boolean> {
    this.unmount();

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

      const minutes = Math.floor(elapsedMs / 60_000);
      const message = document.createElement("p");
      message.className = "message";
      message.textContent = `Lớp học đang ghi hình ${minutes} phút\nBạn có chắc muốn kết thúc lớp học ngay lúc này không?`;

      const actions = document.createElement("div");
      actions.className = "actions";

      const cancelButton = document.createElement("button");
      cancelButton.className = "cancel";
      cancelButton.textContent = "Huỷ";

      const confirmButton = document.createElement("button");
      confirmButton.className = "confirm";
      confirmButton.textContent = "Xác nhận";

      const finish = (result: boolean): void => {
        this.unmount();
        resolve(result);
      };

      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) finish(false);
      });
      cancelButton.addEventListener("click", () => finish(false));
      confirmButton.addEventListener("click", () => finish(true));

      actions.append(cancelButton, confirmButton);
      card.append(message, actions);
      overlay.append(card);
      root.append(style, overlay);
      document.body.appendChild(host);

      this.host = host;
    });
  }

  unmount(): void {
    this.host?.remove();
    this.host = undefined;
  }
}
