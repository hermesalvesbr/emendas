// Emendas parlamentares FEDERAIS com foco em Pernambuco.
//
// Esfera diferente do resto do projeto (União, não Estado) e — felizmente —
// fonte muito melhor: o arquivo único da CGU/Portal da Transparência traz
// autor NOMINAL, UF e município do gasto, função e valores. Zero mineração de
// texto: aqui a autoria vem pronta, o desafio é o recorte de PE.
//
// O recorte é auditável por linha (coluna `cat`):
//   deputado / senador — autor bate com a bancada federal de PE (APIs oficiais
//                        da Câmara e do Senado, casadas por nome eleitoral OU
//                        nome civil normalizado)
//   bancada            — emenda coletiva "Bancada de Pernambuco"
//   gasto-pe           — autor de outro estado, mas recurso aplicado em PE

import type { CategoriaFederal, Db, NewEmendaFederal, NewParlamentarFederal } from "./db.ts";
import { MUNICIPIOS_PE } from "./municipios-pe.ts";
import { normalizarAutor } from "./normalize.ts";
import { parseCsv } from "./harvest-ckan.ts";
import { HarvestError, insist } from "./retry.ts";
import type { Config } from "./types.ts";

const URL_EMENDAS_ZIP = "https://portaldatransparencia.gov.br/download-de-dados/emendas-parlamentares/UNICO";
// idLegislatura=57 (2023-2027) devolve TODOS que exerceram mandato no período
// (36), não só os 25 em exercício hoje — sem isso, emendas de 2023 de quem
// saiu (ex. Ossésio Silva) cairiam em "gasto-pe". Ver NOTAS.md item 28.
// As emendas de 2023 vêm do orçamento aprovado em 2022, pela legislatura
// ANTERIOR — sem a 56ª, autores como Tadeu Alencar e Danilo Cabral cairiam
// em "gasto-pe" como se fossem de outro estado. Ver NOTAS.md item 28.
const LEGISLATURAS = [56, 57] as const;
const urlCamaraPE = (legislatura: number): string =>
  `https://dadosabertos.camara.leg.br/api/v2/deputados?siglaUf=PE&idLegislatura=${legislatura}&itens=100`;
const URL_SENADO = "https://legis.senado.leg.br/dadosabertos/senador/lista/atual";
const CSV_PRINCIPAL = "EmendasParlamentares.csv";
const BANCADA_PE = "BANCADA DE PERNAMBUCO";

/**
 * Ex-senadores de PE cujo mandato terminou em jan/2023 mas cujas emendas
 * aparecem na execução de 2023 (vêm da LOA aprovada em 2022).
 *
 * Por que uma lista explícita: a API do Senado só devolve quem está EM
 * EXERCÍCIO — `lista/atual` e `lista/legislatura/56` (com ou sem
 * `?exercicio=S`) retornam apenas 2 nomes de PE, omitindo quem deixou a
 * casa; `lista/legislatura/56/PE` responde 404. Sem isto, dois senadores
 * legítimos de PE seriam rotulados "gasto-pe" (autor de fora), que é
 * factualmente errado. Ambos serviram PE na 55ª/56ª legislaturas — fato
 * público verificável. Revisar se a API passar a expor o histórico.
 */
const SENADORES_PE_HISTORICOS: ReadonlyArray<{ nome: string; partido: string }> = [
  { nome: "Fernando Bezerra Coelho", partido: "MDB" },
  { nome: "Jarbas Vasconcelos", partido: "MDB" },
];

/** Colunas usadas do CSV — conferidas no arquivo real em 12/08/2026 (regra 1.2). */
const COL = {
  codigo: "Código da Emenda",
  ano: "Ano da Emenda",
  tipo: "Tipo de Emenda",
  autor: "Nome do Autor da Emenda",
  numero: "Número da emenda",
  localidade: "Localidade de aplicação do recurso",
  municipio: "Município",
  uf: "UF",
  funcao: "Nome Função",
  subfuncao: "Nome Subfunção",
  empenhado: "Valor Empenhado",
  liquidado: "Valor Liquidado",
  pago: "Valor Pago",
} as const;

export type FederalHarvestReport = {
  anos: number[];
  linhasArquivo: number;
  inseridas: number;
  porCategoria: Record<CategoriaFederal, number>;
  parlamentares: { deputados: number; senadores: number };
  autoresNaoCasados: string[];
};

