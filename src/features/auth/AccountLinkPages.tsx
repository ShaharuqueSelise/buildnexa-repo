import { AlertTriangle, ArrowLeft, Check, KeyRound, Loader2, UserCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { activateAccount, checkActivationCode, resetPassword } from "../../lib/blocks/auth";
import { useT } from "../../lib/i18n/LocalizationProvider";
import { Alert } from "../../shared/ui/Alert";
import { AuthLayout, PASSWORD_MAX, PASSWORD_MIN, PasswordInput, codeFromUrl } from "./AuthLayout";

type Navigate = (path: string) => void;

// Messages IAM returns for a dead link (probed on dev); shown as our own text.
function isExpired(message: string): boolean {
  return /expired|invalid|not.?found|Invalid_ActivationCode|ActivationCode_Required/i.test(message);
}

function usePasswordPair() {
  const { t } = useT();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  function problem(): string | undefined {
    if (password.length < PASSWORD_MIN) return t("auth.errorPasswordShort").replace("{min}", String(PASSWORD_MIN));
    if (password.length > PASSWORD_MAX) return t("auth.errorPasswordLong").replace("{max}", String(PASSWORD_MAX));
    if (password !== confirm) return t("auth.errorPasswordMatch");
    return undefined;
  }
  return { confirm, password, problem, setConfirm, setPassword };
}

function DeadLink({ title, text, onNavigate }: { title: string; text: string; onNavigate: Navigate }) {
  const { t } = useT();
  return (
    <div className="login-form">
      <span className="login-sent-icon login-icon-warn"><AlertTriangle size={22} /></span>
      <header>
        <h2>{title}</h2>
        <p>{text}</p>
      </header>
      <button className="primary-button auth-submit login-submit" onClick={() => onNavigate("/login")} type="button">
        <ArrowLeft size={18} /> {t("auth.back")}
      </button>
    </div>
  );
}

// Invitation email link: <accountActionBaseUrl>/oidc/activate/<tenant>?code=...
export function ActivatePage({ onNavigate }: { onNavigate: Navigate }) {
  const { t } = useT();
  const code = useRef(codeFromUrl()).current;
  const [state, setState] = useState<"checking" | "dead" | "form">(code ? "checking" : "dead");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const pair = usePasswordPair();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!code) return;
    let live = true;
    void checkActivationCode(code).then((result) => {
      if (!live) return;
      if (!result.ok) return setState("dead");
      setFirstName(result.firstName ?? "");
      setLastName(result.lastName ?? "");
      setState("form");
    });
    return () => {
      live = false;
    };
  }, [code]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    if (!firstName.trim() || !lastName.trim()) return setError(t("auth.errorName"));
    const problem = pair.problem();
    if (problem) return setError(problem);
    setPending(true);
    const result = await activateAccount(code, pair.password, firstName.trim(), lastName.trim());
    if (result.ok) return onNavigate("/login?notice=activated");
    setPending(false);
    if (isExpired(result.message)) return setState("dead");
    setError(result.message);
  }

  return (
    <AuthLayout>
      {state === "checking" ? (
        <div className="login-form login-checking"><Loader2 className="spin" size={22} /> {t("auth.checkingLink")}</div>
      ) : null}
      {state === "dead" ? <DeadLink onNavigate={onNavigate} text={t("auth.inviteDeadText")} title={t("auth.inviteDeadTitle")} /> : null}
      {state === "form" ? (
        <form className="login-form" onSubmit={submit} noValidate>
          <span className="login-sent-icon"><UserCheck size={22} /></span>
          <header>
            <h2>{t("auth.activateTitle")}</h2>
            <p>{t("auth.activateText")}</p>
          </header>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="login-row">
            <label className="login-field">
              <span>{t("auth.firstName")}</span>
              <input autoComplete="given-name" onChange={(e) => setFirstName(e.target.value)} value={firstName} />
            </label>
            <label className="login-field">
              <span>{t("auth.lastName")}</span>
              <input autoComplete="family-name" onChange={(e) => setLastName(e.target.value)} value={lastName} />
            </label>
          </div>
          <label className="login-field">
            <span>{t("auth.newPassword")}</span>
            <PasswordInput autoComplete="new-password" onChange={pair.setPassword} value={pair.password} />
            <small className="login-hint">{t("auth.passwordHint").replace("{min}", String(PASSWORD_MIN))}</small>
          </label>
          <label className="login-field">
            <span>{t("auth.confirmPassword")}</span>
            <PasswordInput autoComplete="new-password" onChange={pair.setConfirm} value={pair.confirm} />
          </label>
          <button className="primary-button auth-submit login-submit" disabled={pending} type="submit">
            {pending ? <Loader2 className="spin" size={18} /> : <Check size={18} />}
            {t("auth.activateButton")}
          </button>
        </form>
      ) : null}
    </AuthLayout>
  );
}

// Reset email link: <accountActionBaseUrl>/resetpassword?code=...
// IAM has no "check reset code" call, so a dead link shows up on submit.
export function ResetPasswordPage({ onNavigate }: { onNavigate: Navigate }) {
  const { t } = useT();
  const code = useRef(codeFromUrl()).current;
  const pair = usePasswordPair();
  const [dead, setDead] = useState(!code);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    const problem = pair.problem();
    if (problem) return setError(problem);
    setPending(true);
    const result = await resetPassword(code, pair.password);
    if (result.ok) return onNavigate("/login?notice=reset");
    setPending(false);
    if (isExpired(result.message)) return setDead(true);
    setError(result.message);
  }

  return (
    <AuthLayout>
      {dead ? (
        <DeadLink onNavigate={onNavigate} text={t("auth.resetDeadText")} title={t("auth.resetDeadTitle")} />
      ) : (
        <form className="login-form" onSubmit={submit} noValidate>
          <span className="login-sent-icon"><KeyRound size={22} /></span>
          <header>
            <h2>{t("auth.resetTitle")}</h2>
            <p>{t("auth.resetText")}</p>
          </header>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <label className="login-field">
            <span>{t("auth.newPassword")}</span>
            <PasswordInput autoComplete="new-password" autoFocus onChange={pair.setPassword} value={pair.password} />
            <small className="login-hint">{t("auth.passwordHint").replace("{min}", String(PASSWORD_MIN))}</small>
          </label>
          <label className="login-field">
            <span>{t("auth.confirmPassword")}</span>
            <PasswordInput autoComplete="new-password" onChange={pair.setConfirm} value={pair.confirm} />
          </label>
          <button className="primary-button auth-submit login-submit" disabled={pending} type="submit">
            {pending ? <Loader2 className="spin" size={18} /> : <Check size={18} />}
            {t("auth.resetButton")}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
