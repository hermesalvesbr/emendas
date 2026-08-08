// O valor real do projeto: extrai autoria de `obs` (§5.5).

import type { AutorTipo, Confianca, EmendaExtraida, EmpenhoBruto, EmpenhoRow } from "./types.ts";

// "PARLAMENTAR"/"PAR." e o "Nº"/"N°"/"N º"/"NO."/"N" são todos opcionais —
// achado ao investigar por que ~860 registros que citam "EMENDA"/"EP" ficavam
// órfãos: variações reais incluem "EMENDA 675/2019" (sem N nenhum), "EMENDA
// N° 864/2019" (sem a palavra PARLAMENTAR) e "EMENDA PAR. <nome> N 477/2020"
// (abreviado). Ver NOTAS.md.
const NUMERO_EMENDA_RE = /EMENDA\s+(?:PARLAMENTAR\s+)?(?:PAR\.\s+)?(?:N\s*(?:[º°]|O\.?)?\s*)?(\d+)(?:\s*\/\s*(?:LOA\s*)?(\d{4}))?/i;
const NUMERO_EP_RE = /\bEP\s+(\d+)(?:\s*\/\s*(\d{4}))?/i;

// Parada comum a quase todos os rótulos: espaço duplo, " - " (dash isolado),
// vírgula, parêntese ou fim da string.
const STOP = "(?=\\s{2,}|\\s-\\s|,|\\)|$)";

const AUTOR_PATTERNS: RegExp[] = [
  new RegExp(`AUTORA?:\\s*([^,)]+?)${STOP}`, "i"),
  // "DO (A) PARLAMENTAR <nome> PARA O MUNICÍPIO..." — rótulo comum nos empenhos
  // de repasse (achado empírico: ~29% dos registros órfãos usam esse formato).
  /\bPARLAMENTAR\s+([^,)(]+?)(?=\s+PARA\b|\s{2,}|\s-\s|,|\)|\(|$)/i,
  new RegExp(`DO\\s+DEPUTADOS?\\s+([^,)]+?)${STOP}`, "i"),
  // "DEPUTADO(A) ESTADUAL <nome>" — o qualificador "ESTADUAL" não deve entrar
  // na captura (achado: sem isso, a limpeza rejeitava a captura inteira e o
  // fallback bare-dash pegava a palavra errada antes, ex. "DERIVADA").
  new RegExp(`\\bDEPUTAD[AO]S?\\s+(?:ESTADUAL\\s+)?([^,)]+?)${STOP}`, "i"),
  new RegExp(`DEP\\.\\s*([^,)]+?)${STOP}`, "i"),
  new RegExp(`^\\s*[-,]\\s*([^,)]+?)${STOP}`),
];

const COLETIVA_MARKERS = ["JUNTAS", "BANCADA", "CONJUNTA", "TODOS OS DEPUTADOS"];

/**
 * Sinaliza onde o "nome" capturado por `AUTOR_PATTERNS` vira texto de
 * descrição do objeto/processo — texto livre real não respeita o separador de
 * espaço duplo com a mesma disciplina do exemplo da spec (achado empírico ao
 * validar contra dados reais: sem isso, ~22% dos registros "confiança alta"
 * carregavam a descrição inteira grudada no nome).
 */
const STOP_MARKERS =
  /\b(N[ºO°]|CONF(ORME)?\b|CI\b|POA\b|SEI\b|SEPLAG|FEM\b|REFERENTE|DESTINAD[AO]|DESTINA-SE|RECURSOS|OBS[;:]|QUANTIDADE|PARA\b|OBJETO|CUSTEIO|P\/|TER\.|ADESAO|DECRETO|PROJETO|REPROGRAMACAO|MUNIC[IÍ]P[IÍ]O|ESTADUAL|PERFURA|CONSTRU|AQUISI|REFORM|AMPLIA|IMPLANTA|MANUTEN|A?VIMENTA|RECUPERA|CAPACITA)/i;

