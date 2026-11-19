// M1 tenancy spike page (throwaway). Proves org-per-project isolation on the
// test environment: org switcher, SpikeRfi list/create/edit, and a cross-org
// probe. Every call's raw result or error goes into the log, which is the
// evidence copied into docs/spikes/M1-tenancy-spike.md.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "../../app/providers/AuthProvider";
import { blocksClient } from "../../lib/blocks/client";
import { blocksConfig } from "../../lib/blocks/config";
import { ActionButton } from "../../shared/ui/ActionButton";
import { JsonPanel } from "../../shared/ui/JsonPanel";
import { PageHeader } from "../../shared/ui/PageHeader";

type SpikeRfi = Record<string, unknown> & {
  ItemId?: string;
  itemId?: string;
  title?: string;
  status?: string;
  note?: string;
  createdByUserId?: string;
  projectRole?: string;
  OrganizationId?: unknown;
};

type LogEntry = { at: string; action: string; ok: boolean; result: unknown };

const FIELDS = ["title", "status", "note", "createdByUserId", "projectRole", "OrganizationId", "CreatedBy"];

// Role-per-project test: each spike org has its own project role.
const PROJECT_ROLES: Record<string, string> = {
  "af143205-f94d-4fe5-a764-6195efeab832": "prj-a",
  "47594bad-8e71-4339-a241-ce84a34ebb9e": "prj-b"
};

function orgIdOf(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] ?? "");
  return String(value ?? "");
}
const rfis = blocksClient.data.collection<SpikeRfi>("SpikeRfi", { fields: FIELDS });

function idOf(row: SpikeRfi): string {
  return String(row.ItemId ?? row.itemId ?? "");
}

function itemsOf(response: unknown): SpikeRfi[] {
  const r = response as { data?: { getSpikeRfis?: { items?: SpikeRfi[] }; items?: SpikeRfi[] }; items?: SpikeRfi[] };
  return r.data?.getSpikeRfis?.items ?? r.data?.items ?? r.items ?? [];
}

// GraphQL can answer 200 with an errors array; treat that as a failure too.
function graphqlErrors(response: unknown): unknown {
  const errors = (response as { errors?: unknown[] } | undefined)?.errors;
  return Array.isArray(errors) && errors.length ? errors : undefined;
}

function errorValue(error: unknown): unknown {
  if (error instanceof Error) return { name: error.name, message: error.message, ...(error as unknown as Record<string, unknown>) };
  return error;
}

