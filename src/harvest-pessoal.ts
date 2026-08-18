// Quem trabalha no gabinete de cada deputado estadual — nome, cargo e vínculo.
//
// A ALEPE publica a lotação nominal em quatro lugares que NÃO concordam entre
// si. A hierarquia abaixo foi medida em 18/08/2026, não presumida (NOTAS 37):
//
//   A  /api/v1/servidores/       1.987 pessoas, 1.292 em 49 gabinetes.  CANÔNICA.
//   D  /api/v1/parlamentares/    49 titulares + partido. Casa com A em 47/49
//                                direto e nos 2 restantes por ALIAS_PARLAMENTAR.
//   B  fun/funcionarios.php      espelho LEGADO e DEFASADO: dos 101 admitidos
//                                desde 01/06/2026 que A lista, só 18 estão em B.
//                                Serve para matrícula, código de cargo e o
//                                roster com nome civil — NUNCA para contagem.
//   C  fun/mapaocupacaosetores   contagem oficial por setor + código do setor
//                                (1110xxx) + demissionários. Mesmo sistema de B,
//                                logo com a mesma defasagem.
//
// Por isso a contagem de assessores sai SÓ de A. B e C entram como
// enriquecimento (matrícula, código de setor) e como divergência registrada.
// Foi testado casar A↔B por sobreposição de nomes dentro do gabinete e o
// resultado é errado — "ANTONIO COELHO" casa com "EDSON VIEIRA" com 18 nomes em
// comum, e "WANDERSON FLORENCIO" com nenhum. Casamento é por rótulo, com alias
// explícito e auditável; o que não casar fica registrado, não é chutado.

import type { Db, NewGabinete, NewPessoalDivergencia, NewServidorAlepe } from "./db.ts";
import { parseCsv } from "./harvest-ckan.ts";
import { normalizarAutor } from "./normalize.ts";
import { HarvestError, insist } from "./retry.ts";
import type { Config } from "./types.ts";

// A barra final é obrigatória: sem ela a API responde 301 e o fetch do Bun
// entrega o HTML do redirect, não o JSON.
const API_SERVIDORES = "https://dadosabertos.alepe.pe.gov.br/api/v1/servidores/?formato=json";
const API_PARLAMENTARES = "https://dadosabertos.alepe.pe.gov.br/api/v1/parlamentares/?formato=json";
const CSV_FUNCIONARIOS = "https://www.alepe.pe.gov.br/servicos/transparencia/fun/funcionarios.php?formato=csv";
const MAPA_SETORES = "https://www.alepe.pe.gov.br/servicos/transparencia/fun/mapaocupacaosetores.php";

/** Rótulo de lotação de gabinete parlamentar. A grafa com espaço, B e C sem. */
const PREFIXO_GABINETE = /^GAB\.\s*DEP\.?\s*/;

/**
 * Gabinete (rótulo em A) → nome do parlamentar (rótulo em D). Só os dois casos
 * em que os dois sistemas da própria ALEPE escrevem o mesmo deputado diferente;
 * os outros 47 casam por igualdade. Lista explícita de propósito: casamento
 * difuso aqui erraria de deputado, que é o pior erro possível neste painel.
 */
export const ALIAS_PARLAMENTAR: Readonly<Record<string, string>> = {
  "DEL. GLEIDE ANGELO": "DELEGADA GLEIDE ANGELO",
  "NINO ENOQUE": "NINO DE ENOQUE",
};

/** Gabinete (rótulo em A) → rótulo do mesmo gabinete no sistema legado (B e C). */
export const ALIAS_LEGADO: Readonly<Record<string, string>> = {
  "CLAUDIANO MARTINS FILHO": "CLAUDIANO FILHO",
  "DEL. GLEIDE ANGELO": "DELEGADA GLEIDE ANGELO",
  "NINO ENOQUE": "NINO DE ENOQUE",
  // João Paulo Lima e Silva (PT). Não confundir com o gabinete "JOAO PAULO
  // COSTA", que existe separadamente nas duas fontes e casa por igualdade.
  "JOAO PAULO DO PT": "JOAO PAULO",
};

