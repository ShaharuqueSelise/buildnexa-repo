import { blocksClient } from "./client";
import { blocksConfig } from "./config";
import { isJwtExpired } from "./jwt";

// IAM's hosted IdP flow sets the session as a Secure, httpOnly cookie by
// default -- this app never sees that token and must not try to. Bearer
// tokens below are only populated when a tenant's OIDC config explicitly
// opts into returning tokens in the response body instead of a cookie; in
// the default cookie flow every function below simply no-ops around them.
const TOKEN_KEY = "blocks-app:access-token";
const REFRESH_TOKEN_KEY = "blocks-app:refresh-token";
const RETURN_KEY = "blocks-app:oidc-return-to";

export type CallbackResult = { ok: true; returnTo: string } | { ok: false; message: string };

let cachedAccessToken: string | undefined;
let cachedRefreshToken: string | undefined;
let refreshInFlight: Promise<string | undefined> | undefined;

// AuthProvider subscribes to this to learn the session died out-of-band (a
// refresh came back invalid_grant) so it can flip status to unauthenticated
// and let RequireAuth redirect to /login -- this module has no router access
// of its own to do that navigation directly.
const sessionExpiredListeners = new Set<() => void>();

export function onSessionExpired(listener: () => void): () => void {
  sessionExpiredListeners.add(listener);
  return () => sessionExpiredListeners.delete(listener);
}

function notifySessionExpired(): void {
  for (const listener of sessionExpiredListeners) listener();
}

function getAccessToken(): string | undefined {
  if (cachedAccessToken && !isJwtExpired(cachedAccessToken)) return cachedAccessToken;

  const stored = sessionStorage.getItem(TOKEN_KEY);
  if (stored && !isJwtExpired(stored)) {
    cachedAccessToken = stored;
    return stored;
  }

  return undefined;
}

// Never written to storage by this app, deliberately: a refresh token is
// long-lived, and anything readable from JS is readable by an XSS payload.
// The access token is short-lived, so that one is persisted to keep a
// reload from bouncing the user, and IAM's httpOnly session cookie
// re-establishes the session once it expires.
//
// The stored value is still *read* as a fallback, for a host that can
// re-establish a session but cannot reach this module's variables -- a
// build running inside blocks-studio's preview is the case that matters:
// the session lives in an httpOnly cookie the page cannot see, and there
// is no reload-surviving cookie flow to fall back on, so the host seeds a
// non-secret marker here to say "ask for a refresh". Reading it is safe
// precisely because this app never puts a real token there.
function getRefreshToken(): string | undefined {
  if (cachedRefreshToken) return cachedRefreshToken;

  const seeded = sessionStorage.getItem(REFRESH_TOKEN_KEY);
  return seeded ?? undefined;
}

function persistTokens(accessToken: string, refreshToken?: string): void {
  cachedAccessToken = accessToken;
  sessionStorage.setItem(TOKEN_KEY, accessToken);

  if (refreshToken) cachedRefreshToken = refreshToken;
}

function clearLocalTokens(): void {
  cachedAccessToken = undefined;
  cachedRefreshToken = undefined;
  sessionStorage.removeItem(TOKEN_KEY);
  // This app never writes that key, but a host may have seeded it (see
  // getRefreshToken) and an earlier build of this app may have persisted a
  // real token there -- either way it must not survive a sign-out.
  sessionStorage.removeItem(REFRESH_TOKEN_KEY);
}

// Passed to createBlocksClient as the `accessToken` resolver: returns the
// cached token when it's still fresh, otherwise refreshes it through
// blocksClient.auth.oidc.refreshToken() -- concurrent callers share one
// in-flight refresh instead of racing duplicate requests. Resolves to
// undefined in the default cookie flow (nothing cached, nothing to
// refresh); the SDK still sends the session cookie on every request, so
// protected calls keep working without an Authorization header.
export async function getValidAccessToken(): Promise<string | undefined> {
  const current = getAccessToken();
  if (current) return current;
  // Cookie session: nothing to send, and no renewal before every call (keepSessionAlive renews on
  // a timer, a 401 renews through onUnauthorized).
  if (!getRefreshToken()) return undefined;
  return forceRefreshAccessToken();
}

