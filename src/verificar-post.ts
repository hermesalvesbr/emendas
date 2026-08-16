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
import {
  agregadoPorAutorEstadual,
  agregadoPorAutorFederal,
  agregadoPorFuncao,
  agregadoPorFuncaoAno,
  agregadoPorMunicipio,
  agregadoPorRegiao,
  agregadoPorSubfuncao,
  curiosidadesPorMunicipio,
  globais,
  liderPorMunicipio,
} from "./agregados.ts";
import { pesoX } from "./post-x.ts";
import { POPULACAO_PE, POPULACAO_PE_TOTAL } from "./populacao-pe.ts";
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
// "mil" ANTES de "mi": na ordem inversa, "85 mil" casava como "85 mi" e virava
// 85 milhões — erro de mil vezes, silencioso se o valor acaso batesse.
const RE_NUMERO = /(R\$\s*)?((?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?)\s*(mil(?:hões|hão)?|bilhões|bilhão|bi|mi|%)?/gi;

/**
 * Marcador de citação legal imediatamente antes do número: "EC 86/2015",
 * "art. 166-A", "Lei 9.504/97", "§ 5º". Também cobre a continuação depois da
 * barra ("/97"), que sozinha não casa com o padrão de ano.
 */
const RE_CITACAO_LEGAL = /(?:\b(?:ECs?|emendas?\s+constitucionais?|arts?|artigos?|leis?|LCs?|res|resolu[çc][ãa]o|s[úu]mula|incisos?|MPs?)\.?\s*|§\s*|\d\/)$/i;

export function extrairNumeros(texto: string): NumeroCitado[] {
  const out: NumeroCitado[] = [];
  for (const m of texto.matchAll(RE_NUMERO)) {
    const [bruto, cifrao, corpo, sufixo] = m;
    if (!corpo) continue;

    // Ano solto (2023-2026) não é grandeza a conferir.
    if (!cifrao && !sufixo && /^(19|20)\d{2}$/.test(corpo)) continue;

    // Ordinal não é grandeza: o índice não tem como confirmá-lo, e ele casa
    // por acidente com qualquer fato pequeno — "2º Suplente" casava com as
    // emendas de Afrânio. Em contrapartida, template da série é proibido de
    // citar posição de ranking em número (usa "o maior de Pernambuco").
    if (!cifrao && !sufixo && /^[ºª°]/.test(texto.slice((m.index ?? 0) + bruto.length))) continue;

    // Citação legal é identificador, não medida — mesma natureza do ano solto
    // acima. Sem isto, "EC 86/2015" fazia o 86 casar com o per capita de Santa
    // Cruz da Baixa Verde, e "art. 166-A" ficava sem lastro: as duas ressalvas
    // que a lei OBRIGA a escrever reprovavam o post que as escrevia.
    // A conferência do texto da lei é trabalho do skill fonte-oficial.
    if (!cifrao && !sufixo && RE_CITACAO_LEGAL.test(texto.slice(0, m.index ?? 0))) continue;

    // Denominador de taxa é UNIDADE, não medida: em "7,1 candidatos por 100
    // mil habitantes", o 100 mil não afirma nada — quem afirma é o 7,1. Sem
    // esta regra, todo post per capita exigia um fato de valor 100.000 e
    // casava com qualquer emenda desse tamanho, em qualquer cidade.
    if (
      !cifrao &&
      /\bpor\s*$/i.test(texto.slice(0, m.index ?? 0)) &&
      /^\s*(habitantes?|moradores?|pessoas?|eleitores?)\b/i.test(texto.slice((m.index ?? 0) + bruto.length))
    ) {
      continue;
    }

    let valor = Number(corpo.replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(valor)) continue;

    const s = sufixo?.toLowerCase() ?? "";
    const escalaDe = (suf: string): number =>
      suf === "mil" ? 1e3 : suf.startsWith("bi") ? 1e9 : suf.startsWith("mil") || suf === "mi" ? 1e6 : 1;
    valor *= escalaDe(s);

    // A precisão escrita define quanto o autor está afirmando. Tolerância
    // fixa (2%) deixava "R$ 47,9 mi" casar com "R$ 47,4 mi" de outro fato
    // — falso negativo pego pelo eval "numero-inventado".
    const casasDecimais = corpo.includes(",") ? (corpo.split(",")[1]?.length ?? 0) : 0;
    const tolerancia = 0.5 * 10 ** -casasDecimais * escalaDe(s);

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

/**
 * De onde o fato vem. Existe porque o índice cresceu de ~1,7 mil para ~4,4 mil
 * fatos ao ganhar candidaturas e votação, e a diluição REABRIU dois erros que
 * já tinham sido publicados: "235 emendas" (contagem inflada) voltou a passar
 * casando com "candidatos que receberam voto em VERDEJANTE em 2022".
 *
 * Um post sobre emendas não pode ser validado por um fato de urna. "geo" é
 * transversal (população, malha) e entra em qualquer recorte.
 */
export type DominioFato = "emendas" | "candidaturas" | "votacao" | "geo";

/** Um número que o banco confirma, com a frase que o descreve. */
export type Fato = { valor: number; rotulo: string; dominio?: DominioFato };

/**
 * Constrói o índice de valores verificáveis a partir do banco: totais por
 * região, por município, contagens de candidatura e patrimônio. É este
 * conjunto que decide se um número do post "existe".
 */
export function indiceDeFatos(db: Database): Fato[] {
  const fatos: Fato[] = [];
  let dominioAtual: DominioFato = "emendas";
  const add = (valor: number, rotulo: string, dominio: DominioFato = dominioAtual): void => {
    if (Number.isFinite(valor) && valor > 0) fatos.push({ valor, rotulo, dominio });
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

  for (const r of db.query(`SELECT e.municipio m, COUNT(DISTINCT e.numero_emenda || "/" || e.exercicio_emenda) n
                            FROM emenda e JOIN empenho em ON substr(em.cd_nm_subacao,1,4) = e.subacao_codigo
                            WHERE e.municipio IS NOT NULL GROUP BY e.municipio`).all() as Array<{ m: string; n: number }>) {
    const fed = db.query(`SELECT COUNT(*) n FROM emenda_federal WHERE municipio = ?`).get(r.m) as { n: number };
    add(r.n + (fed?.n ?? 0), `emendas de ${r.m}`);
  }

  // Autor x município, com autoria CONFIRMADA — é o que todo post regional
  // cita ("fulano lidera com R$ X") e sem isso o número ficava sem lastro.
  for (const r of db.query(`SELECT e.municipio m, e.autor_normalizado a,
                                   COUNT(DISTINCT e.numero_emenda || "/" || e.exercicio_emenda) n,
                                   SUM(em.vlrempenhado) v
                            FROM emenda e JOIN empenho em ON substr(em.cd_nm_subacao,1,4) = e.subacao_codigo
                            WHERE e.municipio IS NOT NULL AND e.confianca = 'alta' AND e.autor_normalizado IS NOT NULL
                            GROUP BY e.municipio, e.autor_normalizado`).all() as Array<{ m: string; a: string; n: number; v: number }>) {
    add(r.v, `emendas de ${r.a} em ${r.m}`);
    add(r.n, `nº de emendas de ${r.a} em ${r.m}`);
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
    add(r.n, `candidatos a ${r.cargo}`, "candidaturas");
  }
  for (const r of db.query(`SELECT regiao, COUNT(*) n FROM candidato_2026
                            WHERE regiao IS NOT NULL GROUP BY regiao`).all() as Array<{ regiao: string; n: number }>) {
    add(r.n, `candidatos nascidos em ${r.regiao}`, "candidaturas");
  }
  const tot = db.query(`SELECT COUNT(*) n, SUM(total_bens) b FROM candidato_2026 WHERE detalhado = 1`).get() as { n: number; b: number };
  add(tot.n, "candidaturas detalhadas", "candidaturas");
  add(tot.b, "patrimônio declarado total", "candidaturas");
  add((db.query(`SELECT COUNT(*) n FROM candidato_2026 WHERE detalhado = 1 AND total_bens = 0`).get() as { n: number }).n, "candidatos que declararam zero", "candidaturas");
  for (const r of db.query(`SELECT nome_urna, total_bens b FROM candidato_2026
                            WHERE detalhado = 1 ORDER BY total_bens DESC LIMIT 20`).all() as Array<{ nome_urna: string; b: number }>) {
    add(r.b, `patrimônio de ${r.nome_urna}`, "candidaturas");
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

  // População (Censo 2022). Fato externo, mas versionado no projeto — já foi
  // escrita de memória duas vezes e publicada errada nas duas.
  for (const [m, p] of POPULACAO_PE) add(p, `população de ${m}`, "geo");
  add(POPULACAO_PE_TOTAL, "população de Pernambuco", "geo");
  const porRegiaoPop = new Map<string, number>();
  for (const [m, g] of MUNICIPIO_REGIAO) porRegiaoPop.set(g, (porRegiaoPop.get(g) ?? 0) + (POPULACAO_PE.get(m) ?? 0));
  for (const [g, p] of porRegiaoPop) add(p, `população da região ${g}`, "geo");

  // As 12 regiões vêm do mapa do IBGE agrupado, não de uma consulta — mas são
  // fato do projeto e aparecem em quase todo post da série.
  add(new Set(MUNICIPIO_REGIAO.values()).size, "regiões de PE no agrupamento do projeto", "geo");
  add(MUNICIPIO_REGIAO.size, "municípios de PE", "geo");

  // ------------------------------------------------------------- derivados
  //
  // Estes são calculados, não lidos — e por isso a tentação era declará-los
  // como `fatosExternos` no momento da geração. Seria tautologia: o gerador
  // calcularia X, declararia X como conferido e pediria ao verificador para
  // confirmar X. O verificador viraria carimbo, e um erro de universo no
  // gerador entraria no ar assinado como "conferido".
  //
  // Vindo daqui, eles são REDERIVADOS do banco no instante da publicação —
  // que é justamente a trava que importa quando o texto foi escrito num dia
  // e o dado mudou no outro.
  for (const m of agregadoPorMunicipio(db)) {
    if (m.porHabitante > 0) add(m.porHabitante, `R$ por habitante em ${m.municipio}`);
    add(m.n, `nº de emendas de ${m.municipio}`);
  }
  for (const r of agregadoPorRegiao(db)) {
    if (r.porHabitante > 0) add(r.porHabitante, `R$ por habitante na região ${r.regiao}`);
  }
  for (const a of agregadoPorAutorEstadual(db)) {
    add(a.v, `emendas estaduais de ${a.nome}`);
    add(a.n, `nº de emendas estaduais de ${a.nome}`);
    add(a.municipios, `municípios atendidos por ${a.nome}`);
  }
  for (const a of agregadoPorAutorFederal(db)) {
    add(a.v, `emendas federais de ${a.nome}`);
    add(a.n, `nº de emendas federais de ${a.nome}`);
  }
  for (const f of agregadoPorFuncao(db)) {
    add(f.n, `nº de emendas federais em ${f.funcao}`);
    add(f.autores, `autores de emendas federais em ${f.funcao}`);
  }
  for (const f of agregadoPorFuncaoAno(db)) {
    add(f.v, `emendas federais em ${f.funcao} em ${f.ano}`);
    add(f.n, `nº de emendas federais em ${f.funcao} em ${f.ano}`);
  }
  for (const s of agregadoPorSubfuncao(db)) {
    add(s.v, `emendas federais em ${s.subfuncao}`);
    add(s.n, `nº de emendas federais em ${s.subfuncao}`);
  }
  for (const l of liderPorMunicipio(db)) {
    add(l.v, `emendas de ${l.autorNome} em ${l.municipio}`);
    add(l.n, `nº de emendas de ${l.autorNome} em ${l.municipio}`);
  }

  // ---- candidaturas e votação de 2022, por município
  //
  // Sem estes, todo post de curiosidade (quantos candidatos nasceram na
  // cidade, quem foi o mais votado ali em 2022) seria reprovado por
  // numero-sem-lastro — o mesmo que aconteceu com o per capita.
  dominioAtual = "candidaturas";
  let semNativo = 0;
  for (const c of curiosidadesPorMunicipio(db)) {
    if (c.nascidos > 0) {
      add(c.nascidos, `candidatos de 2026 nascidos em ${c.municipio}`);
      if (c.por100Mil > 0) add(c.por100Mil, `candidatos por 100 mil habitantes em ${c.municipio}`);
    } else semNativo++;
    add(c.candidatos2022, `candidatos que receberam voto em ${c.municipio} em 2022`, "votacao");
    add(c.totalVotos2022, `votos nominais em ${c.municipio} em 2022`, "votacao");
    for (const [cargo, t] of Object.entries(c.top)) {
      if (t) add(t.votos, `votos de ${t.nome} para ${cargo} em ${c.municipio} em 2022`, "votacao");
    }
  }
  add(semNativo, "municípios de PE sem nenhum candidato nativo em 2026");
  dominioAtual = "emendas";

  const g = globais(db);
  add(g.municipiosComEmenda, "municípios com emenda (estadual ou federal)");
  add(g.municipiosSemEmenda, "municípios de PE sem nenhuma emenda no painel");

  // Número de urna da chapa majoritária. Sem isto, TODO post que assina "300"
  // é reprovado por numero-sem-lastro e a série de campanha cai em bloco.
  // Restrito ao cargo_codigo 5 (Senado e chapa de governo): incluir os 333
  // deputados federais despejaria 333 inteiros de 4 dígitos no índice e
  // arruinaria a regra numero-sem-lastro para essa faixa.
  for (const c of db
    .query(`SELECT nome_urna, numero, cargo FROM candidato_2026
            WHERE numero IS NOT NULL AND cargo_codigo = 5`)
    .all() as Array<{ nome_urna: string; numero: number; cargo: string }>) {
    add(c.numero, `número de urna de ${c.nome_urna} (${c.cargo})`, "candidaturas");
  }

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
  /**
   * Índice pré-construído. `indiceDeFatos` custa ~300 ms e devolve ~2 mil
   * fatos; verificar 392 posts reconstruindo a cada chamada seriam minutos
   * de rebuild puro.
   */
  fatos?: Fato[];
  /**
   * Tom exigido no fecho. "afirmativo" é o padrão desde que a série passou a
   * 8 posts por dia: pergunta só rende quando há alguém para responder nos 30
   * minutos seguintes, e com essa cadência não há.
   */
  tom?: "afirmativo" | "pergunta";
  /**
   * Rótulos dos fatos que o post AFIRMA citar. Quando presente, casar por
   * valor não basta — o fato que casou precisa ser um destes.
   */
  rotulosEsperados?: string[];
  /**
   * Domínios que o texto pode citar. Sem isto, um post sobre emendas é
   * validado por um fato de urna — foi o que reabriu dois erros já
   * publicados quando o índice ganhou candidaturas e votação. "geo" entra
   * sempre: população e malha são transversais.
   */
  dominios?: DominioFato[];
};

/**
 * Frases que a lei ou o dado não sustentam, mecanizando a seção "Nunca" do
 * skill post-do-dia. Erro, não aviso: nenhuma delas tem uso legítimo.
 */
const FRASES_PROIBIDAS: ReadonlyArray<{ re: RegExp; motivo: string }> = [
  {
    re: /\bn[ãa]o\s+(?:é|e|s[ãa]o)\s+candidat[oa]s?\b/i,
    motivo: "o marcador do TSE só sustenta o positivo; ausência na lista não prova nada (NOTAS 29)",
  },
  {
    re: /\brepresent[oa]\s+(?:a|o)\s+regi[ãa]o\b/i,
    motivo: "não existe distrito eleitoral no Brasil; ninguém representa uma região específica",
  },
];

/** Piso legal apresentado como escolha política — o erro do NOTAS 31. */
const RE_PISO_COMO_ESCOLHA = /\b(prioriz|escolh|optou|preferiu|elegeu)\w*\b[^.!?]{0,60}\bsa[úu]de\b/i;

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

  const tom = opts.tom ?? "afirmativo";
  const ultimaLinha = texto.trim().split("\n").at(-1) ?? "";
  if (tom === "afirmativo" && /\?/.test(ultimaLinha)) {
    achados.push({
      severidade: "aviso",
      regra: "pergunta-no-final",
      detalhe: "a série é afirmativa e informativa; fecho em pergunta não é o tom",
    });
  } else if (tom === "pergunta" && !/\?/.test(texto)) {
    achados.push({
      severidade: "aviso",
      regra: "sem-pergunta",
      detalhe: "resposta vale ~27x um like; post sem pergunta desperdiça o sinal mais forte",
    });
  }

  for (const { re, motivo } of FRASES_PROIBIDAS) {
    const m = texto.match(re);
    if (m) achados.push({ severidade: "erro", regra: "frase-proibida", detalhe: `"${m[0]}" — ${motivo}` });
  }

  const piso = texto.match(RE_PISO_COMO_ESCOLHA);
  if (piso) {
    achados.push({
      severidade: "aviso",
      regra: "piso-como-escolha",
      detalhe: `"${piso[0]}" — saúde lidera por piso de 50% (EC 86/2015 e EC 126/2022), não por decisão da bancada`,
    });
  }

  const todosFatos = [...(opts.fatos ?? indiceDeFatos(db)), ...(opts.fatosExternos ?? [])];
  const permitidos = opts.dominios ? new Set<DominioFato>([...opts.dominios, "geo"]) : null;
  // Fato externo declarado à mão não tem domínio e vale sempre: declarar é o
  // ato de assumir que se conferiu.
  const fatos = permitidos ? todosFatos.filter((f) => !f.dominio || permitidos.has(f.dominio)) : todosFatos;
  for (const n of extrairNumeros(texto)) {
    if (n.unidade === "percentual") continue; // percentual é derivado, não consta do índice
    const candidatos = fatos.filter((f) => casa(n, f.valor));
    if (candidatos.length === 0) {
      achados.push({
        severidade: "erro",
        regra: "numero-sem-lastro",
        detalhe: `"${n.bruto}" não casa com nenhum valor do banco nem com fato externo declarado`,
      });
      continue;
    }

    // Casar por valor NÃO garante casar por assunto. Medido: "Caruaru recebeu
    // R$ 45 por habitante" era aprovado porque 45 é o NÚMERO DE EMENDAS de
    // Caruaru. Num regime de 8 posts/dia sem revisão humana essa é a falha
    // dominante — silenciosa, com número plausível e cidade certa.
    const esperados = opts.rotulosEsperados;
    const bate = esperados ? candidatos.find((f) => esperados.includes(f.rotulo)) : candidatos[0];
    if (!bate) {
      achados.push({
        severidade: "erro",
        regra: "numero-rotulo-divergente",
        detalhe:
          `"${n.bruto}" casou com ${candidatos.map((c) => `"${c.rotulo}"`).join(", ")}, ` +
          `mas o post afirma ${esperados?.map((r) => `"${r}"`).join(" / ")}`,
      });
      continue;
    }
    achados.push({
      severidade: "aviso",
      regra: "numero-conferido",
      detalhe: `"${n.bruto}" confere com ${bate.rotulo}`,
    });
  }

  return { ok: !achados.some((a) => a.severidade === "erro"), peso, achados };
}
