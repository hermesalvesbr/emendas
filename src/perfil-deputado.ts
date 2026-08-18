// Perfil completo de um deputado estadual — a junção das cinco camadas que o
// projeto já coleta, resolvida AQUI e não no navegador.
//
// Por que no servidor: cada camada nomeia a mesma pessoa de um jeito. A Alepe
// usa nome parlamentar ("Nino de Enoque"), o TSE usa nome de urna de 2022
// ("SILENO") e nome civil ("SILENO SOUSA GUEDES"), o painel de emendas usa o
// autor normalizado do PLOA. Fazer isso em JavaScript no cliente seria repetir
// a regra em quatro lugares e deixá-la sem teste. A chave canônica é
// `gabinete.deputado_normalizado`, e cada casamento que não fecha vira campo
// nulo com motivo — nunca palpite (NOTAS 37 e 38).
//
// Cobertura medida em 18/08/2026, com os 49 gabinetes:
//   emendas (autoria oficial da ALEPE) ... 48/49  (Cayo Albino assumiu agora)
//   votação de 2022 ...................... 47/49  (42 por urna + 5 por civil)
//   candidatura 2026 ..................... 39/49  (marcador é positivo-only)

import type { Database } from "bun:sqlite";
import { nomeProprioSuave } from "./agregados.ts";
import { custoDoGabinete, indexarRemuneracao } from "./custo-pessoal.ts";
import type { TabelaRemuneracao } from "./custo-pessoal.ts";
import type { Db, GabineteRow } from "./db.ts";
import { casarCandidato, indexarPorNome } from "./harvest-candidatos.ts";
import type { CandidatoRow } from "./db.ts";
import { linhasPainel } from "./elo-painel.ts";
import { nomeMunicipio } from "./nomes-pe.ts";
import { normalizarAutor } from "./normalize.ts";
import { POPULACAO_PE } from "./populacao-pe.ts";
import type { RegiaoPE } from "./regioes-pe.ts";
import { regiaoDoMunicipio } from "./regioes-pe.ts";

export type PerfilEmendas = {
  n: number;
  vemp: number;
  vpago: number;
  municipios: number;
  /** posição no ranking dos 49 por valor empenhado; null quando não há emenda */
  posicaoValor: number | null;
  porExercicio: Array<{ ex: number; n: number; vemp: number; vpago: number }>;
  topMunicipios: Array<{ chave: string; nome: string; regiao: RegiaoPE | null; n: number; v: number; porHabitante: number | null }>;
  porRegiao: Array<{ regiao: string; n: number; v: number }>;
  topUnidades: Array<{ ug: string; n: number; v: number }>;
};

export type PerfilGabinete = {
  rotulo: string;
  codigoSetor: string | null;
  total: number;
  posicao: number;
  cargos: Array<{ cargo: string; n: number }>;
  admissoesPorAno: Array<{ ano: number; n: number }>;
  /** Quantos entraram nesta legislatura (2023+) — mede renovação do gabinete. */
  admitidosNaLegislatura: number;
  totalLegado: number | null;
  demissionarios: number | null;
  /**
   * Custo mensal estimado: soma do vencimento DE TABELA dos cargos ocupados.
   * Não é folha de pagamento — a Alepe não publica remuneração individual.
   */
  custoMensal: number;
  /** posição no ranking de custo entre os 49 — NÃO acompanha a de headcount */
  posicaoCusto: number;
  pessoasSemCusto: number;
};

export type PerfilVotacao2022 = {
  /** como o casamento com o TSE foi feito, para poder ser auditado */
  casadoPor: "nome-de-urna" | "nome-civil";
  nomeUrna: string;
  partido: string | null;
  totalVotos: number;
  municipiosComVoto: number;
  municipioTop: string | null;
  nomeMunicipioTop: string | null;
  votosTop: number;
  /** Herfindahl dos votos por município: 1 = reduto único, ~0 = pulverizado. */
  concentracao: number;
  porRegiao: Array<{ regiao: string; votos: number }>;
  topMunicipios: Array<{ chave: string; nome: string; votos: number; pct: number }>;
};

