// Fonte ÚNICA dos recortes que vão para texto público.
//
// Existe por causa do erro que já foi ao ar: os 12 posts regionais contavam
// TODAS as emendas ligadas ao município — inclusive as sem empenho no escopo —
// e casavam essa contagem com um valor em reais que só somava as com empenho.
// Dois universos numa frase só, inflando de 1,3x a 1,9x. O bug nasceu de duas
// cópias do mesmo SQL divergindo (uma no gerador do texto, outra no
// verificador). Aqui há uma cópia só, e `n` e `v` sempre saem da MESMA query.
//
// REGRA DURA: nenhuma função deste módulo devolve `n` e `v` vindos de queries
// diferentes. Se um recorte precisar de contagem de outro universo, ela sai
// com outro nome (ex.: `nDicionario`) e o template fica proibido de pôr esse
// campo na mesma frase que `v`.

import type { Database } from "bun:sqlite";
import { COD_IBGE, nomeMunicipio } from "./nomes-pe.ts";
import { POPULACAO_PE } from "./populacao-pe.ts";
import { MUNICIPIO_REGIAO, REGIOES_PE, type RegiaoPE } from "./regioes-pe.ts";
import { normalizarAutor } from "./normalize.ts";

// --------------------------------------------------------------- município

export type AgregadoMunicipio = {
  /** Chave normalizada, como no banco ("SAO VICENTE FERRER"). */
  municipio: string;
  /** Nome de exibição, acentuado ("São Vicente Férrer"). */
  nome: string;
  regiao: RegiaoPE | null;
  populacao: number;
  /** Emendas distintas (estaduais + federais) com execução no escopo. */
  n: number;
  /** R$ empenhado — do MESMO conjunto que produziu `n`. */
  v: number;
  /** v / populacao. Zero quando a população é desconhecida. */
  porHabitante: number;
};

/**
 * Estadual: o universo é a emenda que TEM empenho no escopo — é o join que
 * produz o valor, então é o mesmo que produz a contagem.
 */
const SQL_MUN_ESTADUAL = `
  SELECT e.municipio AS m,
         COUNT(DISTINCT e.numero_emenda || '/' || e.exercicio_emenda) AS n,
         SUM(em.vlrempenhado) AS v
  FROM emenda e
  JOIN empenho em ON substr(em.cd_nm_subacao, 1, 4) = e.subacao_codigo
  WHERE e.municipio IS NOT NULL
  GROUP BY e.municipio`;

const SQL_MUN_FEDERAL = `
  SELECT municipio AS m, COUNT(*) AS n, SUM(vlrempenhado) AS v
  FROM emenda_federal
  WHERE municipio IS NOT NULL
  GROUP BY municipio`;

type LinhaNV = { m: string; n: number; v: number };

export function agregadoPorMunicipio(db: Database): AgregadoMunicipio[] {
  const acc = new Map<string, { n: number; v: number }>();
  const somar = (linhas: LinhaNV[]): void => {
    for (const r of linhas) {
      const cur = acc.get(r.m) ?? { n: 0, v: 0 };
      acc.set(r.m, { n: cur.n + (r.n ?? 0), v: cur.v + (r.v ?? 0) });
    }
  };
  somar(db.query(SQL_MUN_ESTADUAL).all() as LinhaNV[]);
  somar(db.query(SQL_MUN_FEDERAL).all() as LinhaNV[]);

  const saida: AgregadoMunicipio[] = [];
  for (const [municipio, { n, v }] of acc) {
    const populacao = POPULACAO_PE.get(municipio) ?? 0;
    saida.push({
      municipio,
      nome: nomeMunicipio(municipio),
      regiao: MUNICIPIO_REGIAO.get(municipio) ?? null,
      populacao,
      n,
      v,
      porHabitante: populacao > 0 ? v / populacao : 0,
    });
  }
  return saida.sort((a, b) => b.v - a.v);
}

// ------------------------------------------------------------------ região

export type AgregadoRegiao = {
  regiao: RegiaoPE;
  populacao: number;
  /** Municípios da região que têm alguma emenda no painel. */
  municipiosComEmenda: number;
  /** Municípios que a região tem no mapa do IBGE — outro universo, outro nome. */
  municipiosExistentes: number;
  n: number;
  v: number;
  porHabitante: number;
};

