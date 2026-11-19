import { FlaskConical, UserRound } from "lucide-react";

export const navItems = [
  { href: "/", labelKey: "nav.profile", icon: UserRound },
  { href: "/spike", labelKey: "nav.spike", icon: FlaskConical }
] as const;
