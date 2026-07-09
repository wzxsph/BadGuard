import { getSnapshot, refreshSnapshot, type Env } from "./data-source";
import { renderHtml } from "./render";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const snapshot = await getSnapshot(env);
      return new Response(renderHtml(snapshot), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store"
        }
      });
    }

    if (url.pathname === "/api/signals") {
      const snapshot = await getSnapshot(env);
      return Response.json(snapshot, { headers: JSON_HEADERS });
    }

    if (url.pathname === "/api/refresh" && request.method === "POST") {
      if (env.REFRESH_TOKEN) {
        const token = request.headers.get("x-refresh-token");
        if (token !== env.REFRESH_TOKEN) {
          return Response.json({ error: "unauthorized" }, { status: 401, headers: JSON_HEADERS });
        }
      }

      const snapshot = await refreshSnapshot(env);
      return Response.json(snapshot, { headers: JSON_HEADERS });
    }

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true }, { headers: JSON_HEADERS });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, context: ExecutionContext): Promise<void> {
    if (env.DATA_PROVIDER_URL) {
      context.waitUntil(refreshSnapshot(env));
    }
  }
};
