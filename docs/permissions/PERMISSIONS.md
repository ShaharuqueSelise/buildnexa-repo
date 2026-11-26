# Buildnexa permissions

How Buildnexa decides who may do what. The client's specification is
[Buildnexa_RBAC_Role_and_Permission_Specification.pdf](Buildnexa_RBAC_Role_and_Permission_Specification.pdf).
This page covers what we built from it, the points we changed or still need to agree, and the limits
that remain.

**The table itself is code:** [`functions/_shared/permissions.js`](../../functions/_shared/permissions.js).
Every Function gets a copy through `tools/sync-functions.mjs`, and the screens import it through
`src/lib/permissions.ts`. A button and the server read the same table, so they cannot disagree.
Company admin › Roles shows it to the customer.

## 1. User stories

- **Company admin.** As a company admin, I invite my staff and the people of my partner companies,
  register those partner companies, create projects and put people on project teams. I see every
  project and its team, but not its RFIs, documents or budget unless I also hold a role on that project.
- **Project Manager.** As a PM, I run my project: I edit it, manage its team and do everything in
  every module.
- **Superintendent, Document Controller.** As GC staff, I work in the modules my role covers, only
  on the projects I am added to.
- **Subcontractor, Designer / Consultant, Owner.** As someone from a partner company, I only see the
  projects I am added to. Inside them I only see what my role and my company's involvement allow.
  I can never be given a GC role.
- **Platform admin.** As a Buildnexa operator, I create customer companies and their first admins.
  I get no customer project content.

## 2. Two kinds of roles