export function agregadoPorRegiao(db: Database): AgregadoRegiao[] {
  const porMun = agregadoPorMunicipio(db);
  const existentes = new Map<RegiaoPE, number>();
  const popRegiao = new Map<RegiaoPE, number>();
  for (const [m, g] of MUNICIPIO_REGIAO) {
    existentes.set(g, (existentes.get(g) ?? 0) + 1);
    popRegiao.set(g, (popRegiao.get(g) ?? 0) + (POPULACAO_PE.get(m) ?? 0));
  }

  const acc = new Map<RegiaoPE, { n: number; v: number; muns: number }>();
  for (const m of porMun) {
    if (!m.regiao) continue;
    const cur = acc.get(m.regiao) ?? { n: 0, v: 0, muns: 0 };
    // `n` somado por município CONTA A MESMA EMENDA VÁRIAS VEZES quando ela
    // atende mais de uma cidade — foi assim que o Agreste Central virou 317.
    // Por isso a contagem regional vem de query própria, abaixo.
    acc.set(m.regiao, { n: cur.n, v: cur.v + m.v, muns: cur.muns + 1 });
  }

  const municipiosPorRegiao = new Map<RegiaoPE, string[]>();
  for (const [m, g] of MUNICIPIO_REGIAO) {
    const lista = municipiosPorRegiao.get(g);
    if (lista) lista.push(m);
    else municipiosPorRegiao.set(g, [m]);
  }

  const saida: AgregadoRegiao[] = [];
  for (const [regiao, ms] of municipiosPorRegiao) {
    const marcadores = ms.map(() => "?").join(",");
    const est = db
      .query(`SELECT COUNT(DISTINCT e.numero_emenda || '/' || e.exercicio_emenda) AS n
              FROM emenda e
              JOIN empenho em ON substr(em.cd_nm_subacao, 1, 4) = e.subacao_codigo
              WHERE e.municipio IN (${marcadores})`)
      .get(...ms) as { n: number };
    const fed = db
      .query(`SELECT COUNT(*) AS n FROM emenda_federal WHERE municipio IN (${marcadores})`)
      .get(...ms) as { n: number };

    const a = acc.get(regiao) ?? { n: 0, v: 0, muns: 0 };
    const populacao = popRegiao.get(regiao) ?? 0;
    const v = a.v;
    saida.push({
      regiao,
      populacao,
      municipiosComEmenda: a.muns,
      municipiosExistentes: existentes.get(regiao) ?? ms.length,
      n: (est?.n ?? 0) + (fed?.n ?? 0),
      v,
      porHabitante: populacao > 0 ? v / populacao : 0,
    });
  }
  return saida.sort((a, b) => b.v - a.v);
}

// ------------------------------------------------------------------- autor

export type AgregadoAutor = {
  /** autor_normalizado — a chave do banco. */
  chave: string;
  /** Nome canônico e acentuado, do dicionário oficial. */
  nome: string;
  esfera: "estadual" | "federal";
  partido: string | null;
  n: number;
  v: number;
  /** Municípios distintos atendidos — outro universo, por isso outro nome. */
  municipios: number;
};

/**
 * Só autores que existem no dicionário oficial da ALEPE.
 *
 * A catraca não é preciosismo: `emenda.confianca = 'alta'` tem 110 autores
 * distintos e entre eles estão ": EDUI", "APORTE FINANCEIRO" e "ADALTO
 * SANTOS." — sobras de regex sobre texto livre. Num regime de 8 posts por dia
 * sem revisão humana, "APORTE FINANCEIRO lidera com R$ 3,2 mi" vai ao ar.
 * `autoria_oficial` vem do XML dos PLOAs e tem o nome como a ALEPE escreve.
 */
const SQL_AUTOR_ESTADUAL = `
  SELECT e.autor_normalizado AS chave,
         COUNT(DISTINCT e.numero_emenda || '/' || e.exercicio_emenda) AS n,
         SUM(em.vlrempenhado) AS v,
         COUNT(DISTINCT e.municipio) AS municipios
  FROM emenda e
  JOIN empenho em ON substr(em.cd_nm_subacao, 1, 4) = e.subacao_codigo
  WHERE e.confianca = 'alta'
    AND e.autor_normalizado IS NOT NULL
    AND e.autor_normalizado IN (SELECT autor_normalizado FROM autoria_oficial)
  GROUP BY e.autor_normalizado`;

