// Replay direto via fetch (§5.3) — depois de `descobrir`, sai do navegador: uma
// ordem de grandeza mais rápido e não precisa de Chrome.

import type { Db, NewEmpenho } from "./db.ts";
import { classificarAutorTipo, extrairBeneficiario, extrairMunicipio, extrairNumeroEmenda, normalizarAutor } from "./normalize.ts";
import { HarvestError, insist } from "./retry.ts";
import type { Config, DiscoveredCall, EndpointsFile } from "./types.ts";
import { runWithConcurrency, yearsUpToCurrent } from "./util.ts";

type CdaColumn = { colName: string; colType: string; colIndex: number };
type CdaResponse = { metadata: CdaColumn[]; resultset: unknown[][]; queryInfo?: { totalRows?: string } };

const PAGE_SIZE = 50;

/**
 * Aliases best-effort: a tabela principal do Pentaho (`nome_ug`, `nm_credor`,
 * `vlr_emp_original`, ...) não usa os mesmos nomes de coluna do CKAN — ver
 * NOTAS.md item 10. Colunas sem alias encontrado ficam `null`.
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  numero_empenho: ["numero_empenho"],
  unidade_gestora: ["unidade_gestora", "nome_ug", "nm_ug"],
  credor: ["credor", "nm_credor", "nome_credor"],
  cd_nm_funcao: ["cd_nm_funcao", "funcao", "nm_funcao"],
  cd_nm_subfuncao: ["cd_nm_subfuncao", "subfuncao"],
  cd_nm_prog: ["cd_nm_prog", "programa"],
  cd_nm_acao: ["cd_nm_acao", "acao", "nm_acao"],
  cd_nm_subacao: ["cd_nm_subacao", "subacao", "nm_subacao"],
  obs: ["obs", "observacao", "observacao_empenho", "detalhamento_empenho"],
  vlrempenhado: ["vlrempenhado", "vlr_emp_original", "vlr_empenhado", "valor_empenhado"],
  vlrliquidado: ["vlrliquidado", "vlr_liquidado", "valor_liquidado"],
  vlrtotalpago: ["vlrtotalpago", "vlr_total_pago", "vlr_pago", "valor_pago"],
  // Achado central (NOTAS.md item 13/14): a tabela principal do painel tem
  // autoria NATIVA — quando presente, dispensa toda a mineração de texto que
  // normalize.ts faz sobre `obs` para as fontes CKAN.
  autor: ["autor", "nm_autor", "deputado", "nome_autor"],
  municipio: ["municipio", "nm_municipio"],
};

export type PentahoHarvestResult = {
  exercicio: number | null;
  dataAccessId: string;
  status: "ok" | "empty" | "http" | "timeout" | "parse";
  inserted: number;
  total: number;
  comAutorNativo: number;
};

export async function harvestPentaho(
  db: Db,
  config: Config,
  opts?: { years?: number[]; concurrency?: number; endpointsPath?: string },
): Promise<PentahoHarvestResult[]> {
  const endpointsPath = opts?.endpointsPath ?? "data/endpoints.json";
  const file = Bun.file(endpointsPath);
  if (!(await file.exists())) {
    throw new Error(`${endpointsPath} não encontrado — rode "bun run descobrir" primeiro`);
  }

  const endpoints = JSON.parse(await file.text()) as EndpointsFile;
  const years = opts?.years ?? yearsUpToCurrent(config.startYear);
  const concurrency = opts?.concurrency ?? config.pentaho.concurrency;

  const templates = new Map<string, DiscoveredCall>();
  for (const call of endpoints.calls) {
    if (call.dataAccessId && !templates.has(call.dataAccessId)) templates.set(call.dataAccessId, call);
  }

  const jobs: Array<{ year: number | null; template: DiscoveredCall }> = [];
  for (const template of templates.values()) {
    if ("parampara_ano" in template.params) {
      for (const year of years) jobs.push({ year, template });
    } else {
      jobs.push({ year: null, template });
    }
  }

  return runWithConcurrency(jobs, concurrency, (job) => harvestOne(db, config, job.template, job.year));
}

async function harvestOne(db: Db, config: Config, template: DiscoveredCall, year: number | null): Promise<PentahoHarvestResult> {
  const dataAccessId = template.dataAccessId ?? "desconhecido";
  const label = year !== null ? `pentaho:${year}:${dataAccessId}` : `pentaho:${dataAccessId}`;
  const paginated = "paramlimit_" in template.params;
  const retryOpts = {
    maxAttempts: config.retry.maxAttempts,
    baseMs: config.retry.baseMs,
    capMs: config.retry.capMs,
    timeoutMs: config.retry.timeoutMs,
  };

  let offset = 0;
  let page = 0;
  let inserted = 0;
  let totalRows = 0;
  let comAutorNativo = 0;
  let anyOk = false;
  let lastStatus: PentahoHarvestResult["status"] = "ok";

  while (true) {
    page++;
    const params = buildParams(template.params, year, paginated ? offset : null);
    const pageLabel = `${label}:p${page}`;

    const attempt = await insist(pageLabel, (signal) => fetchCda(config, template, params, signal), retryOpts);

    if (!attempt.ok) {
      db.logHarvest({
        alvo: pageLabel,
        exercicio: year,
        status: attempt.reason,
        tentativas: attempt.attempts,
        http_status: attempt.status ?? null,
        duracao_ms: null,
        mensagem: attempt.lastError.message,
      });
      lastStatus = attempt.reason;
      break;
    }

    anyOk = true;
    const { body, raw } = attempt.value;
    await writeRawImmutable(year, dataAccessId, page, raw);

    const rowCount = body.resultset.length;
    totalRows += rowCount;

    if (year !== null && looksLikeEmpenhoTable(body.metadata)) {
      for (const row of mapRows(body.metadata, body.resultset)) {
        const { autor, municipioNativo, ...empenhoFields } = row;
        const result = db.insertEmpenho({ ...empenhoFields, exercicio: year, fonte: "pentaho" });
        if (result.inserted) inserted++;

        if (autor && autor.trim().length > 0) {
          const gravou = upsertEmendaComAutorNativo(db, empenhoFields, autor, municipioNativo, year);
          if (gravou) comAutorNativo++;
        }
      }
    }

    db.logHarvest({
      alvo: pageLabel,
      exercicio: year,
      status: "ok",
      tentativas: attempt.attempts,
      http_status: 200,
      duracao_ms: Math.round(attempt.elapsedMs),
      mensagem: `${rowCount} linhas`,
    });

    if (!paginated || rowCount < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return { exercicio: year, dataAccessId, status: anyOk ? "ok" : lastStatus, inserted, total: totalRows, comAutorNativo };
}

/**
 * Grava `emenda` direto da autoria nativa do painel — pula toda a mineração
 * de texto de `normalize.ts` para o campo autor (o painel já responde isso),
 * mas ainda reaproveita `extrairNumeroEmenda`/`extrairBeneficiario`/
 * `extrairMunicipio` para os demais campos derivados, exatamente como o
 * caminho CKAN. `db.upsertEmenda` nunca rebaixa confiança já gravada (§ ver
 * NOTAS.md item 14), então isso é seguro de rodar a qualquer momento.
 */
