import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FUNCTIONS, callFunction } from "../../lib/blocks/functions";

export type Relation = "self" | "sub" | "design" | "owner" | "supplier";

export type Person = {
  ItemId: string;
  userId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  phone?: string;
  jobTitle?: string;
  companyId?: string;
  companyName?: string;
  companyRelation?: Relation;
  orgRole?: "staff" | "external";
  defaultRole?: string;
  isCompanyAdmin?: boolean;
  status?: "invited" | "active" | "deactivated" | "removed";
  invitedAt?: string;
  joinedAt?: string;
  // From IAM
  accountState?: string; // "Active" once the invitation was accepted, "PendingVerification" before
  lastLoggedInTime?: string;
  phoneNumber?: string;
  language?: string;
  isMe?: boolean;
};

export type Company = {
  ItemId: string;
  name: string;
  relation: Relation;
  brandColor?: string;
  tradeCodes?: string[];
  address?: { city?: string } | null;
};
export type PartnerRelation = Exclude<Relation, "self">;
export type CompanyInput = { name: string; tradeCodes: string[]; city: string };
export type Project = { ItemId: string; number: string; name: string; status?: string };
export type Membership = { ItemId: string; projectId: string; userId: string; orgMemberId?: string; role: string };

export type PeopleList = { people: Person[]; companies: Company[]; projects: Project[]; memberships: Membership[] };

export type InviteInput = {
  email: string;
  firstName: string;
  lastName: string;
  jobTitle?: string;
  companyId: string;
  defaultRole: string;
  projectIds: string[];
};

/** The status the demo app shows: Active, Invited or Deactivated. */
export function personStatus(p: Person): "Active" | "Invited" | "Deactivated" {
  if (p.status === "deactivated") return "Deactivated";
  return p.accountState === "Active" ? "Active" : "Invited";
}

const KEY = ["company", "people"] as const;

export function usePeople(enabled = true) {
  return useQuery({
    queryKey: KEY,
    queryFn: () => callFunction<PeopleList>(FUNCTIONS.companyPeople, { action: "list" }),
    enabled
  });
}

function useAction<I>(action: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: I) => callFunction<Record<string, unknown>>(FUNCTIONS.companyPeople, { action, ...input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY })
  });
}

export const useInvitePerson = () => useAction<InviteInput>("invite");
export const useSetDefaultRole = () => useAction<{ memberId: string; role: string }>("setDefaultRole");
export const useResendInvite = () => useAction<{ memberId: string }>("resend");
export const useDeactivate = () => useAction<{ memberId: string }>("deactivate");
export const useReactivate = () => useAction<{ memberId: string }>("reactivate");
/** Stories 3.1/3.2: make a staff member a company admin, or turn an admin back into staff with `role`. */
export const useSetAdmin = () => useAction<{ memberId: string; isAdmin: boolean; role?: string }>("setAdmin");

// Partner companies (spec: the company admin registers the outside companies its people come from).
export const useAddCompany = () => useAction<CompanyInput & { relation: PartnerRelation }>("addCompany");
export const useUpdateCompany = () => useAction<CompanyInput & { companyId: string }>("updateCompany");
export const useRemoveCompany = () => useAction<{ companyId: string }>("removeCompany");