| Kind | Where it lives | Roles |
|---|---|---|
| Account role (company or platform level) | IAM role on the person's account in the company's Blocks organization | `company-admin`, `staff`, `external` (partner), `platform-admin`, `cpm-service` (the Functions' own identity) |
| Project role (one per person per project) | `ProjectMember.role` | `project-manager`, `superintendent`, `document-controller`, `field-user`, `design-reviewer`, `owner-viewer` |

Names on screen follow the spec: Project Manager, Superintendent, Document Controller,
Subcontractor (`field-user`), Designer / Consultant (`design-reviewer`), Owner (`owner-viewer`).
The system names stay as they are, because the stored data uses them.

**Membership is required.** A project role only counts on that project. Being a company admin or
platform admin gives no project content (spec §6).

**Partner companies.** A company's `relation` is `self` (the customer) or `sub`, `design`, `owner`
or `supplier`. People from a partner company may only hold `field-user`, `design-reviewer` or
`owner-viewer`. The Functions check this on invite, on default-role change and when people are added
to a team (`mayHoldProjectRole`). The dropdowns only offer those roles.

Default project role by company type: own staff → Superintendent; subcontractor and supplier →
Subcontractor; design firm → Designer / Consultant; owner → Owner.

## 3. Project permissions

✓ = full. **L** = Limited: only records that belong to the person or their company, or that they are
assigned to. The module's Function checks the record as well as the key. — = none.

| Permission | PM | Supt | DC | Sub | Design | Owner |
|---|---|---|---|---|---|---|
| project.view | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| project.update, project.manage_members | ✓ | — | — | — | — | — |
| rfi.view | ✓ | ✓ | ✓ | L (involved) | ✓ | ✓ |
| rfi.create | ✓ | ✓ | ✓ | ✓ | — | — |
| rfi.respond | ✓ | ✓ | ✓ | L (assigned) | L (assigned) | — |
| rfi.edit, rfi.reassign, rfi.close, rfi.void, rfi.reopen | ✓ | — | — | — | — | — |
| rfi.mark_official | ✓ | — | — | — | L (own answer) | — |
| rfi.see_cost | ✓ | ✓ | ✓ | — | — | ✓ |
| rfi.see_internal | ✓ | ✓ | ✓ | — | — | — |
| drawing.view | ✓ | ✓ | ✓ | L (relevant) | ✓ | ✓ |
| drawing.pin | ✓ | ✓ | ✓ (P8) | ✓ | — | — |
| drawing.upload | ✓ | — | ✓ | — | ✓ (revisions) | — |
| drawing.manage_versions | ✓ | — | ✓ | — | — | — |
| document.view | ✓ | ✓ | ✓ | L | L | ✓ |
| document.upload | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| document.manage | ✓ | — | ✓ | — | — | — |
| submittal.view | ✓ | ✓ | ✓ | L (own) | ✓ | ✓ |
| submittal.manage | ✓ | — | ✓ | — | — | — |
| submittal.upload_own | — | — | — | ✓ | — | — |
| submittal.review | ✓ | — | — | — | ✓ | — |
| daily_log.view (every section, drafts too) | ✓ | ✓ | ✓ | — | — | — |
| daily_log.view_submitted (submitted logs only) | — | — | — | — | — | ✓ |
| daily_log.create (open a day, fill it, every crew, submit) | ✓ | ✓ | — | — | — | — |
| daily_log.crew_own (the day's header, own company's crew and notes, opens today only) | — | — | — | L (own crew) | — | — |
| daily_log.correct | ✓ | — | — | — | — | — |
| punch_item.view | ✓ | ✓ | ✓ | L (assigned) | ✓ | ✓ |
| punch_item.create, assign, close | ✓ | ✓ | — | — | — | — |
| punch_item.update_assigned | — | — | — | ✓ | — | — |
| budget.view, budget.manage | ✓ | — | — | — | — | — |
| budget.view_summary | — | — | — | — | — | ✓ |
| change_order.view | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| change_order.create, change_order.approve | ✓ | — | — | — | — | — |
| change_order.approve_assigned | — | — | — | — | — | ✓ |
| report.view | ✓ | L | L | L | L | ✓ |
| report.export | ✓ | — | — | — | — | — |

Some actions also depend on the record. The RFI creator may close or void their own RFI, and may
pass the ball on it. These per-record checks live in the module's Function.

## 4. Company and platform permissions

| Permission | Held by |
|---|---|
| company.manage_people, company.manage_partners, company.settings | company-admin |
| project.create | company-admin, or staff whose admin ticked "Can create projects" (`project.create_when_allowed`) |
| project.list_all, project.manage_members_any (project list and teams, not content) | company-admin |
| platform.manage_companies, platform.manage_admins | platform-admin |

## 5. How it is enforced

1. **Data Gateway rules** (`tools/data-model.mjs` → `blocks/data/rules.json`).
   - The company's own **staff and admins** may read Company, OrgMember, Project and ProjectMember
     rows of their own company directly (`tenantRole In Auth.roles`).
   - **Partners (`external`) have no direct read.** They load their projects, teams and people
     through the projects Function's `workspace` action. It only returns projects where they have
     an active membership, and it leaves out the contract value.
   - **Project content** (ActivityEvent, Comment, Sequence and every module after them) can only
     be read and written by the service identity, which means through Functions.
   - **Every write** goes through a Function. Nobody has direct create or edit rights; delete
     is closed to everyone (records are voided).
2. **Functions** check the caller's account roles (`accountCan`) and their project role
   (`projectCan`) before doing anything. A refusal comes back as `{ ok: false, code, error }`.
3. **Screens** hide or explain what the person can't do. That is for convenience only, never a
   security check.
4. **Audit.** People, admin, role, team and partner-company changes write an `ActivityEvent`
   showing who did it, before and after.

The Functions run with the service token, which is kept in a Blocks secret. That secret's access list
is the gate for who may run Functions at all: `company-admin`, `staff` and `external`. Being on the
list does not let anyone read the secret's value; that was tested and refused with 403.

## 6. Changes to the spec, and points to agree with the client

| # | Point | What we did, or the question |
|---|---|---|
| P1 | **Designer / Consultant: drawings** | The spec gives "upload". We read that as uploading revisions in their own discipline. Managing the drawing register (supersede, void) stays with the PM and DC. **Confirm.** |
| P2 | **Document Controller: RFIs** | The spec marks DC as Full on RFIs. We gave view, create and respond, but not close, void, reassign or mark official (PM only). **Confirm** whether DC should also close. |
| P3 | **Superintendent: change orders "Limited"** | The spec doesn't define "Limited" here. We gave view only. **Define** what Limited means (for example, raise change events). |
| P4 | **Owner: daily logs** | Owners see submitted logs only, never drafts. |
| P5 | **Change order separation of duties** | Approval within thresholds, and never approving your own change order, comes with the change orders module. |
| P6 | **Role names** | Screens use the spec's names. System names stay (`field-user` = Subcontractor, `design-reviewer` = Designer / Consultant, `owner-viewer` = Owner). |
| P7 | **Custom roles** | Not built. The code checks permission keys, never role names, so a custom role later is one more entry in the table. |
| P8 | **Document Controller: pins on drawings** | **Agreed with the client 2026-11-25:** a DC places pins too. `drawing.pin` now includes the DC, so a DC can pin the RFIs they raise ("New RFI here") and pin an existing punch item that has no pin. "New punch item here" still needs `punch_item.create` (PM, superintendent). As before, a DC moves or removes any pin through `drawing.manage_versions`. |
| P9 | **Designer / Consultant: daily logs** | **Decided 2026-11-26:** designers get no daily logs (the spec gave them submitted logs). Subcontractors see only the day's header (date, status, weather, site conditions) and their own company's crew, never the other sections or other companies. |

## 7. Known limits (accepted for now)

- **Staff can read every project's basic details in their company.** This includes its contract
  value, through a direct API call (not through the screens). The rules can only compare a field
  with the person's roles, not look up their team memberships. Moving staff to Function-only reads
  as well would close this, at the cost of slower pages. **Decide before go-live.**
- **Limited keys need a record check.** `_assigned`, `_own`, `_involved` and `_relevant` say the
  role may act on some records. Each module's Function must check which ones. They come with each
  module (RFIs first).
- **Partners are on the service secret's access list.** That lets them run Functions. Each Function
  refuses partners where they have no business (company-people is admin only; project create and
  team changes need an admin or the PM).