// Passed to createBlocksClient as `onUnauthorized`: unlike getValidAccessToken,
// this skips the "is the cached token still fresh" check and always goes
// straight to refreshAccessToken() -- a 401 means the server already
// disagreed with our local judgment of freshness, so re-checking it would
// just resend the same rejected token. Still funnels through the same
// refreshInFlight guard, so a burst of concurrent 401s (and any proactive
// caller racing them) share one refresh call instead of firing one each.
export async function forceRefreshAccessToken(): Promise<string | undefined> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    // Cookie session (no token in this page): renew the cookie so the next calls work. The SDK
    // retries only with a token, so the call that got the 401 is not repeated; queries retry.
    await renewCookieSession();
    return undefined;
  }

  if (!refreshInFlight) {
    refreshInFlight = refreshAccessToken(refreshToken).finally(() => {
      refreshInFlight = undefined;
    });
  }

  return refreshInFlight;
}

async function refreshAccessToken(refreshToken: string): Promise<string | undefined> {
  let response: Awaited<ReturnType<typeof blocksClient.auth.oidc.refreshToken>>;
  try {
    response = await blocksClient.auth.oidc.refreshToken({ refreshToken });
  } catch {
    // A network/transport failure here says nothing about whether the
    // refresh token itself is still valid -- keep it cached so the next
    // attempt can still use it, instead of forcing a fresh sign-in over a
    // transient blip (e.g. the dev server restarting mid-session).
    return undefined;
  }

  const accessToken = response.access_token ?? response.accessToken;
  if (!accessToken) {
    // IAM answered but explicitly rejected the grant (e.g. invalid_grant --
    // the refresh token expired or was already rotated away) -- now it
    // really is dead, so this is a full sign-out, not just a cache clear.
    // Clear local state before the logout call so its own accessToken
    // lookup finds nothing to refresh and doesn't loop back into us.
    clearLocalTokens();
    await blocksClient.auth.logout({ refreshToken }).catch(() => undefined);
    notifySessionExpired();
    return undefined;
  }

  // The identity provider may not rotate the refresh token on every call --
  // keep the previous one instead of overwriting a working token with undefined.
  const nextRefreshToken = response.refresh_token ?? response.refreshToken ?? refreshToken;
  persistTokens(accessToken, nextRefreshToken);
  return accessToken;
}

// ---------- Keeping a cookie session alive ----------
// Buildnexa's own sign-in screen uses IAM's password login, which answers with httpOnly cookies
// and no token in the body (checked on dev 22 Nov 2026). The access cookie lasts 15 minutes
// (auth config accessTokenValidForNumberMinutes); nothing renewed it, so everyone was sent to the
// sign-in page 15 minutes after signing in. `POST /iam/v4/auth/refresh` with an empty body reads
// the refresh cookie and sets a fresh access cookie (`cookie_set: true`, `expires_utc`), until the
// refresh cookie ends (`refresh_expires_utc`: 5 hours after sign-in, absoluteRefreshTokenValid...).
// No token ever reaches this page. Renewal runs ~2 minutes before each expiry while the tab is
// open, when the tab comes back into view, and once when a session check fails (a reload or a
// laptop waking up after the access cookie ran out).
const RENEW_BEFORE_MS = 2 * 60_000;
let cookieExpiresAt = 0;
let renewInFlight: Promise<boolean> | undefined;
// After "Sign out", nothing may renew the session back to life (until the next sign-in).
let signedOutOnPurpose = false;
let renewTimer: number | undefined;

/** Renews the cookie session; true when IAM set a fresh access cookie. Concurrent callers share one call. */
export function renewCookieSession(): Promise<boolean> {
  if (signedOutOnPurpose) return Promise.resolve(false);
  if (!renewInFlight) {
    renewInFlight = (async () => {
      try {
        const r = (await blocksClient.auth.refresh({})) as Record<string, unknown>;
        const expires = Date.parse(String(r?.expires_utc ?? ""));
        const seconds = Number(r?.expires_in);
        cookieExpiresAt = Number.isFinite(expires) ? expires : Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : Date.now() + 10 * 60_000;
        return r?.cookie_set !== false;
      } catch {
        return false;
      }
    })().finally(() => {
      renewInFlight = undefined;
    });
  }
  return renewInFlight;
}