export async function harvestFederal(
  db: Db,
  config: Config,
  opts?: { years?: number[]; zipPath?: string },
): Promise<FederalHarvestReport> {
  const years = opts?.years ?? anosLegislatura(config.startYear);
  const retryOpts = {
    maxAttempts: config.retry.maxAttempts,
    baseMs: config.retry.baseMs,
    capMs: config.retry.capMs,
    timeoutMs: Math.max(config.retry.timeoutMs, 240_000),
  };

  // 1. bancada federal de PE (para classificar deputado × senador)
  const bancada = await coletarBancadaPE(db, config, retryOpts);

  // 2. arquivo de emendas (raw imutável + extração)
  const zipPath = opts?.zipPath ?? (await baixarZip(db, config, retryOpts));
  const csv = await extrairCsv(zipPath);

  // 3. recorte
  const resultado = filtrarPE(csv, years, bancada);

  db.limparEmendasFederais(); // fonte é um snapshot completo: reconstrói do zero
  let inseridas = 0;
  for (const row of resultado.linhas) {
    if (db.insertEmendaFederal(row).inserted) inseridas++;
  }

  db.logHarvest({
    alvo: "federal:emendas",
    exercicio: null,
    status: "ok",
    tentativas: 1,
    http_status: 200,
    duracao_ms: null,
    mensagem: `${inseridas} linha(s) de PE (${years.join(",")}) de ${resultado.linhasArquivo} do arquivo; por categoria: ${JSON.stringify(resultado.porCategoria)}`,
  });

  return {
    anos: years,
    linhasArquivo: resultado.linhasArquivo,
    inseridas,
    porCategoria: resultado.porCategoria,
    parlamentares: {
      deputados: new Set([...bancada.deputados.values()].map((p) => p.nome_normalizado)).size,
      senadores: new Set([...bancada.senadores.values()].map((p) => p.nome_normalizado)).size,
    },
    autoresNaoCasados: resultado.autoresNaoCasados,
  };
}

export type BancadaPE = { deputados: Map<string, NewParlamentarFederal>; senadores: Map<string, NewParlamentarFederal> };

async function coletarBancadaPE(
  db: Db,
  config: Config,
  retryOpts: { maxAttempts: number; baseMs: number; capMs: number; timeoutMs: number },
): Promise<BancadaPE> {
  const bancada: BancadaPE = { deputados: new Map(), senadores: new Map() };

  for (const legislatura of LEGISLATURAS) {
    const deps = await insist(
      `federal:camara-pe-${legislatura}`,
      (signal) => fetchJson(urlCamaraPE(legislatura), config, signal),
      retryOpts,
    );
    if (!deps.ok) {
      db.logHarvest({
        alvo: `federal:camara-pe-${legislatura}`,
        exercicio: null,
        status: deps.reason,
        tentativas: deps.attempts,
        http_status: deps.status ?? null,
        duracao_ms: null,
        mensagem: deps.lastError.message,
      });
      continue;
    }
    for (const p of parseDeputados(deps.value)) {
      for (const chave of chavesNome(p)) bancada.deputados.set(chave, p);
      db.upsertParlamentarFederal(p);
    }
  }

  const sens = await insist("federal:senado-pe", (signal) => fetchJson(URL_SENADO, config, signal), retryOpts);
  if (sens.ok) {
    for (const p of parseSenadoresPE(sens.value)) {
      for (const chave of chavesNome(p)) bancada.senadores.set(chave, p);
      db.upsertParlamentarFederal(p);
    }
  }

  for (const h of SENADORES_PE_HISTORICOS) {
    const p: NewParlamentarFederal = {
      nome: h.nome,
      nome_civil: null,
      tipo: "senador",
      partido: h.partido,
      nome_normalizado: normalizarAutor(h.nome),
    };
    if (!bancada.senadores.has(p.nome_normalizado)) {
      bancada.senadores.set(p.nome_normalizado, p);
      db.upsertParlamentarFederal(p);
    }
  }

  return bancada;
}

/** Nome eleitoral e nome civil, ambos normalizados — o CSV usa ora um, ora outro. */
function chavesNome(p: NewParlamentarFederal): string[] {
  const chaves = [p.nome_normalizado];
  if (p.nome_civil) chaves.push(normalizarAutor(p.nome_civil));
  return [...new Set(chaves)];
}