export type ServidorApi = {
  nome: string;
  codigo_lotacao: string;
  nome_lotacao: string;
  cargo_efetivo: string | null;
  cargo_nivel: string | null;
  vinculo: string;
  data_admissao: string | null;
};

export type FuncionarioCsv = {
  matricula: string;
  nome: string;
  cargo: string;
  cargo_codigo: string;
  nome_setor: string;
  codigo_setor: string;
  vinculo: string;
};

export type SetorOcupacao = {
  codigo_setor: string;
  nome: string;
  efetivos: number;
  comissionados: number;
  disposicao: number;
  demissionario: number;
};

export type ParlamentarAlepe = { nome: string; partido: string | null };

export type PessoalHarvestReport = {
  snapshot: string;
  gabinetes: number;
  pessoasEmGabinete: number;
  totalServidores: number;
  divergencias: number;
  fontesOk: string[];
  fontesFalhas: Array<{ fonte: string; motivo: string }>;
};

// ---------------------------------------------------------------- normalização

/** Uppercase sem acento e com espaços colapsados — mesma regra de autoria. */
function norm(texto: string | null | undefined): string {
  return normalizarAutor(texto ?? "");
}

/**
 * Chave canônica de um gabinete parlamentar a partir do rótulo de lotação.
 * `null` quando a lotação não é gabinete de deputado (comissões, diretorias).
 */
export function chaveGabinete(nomeLotacao: string | null | undefined): string | null {
  const n = norm(nomeLotacao);
  if (!PREFIXO_GABINETE.test(n)) return null;
  const chave = n.replace(PREFIXO_GABINETE, "").trim();
  return chave.length > 0 ? chave : null;
}

// ------------------------------------------------------------------- parsers

/** A — dados abertos. `SEQ` e `SITUACAO` estão na doc do portal mas não vêm no corpo. */
export function parseServidoresApi(json: string): ServidorApi[] {
  let bruto: unknown;
  try {
    bruto = JSON.parse(json);
  } catch (err) {
    throw new HarvestError("parse", "servidores: corpo não é JSON", { cause: err });
  }
  if (!Array.isArray(bruto)) throw new HarvestError("parse", "servidores: JSON não é lista");

  return bruto.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      nome: String(row.NOME ?? "").trim(),
      codigo_lotacao: String(row.CODIGO_LOTACAO ?? "").trim(),
      nome_lotacao: String(row.NOME_LOTACAO ?? "").trim(),
      cargo_efetivo: vazioParaNulo(row.CARGO_EFETIVO),
      cargo_nivel: vazioParaNulo(row.CARGO_NIVEL),
      vinculo: String(row.VINCULO ?? "").trim(),
      // DATA_ADMISSAO não é string ISO: vem como { date, timezone_type, timezone }.
      data_admissao: extrairData(row.DATA_ADMISSAO),
    };
  });
}

function extrairData(valor: unknown): string | null {
  if (typeof valor === "string") return valor.slice(0, 10) || null;
  if (valor && typeof valor === "object" && "date" in valor) {
    const d = (valor as { date?: unknown }).date;
    return typeof d === "string" ? d.slice(0, 10) : null;
  }
  return null;
}

function vazioParaNulo(valor: unknown): string | null {
  const s = String(valor ?? "").trim();
  return s.length > 0 ? s : null;
}

/**
 * B — CSV do sistema legado. Servido como `text/csv;charset=UTF-8` e **não é
 * UTF-8**: é ISO-8859-1, o mesmo engano do arquivo da CGU (harvest-federal).
 */
