# Isolation exit test (Development)

**User story:** as a customer, I can trust that no other company, no partner and no Buildnexa staff
member can see or change my data, even if they skip the screens and call Blocks directly.

**How:** `tools/isolation-probe.js` runs in the signed-in person's browser tab and calls the Data
Gateway, our Functions, IAM, Secrets and Logic directly. It reports only allowed/refused, status
codes and row counts. Nothing is changed when the rules hold (see the script header for how).

```js
const p = await import("/tools/isolation-probe.js"); const r = await p.run(); console.table(r.rows);
```

**Status: PAUSED on 22 Nov 2026** after three of five people. The partner and platform admin runs
are still open (see the end).

## Results

| Person | Role | Checks | Result |
|---|---|---|---|
| Demo Admin | company admin, Demo Builder | 48 | 1 FAIL (F1) |
| Hue | company admin, Western Refainery (other customer) | 57 | 1 FAIL (F1), 0 cross-company leaks |
| Lukas | staff, Demo Builder | 56 | all PASS |

### What held

- **Reads:** each person reads only their own company's rows (Company, OrgMember, Project,
  ProjectMember, ActivityEvent, Comment). Sequence is refused for everyone.
- **Direct writes:** inserts for every record type are refused, whether stamped with the
  caller's own company or another one. Renaming another company's record changes 0 rows.
- **Deletes:** refused for every record type.
- **Functions with another company's ids:** company-people `resend` answers "This person is not in your company".
  projects `removeMember` answers "This project is not in your company".
- **IAM:** users/access, users/create, users/revoke-access, roles/create and organizations/create
  are all 403. Listing users and listing organizations are also 403.
- **The service password:** the secrets list, secret details and both value routes all return 403
  for company admins. A customer cannot obtain the cpm-service credential.
- **Function code, runs and logs** (Get, GetRuns, GetVersionSource): 403.

### Findings

| # | Finding | Severity | Fix |
|---|---|---|---|
| F1 | A company admin can rewrite `tenantRole` on their own Company record (the update rule checks the existing row, not the new value). They could move their company record into another customer, which would then show a stranger company. No other customer's data becomes readable. | Medium (integrity) | Remove the `company-admin` update policy on Company in `tools/data-model.mjs`; nothing in the app uses it. Changing a company's details goes through a Function. Blocks change, so needs approval. |
| F2 | For staff, company-people stops with Blocks `SecretUnresolved` (502), so the screen shows a generic error instead of "only company admins". | Low (UX) | Catch the 502 in the app and show "Only a company admin can do this". The same cause stops staff with `canCreateProjects` from creating projects (open decision: open the secret to `staff`). |

## Still to run

1. **A partner** (Elektro Weber person; activate a yopmail invite first). Expected today: they can read
   **all** Demo Builder projects and people through direct calls (the accepted v0.2 trade-off). Measure
   it and decide whether partners must be limited to their own projects before production.
2. **The platform admin**: expect 0 company rows and the company Functions refused.
3. After F1 is fixed, rerun all five and record the new results here.
