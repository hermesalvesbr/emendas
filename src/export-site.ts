// Exporta o SQLite para o JSON estático que alimenta o site de consulta
// (docs/ — hospedável no GitHub Pages, sem backend).
//
// Unidade de análise: (emenda × exercício de execução). O elo empenho↔emenda
// tem duas formas, na ordem: (1) o código de 4 chars da subação, quando a
// subação vem no formato "XXXX - ..." (CKAN e painel principal); (2) o par
// numero/ano extraído do texto (subação ou obs) quando não há código — caso
// do painel histórico, cujo nm_subacao vem sem prefixo (o corte cego de 4
// chars criava a pseudo-subação "EMEN" e atribuiu R$ 177 mi à emenda errada;
// ver NOTAS.md item 26). Somas por chave, sem dupla contagem.

import type { Db } from "./db.ts";
import type { EmpenhoRow, EmendaRow } from "./types.ts";
import { extrairCodigoSubacao, extrairNumeroEmenda } from "./normalize.ts";

type LinhaSite = {
  /** chave do elo (código de subação ou numero/ano textual) */
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
  /** fontes dos empenhos desta linha ("ckan" e/ou "pentaho") */
  f: string[];
  /** PLOA onde a emenda consta na ALEPE ("1297/2023"), para o link de conferência */
  ploa: string | null;
};

export type SiteData = {
  geradoEm: string;
  fonte: string;
  totalEmpenhadoBanco: number;
  linhas: LinhaSite[];
};

const RANK = { alta: 0, media: 1, nula: 2 } as const;

export function exportarSite(db: Db): SiteData {
  const empenhos = db.listEmpenhos();
  const emendas = db.raw.query("SELECT * FROM emenda").all() as EmendaRow[];

  // (numero, ano) -> PLOA da ALEPE onde a emenda consta, para o link "conferir
  // na fonte" (primeiro pelo ano-LOA, semântica dominante; depois apresentação)
  const ploaPorEmenda = new Map<string, string>();
  const oficiais = db.raw
    .query("SELECT numero_emenda, exercicio_apresentacao, exercicio_loa, ploa FROM autoria_oficial")
    .all() as Array<{ numero_emenda: string; exercicio_apresentacao: number; exercicio_loa: number; ploa: string }>;
  for (const o of oficiais) ploaPorEmenda.set(`${o.numero_emenda}/${o.exercicio_apresentacao}`, o.ploa);
  for (const o of oficiais) ploaPorEmenda.set(`${o.numero_emenda}/${o.exercicio_loa}`, o.ploa);

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
      // elo textual: numero/ano extraído da própria subação (histórico) ou do obs
      const num =
        extrairNumeroEmenda(em.cd_nm_subacao ?? "", em.exercicio) ?? extrairNumeroEmenda(em.obs ?? "", em.exercicio);
      if (num) {
        chave = `T:${num.numeroEmenda}/${num.exercicioEmenda}`;
        emenda = porNumeroAno.get(`${num.numeroEmenda}/${num.exercicioEmenda}`) ?? null;
      } else {
        chave = `E:${em.id}`; // sem elo nenhum — linha isolada, não some com nada
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

  const linhas: LinhaSite[] = [...acc.entries()].map(([k, a]) => {
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
      ploa: e ? (ploaPorEmenda.get(`${e.numero_emenda}/${e.exercicio_emenda}`) ?? null) : null,
    };
  });
  linhas.sort((x, y) => x.ex - y.ex || x.s.localeCompare(y.s));

  const totalEmpenhadoBanco =
    Math.round(empenhos.reduce((s, em) => s + (em.vlrempenhado ?? 0), 0) * 100) / 100;
  const totalSite = Math.round(linhas.reduce((s, l) => s + l.vemp, 0) * 100) / 100;
  if (Math.abs(totalSite - totalEmpenhadoBanco) > 1) {
    throw new Error(`export inconsistente: site R$ ${totalSite} != banco R$ ${totalEmpenhadoBanco}`);
  }

  return {
    geradoEm: new Date().toISOString(),
    fonte: "Portal da Transparência PE (painéis Pentaho), CKAN dados.pe.gov.br e API de dados abertos da ALEPE",
    totalEmpenhadoBanco,
    linhas,
  };
}