export function agregadoPorAutorEstadual(db: Database): AgregadoAutor[] {
  const nomes = new Map<string, string>();
  for (const r of db
    .query(`SELECT autor_normalizado AS k, autor_nome AS nome FROM autoria_oficial
            WHERE autor_nome IS NOT NULL GROUP BY autor_normalizado`)
    .all() as Array<{ k: string; nome: string }>) {
    nomes.set(r.k, r.nome);
  }

  return (db.query(SQL_AUTOR_ESTADUAL).all() as Array<Omit<AgregadoAutor, "nome" | "esfera" | "partido">>)
    .map((r) => ({ ...r, nome: nomes.get(r.chave) ?? r.chave, esfera: "estadual" as const, partido: null }))
    .filter((a) => a.v > 0)
    .sort((a, b) => b.v - a.v);
}

/**
 * Federal. "BANCADA DE PERNAMBUCO" é rótulo coletivo, não pessoa: fica de
 * fora dos rankings de autor para não competir com parlamentares individuais
 * (é a maior linha do banco, R$ 1,36 bi, e distorceria todo template).
 */
export function agregadoPorAutorFederal(db: Database): AgregadoAutor[] {
  return (
    db
      .query(`SELECT ef.autor_normalizado AS chave,
                     COALESCE(pf.nome, ef.autor) AS nome,
                     MIN(ef.partido) AS partido,
                     COUNT(*) AS n,
                     SUM(ef.vlrempenhado) AS v,
                     COUNT(DISTINCT ef.municipio) AS municipios
              FROM emenda_federal ef
              LEFT JOIN parlamentar_federal pf ON pf.nome_normalizado = ef.autor_normalizado
              WHERE ef.autor_normalizado IS NOT NULL
                AND ef.cat IN ('deputado', 'senador')
              GROUP BY ef.autor_normalizado`)
      .all() as Array<Omit<AgregadoAutor, "esfera">>
  )
    .map((r) => ({ ...r, esfera: "federal" as const }))
    .filter((a) => a.v > 0)
    .sort((a, b) => b.v - a.v);
}

// ------------------------------------------------------------------ função

export type AgregadoFuncao = {
  funcao: string;
  n: number;
  v: number;
  /** Autores distintos que assinaram nessa função — outro universo, outro nome. */
  autores: number;
};

export function agregadoPorFuncao(db: Database): AgregadoFuncao[] {
  return (
    db
      .query(`SELECT COALESCE(funcao, 'Não informada') AS funcao,
                     COUNT(*) AS n,
                     SUM(vlrempenhado) AS v,
                     COUNT(DISTINCT autor_normalizado) AS autores
              FROM emenda_federal
              GROUP BY COALESCE(funcao, 'Não informada')`)
      .all() as AgregadoFuncao[]
  )
    .filter((f) => f.v > 0)
    .sort((a, b) => b.v - a.v);
}

export type AgregadoFuncaoAno = AgregadoFuncao & { ano: number };

export function agregadoPorFuncaoAno(db: Database): AgregadoFuncaoAno[] {
  return (
    db
      .query(`SELECT COALESCE(funcao, 'Não informada') AS funcao, ano,
                     COUNT(*) AS n,
                     SUM(vlrempenhado) AS v,
                     COUNT(DISTINCT autor_normalizado) AS autores
              FROM emenda_federal
              WHERE ano IS NOT NULL
              GROUP BY COALESCE(funcao, 'Não informada'), ano`)
      .all() as AgregadoFuncaoAno[]
  )
    .filter((f) => f.v > 0)
    .sort((a, b) => b.v - a.v);
}

export type AgregadoSubfuncao = { funcao: string; subfuncao: string; n: number; v: number };