export function parseDeputados(json: unknown): NewParlamentarFederal[] {
  const dados = (json as { dados?: Array<Record<string, unknown>> }).dados ?? [];
  return dados.map((d) => ({
    nome: String(d.nome ?? ""),
    nome_civil: null,
    tipo: "deputado" as const,
    partido: (d.siglaPartido as string) ?? null,
    nome_normalizado: normalizarAutor(String(d.nome ?? "")),
  }));
}

/** A API do Senado ignora `?uf=` — o filtro por PE é feito aqui. */
export function parseSenadoresPE(json: unknown): NewParlamentarFederal[] {
  const lista = acharParlamentares(json);
  const out: NewParlamentarFederal[] = [];
  for (const item of lista) {
    const ip = (item as { IdentificacaoParlamentar?: Record<string, unknown> }).IdentificacaoParlamentar;
    if (!ip || ip.UfParlamentar !== "PE") continue;
    const nome = String(ip.NomeParlamentar ?? "");
    if (!nome) continue;
    out.push({
      nome,
      nome_civil: (ip.NomeCompletoParlamentar as string) ?? null,
      tipo: "senador",
      partido: (ip.SiglaPartidoParlamentar as string) ?? null,
      nome_normalizado: normalizarAutor(nome),
    });
  }
  return out;
}

function acharParlamentares(o: unknown): unknown[] {
  if (Array.isArray(o)) {
    for (const v of o) {
      const r = acharParlamentares(v);
      if (r.length) return r;
    }
    return [];
  }
  if (o && typeof o === "object") {
    const obj = o as Record<string, unknown>;
    if (Array.isArray(obj.Parlamentar)) return obj.Parlamentar;
    for (const v of Object.values(obj)) {
      const r = acharParlamentares(v);
      if (r.length) return r;
    }
  }
  return [];
}

async function baixarZip(
  db: Db,
  config: Config,
  retryOpts: { maxAttempts: number; baseMs: number; capMs: number; timeoutMs: number },
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destino = `data/raw/federal/${timestamp}-EmendasParlamentares.zip`;

  const attempt = await insist(
    "federal:download-zip",
    async (signal) => {
      const response = await fetch(URL_EMENDAS_ZIP, { signal, headers: { "User-Agent": config.http.userAgent } });
      if (!response.ok) throw new HarvestError("http", `download retornou ${response.status}`, { status: response.status });
      const buf = await response.arrayBuffer();
      if (buf.byteLength < 1_000_000) throw new HarvestError("empty", `arquivo suspeito: ${buf.byteLength} bytes`);
      await Bun.write(destino, buf);
      return destino;
    },
    retryOpts,
  );

  if (!attempt.ok) {
    db.logHarvest({
      alvo: "federal:download-zip",
      exercicio: null,
      status: attempt.reason,
      tentativas: attempt.attempts,
      http_status: attempt.status ?? null,
      duracao_ms: null,
      mensagem: attempt.lastError.message,
    });
    throw new Error(`não foi possível baixar o arquivo de emendas federais: ${attempt.lastError.message}`, {
      cause: attempt.lastError,
    });
  }
  return attempt.value;
}

/** O CSV da CGU vem em ISO-8859-1 (latin1) — decodificar como UTF-8 corrompe acentos. */
async function extrairCsv(zipPath: string): Promise<string> {
  const proc = Bun.spawn(["unzip", "-p", zipPath, CSV_PRINCIPAL], { stdout: "pipe", stderr: "pipe" });
  const bytes = await new Response(proc.stdout).arrayBuffer();
  const code = await proc.exited;
  if (code !== 0 || bytes.byteLength === 0) {
    throw new Error(`falha ao extrair ${CSV_PRINCIPAL} de ${zipPath} (exit ${code})`);
  }
  // O tipo de TextDecoder no @types/bun não lista os rótulos legados, mas o
  // runtime aceita "iso-8859-1" (verificado) — daí o cast pontual.
  return new TextDecoder("iso-8859-1" as unknown as undefined).decode(bytes);
}

export type FiltroResultado = {
  linhas: NewEmendaFederal[];
  linhasArquivo: number;
  porCategoria: Record<CategoriaFederal, number>;
  autoresNaoCasados: string[];
};

