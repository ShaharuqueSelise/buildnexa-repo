// The screens' view of the ONE permission table (functions/_shared/permissions.js), the same file
// the Functions run, so a button and the server never disagree. Screens only hide or explain;
// the Functions decide.
export {
  PARTNER_PROJECT_ROLES,
  PROJECT_ROLES,
  accountCan,
  mayHoldProjectRole,
  projectCan,
  projectPermissionsOf
} from "../../functions/_shared/permissions.js";
