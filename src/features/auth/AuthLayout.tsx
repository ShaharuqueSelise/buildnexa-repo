import { Building2, ClipboardCheck, Eye, EyeOff, FileStack, Layers, MessagesSquare } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { useT } from "../../lib/i18n/LocalizationProvider";

// Shared frame of the signed-out screens (sign in, activate invitation, reset password):
// Buildnexa brand panel on the left (hidden on phones), the form on the right.
export function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = useT();
  return (
    <div className="login-screen">
      <section className="login-hero" aria-hidden="true">
        <div className="login-hero-brand">
          <span className="login-logo"><Building2 size={20} /></span>
          <span>{t("app.name")}</span>
        </div>
        <div className="login-hero-copy">
          <h1>{t("app.tagline")}</h1>
          <p>{t("auth.heroText")}</p>
          <ul>
            <li><Layers size={18} /> {t("auth.heroDrawings")}</li>
            <li><MessagesSquare size={18} /> {t("auth.heroRfis")}</li>
            <li><ClipboardCheck size={18} /> {t("auth.heroPunch")}</li>
            <li><FileStack size={18} /> {t("auth.heroDocs")}</li>
          </ul>
        </div>
        <p className="login-hero-foot">© {new Date().getFullYear()} {t("app.name")}</p>
      </section>

      <main className="login-panel">
        <div className="login-form-wrap">
          <div className="login-mobile-brand">
            <span className="login-logo"><Building2 size={18} /></span>
            <span>{t("app.name")}</span>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

// Password input with a show/hide toggle.
export function PasswordInput({
  autoComplete,
  autoFocus,
  onChange,
  value
}: {
  autoComplete: "current-password" | "new-password";
  autoFocus?: boolean;
  onChange: (value: string) => void;
  value: string;
}) {
  const { t } = useT();
  const [visible, setVisible] = useState(false);
  return (
    <span className="login-password">
      <input autoComplete={autoComplete} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} type={visible ? "text" : "password"} value={value} />
      <button
        aria-label={visible ? t("auth.hidePassword") : t("auth.showPassword")}
        className="login-eye"
        onClick={() => setVisible((v) => !v)}
        type="button"
      >
        {visible ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </span>
  );
}

// The code from an emailed link (?code=...), as IAM's own pages read it.
export function codeFromUrl(): string {
  return new URLSearchParams(window.location.search).get("code")?.trim() ?? "";
}

// IAM password policy on dev: 8-64 characters, no character-class rules
// (blocks auth config). IAM checks it again on submit and its message is shown.
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 64;