export function agregadoPorSubfuncao(db: Database): AgregadoSubfuncao[] {
  return (
    db
      .query(`SELECT COALESCE(funcao, 'Não informada') AS funcao,
                     COALESCE(subfuncao, 'Não informada') AS subfuncao,
                     COUNT(*) AS n, SUM(vlrempenhado) AS v
              FROM emenda_federal
              WHERE subfuncao IS NOT NULL
              GROUP BY COALESCE(funcao, 'Não informada'), COALESCE(subfuncao, 'Não informada')`)
      .all() as AgregadoSubfuncao[]
  )
    .filter((f) => f.v > 0)
    .sort((a, b) => b.v - a.v);
}

// ----------------------------------------------------- autor x município

export type AgregadoAutorMunicipio = {
  municipio: string;
  nome: string;
  /** Necessária no texto: é o post em que cidade e pessoa aparecem juntas. */
  regiao: RegiaoPE | null;
  autorChave: string;
  autorNome: string;
  n: number;
  v: number;
};

/** Quem lidera, por autoria CONFIRMADA, em cada município. Um por município. */
export function liderPorMunicipio(db: Database): AgregadoAutorMunicipio[] {
  const nomes = new Map<string, string>();
  for (const r of db
    .query(`SELECT autor_normalizado AS k, autor_nome AS nome FROM autoria_oficial
            WHERE autor_nome IS NOT NULL GROUP BY autor_normalizado`)
    .all() as Array<{ k: string; nome: string }>) {
    nomes.set(r.k, r.nome);
  }

  const linhas = db
    .query(`SELECT e.municipio AS municipio, e.autor_normalizado AS autorChave,
                   COUNT(DISTINCT e.numero_emenda || '/' || e.exercicio_emenda) AS n,
                   SUM(em.vlrempenhado) AS v
            FROM emenda e
            JOIN empenho em ON substr(em.cd_nm_subacao, 1, 4) = e.subacao_codigo
            WHERE e.municipio IS NOT NULL
              AND e.confianca = 'alta'
              AND e.autor_normalizado IS NOT NULL
              AND e.autor_normalizado IN (SELECT autor_normalizado FROM autoria_oficial)
            GROUP BY e.municipio, e.autor_normalizado`)
    .all() as Array<{ municipio: string; autorChave: string; n: number; v: number }>;

  const melhor = new Map<string, AgregadoAutorMunicipio>();
  for (const r of linhas) {
    if (r.v <= 0) continue;
    const atual = melhor.get(r.municipio);
    if (atual && atual.v >= r.v) continue;
    melhor.set(r.municipio, {
      municipio: r.municipio,
      nome: nomeMunicipio(r.municipio),
      regiao: MUNICIPIO_REGIAO.get(r.municipio) ?? null,
      autorChave: r.autorChave,
      autorNome: nomes.get(r.autorChave) ?? r.autorChave,
      n: r.n,
      v: r.v,
    });
  }
  return [...melhor.values()].sort((a, b) => b.v - a.v);
}

// ------------------------------------------------------------------ globais

export type Globais = {
  /** Municípios com alguma emenda (estadual OU federal) — a união. */
  municipiosComEmenda: number;
  /** Municípios de PE sem nenhuma emenda no painel. */
  municipiosSemEmenda: number;
  totalEstadual: number;
  totalFederal: number;
};

export function globais(db: Database): Globais {
  const porMun = agregadoPorMunicipio(db);
  const comEmenda = porMun.filter((m) => m.v > 0).length;
  const est = db.query(`SELECT SUM(vlrempenhado) AS v FROM empenho`).get() as { v: number | null };
  const fed = db.query(`SELECT SUM(vlrempenhado) AS v FROM emenda_federal`).get() as { v: number | null };
  return {
    municipiosComEmenda: comEmenda,
    municipiosSemEmenda: MUNICIPIO_REGIAO.size - comEmenda,
    totalEstadual: est?.v ?? 0,
    totalFederal: fed?.v ?? 0,
  };
}

// ------------------------------------------- origem e base dos candidatos

export type OrigemMunicipio = {
  municipio: string;
  nome: string;
  codIbge: string | null;
  regiao: RegiaoPE | null;
  populacao: number;
  candidatos: number;
  /** Candidatos nascidos ali por 100 mil habitantes. */
  por100Mil: number;
};

