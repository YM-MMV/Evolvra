import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PROVIDER_LIFECYCLE_SCENARIOS,
  ProviderLifecycleHarness,
  ProviderLifecycleStatus,
} from "@/components/provider-lifecycle-status";

describe("ProviderLifecycleStatus", () => {
  it.each(PROVIDER_LIFECYCLE_SCENARIOS)(
    "renders the $id lifecycle state without application UI",
    (scenario) => {
      const html = renderToStaticMarkup(
        <ProviderLifecycleStatus {...scenario} />,
      );
      expect(html).toContain('role="status"');
      expect(html).toContain(scenario.expectedLabel);
    },
  );

  it("keeps the exhaustive harness aligned with every declared scenario", () => {
    const html = renderToStaticMarkup(<ProviderLifecycleHarness />);
    for (const scenario of PROVIDER_LIFECYCLE_SCENARIOS) {
      expect(html).toContain(`data-scenario="${scenario.id}"`);
      expect(html).toContain(scenario.expectedLabel);
    }
  });
});