/** Palavras que, no início do trecho capturado, indicam que não é um nome. */
const LEADING_NON_NAME =
  /^(DESTINAD[AO]|DESTINA-SE|PARA|OBJETO|REFERENTE|RECURSOS|CONVENIO|OFERECER|AQUISI[CÇ][AÃ]O|CONSTRU[CÇ][AÃ]O|REFORMA|AMPLIA[CÇ][AÃ]O|MANUTEN[CÇ][AÃ]O|A?VIMENTA[CÇ][AÃ]O|PERFURA[CÇ][AÃ]O|IMPLANTA[CÇ][AÃ]O|RECUPERA[CÇ][AÃ]O|ESTADUAL|MUNICIPAL|CAPACITA[CÇ][AÃ]O|EQUIPAMENTOS?|MATERIA(IS|L)|SERVI[CÇ]OS?|PRESTA[CÇ][AÃ]O|DERIVAD[AO]|EMENDA)\b/i;

/**
 * Só o número/exercício da emenda a partir de `obs`, sem tentar extrair
 * autor — usado tanto pelo primeiro passe de `extrairEmenda` quanto por
 * `harvest-pentaho.ts` quando o autor já vem nativo do painel (sem precisar
 * minerar texto para esse campo).
 */
export function extrairNumeroEmenda(
  obs: string,
  exercicioArquivo: number,
): { numeroEmenda: string; exercicioEmenda: number; tail: string } | null {
  let match = NUMERO_EMENDA_RE.exec(obs);
  if (!match) match = NUMERO_EP_RE.exec(obs);
  if (!match) return null;

  const numeroEmenda = match[1] ?? "";
  if (!numeroEmenda) return null;
  const anoCapturado = match[2] ? Number(match[2]) : null;
  const exercicioEmenda = anoCapturado ?? exercicioArquivo;
  const tail = obs.slice((match.index ?? 0) + match[0].length);

  return { numeroEmenda, exercicioEmenda, tail };
}

/** Extrai o que dá para extrair de uma única linha de `obs` (primeiro passe). */
export function extrairEmenda(
  row: { obs: EmpenhoBruto["obs"]; cd_nm_subacao: EmpenhoBruto["cd_nm_subacao"] | null },
  exercicioArquivo: number,
): EmendaExtraida {
  const subacaoCodigo = row.cd_nm_subacao ? row.cd_nm_subacao.trim().slice(0, 4).toUpperCase() : null;

  const obs = row.obs?.trim() ?? "";
  if (obs.length === 0) {
    return {
      numero_emenda: null,
      exercicio_emenda: null,
      subacao_codigo: subacaoCodigo,
      autor_bruto: null,
      autor_normalizado: null,
      autor_tipo: "desconhecido",
      confianca: "nula",
    };
  }

  const numero = extrairNumeroEmenda(obs, exercicioArquivo);
  if (!numero) {
    return {
      numero_emenda: null,
      exercicio_emenda: null,
      subacao_codigo: subacaoCodigo,
      autor_bruto: null,
      autor_normalizado: null,
      autor_tipo: "desconhecido",
      confianca: "nula",
    };
  }

  const { numeroEmenda, exercicioEmenda, tail } = numero;
  const autor = extrairAutor(tail);
  if (!autor) {
    return {
      numero_emenda: numeroEmenda,
      exercicio_emenda: exercicioEmenda,
      subacao_codigo: subacaoCodigo,
      autor_bruto: null,
      autor_normalizado: null,
      autor_tipo: "desconhecido",
      confianca: "nula",
    };
  }

  return {
    numero_emenda: numeroEmenda,
    exercicio_emenda: exercicioEmenda,
    subacao_codigo: subacaoCodigo,
    autor_bruto: autor.bruto,
    autor_normalizado: normalizarAutor(autor.limpo),
    autor_tipo: classificarAutorTipo(autor.limpo),
    confianca: "alta",
  };
}

/**
 * `bruto` é o trecho cru capturado pelo regex (sem tratamento, §5.5); `limpo`
 * é o mesmo trecho depois de cortado em `STOP_MARKERS`/pontuação — só esse
 * segundo passa a validação de "parece um nome" antes de virar `autor_alta`.
 */
function extrairAutor(tail: string): { bruto: string; limpo: string } | null {
  for (const re of AUTOR_PATTERNS) {
    const m = re.exec(tail);
    if (!m?.[1]) continue;
    const bruto = m[1].trim();
    if (bruto.length === 0) continue;
    const limpo = limparNomeCapturado(bruto);
    if (limpo) return { bruto, limpo };
  }
  return null;
}

