// Fallback estável: CKAN dados.pe.gov.br (§5.4). Sem coluna de autoria — isso é
// resolvido depois, em normalize.ts.

import type { Db, NewEmpenho } from "./db.ts";
import { HarvestError, insist } from "./retry.ts";
import type { CkanPackageShowResponse, CkanResource, Config, EmpenhoBruto } from "./types.ts";
import { runWithConcurrency, yearsUpToCurrent } from "./util.ts";

const CSV_COLUMNS = [
  "numero_empenho",
  "unidade_gestora",
  "credor",
  "cd_nm_funcao",
  "cd_nm_subfuncao",
  "cd_nm_prog",
  "cd_nm_acao",
  "cd_nm_subacao",
  "ds_modalidade_empenho",
  "ds_tp_licitacao",
  "obs",
  "ds_tp_desp",
  "cd_ds_fonte_recurso",
  "cd_nm_categoria",
  "cd_nm_grupo",
  "cd_nm_modalidade",
  "cd_nm_elemento",
  "cd_nm_item_vlrliquidado",
  "vlrempenhado",
  "vlrliquidado",
  "vlrtotalpago",
] as const;

const NUMERIC_COLUMNS = new Set(["vlrempenhado", "vlrliquidado", "vlrtotalpago"]);

const DATASET_PAGE_URL = "https://dados.pe.gov.br/dataset/emendasparlamentaresestaduais";

export type CkanHarvestResult = {
  exercicio: number;
  status: "ok" | "empty" | "http" | "timeout" | "parse";
  inserted: number;
  total: number;
};

export async function harvestCkan(
  db: Db,
  config: Config,
  opts?: { years?: number[]; concurrency?: number },
): Promise<CkanHarvestResult[]> {
  const years = opts?.years ?? yearsUpToCurrent(config.startYear);
  const concurrency = opts?.concurrency ?? config.pentaho.concurrency;
  const retryOpts = {
    maxAttempts: config.retry.maxAttempts,
    baseMs: config.retry.baseMs,
    capMs: config.retry.capMs,
    timeoutMs: config.retry.timeoutMs,
  };

  const resources = await resolveResources(db, config, retryOpts);
  if (!resources) {
    return years.map((exercicio) => ({ exercicio, status: "http" as const, inserted: 0, total: 0 }));
  }

  return runWithConcurrency(years, concurrency, (year) => harvestYear(db, config, resources, year));
}

/**
 * `package_show` é o caminho normal. Se ele falhar mesmo após todas as
 * tentativas de `insist()`, raspa a página HTML pública do dataset com
 * `HTMLRewriter` como último recurso antes de desistir de todo o exercício
 * (tabela §2.1 exige `HTMLRewriter` para esse fallback).
 */
async function resolveResources(
  db: Db,
  config: Config,
  retryOpts: { maxAttempts: number; baseMs: number; capMs: number; timeoutMs: number },
): Promise<CkanResource[] | null> {
  const pkgAttempt = await insist("ckan:package_show", (signal) => fetchPackage(config, signal), retryOpts);
  if (pkgAttempt.ok) return pkgAttempt.value.result.resources;

  db.logHarvest({
    alvo: "ckan:package_show",
    exercicio: null,
    status: pkgAttempt.reason,
    tentativas: pkgAttempt.attempts,
    http_status: pkgAttempt.status ?? null,
    duracao_ms: null,
    mensagem: pkgAttempt.lastError.message,
  });

  const scrapeAttempt = await insist("ckan:scrape-fallback", (signal) => fetchPackageViaHtmlFallback(config, signal), retryOpts);
  if (scrapeAttempt.ok) {
    db.logHarvest({
      alvo: "ckan:scrape-fallback",
      exercicio: null,
      status: "ok",
      tentativas: scrapeAttempt.attempts,
      http_status: 200,
      duracao_ms: Math.round(scrapeAttempt.elapsedMs),
      mensagem: `${scrapeAttempt.value.result.resources.length} recursos raspados de ${DATASET_PAGE_URL}`,
    });
    return scrapeAttempt.value.result.resources;
  }

  db.logHarvest({
    alvo: "ckan:scrape-fallback",
    exercicio: null,
    status: scrapeAttempt.reason,
    tentativas: scrapeAttempt.attempts,
    http_status: scrapeAttempt.status ?? null,
    duracao_ms: null,
    mensagem: scrapeAttempt.lastError.message,
  });
  return null;
}

