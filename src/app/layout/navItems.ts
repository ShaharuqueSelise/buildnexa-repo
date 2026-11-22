// Every page in the sidebar, grouped as in the demo app (mock/src/mock/MockApp.tsx ROUTES), and
// who may open it (mock/src/mock/data.ts ROLE_MODULES, from the PRD permissions matrix).
// Modules that are not built yet stay listed with the phase that builds them
// (docs/PROJECT_PHASES.md); their page says so.
import {
  Building2, CalendarDays, ClipboardCheck, FileQuestion, FileStack, FolderOpen, Home, Images, Inbox, LayoutGrid, LineChart,
  Map as MapIcon, Receipt, ScrollText, Settings, ShieldCheck, Smartphone, Users, Wallet
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { TranslationKey } from "../../lib/i18n/dictionary";

export type ModuleKey =
  | "home" | "drawings" | "rfis" | "submittals" | "logs" | "punch" | "photos" | "documents"
  | "budget" | "changeOrders" | "directory" | "reports" | "audit" | "settings" | "inbox"
  | "portfolio" | "companyAdmin" | "platformAdmin" | "field";

export type NavGroup = "project" | "financials" | "projectAdmin" | "workspace" | "administration";

export type NavItem = {
  href: string;
  labelKey: TranslationKey;
  icon: LucideIcon;
  module: ModuleKey;
  group: NavGroup;
  /** The phase that builds it; absent when the page is real. */
  phase?: 2 | 3 | 4 | 5;
};

export const NAV_GROUPS: { key: NavGroup; labelKey: TranslationKey }[] = [
  { key: "project", labelKey: "nav.group.project" },
  { key: "financials", labelKey: "nav.group.financials" },
  { key: "projectAdmin", labelKey: "nav.group.projectAdmin" },
  { key: "workspace", labelKey: "nav.group.workspace" },
  { key: "administration", labelKey: "nav.group.administration" }
];

export const navItems: readonly NavItem[] = [
  { href: "/", labelKey: "nav.home", icon: Home, module: "home", group: "project" },
  { href: "/drawings", labelKey: "nav.drawings", icon: MapIcon, module: "drawings", group: "project", phase: 3 },
  { href: "/rfis", labelKey: "nav.rfis", icon: FileQuestion, module: "rfis", group: "project" },
  { href: "/submittals", labelKey: "nav.submittals", icon: FileStack, module: "submittals", group: "project", phase: 4 },
  { href: "/daily-logs", labelKey: "nav.dailyLogs", icon: CalendarDays, module: "logs", group: "project", phase: 3 },
  { href: "/punch", labelKey: "nav.punch", icon: ClipboardCheck, module: "punch", group: "project", phase: 3 },
  { href: "/photos", labelKey: "nav.photos", icon: Images, module: "photos", group: "project", phase: 2 },
  { href: "/documents", labelKey: "nav.documents", icon: FolderOpen, module: "documents", group: "project", phase: 2 },
  { href: "/budget", labelKey: "nav.budget", icon: Wallet, module: "budget", group: "financials", phase: 4 },
  { href: "/change-orders", labelKey: "nav.changeOrders", icon: Receipt, module: "changeOrders", group: "financials", phase: 4 },
  { href: "/directory", labelKey: "nav.directory", icon: Users, module: "directory", group: "projectAdmin" },
  { href: "/reports", labelKey: "nav.reports", icon: LineChart, module: "reports", group: "projectAdmin", phase: 5 },
  { href: "/audit", labelKey: "nav.audit", icon: ScrollText, module: "audit", group: "projectAdmin", phase: 2 },
  { href: "/settings", labelKey: "nav.settings", icon: Settings, module: "settings", group: "projectAdmin", phase: 5 },
  { href: "/projects", labelKey: "nav.projects", icon: LayoutGrid, module: "portfolio", group: "workspace" },
  { href: "/inbox", labelKey: "nav.inbox", icon: Inbox, module: "inbox", group: "workspace", phase: 2 },
  { href: "/field", labelKey: "nav.field", icon: Smartphone, module: "field", group: "workspace", phase: 3 },
  { href: "/company", labelKey: "nav.company", icon: Building2, module: "companyAdmin", group: "administration" },
  { href: "/platform", labelKey: "nav.platform", icon: ShieldCheck, module: "platformAdmin", group: "administration" }
];

const ALL_PROJECT: ModuleKey[] = ["home", "drawings", "rfis", "submittals", "logs", "punch", "photos", "documents", "directory", "inbox", "portfolio", "field"];

/** What each project role (ProjectMember.role) may open, as in the demo app. */
const ROLE_MODULES: Record<string, ModuleKey[]> = {
  "project-manager": [...ALL_PROJECT, "budget", "changeOrders", "reports", "audit", "settings"],
  superintendent: [...ALL_PROJECT, "budget", "changeOrders", "reports"],
  "document-controller": [...ALL_PROJECT, "reports", "audit"],
  "field-user": ["home", "drawings", "rfis", "submittals", "logs", "punch", "photos", "documents", "directory", "inbox", "portfolio", "field"],
  "design-reviewer": ["home", "drawings", "rfis", "submittals", "photos", "documents", "directory", "inbox", "portfolio"],
  "owner-viewer": ["home", "drawings", "rfis", "submittals", "logs", "punch", "photos", "budget", "changeOrders", "reports", "directory", "inbox", "portfolio"]
};
const COMPANY_ADMIN: ModuleKey[] = ["portfolio", "companyAdmin", "inbox", "directory", "home"];
const EVERYONE: ModuleKey[] = ["home", "portfolio", "inbox"];

const PLATFORM_ONLY: ModuleKey[] = ["platformAdmin", "inbox"];

/**
 * The modules someone may open: their role on the current project, plus Company admin's.
 * A platform admin outside any company sees only the platform area.
 */
export function visibleModules({ projectRole, isAdmin, isPlatformAdmin, platformOnly }: { projectRole?: string; isAdmin: boolean; isPlatformAdmin?: boolean; platformOnly?: boolean }): Set<ModuleKey> {
  if (platformOnly) return new Set(PLATFORM_ONLY);
  const set = new Set<ModuleKey>(EVERYONE);
  for (const m of ROLE_MODULES[projectRole ?? ""] ?? []) set.add(m);
  if (isAdmin) for (const m of COMPANY_ADMIN) set.add(m);
  if (isPlatformAdmin) set.add("platformAdmin");
  return set;
}

export function navItemFor(path: string): NavItem | undefined {
  return navItems.find((item) => item.href === path);
}