export function parseFuncionariosCsv(bytes: ArrayBuffer | Uint8Array): FuncionarioCsv[] {
  // O tipo de TextDecoder no @types/bun não lista os rótulos legados, mas o
  // runtime aceita "iso-8859-1" — mesmo cast pontual de harvest-federal.ts:294.
  const texto = new TextDecoder("iso-8859-1" as unknown as undefined).decode(bytes);
  const linhas = parseCsv(texto, ",");
  const cabecalho = linhas[0];
  if (!cabecalho) throw new HarvestError("parse", "funcionarios.php: CSV vazio");

  const idx = new Map(cabecalho.map((c, i) => [c.trim().toLowerCase(), i] as const));
  for (const obrigatoria of ["mat", "nome", "nomecargo", "nomesetor", "setor", "vinculo"]) {
    if (!idx.has(obrigatoria)) {
      throw new HarvestError("parse", `funcionarios.php: coluna "${obrigatoria}" ausente`);
    }
  }
  const col = (linha: string[], nome: string): string => (linha[idx.get(nome) ?? -1] ?? "").trim();

  return linhas.slice(1).map((linha) => ({
    matricula: col(linha, "mat"),
    nome: col(linha, "nome"),
    cargo: col(linha, "nomecargo"),
    cargo_codigo: col(linha, "cargo"),
    nome_setor: col(linha, "nomesetor"),
    codigo_setor: col(linha, "setor"),
    vinculo: col(linha, "vinculo"),
  }));
}

/** C — ocupação por setor. É a única fonte do código de setor (1110xxx). */
export function parseMapaOcupacao(json: string): SetorOcupacao[] {
  let bruto: unknown;
  try {
    bruto = JSON.parse(json);
  } catch (err) {
    throw new HarvestError("parse", "mapaocupacaosetores: corpo não é JSON", { cause: err });
  }
  if (!Array.isArray(bruto)) throw new HarvestError("parse", "mapaocupacaosetores: JSON não é lista");

  return bruto.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      codigo_setor: String(row.id ?? "").trim(),
      nome: String(row.nome ?? "").trim(),
      efetivos: Number(row.efetivos ?? 0),
      comissionados: Number(row.comissionados ?? 0),
      disposicao: Number(row.disposicao ?? 0),
      demissionario: Number(row.demissionario ?? 0),
    };
  });
}

/** D — roster de titulares com partido. */
export function parseParlamentares(json: string): ParlamentarAlepe[] {
  let bruto: unknown;
  try {
    bruto = JSON.parse(json);
  } catch (err) {
    throw new HarvestError("parse", "parlamentares: corpo não é JSON", { cause: err });
  }
  if (!Array.isArray(bruto)) throw new HarvestError("parse", "parlamentares: JSON não é lista");

  return bruto.map((r) => {
    const row = r as Record<string, unknown>;
    return { nome: String(row.nomeParlamentar ?? "").trim(), partido: vazioParaNulo(row.partido) };
  });
}

// ------------------------------------------------------------- reconciliação

export type Reconciliacao = {
  gabinetes: NewGabinete[];
  servidores: NewServidorAlepe[];
  divergencias: NewPessoalDivergencia[];
};

/**
 * Junta as quatro fontes num snapshot.
 *
 * A contagem por gabinete vem SÓ de A. B e C só acrescentam colunas (matrícula,
 * código de setor) e produzem linhas de divergência quando discordam — nunca
 * alteram quem está lotado onde.
 */