function scheduleRenewal(): void {
  if (renewTimer !== undefined) window.clearTimeout(renewTimer);
  const wait = Math.max(30_000, (cookieExpiresAt || Date.now()) - Date.now() - RENEW_BEFORE_MS);
  renewTimer = window.setTimeout(async () => {
    renewTimer = undefined;
    if (await renewCookieSession()) scheduleRenewal();
    else notifySessionExpired();
  }, wait);
}

/** Starts renewing the session (call when signed in); renews now if the cookie is near its end. */
export async function keepSessionAlive(): Promise<void> {
  if (!cookieExpiresAt || cookieExpiresAt - Date.now() < RENEW_BEFORE_MS) await renewCookieSession();
  scheduleRenewal();
}

export function stopKeepingSessionAlive(): void {
  if (renewTimer !== undefined) window.clearTimeout(renewTimer);
  renewTimer = undefined;
  cookieExpiresAt = 0;
}

// The session's source of truth is IAM, not a token this app can inspect --
// `GET /iam/v4/auth/me` (blocksClient.auth.userInfo()) validates the
// httpOnly session cookie (or bearer token, if one is cached) and returns
// its claims in one round trip. `iam.me()` is a different, heavier call --
// the full IAM user profile with roles/permissions -- and is used
// separately on the Profile page; it is not a substitute for this check.
// When it fails, the access cookie may only have run out: renew once and ask again.
export async function fetchSessionClaims(): Promise<Record<string, unknown> | undefined> {
  try {
    return await blocksClient.auth.userInfo();
  } catch {
    if (!(await renewCookieSession())) return undefined;
    try {
      return await blocksClient.auth.userInfo();
    } catch {
      return undefined;
    }
  }
}

export async function startLogin(returnTo?: string): Promise<void> {
  if (!blocksConfig.oidcClientId) {
    throw new Error("Login is not configured. Set VITE_BLOCKS_OIDC_CLIENT_ID in .env.");
  }

  sessionStorage.setItem(RETURN_KEY, returnTo || "/");
  await blocksClient.auth.idp.redirectToProvider();
}

export async function completeLogin(callbackUrl: string): Promise<CallbackResult> {
  const returnTo = sessionStorage.getItem(RETURN_KEY) || "/";

  sessionStorage.removeItem(RETURN_KEY);

  const data = await blocksClient.auth.idp.callback(callbackUrl);

  if (data.error) {
    return { message: data.error_description || data.error, ok: false };
  }

  // In the default cookie flow IAM sets the session via Set-Cookie on this
  // same response and returns no token in the body -- that's success, not
  // a failure. Only cache a token here if a non-default OIDC config made
  // IAM return one.
  const accessToken = data.access_token ?? data.accessToken;
  if (accessToken) persistTokens(accessToken, data.refresh_token ?? data.refreshToken);
  signedOutOnPurpose = false;

  return { ok: true, returnTo };
}

// ---------- App-owned sign-in (Buildnexa's own login screen) ----------
// IAM's embedded password login (`POST /iam/v4/auth/login`, enabled for this tenant:
// login-options says signIn.embedded.password = true). The response either carries tokens in
// the body or sets the session cookie; both are handled, exactly as completeLogin does.

export type SignInResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "mfa" | "locked" | "tooMany" | "network" | "other"; message: string };

function errorBody(error: unknown): Record<string, unknown> | undefined {
  const body = (error as { body?: unknown })?.body;
  return body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
}

function signInFailure(body: Record<string, unknown> | undefined, fallback: string): SignInResult {
  const code = String(body?.error ?? "");
  const message = String(body?.error_description ?? body?.message ?? fallback);
  if (code === "invalid_username_password") return { ok: false, reason: "invalid", message };
  // IAM locks a username for 5 minutes after 5 failed attempts (blocks auth config).
  if (/temporarily locked|failed authentication attempts/i.test(message)) return { ok: false, reason: "tooMany", message };
  if (/lock|disabled|inactive|not_active|verification/i.test(code + message)) return { ok: false, reason: "locked", message };
  return { ok: false, reason: "other", message };
}