/**
 * Quantos candidatos de 2026 nasceram em cada município de PE.
 *
 * Devolve TODOS os 185 municípios, inclusive os que não produziram nenhum —
 * o mapa precisa deles e o zero é a informação mais interessante do recorte
 * (89 municípios não têm nenhum nativo candidato). Cuidado de leitura, NOTAS
 * 29 e 30: isso é "nenhum nativo concorrendo", NUNCA "ninguém disputa lá" —
 * a circunscrição em PE é única.
 */
export function origemPorMunicipio(db: Database): OrigemMunicipio[] {
  const contagem = new Map<string, number>();
  for (const r of db
    .query(`SELECT municipio_nascimento AS m, COUNT(*) AS n FROM candidato_2026
            WHERE uf_nascimento = 'PE' AND municipio_nascimento IS NOT NULL
            GROUP BY municipio_nascimento`)
    .all() as Array<{ m: string; n: number }>) {
    contagem.set(normalizarAutor(r.m), r.n);
  }

  const out: OrigemMunicipio[] = [];
  for (const [municipio, regiao] of MUNICIPIO_REGIAO) {
    const populacao = POPULACAO_PE.get(municipio) ?? 0;
    const candidatos = contagem.get(municipio) ?? 0;
    out.push({
      municipio,
      nome: nomeMunicipio(municipio),
      codIbge: COD_IBGE.get(municipio) ?? null,
      regiao,
      populacao,
      candidatos,
      por100Mil: populacao > 0 ? (candidatos / populacao) * 1e5 : 0,
    });
  }
  return out.sort((a, b) => b.candidatos - a.candidatos);
}

export type OrigemRegiao = {
  /** null = nascido fora de PE. Nunca redistribuído numa região qualquer. */
  regiao: RegiaoPE | null;
  rotulo: string;
  populacao: number;
  candidatos: number;
  por100Mil: number;
};

export function origemPorRegiao(db: Database): OrigemRegiao[] {
  const contagem = new Map<string, number>();
  for (const r of db
    .query(`SELECT COALESCE(regiao, '') AS g, COUNT(*) AS n FROM candidato_2026 GROUP BY COALESCE(regiao, '')`)
    .all() as Array<{ g: string; n: number }>) {
    contagem.set(r.g, r.n);
  }

  const pop = new Map<string, number>();
  for (const [m, g] of MUNICIPIO_REGIAO) pop.set(g, (pop.get(g) ?? 0) + (POPULACAO_PE.get(m) ?? 0));

  const out: OrigemRegiao[] = [];
  for (const g of REGIOES_PE) {
    const candidatos = contagem.get(g) ?? 0;
    const populacao = pop.get(g) ?? 0;
    out.push({ regiao: g, rotulo: g, populacao, candidatos, por100Mil: populacao > 0 ? (candidatos / populacao) * 1e5 : 0 });
  }
  const fora = contagem.get("") ?? 0;
  if (fora > 0) {
    // Sem população de referência: são 19 UFs diferentes. por100Mil = 0 e o
    // front não deve oferecer o modo per capita para este grupo.
    out.push({ regiao: null, rotulo: "(nascido fora de PE)", populacao: 0, candidatos: fora, por100Mil: 0 });
  }
  return out.sort((a, b) => b.candidatos - a.candidatos);
}

export type BaseEleitoral = {
  candidatoId: number;
  nome: string;
  cargo2026: string;
  partido: string | null;
  municipioNascimento: string | null;
  ufNascimento: string | null;
  regiaoNascimento: RegiaoPE | null;
  cargo2022: string | null;
  totalVotos: number;
  /** Município onde teve mais votos em 2022. */
  municipioTop: string | null;
  nomeMunicipioTop: string | null;
  votosTop: number;
  regiaoTop: RegiaoPE | null;
  /** % dos votos na região de nascimento. null quando nasceu fora de PE. */
  pctNaRegiaoNatal: number | null;
  /** % dos votos no próprio município de nascimento. */
  pctNoMunicipioNatal: number | null;
  /**
   * Índice de Herfindahl dos votos por município: 1 = tudo num município só,
   * perto de 0 = pulverizado pelo estado. Separa quem tem reduto de quem tem
   * voto difuso.
   */
  concentracao: number;
  /** Municípios em que teve ao menos um voto. */
  municipiosComVoto: number;
  /**
   * Votos por município, compacto: [códigoIBGE, votos].
   *
   * O nome do município sairia repetido ~44 mil vezes no JSON público (2,4 MB
   * contra 0,9 MB). O front já tem a lista de municípios e resolve o nome pelo
   * código — repetir aqui seria pagar banda por dado derivável.
   */
  votosPorMunicipio: Array<[string, number]>;
};