export function reconciliar(
  snapshot: string,
  api: ServidorApi[],
  csv: FuncionarioCsv[],
  mapa: SetorOcupacao[],
  parlamentares: ParlamentarAlepe[],
): Reconciliacao {
  const divergencias: NewPessoalDivergencia[] = [];
  const div = (escopo: NewPessoalDivergencia["escopo"], chave: string, tipo: NewPessoalDivergencia["tipo"], detalhe: string) =>
    divergencias.push({ snapshot, escopo, chave, tipo, detalhe });

  // --- matrícula por nome, do legado. Homônimo perde a matrícula em vez de
  // receber a de outra pessoa: identidade errada é pior que identidade ausente.
  const porNomeCsv = new Map<string, FuncionarioCsv[]>();
  for (const f of csv) {
    const chave = norm(f.nome);
    if (!chave) continue;
    const lista = porNomeCsv.get(chave);
    if (lista) lista.push(f);
    else porNomeCsv.set(chave, [f]);
  }

  // --- índices do legado por rótulo de gabinete
  const setorPorChave = new Map<string, SetorOcupacao>();
  for (const s of mapa) {
    const chave = chaveGabinete(s.nome);
    if (chave) setorPorChave.set(chave, s);
  }
  const legadoPorChave = new Map<string, FuncionarioCsv[]>();
  for (const f of csv) {
    const chave = chaveGabinete(f.nome_setor);
    if (!chave) continue;
    const lista = legadoPorChave.get(chave);
    if (lista) lista.push(f);
    else legadoPorChave.set(chave, [f]);
  }

  // --- roster de titulares
  const partidoPorNome = new Map<string, ParlamentarAlepe>();
  for (const p of parlamentares) partidoPorNome.set(norm(p.nome), p);
  // O legado registra o deputado pelo NOME CIVIL ("ALVARO PORTO DE BARROS"),
  // não pelo nome parlamentar ("Álvaro Porto") — casar por igualdade não acha
  // nenhum. A regra abaixo é frouxa o bastante para casar e apertada o
  // bastante para não trocar de deputado: os tokens do nome parlamentar têm de
  // aparecer NA ORDEM no nome civil, e o casamento tem de ser único. "JOAO
  // PAULO" cai fora de propósito — casaria com dois deputados diferentes.
  const roster = csv.filter((f) => f.vinculo.toUpperCase() === "PARLAMENTAR");

  // --- servidores: uma linha por pessoa em A, com a matrícula do legado quando
  //     ela existe lá. Quem só está no legado NÃO entra: é gente desligada.
  const servidores: NewServidorAlepe[] = [];
  const emGabinete = new Map<string, ServidorApi[]>();

  for (const s of api) {
    const chaveGab = chaveGabinete(s.nome_lotacao);
    if (chaveGab) {
      const lista = emGabinete.get(chaveGab);
      if (lista) lista.push(s);
      else emGabinete.set(chaveGab, [s]);
    }
    const nomeNorm = norm(s.nome);
    const candidatos = porNomeCsv.get(nomeNorm) ?? [];
    const legado = candidatos.length === 1 ? candidatos[0] : undefined;
    if (candidatos.length > 1) {
      div("pessoa", nomeNorm, "homonimo", `${candidatos.length} matrículas com este nome no legado — matrícula não atribuída`);
    }
    servidores.push({
      snapshot,
      chave: legado?.matricula || nomeNorm,
      matricula: legado?.matricula ?? null,
      nome: s.nome,
      nome_normalizado: nomeNorm,
      cargo: s.cargo_nivel ?? s.cargo_efetivo,
      cargo_codigo: legado?.cargo_codigo ?? null,
      vinculo: s.vinculo,
      codigo_lotacao: s.codigo_lotacao || null,
      nome_lotacao: s.nome_lotacao || null,
      gabinete_chave: chaveGab,
      data_admissao: s.data_admissao,
      no_legado: legado ? 1 : 0,
    });
  }

  // --- gabinetes
  const gabinetes: NewGabinete[] = [];
  for (const [chave, pessoas] of [...emGabinete].sort(([a], [b]) => a.localeCompare(b))) {
    const nomeParlamentar = ALIAS_PARLAMENTAR[chave] ?? chave;
    const titular = partidoPorNome.get(nomeParlamentar);
    if (!titular) {
      div("gabinete", chave, "sem-titular", `gabinete sem par no roster de parlamentares (${nomeParlamentar})`);
    }
    const chaveLegado = ALIAS_LEGADO[chave] ?? chave;
    const setor = setorPorChave.get(chaveLegado);
    if (!setor) {
      div("gabinete", chave, "so-atual", `sem par no sistema legado (procurado como "${chaveLegado}") — titular novo`);
    } else {
      const oficial = setor.comissionados + setor.disposicao + setor.efetivos;
      if (oficial !== pessoas.length) {
        div(
          "gabinete",
          chave,
          "contagem",
          `dados abertos: ${pessoas.length} · mapa de ocupação (legado): ${oficial} (${setor.comissionados} com. + ${setor.disposicao} à disp. + ${setor.efetivos} efet., ${setor.demissionario} demissionário(s))`,
        );
      }
    }
    const civil = casarNomeCivil(nomeParlamentar, roster);

    gabinetes.push({
      chave,
      rotulo_api: pessoas[0]?.nome_lotacao ?? chave,
      rotulo_legado: setor?.nome ?? null,
      codigo_setor: setor?.codigo_setor ?? null,
      codigo_lotacao: pessoas[0]?.codigo_lotacao ?? null,
      deputado_nome: titular?.nome ?? nomeParlamentar,
      deputado_normalizado: normalizarAutor(titular?.nome ?? nomeParlamentar),
      deputado_matricula: civil?.matricula ?? null,
      deputado_nome_civil: civil?.nome ?? null,
      partido: titular?.partido ?? null,
      total: pessoas.length,
      total_legado: setor ? setor.comissionados + setor.disposicao + setor.efetivos : null,
      demissionarios: setor?.demissionario ?? null,
      atualizado_em: snapshot,
    });
  }

  // Gabinetes que o legado tem e o atual não: titular substituído. Registrado
  // para que a troca fique visível, não para entrar na contagem.
  const chavesAtuais = new Set([...emGabinete.keys()].map((c) => ALIAS_LEGADO[c] ?? c));
  for (const [chave, setor] of setorPorChave) {
    if (chavesAtuais.has(chave)) continue;
    const n = legadoPorChave.get(chave)?.length ?? 0;
    div("gabinete", chave, "so-legado", `só no sistema legado, com ${n} pessoa(s) — titular provavelmente substituído (setor ${setor.codigo_setor})`);
  }

  return { gabinetes, servidores, divergencias };
}

