// Agregado de gabinete: quantas pessoas e quanto custa cada um dos 49.
//
// Existe pela mesma razão que `agregados.ts`: o gerador da série, o índice de
// fatos do verificador e o export do site precisam do MESMO número. Duas
// cópias do mesmo SQL divergindo foi o que inflou 12 posts publicados em até
// 1,9x (NOTAS 33), e aqui o risco é maior — o número sai com o nome de uma
// pessoa ao lado.
//
// Três regras herdadas de NOTAS 40, que este módulo torna difíceis de violar:
//
//   1. `pessoas` e `custoMensal` saem das MESMAS linhas. Nunca de duas
//      queries — contagem de um universo com valor de outro é o erro que já
//      foi publicado.
//   2. O valor é *vencimento do cargo*, jamais salário de alguém. A Alepe não
//      publica contracheque; quem está à disposição fica fora da conta porque
//      é pago pela origem, e contá-lo seria inventar despesa.
//   3. Cabeças e custo se contradizem (1º em pessoas é 38º em custo). Quem
//      consome este módulo recebe os dois postos juntos, de propósito: o
//      consumidor teria de trabalhar para publicar só metade do quadro.

import type { Database } from "bun:sqlite";
import { custoDaPessoa, indexarRemuneracao, type RemuneracaoCargo } from "./custo-pessoal.ts";
import { slugDeputado } from "./perfil-deputado.ts";

export type AgregadoGabinete = {
  chave: string;
  /** Nome do deputado como a Alepe publica. */
  deputado: string;
  slug: string;
  partido: string | null;
  /** Pessoas lotadas no gabinete no snapshot. */
  pessoas: number;
  /** Soma dos vencimentos de tabela dos comissionados, por mês. */
  custoMensal: number;
  /** Pessoas fora da conta de custo (à disposição, sem cargo, cargo fora da tabela). */
  semCusto: number;
  cargos: Record<string, number>;
  /** 1 = o maior em número de pessoas. */
  postoPessoas: number;
  /** 1 = o mais caro. */
  postoCusto: number;
};

export type TotaisGabinete = {
  snapshot: string;
  competencia: string | null;
  gabinetes: number;
  pessoas: number;
  custoMensal: number;
  /** 12x o mensal. NÃO é a folha anual: falta 13º, férias e encargo patronal. */
  custoAnualSimples: number;
  menorGabinete: number;
  maiorGabinete: number;
  cargos: Array<{ cargo: string; venc: number; pessoas: number }>;
  /** Quantas vezes o cargo mais caro custa o mais barato da tabela de gabinete. */
  razaoTopoBase: number;
  cargoTopo: string;
  cargoBase: string;
};

type LinhaServidor = { gabinete_chave: string; cargo: string | null; vinculo: string };

/**
 * Um gabinete por deputado, com pessoas e custo saindo das mesmas linhas.
 *
 * Ordenado por custo decrescente — é o ranking que a tela publica e o que o
 * post cita. `postoPessoas` acompanha para que nenhum consumidor precise
 * recalcular (e errar) a contradição entre os dois.
 */
export function agregadoPorGabinete(db: Database): AgregadoGabinete[] {
  const tabela = indexarRemuneracao(
    db
      .query(
        `SELECT * FROM remuneracao_cargo
         WHERE competencia = (SELECT MAX(competencia) FROM remuneracao_cargo)`,
      )
      .all() as RemuneracaoCargo[],
  );

  const gabinetes = db
    .query(
      `SELECT chave, deputado_nome, deputado_normalizado, partido, total
       FROM gabinete ORDER BY deputado_nome`,
    )
    .all() as Array<{
    chave: string;
    deputado_nome: string;
    deputado_normalizado: string;
    partido: string | null;
    total: number;
  }>;

  // Uma passada só sobre o snapshot mais recente: pessoas e custo do mesmo
  // conjunto de linhas, que é o invariante deste módulo.
  const servidores = db
    .query(
      `SELECT gabinete_chave, cargo, vinculo FROM servidor_alepe
       WHERE snapshot = (SELECT MAX(snapshot) FROM servidor_alepe)
         AND gabinete_chave IS NOT NULL`,
    )
    .all() as LinhaServidor[];

  const porGabinete = new Map<string, LinhaServidor[]>();
  for (const s of servidores) {
    const lista = porGabinete.get(s.gabinete_chave);
    if (lista) lista.push(s);
    else porGabinete.set(s.gabinete_chave, [s]);
  }

  const linhas = gabinetes.map((g) => {
    const pessoas = porGabinete.get(g.chave) ?? [];

    // Mesmo invariante do export: se a foto do snapshot não bate com o total
    // gravado no gabinete, o dado mudou debaixo do agregado. Quebrar é melhor
    // do que publicar um número com o nome de alguém ao lado.
    if (pessoas.length !== g.total) {
      throw new Error(
        `gabinete: ${g.deputado_nome} tem total ${g.total} mas ${pessoas.length} pessoa(s) no snapshot`,
      );
    }

    let custoMensal = 0;
    let semCusto = 0;
    const cargos: Record<string, number> = {};
    for (const p of pessoas) {
      const rotulo = p.cargo ?? "(sem cargo informado)";
      cargos[rotulo] = (cargos[rotulo] ?? 0) + 1;
      const c = custoDaPessoa(p, tabela);
      if (c.remuneracaoCargo === null) semCusto += 1;
      else custoMensal += c.remuneracaoCargo;
    }

    return {
      chave: g.chave,
      deputado: g.deputado_nome,
      slug: slugDeputado(g.deputado_normalizado),
      partido: g.partido,
      pessoas: pessoas.length,
      custoMensal: Math.round(custoMensal * 100) / 100,
      semCusto,
      cargos,
      postoPessoas: 0,
      postoCusto: 0,
    } satisfies AgregadoGabinete;
  });

  // Desempate por nome nos dois postos: sem ele, dois gabinetes com o mesmo
  // custo trocariam de posição a cada execução e o pool deixaria de ser
  // reproduzível.
  const porPessoas = [...linhas].sort((a, b) => b.pessoas - a.pessoas || a.deputado.localeCompare(b.deputado, "pt-BR"));
  porPessoas.forEach((l, i) => {
    l.postoPessoas = i + 1;
  });
  const porCusto = [...linhas].sort((a, b) => b.custoMensal - a.custoMensal || a.deputado.localeCompare(b.deputado, "pt-BR"));
  porCusto.forEach((l, i) => {
    l.postoCusto = i + 1;
  });

  return porCusto;
}

