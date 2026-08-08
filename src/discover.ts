// Descoberta por observação de rede (§5.2): não adivinha o endpoint CDA, abre o
// dashboard num Chrome headless via CDP e anota o que ele de fato chama.

import { HarvestError, insist } from "./retry.ts";
import type { AttemptReason } from "./retry.ts";
import type { Config, DiscoveredCall, EndpointsFile } from "./types.ts";

const CDA_RE = /\/pentaho\/plugin\/cda\//;

export type DiscoverySuccess = {
  outDir: string;
  endpointsPath: string;
  screenshotPath: string;
  callCount: number;
};

export type DiscoveryReport =
  | { ok: true; result: DiscoverySuccess; attempts: number; elapsedMs: number }
  | { ok: false; reason: AttemptReason; message: string; screenshotPath: string | null; attempts: number };

/** Carrega o caminho do screenshot de diagnóstico junto do erro, para o relatório de falha (critério 3). */
class DiscoveryError extends HarvestError {
  readonly screenshotPath: string | null;
  constructor(reason: AttemptReason, message: string, screenshotPath: string | null, opts?: { cause?: unknown }) {
    super(reason, message, opts);
    this.screenshotPath = screenshotPath;
  }
}

export async function discover(config: Config): Promise<DiscoveryReport> {
  const attempt = await insist("descobrir:painel", (signal, n) => attemptDiscovery(config, signal, n), {
    maxAttempts: config.retry.maxAttempts,
    baseMs: config.retry.baseMs,
    capMs: config.retry.capMs,
    timeoutMs: Math.max(config.retry.timeoutMs, config.pentaho.settleMs + 15_000),
  });

  if (attempt.ok) {
    return { ok: true, result: attempt.value, attempts: attempt.attempts, elapsedMs: attempt.elapsedMs };
  }

  return {
    ok: false,
    reason: attempt.reason,
    message: attempt.lastError.message,
    screenshotPath: attempt.lastError instanceof DiscoveryError ? attempt.lastError.screenshotPath : null,
    attempts: attempt.attempts,
  };
}

async function attemptDiscovery(config: Config, _signal: AbortSignal, attemptNumber: number): Promise<DiscoverySuccess> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = `data/raw/discovery/${timestamp}-tentativa${attemptNumber}`;
  const screenshotPath = `data/shots/discovery-${timestamp}-tentativa${attemptNumber}.png`;

  // O CDA responde a POST com corpo application/x-www-form-urlencoded, não GET
  // com querystring — path/dataAccessId/parâmetros do ano vêm de `postData`.
  // Por isso é preciso correlacionar `requestWillBeSent` (pedido) com
  // `responseReceived` (status) pelo mesmo requestId. Ver NOTAS.md.
  const requests = new Map<string, { url: string; method: string; postData?: string }>();
  const responseInfo = new Map<string, { status: number; mimeType: string }>();

  await using view = new Bun.WebView({
    backend: { type: "chrome", url: false },
    width: 1600,
    height: 1200,
    console: (type, ...args) => logPage(type, args),
  });

  await view.navigate("about:blank");
  await view.cdp("Network.enable");

  view.addEventListener("Network.requestWillBeSent", (event) => {
    const data = (event as unknown as { data: { requestId: string; request: { url: string; method: string; postData?: string } } }).data;
    const { requestId, request } = data;
    if (!CDA_RE.test(request.url)) return;
    const entry: { url: string; method: string; postData?: string } = { url: request.url, method: request.method };
    if (request.postData) entry.postData = request.postData;
    requests.set(requestId, entry);
  });

  view.addEventListener("Network.responseReceived", (event) => {
    const data = (event as unknown as { data: { requestId: string; response: { url: string; status: number; mimeType: string } } }).data;
    const { requestId, response } = data;
    if (!CDA_RE.test(response.url)) return;
    responseInfo.set(requestId, { status: response.status, mimeType: response.mimeType });
  });

  try {
    await view.navigate(config.pentaho.panelUrl);
  } catch (err) {
    await saveScreenshotBestEffort(view, screenshotPath);
    throw new DiscoveryError("http", `navegação ao painel Pentaho falhou: ${errorMessage(err)}`, screenshotPath, { cause: err });
  }

  await Bun.sleep(config.pentaho.settleMs);

  const calls: DiscoveredCall[] = [];
  for (const [requestId, req] of requests) {
    const resp = responseInfo.get(requestId);
    if (!resp) continue;
    calls.push({
      requestId,
      url: req.url,
      method: req.method,
      status: resp.status,
      mimeType: resp.mimeType,
      ...(req.postData ? { postData: req.postData } : {}),
      ...parsePostParams(req.postData),
    });
  }

  if (calls.length === 0) {
    await saveScreenshotBestEffort(view, screenshotPath);
    throw new DiscoveryError("empty", "painel carregou mas nenhuma chamada ao plugin CDA foi observada", screenshotPath);
  }

  const manifest: DiscoveredCall[] = [];
  let n = 0;
  for (const call of calls) {
    n++;
    const body = await captureResponseBody(view, call.requestId);
    await Bun.write(`${outDir}/${n}.json`, JSON.stringify(body, null, 2));
    manifest.push(call);
  }
  await Bun.write(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2));
  await saveScreenshotBestEffort(view, screenshotPath);

  const endpointsFile: EndpointsFile = {
    discoveredAt: new Date().toISOString(),
    panelUrl: config.pentaho.panelUrl,
    calls: manifest,
  };
  await Bun.write("data/endpoints.json", JSON.stringify(endpointsFile, null, 2));

  return { outDir, endpointsPath: "data/endpoints.json", screenshotPath, callCount: manifest.length };
}

async function captureResponseBody(view: Bun.WebView, requestId: string): Promise<unknown> {
  try {
    return await view.cdp("Network.getResponseBody", { requestId });
  } catch (err) {
    return { erro: errorMessage(err) };
  }
}

async function saveScreenshotBestEffort(view: Bun.WebView, path: string): Promise<void> {
  try {
    const shot = await view.screenshot({ format: "png" });
    await Bun.write(path, shot);
  } catch (err) {
    await Bun.write(`${path}.erro.txt`, errorMessage(err));
  }
}

function parsePostParams(postData: string | undefined): { path?: string; dataAccessId?: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  if (postData) {
    for (const [key, value] of new URLSearchParams(postData)) params[key] = value;
  }
  const result: { path?: string; dataAccessId?: string; params: Record<string, string> } = { params };
  if (params.path) result.path = params.path;
  if (params.dataAccessId) result.dataAccessId = params.dataAccessId;
  return result;
}

function logPage(type: string, args: unknown[]): void {
  console.error(`[webview:${type}]`, ...args);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (/chrome|chromium/i.test(err.message) && /not found|enoent|failed to launch/i.test(err.message)) {
      return `${err.message} — instale Chrome/Chromium ou defina BUN_CHROME_PATH`;
    }
    return err.message;
  }
  return String(err);
}
