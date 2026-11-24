// RFIs: every read and write goes through the rfis Function (functions/rfis), because only the
// Function can check project membership and strip cost fields and internal notes for roles that
// may not see them. Every change answers with the RFI's full detail, which goes straight into the
// cache, so the screen updates without a second call.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FUNCTIONS, callFunction } from "../../lib/blocks/functions";
import type { Attachment, FileLinks, NewAttachment, UploadRequest, UploadSlot } from "../files/files";

export type RfiStatus = "draft" | "open" | "answered" | "closed" | "void";
export type Impact = "no" | "yes" | "tbd";

export type RfiRow = {
  ItemId: string;
  projectId: string;
  number: string;
  seq?: number;
  version?: number;
  subject: string;
  question?: string;
  suggestedAnswer?: string;
  status: RfiStatus;
  priority?: "low" | "normal" | "high";
  discipline?: string;
  location?: string;
  dueDate?: string;
  managerUserId?: string;
  assigneeUserIds?: string[];
  distributionUserIds?: string[];
  ballInCourtUserId?: string;
  ballInCourtCompanyId?: string;
  ballInCourtName?: string;
  ballInCourtRole?: "creator" | "assignee" | "manager" | "none";
  createdByUserId: string;
  createdByCompanyId?: string;
  createdByName?: string;
  createdAt: string;
  openedDate?: string;
  answeredDate?: string;
  closedDate?: string;
  officialResponseId?: string;
  officialAnswerText?: string;
  responseCount?: number;
  lastResponseAt?: string;
  isVoided?: boolean;
  voidReason?: string;
  // Only for roles that may see them (the Function leaves them out otherwise).
  costImpact?: Impact;
  scheduleImpact?: Impact;
  costImpactAmount?: number;
  scheduleImpactDays?: number;
  internalNote?: string;
  attachments?: Attachment[];
};

export type RfiResponseRow = {
  ItemId: string;
  body: string;
  authorUserId: string;
  authorCompanyId?: string;
  authorName?: string;
  authorRole?: string;
  postedAt: string;
  isOfficial?: boolean;
  markedOfficialAt?: string;
  attachments?: Attachment[];
};

export type RfiHistoryRow = {
  ItemId: string;
  action: string;
  actorName?: string;
  at: string;
  summary?: string;
  reason?: string;
  fromStatus?: string;
  toStatus?: string;
};

export type RfiCan = {
  edit: boolean;
  submit: boolean;
  reassign: boolean;
  respond: boolean;
  markOfficial: boolean;
  markOfficialOwn: boolean;
  askAgain: boolean;
  close: boolean;
  reopen: boolean;
  void: boolean;
};

/** `files`: download links for the RFI's and its responses' files (they run out after an hour). */
export type RfiDetail = { rfi: RfiRow; can: RfiCan; responses: RfiResponseRow[]; history: RfiHistoryRow[]; files?: FileLinks };
/** Who was told about a change (the Function sends the bell and emails itself). */
export type RfiNotified = { bell: number; email: number; failed: string[] };
export type RfiList = { role: string; canCreate: boolean; seesCost: boolean; seesInternal: boolean; rfis: RfiRow[] };

/** The fields a person fills in on the New RFI and Edit forms. */
export type RfiInput = {
  subject: string;
  question: string;
  suggestedAnswer: string;
  priority: "low" | "normal" | "high";
  discipline: string;
  location: string;
  dueDate: string;
  assigneeUserIds: string[];
  distributionUserIds: string[];
  costImpact?: Impact;
  scheduleImpact?: Impact;
  costImpactAmount?: number | "";
  scheduleImpactDays?: number | "";
  internalNote?: string;
  /** Files already on the RFI plus new uploads (with their signed tickets). */
  attachments?: (Attachment | NewAttachment)[];
};

const listKey = (projectId?: string) => ["rfis", projectId ?? ""];
const detailKey = (projectId?: string, rfiId?: string) => ["rfi", projectId ?? "", rfiId ?? ""];

