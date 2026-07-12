import { getCompanyProfile, getSnapshot, refreshSnapshot, type Env } from "./data-source";
import { getDataFreshness } from "./data-health";
import { getSnapshotDataQuality, withSnapshotDataQuality } from "./data-quality";
import {
  HistoryNotFoundError,
  HistoryStorageUnavailableError,
  InvalidHistoryDateError,
  getHistoryDetail,
  getHistoryIndex
} from "./history";
import { renderHistoryHtml } from "./history-render";
import { renderHtml } from "./render";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "https://wzxsph.github.io"
};

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store"
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const snapshot = await getSnapshot(env);
      const freshness = await getDataFreshness(env, snapshot).catch(() => null);
      return new Response(renderHtml(snapshot, freshness), {
        headers: HTML_HEADERS
      });
    }

    if (url.pathname === "/history") {
      if (request.method !== "GET") {
        return methodNotAllowed("GET");
      }

      try {
        const index = await getHistoryIndex(env);
        const latestEntry = index.entries[0];
        const detail = latestEntry ? await getHistoryDetail(env, latestEntry.date) : null;
        return new Response(renderHistoryHtml(index.entries, detail), { headers: HTML_HEADERS });
      } catch (error) {
        const mapped = mapHistoryError(error);
        return new Response(renderHistoryHtml([], null, mapped.body.error.message), {
          status: mapped.status,
          headers: HTML_HEADERS
        });
      }
    }

    if (url.pathname === "/api/history") {
      if (request.method !== "GET") {
        return methodNotAllowed("GET");
      }

      try {
        const index = await getHistoryIndex(env);
        return Response.json({
          version: index.version,
          dates: index.entries,
          tradingDates: index.tradingDates,
          ...(index.updatedAt ? { updatedAt: index.updatedAt } : {})
        }, { headers: JSON_HEADERS });
      } catch (error) {
        return historyErrorResponse(error);
      }
    }

    const historyDetailMatch = url.pathname.match(/^\/api\/history\/([^/]+)$/);
    if (historyDetailMatch) {
      if (request.method !== "GET") {
        return methodNotAllowed("GET");
      }

      let date: string;
      try {
        date = decodeURIComponent(historyDetailMatch[1]);
      } catch {
        return historyErrorResponse(new InvalidHistoryDateError(historyDetailMatch[1]));
      }

      try {
        const detail = await getHistoryDetail(env, date);
        return Response.json(withSnapshotDataQuality(detail, {
          bootstrapSeed: detail.entry.bootstrapSeed
        }), { headers: JSON_HEADERS });
      } catch (error) {
        return historyErrorResponse(error);
      }
    }

    const companyProfileMatch = url.pathname.match(/^\/api\/company\/(\d{6})$/);
    if (companyProfileMatch) {
      if (request.method !== "GET") {
        return methodNotAllowed("GET");
      }

      const profile = await getCompanyProfile(env, companyProfileMatch[1]);
      if (!profile) {
        return Response.json({
          error: { code: "company_profile_not_found", message: "该公司的 F10 概况暂未收录。" }
        }, { status: 404, headers: JSON_HEADERS });
      }

      return Response.json(profile, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=86400",
          "access-control-allow-origin": "https://wzxsph.github.io"
        }
      });
    }

    if (url.pathname === "/api/signals") {
      const snapshot = await getSnapshot(env);
      return Response.json({
        ...snapshot,
        dataQuality: getSnapshotDataQuality(snapshot)
      }, { headers: JSON_HEADERS });
    }

    if (url.pathname === "/api/data-health") {
      const snapshot = await getSnapshot(env);
      try {
        return Response.json(await getDataFreshness(env, snapshot), { headers: JSON_HEADERS });
      } catch {
        return Response.json({
          ok: false,
          status: "unknown",
          expectedMarketDate: null,
          currentMarketDate: snapshot.marketDate,
          historyReady: false,
          missingDates: [],
          checkedAt: new Date().toISOString(),
          label: "交易日状态暂不可用"
        }, { headers: JSON_HEADERS });
      }
    }

    if (url.pathname === "/api/refresh" && request.method === "POST") {
      if (env.REFRESH_TOKEN) {
        const token = request.headers.get("x-refresh-token");
        if (token !== env.REFRESH_TOKEN) {
          return Response.json({ error: "unauthorized" }, { status: 401, headers: JSON_HEADERS });
        }
      }

      const snapshot = await refreshSnapshot(env);
      return Response.json({
        ...snapshot,
        dataQuality: getSnapshotDataQuality(snapshot)
      }, { headers: JSON_HEADERS });
    }

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true }, { headers: JSON_HEADERS });
    }

    return new Response("Not found", { status: 404 });
  }
};

function methodNotAllowed(allow: string): Response {
  return Response.json({
    error: {
      code: "method_not_allowed",
      message: "该接口不支持此请求方法。"
    }
  }, {
    status: 405,
    headers: { ...JSON_HEADERS, allow }
  });
}

function historyErrorResponse(error: unknown): Response {
  const mapped = mapHistoryError(error);
  return Response.json(mapped.body, { status: mapped.status, headers: JSON_HEADERS });
}

function mapHistoryError(error: unknown): {
  status: number;
  body: { error: { code: string; message: string } };
} {
  if (error instanceof InvalidHistoryDateError) {
    return {
      status: 400,
      body: { error: { code: error.code, message: "日期格式无效，请使用真实的 YYYY-MM-DD 日期。" } }
    };
  }

  if (error instanceof HistoryNotFoundError) {
    return {
      status: 404,
      body: { error: { code: error.code, message: "该交易日没有可用的历史榜单。" } }
    };
  }

  if (error instanceof HistoryStorageUnavailableError) {
    return {
      status: 503,
      body: { error: { code: error.code, message: "历史存储暂时不可用，请稍后再试。" } }
    };
  }

  return {
    status: 500,
    body: { error: { code: "history_internal_error", message: "历史数据处理失败，请稍后再试。" } }
  };
}
