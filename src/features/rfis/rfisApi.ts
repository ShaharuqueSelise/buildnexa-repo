// RFIs: every read and write goes through the rfis Function (functions/rfis), because only the
// Function can check project membership and strip cost fields and internal notes for roles that
// may not see them. Every change answers with the RFI's full detail, which goes straight into the
// cache, so the screen updates without a second call.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FUNCTIONS, callFunction } from "../../lib/blocks/functions";

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

export type RfiDetail = { rfi: RfiRow; can: RfiCan; responses: RfiResponseRow[]; history: RfiHistoryRow[] };
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
    retry: false
  });
}

type ActionBody =
  | ({ action: "create"; clientRequestId: string; submit: boolean } & RfiInput)
  | { action: "edit"; rfiId: string; changes: Partial<RfiInput> }
  | { action: "submit"; rfiId: string }
  | { action: "reassign"; rfiId: string; toUserId: string; note?: string }
  | { action: "respond"; rfiId: string; body: string; asOfficial?: boolean }
  | { action: "markOfficial"; rfiId: string; responseId: string }
  | { action: "askAgain"; rfiId: string; reason: string }
  | { action: "close"; rfiId: string }
  | { action: "reopen"; rfiId: string; reason: string }
  | { action: "void"; rfiId: string; reason: string };

/** Runs one RFI action; the answer (the RFI's full detail) replaces the cached copy. */
export function useRfiAction(projectId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ActionBody) => call<RfiDetail & { created?: boolean }>({ ...body, projectId }),
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
