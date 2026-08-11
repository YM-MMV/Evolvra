import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BlockingRecoveryScreen } from "@/components/blocking-recovery-screen";

describe("BlockingRecoveryScreen semantics", () => {
  it("gives a mandatory recovery alert an accessible name and description", () => {
    const html = renderToStaticMarkup(
      <BlockingRecoveryScreen
        layer="terminal"
        mode="alert"
        title="Recovery must finish"
        description={<p>The private workspace remains fenced.</p>}
        icon={<span>!</span>}
      >
        <button>Retry safely</button>
      </BlockingRecoveryScreen>,
    );

    const labelledBy = html.match(/aria-labelledby="([^"]+)"/)?.[1];
    const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1];

    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('data-recovery-layer="terminal"');
    expect(html).toMatch(/z-index:1200/);
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`<h1 id="${labelledBy}"`);
    expect(html).toContain(`<div id="${describedBy}"><p>The private workspace remains fenced.</p></div>`);
    expect(html).toContain("Recovery must finish");
  });

  it("announces a non-interactive recovery operation without claiming modality", () => {
    const html = renderToStaticMarkup(
      <BlockingRecoveryScreen
        layer="bootstrap"
        mode="status"
        title="Checking recovery state"
        description={<p>Verifying durable deletion fences.</p>}
        icon={<span>!</span>}
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("aria-modal");
  });
});
