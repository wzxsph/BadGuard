import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("production automation contracts", () => {
  it("runs the full refresh after close and audits freshness every two hours", () => {
    const refresh = fs.readFileSync(".github/workflows/refresh-akshare.yml", "utf8");
    const audit = fs.readFileSync(".github/workflows/audit-akshare-quality.yml", "utf8");

    expect(refresh).toContain('cron: "15 8 * * 1-5"');
    expect(audit).toContain('cron: "17 */2 * * *"');
    expect(audit).toContain("--close-grace-minutes 45");
    expect(audit).toContain("--min-history-coverage 0.98");
    expect(audit).toContain("--min-close-coverage 0.98");
    expect(audit).toContain('"force_publish": "true"');
    expect(audit).toContain("Check for an active production refresh");
    expect(audit).toContain("SHOULD_DISPATCH=true");
  });

  it("keeps the full F10 database out of the Worker bundle", () => {
    const render = fs.readFileSync("src/render.ts", "utf8");
    const deploy = fs.readFileSync(".github/workflows/deploy-worker.yml", "utf8");

    expect(render).not.toContain('import companyProfilesJson from "../data/company-profiles.json"');
    expect(render).toContain("/api/company/");
    expect(deploy).toContain("publish_company_profiles.mjs");
    expect(deploy).toContain("wrangler deploy --dry-run");
  });
});
