// Projects and teams, read straight from the Data Gateway with the signed-in user's token
// (Project, ProjectMember, OrgMember and Company are readable by everyone in the company
// organization). Writes go through the `projects` Function.
//
// Who sees which project (docs/architecture/01 §3): company admins see every project, everyone
// else only projects where they have an active ProjectMember row. The server would return other
// projects of the same company to someone calling the API directly; that is the accepted
// trade-off of v0.2.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { blocksClient } from "../../lib/blocks/client";
import { FUNCTIONS, callFunction } from "../../lib/blocks/functions";
import { useCurrentUser, useMyRoles } from "../profile/useCurrentUser";

export type Stage = "preconstruction" | "construction" | "closeout" | "archived";

export type ProjectRow = {
  ItemId: string;
  number: string;
  name: string;
  clientName?: string;
  projectType?: string;
  address?: { street?: string; city?: string };
  status?: string; // active | onHold | completed | archived
  stage?: string;
  startDate?: string;
  endDate?: string;
  timezone?: string;
  contractValue?: number;
  createdByUserId?: string;
};

export type TeamRow = {
  ItemId: string;
  projectId: string;
  userId: string;
  orgMemberId?: string;
  email?: string;
  displayName?: string;
  companyId?: string;
  companyName?: string;
  companyRelation?: string;
  role: string;
  status?: string;
  joinedAt?: string;
};

export type OrgMemberRow = {
  ItemId: string;
  userId: string;
  email: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  jobTitle?: string;
  companyId?: string;
  companyName?: string;
  companyRelation?: string;
  orgRole?: string;
  defaultRole?: string;
  isCompanyAdmin?: boolean;
  canCreateProjects?: boolean;
  status?: string; // invited | active | deactivated | removed
  invitedAt?: string;
  joinedAt?: string;
};

export type CompanyRow = { ItemId: string; name: string; relation: string; brandColor?: string; isVoided?: boolean; address?: { city?: string }; tradeCodes?: string[] };

type Workspace = { projects: ProjectRow[]; team: TeamRow[]; people: OrgMemberRow[]; companies: CompanyRow[] };

const QUERY = `query workspace($input: DynamicQueryInput) {
  getProjects(input: $input) { items { ItemId number name clientName projectType address { street city } status stage startDate endDate timezone contractValue createdByUserId } }
  getProjectMembers(input: $input) { items { ItemId projectId userId orgMemberId email displayName companyId companyName companyRelation role status joinedAt } }
  getOrgMembers(input: $input) { items { ItemId userId email displayName firstName lastName phone jobTitle companyId companyName companyRelation orgRole defaultRole isCompanyAdmin canCreateProjects status invitedAt joinedAt } }
  getCompanys(input: $input) { items { ItemId name relation brandColor isVoided address { city } tradeCodes } }
}`;

type GqlResponse = {
  data?: {
    getProjects?: { items?: ProjectRow[] };
    getProjectMembers?: { items?: TeamRow[] };
    getOrgMembers?: { items?: OrgMemberRow[] };
    getCompanys?: { items?: CompanyRow[] };
  };
  errors?: { message?: string }[];
};

async function loadWorkspace(): Promise<Workspace> {
  const res = (await blocksClient.data.graphql({ operationName: "workspace", query: QUERY, variables: { input: { pageNo: 1, pageSize: 1000 } } })) as GqlResponse;
  if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join("; "));
  return {
    projects: res.data?.getProjects?.items ?? [],
    team: res.data?.getProjectMembers?.items ?? [],
    people: res.data?.getOrgMembers?.items ?? [],
    companies: (res.data?.getCompanys?.items ?? []).filter((c) => !c.isVoided)
  };
}

const KEY = ["workspace"] as const;

// true while only company admins may run Functions that use the Buildnexa service password.

/** The demo app's stage for a project (archived wins over the stored stage). */
export function stageOf(p: ProjectRow): Stage {
  if (p.status === "archived") return "archived";
  return p.stage === "construction" || p.stage === "closeout" ? p.stage : "preconstruction";
}

/** Share of the planned time already gone, 0-100 (the project's real progress comes with daily logs). */
export function timeElapsed(p: ProjectRow, now = Date.now()): number {
  const start = p.startDate ? Date.parse(p.startDate) : NaN;
  const end = p.endDate ? Date.parse(p.endDate) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.max(0, Math.min(100, Math.round(((now - start) / (end - start)) * 100)));
}

