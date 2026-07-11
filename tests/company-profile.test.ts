import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { CompanyProfile } from "../src/types";

const profile: CompanyProfile = {
  code: "000001",
  name: "测试公司",
  industry: "测试行业",
  mainBusiness: "测试主营业务",
  businessScope: "测试经营范围",
  profileSource: "akshare-f10",
  updatedAt: "2026-07-10T00:00:00+08:00"
};

describe("lazy company profiles", () => {
  it("reads one company profile from KV with public caching", async () => {
    const response = await worker.fetch(new Request("https://example.test/api/company/000001"), {
      SIGNAL_KV: {
        get: async (key: string) => key === "company-profile:000001" ? profile : null
      } as unknown as KVNamespace
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(await response.json()).toMatchObject(profile);
  });

  it("returns a clear 404 when a profile is not available", async () => {
    const response = await worker.fetch(new Request("https://example.test/api/company/000002"), {
      SIGNAL_KV: {
        get: async () => null
      } as unknown as KVNamespace
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "company_profile_not_found" } });
  });
});