/**
 * Perfil eleitoral de quem concorreu em 2022 e concorre de novo em 2026.
 *
 * Só 1º turno: no 2º turno a maioria dos cargos já saiu da urna, e misturar
 * os dois somaria universos diferentes — o mesmo erro de universo que já foi
 * publicado neste projeto.
 */
export function baseEleitoral(db: Database): BaseEleitoral[] {
  const linhas = db
    .query(`SELECT v.candidato_2026_id AS id, v.municipio, v.votos, v.cargo,
                   c.nome_urna, c.cargo AS cargo2026, c.partido,
                   c.municipio_nascimento, c.uf_nascimento, c.regiao
            FROM votacao_2022 v
            JOIN candidato_2026 c ON c.id = v.candidato_2026_id
            WHERE v.nr_turno = 1 AND v.votos > 0`)
    .all() as Array<{
      id: number; municipio: string; votos: number; cargo: string | null;
      nome_urna: string; cargo2026: string; partido: string | null;
      municipio_nascimento: string | null; uf_nascimento: string | null; regiao: RegiaoPE | null;
    }>;

  const porCandidato = new Map<number, BaseEleitoral & { _mapa: Map<string, number> }>();
  for (const l of linhas) {
    let c = porCandidato.get(l.id);
    if (!c) {
      c = {
        candidatoId: l.id, nome: l.nome_urna, cargo2026: l.cargo2026, partido: l.partido,
        municipioNascimento: l.municipio_nascimento ? normalizarAutor(l.municipio_nascimento) : null,
        ufNascimento: l.uf_nascimento, regiaoNascimento: l.regiao,
        cargo2022: l.cargo, totalVotos: 0, municipioTop: null, nomeMunicipioTop: null,
        votosTop: 0, regiaoTop: null, pctNaRegiaoNatal: null, pctNoMunicipioNatal: null,
        concentracao: 0, municipiosComVoto: 0, votosPorMunicipio: [],
        _mapa: new Map(),
      };
      porCandidato.set(l.id, c);
    }
    c._mapa.set(l.municipio, (c._mapa.get(l.municipio) ?? 0) + l.votos);
    c.totalVotos += l.votos;
  }

  const out: BaseEleitoral[] = [];
  for (const c of porCandidato.values()) {
    const { _mapa, ...base } = c;
    let votosNaRegiao = 0;
    let hhi = 0;
    for (const [m, v] of _mapa) {
      const frac = v / c.totalVotos;
      hhi += frac * frac;
      if (c.regiaoNascimento && MUNICIPIO_REGIAO.get(m) === c.regiaoNascimento) votosNaRegiao += v;
      if (v > base.votosTop) {
        base.votosTop = v;
        base.municipioTop = m;
        base.nomeMunicipioTop = nomeMunicipio(m);
        base.regiaoTop = MUNICIPIO_REGIAO.get(m) ?? null;
      }
    }
    base.concentracao = hhi;
    base.municipiosComVoto = _mapa.size;
    base.pctNaRegiaoNatal = c.regiaoNascimento ? (votosNaRegiao / c.totalVotos) * 100 : null;
    base.pctNoMunicipioNatal =
      c.municipioNascimento && c.ufNascimento === "PE"
        ? ((_mapa.get(c.municipioNascimento) ?? 0) / c.totalVotos) * 100
        : null;
    base.votosPorMunicipio = [..._mapa]
      .map(([municipio, votos]) => [COD_IBGE.get(municipio) ?? municipio, votos] as [string, number])
      .sort((a, b) => b[1] - a[1]);
    out.push(base);
  }
  return out.sort((a, b) => b.totalVotos - a.totalVotos);
}
