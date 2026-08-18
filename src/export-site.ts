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

import { agregadoPorAutorEstadual, baseEleitoral, origemPorMunicipio, origemPorRegiao, todosCandidatos } from "./agregados.ts";
import type { Db } from "./db.ts";
import type { CargoAtual } from "./harvest-candidatos.ts";
import { casarCandidato, indexarPorNome } from "./harvest-candidatos.ts";
import type { EmendaFederalRow } from "./db.ts";
import { chaveCargo as chaveDeCargo, custoDaPessoa, custoDoGabinete, indexarRemuneracao } from "./custo-pessoal.ts";
import { linhasPainel } from "./elo-painel.ts";
import type { PerfilDeputado } from "./perfil-deputado.ts";
import { perfisDeputados, slugDeputado } from "./perfil-deputado.ts";

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

export function exportarSite(db: Db): SiteData {
  // O elo mora em elo-painel.ts, compartilhado com os agregados dos posts:
  // painel e série do X têm de chegar ao MESMO número por construção.
  const base = linhasPainel(db.raw);

  // (numero, ano) -> PLOA da ALEPE onde a emenda consta, para o link "conferir
  // na fonte" (primeiro pelo ano-LOA, semântica dominante; depois apresentação)
  const ploaPorEmenda = new Map<string, string>();
  const oficiais = db.raw
    .query("SELECT numero_emenda, exercicio_apresentacao, exercicio_loa, ploa FROM autoria_oficial")
    .all() as Array<{ numero_emenda: string; exercicio_apresentacao: number; exercicio_loa: number; ploa: string }>;
  for (const o of oficiais) ploaPorEmenda.set(`${o.numero_emenda}/${o.exercicio_apresentacao}`, o.ploa);
  for (const o of oficiais) ploaPorEmenda.set(`${o.numero_emenda}/${o.exercicio_loa}`, o.ploa);

  const linhas: LinhaSite[] = base.map((l) => ({
    ...l,
    ploa: l.em ? (ploaPorEmenda.get(l.em) ?? null) : null,
  }));

  const totalEmpenhadoBanco =
    Math.round(((db.raw.query("SELECT SUM(vlrempenhado) v FROM empenho").get() as { v: number | null }).v ?? 0) * 100) / 100;
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


// === Camada FEDERAL ===
// Uma linha por registro do arquivo da CGU (a granularidade da fonte é
// emenda × localidade × função). `cat` diz por que a linha está no recorte de
// PE — os botões do painel filtram por ela.

type LinhaFederal = {
  cod: string;
  ano: number;
  num: string | null;
  tipo: string | null;
  autor: string;
  cat: string;
  partido: string | null;
  loc: string | null;
  mun: string | null;
  func: string | null;
  vemp: number;
  vliq: number;
  vpago: number;
};

export type SiteDataFederal = {
  geradoEm: string;
  fonte: string;
  totalEmpenhadoBanco: number;
  linhas: LinhaFederal[];
};

export function exportarSiteFederal(db: Db): SiteDataFederal {
  const rows = db.listEmendasFederais() as EmendaFederalRow[];

  const linhas: LinhaFederal[] = rows.map((r) => ({
    cod: r.codigo_emenda,
    ano: r.ano,
    num: r.numero_emenda,
    tipo: r.tipo_emenda,
    autor: r.autor_normalizado,
    cat: r.cat,
    partido: r.partido,
    loc: r.localidade,
    mun: r.municipio,
    func: r.funcao,
    vemp: Math.round((r.vlrempenhado ?? 0) * 100) / 100,
    vliq: Math.round((r.vlrliquidado ?? 0) * 100) / 100,
    vpago: Math.round((r.vlrpago ?? 0) * 100) / 100,
  }));

  const totalEmpenhadoBanco = Math.round(rows.reduce((s, r) => s + (r.vlrempenhado ?? 0), 0) * 100) / 100;
  const totalSite = Math.round(linhas.reduce((s, l) => s + l.vemp, 0) * 100) / 100;
  if (Math.abs(totalSite - totalEmpenhadoBanco) > 1) {
    throw new Error(`export federal inconsistente: site R$ ${totalSite} != banco R$ ${totalEmpenhadoBanco}`);
  }

  return {
    geradoEm: new Date().toISOString(),
    fonte: "Emendas parlamentares federais — CGU/Portal da Transparência; bancada de PE via APIs da Câmara e do Senado",
    totalEmpenhadoBanco,
    linhas,
  };
}

// ---------------------------------------------------------- candidatos 2026

type MarcadorCandidato = {
  /** Chave: autor_normalizado, como aparece nos outros dois JSONs. */
  autor: string;
  cargo_2026: string;
  partido: string | null;
  /** Concorre ao MESMO cargo que ocupa hoje. Derivado — o TSE não informa. */
  reeleicao: boolean;
};

export type SiteDataCandidatos = {
  geradoEm: string;
  fonte: string;
  /** Texto exibido no rodapé do painel. A ressalva é parte do dado, não enfeite. */
  ressalva: string;
  totalCandidatosPE: number;
  porCargo: Record<string, number>;
  /** Nomes que casaram com mais de um candidato e por isso NÃO recebem marcador. */
  ambiguos: Array<{ autor: string; motivo: string }>;
  marcadores: MarcadorCandidato[];
};

/**
 * Cruza os autores de emendas com as candidaturas de 2026.
 *
 * Só produz marcador POSITIVO. Autor ausente da lista do TSE não vira
 * "não é candidato": o prazo de registro fecha em 15/08/2026 e a lista está
 * incompleta enquanto isso. Ambiguidade por homônimo também não vira
 * marcador — vai para `ambiguos`, visível, em vez de virar um chute.
 */
export function exportarSiteCandidatos(db: Db): SiteDataCandidatos {
  const candidatos = db.listCandidatos();
  const indice = indexarPorNome(candidatos);

  const marcadores: MarcadorCandidato[] = [];
  const ambiguos: Array<{ autor: string; motivo: string }> = [];
  const vistos = new Set<string>();

  const avaliar = (autor: string, cargoAtual: CargoAtual, partido: string | null): void => {
    if (!autor || vistos.has(autor)) return;
    vistos.add(autor);
    const v = casarCandidato(autor, cargoAtual, indice, partido);
    if (v.situacao === "candidato") {
      marcadores.push({ autor, cargo_2026: v.cargo_2026, partido: v.partido, reeleicao: v.reeleicao });
    } else if (v.situacao === "ambiguo") {
      ambiguos.push({ autor, motivo: v.motivo });
    }
  };

  // Federais primeiro: são os únicos com partido conhecido, o que desempata
  // homônimo. Um nome resolvido aqui não é reavaliado como estadual depois.
  for (const p of db.listParlamentaresFederais()) {
    avaliar(p.nome_normalizado, p.tipo === "senador" ? "Senador" : "Deputado Federal", p.partido ?? null);
  }

  // Estaduais: só autoria CONFIRMADA. Marcar como candidato alguém cuja
  // autoria foi apenas inferida somaria duas incertezas num rótulo público.
  const estaduais = db.raw
    .query("SELECT DISTINCT autor_normalizado a FROM emenda WHERE confianca = 'alta' AND autor_normalizado IS NOT NULL")
    .all() as Array<{ a: string }>;
  for (const { a } of estaduais) avaliar(a, "Deputado Estadual", null);

  const porCargo = candidatos.reduce<Record<string, number>>((acc, c) => ((acc[c.cargo] = (acc[c.cargo] ?? 0) + 1), acc), {});

  return {
    geradoEm: new Date().toISOString(),
    fonte: "Candidaturas — TSE/DivulgaCandContas, Eleições Gerais 2026 (PE)",
    ressalva:
      "Registro de candidaturas aberto até 15/08/2026 e todas as candidaturas estão aguardando julgamento. " +
      "A ausência do marcador não significa que a pessoa não é candidata.",
    totalCandidatosPE: candidatos.length,
    porCargo,
    ambiguos: ambiguos.sort((x, y) => x.autor.localeCompare(y.autor)),
    marcadores: marcadores.sort((x, y) => x.autor.localeCompare(y.autor)),
  };
}

// ------------------------------------------- ranking de bens dos candidatos

type LinhaBens = {
  /** id do TSE — permite conferir na fonte. */
  id: number;
  nome: string;
  cargo: string;
  partido: string | null;
  /** Região do MUNICÍPIO DE NASCIMENTO, não da base eleitoral. Ver NOTAS.md 30. */
  regiao: string | null;
  nasc: string | null;
  ocup: string | null;
  /** Escolaridade declarada. */
  esc: string | null;
  /** Patrimônio declarado, em reais. */
  bens: number;
  /** Quantidade de itens declarados. */
  qtd: number;
  /** true = suplente/vice (não disputa voto direto). */
  sup: boolean;
  /** Nome do titular da chapa, quando esta linha é de suplente/vice. */
  titular: string | null;
};

export type SiteDataBens = {
  geradoEm: string;
  fonte: string;
  ressalva: string;
  ressalvaRegiao: string;
  totalCandidatos: number;
  semDetalhe: number;
  linhas: LinhaBens[];
};

/**
 * Ranking de patrimônio declarado das candidaturas de PE em 2026.
 *
 * Inclui suplentes (marcados), porque o usuário precisa vê-los: suplente de
 * senador chega ao mandato sem passar por voto nominal, e o patrimônio deles
 * é dado público igual.
 *
 * "Sem bens declarados" (0) é informação, não ausência de dado: quem não
 * declarou nada aparece com zero e entra na contagem. Já quem ainda não teve
 * o detalhe coletado fica FORA da lista e é contado em `semDetalhe`, para não
 * virar um zero falso no ranking.
 */
export function exportarSiteBens(db: Db): SiteDataBens {
  const todos = db.listCandidatos();
  const detalhados = todos.filter((c) => c.detalhado === 1);
  // Sem o nome do titular a tag "suplente" não informa nada — a pergunta
  // óbvia de quem lê é "suplente de quem?".
  const porId = new Map(todos.map((c) => [c.id, c]));

  const linhas: LinhaBens[] = detalhados.map((c) => ({
    id: c.id,
    nome: c.nome_urna,
    cargo: c.cargo,
    partido: c.partido,
    regiao: c.regiao ?? null,
    nasc: c.municipio_nascimento ? `${c.municipio_nascimento}${c.uf_nascimento ? "/" + c.uf_nascimento : ""}` : null,
    ocup: c.ocupacao ?? null,
    esc: c.grau_instrucao ?? null,
    bens: Math.round((c.total_bens ?? 0) * 100) / 100,
    qtd: c.qtd_bens ?? 0,
    sup: c.id_titular !== null,
    titular: c.id_titular !== null ? (porId.get(c.id_titular)?.nome_urna ?? null) : null,
  }));

  linhas.sort((a, b) => b.bens - a.bens);

  return {
    geradoEm: new Date().toISOString(),
    fonte: "Bens declarados — TSE/DivulgaCandContas, Eleições Gerais 2026 (PE)",
    ressalva:
      "Patrimônio declarado pelo próprio candidato no registro de candidatura, ainda sujeito a julgamento. " +
      "Valor zero significa que nada foi declarado.",
    ressalvaRegiao:
      "A região vem do MUNICÍPIO DE NASCIMENTO. Deputado estadual, federal, senador e governador são eleitos " +
      "em circunscrição única (o estado inteiro) — não existe, no dado do TSE, a região que o candidato representa.",
    totalCandidatos: todos.length,
    semDetalhe: todos.length - detalhados.length,
    linhas,
  };
}

// ----------------------------------------------- origem dos candidatos

/**
 * Tela "de onde são os candidatos": naturalidade, base eleitoral de 2022 e
 * concentração de voto.
 *
 * O motivo de existir é corrigir um limite do próprio painel. O modo de bens
 * já filtra por região de NASCIMENTO, e NOTAS 30 avisa que isso não é a região
 * que o candidato representa — em PE a circunscrição é única. Naturalidade é
 * um proxy inválido de base territorial; votação por município é o dado real.
 * Aqui os dois aparecem lado a lado, para que a diferença seja visível.
 *
 * CPF NÃO SAI DAQUI. Ele é a chave de junção com o histórico do TSE e fica só
 * no banco local; o JSON público leva o `id` do TSE, que já é publicado hoje.
 */
export async function exportarSiteOrigem(db: Db, destino = "docs/candidatos-origem.json"): Promise<number> {
  const municipios = origemPorMunicipio(db.raw);
  const regioes = origemPorRegiao(db.raw);
  const base = baseEleitoral(db.raw);
  const candidatos = todosCandidatos(db.raw);

  const totalVotosBanco = (
    db.raw.query("SELECT SUM(votos) AS v FROM votacao_2022 WHERE nr_turno = 1 AND votos > 0").get() as { v: number | null }
  ).v ?? 0;
  const totalVotosSite = base.reduce((s, b) => s + b.totalVotos, 0);
  // Mesmo guard dos exports de emenda: se a soma divergir, o dado mudou e o
  // JSON não pode ir ao ar mentindo. Os exports de bens e candidatos não têm
  // este invariante, e é uma lacuna — aqui não se repete.
  if (totalVotosSite !== totalVotosBanco) {
    throw new Error(`export de origem inconsistente: site ${totalVotosSite} votos != banco ${totalVotosBanco}`);
  }

  const totalCandidatos = (db.raw.query("SELECT COUNT(*) AS n FROM candidato_2026").get() as { n: number }).n;
  const nascidosEmPE = municipios.reduce((s, m) => s + m.candidatos, 0);

  const payload = {
    geradoEm: new Date().toISOString(),
    fonte: "Naturalidade: TSE/DivulgaCandContas 2026 · Votação: TSE, votação nominal por município e zona, 2022 (1º turno)",
    ressalvaRegiao:
      "A região de nascimento NÃO é a região que o candidato representa. Deputado estadual, federal, senador e governador são eleitos em circunscrição única — o estado inteiro. Não existe distrito eleitoral no Brasil.",
    ressalvaVazio:
      "Município sem candidato nativo significa que ninguém NASCIDO ali concorre em 2026 — não que ninguém dispute votos lá.",
    ressalvaBase:
      "A votação de 2022 só existe para quem também concorreu naquele ano. Ausência aqui é 'não estava na urna em 2022', nunca 'teve zero voto'.",
    totalCandidatos,
    nascidosEmPE,
    nascidosForaDePE: totalCandidatos - nascidosEmPE,
    municipiosComNativoCandidato: municipios.filter((m) => m.candidatos > 0).length,
    municipiosSemNativoCandidato: municipios.filter((m) => m.candidatos === 0).length,
    candidatosComVotacao2022: base.length,
    totalVotos2022: totalVotosSite,
    municipios,
    regioes,
    // TODOS os 836. A tela lista candidatura, não só quem tem histórico de
    // voto — sumir com 595 estreantes num painel de transparência é o oposto
    // do que ele existe para fazer.
    candidatos,
    base,
  };

  await Bun.write(destino, `${JSON.stringify(payload)}\n`);
  return base.length;
}

/**
 * Malha municipal de PE para o mapa. Qualidade "minima" (85 KB) porque o
 * painel desenha o estado inteiro numa tela — a "maxima" tem 2 MB e nenhum
 * detalhe visível nessa escala. Chave `codarea` = código IBGE de 7 dígitos.
 */
export async function exportarMalhaPE(destino = "docs/malha-pe.json"): Promise<number> {
  const url =
    "https://servicodados.ibge.gov.br/api/v3/malhas/estados/26?formato=application/vnd.geo+json&intrarregiao=municipio&qualidade=minima";
  const res = await fetch(url, { headers: { "User-Agent": "emendas-pe (hermes@softagon.com.br)" } });
  if (!res.ok) throw new Error(`malha IBGE: HTTP ${res.status}`);
  const geo = (await res.json()) as { type: string; features: unknown[] };
  if (geo.type !== "FeatureCollection" || geo.features.length !== 185) {
    throw new Error(`malha IBGE inesperada: ${geo.type} com ${geo.features?.length} feições (esperado 185)`);
  }
  await Bun.write(destino, JSON.stringify(geo));
  return geo.features.length;
}

// === Pessoal: quem trabalha no gabinete de cada deputado estadual ===
//
// Dado nominal de pessoa, então o JSON carrega a data do snapshot e a ressalva
// no próprio corpo — a página não pode publicar "N assessores" sem dizer de
// quando é e de onde veio. Ver NOTAS.md item 37.

export type LinhaGabinete = {
  dep: string;
  /** slug do perfil (docs/deputado.html?d=slug) — mesma regra de perfil-deputado.ts */
  slug: string;
  partido: string | null;
  total: number;
  /** contagem por cargo, ex. { "Assessor Especial": 17 } */
  cargos: Record<string, number>;
  /** nomes, em ordem alfabética, com cargo, vínculo e o vencimento DO CARGO */
  pessoas: Array<{ nome: string; cargo: string | null; vinculo: string; desde: string | null; venc: number | null }>;
  /** custo mensal estimado: soma dos vencimentos de tabela dos comissionados */
  custo: number;
  /** pessoas sem estimativa de custo, e por quê */
  semCusto: number;
  /** o que o sistema legado da ALEPE dizia, quando havia par lá */
  legado: number | null;
};

export type SiteDataPessoal = {
  geradoEm: string;
  snapshot: string;
  fonte: string;
  fonteCusto: string;
  fonteTransparencia: string;
  ressalva: string;
  ressalvaCusto: string;
  competencia: string | null;
  totalGabinetes: number;
  totalEmGabinete: number;
  custoMensalTotal: number;
  /** vencimento de tabela por cargo, para a tela mostrar de onde vem a conta */
  tabelaCargos: Array<{ cargo: string; venc: number; pessoas: number }>;
  linhas: LinhaGabinete[];
  divergencias: Array<{ escopo: string; chave: string; tipo: string; detalhe: string }>;
};

export function exportarSitePessoal(db: Db): SiteDataPessoal {
  const snapshot = db.ultimoSnapshotPessoal();
  if (!snapshot) throw new Error("pessoal: nenhum snapshot no banco — rode `bun run coletar:pessoal` antes");

  const competencia = db.ultimaCompetenciaRemuneracao();
  const tabela = indexarRemuneracao(db.remuneracaoCargos());

  const gabinetes = db.listGabinetes();
  const pessoasPorCargo = new Map<string, number>();
  const linhas: LinhaGabinete[] = gabinetes.map((g) => {
    const pessoas = db.assessoresDoGabinete(g.chave, snapshot);
    const cargos: Record<string, number> = {};
    for (const p of pessoas) {
      const c = p.cargo ?? "(sem cargo informado)";
      cargos[c] = (cargos[c] ?? 0) + 1;
      pessoasPorCargo.set(c, (pessoasPorCargo.get(c) ?? 0) + 1);
    }
    const custo = custoDoGabinete(pessoas, tabela);
    return {
      dep: g.deputado_nome,
      slug: slugDeputado(g.deputado_normalizado),
      partido: g.partido,
      total: g.total,
      cargos,
      pessoas: pessoas.map((p) => ({
        nome: p.nome,
        cargo: p.cargo,
        vinculo: p.vinculo,
        desde: p.data_admissao,
        venc: custoDaPessoa(p, tabela).remuneracaoCargo,
      })),
      custo: custo.mensal,
      semCusto: custo.semValor,
      legado: g.total_legado,
    };
  });

  // Mesmo invariante dos outros exports: se a soma do JSON divergir do banco,
  // o dado mudou debaixo do export — quebrar é melhor do que publicar errado.
  for (const l of linhas) {
    if (l.pessoas.length !== l.total) {
      throw new Error(`pessoal: ${l.dep} tem total ${l.total} mas ${l.pessoas.length} nome(s) no snapshot ${snapshot}`);
    }
  }
  const totalEmGabinete = linhas.reduce((acc, l) => acc + l.total, 0);
  const noBanco = (db.raw
    .query("SELECT COUNT(*) c FROM servidor_alepe WHERE snapshot = $s AND gabinete_chave IS NOT NULL")
    .get({ s: snapshot }) as { c: number } | null)?.c ?? -1;
  if (totalEmGabinete !== noBanco) {
    throw new Error(`pessoal: soma do JSON (${totalEmGabinete}) diverge do banco (${noBanco})`);
  }

  return {
    geradoEm: new Date().toISOString(),
    snapshot,
    fonte: "Lotação de pessoal — Dados Abertos da Alepe (/api/v1/servidores e /api/v1/parlamentares)",
    fonteCusto: `Vencimento por cargo — Dados Abertos da Alepe (/api/v1/remuneracao), competência ${competencia ?? "não coletada"}`,
    fonteTransparencia: "Transparência Internacional – Brasil, ITGP Legislativo Estadual — indicador TA01 (‘Publica mensalmente, bases de dados com o salário dos servidores efetivos e comissionados de forma nominal’): Alepe = 0. Nota cheia só em CE, ES, GO e RS. transparenciainternacional.org.br/itgp/assembleia-legislativa/pernambuco/",
    ressalvaCusto:
      "A Alepe não publica remuneração individual — publica o vencimento de cada CARGO. O valor ao lado de cada nome " +
      "é o do cargo que a pessoa ocupa, não o que ela recebe. É bruto: sem descontos, sem 13º, sem férias, sem " +
      "gratificação e sem encargo patronal. Quem está à disposição é pago pelo órgão de origem e fica fora da conta. " +
      "Essa ausência é medida por avaliação externa: no ITGP Legislativo Estadual da Transparência Internacional – " +
      "Brasil, a Alepe recebe nota ZERO no indicador TA01, que mede exatamente a publicação do salário nominal dos " +
      "servidores; das 27 assembleias, só Ceará, Espírito Santo, Goiás e Rio Grande do Sul cumprem o critério.",
    competencia,
    ressalva:
      `Foto do dia ${snapshot.split("-").reverse().join("/")}, do sistema de dados abertos da Alepe. ` +
      "O portal legado da Alepe (funcionarios.php) publica números diferentes porque está desatualizado — " +
      "as diferenças estão listadas ao final.",
    totalGabinetes: gabinetes.length,
    totalEmGabinete,
    custoMensalTotal: Math.round(linhas.reduce((s, l) => s + l.custo, 0) * 100) / 100,
    tabelaCargos: [...pessoasPorCargo]
      .map(([cargo, pessoas]) => ({ cargo, venc: tabela.get(chaveDeCargo(cargo))?.remuneracao ?? 0, pessoas }))
      .sort((a, b) => b.venc - a.venc),
    linhas,
    divergencias: db.divergenciasPessoal(snapshot).map((d) => ({ escopo: d.escopo, chave: d.chave, tipo: d.tipo, detalhe: d.detalhe })),
  };
}

// === Perfil por deputado estadual ===
//
// Uma página por parlamentar, com o que as cinco camadas do projeto sabem
// dele. O JSON carrega as fontes de CADA bloco (não uma linha genérica no
// rodapé): assessores, emendas, votação e candidatura vêm de órgãos
// diferentes, com datas diferentes, e a tela precisa dizer qual é qual.

export type SiteDataDeputados = {
  geradoEm: string;
  snapshotPessoal: string;
  fontes: {
    gabinete: string;
    emendas: string;
    votacao2022: string;
    candidatura2026: string;
    bens: string;
    custo: string;
    transparencia: string;
  };
  ressalvas: {
    gabinete: string;
    emendas: string;
    candidatura: string;
    votacao: string;
    ranking: string;
    custo: string;
  };
  totais: {
    deputados: number;
    pessoasEmGabinete: number;
    mediaAssessores: number;
    comEmendas: number;
    vempTotal: number;
    custoMensalTotal: number;
    custoMensalMedio: number;
  };
  perfis: PerfilDeputado[];
};

/**
 * Índice enxuto (chave → slug) para as OUTRAS telas linkarem o perfil sem
 * baixar os 49 perfis inteiros. `docs/dados-deputados.json` tem 210 KB; isto
 * tem 4 KB e é tudo de que a tabela do painel precisa para virar link.
 */
export type IndiceDeputados = {
  geradoEm: string;
  itens: Array<{ chave: string; slug: string; nome: string; partido: string | null; assessores: number }>;
};

export function exportarIndiceDeputados(perfis: PerfilDeputado[]): IndiceDeputados {
  return {
    geradoEm: new Date().toISOString(),
    itens: perfis.map((p) => ({
      chave: p.chave,
      slug: p.slug,
      nome: p.nome,
      partido: p.partido,
      assessores: p.gabinete.total,
    })),
  };
}

export function exportarSiteDeputados(db: Db): SiteDataDeputados {
  const snapshot = db.ultimoSnapshotPessoal();
  if (!snapshot) throw new Error("deputados: nenhum snapshot de pessoal — rode `bun run coletar:pessoal` antes");

  const perfis = perfisDeputados(db);

  // Invariante cruzado: o agregado por autor do PAINEL é a referência
  // publicada. Se o perfil chegar a outro número para a mesma pessoa, é
  // porque o recorte divergiu — e o leitor clicaria em "confira no painel"
  // para encontrar um valor diferente. Quebrar aqui é melhor.
  const oficial = new Map(agregadoPorAutorEstadual(db.raw).map((a) => [a.chave, a]));
  for (const p of perfis) {
    const ref = oficial.get(p.chave);
    const meu = p.emendas?.vemp ?? 0;
    const dele = ref?.v ?? 0;
    if (Math.abs(meu - dele) > 1) {
      throw new Error(`perfil de ${p.nome}: R$ ${meu} no perfil != R$ ${dele} no agregado do painel`);
    }
    if (p.emendas && ref && p.emendas.n !== ref.n) {
      throw new Error(`perfil de ${p.nome}: ${p.emendas.n} emenda(s) no perfil != ${ref.n} no agregado do painel`);
    }
  }

  const totalPessoas = perfis.reduce((s, p) => s + p.gabinete.total, 0);
  return {
    geradoEm: new Date().toISOString(),
    snapshotPessoal: snapshot,
    fontes: {
      gabinete: "Dados Abertos da Alepe — /api/v1/servidores e /api/v1/parlamentares (dadosabertos.alepe.pe.gov.br)",
      emendas:
        "Execução: Portal da Transparência PE (painéis Pentaho) e CKAN dados.pe.gov.br · " +
        "Autoria: dados abertos da Alepe, bloco <emendas> do PLOA (proposicoes.alepe.pe.gov.br)",
      votacao2022: "TSE — votação nominal por município e zona, Eleições Gerais 2022, 1º turno (cdn.tse.jus.br)",
      candidatura2026: "TSE/DivulgaCandContas — Eleições Gerais 2026, circunscrição PE",
      bens: "TSE/DivulgaCandContas — bens declarados no registro de candidatura de 2026",
      custo: `Dados Abertos da Alepe — /api/v1/remuneracao, vencimento por cargo, competência ${db.ultimaCompetenciaRemuneracao() ?? "não coletada"}`,
      transparencia: "Transparência Internacional – Brasil, ITGP Legislativo Estadual — indicador TA01 (‘Publica mensalmente, bases de dados com o salário dos servidores efetivos e comissionados de forma nominal’): Alepe = 0. Nota cheia só em CE, ES, GO e RS. transparenciainternacional.org.br/itgp/assembleia-legislativa/pernambuco/",
    },
    ressalvas: {
      gabinete:
        `Foto do dia ${snapshot.split("-").reverse().join("/")}. O portal legado da Alepe publica números diferentes porque está desatualizado — as divergências estão na tela de gabinetes.`,
      emendas:
        "Só emendas com autoria CONFIRMADA no dicionário oficial da Alepe e com execução orçamentária nos empenhos coletados. " +
        "Emenda apresentada e não executada não aparece; autoria apenas inferida de texto livre não entra.",
      candidatura:
        "Marcador positivo-only: a ausência não significa que a pessoa não é candidata. As candidaturas de 2026 ainda estão sujeitas a julgamento.",
      votacao:
        "Votação de 2022, 1º turno. Deputado estadual é eleito em circunscrição única — o estado inteiro. " +
        "Onde teve voto não é 'a região que representa'.",
      ranking:
        "O tamanho de gabinete varia pouco (23 a 32 pessoas): os cargos são fixados por ato da Mesa, não pela vontade de cada deputado. " +
        "A posição no ranking mede diferença pequena e não deve ser lida como excesso ou economia.",
      custo:
        "A Alepe não publica remuneração individual — publica o vencimento de cada CARGO. O custo é a soma dos vencimentos " +
        "de tabela dos cargos ocupados: valor bruto, sem descontos, 13º, férias, gratificação ou encargo patronal, e sem " +
        "quem está à disposição (pago pelo órgão de origem). É estimativa de custo do gabinete, não folha de pagamento. " +
        "A Alepe tem nota ZERO no indicador TA01 do ITGP Legislativo Estadual (Transparência Internacional – Brasil), que " +
        "mede a publicação do salário nominal dos servidores; só 4 das 27 assembleias cumprem o critério.",
    },
    totais: {
      deputados: perfis.length,
      pessoasEmGabinete: totalPessoas,
      mediaAssessores: perfis.length ? Math.round((totalPessoas / perfis.length) * 10) / 10 : 0,
      comEmendas: perfis.filter((p) => p.emendas).length,
      vempTotal: Math.round(perfis.reduce((s, p) => s + (p.emendas?.vemp ?? 0), 0) * 100) / 100,
      custoMensalTotal: Math.round(perfis.reduce((s, p) => s + p.gabinete.custoMensal, 0) * 100) / 100,
      custoMensalMedio: perfis.length
        ? Math.round((perfis.reduce((s, p) => s + p.gabinete.custoMensal, 0) / perfis.length) * 100) / 100
        : 0,
    },
    perfis,
  };
}