const call = <T,>(body: Record<string, unknown>) => callFunction<T>(FUNCTIONS.rfis, body);

export function useRfiList(projectId?: string) {
  return useQuery({
    queryKey: listKey(projectId),
    queryFn: () => call<RfiList>({ action: "list", projectId }),
    enabled: Boolean(projectId && FUNCTIONS.rfis)
  });
}

export function useRfi(projectId?: string, rfiId?: string) {
  return useQuery({
    queryKey: detailKey(projectId, rfiId),
    queryFn: () => call<RfiDetail>({ action: "get", projectId, rfiId }),
    enabled: Boolean(projectId && rfiId && FUNCTIONS.rfis),
    retry: false,
    // File links last an hour (storage download expiry): read the RFI again before they run out.
    refetchInterval: 40 * 60_000
  });
}

type ActionBody =
  | ({ action: "create"; clientRequestId: string; submit: boolean; pin?: RfiPin } & RfiInput)
  | { action: "edit"; rfiId: string; changes: Partial<RfiInput> }
  | { action: "submit"; rfiId: string }
  | { action: "reassign"; rfiId: string; toUserId: string; note?: string }
  | { action: "respond"; rfiId: string; body: string; asOfficial?: boolean; attachments?: NewAttachment[] }
  | { action: "markOfficial"; rfiId: string; responseId: string }
  | { action: "askAgain"; rfiId: string; reason: string }
  | { action: "close"; rfiId: string }
  | { action: "reopen"; rfiId: string; reason: string }
  | { action: "void"; rfiId: string; reason: string };

/** Runs one RFI action; the answer (the RFI's full detail) replaces the cached copy. */
/** "New RFI here" on a drawing: the pin is saved with the RFI, on the sheet's current revision. */
export type RfiPin = { sheetId: string; revisionIndex: number; x: number; y: number };

export function useRfiAction(projectId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ActionBody) => call<RfiDetail & { created?: boolean; notified?: RfiNotified }>({ ...body, projectId }),
    onSuccess: (detail) => {
      queryClient.setQueryData(detailKey(projectId, detail.rfi.ItemId), detail);
      queryClient.setQueryData<RfiList>(listKey(projectId), (old) => {
        if (!old) return old;
        const others = old.rfis.filter((r) => r.ItemId !== detail.rfi.ItemId);
        return { ...old, rfis: [detail.rfi, ...others] };
      });
    },
    onError: (_error, body) => {
      // Someone else changed it meanwhile (STATE_CHANGED) or it is gone: show the current state.
      if ("rfiId" in body) void queryClient.invalidateQueries({ queryKey: detailKey(projectId, body.rfiId) });
      void queryClient.invalidateQueries({ queryKey: listKey(projectId) });
    }
  });
}

/** Upload links for files on a new RFI (no rfiId) or on an RFI the person may edit or answer. */
export function rfiUploadLinks(projectId: string, rfiId?: string) {
  return async (files: UploadRequest[]) => (await call<{ uploads: UploadSlot[] }>({ action: "uploadLinks", projectId, rfiId, files })).uploads;
}

const LIVE_STATUSES: RfiStatus[] = ["draft", "open", "answered"];

/**
 * "My items" for RFIs: the ones where the ball is on me (a draft is on its creator), overdue first,
 * then by due date. `today` is YYYY-MM-DD.
 */
export function rfisOnMe(rfis: RfiRow[] | undefined, userId: string, today: string) {
  const mine = (rfis ?? []).filter((r) => userId && r.ballInCourtUserId === userId && LIVE_STATUSES.includes(r.status));
  const overdue = (r: RfiRow) => r.status === "open" && Boolean(r.dueDate) && String(r.dueDate) < today;
  return mine.sort((a, b) => Number(overdue(b)) - Number(overdue(a)) || String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")));
}
