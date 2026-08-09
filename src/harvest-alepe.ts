// Autoria OFICIAL de emendas, direto da ALEPE (dados abertos de proposições).
//
// O detalhe de cada PLOA (Projeto de Lei Orçamentária Anual) na API
// dadosabertos.alepe.pe.gov.br inclui o bloco <emendas><emenda numero=.. ano=..>
// <autores><autor nome=.. tipo=..>. É o mapeamento (numero, ano) -> deputado
// autor que nenhuma outra fonte pública oferece para 2014-2025 — formato
// provado pelo parser do bundle oficial do portal proposicoes.alepe.pe.gov.br
// (ver NOTAS.md item 19). A API cai com frequência ("Erro na conexão com o
// banco de dados", HTTP 200) — por isso tudo aqui passa por insist() e o
// worker do cron reexecuta a cada disparo até conseguir.

import type { Db, NewAutoriaOficial } from "./db.ts";
import { classificarAutorTipo, normalizarAutor } from "./normalize.ts";
import { HarvestError, insist } from "./retry.ts";
import type { Config } from "./types.ts";

const API_PROJETOS = "https://dadosabertos.alepe.pe.gov.br/api/v1/proposicoes/projetos/";
const TIPO_PLOA = "PROJETO DE LEI ORÇAMENTÁRIA ANUAL";
// 17ª: 2011-2014 · 18ª: 2015-2018 · 19ª: 2019-2022 · 20ª: 2023-2026
const LEGISLATURAS = [17, 18, 19, 20] as const;

export type PloaRef = { docid: string; numero: string; ano: number };

export type AlepePloaResult = {
  ploa: string;
  status: "ok" | "empty" | "http" | "timeout" | "parse";
  emendas: number;
  comAutor: number;
};

export type AlepeHarvestReport = {
  ploas: AlepePloaResult[];
  totalAutoriaOficial: number;
  elevadas: number;
  discordancias: number;
};

export async function harvestAlepe(db: Db, config: Config): Promise<AlepeHarvestReport> {
  const retryOpts = {
    maxAttempts: config.retry.maxAttempts,
    baseMs: config.retry.baseMs,
    capMs: config.retry.capMs,
    timeoutMs: Math.max(config.retry.timeoutMs, 60_000),
  };

  const ploas: PloaRef[] = [];
  for (const legislatura of LEGISLATURAS) {
    const attempt = await insist(
      `alepe:legislatura-${legislatura}`,
      (signal) => fetchXml(`${API_PROJETOS}?legislatura=${legislatura}`, config, signal),
      retryOpts,
    );
    if (!attempt.ok) {
      db.logHarvest({
        alvo: `alepe:legislatura-${legislatura}`,
        exercicio: null,
        status: attempt.reason,
        tentativas: attempt.attempts,
        http_status: attempt.status ?? null,
        duracao_ms: null,
        mensagem: attempt.lastError.message,
      });
      continue;
    }
    ploas.push(...extrairPloas(attempt.value));
  }

  const resultados: AlepePloaResult[] = [];
  for (const ploa of ploas) {
    resultados.push(await harvestPloa(db, config, ploa, retryOpts));
  }

  const aplicacao = db.aplicarAutoriaOficial();
  return {
    ploas: resultados,
    totalAutoriaOficial: db.countAutoriaOficial(),
    elevadas: aplicacao.elevadas,
    discordancias: aplicacao.discordancias.length,
  };
}

async function harvestPloa(
  db: Db,
  config: Config,
  ploa: PloaRef,
  retryOpts: { maxAttempts: number; baseMs: number; capMs: number; timeoutMs: number },
): Promise<AlepePloaResult> {
  const label = `alepe:ploa-${ploa.numero}/${ploa.ano}`;
  const attempt = await insist(
    label,
    (signal) => fetchXml(`${API_PROJETOS}?numero=${ploa.numero}&ano=${ploa.ano}`, config, signal),
    retryOpts,
  );

  if (!attempt.ok) {
    db.logHarvest({
      alvo: label,
      exercicio: ploa.ano + 1,
      status: attempt.reason,
      tentativas: attempt.attempts,
      http_status: attempt.status ?? null,
      duracao_ms: null,
      mensagem: attempt.lastError.message,
    });
    return { ploa: `${ploa.numero}/${ploa.ano}`, status: attempt.reason, emendas: 0, comAutor: 0 };
  }

  await writeRawImmutable(ploa, attempt.value);
  const emendas = parseEmendasXml(attempt.value);

  let comAutor = 0;
  for (const emenda of emendas) {
    const row = paraAutoriaOficial(emenda, ploa);
    if (!row) continue;
    db.upsertAutoriaOficial(row);
    comAutor++;
  }

  db.logHarvest({
    alvo: label,
    exercicio: ploa.ano + 1,
    status: "ok",
    tentativas: attempt.attempts,
    http_status: 200,
    duracao_ms: Math.round(attempt.elapsedMs),
    mensagem: `${emendas.length} emenda(s) no PLOA, ${comAutor} com autor`,
  });
  return { ploa: `${ploa.numero}/${ploa.ano}`, status: "ok", emendas: emendas.length, comAutor };
}