export async function signInWithPassword(email: string, password: string): Promise<SignInResult> {
  let data: Record<string, unknown>;
  try {
    data = (await blocksClient.auth.login({ username: email.trim(), password })) as Record<string, unknown>;
  } catch (error) {
    const body = errorBody(error);
    if (!body && !(error as { status?: number })?.status) return { ok: false, reason: "network", message: (error as Error).message };
    return signInFailure(body, (error as Error).message);
  }

  if (data.error) return signInFailure(data, "Sign-in failed");
  // A second factor is not part of the MVP; say so instead of failing silently.
  if (data.enable_mfa || data.enableMfa || data.mfaId || data.mfa_id) {
    return { ok: false, reason: "mfa", message: "This account needs a second sign-in step, which Buildnexa does not support yet." };
  }

  const accessToken = (data.access_token ?? data.accessToken) as string | undefined;
  if (accessToken) persistTokens(accessToken, (data.refresh_token ?? data.refreshToken) as string | undefined);
  signedOutOnPurpose = false;
  return { ok: true };
}

// Forgot password: IAM emails a reset link. The answer is the same whether or not the address
// has an account, so the screen never reveals which emails exist.
export async function requestPasswordReset(email: string): Promise<{ ok: boolean; message?: string }> {
  try {
    await blocksClient.auth.recover({ email: email.trim() });
    return { ok: true };
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (status && status < 500) return { ok: true };
    return { ok: false, message: (error as Error).message };
  }
}

// ---------- Emailed links: accept an invitation, reset a password ----------
// Contracts probed on dev (19 Nov 2026): validate-activation takes `activationCode` and answers
// { status, firstName, lastName, errors }; activate and reset-password take `code` + `password`
// and answer { isSuccess, errors: { Field: "message" } }. All three are public.

export type CodeCheck = { ok: true; firstName?: string; lastName?: string } | { ok: false; message: string };
export type CodeSubmit = { ok: true } | { ok: false; message: string };

function firstError(body: Record<string, unknown> | undefined, fallback: string): string {
  const errors = body?.errors;
  if (errors && typeof errors === "object") {
    const first = Object.values(errors as Record<string, unknown>).find((v) => typeof v === "string" && v);
    if (typeof first === "string") return first;
  }
  return String(body?.error_description ?? body?.message ?? fallback);
}

async function submitCode(call: () => Promise<unknown>, fallback: string): Promise<CodeSubmit> {
  try {
    const body = (await call()) as Record<string, unknown>;
    if (body?.isSuccess === false) return { ok: false, message: firstError(body, fallback) };
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstError(errorBody(error), (error as Error).message || fallback) };
  }
}

export async function checkActivationCode(code: string): Promise<CodeCheck> {
  try {
    const body = (await blocksClient.auth.validateActivation({ activationCode: code })) as Record<string, unknown>;
    if (body?.isSuccess === false || body?.status === "Invalid") return { ok: false, message: firstError(body, "Invalid_ActivationCode") };
    return { ok: true, firstName: (body?.firstName as string) || undefined, lastName: (body?.lastName as string) || undefined };
  } catch (error) {
    return { ok: false, message: firstError(errorBody(error), (error as Error).message) };
  }
}

export function activateAccount(code: string, password: string, firstName?: string, lastName?: string): Promise<CodeSubmit> {
  return submitCode(() => blocksClient.auth.activate({ code, password, firstName, lastName }), "Activation failed");
}

export function resetPassword(code: string, password: string): Promise<CodeSubmit> {
  return submitCode(() => blocksClient.auth.resetPassword({ code, password }), "Password reset failed");
}

export async function logout(): Promise<void> {
  // Ask IAM to end the session (clears the httpOnly cookie server-side)
  // before dropping any locally cached bearer token; best-effort so a
  // network failure never blocks the user from leaving a protected page.
  signedOutOnPurpose = true;
  stopKeepingSessionAlive();
  await blocksClient.auth.logout({ refreshToken: getRefreshToken() }).catch(() => undefined);
  clearLocalTokens();
}
