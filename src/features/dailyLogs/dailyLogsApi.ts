// Daily logs: every read and write goes through the daily-logs Function (functions/daily-logs),
// because only the Function can check the person's project role (a subcontractor sees the day's
// header and their own company's crew, the owner submitted logs only). Every change answers with the
// day's full detail, which goes straight into the cache, so the screen updates without a second call.
// A day is addressed by its date ("yyyy-MM-dd" in the project's timezone).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { FUNCTIONS, FunctionRefused, callFunction } from "../../lib/blocks/functions";

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

export type LogCan = { open: boolean; editSections: boolean; editAnyCrew: boolean; editOwnCrew: boolean; submit: boolean; correct: boolean };

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
  history: LogHistory[];
  can: LogCan;
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
  | { action: "correct"; reason: string; section?: SectionKey; value?: unknown; crewCompanyId?: string; manpower?: ManpowerRow[]; notes?: string };

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

export const refusalText = (error: unknown, fallback: string) => (error instanceof FunctionRefused ? error.message : fallback);

export const totalsOf = (rows: ManpowerRow[]) => ({
  headcount: rows.reduce((s, r) => s + (Number(r.headcount) || 0), 0),
  hours: Math.round(rows.reduce((s, r) => s + (Number(r.hours) || 0), 0) * 100) / 100
});