/** Raspa `<li class="resource-item">` da página do dataset (verificado contra o HTML real em 08/08/2026). */
export function scrapeResourcesFromHtml(html: string): CkanResource[] {
  const items: Array<Partial<CkanResource>> = [];
  let current: Partial<CkanResource> | null = null;

  const rewriter = new HTMLRewriter();
  rewriter.on("li.resource-item", {
    element(el) {
      current = { id: el.getAttribute("data-id") ?? "" };
      items.push(current);
    },
  });
  rewriter.on("li.resource-item a.heading", {
    element(el) {
      if (current && !current.name) current.name = el.getAttribute("title") ?? "";
    },
  });
  rewriter.on("li.resource-item span.format-label", {
    element(el) {
      if (current && !current.format) current.format = el.getAttribute("data-format") ?? "";
    },
  });
  rewriter.on("li.resource-item a.resource-url-analytics", {
    element(el) {
      if (current && !current.url) current.url = el.getAttribute("href") ?? "";
    },
  });
  rewriter.transform(html);

  return items.filter((i): i is CkanResource => Boolean(i.id && i.name && i.format && i.url));
}

async function fetchPackageViaHtmlFallback(config: Config, signal: AbortSignal): Promise<CkanPackageShowResponse> {
  const response = await fetch(DATASET_PAGE_URL, { signal, headers: { "User-Agent": config.http.userAgent } });
  if (!response.ok) {
    throw new HarvestError("http", `página do dataset retornou ${response.status}`, { status: response.status });
  }
  const html = await response.text();
  if (html.trim().length === 0) throw new HarvestError("empty", "página do dataset retornou corpo vazio");

  const resources = scrapeResourcesFromHtml(html);
  if (resources.length === 0) {
    throw new HarvestError("parse", "nenhum recurso encontrado ao raspar a página do dataset");
  }
  return { success: true, result: { id: config.ckan.datasetUuid, resources } };
}

async function harvestYear(db: Db, config: Config, resources: CkanResource[], year: number): Promise<CkanHarvestResult> {
  const label = `ckan:${year}`;
  const resource = pickResource(resources, year);

  if (!resource) {
    db.logHarvest({
      alvo: label,
      exercicio: year,
      status: "empty",
      tentativas: 0,
      http_status: null,
      duracao_ms: null,
      mensagem: "nenhum recurso publicado para este exercício",
    });
    return { exercicio: year, status: "empty", inserted: 0, total: 0 };
  }

  const attempt = await insist(
    label,
    (signal) => fetchResource(resource, signal),
    { maxAttempts: config.retry.maxAttempts, baseMs: config.retry.baseMs, capMs: config.retry.capMs, timeoutMs: config.retry.timeoutMs },
  );

  if (!attempt.ok) {
    db.logHarvest({
      alvo: label,
      exercicio: year,
      status: attempt.reason,
      tentativas: attempt.attempts,
      http_status: attempt.status ?? null,
      duracao_ms: null,
      mensagem: attempt.lastError.message,
    });
    return { exercicio: year, status: attempt.reason, inserted: 0, total: 0 };
  }

  const { body, kind } = attempt.value;
  await writeRawImmutable(year, kind, body);

  let rows: EmpenhoBruto[];
  try {
    rows = kind === "json" ? parseJsonEnvelope(body) : parseCsvBody(body);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err), { cause: err });
    db.logHarvest({
      alvo: label,
      exercicio: year,
      status: "parse",
      tentativas: attempt.attempts,
      http_status: 200,
      duracao_ms: Math.round(attempt.elapsedMs),
      mensagem: error.message,
    });
    return { exercicio: year, status: "parse", inserted: 0, total: 0 };
  }

  if (rows.length === 0) {
    db.logHarvest({
      alvo: label,
      exercicio: year,
      status: "empty",
      tentativas: attempt.attempts,
      http_status: 200,
      duracao_ms: Math.round(attempt.elapsedMs),
      mensagem: "0 linhas após parse",
    });
    return { exercicio: year, status: "empty", inserted: 0, total: 0 };
  }

  await writeWorkingJsonl(year, rows);

  let inserted = 0;
  for (const row of rows) {
    const newRow: NewEmpenho = {
      exercicio: year,
      numero_empenho: row.numero_empenho,
      unidade_gestora: row.unidade_gestora,
      credor: row.credor,
      obs: row.obs,
      cd_nm_subacao: row.cd_nm_subacao,
      cd_nm_funcao: row.cd_nm_funcao,
      vlrempenhado: row.vlrempenhado,
      vlrliquidado: row.vlrliquidado,
      vlrtotalpago: row.vlrtotalpago,
      fonte: "ckan",
    };
    const result = db.insertEmpenho(newRow);
    if (result.inserted) inserted++;
  }

  db.logHarvest({
    alvo: label,
    exercicio: year,
    status: "ok",
    tentativas: attempt.attempts,
    http_status: 200,
    duracao_ms: Math.round(attempt.elapsedMs),
    mensagem: `${inserted}/${rows.length} novas linhas`,
  });

  return { exercicio: year, status: "ok", inserted, total: rows.length };
}

