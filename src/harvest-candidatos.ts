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

import type { DetalheCandidato, Db } from "./db.ts";
import { normalizarAutor } from "./normalize.ts";
import { regiaoDoMunicipio } from "./regioes-pe.ts";
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

// ------------------------------------------------- fase 2: detalhe e bens

/**
 * Suplentes vêm dentro do detalhe do titular, no campo `vices`, e com nomes de
 * campo em OUTRO padrão (sq_CANDIDATO, nm_URNA...) — resquício de outra
 * geração da API. Só senadores têm suplente.
 */
type ViceCru = {
  sq_CANDIDATO?: number | string | null;
  nm_URNA?: string | null;
  nm_CANDIDATO?: string | null;
  nr_CANDIDATO?: number | null;
  ds_CARGO?: string | null;
  sg_PARTIDO?: string | null;
  descricaoTotalizacao?: string | null;
};

export function parseSuplentes(json: unknown, idTitular: number): Array<Candidato & { id_titular: number }> {
  const vices = (json as { vices?: ViceCru[] | null })?.vices;
  if (!Array.isArray(vices)) return [];

  const out: Array<Candidato & { id_titular: number }> = [];
  for (const v of vices) {
    const id = Number(v.sq_CANDIDATO);
    if (!Number.isFinite(id) || id === 0 || !v.nm_URNA) continue;
    const completo = v.nm_CANDIDATO?.trim() || null;
    out.push({
      id,
      nome_urna: v.nm_URNA.trim(),
      nome_completo: completo,
      nome_urna_normalizado: normalizarAutor(v.nm_URNA),
      nome_completo_normalizado: completo ? normalizarAutor(completo) : null,
      numero: v.nr_CANDIDATO ?? null,
      // Suplente de senador herda o código do cargo do titular; o rótulo
      // ("1º Suplente") vem do próprio registro e é o que interessa exibir.
      cargo_codigo: 5,
      cargo: v.ds_CARGO?.trim() || "Suplente",
      partido: v.sg_PARTIDO?.trim() || null,
      situacao: v.descricaoTotalizacao?.trim() || null,
      id_titular: idTitular,
    });
  }
  return out;
}

type DetalheCru = {
  totalDeBens?: number | null;
  bens?: unknown[] | null;
  nomeMunicipioNascimento?: string | null;
  sgUfNascimento?: string | null;
  ocupacao?: string | null;
  grauInstrucao?: string | null;
  descricaoSexo?: string | null;
  cpf?: string | null;
  dataDeNascimento?: string | null;
};

/**
 * A região sai da NATURALIDADE (município de nascimento) e só quando o
 * nascimento foi em PE. Não existe, nesta eleição, campo de "região que o
 * candidato representa": estadual, federal, senador e governador são eleitos
 * em circunscrição única — o estado inteiro. Ver NOTAS.md item 30.
 */
export function parseDetalhe(json: unknown): DetalheCandidato {
  const d = json as DetalheCru;
  const uf = d.sgUfNascimento?.trim() || null;
  const municipio = d.nomeMunicipioNascimento?.trim() || null;
  return {
    total_bens: typeof d.totalDeBens === "number" ? d.totalDeBens : null,
    qtd_bens: Array.isArray(d.bens) ? d.bens.length : null,
    municipio_nascimento: municipio,
    uf_nascimento: uf,
    regiao: uf === "PE" ? regiaoDoMunicipio(municipio) : null,
    ocupacao: d.ocupacao?.trim() || null,
    grau_instrucao: d.grauInstrucao?.trim() || null,
    sexo: d.descricaoSexo?.trim() || null,
    // Só dígitos: o TSE devolve o CPF sem máscara em 2026 e com zeros à
    // esquerda em consulta_cand_2022. Comparar as duas pontas exige o mesmo
    // formato, e um zero perdido silenciaria o casamento do candidato.
    cpf: d.cpf?.replace(/\D/g, "") || null,
    data_nascimento: d.dataDeNascimento?.trim() || null,
  };
}

export type RelatorioDetalhe = {
  detalhados: number;
  suplentes: number;
  comBens: number;
  semRegiao: number;
  falhas: number;
};

/**
 * Um request por candidato (~830 no total). Vai devagar de propósito: a API
 * não publica limite e a documentação não-oficial pede intervalo. Retomável —
 * só busca quem ainda tem detalhado = 0.
 */
export async function detalharCandidatos(db: Db, opts?: { pausaMs?: number }): Promise<RelatorioDetalhe> {
  const pausaMs = opts?.pausaMs ?? 350;
  const rel: RelatorioDetalhe = { detalhados: 0, suplentes: 0, comBens: 0, semRegiao: 0, falhas: 0 };
  const coletadoEm = new Date().toISOString();

  // Duas passadas: a primeira descobre suplentes (que viram novas linhas), a
  // segunda pega o detalhe deles. Sem isso os suplentes ficariam sem bens.
  for (let passada = 1; passada <= 2; passada++) {
    const pendentes = db.candidatosSemDetalhe();
    if (pendentes.length === 0) break;
    console.log(`  passada ${passada}: ${pendentes.length} candidato(s) a detalhar`);

    for (const [i, c] of pendentes.entries()) {
      const url = `${BASE}/candidatura/buscar/2026/PE/${ELEICAO_2026}/candidato/${c.id}`;
      const r = await insist(
        `tse:detalhe-${c.id}`,
        async (signal) => {
          const res = await fetch(url, { signal, headers: { "User-Agent": "Mozilla/5.0 (emendas-pe)" } });
          if (!res.ok) throw new HarvestError("http", `TSE ${res.status} no detalhe ${c.id}`, { status: res.status });
          return (await res.json()) as unknown;
        },
        { maxAttempts: 3, baseMs: 1200 },
      );

      if (!r.ok) {
        rel.falhas++;
        console.error(`    falhou: ${c.nome_urna} (${c.id})`);
        continue;
      }

      const d = parseDetalhe(r.value);
      db.gravarDetalheCandidato(c.id, d);
      rel.detalhados++;
      if ((d.total_bens ?? 0) > 0) rel.comBens++;
      if (!d.regiao) rel.semRegiao++;

      const sup = parseSuplentes(r.value, c.id);
      if (sup.length > 0) rel.suplentes += db.inserirSuplentes(sup, coletadoEm);

      if ((i + 1) % 100 === 0) console.log(`    ${i + 1}/${pendentes.length}...`);
      await Bun.sleep(pausaMs);
    }
  }

  db.logHarvest({
    alvo: "tse:detalhe-candidatos",
    exercicio: 2026,
    status: rel.falhas === 0 ? "ok" : "http",
    tentativas: 1,
    http_status: 200,
    duracao_ms: null,
    mensagem: `${rel.detalhados} detalhado(s), ${rel.suplentes} suplente(s), ${rel.falhas} falha(s)`,
  });
  return rel;
}
