// Types for permissions.js (the shared permission table), so the screens can import it.
export declare const PROJECT_ROLES: readonly ["project-manager", "superintendent", "document-controller", "field-user", "design-reviewer", "owner-viewer"];
export declare const PARTNER_PROJECT_ROLES: readonly ["field-user", "design-reviewer", "owner-viewer"];
export declare function projectCan(projectRole: string | undefined, key: string): boolean;
export declare function accountCan(accountRoles: readonly string[] | undefined, key: string): boolean;
export declare function projectPermissionsOf(projectRole: string): string[];
export declare function mayHoldProjectRole(companyRelation: string | undefined, projectRole: string): boolean;
