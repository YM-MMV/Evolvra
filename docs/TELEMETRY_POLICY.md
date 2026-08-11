# Telemetry operating policy

Evolvra telemetry is disabled by default and is disabled in the current
production environment. This file defines the minimum operating controls that
must exist before anyone enables `NEXT_PUBLIC_EVOLVRA_TELEMETRY_ENABLED=true`.

## Data boundary

Only the allow-listed payloads in `lib/telemetry.ts` are permitted:

- Web Vital name, numeric value, and rating.
- Client error class name and an optional opaque framework digest.

URLs, route paths, account identifiers, email addresses, IP-derived
identifiers, free text, stack traces, error messages, goal data, evidence
metadata, and workspace values must never be added. The API accepts at most
2 KiB, requires same-origin provenance, uses `Cache-Control: no-store`, and
sanitises the payload again on the server.

## Controls required before enablement

The deployment owner must record all of the following in the release record:

1. An infrastructure-wide request limit in front of the application. The
   in-process limiter is defence in depth and is not a fleet-wide limit.
2. A hosting-log retention limit of no more than 14 days for telemetry entries,
   with deletion verified after the first retention window.
3. Access limited to the deployment/rollback owner and named incident
   responders.
4. Alerts based only on aggregate error rates and Web Vital distributions.
5. A tested emergency disable procedure: remove or set the public telemetry
   flag to `false`, deploy, and confirm the endpoint returns 204 without
   parsing or logging the body.
6. A privacy review of the hosting provider's unavoidable request metadata.
   Application code must not copy that metadata into telemetry logs.

If any control is absent, telemetry stays off.

## Sampling and response

- Client errors may be sent once per captured failure.
- Web Vitals use the bounded sampling rate in `lib/telemetry.ts`.
- The service must not use telemetry to build user profiles, compare people,
  score activity, or infer personal qualities.
- A sudden sustained error increase should trigger a read-only synthetic and
  deployment inspection before any workspace mutation is attempted.

## Deletion and audit

The deployment owner performs a quarterly audit while telemetry is enabled:

- confirm the payload allow-list has not expanded;
- sample redacted log records for forbidden fields;
- confirm entries older than 14 days are absent;
- exercise the emergency disable procedure in Preview;
- record the result and owner in the release log.

Telemetry data is operational and disposable. It is never a workspace backup
or a source of product analytics.
