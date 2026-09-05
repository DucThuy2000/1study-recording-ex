import type { ChromeStorageAdapter } from "../storage";
import {
  ApiService,
  ApiAuthError,
  ApiNetworkError,
  ApiHttpError,
} from "@/src/core/api-service";
import type { Logger } from "@/src/core/logger";
import { CONFIG } from "@/src/shared/config";
import type {
  LmsMeetContextData,
  LmsCachedContext,
  LmsGuardResult,
} from "./types";

const LMS_CONTEXT_KEY = "lmsCachedContext";

interface LmsApiResponse<T> {
  success: boolean;
  message?: string;
  data: T;
}

export class LmsAdapter {
  constructor(
    private readonly store: ChromeStorageAdapter,
    private readonly api: ApiService,
    private readonly logger: Logger,
  ) {}

  async getCachedContext(): Promise<LmsCachedContext | null> {
    return (await this.store.get<LmsCachedContext>(LMS_CONTEXT_KEY)) ?? null;
  }

  async clearContext(): Promise<void> {
    await this.store.delete(LMS_CONTEXT_KEY);
    this.logger.info("cleared LMS cached context from storage");
  }

  async ensureContext(meetingCode: string): Promise<LmsGuardResult> {
    const nowSec = Math.floor(Date.now() / 1000);
    const cached = await this.getCachedContext();

    if (cached && cached.meetingCode === meetingCode) {
      const startWindow = cached.scheduledStart - 10 * 60;
      const endWindow = cached.scheduledEnd + 30 * 60;
      if (nowSec >= startWindow && nowSec <= endWindow) {
        this.logger.debug("using valid cached LMS context", {
          meetingCode,
          classroomId: cached.classroomId,
        });
        return { allowed: true, context: cached };
      }
    }

    try {
      this.logger.info("fetching meet context from LMS", { meetingCode });
      const contextData = await this.getMeetContext(meetingCode);

      const startWindow = contextData.scheduledStart - 10 * 60;
      const endWindow = contextData.scheduledEnd + 30 * 60;
      if (nowSec < startWindow || nowSec > endWindow) {
        this.logger.warn("meet class is outside schedule window", {
          meetingCode,
          scheduledStart: contextData.scheduledStart,
          scheduledEnd: contextData.scheduledEnd,
          nowSec,
        });
        return {
          allowed: false,
          reason: "OUTSIDE_SCHEDULE",
          detail: "Buổi học chưa bắt đầu hoặc đã kết thúc.",
        };
      }

      const safeContext: LmsCachedContext = {
        meetingCode,
        classroomId: contextData.classroomId,
        className: contextData.className,
        scheduledStart: contextData.scheduledStart,
        scheduledEnd: contextData.scheduledEnd,
        classroomStatus: contextData.classroomStatus,
        materials: contextData.materials ?? [],
        cachedAtMs: Date.now(),
      };

      await this.store.set(LMS_CONTEXT_KEY, safeContext);
      this.logger.info("saved safe LMS context to storage", {
        meetingCode,
        classroomId: safeContext.classroomId,
      });

      return { allowed: true, context: safeContext };
    } catch (error) {
      return this.handleLmsError(error);
    }
  }

  async getMeetContext(meetingCode: string): Promise<LmsMeetContextData> {
    const endpoint = CONFIG.LMS_API().meet_context;
    const response = await this.api.get<LmsApiResponse<LmsMeetContextData>>(
      endpoint,
      { meetingCode },
    );
    if (!response.success || !response.data) {
      throw new Error(response.message || "Failed to retrieve meet context");
    }
    return response.data;
  }

  async endClass(
    classroomId: number,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.logger.info("calling LMS end_class endpoint", { classroomId });
      const endpoint = CONFIG.LMS_API().end_class;
      const response = await this.api.post<
        LmsApiResponse<{ classroomId: number; classroomStatus: number }>
      >(endpoint, new URLSearchParams({ classroomid: String(classroomId) }));

      if (!response.success) {
        throw new Error(response.message || "Class end failed");
      }
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("LMS endClass error", { classroomId, error: message });
      return { success: false, error: message };
    }
  }

  private handleLmsError(error: unknown): LmsGuardResult {
    this.logger.error("LMS error encountered", { error: String(error) });

    if (error instanceof ApiAuthError) {
      const body = error.responseBody as { message?: string } | undefined;
      const msg = body?.message;
      if (msg === "NO_ACTIVE_CLASS") {
        return { allowed: false, reason: "NO_ACTIVE_CLASS" };
      }
      if (msg === "NOT_YOUR_CLASS") {
        return { allowed: false, reason: "NOT_YOUR_CLASS" };
      }
      return { allowed: false, reason: "NOT_LOGGED_IN" };
    }

    if (error instanceof ApiNetworkError) {
      return { allowed: false, reason: "NETWORK_ERROR" };
    }

    if (error instanceof ApiHttpError) {
      return {
        allowed: false,
        reason: "NETWORK_ERROR",
        detail: error.message,
      };
    }

    return {
      allowed: false,
      reason: "NETWORK_ERROR",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
