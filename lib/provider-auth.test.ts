import { describe, expect, it } from "vitest";
import {
  AUTH_BOOTSTRAP_ERROR_MESSAGE,
  decideAuthBootstrap,
} from "@/lib/provider-auth";

describe("provider auth bootstrap", () => {
  it("opens the anonymous device workspace and preserves cloud error status on failure", () => {
    expect(decideAuthBootstrap(null, new Error("network unavailable"))).toEqual({
      action: "open-local-fallback",
      session: null,
      authResolved: true,
      syncStatus: "error",
      message: AUTH_BOOTSTRAP_ERROR_MESSAGE,
    });
  });

  it("applies a successful session or explicit signed-out result", () => {
    const session = { user: { id: "user-a" } };
    expect(decideAuthBootstrap(session, null)).toEqual({
      action: "apply-session",
      session,
    });
    expect(decideAuthBootstrap(null, null)).toEqual({
      action: "apply-session",
      session: null,
    });
  });
});
