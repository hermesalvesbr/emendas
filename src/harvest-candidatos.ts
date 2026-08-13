// Candidaturas de PE nas Eleições Gerais 2026 (TSE / DivulgaCandContas).
//
// Serve a um único propósito no painel: marcar se quem assinou uma emenda
// está concorrendo em 2026, e a qual cargo. Duas restrições medidas em
// 13/08/2026 moldam todo este módulo (ver NOTAS.md item 29):
//
//  1. O campo `st_REELEICAO` da API vem `false` para os 811 candidatos de PE
//     — ele só é preenchido depois do julgamento. Reeleição é DERIVADA aqui,
//     comparando o cargo atual do parlamentar com o cargo de 2026.
//  2. O prazo de registro só fecha em 15/08/2026 e todas as candidaturas
//     estão "Aguardando julgamento". Logo, ausência na lista NÃO significa
//     que a pessoa não é candidata — significa que ainda não sabemos. O
//     painel só exibe o marcador positivo; nunca afirma o negativo.
//
// A API não é documentada oficialmente; o contrato usado aqui foi conferido
// contra as respostas reais e contra a documentação não-oficial em
// https://github.com/augusto-herrmann/divulgacandcontas-doc

import type { Db } from "./db.ts";
import { normalizarAutor } from "./normalize.ts";
import { HarvestError, insist } from "./retry.ts";

const BASE = "https://divulgacandcontas.tse.jus.br/divulga/rest/v1";

/** Eleição Geral Federal 2026, obtida de /eleicao/ordinarias em 13/08/2026. */
export const ELEICAO_2026 = 20322002026;

/** Cargos disputados em PE. Presidente (1) é nacional e não entra no recorte estadual. */
export const CARGOS = {
  3: "Governador",
  5: "Senador",
  6: "Deputado Federal",
  7: "Deputado Estadual",
} as const satisfies Record<number, string>;

export type CargoCodigo = keyof typeof CARGOS;
export type CargoNome = (typeof CARGOS)[CargoCodigo];

export type Candidato = {
  id: number;
  nome_urna: string;
  nome_completo: string | null;
  nome_urna_normalizado: string;
  nome_completo_normalizado: string | null;
  numero: number | null;
  cargo_codigo: number;
  cargo: string;
  partido: string | null;
  situacao: string | null;
};

// ------------------------------------------------------------------- parse

type RespostaTse = {
  candidatos?: Array<{
    id?: number;
    nomeUrna?: string;
    nomeCompleto?: string | null;
    numero?: number | null;
    partido?: { sigla?: string | null } | null;
    descricaoSituacao?: string | null;
  }> | null;
};

/** Converte a resposta crua num registro estável. Falha alto se o formato mudar. */
export function parseCandidatos(json: unknown, cargoCodigo: CargoCodigo): Candidato[] {
  const resposta = json as RespostaTse;
  if (!Array.isArray(resposta?.candidatos)) {
    throw new HarvestError("parse", `TSE: resposta sem array "candidatos" para o cargo ${cargoCodigo}`);
  }

  const out: Candidato[] = [];
  for (const c of resposta.candidatos) {
    if (typeof c.id !== "number" || !c.nomeUrna) continue;
    const completo = c.nomeCompleto?.trim() || null;
    out.push({
      id: c.id,
      nome_urna: c.nomeUrna.trim(),
      nome_completo: completo,
      nome_urna_normalizado: normalizarAutor(c.nomeUrna),
      nome_completo_normalizado: completo ? normalizarAutor(completo) : null,
      numero: c.numero ?? null,
      cargo_codigo: cargoCodigo,
      cargo: CARGOS[cargoCodigo],
      partido: c.partido?.sigla?.trim() || null,
      situacao: c.descricaoSituacao?.trim() || null,
    });
  }
  return out;
}

// ---------------------------------------------------------------- casamento

/** O cargo que a pessoa ocupa hoje, para decidir se 2026 é reeleição ou troca. */
export type CargoAtual = "Deputado Estadual" | "Deputado Federal" | "Senador";

export type Vinculo =
  | { situacao: "candidato"; cargo_2026: string; partido: string | null; reeleicao: boolean; candidato_id: number }
  | { situacao: "ambiguo"; motivo: string }
  | { situacao: "sem-registro" };