/** A stable cover hue per project, as the demo app's `hue`. */
export function hueOf(p: Pick<ProjectRow, "ItemId" | "number">): number {
  let h = 0;
  for (const ch of `${p.number}${p.ItemId}`) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function personName(m: Pick<OrgMemberRow, "displayName" | "firstName" | "lastName" | "email">): string {
  return m.displayName || [m.firstName, m.lastName].filter(Boolean).join(" ") || m.email;
}

// ---------- current project (the switcher), kept per browser ----------
const CURRENT_KEY = "buildnexa:current-project";
const listeners = new Set<() => void>();
function readCurrent(): string | null {
  try {
    return localStorage.getItem(CURRENT_KEY);
  } catch {
    return null;
  }
}
export function setCurrentProject(id: string) {
  try {
    localStorage.setItem(CURRENT_KEY, id);
  } catch {
    // private window: the choice lasts until reload
  }
  memoryCurrent = id;
  listeners.forEach((l) => l());
}
let memoryCurrent: string | null = readCurrent();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The company-level roles; anyone holding one belongs to a customer company. */
const COMPANY_ROLES = ["company-admin", "staff", "external"];

/**
 * Everything the project screens need: the projects I can see, the current project, my role in
 * it and whether I may create projects or change its team.
 */
export function useProjects() {
  const roles = useMyRoles();
  const me = useCurrentUser();
  const myUserId = String((me.data?.data as { itemId?: string } | undefined)?.itemId ?? "");
  // A platform admin who belongs to no company has no projects; skip the company reads.
  const isPlatformAdmin = roles?.includes("platform-admin") ?? false;
  const inCompany = roles?.some((r) => COMPANY_ROLES.includes(r)) ?? false;
  const platformOnly = isPlatformAdmin && !inCompany;
  const query = useQuery({ queryKey: KEY, queryFn: loadWorkspace, enabled: Boolean(roles && myUserId) && !platformOnly });
  const current = useSyncExternalStore(subscribe, () => memoryCurrent);

  const isAdmin = roles?.includes("company-admin") ?? false;
  const isStaff = isAdmin || (roles?.includes("staff") ?? false);
  const ws = query.data;
  const myRows = (ws?.team ?? []).filter((r) => r.userId === myUserId && r.status === "active");
  const projects = (ws?.projects ?? [])
    .filter((p) => isAdmin || myRows.some((r) => r.projectId === p.ItemId))
    .sort((a, b) => a.number.localeCompare(b.number));
  const project = projects.find((p) => p.ItemId === current) ?? projects.find((p) => stageOf(p) !== "archived") ?? projects[0];
  const myMember = ws?.people.find((m) => m.userId === myUserId);
  const myRole = project ? myRows.find((r) => r.projectId === project.ItemId)?.role : undefined;

  return {
    query,
    ws,
    roles,
    myUserId,
    isAdmin,
    isPlatformAdmin,
    platformOnly,
    isStaff,
    projects,
    project,
    myRole,
    /** The company I work for (partners: their own company), shown instead of the hidden tag. */
    myCompanyName: myMember?.companyName ?? ws?.companies.find((c) => c.relation === "self")?.name,
    // Company admins, and staff their admin allowed, create projects; a project's team is changed by
    // a company admin or that project's PM. The projects Function checks the same rules on the server.
    canCreate: isAdmin || (isStaff && Boolean(myMember?.canCreateProjects)),
    canEditTeam: isAdmin || myRole === "project-manager",
    seesCost: isStaff
  };
}

// ---------- writes (projects Function) ----------
export type NewProject = {
  number: string;
  name: string;
  clientName?: string;
  projectType?: string;
  street: string;
  city: string;
  startDate: string;
  endDate: string;
  timezone: string;
  stage: "preconstruction" | "construction";
  contractValue?: number;
  team: { orgMemberId: string; role: string }[];
};

function useAction<I, O = Record<string, unknown>>(action: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: I) => callFunction<O>(FUNCTIONS.projects, { action, ...input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY })
  });
}

export const useCreateProject = () => useAction<NewProject, { projectId: string; added: number }>("create");
export const useAddMembers = () => useAction<{ projectId: string; team: { orgMemberId: string; role: string }[] }>("addMembers");
export const useSetProjectRole = () => useAction<{ projectId: string; projectMemberId: string; role: string }>("setRole");
export const useRemoveMember = () => useAction<{ projectId: string; projectMemberId: string }>("removeMember");
