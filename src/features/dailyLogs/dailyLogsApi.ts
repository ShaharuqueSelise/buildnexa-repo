// Daily logs: every read and write goes through the daily-logs Function (functions/daily-logs),
// because only the Function can check the person's project role (a subcontractor sees the day's
// header and their own company's crew, the owner submitted logs only). Every change answers with the
// day's full detail, which goes straight into the cache, so the screen updates without a second call.
// A day is addressed by its date ("yyyy-MM-dd" in the project's timezone).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { FUNCTIONS, FunctionRefused, callFunction } from "../../lib/blocks/functions";
import { enqueuePhotos, usePhotoQueue } from "../photos/photosApi";
import type { QueueItem } from "../photos/photosApi";

export type LogStatus = "draft" | "submitted";
export type DayStatus = LogStatus | "pending";

export const SITE_CONDITIONS = ["normal", "wet", "frozen", "flooded", "noAccess"] as const;
export const EQUIPMENT_STATUS = ["working", "idle", "broken"] as const;
export const DELAY_TYPES = ["weather", "material", "labour", "design", "owner", "inspection", "access", "other"] as const;
export const SAFETY_TYPES = ["observation", "nearMiss", "incident", "toolboxTalk", "inspection"] as const;
export const CONDITIONS = ["clear", "partlyCloudy", "cloudy", "fog", "drizzle", "rain", "snow", "thunderstorm"] as const;

export type Weather = {
  source: string;
  place?: string;
  condition?: string;
  summary?: string;
  fetchedAt?: string;
  tempMinC?: number;
  tempMaxC?: number;
  precipitationMm?: number;
  windMaxKph?: number;
};

export type EquipmentRow = { rowId?: string; name: string; quantity?: number; hoursUsed?: number; status: string; notes?: string };
export type DeliveryRow = { rowId?: string; time?: string; supplier: string; material: string; quantity?: string; deliveryNoteNo?: string };
export type VisitorRow = { rowId?: string; name: string; organisation?: string; purpose?: string; timeIn?: string; timeOut?: string };
export type DelayRow = { rowId?: string; type: string; description: string; durationHours?: number };
export type SafetyRow = { rowId?: string; type: string; description: string; actionTaken?: string };
export type ManpowerRow = { rowId?: string; trade?: string; headcount: number; hours?: number; workDone?: string; location?: string };

export type RowSectionKey = "equipment" | "deliveries" | "visitors" | "delays" | "safety";
export type SectionKey = RowSectionKey | "notes" | "siteConditions" | "weatherOverride";

export type DayRow = { date: string; status: DayStatus; isWorkingDay: boolean; condition?: string; headcount?: number | null; corrections?: number };

export type LogMonth = {
  month: string;
  today: string;
  role: string;
  place: string;
  days: DayRow[];
  can: { open: boolean; seesCrewTotals: boolean };
};

/** The day's log. A subcontractor gets the header only (no sections, no summary). */
export type LogView = {
  id: string;
  date: string;
  status: LogStatus;
  version: number;
  isWorkingDay: boolean;
  weather: Weather | null;
  siteConditions: string;
  submittedAt: string;
  submittedByName: string;
  correctionCount: number;
  weatherForecast?: Weather | null;
  weatherOverride?: Weather | null;
  equipment?: EquipmentRow[];
  deliveries?: DeliveryRow[];
  visitors?: VisitorRow[];
  delays?: DelayRow[];
  safety?: SafetyRow[];
  notes?: string;
  manpowerSummary?: (ManpowerRow & { companyId: string; companyName: string })[];
  totalHeadcount?: number;
  totalHours?: number;
};

export type Crew = {
  id: string;
  companyId: string;
  companyName: string;
  status: "open" | "locked";
  version: number;
  manpower: ManpowerRow[];
  notes: string;
  headcount: number;
  hours: number;
  lastEditedByName: string;
  lastEditedAt: string;
};

export type CrewCompany = { companyId: string; companyName: string; own: boolean };

export type LogHistory = { id: string; action: string; actorName?: string; at: string; summary?: string; reason?: string; before?: unknown; after?: unknown };

export type LogCan = { open: boolean; editSections: boolean; editAnyCrew: boolean; editOwnCrew: boolean; submit: boolean; correct: boolean; addPhotos: boolean; remind?: boolean };
/** Who was told about a submit, correction or reminder (bell and email counts; failures in `failed`). */
export type Notified = { bell: number; email: number; failed: string[] };

/** A photo on the log (a subcontractor gets their own company's only). Image links are short-lived. */
export type LogPhoto = { ItemId: string; caption: string; takenAt: string; uploadedByName: string; companyName: string; thumbUrl?: string; previewUrl?: string };

