// Quanto custa um gabinete, a partir do que a ALEPE de fato publica.
//
// A ALEPE **não publica contracheque**. `/api/v1/remuneracao/` traz a tabela de
// vencimento **por cargo** (competência 08/2026, "Cargo Comissionado de
// Gabinete"), e `/api/v1/servidores/` diz qual cargo cada pessoa ocupa. O
// cruzamento dá o vencimento DO CARGO que a pessoa ocupa — não o que ela
// recebe. A diferença não é preciosismo:
//
//   - é valor BRUTO: sem IR, sem previdência, sem consignado;
//   - não tem 13º, férias, gratificação, diária nem encargo patronal;
//   - quem entrou no meio do mês não recebeu o mês inteiro;
//   - quem está "à disposição" é pago pelo órgão de origem, não pela ALEPE.
//
// Por isso o número publicado se chama *custo estimado do gabinete*, e nunca
// "salário do assessor". Ver NOTAS.md item 40.

import type { ServidorAlepeRow } from "./db.ts";
import { normalizarAutor } from "./normalize.ts";

export type RemuneracaoCargo = {
  competencia: string;
  cargo: string;
  cargo_normalizado: string;
  tipo_cargo: string | null;
  remuneracao: number;
};

export type TabelaRemuneracao = ReadonlyMap<string, RemuneracaoCargo>;

/** Chave de junção entre o cargo do servidor e o cargo da tabela de vencimento. */
export function chaveCargo(cargo: string | null | undefined): string {
  return normalizarAutor(cargo ?? "");
}

export function indexarRemuneracao(linhas: readonly RemuneracaoCargo[]): TabelaRemuneracao {
  return new Map(linhas.map((r) => [r.cargo_normalizado, r]));
}

export type CustoPessoa = {
  /** Vencimento do CARGO na tabela. null = não é possível estimar. */
  remuneracaoCargo: number | null;
  /** Por que não entrou na conta. null quando entrou. */
  motivoSemValor: "sem-cargo-informado" | "a-disposicao" | "cargo-fora-da-tabela" | null;
};

/**
 * Vencimento do cargo de uma pessoa, ou o motivo de não haver estimativa.
 *
 * "À disposição" fica de fora mesmo quando ocupa cargo comissionado (6 casos
 * em 18/08/2026): cedido pode optar pela remuneração do órgão de origem, e a
 * ALEPE não publica qual. Contar seria inventar despesa.
 */
export function custoDaPessoa(servidor: Pick<ServidorAlepeRow, "cargo" | "vinculo">, tabela: TabelaRemuneracao): CustoPessoa {
  if (servidor.vinculo !== "Comissionado") return { remuneracaoCargo: null, motivoSemValor: "a-disposicao" };
  if (!servidor.cargo) return { remuneracaoCargo: null, motivoSemValor: "sem-cargo-informado" };

  const achado = tabela.get(chaveCargo(servidor.cargo));
  if (!achado) return { remuneracaoCargo: null, motivoSemValor: "cargo-fora-da-tabela" };
  return { remuneracaoCargo: achado.remuneracao, motivoSemValor: null };
}

export type CustoGabinete = {
  /** Soma dos vencimentos de tabela, em reais por mês. */
  mensal: number;
  /** Pessoas que entraram na conta. */
  comValor: number;
  /** Pessoas sem estimativa, e por quê. */
  semValor: number;
  motivos: Record<string, number>;
};

export function custoDoGabinete(pessoas: readonly ServidorAlepeRow[], tabela: TabelaRemuneracao): CustoGabinete {
  let mensal = 0;
  let comValor = 0;
  const motivos: Record<string, number> = {};

  for (const p of pessoas) {
    const c = custoDaPessoa(p, tabela);
    if (c.remuneracaoCargo === null) {
      motivos[c.motivoSemValor ?? "desconhecido"] = (motivos[c.motivoSemValor ?? "desconhecido"] ?? 0) + 1;
      continue;
    }
    mensal += c.remuneracaoCargo;
    comValor++;
  }

  return { mensal: Math.round(mensal * 100) / 100, comValor, semValor: pessoas.length - comValor, motivos };
}
