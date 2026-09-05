import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getLoginUrl,
  getGuardFailureMessage,
  renderMaterials,
  applyLmsGuard,
  createInitialPopupState,
} from "..";
import type { TeachingMaterial } from "@/src/adapters/lms/types";
import type { Message } from "@/src/shared/messages";
import { CONFIG } from "@/src/shared/config";
import fs from "node:fs";
import path from "node:path";

describe("Popup Logic & Rendering", () => {
  describe("getLoginUrl", () => {
    it("returns correct login URL based on CONFIG.LMS_API().root", () => {
      const url = getLoginUrl();
      const root = CONFIG.LMS_API().root;
      expect(url).toContain("login/index.php");
      expect(url.startsWith(root)).toBe(true);
    });
  });

  describe("getGuardFailureMessage", () => {
    it("returns correct friendly Vietnamese messages for LMS guard reasons", () => {
      expect(getGuardFailureMessage("NOT_LOGGED_IN")).toBe(
        "Chưa đăng nhập LMS hoặc phiên làm việc đã hết hạn. Vui lòng đăng nhập lại 1Study để bắt đầu.",
      );
      expect(getGuardFailureMessage("NO_ACTIVE_CLASS")).toBe(
        "Phòng Meet này không thuộc lớp học nào đang diễn ra trên 1Study.",
      );
      expect(getGuardFailureMessage("NOT_YOUR_CLASS")).toBe(
        "Bạn không phải giáo viên phụ trách lớp học này.",
      );
      expect(getGuardFailureMessage("OUTSIDE_SCHEDULE")).toBe(
        "Buổi học chưa bắt đầu hoặc đã kết thúc (cho phép từ trước 10 phút đến sau 30 phút).",
      );
      expect(getGuardFailureMessage("NETWORK_ERROR")).toBe(
        "Không thể kết nối đến hệ thống LMS. Vui lòng kiểm tra lại mạng.",
      );
      expect(getGuardFailureMessage("NOT_MEET_TAB")).toBe(
        "Mở tab Google Meet của lớp rồi bấm lại vào biểu tượng extension.",
      );
    });

    it("returns correct messages for other guard reasons", () => {
      expect(getGuardFailureMessage("ALREADY_RECORDING")).toBe(
        "Đang có một phiên ghi chạy. Bấm Dừng ghi để kết thúc phiên đó trước.",
      );
      expect(getGuardFailureMessage("START_FAILED", "Custom error")).toBe(
        "Không bắt đầu ghi được: Custom error",
      );
      expect(getGuardFailureMessage("MIC_PERMISSION_NEEDED")).toBe(
        "Cấp quyền micro ở tab vừa mở, rồi bấm Bắt đầu ghi lại.",
      );
      expect(getGuardFailureMessage("MIC_PERMISSION_DENIED")).toBe(
        "Quyền micro đang bị chặn. Mở chrome://settings/content/microphone để bỏ chặn rồi thử lại.",
      );
      expect(getGuardFailureMessage("LOW_DISK")).toBe(
        "Ổ đĩa sắp đầy — cần giải phóng dung lượng trước khi ghi.",
      );
      expect(getGuardFailureMessage("BACKLOG_HIGH")).toBe(
        "Bản ghi cũ tồn đọng quá nhiều, chưa được tải lên — mở Chrome để tự động tải lên rồi thử lại.",
      );
      expect(getGuardFailureMessage(undefined)).toBe("Không bắt đầu ghi được.");
    });
  });

  describe("renderMaterials", () => {
    let container: HTMLDivElement;

    beforeEach(() => {
      container = document.createElement("div");
    });

    it("clears container when materials array is empty", () => {
      container.innerHTML = "<div>old content</div>";
      renderMaterials(container, []);
      expect(container.innerHTML).toBe("");
    });

    it("renders materials with name and secure blank links", () => {
      const materials: TeachingMaterial[] = [
        {
          name: "Toán Lớp 5 - Tập 1",
          links: [
            { label: "Sách GK", url: "https://example.com/sgk.pdf" },
            { label: "Bài tập", url: "https://example.com/bt.pdf" },
          ],
        },
        {
          name: "Vở bài tập",
          links: [],
        },
      ];

      renderMaterials(container, materials);

      const items = container.querySelectorAll(".material-item");
      expect(items).toHaveLength(2);

      // Check item 1
      const item1 = items[0]!;
      const name1 = item1.querySelector(".material-name");
      expect(name1?.textContent).toBe("Toán Lớp 5 - Tập 1");

      const links1 = item1.querySelectorAll(".material-link");
      expect(links1).toHaveLength(2);
      expect(links1[0]!.getAttribute("href")).toBe(
        "https://example.com/sgk.pdf",
      );
      expect(links1[0]!.getAttribute("target")).toBe("_blank");
      expect(links1[0]!.getAttribute("rel")).toBe("noopener noreferrer");
      expect(links1[0]!.textContent).toBe("Sách GK");

      expect(links1[1]!.getAttribute("href")).toBe(
        "https://example.com/bt.pdf",
      );
      expect(links1[1]!.getAttribute("target")).toBe("_blank");
      expect(links1[1]!.getAttribute("rel")).toBe("noopener noreferrer");
      expect(links1[1]!.textContent).toBe("Bài tập");

      // Check item 2 (no links)
      const item2 = items[1]!;
      const name2 = item2.querySelector(".material-name");
      expect(name2?.textContent).toBe("Vở bài tập");
      expect(item2.querySelector(".material-links")).toBeNull();
    });

    it("safely escapes HTML tags in material name and link labels", () => {
      const maliciousMaterials: TeachingMaterial[] = [
        {
          name: '<img src=x onerror="alert(1)">Special & Math',
          links: [{ label: "<b>Bold</b>", url: "https://example.com" }],
        },
      ];

      renderMaterials(container, maliciousMaterials);

      const nameEl = container.querySelector(".material-name");
      expect(nameEl?.innerHTML).toBe(
        '&lt;img src=x onerror="alert(1)"&gt;Special &amp; Math',
      );
      expect(nameEl?.textContent).toBe(
        '<img src=x onerror="alert(1)">Special & Math',
      );

      const linkEl = container.querySelector(".material-link");
      expect(linkEl?.innerHTML).toBe("&lt;b&gt;Bold&lt;/b&gt;");
      expect(linkEl?.textContent).toBe("<b>Bold</b>");
    });
  });

  describe("applyLmsGuard", () => {
    let state: ReturnType<typeof createInitialPopupState>;
    let elements: {
      materialsList: HTMLDivElement;
      materials: HTMLDivElement;
      classInfo: HTMLDivElement;
      className: HTMLSpanElement;
      loginBtn: HTMLButtonElement;
    };
    let mockSendMessage: ReturnType<
      typeof vi.fn<(message: Message) => Promise<unknown>>
    >;

    beforeEach(() => {
      state = createInitialPopupState();
      elements = {
        materialsList: document.createElement("div"),
        materials: document.createElement("div"),
        classInfo: document.createElement("div"),
        className: document.createElement("span"),
        loginBtn: document.createElement("button"),
      };
      mockSendMessage = vi.fn((_message: Message) =>
        Promise.resolve<unknown>(undefined),
      );
    });

    it("handles non-Meet URL (NOT_MEET_TAB)", async () => {
      await applyLmsGuard(
        "https://mail.google.com",
        mockSendMessage,
        state,
        elements,
        true,
      );

      expect(state.guardAllowed).toBe(false);
      expect(state.guardMessage).toBe(
        "Mở tab Google Meet của lớp rồi bấm lại vào biểu tượng extension.",
      );
      expect(elements.classInfo.hidden).toBe(true);
      expect(elements.materials.hidden).toBe(true);
      expect(elements.loginBtn.hidden).toBe(true);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("handles allowed LMS context successfully", async () => {
      mockSendMessage.mockResolvedValue({
        allowed: true,
        context: {
          meetingCode: "abc-defg-hij",
          classroomId: 101,
          className: "Toán Nâng Cao 5A",
          materials: [
            {
              name: "Sách giáo khoa",
              links: [{ label: "Xem", url: "https://example.com/book.pdf" }],
            },
          ],
        },
      });

      await applyLmsGuard(
        "https://meet.google.com/abc-defg-hij",
        mockSendMessage,
        state,
        elements,
        true,
      );

      expect(state.guardAllowed).toBe(true);
      expect(state.guardMessage).toBe("Sẵn sàng ghi tab Meet này.");
      expect(state.currentClassName).toBe("Toán Nâng Cao 5A");
      expect(elements.className.textContent).toBe("Toán Nâng Cao 5A");
      expect(elements.classInfo.hidden).toBe(false);
      expect(elements.materials.hidden).toBe(false);
      expect(elements.materialsList.children).toHaveLength(1);
      expect(elements.loginBtn.hidden).toBe(true);
    });

    it("handles allowed LMS context when materials array is empty", async () => {
      mockSendMessage.mockResolvedValue({
        allowed: true,
        context: {
          meetingCode: "abc-defg-hij",
          classroomId: 101,
          className: "Tiếng Anh 6",
          materials: [],
        },
      });

      await applyLmsGuard(
        "https://meet.google.com/abc-defg-hij",
        mockSendMessage,
        state,
        elements,
        true,
      );

      expect(state.guardAllowed).toBe(true);
      expect(elements.classInfo.hidden).toBe(false);
      expect(elements.materials.hidden).toBe(true);
      expect(elements.loginBtn.hidden).toBe(true);
    });

    it("shows login button and message on NOT_LOGGED_IN", async () => {
      mockSendMessage.mockResolvedValue({
        allowed: false,
        reason: "NOT_LOGGED_IN",
      });

      await applyLmsGuard(
        "https://meet.google.com/abc-defg-hij",
        mockSendMessage,
        state,
        elements,
        true,
      );

      expect(state.guardAllowed).toBe(false);
      expect(state.showLoginBtn).toBe(true);
      expect(elements.loginBtn.hidden).toBe(false);
      expect(elements.classInfo.hidden).toBe(true);
      expect(elements.materials.hidden).toBe(true);
      expect(state.guardMessage).toBe(
        "Chưa đăng nhập LMS hoặc phiên làm việc đã hết hạn. Vui lòng đăng nhập lại 1Study để bắt đầu.",
      );
    });

    it("handles NO_ACTIVE_CLASS", async () => {
      mockSendMessage.mockResolvedValue({
        allowed: false,
        reason: "NO_ACTIVE_CLASS",
      });

      await applyLmsGuard(
        "https://meet.google.com/abc-defg-hij",
        mockSendMessage,
        state,
        elements,
        true,
      );

      expect(state.guardAllowed).toBe(false);
      expect(state.showLoginBtn).toBe(false);
      expect(elements.loginBtn.hidden).toBe(true);
      expect(state.guardMessage).toBe(
        "Phòng Meet này không thuộc lớp học nào đang diễn ra trên 1Study.",
      );
    });

    it("handles NOT_YOUR_CLASS", async () => {
      mockSendMessage.mockResolvedValue({
        allowed: false,
        reason: "NOT_YOUR_CLASS",
      });

      await applyLmsGuard(
        "https://meet.google.com/abc-defg-hij",
        mockSendMessage,
        state,
        elements,
        true,
      );

      expect(state.guardAllowed).toBe(false);
      expect(state.showLoginBtn).toBe(false);
      expect(elements.loginBtn.hidden).toBe(true);
      expect(state.guardMessage).toBe(
        "Bạn không phải giáo viên phụ trách lớp học này.",
      );
    });

    it("handles OUTSIDE_SCHEDULE", async () => {
      mockSendMessage.mockResolvedValue({
        allowed: false,
        reason: "OUTSIDE_SCHEDULE",
      });

      await applyLmsGuard(
        "https://meet.google.com/abc-defg-hij",
        mockSendMessage,
        state,
        elements,
        true,
      );

      expect(state.guardAllowed).toBe(false);
      expect(state.showLoginBtn).toBe(false);
      expect(elements.loginBtn.hidden).toBe(true);
      expect(state.guardMessage).toBe(
        "Buổi học chưa bắt đầu hoặc đã kết thúc (cho phép từ trước 10 phút đến sau 30 phút).",
      );
    });

    it("handles NETWORK_ERROR", async () => {
      mockSendMessage.mockResolvedValue({
        allowed: false,
        reason: "NETWORK_ERROR",
      });

      await applyLmsGuard(
        "https://meet.google.com/abc-defg-hij",
        mockSendMessage,
        state,
        elements,
        true,
      );

      expect(state.guardAllowed).toBe(false);
      expect(state.showLoginBtn).toBe(false);
      expect(elements.loginBtn.hidden).toBe(true);
      expect(state.guardMessage).toBe(
        "Không thể kết nối đến hệ thống LMS. Vui lòng kiểm tra lại mạng.",
      );
    });
  });

  describe("HTML and CSS template integrity", () => {
    it("has class-info, materials, and login-btn elements in index.html", () => {
      const htmlPath = path.resolve(
        __dirname,
        "../../../entrypoints/popup/index.html",
      );
      const html = fs.readFileSync(htmlPath, "utf-8");

      expect(html).toContain('id="class-info"');
      expect(html).toContain('id="class-name"');
      expect(html).toContain('id="materials"');
      expect(html).toContain('id="materials-list"');
      expect(html).toContain('id="login-btn"');
    });

    it("has styles for class-info, materials, and btn-secondary in style.css", () => {
      const cssPath = path.resolve(
        __dirname,
        "../../../entrypoints/popup/style.css",
      );
      const css = fs.readFileSync(cssPath, "utf-8");

      expect(css).toContain(".class-info");
      expect(css).toContain(".class-name");
      expect(css).toContain(".materials");
      expect(css).toContain(".materials-title");
      expect(css).toContain(".material-item");
      expect(css).toContain(".material-name");
      expect(css).toContain(".material-link");
      expect(css).toContain(".btn-secondary");
    });
  });
});