/**
 * Casa um parlamentar com as candidaturas de 2026.
 *
 * Conservador de propósito: homônimo é risco real (medido — "ANDRE FERREIRA",
 * deputado federal, casa com um candidato a estadual que é outra pessoa).
 * Quando há mais de um candidato com o mesmo nome, só resolve se o partido
 * desempatar; caso contrário devolve "ambiguo" e o painel não marca nada.
 * Errar aqui é acusar publicamente a pessoa errada de estar concorrendo.
 */
export function casarCandidato(
  nomeNormalizado: string,
  cargoAtual: CargoAtual,
  indice: Map<string, Candidato[]>,
  partidoConhecido?: string | null,
): Vinculo {
  const achados = indice.get(nomeNormalizado);
  if (!achados || achados.length === 0) return { situacao: "sem-registro" };

  // Dedup por candidato (o índice guarda nome de urna e nome civil).
  const unicos = [...new Map(achados.map((c) => [c.id, c])).values()];

  let escolhido = unicos[0];
  if (unicos.length > 1) {
    const porPartido = partidoConhecido
      ? unicos.filter((c) => c.partido && c.partido.toUpperCase() === partidoConhecido.toUpperCase())
      : [];
    if (porPartido.length !== 1) {
      return {
        situacao: "ambiguo",
        motivo: `${unicos.length} candidatos com este nome (${unicos.map((c) => `${c.cargo}/${c.partido ?? "?"}`).join(", ")})`,
      };
    }
    escolhido = porPartido[0];
  }

  if (!escolhido) return { situacao: "sem-registro" };
  return {
    situacao: "candidato",
    cargo_2026: escolhido.cargo,
    partido: escolhido.partido,
    reeleicao: escolhido.cargo === cargoAtual,
    candidato_id: escolhido.id,
  };
}

/** Índice de busca por nome de urna E nome civil — o painel usa ora um, ora outro. */
export function indexarPorNome(candidatos: Candidato[]): Map<string, Candidato[]> {
  const idx = new Map<string, Candidato[]>();
  for (const c of candidatos) {
    for (const chave of [c.nome_urna_normalizado, c.nome_completo_normalizado]) {
      if (!chave) continue;
      const lista = idx.get(chave);
      if (lista) lista.push(c);
      else idx.set(chave, [c]);
    }
  }
  return idx;
}

// -------------------------------------------------------------------- rede

export type RelatorioCandidatos = {
  total: number;
  porCargo: Record<string, number>;
  porSituacao: Record<string, number>;
  coletadoEm: string;
};

export async function harvestCandidatos(db: Db): Promise<RelatorioCandidatos> {
  const todos: Candidato[] = [];

  for (const codigo of Object.keys(CARGOS).map(Number) as CargoCodigo[]) {
    const url = `${BASE}/candidatura/listar/2026/PE/${ELEICAO_2026}/${codigo}/candidatos`;
    const r = await insist(
      `tse:cargo-${codigo}`,
      async (signal) => {
        const res = await fetch(url, { signal, headers: { "User-Agent": "Mozilla/5.0 (emendas-pe)" } });
        if (!res.ok) throw new HarvestError("http", `TSE ${res.status} no cargo ${codigo}`, { status: res.status });
        return parseCandidatos(await res.json(), codigo);
      },
      { maxAttempts: 5, baseMs: 1500 },
    );

    if (!r.ok) throw r.lastError;
    todos.push(...r.value);
    db.logHarvest({
      alvo: `tse:candidatos-${CARGOS[codigo]}`,
      exercicio: 2026,
      status: "ok",
      tentativas: r.attempts,
      http_status: 200,
      duracao_ms: Math.round(r.elapsedMs),
      mensagem: `${r.value.length} candidato(s)`,
    });
    // A documentação não-oficial pede intervalo entre chamadas; o TSE não
    // publica limite, então vamos devagar de propósito.
    await Bun.sleep(500);
  }

  const coletadoEm = new Date().toISOString();
  db.substituirCandidatos(todos, coletadoEm);

  const conta = (f: (c: Candidato) => string): Record<string, number> =>
    todos.reduce<Record<string, number>>((a, c) => ((a[f(c)] = (a[f(c)] ?? 0) + 1), a), {});

  return {
    total: todos.length,
    porCargo: conta((c) => c.cargo),
    porSituacao: conta((c) => c.situacao ?? "?"),
    coletadoEm,
  };
}