async function fetchPackage(config: Config, signal: AbortSignal): Promise<CkanPackageShowResponse> {
  const response = await fetch(config.ckan.packageShowUrl, {
    signal,
    headers: { "User-Agent": config.http.userAgent },
  });
  if (!response.ok) {
    throw new HarvestError("http", `package_show retornou ${response.status}`, { status: response.status });
  }
  const text = await response.text();
  if (text.trim().length === 0) throw new HarvestError("empty", "package_show retornou corpo vazio");
  let parsed: CkanPackageShowResponse;
  try {
    parsed = JSON.parse(text) as CkanPackageShowResponse;
  } catch (err) {
    throw new HarvestError("parse", "package_show retornou JSON inválido", { cause: err });
  }
  if (!parsed.success || !Array.isArray(parsed.result?.resources)) {
    throw new HarvestError("parse", "package_show sem lista de resources válida");
  }
  return parsed;
}

async function fetchResource(resource: CkanResource, signal: AbortSignal): Promise<{ body: string; kind: "json" | "csv" }> {
  const response = await fetch(resource.url, { signal });
  if (!response.ok) {
    throw new HarvestError("http", `${resource.url} retornou ${response.status}`, { status: response.status });
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength === "0") {
    throw new HarvestError("empty", `${resource.url} respondeu content-length: 0`, { status: response.status });
  }
  const body = await response.text();
  if (body.trim().length === 0) {
    throw new HarvestError("empty", `${resource.url} respondeu corpo vazio`, { status: response.status });
  }
  const kind = resource.format.replace(/^\./, "").toUpperCase() === "JSON" ? "json" : "csv";
  return { body, kind };
}

function pickResource(resources: CkanResource[], year: number): CkanResource | undefined {
  const matches = resources.filter((r) => r.name.includes(String(year)));
  const json = matches.find((r) => r.format.replace(/^\./, "").toUpperCase() === "JSON");
  if (json) return json;
  return matches.find((r) => r.format.replace(/^\./, "").toUpperCase() === "CSV");
}

function parseJsonEnvelope(body: string): EmpenhoBruto[] {
  const parsed = JSON.parse(body) as { campos?: unknown };
  if (!parsed || !Array.isArray(parsed.campos)) {
    throw new Error("JSON não segue o envelope esperado {campos: [...]}");
  }
  return parsed.campos as EmpenhoBruto[];
}

function rowMapper<const Cols extends readonly string[]>(cols: Cols) {
  return (values: string[]): Record<Cols[number], string> => {
    const obj = {} as Record<Cols[number], string>;
    for (let i = 0; i < cols.length; i++) {
      const key = cols[i] as Cols[number];
      obj[key] = values[i] ?? "";
    }
    return obj;
  };
}

const mapCsvRow = rowMapper(CSV_COLUMNS);

function parseCsvBody(body: string): EmpenhoBruto[] {
  const rows = parseCsv(body, ";");
  if (rows.length === 0) return [];

  const header = rows[0] ?? [];
  const expected = CSV_COLUMNS as readonly string[];
  const normalizedHeader = header.map((h) => h.trim());
  const missing = expected.filter((c) => !normalizedHeader.includes(c));
  if (missing.length > 0) {
    throw new Error(`colunas ausentes no CSV: ${missing.join(", ")}`);
  }

  const dataRows = rows.slice(1).filter((r) => r.length > 1 || (r[0] ?? "") !== "");
  return dataRows.map((values) => {
    const raw = mapCsvRow(values);
    const record: Record<string, string | number | null> = { ...raw };
    for (const col of NUMERIC_COLUMNS) {
      record[col] = raw[col as (typeof CSV_COLUMNS)[number]] === "" ? 0 : Number(raw[col as (typeof CSV_COLUMNS)[number]]);
    }
    record.obs = raw.obs === "" ? null : raw.obs;
    return record as unknown as EmpenhoBruto;
  });
}

/** Parser CSV próprio: aspas com escape `""`, delimitador configurável, `\r\n`/`\n`. */
export function parseCsv(text: string, delimiter = ";"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

async function writeRawImmutable(year: number, kind: "json" | "csv", body: string): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `data/raw/ckan/${year}/${timestamp}.${kind}`;
  await Bun.write(path, body);
}

async function writeWorkingJsonl(year: number, rows: EmpenhoBruto[]): Promise<void> {
  const path = `data/raw/ckan/${year}.jsonl`;
  const sink = Bun.file(path).writer();
  for (const row of rows) {
    sink.write(`${JSON.stringify(row)}\n`);
  }
  await sink.end();
}