/**
 * Casa o nome parlamentar com o nome civil no roster do legado. Devolve
 * `undefined` quando não há casamento OU quando há mais de um — identidade
 * ambígua fica sem matrícula em vez de virar a matrícula de outra pessoa.
 */
export function casarNomeCivil(nomeParlamentar: string, roster: FuncionarioCsv[]): FuncionarioCsv | undefined {
  const alvo = nomeParlamentar.split(" ").filter(Boolean);
  if (alvo.length === 0) return undefined;

  const casam = roster.filter((f) => contemNaOrdem(norm(f.nome).split(" ").filter(Boolean), alvo));
  return casam.length === 1 ? casam[0] : undefined;
}

/** Todos os tokens de `alvo` aparecem em `tokens` na mesma ordem relativa. */
function contemNaOrdem(tokens: string[], alvo: string[]): boolean {
  let i = 0;
  for (const t of tokens) {
    if (t === alvo[i]) i++;
    if (i === alvo.length) return true;
  }
  return false;
}

// ---------------------------------------------------------------- orquestração

export async function harvestPessoal(db: Db, config: Config): Promise<PessoalHarvestReport> {
  const retryOpts = {
    maxAttempts: config.retry.maxAttempts,
    baseMs: config.retry.baseMs,
    capMs: config.retry.capMs,
    timeoutMs: config.retry.timeoutMs,
  };
  const snapshot = new Date().toISOString().slice(0, 10);
  const fontesOk: string[] = [];
  const fontesFalhas: Array<{ fonte: string; motivo: string }> = [];

  const texto = async (alvo: string, url: string): Promise<string | null> => {
    const attempt = await insist(alvo, (signal) => fetchTexto(url, config, signal), retryOpts);
    if (!attempt.ok) {
      db.logHarvest({
        alvo,
        exercicio: null,
        status: attempt.reason,
        tentativas: attempt.attempts,
        http_status: attempt.status ?? null,
        duracao_ms: null,
        mensagem: attempt.lastError.message,
      });
      fontesFalhas.push({ fonte: alvo, motivo: attempt.lastError.message });
      return null;
    }
    fontesOk.push(alvo);
    return attempt.value;
  };

  // A é a única fonte da contagem: sem ela não há snapshot que preste.
  const brutoApi = await texto("pessoal:servidores", API_SERVIDORES);
  if (brutoApi === null) {
    throw new Error("pessoal: a API de servidores da ALEPE não respondeu — snapshot não gravado");
  }
  await writeRawImmutable("servidores", "json", brutoApi);
  const api = parseServidoresApi(brutoApi);

  const brutoParl = await texto("pessoal:parlamentares", API_PARLAMENTARES);
  if (brutoParl !== null) await writeRawImmutable("parlamentares", "json", brutoParl);
  const parlamentares = brutoParl === null ? [] : parseParlamentares(brutoParl);

  const brutoMapa = await texto("pessoal:mapa-setores", MAPA_SETORES);
  if (brutoMapa !== null) await writeRawImmutable("mapa-setores", "json", brutoMapa);
  const mapa = brutoMapa === null ? [] : parseMapaOcupacao(brutoMapa);

  // O CSV é binário latin-1, então não passa pelo helper de texto.
  const attemptCsv = await insist("pessoal:funcionarios-csv", (signal) => fetchBytes(CSV_FUNCIONARIOS, config, signal), retryOpts);
  let csv: FuncionarioCsv[] = [];
  if (attemptCsv.ok) {
    fontesOk.push("pessoal:funcionarios-csv");
    await Bun.write(caminhoRaw("funcionarios", "csv"), attemptCsv.value);
    csv = parseFuncionariosCsv(attemptCsv.value);
  } else {
    db.logHarvest({
      alvo: "pessoal:funcionarios-csv",
      exercicio: null,
      status: attemptCsv.reason,
      tentativas: attemptCsv.attempts,
      http_status: attemptCsv.status ?? null,
      duracao_ms: null,
      mensagem: attemptCsv.lastError.message,
    });
    fontesFalhas.push({ fonte: "pessoal:funcionarios-csv", motivo: attemptCsv.lastError.message });
  }

  const { gabinetes, servidores, divergencias } = reconciliar(snapshot, api, csv, mapa, parlamentares);

  // Invariante no espírito de export-site: a soma dos gabinetes tem de ser
  // exatamente a quantidade de pessoas lotadas em gabinete no snapshot.
  const somaGabinetes = gabinetes.reduce((acc, g) => acc + g.total, 0);
  const pessoasEmGabinete = servidores.filter((s) => s.gabinete_chave !== null).length;
  if (somaGabinetes !== pessoasEmGabinete) {
    throw new Error(`pessoal: soma dos gabinetes (${somaGabinetes}) diverge das pessoas lotadas (${pessoasEmGabinete})`);
  }

  db.gravarSnapshotPessoal(snapshot, gabinetes, servidores, divergencias);
  db.logHarvest({
    alvo: "pessoal",
    exercicio: null,
    status: "ok",
    tentativas: 1,
    http_status: 200,
    duracao_ms: null,
    mensagem: `${gabinetes.length} gabinete(s), ${pessoasEmGabinete} em gabinete, ${servidores.length} servidores, ${divergencias.length} divergência(s)`,
  });

  return {
    snapshot,
    gabinetes: gabinetes.length,
    pessoasEmGabinete,
    totalServidores: servidores.length,
    divergencias: divergencias.length,
    fontesOk,
    fontesFalhas,
  };
}

async function fetchTexto(url: string, config: Config, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal, headers: { "User-Agent": config.http.userAgent } });
  if (!response.ok) {
    throw new HarvestError("http", `${url} retornou ${response.status}`, { status: response.status });
  }
  const body = await response.text();
  if (body.trim().length === 0) throw new HarvestError("empty", `${url} respondeu corpo vazio`);
  return body;
}

async function fetchBytes(url: string, config: Config, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal, headers: { "User-Agent": config.http.userAgent } });
  if (!response.ok) {
    throw new HarvestError("http", `${url} retornou ${response.status}`, { status: response.status });
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0) throw new HarvestError("empty", `${url} respondeu corpo vazio`);
  return bytes;
}

function caminhoRaw(fonte: string, ext: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `data/raw/pessoal/${fonte}/${timestamp}.${ext}`;
}

async function writeRawImmutable(fonte: string, ext: string, corpo: string): Promise<void> {
  await Bun.write(caminhoRaw(fonte, ext), corpo);
}
