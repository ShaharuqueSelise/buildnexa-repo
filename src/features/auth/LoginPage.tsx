import { ArrowLeft, Loader2, LogIn, Mail } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { useAuth } from "../../app/providers/AuthProvider";
import { requestPasswordReset } from "../../lib/blocks/auth";
import { useT } from "../../lib/i18n/LocalizationProvider";
import { Alert } from "../../shared/ui/Alert";
import { AuthLayout, PasswordInput } from "./AuthLayout";

type View = "signin" | "forgot" | "sent";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Buildnexa's own sign-in screen. Email + password go straight to Blocks IAM
// (embedded password login); there is no redirect to the hosted Blocks IAM page.
// `notice` is a one-line confirmation from the activate/reset pages ("you can sign in now").
export function LoginPage({ notice }: { notice?: string }) {
  const { signIn } = useAuth();
  const { t } = useT();
  const [view, setView] = useState<View>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submitSignIn(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    if (!EMAIL.test(email.trim())) return setError(t("auth.errorEmail"));
    if (!password) return setError(t("auth.errorPassword"));
    setPending(true);
    const result = await signIn(email, password);
    // On success the session is "authenticated" and RedirectIfAuthenticated takes the user to returnTo.
    if (result.ok) return;
    setPending(false);
    setPassword("");
    if (result.reason === "invalid") setError(t("auth.errorInvalid"));
    else if (result.reason === "tooMany") setError(t("auth.errorTooMany"));
    else if (result.reason === "network") setError(t("auth.errorNetwork"));
    else if (result.reason === "locked") setError(`${t("auth.errorLocked")} (${result.message})`);
    else setError(result.message);
  }

  async function submitForgot(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    if (!EMAIL.test(email.trim())) return setError(t("auth.errorEmail"));
    setPending(true);
    const result = await requestPasswordReset(email);
    setPending(false);
    if (result.ok) setView("sent");
    else setError(t("auth.errorNetwork"));
  }

  function go(next: View) {
    setError(undefined);
    setPending(false);
    setView(next);
  }

  return (
    <AuthLayout>
      {view === "signin" ? (
        <form className="login-form" onSubmit={submitSignIn} noValidate>
          <header>
            <h2>{t("auth.welcome")}</h2>
            <p>{t("auth.subtitle")}</p>
          </header>
          {notice && !error ? <Alert tone="info">{notice}</Alert> : null}
          {error ? <Alert tone="error">{error}</Alert> : null}
          <label className="login-field">
            <span>{t("auth.email")}</span>
            <input
              autoComplete="username"
              autoFocus
              inputMode="email"
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
              type="email"
              value={email}
            />
          </label>
          <label className="login-field">
            <span className="login-field-row">
              {t("auth.password")}
              <button className="login-link" onClick={() => go("forgot")} type="button">{t("auth.forgot")}</button>
            </span>
            <PasswordInput autoComplete="current-password" onChange={setPassword} value={password} />
          </label>
          <button className="primary-button auth-submit login-submit" disabled={pending} type="submit">
            {pending ? <Loader2 className="spin" size={18} /> : <LogIn size={18} />}
            {pending ? t("auth.signingIn") : t("auth.signIn")}
          </button>
          <p className="login-note">{t("auth.inviteOnly")}</p>
        </form>
      ) : null}

      {view === "forgot" ? (
        <form className="login-form" onSubmit={submitForgot} noValidate>
          <header>
            <h2>{t("auth.forgotTitle")}</h2>
            <p>{t("auth.forgotText")}</p>
          </header>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <label className="login-field">
            <span>{t("auth.email")}</span>
            <input autoComplete="username" autoFocus inputMode="email" onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" type="email" value={email} />
          </label>
          <button className="primary-button auth-submit login-submit" disabled={pending} type="submit">
            {pending ? <Loader2 className="spin" size={18} /> : <Mail size={18} />}
            {t("auth.sendLink")}
          </button>
          <button className="login-link login-back" onClick={() => go("signin")} type="button"><ArrowLeft size={16} /> {t("auth.back")}</button>
        </form>
      ) : null}

      {view === "sent" ? (
        <div className="login-form">
          <span className="login-sent-icon"><Mail size={22} /></span>
          <header>
            <h2>{t("auth.sentTitle")}</h2>
            <p>{t("auth.sentText").replace("{email}", email.trim())}</p>
          </header>
          <button className="primary-button auth-submit login-submit" onClick={() => go("signin")} type="button"><ArrowLeft size={18} /> {t("auth.back")}</button>
        </div>
      ) : null}
    </AuthLayout>
  );
}