function limparNomeCapturado(bruto: string): string | null {
  const stopMatch = STOP_MARKERS.exec(bruto);
  let cortado = stopMatch ? bruto.slice(0, stopMatch.index) : bruto;

  const pontoMatch = /\./.exec(cortado);
  if (pontoMatch) cortado = cortado.slice(0, pontoMatch.index);

  const limpo = cortado.replace(/^[.\-,\s]+|[.\-,\s]+$/g, "");
  if (limpo.length === 0) return null;

  const palavras = limpo.split(/\s+/).filter(Boolean);
  if (palavras.length === 0 || palavras.length > 5) return null;
  if (/\d/.test(limpo)) return null;
  if (LEADING_NON_NAME.test(palavras[0]!)) return null;

  return limpo;
}

export function classificarAutorTipo(autorBruto: string): AutorTipo {
  const normalizado = normalizarAutor(autorBruto);
  if (COLETIVA_MARKERS.some((marker) => normalizado.includes(marker))) return "coletiva";
  return "individual";
}

export function normalizarAutor(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Split de `credor` no primeiro espaço-hífen-espaço (§5.5). */
export function extrairBeneficiario(credor: string | null): { cnpj: string | null; nome: string | null } {
  if (!credor || credor.trim().length === 0) return { cnpj: null, nome: null };
  const idx = credor.indexOf(" - ");
  if (idx === -1) return { cnpj: null, nome: credor.trim() };
  return { cnpj: credor.slice(0, idx).trim(), nome: credor.slice(idx + 3).trim() };
}

const MUNICIPIO_OBS_RE = /\b([A-ZÀ-Ü][A-ZÀ-Ü\s]{1,40}?)-PE\b/;
const MUNICIPIO_CREDOR_RE = /\b(?:MUNICIPAL|PREFEITURA)\s+(?:DE\s+SAUDE\s+)?DE\s+([A-ZÀ-Ü][A-ZÀ-Ü\s]{1,40})$/;

/** Heurística sobre `credor` + `obs` (§5.5) — best effort, nunca decisivo sozinho. */
export function extrairMunicipio(credor: string | null, obs: string | null): string | null {
  if (obs) {
    const m = MUNICIPIO_OBS_RE.exec(obs);
    if (m?.[1]) return normalizarAutor(m[1]);
  }
  if (credor) {
    const m = MUNICIPIO_CREDOR_RE.exec(credor.trim());
    if (m?.[1]) return normalizarAutor(m[1]);
  }
  return null;
}

export type EmendaConsolidada = EmendaExtraida & {
  municipio: string | null;
  beneficiario_cnpj: string | null;
  beneficiario_nome: string | null;
};

/**
 * Segundo passe (§5.5): a subação é estável por emenda. Se uma subação aparece
 * em N registros e só alguns citam o autor explicitamente, propaga o autor para
 * os demais com `confianca: "media"` — nunca "alta" por propagação.
 */
export function propagarPorSubacao(extraidas: EmendaExtraida[]): EmendaExtraida[] {
  const autorPorSubacao = new Map<string, EmendaExtraida>();
  for (const e of extraidas) {
    if (e.confianca === "alta" && e.subacao_codigo && !autorPorSubacao.has(e.subacao_codigo)) {
      autorPorSubacao.set(e.subacao_codigo, e);
    }
  }

  return extraidas.map((e) => {
    if (e.confianca === "alta" || !e.subacao_codigo) return e;
    const fonte = autorPorSubacao.get(e.subacao_codigo);
    if (!fonte) return e;
    return {
      ...e,
      numero_emenda: e.numero_emenda ?? fonte.numero_emenda,
      exercicio_emenda: e.exercicio_emenda ?? fonte.exercicio_emenda,
      autor_bruto: fonte.autor_bruto,
      autor_normalizado: fonte.autor_normalizado,
      autor_tipo: fonte.autor_tipo,
      confianca: "media" as Confianca,
    };
  });
}

/** Consolida uma linha de `empenho` já persistida em um registro pronto para `emenda`. */
export function consolidarEmenda(empenho: Pick<EmpenhoRow, "obs" | "cd_nm_subacao" | "credor" | "exercicio">): EmendaConsolidada {
  const extraida = extrairEmenda({ obs: empenho.obs, cd_nm_subacao: empenho.cd_nm_subacao }, empenho.exercicio);
  const { cnpj, nome } = extrairBeneficiario(empenho.credor);
  const municipio = extrairMunicipio(empenho.credor, empenho.obs);
  return { ...extraida, municipio, beneficiario_cnpj: cnpj, beneficiario_nome: nome };
}

const CONFIANCA_RANK: Record<Confianca, number> = { alta: 2, media: 1, nula: 0 };

/**
 * Pipeline completo para o comando `normalizar`: consolida cada linha de
 * `empenho`, propaga autor por subação, e reduz para um registro por
 * `(numero_emenda, exercicio_emenda)` — a PK de `emenda` — já que uma mesma
 * emenda costuma ser paga em vários empenhos ao longo do ano.
 */
export function consolidarLote(
  empenhos: Array<Pick<EmpenhoRow, "obs" | "cd_nm_subacao" | "credor" | "exercicio">>,
): EmendaConsolidada[] {
  const consolidadas = empenhos.map(consolidarEmenda);
  const propagadasBase = propagarPorSubacao(consolidadas);
  const propagadas: EmendaConsolidada[] = propagadasBase.map((base, i) => ({
    ...base,
    municipio: consolidadas[i]?.municipio ?? null,
    beneficiario_cnpj: consolidadas[i]?.beneficiario_cnpj ?? null,
    beneficiario_nome: consolidadas[i]?.beneficiario_nome ?? null,
  }));

  const porChave = new Map<string, EmendaConsolidada>();
  for (const e of propagadas) {
    if (!e.numero_emenda || e.exercicio_emenda === null) continue;
    const chave = `${e.numero_emenda}|${e.exercicio_emenda}`;
    const atual = porChave.get(chave);
    if (!atual) {
      porChave.set(chave, e);
    } else if (CONFIANCA_RANK[e.confianca] > CONFIANCA_RANK[atual.confianca]) {
      porChave.set(chave, { ...e, municipio: atual.municipio ?? e.municipio });
    } else if (!atual.municipio && e.municipio) {
      porChave.set(chave, { ...atual, municipio: e.municipio });
    }
  }
  return [...porChave.values()];
}

export type CoberturaStats = {
  totalEmpenhos: number;
  totalEmendas: number;
  comAutorAlta: number;
  comAutorMedia: number;
  semAutor: number;
  orfaos: Array<{ subacao_codigo: string | null; exercicio: number; total: number }>;
};

/** O entregável mais importante do projeto (§5.5): quanto do buraco de autoria dá para fechar sem LAI. */
export function gerarCoberturaMarkdown(stats: CoberturaStats, geradoEm: Date): string {
  const pctAlta = pct(stats.comAutorAlta, stats.totalEmendas);
  const pctMedia = pct(stats.comAutorMedia, stats.totalEmendas);
  const pctSem = pct(stats.semAutor, stats.totalEmendas);

  const linhasOrfaos =
    stats.orfaos.length > 0
      ? stats.orfaos
          .map((o) => `- \`${o.subacao_codigo ?? "(sem código)"}\` (exercício ${o.exercicio}): ${o.total} empenho(s)`)
          .join("\n")
      : "_nenhum código de subação órfão._";

  return `# Cobertura de autoria — emendas-pe

Gerado em ${geradoEm.toISOString()}.

## Resumo

| Métrica | Valor |
|---|---|
| Total de empenhos coletados | ${stats.totalEmpenhos} |
| Total de emendas identificadas | ${stats.totalEmendas} |
| Com autor explícito (confiança alta) | ${stats.comAutorAlta} (${pctAlta}%) |
| Resolvido por propagação (confiança média) | ${stats.comAutorMedia} (${pctMedia}%) |
| Sem autor identificado (confiança nula) | ${stats.semAutor} (${pctSem}%) |

## Subações órfãs

Códigos de subação sem nenhuma emenda com autor identificado (nem direto, nem por
propagação). São os candidatos naturais a um pedido de LAI.

${linhasOrfaos}
`;
}

function pct(n: number, total: number): string {
  if (total === 0) return "0.0";
  return ((n / total) * 100).toFixed(1);
}
