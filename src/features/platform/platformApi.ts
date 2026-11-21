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