async function fetchXml(url: string, config: Config, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal, headers: { "User-Agent": config.http.userAgent } });
  if (!response.ok) {
    throw new HarvestError("http", `${url} retornou ${response.status}`, { status: response.status });
  }
  const body = await response.text();
  if (body.trim().length === 0) throw new HarvestError("empty", `${url} respondeu corpo vazio`);
  // A API devolve HTTP 200 com <error> quando o banco dela está fora — é
  // transitório (observado dias inteiros), então retryable como "http".
  if (body.includes("<error>")) {
    const msg = /<message>([^<]*)<\/message>/.exec(body)?.[1] ?? "erro desconhecido da API";
    throw new HarvestError("http", `API ALEPE: ${msg}`, { status: 200 });
  }
  return body;
}

/** Extrai os PLOAs da listagem de uma legislatura. */
export function extrairPloas(xml: string): PloaRef[] {
  const ploas: PloaRef[] = [];
  const rewriter = new HTMLRewriter();
  rewriter.on("projeto", {
    element(el) {
      if ((el.getAttribute("tipo") ?? "").trim().toUpperCase() !== TIPO_PLOA) return;
      const docid = el.getAttribute("docid") ?? "";
      const numero = el.getAttribute("numero") ?? "";
      const ano = Number(el.getAttribute("ano") ?? "");
      if (docid && numero && Number.isInteger(ano)) ploas.push({ docid, numero, ano });
    },
  });
  rewriter.transform(xml);
  return ploas;
}

export type EmendaAlepe = {
  numero: string;
  ano: number;
  autores: Array<{ nome: string; tipo: string }>;
};

/** Parseia o bloco <emendas> do detalhe de um PLOA (formato provado pelo bundle oficial). */
export function parseEmendasXml(xml: string): EmendaAlepe[] {
  const emendas: EmendaAlepe[] = [];
  let atual: EmendaAlepe | null = null;

  const rewriter = new HTMLRewriter();
  rewriter.on("emenda", {
    element(el) {
      const numero = el.getAttribute("numero") ?? "";
      const ano = Number(el.getAttribute("ano") ?? "");
      atual = numero && Number.isInteger(ano) ? { numero, ano, autores: [] } : null;
      if (atual) emendas.push(atual);
    },
  });
  rewriter.on("emenda autor", {
    element(el) {
      const nome = (el.getAttribute("nome") ?? "").trim();
      if (atual && nome) atual.autores.push({ nome, tipo: (el.getAttribute("tipo") ?? "").trim() });
    },
  });
  rewriter.transform(xml);
  return emendas;
}

function paraAutoriaOficial(emenda: EmendaAlepe, ploa: PloaRef): NewAutoriaOficial | null {
  if (emenda.autores.length === 0) return null;

  const nomes = emenda.autores.map((a) => a.nome);
  const autorNome = nomes.join(" E ");
  const coletiva = emenda.autores.length > 1 || emenda.autores.some((a) => a.tipo.toUpperCase() !== "DEPUTADO");

  return {
    numero_emenda: emenda.numero,
    exercicio_apresentacao: emenda.ano,
    // PLOA apresentado no ano X orça o exercício X+1 — os empenhos citam ora
    // "650/2022" (apresentação), ora "650/2023" (LOA); gravamos os dois anos.
    exercicio_loa: ploa.ano + 1,
    autor_nome: autorNome,
    autor_normalizado: normalizarAutor(autorNome),
    autor_tipo: coletiva ? "coletiva" : classificarAutorTipo(nomes[0] ?? ""),
    ploa: `${ploa.numero}/${ploa.ano}`,
  };
}

async function writeRawImmutable(ploa: PloaRef, xml: string): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await Bun.write(`data/raw/alepe/ploa-${ploa.numero}-${ploa.ano}/${timestamp}.xml`, xml);
}
