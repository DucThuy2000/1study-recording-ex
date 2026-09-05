export interface TeachingMaterialLink {
  label: string;
  url: string;
}

export interface TeachingMaterial {
  name: string;
  links: TeachingMaterialLink[];
}

export interface LmsMeetContextData {
  classroomId: number;
  className: string;
  scheduledStart: number; // unix timestamp in seconds
  scheduledEnd: number; // unix timestamp in seconds
  classroomStatus: number;
  sesskey: string;
  recording: {
    classid: number;
    token: string;
    skipupload: boolean;
  } | null;
  materials: TeachingMaterial[];
}

/** Cache an toàn trong storage.local: KHÔNG LƯU token hoặc sesskey */
export interface LmsCachedContext {
  meetingCode: string;
  classroomId: number;
  className: string;
  scheduledStart: number;
  scheduledEnd: number;
  classroomStatus: number;
  materials: TeachingMaterial[];
  cachedAtMs: number;
}

export type LmsGuardResult =
  | { allowed: true; context: LmsCachedContext }
  | {
      allowed: false;
      reason:
        | 'NOT_MEET_TAB'
        | 'NOT_LOGGED_IN'
        | 'NO_ACTIVE_CLASS'
        | 'NOT_YOUR_CLASS'
        | 'OUTSIDE_SCHEDULE'
        | 'NETWORK_ERROR';
      detail?: string;
    };
