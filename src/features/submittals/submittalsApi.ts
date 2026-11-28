// Submittals: every read and write goes through the submittals Function (functions/submittals),
// because only the Function can check the person's project role (a subcontractor sees only their
// company's submittals, drafts only the PM and the document controller) and strip internal notes.
// Every change answers with the submittal's full detail, which goes straight into the cache, so the
// screen updates without a second call.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FUNCTIONS, callFunction } from "../../lib/blocks/functions";
import { addDays, addWorkingDays } from "../../lib/workdays";
import type { Attachment, FileLinks, NewAttachment, UploadRequest, UploadSlot } from "../files/files";

export type SubmittalStatus = "draft" | "awaitingSubmission" | "inGcReview" | "inDesignReview" | "closed" | "void";
export type SubmittalDecision = "approved" | "approvedAsNoted" | "reviseResubmit" | "rejected";
export type SubmittalType = "shopDrawing" | "productData" | "sample" | "mockup" | "calculation" | "certificate" | "warranty" | "other";

export const SUBMITTAL_TYPES: SubmittalType[] = ["shopDrawing", "productData", "sample", "mockup", "calculation", "certificate", "warranty", "other"];
export const SUBMITTAL_DECISIONS: SubmittalDecision[] = ["approved", "approvedAsNoted", "reviseResubmit", "rejected"];
export const SUBMITTAL_OPEN: SubmittalStatus[] = ["draft", "awaitingSubmission", "inGcReview", "inDesignReview"];

export type SubmittalRow = {
  ItemId: string;
  projectId: string;
  number: string;
  seq?: number;
  version?: number;
  revision: number;
  title: string;
  specSection: string;
  specSectionTitle?: string;
  type: SubmittalType;
  status: SubmittalStatus;
  decision?: SubmittalDecision | "";
  responsibleCompanyId: string;
  responsibleCompanyName?: string;
  responsibleUserId?: string;
  responsibleName?: string;
  gcReviewerUserId?: string;
  gcReviewerName?: string;
  designReviewerUserId?: string;
  designReviewerName?: string;
  requiredOnSiteDate: string;
  submitByDate: string;
  dueDate?: string;
  leadTimeDays: number;
  gcReviewDays: number;
  designReviewDays: number;
  ballInCourtUserId?: string;
  ballInCourtName?: string;
  ballInCourtRole?: "gc" | "sub" | "reviewer" | "none";
  files: Attachment[];
  decisionFiles: Attachment[];
  decisionComment?: string;
  description?: string;
  /** Only for the PM, the superintendent and the document controller. */
  internalNotes?: string;
  createdByUserId: string;
  createdByName?: string;
  createdAt: string;
  sentAt?: string;
  submittedAt?: string;
  forwardedAt?: string;
  decidedAt?: string;
  decidedByName?: string;
  stepStartedAt?: string;
  isVoided?: boolean;
  voidReason?: string;
  // Worked out by the Function:
  overdue: boolean;
  /** Not submitted yet and the submit-by date has passed. */
  submitLate: boolean;
};

export type SubmittalPerson = { userId: string; displayName: string; companyName: string; role: string };
export type SubmittalCompany = { companyId: string; companyName: string; trade: string; people: { userId: string; displayName: string }[] };

export type SubmittalList = {
  role: string;
  archived: boolean;
  today: string;
  can: { create: boolean; seesAllCompanies: boolean; seeInternal: boolean };
  defaults: { gcReviewDays: number; designReviewDays: number };
  /** The pickers of the New submittal form (only for the PM and the document controller). */
  companies: SubmittalCompany[];
  reviewers: SubmittalPerson[];
  gcReviewers: SubmittalPerson[];
  submittals: SubmittalRow[];
};

export type SubmittalCan = {
  edit: boolean;
  send: boolean;
  submit: boolean;
  onBehalf: boolean;
  forward: boolean;
  returnToSub: boolean;
  decide: boolean;
  newRevision: boolean;
  void: boolean;
  comment: boolean;
  distribute: boolean;
  seeInternal: boolean;
};

export type SubmittalStep = {
  ItemId: string;
  revision: number;
  stepOrder: number;
  stepType: "submit" | "gcReview" | "designReview";
  outcome: "submitted" | "forwarded" | "returnedIncomplete" | SubmittalDecision;
  comment: string;
  attachments: Attachment[];
  actorUserId: string;
  actorName: string;
  actorRole: string;
  startedAt?: string;
  completedAt: string;
  dueDate: string;
};

export type SubmittalComment = { ItemId: string; body: string; attachments: Attachment[]; authorUserId: string; authorName: string; postedAt: string };
export type SubmittalHistory = { ItemId: string; action: string; actorName?: string; at: string; summary?: string; reason?: string; fromStatus?: string; toStatus?: string };
export type SubmittalNotified = { bell: number; email: number; failed: string[] };

export type SubmittalDetail = {
  role: string;
  today: string;
  linksExpireAt: string;
  submittal: SubmittalRow;
  can: SubmittalCan;
  steps: SubmittalStep[];
  comments: SubmittalComment[];
  history: SubmittalHistory[];
  files: FileLinks;
};

