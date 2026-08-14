// Verificador de post antes da publicação.
//
// Existe por causa de uma falha real e repetida: números escritos de memória
// em vez de consultados. Dois posts foram ao ar com população errada
// (Casinhas "14 mil" para 12.967; Jaqueira "12 mil" para 10.247) e um post do
// plano tratava o piso constitucional da saúde como escolha da bancada.
//
// A regra que este módulo impõe: todo número citado num texto público tem de
// existir no banco ou na lista de fatos externos declarados. O que não casar
// é apontado — não silenciosamente aceito.

import { Database } from "bun:sqlite";
import { pesoX } from "./post-x.ts";
import { MUNICIPIO_REGIAO } from "./regioes-pe.ts";

export type Achado = {
  severidade: "erro" | "aviso";
  regra: string;
  detalhe: string;
};

export type Veredito = {
  ok: boolean;
  peso: number;
  achados: Achado[];
};

// ------------------------------------------------------------------ números

/** Números em pt-BR no texto: 12.967 · R$ 8,0 mi · 57,7% · 4,24 bi */
export type NumeroCitado = {
  bruto: string;
  valor: number;
  unidade: "reais" | "percentual" | "puro";
  /** Metade da última casa escrita: "8,5 mi" afirma 8,45–8,55, não 8,0–8,7. */
  tolerancia: number;
};

