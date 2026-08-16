// O elo empenho↔emenda que o PAINEL usa — extraído de export-site.ts para ser
// a fonte única também dos posts.
//
// Por que existe: agregados.ts tinha reimplementado o elo com um join simples
// (`substr(cd_nm_subacao,1,4) = subacao_codigo`) que soma o MESMO empenho N
// vezes quando a subação casa com N emendas. Medido em 16/08/2026: R$ 240,97
// mi contra R$ 220,82 mi de empenhos únicos (+9,1%), e Recife divergindo do
// painel publicado (R$ 14,88 mi vs R$ 15,63 mi). Um post que manda o leitor
// "conferir no painel" não pode chegar a um número que o painel não mostra.
//
// A regra do elo (a mesma de NOTAS 26/32): cada empenho entra em EXATAMENTE
// uma chave — (1) código de 4 chars quando a subação tem o formato "XXXX - ",
// (2) elo textual "T:numero/ano" extraído da subação ou do obs, (3) "E:id"
// quando não casa com nada (linha isolada; nunca somada a emenda alguma).
// Somas por chave, sem dupla contagem — o invariante contra o total do banco
// é verificado aqui, a cada chamada.

import type { Database } from "bun:sqlite";
import type { EmendaRow, EmpenhoRow } from "./types.ts";
import { extrairCodigoSubacao, extrairNumeroEmenda } from "./normalize.ts";

export type LinhaPainel = {
  /** chave do elo (código de subação, "T:num/ano" ou "E:id") */
  s: string;
  /** exercício de execução (ano dos empenhos) */
  ex: number;
  /** numero/ano da emenda vinculada, ex. "650/2023" */
  em: string | null;
  autor: string | null;
  tipo: string | null;
  conf: "alta" | "media" | "nula";
  mun: string | null;
  benef: string | null;
  ug: string | null;
  vemp: number;
  vpago: number;
  n: number;
  f: string[];
};

const RANK = { alta: 0, media: 1, nula: 2 } as const;

/**
 * As linhas (emenda × exercício) exatamente como o painel as publica em
 * docs/dados.json — mesmo elo, mesma deduplicação, mesmo invariante.
 */
export function linhasPainel(raw: Database): LinhaPainel[] {
  const empenhos = raw.query("SELECT * FROM empenho ORDER BY id").all() as EmpenhoRow[];
  const emendas = raw.query("SELECT * FROM emenda").all() as EmendaRow[];

  // melhor emenda por código de subação e índice por (numero/ano)
  const porSubacao = new Map<string, EmendaRow>();
  const porNumeroAno = new Map<string, EmendaRow>();
  for (const e of emendas) {
    if (e.subacao_codigo) {
      const atual = porSubacao.get(e.subacao_codigo);
      if (!atual || RANK[e.confianca] < RANK[atual.confianca]) porSubacao.set(e.subacao_codigo, e);
    }
    porNumeroAno.set(`${e.numero_emenda}/${e.exercicio_emenda}`, e);
  }

  type Acc = { ex: number; emenda: EmendaRow | null; ug: string | null; vemp: number; vpago: number; n: number; fontes: Set<string> };
  const acc = new Map<string, Acc>();

  for (const em of empenhos) {
    const codigo = extrairCodigoSubacao(em.cd_nm_subacao);
    let chave: string;
    let emenda: EmendaRow | null = null;

    if (codigo) {
      chave = codigo;
      emenda = porSubacao.get(codigo) ?? null;
    } else {
      const num =
        extrairNumeroEmenda(em.cd_nm_subacao ?? "", em.exercicio) ?? extrairNumeroEmenda(em.obs ?? "", em.exercicio);
      if (num) {
        chave = `T:${num.numeroEmenda}/${num.exercicioEmenda}`;
        emenda = porNumeroAno.get(`${num.numeroEmenda}/${num.exercicioEmenda}`) ?? null;
      } else {
        chave = `E:${em.id}`;
      }
    }

    const k = `${chave}|${em.exercicio}`;
    const a = acc.get(k) ?? { ex: em.exercicio, emenda, ug: em.unidade_gestora, vemp: 0, vpago: 0, n: 0, fontes: new Set<string>() };
    a.fontes.add(em.fonte);
    a.vemp += em.vlrempenhado ?? 0;
    a.vpago += em.vlrtotalpago ?? 0;
    a.n += 1;
    if (!a.emenda && emenda) a.emenda = emenda;
    acc.set(k, a);
  }

  const linhas: LinhaPainel[] = [...acc.entries()].map(([k, a]) => {
    const chave = k.slice(0, k.lastIndexOf("|"));
    const e = a.emenda;
    return {
      s: chave,
      ex: a.ex,
      em: e ? `${e.numero_emenda}/${e.exercicio_emenda}` : null,
      autor: e?.autor_normalizado ?? null,
      tipo: e?.autor_tipo ?? null,
      conf: e?.confianca ?? "nula",
      mun: e?.municipio ?? null,
      benef: e?.beneficiario_nome ?? null,
      ug: a.ug,
      vemp: Math.round(a.vemp * 100) / 100,
      vpago: Math.round(a.vpago * 100) / 100,
      n: a.n,
      f: [...a.fontes].sort(),
    };
  });
  linhas.sort((x, y) => x.ex - y.ex || x.s.localeCompare(y.s));

  // O invariante do painel vale para quem quer que consuma o elo: se a soma
  // das linhas divergir do banco, há dupla contagem ou perda — pare aqui.
  const totalBanco = Math.round(empenhos.reduce((s, em) => s + (em.vlrempenhado ?? 0), 0) * 100) / 100;
  const totalLinhas = Math.round(linhas.reduce((s, l) => s + l.vemp, 0) * 100) / 100;
  if (Math.abs(totalLinhas - totalBanco) > 1) {
    throw new Error(`elo inconsistente: linhas R$ ${totalLinhas} != banco R$ ${totalBanco}`);
  }

  return linhas;
}