/** What the New submittal form sends. */
export type SubmittalInput = {
  title: string;
  specSection: string;
  specSectionTitle: string;
  type: SubmittalType;
  responsibleCompanyId: string;
  responsibleUserId?: string;
  designReviewerUserId: string;
  gcReviewerUserId?: string;
  requiredOnSiteDate: string;
  leadTimeDays: number;
  gcReviewDays: number;
  designReviewDays: number;
  description?: string;
  internalNotes?: string;
};

const listKey = (projectId?: string) => ["submittals", projectId ?? ""];
const detailKey = (projectId?: string, submittalId?: string) => ["submittal", projectId ?? "", submittalId ?? ""];
const call = <T,>(body: Record<string, unknown>) => callFunction<T>(FUNCTIONS.submittals, body);

export function useSubmittalList(projectId?: string) {
  return useQuery({
    queryKey: listKey(projectId),
    queryFn: () => call<SubmittalList>({ action: "list", projectId }),
    enabled: Boolean(projectId && FUNCTIONS.submittals)
  });
}

export function useSubmittal(projectId?: string, submittalId?: string) {
  return useQuery({
    queryKey: detailKey(projectId, submittalId),
    queryFn: () => call<SubmittalDetail>({ action: "get", projectId, submittalId }),
    enabled: Boolean(projectId && submittalId && FUNCTIONS.submittals),
    retry: false,
    // File links last about an hour: read the submittal again before they run out.
    refetchInterval: 40 * 60_000
  });
}

type ActionBody =
  | ({ action: "create"; clientRequestId: string; send: boolean } & SubmittalInput)
  | { action: "edit"; submittalId: string; version?: number; changes: Partial<SubmittalInput> }
  | { action: "send"; submittalId: string; version?: number }
  | { action: "submit"; submittalId: string; version?: number; attachments: (Attachment | NewAttachment | { fileId: string })[]; comment?: string }
  | { action: "forward"; submittalId: string; version?: number; comment?: string }
  | { action: "returnToSub"; submittalId: string; version?: number; comment: string }
  | { action: "decide"; submittalId: string; version?: number; decision: SubmittalDecision; comment?: string; attachments?: NewAttachment[] }
  | { action: "newRevision" | "void"; submittalId: string; version?: number; reason: string }
  | { action: "comment"; submittalId: string; body: string; attachments?: NewAttachment[] }
  | { action: "distribute"; submittalId: string; userIds: string[]; note?: string };

/** Runs one submittal action; the answer (the submittal's full detail) replaces the cached copy. */
export function useSubmittalAction(projectId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ActionBody) => call<SubmittalDetail & { created?: boolean; notified?: SubmittalNotified; sentTo?: number }>({ ...body, projectId }),
    onSuccess: (detail) => {
      queryClient.setQueryData(detailKey(projectId, detail.submittal.ItemId), detail);
      queryClient.setQueryData<SubmittalList>(listKey(projectId), (old) => {
        if (!old) return old;
        const others = old.submittals.filter((s) => s.ItemId !== detail.submittal.ItemId);
        return { ...old, submittals: [detail.submittal, ...others] };
      });
    },
    onError: (_error, body) => {
      // Someone else changed it meanwhile (STATE_CHANGED) or it is gone: show the current state.
      if ("submittalId" in body) void queryClient.invalidateQueries({ queryKey: detailKey(projectId, body.submittalId) });
      void queryClient.invalidateQueries({ queryKey: listKey(projectId) });
    }
  });
}

/** Upload links for the package, the markups or a comment's files on one submittal. */
export function submittalUploadLinks(projectId: string, submittalId: string) {
  return async (files: UploadRequest[]) => (await call<{ uploads: UploadSlot[] }>({ action: "uploadLinks", projectId, submittalId, files })).uploads;
}

/**
 * Submit by = required on site − lead time (calendar days) − GC check − design review (working
 * days). The same rule as the Function (which has the last word).
 */
export function submitByOf(requiredOnSiteDate: string, leadTimeDays: number, gcReviewDays: number, designReviewDays: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requiredOnSiteDate)) return "";
  return addWorkingDays(addDays(requiredOnSiteDate, -Math.max(0, leadTimeDays)), -Math.max(0, gcReviewDays + designReviewDays));
}

/**
 * How a submittal reads in the register: the server's status plus the decision and revision, so the
 * people on site see "Revise and resubmit" or "Approved as noted" instead of "closed".
 */
export type SubmittalView = "draft" | "notSubmitted" | "resubmit" | "withGc" | "withReviewer" | SubmittalDecision | "void";

export function viewOf(s: Pick<SubmittalRow, "status" | "decision" | "revision">): SubmittalView {
  switch (s.status) {
    case "draft":
      return "draft";
    case "awaitingSubmission":
      return Number(s.revision) > 0 ? "resubmit" : "notSubmitted";
    case "inGcReview":
      return "withGc";
    case "inDesignReview":
      return "withReviewer";
    case "closed":
      return s.decision && s.decision !== "reviseResubmit" ? s.decision : "approved";
    default:
      return "void";
  }
}

/** Open submittals whose ball is with this person: overdue first, then by due date. */
export function submittalsOnMe(rows: SubmittalRow[] | undefined, userId: string) {
  return (rows ?? [])
    .filter((s) => userId && s.ballInCourtUserId === userId && SUBMITTAL_OPEN.includes(s.status))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")));
}
