// Project roles, as in the demo app (mock/src/mock/data.ts ROLES), keyed by the system slug that
// ProjectMember.role and OrgMember.defaultRole store. Labels are translation keys.
import type { TranslationKey } from "./i18n/dictionary";

export const PROJECT_ROLES = [
  "project-manager",
  "superintendent",
  "document-controller",
  "field-user",
  "design-reviewer",
  "owner-viewer"
] as const;

export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const ROLE_LABEL: Record<ProjectRole | "company-admin", { label: TranslationKey; short: TranslationKey }> = {
  "project-manager": { label: "role.pm", short: "role.pm.short" },
  superintendent: { label: "role.supt", short: "role.supt.short" },
  "document-controller": { label: "role.dc", short: "role.dc.short" },
  "field-user": { label: "role.sub", short: "role.sub.short" },
  "design-reviewer": { label: "role.design", short: "role.design.short" },
  "owner-viewer": { label: "role.owner", short: "role.owner.short" },
  "company-admin": { label: "role.coadmin", short: "role.coadmin.short" }
};

export function isProjectRole(value: unknown): value is ProjectRole {
  return typeof value === "string" && (PROJECT_ROLES as readonly string[]).includes(value);
}