function upsertEmendaComAutorNativo(
  db: Db,
  empenho: { obs: string | null; cd_nm_subacao: string | null; credor: string | null },
  autorNativo: string,
  municipioNativo: string | null | undefined,
  exercicioArquivo: number,
): boolean {
  const numero = extrairNumeroEmenda(empenho.obs ?? "", exercicioArquivo) ?? extrairNumeroEmenda(empenho.cd_nm_subacao ?? "", exercicioArquivo);
  if (!numero) return false;

  const subacaoCodigo = empenho.cd_nm_subacao ? empenho.cd_nm_subacao.trim().slice(0, 4).toUpperCase() : null;
  const autorLimpo = autorNativo.trim();
  const { cnpj, nome } = extrairBeneficiario(empenho.credor);
  const municipio = municipioNativo?.trim() ? normalizarAutor(municipioNativo) : extrairMunicipio(empenho.credor, empenho.obs);

  db.upsertEmenda({
    numero_emenda: numero.numeroEmenda,
    exercicio_emenda: numero.exercicioEmenda,
    subacao_codigo: subacaoCodigo,
    autor_bruto: autorLimpo,
    autor_normalizado: normalizarAutor(autorLimpo),
    autor_tipo: classificarAutorTipo(autorLimpo),
    municipio,
    beneficiario_cnpj: cnpj,
    beneficiario_nome: nome,
    confianca: "alta",
  });
  return true;
}

