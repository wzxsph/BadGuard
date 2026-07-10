import { describe, expect, it } from "vitest";
import latestSnapshot from "../data/latest.json";
import { getSnapshotDataQuality } from "../src/data-quality";
import worker from "../src/index";
import type { SignalSnapshot, SnapshotMeta } from "../src/types";

describe("snapshot data quality transparency", () => {
  it("classifies only a fully covered fixed-universe run as complete production", () => {
    const snapshot = makeSnapshot({
      scanLimit: 0,
      stockCount: 1000,
      universeSource: "code-list",
      historySource: "eastmoney",
      historySuccessCount: 980,
      historySuccessRate: 0.98,
      failureCount: 20,
      exactCloseCount: 970,
      exactCloseCoverage: 0.97,
      perBoardLimit: 0,
      buildMode: "production",
      runContextHash: "ffffffffffffffffffffffffffffffff",
      universeManifestRevision: "0123456789abcdef0123456789abcdef",
      universeManifestMemberCount: 1000,
      universeStaleCount: 2
    });

    expect(getSnapshotDataQuality(snapshot)).toMatchObject({
      kind: "complete-production",
      label: "完整生产快照",
      stockCount: 1000,
      historySuccessCount: 980,
      historySuccessRate: 0.98,
      exactCloseCount: 970,
      exactCloseCoverage: 0.97,
      universeSource: "code-list",
      universeSourceLabel: "固定代码池",
      universeVersion: "0123456789abcdef0123456789abcdef",
      universeMemberCount: 1000,
      universeStaleCount: 2,
      universeReuseLabel: "沿用固定池中的 2 只暂时缺席成员",
      snapshotTiming: "same-day-close"
    });
  });

  it("reports a seed's actually published ranked-code coverage instead of its original scan coverage", () => {
    const snapshot = makeSnapshot({
      scanLimit: 500,
      stockCount: 500,
      universeSource: "code-list",
      historySource: "eastmoney",
      failureCount: 0,
      exactCloseCount: 499,
      buildMode: "bundled",
      bootstrapSeed: true,
      bootstrapCloseCoverage: "ranked-codes-only",
      bootstrapPublishedCloseCount: 44
    });

    const quality = getSnapshotDataQuality(snapshot);
    expect(quality).toMatchObject({
      kind: "bootstrap-seed",
      label: "临时恢复种子",
      stockCount: 500,
      historySuccessCount: 500,
      historySuccessRate: 1,
      exactCloseCount: 44,
      exactCloseCoverage: 0.088,
      coverageScope: "ranked-codes-only"
    });
    expect(quality.warning).toContain("44/500");
    expect(quality.warning).toContain("榜单数量少不能解读为全市场信号很少");
  });

  it("does not call 97.9% history success complete production even with sufficient close coverage", () => {
    const snapshot = makeSnapshot({
      scanLimit: 0,
      stockCount: 1000,
      universeSource: "code-list",
      historySource: "eastmoney",
      historySuccessCount: 979,
      historySuccessRate: 0.979,
      failureCount: 21,
      exactCloseCount: 950,
      exactCloseCoverage: 0.95,
      perBoardLimit: 0,
      buildMode: "production",
      universeManifestRevision: "0123456789abcdef0123456789abcdef"
    });

    expect(getSnapshotDataQuality(snapshot).kind).toBe("partial-or-preview");
  });

  it("does not treat a run context hash as an accepted sticky-universe version", () => {
    const snapshot = makeSnapshot({
      scanLimit: 0,
      stockCount: 1000,
      universeSource: "code-list",
      historySource: "eastmoney",
      historySuccessCount: 1000,
      historySuccessRate: 1,
      failureCount: 0,
      exactCloseCount: 1000,
      exactCloseCoverage: 1,
      perBoardLimit: 0,
      buildMode: "production",
      runContextHash: "0123456789abcdef0123456789abcdef"
    });

    expect(getSnapshotDataQuality(snapshot).kind).toBe("partial-or-preview");
  });

  it("labels the bundled snapshot as a carried, non-production preview without treating row count as failure", () => {
    const quality = getSnapshotDataQuality(latestSnapshot as SignalSnapshot);

    expect(quality).toMatchObject({
      kind: "partial-or-preview",
      label: "非完整生产快照",
      stockCount: 500,
      historySuccessCount: 500,
      exactCloseCount: 499,
      exactCloseCoverage: 0.998,
      universeSourceLabel: "固定代码池",
      universeVersion: null,
      universeReuseLabel: "旧版未记录是否沿用",
      snapshotTiming: "latest-completed",
      snapshotTimingLabel: "沿用最近完整收盘榜单"
    });
  });

  it("adds the same quality contract to the signals API", async () => {
    const response = await worker.fetch(new Request("https://example.test/api/signals"), {});
    const payload = await response.json<Record<string, unknown>>() as {
      marketDate: string;
      dataQuality: ReturnType<typeof getSnapshotDataQuality>;
    };

    expect(response.status).toBe(200);
    expect(payload.marketDate).toBe("2026-07-09");
    expect(payload.dataQuality).toMatchObject({
      stockCount: 500,
      historySuccessRate: 1,
      exactCloseCoverage: 0.998,
      universeSource: "code-list",
      kind: "partial-or-preview"
    });
  });

  it("exposes the actual sticky-universe revision and reuse status through the API", async () => {
    const snapshot = makeSnapshot({
      scanLimit: 0,
      stockCount: 1000,
      universeSource: "code-list",
      historySource: "eastmoney",
      historySuccessCount: 990,
      historySuccessRate: 0.99,
      failureCount: 10,
      exactCloseCount: 985,
      exactCloseCoverage: 0.985,
      perBoardLimit: 0,
      buildMode: "production",
      universeManifestRevision: "abcdef0123456789abcdef0123456789",
      universeManifestMemberCount: 1000,
      universeStaleCount: 7
    });
    const response = await worker.fetch(new Request("https://example.test/api/signals"), {
      SIGNAL_KV: {
        get: async (key: string) => key === "latest-signal-snapshot" ? snapshot : null
      } as unknown as KVNamespace
    });
    const payload = await response.json() as { dataQuality: ReturnType<typeof getSnapshotDataQuality> };

    expect(payload.dataQuality).toMatchObject({
      universeSource: "code-list",
      universeVersion: "abcdef0123456789abcdef0123456789",
      universeMemberCount: 1000,
      universeStaleCount: 7,
      universeReuseLabel: "沿用固定池中的 7 只暂时缺席成员"
    });
  });
});

function makeSnapshot(meta: SnapshotMeta): SignalSnapshot {
  return {
    marketDate: "2026-07-09",
    refreshedAt: "2026-07-09T15:30:00+08:00",
    source: "provider",
    sourceLabel: "测试",
    meta,
    boards: [],
    topRows: [],
    philosophy: "测试",
    disclaimers: []
  };
}
