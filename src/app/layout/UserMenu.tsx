import { LogOut, UserRound } from "lucide-react";
import { useAuth } from "../providers/AuthProvider";
import { useCurrentUser, userDisplayName, userInitials } from "../../features/profile/useCurrentUser";
import { useT } from "../../lib/i18n/LocalizationProvider";
import { accountRoleLabels } from "../../lib/roles";
import { useProjects } from "../../features/projects/projectsApi";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "../../shared/ui/dropdown-menu";

export function UserMenu({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { logout } = useAuth();
  const { t } = useT();
  const me = useCurrentUser();
  const profile = me.data?.data;
  const name = userDisplayName(profile) || (me.isLoading ? "Loading..." : "Guest");
  const { myCompanyName } = useProjects();
  // "Company Admin · Demo Builder GmbH": plain words, never the hidden company tag.
  const access = [accountRoleLabels(profile?.roles, t).join(", "), myCompanyName].filter(Boolean).join(" · ");

  function handleLogout() {
    // Login page first, then sign out in the same click (React applies both together): no flash
    // of the app, and no "return to this page" link, which only makes sense when a session expires.
    onNavigate("/login");
    void logout();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="user-menu-trigger" aria-label="Open user menu">
        <span className="avatar avatar-sm">{userInitials(profile)}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[280px]">
        <DropdownMenuLabel className="flex items-center gap-3 font-normal">
          <span className="avatar avatar-lg">{userInitials(profile)}</span>
          <div className="grid gap-0.5 overflow-hidden">
            <strong className="truncate text-sm font-semibold">{name}</strong>
            {profile?.email ? <small className="truncate text-xs text-[hsl(var(--muted-foreground))]">{profile.email}</small> : null}
            {access ? <small className="truncate text-xs text-[hsl(var(--muted-foreground))]">{access}</small> : null}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onNavigate("/profile")}>
          <UserRound size={18} /> {t("nav.profile")}
        </DropdownMenuItem>
        <DropdownMenuItem destructive onSelect={handleLogout}>
          <LogOut size={18} /> {t("nav.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