export function filtrarPE(csvTexto: string, years: number[], bancada: BancadaPE): FiltroResultado {
  const linhas = parseCsv(csvTexto, ";");
  const header = (linhas[0] ?? []).map((h) => h.trim());
  const idx = (nome: string): number => header.indexOf(nome);

  const iCodigo = idx(COL.codigo);
  const iAno = idx(COL.ano);
  if (iAno < 0 || iCodigo < 0) throw new Error(`cabeçalho inesperado no CSV federal: ${header.slice(0, 6).join(" | ")}`);

  const anos = new Set(years);
  const out: NewEmendaFederal[] = [];
  const porCategoria: Record<CategoriaFederal, number> = { deputado: 0, senador: 0, bancada: 0, "gasto-pe": 0 };
  const naoCasados = new Set<string>();

  for (let i = 1; i < linhas.length; i++) {
    const linha = linhas[i];
    if (!linha || linha.length < header.length - 2) continue;

    const ano = Number(linha[iAno]);
    if (!anos.has(ano)) continue;

    const autor = (linha[idx(COL.autor)] ?? "").trim();
    const uf = (linha[idx(COL.uf)] ?? "").trim();
    const autorNorm = normalizarAutor(autor);
    const ufPE = uf.toUpperCase() === "PERNAMBUCO";

    let cat: CategoriaFederal | null = null;
    let partido: string | null = null;
    if (bancada.deputados.has(autorNorm)) {
      cat = "deputado";
      partido = bancada.deputados.get(autorNorm)?.partido ?? null;
    } else if (bancada.senadores.has(autorNorm)) {
      cat = "senador";
      partido = bancada.senadores.get(autorNorm)?.partido ?? null;
    } else if (autorNorm === BANCADA_PE) {
      cat = "bancada";
    } else if (ufPE) {
      cat = "gasto-pe";
      // auditoria: autor não casou com a bancada mas o gasto é em PE — pode ser
      // parlamentar de PE com grafia diferente nas APIs. Nunca silenciar.
      if (autorNorm && autorNorm !== "SEM INFORMACAO") naoCasados.add(autor);
    }
    if (!cat) continue;

    const municipioBruto = (linha[idx(COL.municipio)] ?? "").trim();
    const municipioNorm = normalizarAutor(municipioBruto);
    const municipio = ufPE && MUNICIPIOS_PE.has(municipioNorm) ? municipioNorm : null;

    out.push({
      codigo_emenda: (linha[iCodigo] ?? "").trim(),
      ano,
      numero_emenda: vazioParaNull(linha[idx(COL.numero)]),
      tipo_emenda: vazioParaNull(linha[idx(COL.tipo)]),
      autor,
      autor_normalizado: autorNorm,
      cat,
      partido,
      localidade: vazioParaNull(linha[idx(COL.localidade)]),
      municipio,
      uf: vazioParaNull(uf),
      funcao: vazioParaNull(linha[idx(COL.funcao)]),
      subfuncao: vazioParaNull(linha[idx(COL.subfuncao)]),
      vlrempenhado: paraNumero(linha[idx(COL.empenhado)]),
      vlrliquidado: paraNumero(linha[idx(COL.liquidado)]),
      vlrpago: paraNumero(linha[idx(COL.pago)]),
    });
    porCategoria[cat]++;
  }

  return { linhas: out, linhasArquivo: linhas.length - 1, porCategoria, autoresNaoCasados: [...naoCasados].sort() };
}

function vazioParaNull(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  return t.length === 0 || t === "Sem informação" || t === "S/I" ? null : t;
}

/** Valores vêm no formato brasileiro: "899920,98". */
function paraNumero(v: string | undefined): number | null {
  const t = (v ?? "").trim();
  if (!t) return null;
  const n = Number(t.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

async function fetchJson(url: string, config: Config, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, headers: { "User-Agent": config.http.userAgent, Accept: "application/json" } });
  if (!response.ok) throw new HarvestError("http", `${url} retornou ${response.status}`, { status: response.status });
  const text = await response.text();
  if (text.trim().length === 0) throw new HarvestError("empty", `${url} respondeu corpo vazio`);
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new HarvestError("parse", `${url} retornou JSON inválido`, { cause: err });
  }
}

function anosLegislatura(startYear: number): number[] {
  const atual = new Date().getFullYear();
  const anos: number[] = [];
  for (let a = startYear; a <= atual; a++) anos.push(a);
  return anos;
}
