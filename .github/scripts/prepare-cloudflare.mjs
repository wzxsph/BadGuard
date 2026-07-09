import fs from "node:fs/promises";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
const workersSubdomain = process.env.WORKERS_SUBDOMAIN?.trim() || "nizabentley397";
const workerName = "badguard";
const bindingName = "SIGNAL_KV";
const namespaceTitle = `${workerName}-${bindingName}`;
const previewNamespaceTitle = `${workerName}-${bindingName}_preview`;

if (!accountId) {
  throw new Error("CLOUDFLARE_ACCOUNT_ID is required.");
}

if (!/^[a-f0-9]{32}$/i.test(accountId)) {
  throw new Error(`CLOUDFLARE_ACCOUNT_ID does not look like a Cloudflare account id: ${accountId}`);
}

if (!token) {
  throw new Error("CLOUDFLARE_API_TOKEN is required.");
}

if (/\.workers\.dev$/i.test(token)) {
  throw new Error("CLOUDFLARE_API_TOKEN looks like a workers.dev domain. Use a Cloudflare API token string instead.");
}

const deploymentUrl = `https://${workerName}.${workersSubdomain}.workers.dev`;

async function cloudflare(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers || {})
    }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const message = payload.errors?.map((error) => error.message).join("; ") || response.statusText;
    throw new Error(`Cloudflare API ${init.method || "GET"} ${path} failed: ${message}`);
  }

  return payload;
}

async function listNamespaces() {
  const namespaces = [];
  let page = 1;
  let totalPages = 1;

  do {
    const payload = await cloudflare(`/storage/kv/namespaces?per_page=100&page=${page}`);
    namespaces.push(...(payload.result || []));
    totalPages = payload.result_info?.total_pages || 1;
    page += 1;
  } while (page <= totalPages);

  return namespaces;
}

async function ensureNamespace(title) {
  const existing = (await listNamespaces()).find((namespace) => namespace.title === title);
  if (existing) {
    console.log(`Using existing KV namespace ${title}: ${existing.id}`);
    return existing.id;
  }

  const payload = await cloudflare("/storage/kv/namespaces", {
    method: "POST",
    body: JSON.stringify({ title })
  });

  console.log(`Created KV namespace ${title}: ${payload.result.id}`);
  return payload.result.id;
}

function replaceBadGuardUrls(content) {
  return content.replace(/https:\/\/badguard\.[a-z0-9-]+\.workers\.dev/g, deploymentUrl);
}

async function updateWrangler(namespaceId, previewNamespaceId) {
  let content = await fs.readFile("wrangler.toml", "utf8");

  if (/^account_id\s*=/m.test(content)) {
    content = content.replace(/^account_id\s*=.*$/m, `account_id = "${accountId}"`);
  } else {
    content = content.replace(/^name\s*=.*$/m, (line) => `${line}\naccount_id = "${accountId}"`);
  }

  content = content.replace(
    /(\[\[kv_namespaces\]\]\s*binding\s*=\s*"SIGNAL_KV"\s*id\s*=\s*")[^"]+(")/,
    `$1${namespaceId}$2`
  );
  content = content.replace(
    /(\[\[kv_namespaces\]\]\s*binding\s*=\s*"SIGNAL_KV"[\s\S]*?preview_id\s*=\s*")[^"]+(")/,
    `$1${previewNamespaceId}$2`
  );

  await fs.writeFile("wrangler.toml", content);
}

async function updateTextFile(path, updater) {
  let content = await fs.readFile(path, "utf8");
  content = replaceBadGuardUrls(content);
  content = updater(content);
  await fs.writeFile(path, content);
}

const namespaceId = await ensureNamespace(namespaceTitle);
const previewNamespaceId = await ensureNamespace(previewNamespaceTitle);

await updateWrangler(namespaceId, previewNamespaceId);

await updateTextFile("README.md", (content) => content);

await updateTextFile(".github/workflows/deploy-worker.yml", (content) => content);
await updateTextFile(".github/workflows/refresh-akshare.yml", (content) => content);

console.log(JSON.stringify({
  deploymentUrl,
  kvBinding: bindingName
}, null, 2));
