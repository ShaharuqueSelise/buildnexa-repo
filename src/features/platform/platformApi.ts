// Platform admin data, through the Function `platform` (platform admins only).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FUNCTIONS, callFunction } from "../../lib/blocks/functions";

export type PlatformCompany = {
  id: string;
  name: string;
  /** The company's hidden tag (tenant role), e.g. company-mueller-bau. */
  tag: string;
  status: string;
  createdAt?: string;
  admins: { name: string; email: string; status: string }[];
  people: number;
  invited: number;
  projects: number;
};

export type NewCompany = { name: string; shortName: string; admin: { email: string; firstName: string; lastName: string } };

const KEY = ["platform", "companies"] as const;

export function useCompanies(enabled = true) {
  return useQuery({
    queryKey: KEY,
    enabled,
    queryFn: async () => (await callFunction<{ companies: PlatformCompany[] }>(FUNCTIONS.platform, { action: "list" })).companies
  });
}

export function useCreateCompany() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: NewCompany) => callFunction<{ company: { name: string; tag: string } }>(FUNCTIONS.platform, { action: "create", ...input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY })
  });
}

// ---------- story 3.4 ----------
export type NewAdmin = { email: string; firstName: string; lastName: string };

export function useAddCompanyAdmin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { companyId: string; admin: NewAdmin }) => callFunction<{ invited: boolean }>(FUNCTIONS.platform, { action: "addCompanyAdmin", ...input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY })
  });
}

// ---------- stories 3.5 to 3.7 ----------
export type PlatformAdmin = { userId: string; name: string; email: string; state: "active" | "invited" | "deactivated"; lastLoggedInTime?: string; isMe: boolean };

const ADMINS_KEY = ["platform", "admins"] as const;

export function usePlatformAdmins(enabled = true) {
  return useQuery({
    queryKey: ADMINS_KEY,
    enabled,
    queryFn: async () => (await callFunction<{ admins: PlatformAdmin[] }>(FUNCTIONS.platform, { action: "listAdmins" })).admins
  });
}

export function useAddPlatformAdmin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: NewAdmin) => callFunction<{ invited: boolean }>(FUNCTIONS.platform, { action: "addAdmin", ...input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADMINS_KEY })
  });
}

export function useRemovePlatformAdmin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => callFunction<Record<string, unknown>>(FUNCTIONS.platform, { action: "removeAdmin", userId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADMINS_KEY })
  });
}

/** A short name from the company name: "Müller Bau GmbH" -> "mueller-bau-gmbh". */
export function shortNameFrom(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}
