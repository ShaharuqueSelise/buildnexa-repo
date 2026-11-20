import { Building2, FlaskConical, LayoutGrid, UserRound, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { TranslationKey } from "../../lib/i18n/dictionary";

// `roles`: shown only to people holding one of these roles.

type NavItem = { href: string; labelKey: TranslationKey; icon: LucideIcon; roles?: readonly string[] };

export const navItems: readonly NavItem[] = [
  { href: "/directory", labelKey: "nav.directory", icon: Users },
  { href: "/projects", labelKey: "nav.projects", icon: LayoutGrid },
  { href: "/company", labelKey: "nav.company", icon: Building2, roles: ["company-admin"] },
  { href: "/", labelKey: "nav.profile", icon: UserRound },
  { href: "/spike", labelKey: "nav.spike", icon: FlaskConical }
];