export type LogDetail = {
  date: string;
  today: string;
  role: string;
  archived: boolean;
  place: string;
  log: LogView | null;
  /** The owner asked for a day whose log is still a draft. */
  pending: boolean;
  crews: Crew[];
  ownCompanyId?: string;
  ownCompanyName?: string;
  /** Companies that keep a crew in the log (the PM and the superintendent only). */
  companies: CrewCompany[];
  /** Subcontractor companies on the team that haven't added a crew yet. */
  missingCrews: CrewCompany[];
  /** When each subcontractor was last reminded to add their crew (companyId -> time; GC only). */
  remindedAt?: Record<string, string>;
  history: LogHistory[];
  photos: LogPhoto[];
  can: LogCan;
  /** Only in the answer to submit and correct. */
  notified?: Notified;
  /** Only in the answer to remind. */
  reminded?: Notified & { companyName: string; people: number };
};

export const monthKey = (projectId?: string, month?: string) => ["dailyLogMonth", projectId ?? "", month ?? ""];
export const dayKey = (projectId?: string, date?: string) => ["dailyLog", projectId ?? "", date ?? ""];
const call = <T,>(body: Record<string, unknown>) => callFunction<T>(FUNCTIONS.dailyLogs, body);

export function useLogMonth(projectId?: string, month?: string) {
  return useQuery({
    queryKey: monthKey(projectId, month),
    queryFn: () => call<LogMonth>({ action: "month", projectId, month }),
    enabled: Boolean(projectId && month && FUNCTIONS.dailyLogs),
    placeholderData: (previous) => previous
  });
}

export function useLogDay(projectId?: string, date?: string) {
  return useQuery({
    queryKey: dayKey(projectId, date),
    queryFn: () => call<LogDetail>({ action: "get", projectId, date }),
    enabled: Boolean(projectId && date && FUNCTIONS.dailyLogs),
    retry: false
  });
}

/** The day's detail into its cache; the month is read again (status, headcount, weather). */
function putDetail(queryClient: QueryClient, projectId: string, detail: LogDetail) {
  queryClient.setQueryData(dayKey(projectId, detail.date), detail);
  void queryClient.invalidateQueries({ queryKey: monthKey(projectId, detail.date.slice(0, 7)) });
}

export type LogAction =
  | { action: "open" }
  | { action: "saveSection"; section: SectionKey; value: unknown; base?: unknown }
  | { action: "saveCrew"; companyId?: string; manpower: ManpowerRow[]; notes: string; version?: number }
  | { action: "submit" }
  | { action: "refreshWeather" }
  | { action: "correct"; reason: string; section?: SectionKey; value?: unknown; crewCompanyId?: string; manpower?: ManpowerRow[]; notes?: string }
  | { action: "remind"; companyId: string };

/** Runs one action on the day; the answer (the day's full detail) replaces the cached copy. */
export function useLogAction(projectId?: string, date?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LogAction) => call<LogDetail>({ ...body, projectId, date }),
    onSuccess: (detail) => projectId && putDetail(queryClient, projectId, detail),
    onError: () => {
      // Someone else changed it meanwhile (CONFLICT, STATE_CHANGED): show the current state.
      void queryClient.invalidateQueries({ queryKey: dayKey(projectId, date) });
    }
  });
}

/** Photos for the day's log go through the app's photo queue (functions/photos `add`, linked to the log). */
export function addLogPhotos(projectId: string, logId: string, files: File[]) {
  enqueuePhotos(projectId, files, { tags: ["daily-log"], link: { type: "dailyLog", id: logId } });
}

/**
 * This log's photos in the queue: still going up, or failed. When one is saved the day is read
 * again, so its thumbnail shows in the card.
 */
export function useLogPhotoQueue(projectId: string | undefined, logId: string | undefined, date: string) {
  const queryClient = useQueryClient();
  const { items } = usePhotoQueue();
  const seen = useRef(new Set<string>());
  const mine: QueueItem[] = items.filter((x) => x.projectId === projectId && x.options.link?.type === "dailyLog" && x.options.link.id === logId);
  useEffect(() => {
    const done = mine.filter((x) => x.state === "done" && !seen.current.has(x.id));
    if (!done.length || !projectId) return;
    for (const x of done) seen.current.add(x.id);
    void queryClient.invalidateQueries({ queryKey: dayKey(projectId, date) });
  }, [mine, projectId, date, queryClient]);
  return { busy: mine.filter((x) => x.state !== "done" && x.state !== "failed"), failed: mine.filter((x) => x.state === "failed") };
}

export const refusalText = (error: unknown, fallback: string) => (error instanceof FunctionRefused ? error.message : fallback);

export const totalsOf = (rows: ManpowerRow[]) => ({
  headcount: rows.reduce((s, r) => s + (Number(r.headcount) || 0), 0),
  hours: Math.round(rows.reduce((s, r) => s + (Number(r.hours) || 0), 0) * 100) / 100
});
