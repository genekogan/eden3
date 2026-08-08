import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = (path: string) => readFileSync(resolve(WEB_ROOT, path), "utf8");

describe("closed-cohort moderation reachability", () => {
  it("wires public creation reporting through the typed API", () => {
    const page = source("app/creations/[id]/page.tsx");
    const reportControl = source("components/creations/report-creation.tsx");
    const api = source("lib/api.ts");

    expect(page).toContain("creation.reportable === true ? <ReportCreation creationId={creation.id} /> : null");
    expect(reportControl).toContain("Report this creation");
    expect(reportControl).toContain("api.creations.report(creationId");
    expect(reportControl).toContain("Sign in to report this creation.");
    expect(api).toContain("/creations/${enc(id)}/report");
  });

  it("keeps the content queue on the operator surface with explicit decisions", () => {
    const operator = source("app/operator/operator-client.tsx");
    const panel = source("components/operator/content-reports-panel.tsx");
    const api = source("lib/api.ts");

    expect(operator).toContain("<ContentReportsPanel />");
    expect(panel).toContain('api.operator.contentReports({ status: "open"');
    expect(panel).toContain('report.targetType === "creation"');
    expect(panel).toContain("report.targetExists");
    expect(panel).toContain("report.targetPublic === true");
    expect(panel).toContain("report.targetDeleted === false");
    expect(api).toContain("/operator/content-reports/${enc(id)}/resolve");
  });

  it("retains the existing admin-only skill review queue", () => {
    const skills = source("app/skills/skills-client.tsx");
    const api = source("lib/api.ts");

    expect(skills).toContain('const canReview = isAdmin && skill.status === "pending"');
    expect(skills).toContain("api.skills.review");
    expect(api).toContain("/skills/${enc(slug)}/review");
  });

  it("keeps primary phone moderation actions at the 44px target floor", () => {
    for (const path of [
      "components/creations/report-creation.tsx",
      "components/operator/content-reports-panel.tsx",
    ]) {
      expect(source(path)).toContain("min-h-11");
    }
  });
});