function buildParams(templateParams: Record<string, string>, year: number | null, offset: number | null): Record<string, string> {
  const params = { ...templateParams };
  if (year !== null && "parampara_ano" in params) params.parampara_ano = String(year);
  if (offset !== null) params.paramoffset_ = String(offset);
  return params;
}

async function fetchCda(
  config: Config,
  template: DiscoveredCall,
  params: Record<string, string>,
  signal: AbortSignal,
): Promise<{ body: CdaResponse; raw: string }> {
  const bodyText = new URLSearchParams(params).toString();
  const response = await fetch(template.url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": config.http.userAgent },
    body: bodyText,
  });

  if (!response.ok) {
    throw new HarvestError("http", `${template.dataAccessId} retornou ${response.status}`, { status: response.status });
  }

  const raw = await response.text();
  if (raw.trim().length === 0) {
    throw new HarvestError("empty", `${template.dataAccessId} respondeu corpo vazio`, { status: response.status });
  }

  let parsed: CdaResponse;
  try {
    parsed = JSON.parse(raw) as CdaResponse;
  } catch (err) {
    throw new HarvestError("parse", `${template.dataAccessId} retornou JSON inválido`, { cause: err });
  }
  if (!Array.isArray(parsed.metadata) || !Array.isArray(parsed.resultset)) {
    throw new HarvestError("parse", `${template.dataAccessId} não seguiu o envelope CDA esperado`);
  }

  return { body: parsed, raw };
}

function looksLikeEmpenhoTable(metadata: CdaColumn[]): boolean {
  return metadata.some((c) => c.colName.toLowerCase() === "numero_empenho");
}

type MappedRow = Omit<NewEmpenho, "exercicio" | "fonte"> & { autor: string | null; municipioNativo: string | null };

function mapRows(metadata: CdaColumn[], resultset: unknown[][]): MappedRow[] {
  const indexByTarget: Record<string, number> = {};
  for (const [target, aliases] of Object.entries(COLUMN_ALIASES)) {
    const col = metadata.find((c) => aliases.includes(c.colName.toLowerCase()));
    if (col) indexByTarget[target] = col.colIndex;
  }

  const get = (row: unknown[], target: string): unknown => {
    const idx = indexByTarget[target];
    return idx === undefined ? null : (row[idx] ?? null);
  };

  return resultset
    .map((row) => ({
      numero_empenho: String(get(row, "numero_empenho") ?? ""),
      unidade_gestora: get(row, "unidade_gestora") as string | null,
      credor: get(row, "credor") as string | null,
      obs: get(row, "obs") as string | null,
      cd_nm_subacao: get(row, "cd_nm_subacao") as string | null,
      cd_nm_funcao: get(row, "cd_nm_funcao") as string | null,
      vlrempenhado: toNumber(get(row, "vlrempenhado")),
      vlrliquidado: toNumber(get(row, "vlrliquidado")),
      vlrtotalpago: toNumber(get(row, "vlrtotalpago")),
      autor: get(row, "autor") as string | null,
      municipioNativo: get(row, "municipio") as string | null,
    }))
    .filter((r) => r.numero_empenho.length > 0);
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function writeRawImmutable(year: number | null, dataAccessId: string, page: number, raw: string): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const yearSegment = year !== null ? String(year) : "_lookup";
  const path = `data/raw/pentaho/${yearSegment}/${dataAccessId}/${timestamp}-p${page}.json`;
  await Bun.write(path, raw);
}