export function SpikePage() {
  const { claims, refresh } = useAuth();
  const queryClient = useQueryClient();
  const [log, setLog] = useState<LogEntry[]>([]);
  const [title, setTitle] = useState("");
  const [probeId, setProbeId] = useState("");

  const userId = String(claims?.sub ?? claims?.user_id ?? "");
  const tokenOrg = claims?.org_id ?? claims?.organization_id ?? claims?.organizationId ?? claims?.tenant_org;

  function record(action: string, ok: boolean, result: unknown) {
    setLog((prev) => [{ at: new Date().toLocaleTimeString(), action, ok, result }, ...prev].slice(0, 40));
  }

  async function run<T>(action: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      const result = await fn();
      const gqlErrors = graphqlErrors(result);
      record(action, !gqlErrors, result);
      return result;
    } catch (error) {
      record(action, false, errorValue(error));
      return undefined;
    }
  }

  const me = useQuery({ queryKey: ["spike", "me"], queryFn: () => blocksClient.iam.me() });
  const myOrgs = useQuery({ queryKey: ["spike", "orgs"], queryFn: () => blocksClient.iam.organizations.my() });
  const list = useQuery({
    queryKey: ["spike", "rfis"],
    queryFn: async () => {
      const response = await rfis.list({ pageNo: 1, pageSize: 50 });
      record("list SpikeRfi", !graphqlErrors(response), response);
      return itemsOf(response);
    }
  });

  const orgs = ((myOrgs.data as { data?: unknown[]; organizations?: unknown[] } | undefined)?.data
    ?? (myOrgs.data as { organizations?: unknown[] } | undefined)?.organizations
    ?? (Array.isArray(myOrgs.data) ? myOrgs.data : [])) as Array<Record<string, unknown>>;

  async function switchTo(organizationId: string, name: string) {
    const result = await run(`switch to ${name}`, () => blocksClient.auth.switchOrganization({ organizationId }));
    if (result === undefined) return;
    // Drop everything cached under the old org before re-reading.
    queryClient.removeQueries({ queryKey: ["spike"] });
    await refresh();
    await queryClient.invalidateQueries();
  }

  const currentRole = PROJECT_ROLES[String(tokenOrg ?? "")] ?? "";
  const otherRole = currentRole === "prj-a" ? "prj-b" : "prj-a";

  async function create(projectRole = currentRole) {
    const label = projectRole === currentRole ? "create SpikeRfi" : `create SpikeRfi with OTHER role ${projectRole}`;
    await run(label, () => rfis.create({ title: title || `Spike ${new Date().toLocaleTimeString()}`, status: "open", note: "", createdByUserId: userId, projectRole }));
    setTitle("");
    await list.refetch();
  }

  async function edit(row: SpikeRfi) {
    await run(`edit ${idOf(row)}`, () => rfis.update(idOf(row), { status: row.status === "answered" ? "open" : "answered" }));
    await list.refetch();
  }

  async function stamp(row: SpikeRfi) {
    const role = PROJECT_ROLES[orgIdOf(row.OrganizationId)];
    if (!role) return record(`stamp ${idOf(row)}`, false, "unknown org");
    await run(`stamp ${idOf(row)} -> ${role}`, () => rfis.update(idOf(row), { projectRole: role }));
    await list.refetch();
  }

  async function probe(kind: "get" | "edit") {
    const id = probeId.trim();
    if (!id) return;
    if (kind === "get") await run(`probe get ${id}`, () => rfis.get(id));
    else await run(`probe edit ${id}`, () => rfis.update(id, { note: `probe ${new Date().toISOString()}` }));
  }

  return (
    <section>
      <PageHeader
        title="Tenancy spike"
        subtitle={`Tenant ${blocksConfig.xBlocksKey}. Throwaway page for M1; see docs/spikes/M1-tenancy-spike.md.`}
      />

      <div className="spike-grid" style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        <div className="profile-card" style={{ display: "block" }}>
          <h3>Session</h3>
          <p>User id: <code>{userId || "?"}</code></p>
          <p>Token org: <code>{String(tokenOrg ?? "not in claims")}</code></p>
          <details><summary>Session claims (auth/me)</summary><JsonPanel value={claims} /></details>
          <details><summary>iam.me()</summary><JsonPanel value={me.data ?? me.error} /></details>
        </div>

        <div className="profile-card" style={{ display: "block" }}>
          <h3>My organizations</h3>
          {orgs.length === 0 ? <p>None returned.</p> : null}
          {orgs.map((org) => {
            const id = String(org.itemId ?? org.organizationId ?? org.id ?? "");
            const name = String(org.name ?? org.organizationName ?? id);
            return (
              <p key={id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <ActionButton onClick={() => void switchTo(id, name)}>Switch</ActionButton>
                <span>{name} <code>{id.slice(0, 8)}</code></span>
              </p>
            );
          })}
          <details><summary>organizations.my() raw</summary><JsonPanel value={myOrgs.data ?? myOrgs.error} /></details>
        </div>
      </div>

      <div className="profile-card" style={{ display: "block", marginTop: 16 }}>
        <h3>SpikeRfi records visible now ({list.data?.length ?? 0})</h3>
        <p style={{ display: "flex", gap: 8 }}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" />
          <ActionButton onClick={() => void create()}>Create ({currentRole || "no role"})</ActionButton>
          <ActionButton onClick={() => void create(otherRole)}>Create with {otherRole}</ActionButton>
          <ActionButton onClick={() => void list.refetch()}>Reload</ActionButton>
        </p>
        <table style={{ width: "100%" }}>
          <thead><tr><th align="left">ItemId</th><th align="left">Title</th><th align="left">Status</th><th align="left">projectRole</th><th align="left">OrganizationId</th><th /></tr></thead>
          <tbody>
            {(list.data ?? []).map((row) => (
              <tr key={idOf(row)}>
                <td><code>{idOf(row)}</code></td>
                <td>{row.title}</td>
                <td>{row.status}</td>
                <td><code>{row.projectRole ?? "-"}</code></td>
                <td><code>{JSON.stringify(row.OrganizationId)}</code></td>
                <td style={{ display: "flex", gap: 4 }}>
                  <ActionButton onClick={() => void edit(row)}>Toggle status</ActionButton>
                  <ActionButton onClick={() => void stamp(row)}>Stamp role</ActionButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="profile-card" style={{ display: "block", marginTop: 16 }}>
        <h3>Cross-org probe</h3>
        <p>Paste an ItemId from the other project, then try to read or edit it from here.</p>
        <p style={{ display: "flex", gap: 8 }}>
          <input value={probeId} onChange={(e) => setProbeId(e.target.value)} placeholder="ItemId" style={{ flex: 1 }} />
          <ActionButton onClick={() => void probe("get")}>Probe read</ActionButton>
          <ActionButton onClick={() => void probe("edit")}>Probe edit</ActionButton>
        </p>
      </div>

      <div className="profile-card" style={{ display: "block", marginTop: 16 }}>
        <h3>Call log</h3>
        {log.map((entry, index) => (
          <details key={index} open={index === 0}>
            <summary>{entry.at} · {entry.ok ? "OK" : "FAILED"} · {entry.action}</summary>
            <JsonPanel value={entry.result} />
          </details>
        ))}
      </div>
    </section>
  );
}
