import type { GuardFailureReason, Message } from "@/src/shared/messages";
import type {
  LmsGuardResult,
  TeachingMaterial,
} from "@/src/adapters/lms/types";
import { CONFIG } from "@/src/shared/config";
import { assertNever } from "@/src/core/assert";
import { isMeetUrl, extractMeetingCode } from "@/src/shared/utils";

export interface PopupState {
  guardAllowed: boolean;
  guardMessage: string;
  roomCode: string | null;
  currentClassName: string | null;
  currentMaterials: TeachingMaterial[];
  showLoginBtn: boolean;
}

export function createInitialPopupState(): PopupState {
  return {
    guardAllowed: false,
    guardMessage: "Đang kiểm tra tab này…",
    roomCode: null,
    currentClassName: null,
    currentMaterials: [],
    showLoginBtn: false,
  };
}

export function getLoginUrl(): string {
  const root = CONFIG.LMS_API().root;
  return root.endsWith("/")
    ? `${root}login/index.php`
    : `${root}/login/index.php`;
}

export function getGuardFailureMessage(
  reason: GuardFailureReason | undefined,
  detail?: string,
): string {
  switch (reason) {
    case "NOT_LOGGED_IN":
      return "Chưa đăng nhập LMS hoặc phiên làm việc đã hết hạn. Vui lòng đăng nhập lại 1Study để bắt đầu.";
    case "NO_ACTIVE_CLASS":
      return "Phòng Meet này không thuộc lớp học nào đang diễn ra trên 1Study.";
    case "NOT_YOUR_CLASS":
      return "Bạn không phải giáo viên phụ trách lớp học này.";
    case "OUTSIDE_SCHEDULE":
      return "Buổi học chưa bắt đầu hoặc đã kết thúc (cho phép từ trước 10 phút đến sau 30 phút).";
    case "NETWORK_ERROR":
      return "Không thể kết nối đến hệ thống LMS. Vui lòng kiểm tra lại mạng.";
    case "NOT_MEET_TAB":
      return "Mở tab Google Meet của lớp rồi bấm lại vào biểu tượng extension.";
    case "ALREADY_RECORDING":
      return "Đang có một phiên ghi chạy. Bấm Dừng ghi để kết thúc phiên đó trước.";
    case "START_FAILED":
      return `Không bắt đầu ghi được: ${detail ?? "lỗi không xác định"}`;
    case "MIC_PERMISSION_NEEDED":
      return "Cấp quyền micro ở tab vừa mở, rồi bấm Bắt đầu ghi lại.";
    case "MIC_PERMISSION_DENIED":
      return "Quyền micro đang bị chặn. Mở chrome://settings/content/microphone để bỏ chặn rồi thử lại.";
    case "LOW_DISK":
      return (
        detail ?? "Ổ đĩa sắp đầy — cần giải phóng dung lượng trước khi ghi."
      );
    case "BACKLOG_HIGH":
      return (
        detail ??
        "Bản ghi cũ tồn đọng quá nhiều, chưa được tải lên — mở Chrome để tự động tải lên rồi thử lại."
      );
    case undefined:
      return "Không bắt đầu ghi được.";
    default:
      return assertNever(reason);
  }
}

export function renderMaterials(
  container: HTMLElement,
  materials: TeachingMaterial[],
): void {
  container.innerHTML = "";
  for (const mat of materials) {
    const item = document.createElement("div");
    item.className = "material-item";

    const nameSpan = document.createElement("span");
    nameSpan.className = "material-name";
    nameSpan.textContent = mat.name;
    item.appendChild(nameSpan);

    if (mat.links && mat.links.length > 0) {
      const linksDiv = document.createElement("div");
      linksDiv.className = "material-links";

      for (const link of mat.links) {
        const a = document.createElement("a");
        a.className = "material-link";
        a.href = link.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = link.label;
        linksDiv.appendChild(a);
      }

      item.appendChild(linksDiv);
    }

    container.appendChild(item);
  }
}

export interface LmsGuardElements {
  materialsList: HTMLElement;
  materials: { hidden: boolean | string };
  classInfo: { hidden: boolean | string };
  className: { textContent: string | null };
  loginBtn: { hidden: boolean | string };
}

export async function applyLmsGuard(
  tabUrl: string | undefined,
  sendMessage: (message: Message) => Promise<unknown>,
  state: PopupState,
  elements: LmsGuardElements,
  isIdle: boolean,
): Promise<void> {
  const actualCode = tabUrl ? extractMeetingCode(tabUrl) : null;
  const isMeet = !!tabUrl && isMeetUrl(tabUrl);

  if (!isMeet || !actualCode) {
    state.guardAllowed = false;
    if (isIdle) {
      state.roomCode = null;
      state.currentClassName = null;
      state.currentMaterials = [];
      state.showLoginBtn = false;
      elements.classInfo.hidden = true;
      renderMaterials(elements.materialsList, []);
      elements.materials.hidden = true;
      elements.loginBtn.hidden = true;
    }
    state.guardMessage = getGuardFailureMessage("NOT_MEET_TAB");
    return;
  }

  if (isIdle) {
    state.roomCode = actualCode;
  }

  const result = (await sendMessage({
    type: "LMS_GET_CONTEXT",
    meetingCode: actualCode,
  })) as LmsGuardResult | undefined;

  if (result && result.allowed) {
    state.guardAllowed = true;
    state.showLoginBtn = false;
    state.currentClassName = result.context.className;
    state.currentMaterials = result.context.materials ?? [];
    elements.className.textContent = result.context.className;
    elements.classInfo.hidden = false;
    renderMaterials(elements.materialsList, state.currentMaterials);
    elements.materials.hidden = state.currentMaterials.length === 0;
    elements.loginBtn.hidden = true;
    state.guardMessage = "Sẵn sàng ghi tab Meet này.";
    return;
  }

  state.guardAllowed = false;
  state.currentClassName = null;
  state.currentMaterials = [];
  elements.classInfo.hidden = true;
  renderMaterials(elements.materialsList, []);
  elements.materials.hidden = true;

  const reason = result?.reason ?? "NETWORK_ERROR";
  state.showLoginBtn = reason === "NOT_LOGGED_IN";
  elements.loginBtn.hidden = !state.showLoginBtn;
  state.guardMessage = getGuardFailureMessage(reason, result?.detail);
}