export type PerfilDeputado = {
  slug: string;
  chave: string;
  nome: string;
  nomeCivil: string | null;
  partido: string | null;
  matricula: string | null;
  gabinete: PerfilGabinete;
  emendas: PerfilEmendas | null;
  /** null = sem registro na lista do TSE; o marcador é positivo-only (NOTAS 29). */
  candidatura2026: { cargo: string; partido: string | null; reeleicao: boolean } | null;
  bens: { total: number; qtd: number } | null;
  votacao2022: PerfilVotacao2022 | null;
  /** Por que uma camada ficou vazia. Vai para a tela; lacuna explicada não é lacuna escondida. */
  lacunas: string[];
};

/** URL amigável e estável: derivada da chave normalizada, não do nome exibido. */
export function slugDeputado(chaveNormalizada: string): string {
  return chaveNormalizada
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function perfisDeputados(db: Db): PerfilDeputado[] {
  const raw = db.raw;
  const gabinetes = db.listGabinetes();

  const emendasPorChave = agregarEmendas(raw);
  const votacaoPorChave = casarVotacao2022(raw, gabinetes);
  const candidaturaPorChave = casarCandidaturas(raw, gabinetes);
  const bensPorId = new Map(
    (raw.query("SELECT id, total_bens, qtd_bens FROM candidato_2026").all() as Array<{
      id: number;
      total_bens: number | null;
      qtd_bens: number | null;
    }>).map((c) => [c.id, c]),
  );

  // Rankings calculados sobre os 49, uma vez só — cada perfil só lê a posição.
  const tabela = indexarRemuneracao(db.remuneracaoCargos());
  const snapshotPessoal = db.ultimoSnapshotPessoal();
  const custoPorChave = new Map(
    gabinetes.map((g) => [
      g.deputado_normalizado,
      custoDoGabinete(snapshotPessoal ? db.assessoresDoGabinete(g.chave, snapshotPessoal) : [], tabela),
    ]),
  );

  const rankAssessores = ranquear(gabinetes.map((g) => [g.deputado_normalizado, g.total] as const));
  const rankCusto = ranquear(gabinetes.map((g) => [g.deputado_normalizado, custoPorChave.get(g.deputado_normalizado)?.mensal ?? 0] as const));
  const rankValor = ranquear(gabinetes.map((g) => [g.deputado_normalizado, emendasPorChave.get(g.deputado_normalizado)?.vemp ?? 0] as const));

  const snapshot = db.ultimoSnapshotPessoal();

  return gabinetes
    .map((g): PerfilDeputado => {
      const lacunas: string[] = [];
      const chave = g.deputado_normalizado;

      const em = emendasPorChave.get(chave) ?? null;
      if (!em) {
        lacunas.push(
          "Nenhuma emenda com autoria confirmada no dicionário oficial da ALEPE. Isso não significa que não tenha apresentado emendas — significa que nenhuma emenda de autoria dele foi executada nos empenhos coletados.",
        );
      }

      const vot = votacaoPorChave.get(chave) ?? null;
      if (!vot) {
        lacunas.push(
          "Votação de 2022 não casada: o nome de urna de 2022 difere do nome parlamentar atual e não há nome civil no cadastro da ALEPE para desempatar. Preferimos deixar vazio a arriscar o candidato errado.",
        );
      }

      const cand = candidaturaPorChave.get(chave) ?? null;
      if (!cand) {
        lacunas.push(
          "Sem registro de candidatura em 2026 na lista do TSE consultada. A ausência NÃO significa que não é candidato — o marcador é positivo-only.",
        );
      }

      const bruto = cand?.candidato_id ? bensPorId.get(cand.candidato_id) : undefined;
      const bens = bruto && bruto.total_bens !== null ? { total: bruto.total_bens, qtd: bruto.qtd_bens ?? 0 } : null;

      return {
        slug: slugDeputado(chave),
        chave,
        nome: nomeProprioSuave(g.deputado_nome),
        nomeCivil: g.deputado_nome_civil,
        partido: g.partido,
        matricula: g.deputado_matricula,
        gabinete: perfilGabinete(db, g, rankAssessores.get(chave) ?? 0, snapshot, tabela, rankCusto.get(chave) ?? 0),
        emendas: em ? { ...em, posicaoValor: rankValor.get(chave) ?? null } : null,
        candidatura2026: cand ? { cargo: cand.cargo, partido: cand.partido, reeleicao: cand.reeleicao } : null,
        bens,
        votacao2022: vot,
        lacunas,
      };
    })
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}

// ------------------------------------------------------------------ gabinete

function perfilGabinete(
  db: Db,
  g: GabineteRow,
  posicao: number,
  snapshot: string | null,
  tabela: TabelaRemuneracao,
  posicaoCusto: number,
): PerfilGabinete {
  const pessoas = snapshot ? db.assessoresDoGabinete(g.chave, snapshot) : [];

  const custo = custoDoGabinete(pessoas, tabela);
  const porCargo = new Map<string, number>();
  const porAno = new Map<number, number>();
  for (const p of pessoas) {
    const c = p.cargo ?? "(sem cargo informado)";
    porCargo.set(c, (porCargo.get(c) ?? 0) + 1);
    const ano = p.data_admissao ? Number(p.data_admissao.slice(0, 4)) : null;
    if (ano && Number.isInteger(ano)) porAno.set(ano, (porAno.get(ano) ?? 0) + 1);
  }

  return {
    rotulo: g.rotulo_api,
    codigoSetor: g.codigo_setor,
    total: g.total,
    posicao,
    cargos: [...porCargo].map(([cargo, n]) => ({ cargo, n })).sort((a, b) => b.n - a.n || a.cargo.localeCompare(b.cargo, "pt-BR")),
    admissoesPorAno: [...porAno].map(([ano, n]) => ({ ano, n })).sort((a, b) => a.ano - b.ano),
    // A 20ª legislatura começou em 2023: quem entrou antes veio de gabinete
    // anterior ou do quadro da Casa.
    admitidosNaLegislatura: pessoas.filter((p) => (p.data_admissao ?? "") >= "2023-02-01").length,
    totalLegado: g.total_legado,
    demissionarios: g.demissionarios,
    custoMensal: custo.mensal,
    posicaoCusto,
    pessoasSemCusto: custo.semValor,
  };
}

// ------------------------------------------------------------------- emendas

type AgregadoEmendas = Omit<PerfilEmendas, "posicaoValor">;

/**
 * Mesmo universo do painel publicado: elo canônico de `linhasPainel` + catraca
 * do dicionário oficial (só `conf === "alta"` e autor presente em
 * `autoria_oficial`). Reproduzir esse recorte importa mais do que ser
 * abrangente: o perfil manda o leitor conferir no painel, e o número tem de
 * ser o mesmo que ele vai encontrar lá (NOTAS 26/32).
 */
function agregarEmendas(raw: Database): Map<string, AgregadoEmendas> {
  const oficiais = new Set(
    (raw.query("SELECT DISTINCT autor_normalizado a FROM autoria_oficial").all() as Array<{ a: string }>).map((r) => r.a),
  );

  type Acc = {
    emendas: Set<string>;
    vemp: number;
    vpago: number;
    muns: Map<string, { n: Set<string>; v: number }>;
    anos: Map<number, { n: Set<string>; vemp: number; vpago: number }>;
    ugs: Map<string, { n: Set<string>; v: number }>;
  };
  const acc = new Map<string, Acc>();

  for (const l of linhasPainel(raw)) {
    if (l.conf !== "alta" || !l.autor || !oficiais.has(l.autor)) continue;
    const a =
      acc.get(l.autor) ??
      ({ emendas: new Set(), vemp: 0, vpago: 0, muns: new Map(), anos: new Map(), ugs: new Map() } satisfies Acc);
    // A identidade da emenda é numero/ano; a linha é (emenda × exercício).
    // Sem isso, uma emenda executada em 3 anos seria contada como 3 emendas.
    const idEmenda = l.em ?? l.s;
    a.emendas.add(idEmenda);
    a.vemp += l.vemp;
    a.vpago += l.vpago;

    const ano = a.anos.get(l.ex) ?? { n: new Set<string>(), vemp: 0, vpago: 0 };
    ano.n.add(idEmenda);
    ano.vemp += l.vemp;
    ano.vpago += l.vpago;
    a.anos.set(l.ex, ano);

    if (l.mun) {
      const m = a.muns.get(l.mun) ?? { n: new Set<string>(), v: 0 };
      m.n.add(idEmenda);
      m.v += l.vemp;
      a.muns.set(l.mun, m);
    }
    if (l.ug) {
      const u = a.ugs.get(l.ug) ?? { n: new Set<string>(), v: 0 };
      u.n.add(idEmenda);
      u.v += l.vemp;
      a.ugs.set(l.ug, u);
    }
    acc.set(l.autor, a);
  }

  const saida = new Map<string, AgregadoEmendas>();
  for (const [chave, a] of acc) {
    if (a.vemp <= 0) continue;

    const porRegiao = new Map<string, { n: number; v: number }>();
    for (const [mun, m] of a.muns) {
      const r = regiaoDoMunicipio(mun) ?? "Sem município identificado";
      const cur = porRegiao.get(r) ?? { n: 0, v: 0 };
      cur.n += m.n.size;
      cur.v += m.v;
      porRegiao.set(r, cur);
    }

    saida.set(chave, {
      n: a.emendas.size,
      vemp: arred(a.vemp),
      vpago: arred(a.vpago),
      municipios: a.muns.size,
      porExercicio: [...a.anos]
        .map(([ex, v]) => ({ ex, n: v.n.size, vemp: arred(v.vemp), vpago: arred(v.vpago) }))
        .sort((x, y) => x.ex - y.ex),
      topMunicipios: [...a.muns]
        .map(([chaveMun, m]) => {
          const pop = POPULACAO_PE.get(chaveMun) ?? null;
          return {
            chave: chaveMun,
            nome: nomeMunicipio(chaveMun),
            regiao: regiaoDoMunicipio(chaveMun),
            n: m.n.size,
            v: arred(m.v),
            porHabitante: pop ? arred(m.v / pop) : null,
          };
        })
        .sort((x, y) => y.v - x.v)
        .slice(0, 15),
      porRegiao: [...porRegiao]
        .map(([regiao, v]) => ({ regiao, n: v.n, v: arred(v.v) }))
        .sort((x, y) => y.v - x.v),
      topUnidades: [...a.ugs]
        .map(([ug, u]) => ({ ug, n: u.n.size, v: arred(u.v) }))
        .sort((x, y) => y.v - x.v)
        .slice(0, 8),
    });
  }
  return saida;
}

// ------------------------------------------------------------------ votação

/**
 * Casa cada gabinete com a votação nominal de 2022.
 *
 * Duas chaves, nesta ordem: nome de urna e, se ele não resolver, nome civil.
 * As duas exigem casamento ÚNICO — mais de um candidato com o mesmo nome
 * devolve nada, porque atribuir a votação de outra pessoa a um deputado é
 * exatamente o erro que este painel não pode cometer.
 *
 * `votacao_2022_municipio.nome_urna` guarda o valor CRU do TSE, com acento e
 * às vezes espaço à direita ("SOCORRO PIMENTEL "). Normalizar os dois lados
 * sobe o casamento de 36 para 42; o nome civil leva a 47 dos 49.
 */
function casarVotacao2022(raw: Database, gabinetes: GabineteRow[]): Map<string, PerfilVotacao2022> {
  type Voto = { sq: string; urna: string; civil: string | null; partido: string | null; municipio: string; votos: number };
  const linhas = raw
    .query(`SELECT sq_candidato AS sq, nome_urna AS urna, nome_completo AS civil, partido, municipio, votos
            FROM votacao_2022_municipio WHERE cargo = 'Deputado Estadual'`)
    .all() as Voto[];

  const porCandidato = new Map<string, Voto[]>();
  for (const l of linhas) {
    const lista = porCandidato.get(l.sq);
    if (lista) lista.push(l);
    else porCandidato.set(l.sq, [l]);
  }

  const porUrna = new Map<string, Set<string>>();
  const porCivil = new Map<string, Set<string>>();
  const indexar = (mapa: Map<string, Set<string>>, chave: string, sq: string) => {
    if (!chave) return;
    const s = mapa.get(chave);
    if (s) s.add(sq);
    else mapa.set(chave, new Set([sq]));
  };
  for (const [sq, votos] of porCandidato) {
    const primeiro = votos[0];
    if (!primeiro) continue;
    indexar(porUrna, normalizarAutor(primeiro.urna), sq);
    indexar(porCivil, normalizarAutor(primeiro.civil ?? ""), sq);
  }

  const saida = new Map<string, PerfilVotacao2022>();
  for (const g of gabinetes) {
    let sq: string | undefined;
    let casadoPor: PerfilVotacao2022["casadoPor"] = "nome-de-urna";

    const porNome = porUrna.get(g.deputado_normalizado);
    if (porNome?.size === 1) {
      sq = [...porNome][0];
    } else if (g.deputado_nome_civil) {
      const porCiv = porCivil.get(normalizarAutor(g.deputado_nome_civil));
      if (porCiv?.size === 1) {
        sq = [...porCiv][0];
        casadoPor = "nome-civil";
      }
    }
    if (!sq) continue;

    const votos = porCandidato.get(sq) ?? [];
    const total = votos.reduce((s, v) => s + v.votos, 0);
    if (total <= 0) continue;

    const ordenados = [...votos].sort((a, b) => b.votos - a.votos);
    const top = ordenados[0];
    const porRegiao = new Map<string, number>();
    for (const v of votos) {
      const r = regiaoDoMunicipio(v.municipio) ?? "Outros";
      porRegiao.set(r, (porRegiao.get(r) ?? 0) + v.votos);
    }

    saida.set(g.deputado_normalizado, {
      casadoPor,
      nomeUrna: votos[0]?.urna.trim() ?? g.deputado_nome,
      partido: votos[0]?.partido ?? null,
      totalVotos: total,
      municipiosComVoto: votos.length,
      municipioTop: top?.municipio ?? null,
      nomeMunicipioTop: top ? nomeMunicipio(top.municipio) : null,
      votosTop: top?.votos ?? 0,
      concentracao: arred(votos.reduce((s, v) => s + (v.votos / total) ** 2, 0), 4),
      porRegiao: [...porRegiao].map(([regiao, votos2]) => ({ regiao, votos: votos2 })).sort((a, b) => b.votos - a.votos),
      topMunicipios: ordenados.slice(0, 15).map((v) => ({
        chave: v.municipio,
        nome: nomeMunicipio(v.municipio),
        votos: v.votos,
        pct: arred((v.votos / total) * 100, 2),
      })),
    });
  }
  return saida;
}

// --------------------------------------------------------------- candidatura

function casarCandidaturas(
  raw: Database,
  gabinetes: GabineteRow[],
): Map<string, { cargo: string; partido: string | null; reeleicao: boolean; candidato_id: number }> {
  const candidatos = raw.query("SELECT * FROM candidato_2026").all() as CandidatoRow[];
  const indice = indexarPorNome(candidatos);
  const saida = new Map<string, { cargo: string; partido: string | null; reeleicao: boolean; candidato_id: number }>();

  for (const g of gabinetes) {
    // Mesma função do painel — inclusive o desempate por partido, que aqui é
    // conhecido (vem do roster da ALEPE) e resolve homônimo de graça.
    const v = casarCandidato(g.deputado_normalizado, "Deputado Estadual", indice, g.partido);
    if (v.situacao !== "candidato" || v.candidato_id === undefined) continue;
    saida.set(g.deputado_normalizado, {
      cargo: v.cargo_2026,
      partido: v.partido,
      reeleicao: v.reeleicao,
      candidato_id: v.candidato_id,
    });
  }
  return saida;
}

// ---------------------------------------------------------------- utilitários

/** Posição 1..N por valor decrescente; empate recebe a MESMA posição. */
function ranquear(pares: ReadonlyArray<readonly [string, number]>): Map<string, number> {
  const ordenado = [...pares].sort((a, b) => b[1] - a[1]);
  const saida = new Map<string, number>();
  let posicao = 0;
  let anterior: number | null = null;
  ordenado.forEach(([chave, valor], i) => {
    if (valor !== anterior) {
      posicao = i + 1;
      anterior = valor;
    }
    saida.set(chave, posicao);
  });
  return saida;
}

function arred(v: number, casas = 2): number {
  const f = 10 ** casas;
  return Math.round(v * f) / f;
}
