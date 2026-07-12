import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { renderHtml } from "../src/render";
import type { SignalSnapshot } from "../src/types";

const root = resolve(import.meta.dirname, "..");
const outputDir = resolve(root, "dist/pages");
const workerBaseUrl = "https://badguard.nizabentley397.workers.dev";

const snapshot = JSON.parse(
  await readFile(resolve(root, "data/latest.json"), "utf8"),
) as SignalSnapshot;

const staticNotice = `<aside style="position:relative;z-index:4;margin:0;padding:12px 20px;background:#161616;color:#f7f1e3;text-align:center;font:600 13px/1.6 system-ui,sans-serif;border-bottom:1px solid #000">
  GitHub Pages 静态快照 · 数据日期 ${snapshot.marketDate} ·
  <a href="${workerBaseUrl}" style="color:#ffe36e;text-decoration:underline" target="_blank" rel="noopener noreferrer">打开实时在线版 ↗</a>
</aside>`;

const html = renderHtml(snapshot, null)
  .replace("<body>", `<body>${staticNotice}`)
  .replace('href="/" aria-current="page"', 'href="./" aria-current="page"')
  .replace('href="/history"', `href="${workerBaseUrl}/history"`)
  .replace(
    'fetch("/api/company/" + encodeURIComponent(code))',
    `fetch("${workerBaseUrl}/api/company/" + encodeURIComponent(code))`,
  );

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(resolve(outputDir, "index.html"), html),
  writeFile(resolve(outputDir, ".nojekyll"), ""),
]);

console.log(`Built BadGuard GitHub Pages snapshot for ${snapshot.marketDate}`);