/**
 * Os agregados de gabinete, ou o motivo de não haver nenhum.
 *
 * Existe por causa do raio de alcance da falha. `agregadoPorGabinete` **lança**
 * quando a foto do snapshot diverge do total gravado — invariante certo, mas o
 * índice de fatos do verificador é construído inteiro a cada publicação, e um
 * problema no pessoal derrubaria também o post de cidade, o de autor e o de
 * função. A série toda pararia por causa de uma tabela que nenhum deles cita.
 *
 * Aqui a falha fica contida: sem fatos de gabinete, o post de gabinete é
 * reprovado por falta de lastro (fecha, como deve) e os outros eixos seguem. O
 * motivo vai para stderr, que o job do cron captura e entrega no alerta.
 */
export function gabinetesOuNada(db: Database): {
  linhas: AgregadoGabinete[];
  totais: TotaisGabinete | null;
  erro: string | null;
} {
  try {
    return { linhas: agregadoPorGabinete(db), totais: totaisGabinete(db), erro: null };
  } catch (err) {
    const erro = err instanceof Error ? err.message : String(err);
    console.error(`gabinete: agregado indisponível, posts de gabinete vão falhar fechados — ${erro}`);
    return { linhas: [], totais: null, erro };
  }
}

export function totaisGabinete(db: Database): TotaisGabinete | null {
  const linhas = agregadoPorGabinete(db);
  if (linhas.length === 0) return null;

  const snapshot =
    (db.query(`SELECT MAX(snapshot) s FROM servidor_alepe`).get() as { s: string | null } | null)?.s ?? null;
  if (!snapshot) return null;
  const competencia =
    (db.query(`SELECT MAX(competencia) c FROM remuneracao_cargo`).get() as { c: string | null } | null)?.c ?? null;

  const tabela = indexarRemuneracao(
    db
      .query(
        `SELECT * FROM remuneracao_cargo
         WHERE competencia = (SELECT MAX(competencia) FROM remuneracao_cargo)`,
      )
      .all() as RemuneracaoCargo[],
  );

  const pessoasPorCargo = new Map<string, number>();
  for (const l of linhas) {
    for (const [cargo, n] of Object.entries(l.cargos)) {
      pessoasPorCargo.set(cargo, (pessoasPorCargo.get(cargo) ?? 0) + n);
    }
  }
  const cargos = [...pessoasPorCargo]
    .map(([cargo, pessoas]) => ({
      cargo,
      venc: [...tabela.values()].find((r) => r.cargo === cargo)?.remuneracao ?? 0,
      pessoas,
    }))
    .sort((a, b) => b.venc - a.venc);

  // Só cargos COM vencimento entram na razão: "(sem cargo informado)" tem
  // venc 0 e viraria uma razão infinita apresentada como fato.
  const comValor = cargos.filter((c) => c.venc > 0);
  const topo = comValor[0];
  const base = comValor.at(-1);

  const custoMensal = Math.round(linhas.reduce((s, l) => s + l.custoMensal, 0) * 100) / 100;

  return {
    snapshot,
    competencia,
    gabinetes: linhas.length,
    pessoas: linhas.reduce((s, l) => s + l.pessoas, 0),
    custoMensal,
    custoAnualSimples: Math.round(custoMensal * 12 * 100) / 100,
    menorGabinete: Math.min(...linhas.map((l) => l.pessoas)),
    maiorGabinete: Math.max(...linhas.map((l) => l.pessoas)),
    cargos,
    razaoTopoBase: topo && base && base.venc > 0 ? Number((topo.venc / base.venc).toFixed(1)) : 0,
    cargoTopo: topo?.cargo ?? "",
    cargoBase: base?.cargo ?? "",
  };
}