// A alternância precisa exigir o separador de milhar no PRIMEIRO ramo. Com
// `\d{1,3}(?:\.\d{3})*` na frente, "12967" casava como "129" e depois "67" —
// todo número de 4+ dígitos sem ponto era partido ao meio.
const RE_NUMERO = /(R\$\s*)?((?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?)\s*(mi(?:lhões|lhão)?|bi(?:lhões|lhão)?|mil|%)?/gi;

export function extrairNumeros(texto: string): NumeroCitado[] {
  const out: NumeroCitado[] = [];
  for (const m of texto.matchAll(RE_NUMERO)) {
    const [bruto, cifrao, corpo, sufixo] = m;
    if (!corpo) continue;

    // Ano solto (2023-2026) não é grandeza a conferir.
    if (!cifrao && !sufixo && /^(19|20)\d{2}$/.test(corpo)) continue;

    let valor = Number(corpo.replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(valor)) continue;

    const s = sufixo?.toLowerCase() ?? "";
    if (s.startsWith("mi")) valor *= 1e6;
    else if (s.startsWith("bi")) valor *= 1e9;
    else if (s === "mil") valor *= 1e3;

    // A precisão escrita define quanto o autor está afirmando. Tolerância
    // fixa (2%) deixava "R$ 47,9 mi" casar com "R$ 47,4 mi" de outro fato
    // — falso negativo pego pelo eval "numero-inventado".
    const casasDecimais = corpo.includes(",") ? (corpo.split(",")[1]?.length ?? 0) : 0;
    const escala = s.startsWith("mi") ? 1e6 : s.startsWith("bi") ? 1e9 : s === "mil" ? 1e3 : 1;
    const tolerancia = (0.5 * 10 ** -casasDecimais) * escala;

    out.push({
      bruto: bruto.trim(),
      valor,
      unidade: s === "%" ? "percentual" : cifrao ? "reais" : "puro",
      tolerancia,
    });
  }
  return out;
}

// -------------------------------------------------------------------- fatos

/** Um número que o banco confirma, com a frase que o descreve. */
export type Fato = { valor: number; rotulo: string };

/**
 * Constrói o índice de valores verificáveis a partir do banco: totais por
 * região, por município, contagens de candidatura e patrimônio. É este
 * conjunto que decide se um número do post "existe".
 */
export function indiceDeFatos(db: Database): Fato[] {
  const fatos: Fato[] = [];
  const add = (valor: number, rotulo: string): void => {
    if (Number.isFinite(valor) && valor > 0) fatos.push({ valor, rotulo });
  };

  const porMunicipio = new Map<string, number>();
  const q = `SELECT e.municipio m, SUM(em.vlrempenhado) v FROM emenda e
             JOIN empenho em ON substr(em.cd_nm_subacao,1,4) = e.subacao_codigo
             WHERE e.municipio IS NOT NULL GROUP BY e.municipio`;
  for (const r of db.query(q).all() as Array<{ m: string; v: number }>) {
    porMunicipio.set(r.m, (porMunicipio.get(r.m) ?? 0) + (r.v ?? 0));
  }
  for (const r of db.query(`SELECT municipio m, SUM(vlrempenhado) v FROM emenda_federal
                            WHERE municipio IS NOT NULL GROUP BY municipio`).all() as Array<{ m: string; v: number }>) {
    porMunicipio.set(r.m, (porMunicipio.get(r.m) ?? 0) + (r.v ?? 0));
  }

  const porRegiao = new Map<string, number>();
  for (const [m, v] of porMunicipio) {
    add(v, `emendas de ${m}`);
    const g = MUNICIPIO_REGIAO.get(m);
    if (g) porRegiao.set(g, (porRegiao.get(g) ?? 0) + v);
  }
  for (const [g, v] of porRegiao) add(v, `emendas da região ${g}`);

  // Contagens por região. Precisa ser DISTINCT sobre a região inteira, não
  // soma por município: a mesma emenda pode aparecer em vários municípios e a
  // soma inflaria. Foi exatamente esse erro que foi publicado — "317 emendas"
  // no Agreste Central quando as que produzem o valor citado são 204.
  // E o universo é o das emendas COM empenho no escopo, o mesmo que gera o
  // valor em reais; casar contagem de um universo com valor de outro é o bug.
  const municipiosPorRegiao = new Map<string, string[]>();
  for (const [m, g] of MUNICIPIO_REGIAO) {
    const lista = municipiosPorRegiao.get(g);
    if (lista) lista.push(m);
    else municipiosPorRegiao.set(g, [m]);
  }
  for (const [g, ms] of municipiosPorRegiao) {
    const marcadores = ms.map(() => "?").join(",");
    const est = db
      .query(`SELECT COUNT(DISTINCT e.numero_emenda || "/" || e.exercicio_emenda) n
              FROM emenda e JOIN empenho em ON substr(em.cd_nm_subacao,1,4) = e.subacao_codigo
              WHERE e.municipio IN (${marcadores})`)
      .get(...ms) as { n: number };
    const fed = db
      .query(`SELECT COUNT(*) n, COUNT(DISTINCT municipio) m FROM emenda_federal WHERE municipio IN (${marcadores})`)
      .get(...ms) as { n: number; m: number };
    const mun = db
      .query(`SELECT COUNT(DISTINCT municipio) c FROM emenda
              WHERE municipio IN (${marcadores})
                AND EXISTS (SELECT 1 FROM empenho em WHERE substr(em.cd_nm_subacao,1,4) = emenda.subacao_codigo)`)
      .get(...ms) as { c: number };
    add(est.n + fed.n, `emendas com execução na região ${g}`);
    add(Math.max(mun.c, fed.m), `municípios com emenda na região ${g}`);
    // Total da região, que é diferente de "com emenda" — a diferença entre os
    // dois é justamente onde moram os achados (Santa Filomena, no Araripe).
    add(ms.length, `municípios existentes na região ${g}`);
  }

  for (const r of db.query(`SELECT cargo, COUNT(*) n FROM candidato_2026 GROUP BY cargo`).all() as Array<{ cargo: string; n: number }>) {
    add(r.n, `candidatos a ${r.cargo}`);
  }
  for (const r of db.query(`SELECT regiao, COUNT(*) n FROM candidato_2026
                            WHERE regiao IS NOT NULL GROUP BY regiao`).all() as Array<{ regiao: string; n: number }>) {
    add(r.n, `candidatos nascidos em ${r.regiao}`);
  }
  const tot = db.query(`SELECT COUNT(*) n, SUM(total_bens) b FROM candidato_2026 WHERE detalhado = 1`).get() as { n: number; b: number };
  add(tot.n, "candidaturas detalhadas");
  add(tot.b, "patrimônio declarado total");
  add((db.query(`SELECT COUNT(*) n FROM candidato_2026 WHERE detalhado = 1 AND total_bens = 0`).get() as { n: number }).n, "candidatos que declararam zero");
  for (const r of db.query(`SELECT nome_urna, total_bens b FROM candidato_2026
                            WHERE detalhado = 1 ORDER BY total_bens DESC LIMIT 20`).all() as Array<{ nome_urna: string; b: number }>) {
    add(r.b, `patrimônio de ${r.nome_urna}`);
  }
  for (const r of db.query(`SELECT funcao, SUM(vlrempenhado) v FROM emenda_federal GROUP BY funcao`).all() as Array<{ funcao: string; v: number }>) {
    add(r.v, `emendas federais em ${r.funcao ?? "?"}`);
  }

  // Totais globais — o post de abertura cita os dois, e sem eles ficavam sem
  // lastro mesmo estando corretos no painel.
  // Universo inteiro coletado, que é o que o painel exibe como KPI. Filtrar
  // por "tem emenda identificada" daria 265 mi e divergiria do site — dois
  // universos outra vez.
  add((db.query(`SELECT SUM(vlrempenhado) v FROM empenho`).get() as { v: number }).v, "total empenhado em emendas estaduais (painel)");
  add(
    (db.query(`SELECT SUM(em.vlrempenhado) v FROM empenho em
               WHERE EXISTS (SELECT 1 FROM emenda e WHERE e.subacao_codigo = substr(em.cd_nm_subacao,1,4))`)
      .get() as { v: number }).v,
    "empenhado apenas nas emendas identificadas",
  );
  add((db.query(`SELECT SUM(vlrempenhado) v FROM emenda_federal`).get() as { v: number }).v, "total empenhado em emendas federais");
  add((db.query(`SELECT COUNT(DISTINCT municipio) c FROM emenda WHERE municipio IS NOT NULL`).get() as { c: number }).c, "municípios com emenda estadual");

  // Qualidade da autoria — contagem DISTINTA de emendas, não linhas do join.
  // A soma por join dava 426 e eu já a publiquei como "426 emendas"; as
  // emendas distintas sem autor são 238. Quarta vez que o mesmo padrão morde.
  for (const r of db.query(`SELECT e.confianca c, COUNT(DISTINCT e.numero_emenda || "/" || e.exercicio_emenda) n,
                                   SUM(em.vlrempenhado) v
                            FROM emenda e JOIN empenho em ON substr(em.cd_nm_subacao,1,4) = e.subacao_codigo
                            GROUP BY e.confianca`).all() as Array<{ c: string; n: number; v: number }>) {
    add(r.n, `emendas com autoria "${r.c}"`);
    add(r.v, `valor das emendas com autoria "${r.c}"`);
  }

  // As 12 regiões vêm do mapa do IBGE agrupado, não de uma consulta — mas são
  // fato do projeto e aparecem em quase todo post da série.
  add(new Set(MUNICIPIO_REGIAO.values()).size, "regiões de PE no agrupamento do projeto");
  add(MUNICIPIO_REGIAO.size, "municípios de PE");

  return fatos;
}

/** Casa quando o fato cai dentro da precisão que o post declarou. */
function casa(n: NumeroCitado, fato: number): boolean {
  return Math.abs(n.valor - fato) <= n.tolerancia;
}

// ------------------------------------------------------------------ regras

export type OpcoesVerificacao = {
  /** Números que vêm de fora do banco (IBGE, lei) e já foram conferidos à mão. */
  fatosExternos?: Fato[];
  /** Post de abertura/fecho pode levar link; os do meio da série, não. */
  permitirLink?: boolean;
};

export function verificarPost(texto: string, db: Database, opts: OpcoesVerificacao = {}): Veredito {
  const achados: Achado[] = [];
  const peso = pesoX(texto);

  if (peso > 280) {
    achados.push({ severidade: "erro", regra: "peso", detalhe: `${peso}/280 — não cabe num post` });
  }

  const temLink = /https?:\/\/\S+/.test(texto);
  if (temLink && !opts.permitirLink) {
    achados.push({
      severidade: "erro",
      regra: "link-no-post",
      detalhe: "link no corpo derruba o alcance em 50–90%; ponha na primeira resposta",
    });
  }

  if (!/\?/.test(texto)) {
    achados.push({
      severidade: "aviso",
      regra: "sem-pergunta",
      detalhe: "resposta vale ~27x um like; post sem pergunta desperdiça o sinal mais forte",
    });
  }

  const fatos = [...indiceDeFatos(db), ...(opts.fatosExternos ?? [])];
  for (const n of extrairNumeros(texto)) {
    if (n.unidade === "percentual") continue; // percentual é derivado, não consta do índice
    const bate = fatos.find((f) => casa(n, f.valor));
    if (!bate) {
      achados.push({
        severidade: "erro",
        regra: "numero-sem-lastro",
        detalhe: `"${n.bruto}" não casa com nenhum valor do banco nem com fato externo declarado`,
      });
      continue;
    }
    // Casar por valor não garante que seja o MESMO assunto: "R$ 47,9 mi" já
    // casou com um fato sem relação. O rótulo vai no aviso para leitura humana.
    achados.push({
      severidade: "aviso",
      regra: "numero-conferido",
      detalhe: `"${n.bruto}" confere com ${bate.rotulo}`,
    });
  }

  return { ok: !achados.some((a) => a.severidade === "erro"), peso, achados };
}
