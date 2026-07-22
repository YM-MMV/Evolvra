export const AUTH_BOOTSTRAP_ERROR_MESSAGE =
  "The saved sign-in session could not be checked. Evolvra opened the private device workspace and paused cloud sync.";

export type AuthBootstrapDecision<TUser> =
  | { action: "apply-session"; session: { user: TUser } | null }
  | {
    action: "open-local-fallback";
    session: null;
    authResolved: true;
    syncStatus: "error";
    message: string;
  };

/** Every bootstrap outcome resolves auth; cloud failure never traps local use. */
export function decideAuthBootstrap<TUser>(
  session: { user: TUser } | null,
  error: unknown,
): AuthBootstrapDecision<TUser> {
  if (!error) return { action: "apply-session", session };
  return {
    action: "open-local-fallback",
    session: null,
    authResolved: true,
    syncStatus: "error",
    message: AUTH_BOOTSTRAP_ERROR_MESSAGE,
  };
}
