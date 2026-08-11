export type ProviderCloudSaveSupersededReason =
  | "account"
  | "scope"
  | "write-gate";

export type ProviderCloudSaveCurrentness =
  | { readonly current: true }
  | {
    readonly current: false;
    readonly reason: ProviderCloudSaveSupersededReason;
  };

export interface ProviderCloudSaveBoundary<TScopeKey> {
  readonly accountId: string;
  readonly workspaceGeneration: TScopeKey;
  readonly workspaceScopeKey: TScopeKey;
}

export interface ProviderCloudSaveRequest<TSnapshot, TScopeKey> {
  readonly boundary: ProviderCloudSaveBoundary<TScopeKey>;
  readonly snapshot: TSnapshot;
  readonly expectedRevision: number;
  readonly changeVersion: number;
}

export interface ProviderCloudSaveTransportResponse {
  readonly data: unknown;
  readonly error: unknown;
}

/**
 * Browser, React, and Supabase details remain outside this boundary. The save
 * port owns the transport deadline; currentness is checked both before the
 * request and after its settlement so a late response cannot cross an account
 * or workspace-scope transition.
 */
export interface ProviderCloudSavePorts<TSnapshot, TScopeKey> {
  readonly saveSnapshot: (
    snapshot: TSnapshot,
    expectedRevision: number,
  ) => PromiseLike<ProviderCloudSaveTransportResponse>;
  readonly inspectCurrentness: (
    boundary: ProviderCloudSaveBoundary<TScopeKey>,
  ) => ProviderCloudSaveCurrentness;
  readonly readChangeVersion: () => number;
  readonly parseRevision: (value: unknown) => number | null;
  readonly isRevisionConflict: (error: unknown) => boolean;
}

export type ProviderCloudSaveOutcome =
  | {
    readonly kind: "saved";
    readonly revision: number;
    readonly updatedAt: string;
    readonly localUnchanged: boolean;
  }
  | {
    readonly kind: "superseded";
    readonly phase: "preflight" | "settlement";
    readonly reason: ProviderCloudSaveSupersededReason;
  }
  | {
    readonly kind: "revision-conflict";
    readonly error: unknown;
  }
  | {
    readonly kind: "error";
    readonly error: unknown;
  }
  | {
    readonly kind: "malformed-response";
    readonly data: unknown;
  }
  | {
    /**
     * A rejected or interrupted request is intentionally ambiguous: the
     * compare-and-swap may have committed before its response was lost.
     */
    readonly kind: "ambiguous";
    readonly error: unknown;
  };

/**
 * Coordinates one cloud compare-and-swap attempt without adopting any state.
 * The caller applies the typed outcome only within its own lifecycle boundary.
 */
export async function runProviderCloudSave<TSnapshot, TScopeKey>(
  request: ProviderCloudSaveRequest<TSnapshot, TScopeKey>,
  ports: ProviderCloudSavePorts<TSnapshot, TScopeKey>,
): Promise<ProviderCloudSaveOutcome> {
  const beforeRequest = ports.inspectCurrentness(request.boundary);
  if (!beforeRequest.current) {
    return {
      kind: "superseded",
      phase: "preflight",
      reason: beforeRequest.reason,
    };
  }

  try {
    const response = await ports.saveSnapshot(
      request.snapshot,
      request.expectedRevision,
    );
    const afterSettlement = ports.inspectCurrentness(request.boundary);
    if (!afterSettlement.current) {
      return {
        kind: "superseded",
        phase: "settlement",
        reason: afterSettlement.reason,
      };
    }

    if (response.error) {
      return ports.isRevisionConflict(response.error)
        ? { kind: "revision-conflict", error: response.error }
        : { kind: "error", error: response.error };
    }

    const row = Array.isArray(response.data)
      ? response.data[0]
      : response.data;
    const responseRow = row as {
      readonly revision?: unknown;
      readonly updated_at?: unknown;
    } | null | undefined;
    const revision = ports.parseRevision(responseRow?.revision);
    if (
      !row
      || revision === null
      || typeof responseRow?.updated_at !== "string"
    ) {
      return { kind: "malformed-response", data: response.data };
    }

    return {
      kind: "saved",
      revision,
      updatedAt: responseRow.updated_at,
      localUnchanged: ports.readChangeVersion() === request.changeVersion,
    };
  } catch (error) {
    const afterSettlement = ports.inspectCurrentness(request.boundary);
    if (!afterSettlement.current) {
      return {
        kind: "superseded",
        phase: "settlement",
        reason: afterSettlement.reason,
      };
    }
    return { kind: "ambiguous", error };
  }
}
