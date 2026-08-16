// Gerador do pool de posts da série de 3 em 3 horas.
//
// Ninguém escreve 392 posts à mão, e os 17 de POSTS-X.md foram escritos assim
// — com três erros publicados por números de memória. Aqui o texto sai do
// agregado, e todo post passa pelo verificador contra o banco ANTES de entrar
// no pool. O que não passa é descartado com a regra que o reprovou.
//
// Templates são funções PURAS de (fatia, variante) para camadas de texto:
// dá para testá-los sem banco e sem rede, e o mesmo recorte sempre rende o
// mesmo texto (pool reproduzível, diff revisável).

import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  type AgregadoAutor,
  type AgregadoAutorMunicipio,
  type AgregadoFuncao,
  type AgregadoFuncaoAno,
  type AgregadoMunicipio,
  type AgregadoSubfuncao,
  agregadoPorAutorEstadual,
  agregadoPorAutorFederal,
  agregadoPorFuncao,
  agregadoPorFuncaoAno,
  agregadoPorMunicipio,
  agregadoPorSubfuncao,
  type CuriosidadeMunicipio,
  curiosidadesPorMunicipio,
  liderPorMunicipio,
} from "./agregados.ts";
import { pesoX } from "./post-x.ts";
import { type DominioFato, type Fato, indiceDeFatos, verificarPost } from "./verificar-post.ts";

export type Eixo = "cidade" | "autor" | "funcao" | "curiosidade";
export type Postura = "dado" | "campanha";

export type PostGerado = {
  /** Determinístico e estável: "cidade:CASINHAS:per-capita". */
  id: string;
  eixo: Eixo;
  template: string;
  variante: number;
  postura: Postura;
  texto: string;
  peso: number;
  /** sha256 do texto normalizado — trava contra o 403 duplicate content da X. */
  hash: string;
  /** O que o post AFIRMA citar. Vira `rotulosEsperados` na verificação. */
  fatos: Fato[];
  chave: Record<string, string | number>;
  /** Valor de referência para ordenar o eixo (R$ do recorte). */
  peso_editorial: number;
  /** Domínios que este texto pode citar, conferidos de novo na publicação. */
  dominios: DominioFato[];
};

export type Descarte = { id: string; regra: string; detalhe: string };

/**
 * Domínio de fatos que cada eixo pode citar. Impede que um post de emenda seja
 * validado por um número de urna e vice-versa — a diluição do índice já
 * reabriu erros que estavam travados por eval.
 */
const DOMINIO_DO_EIXO: Record<Eixo, DominioFato[]> = {
  cidade: ["emendas"],
  autor: ["emendas"],
  funcao: ["emendas"],
  curiosidade: ["candidaturas", "votacao"],
};

// ------------------------------------------------------------- formatação

/**
 * Reais na precisão que o verificador consegue confirmar.
 *
 * A tolerância que `extrairNumeros` deriva é metade da última casa escrita:
 * "R$ 8,0 mi" afirma 8,45–8,55 mi... não — afirma ±50 mil. O arredondamento
 * aqui erra no máximo essa mesma metade, então o número escrito sempre casa
 * com o fato de origem. Escrever com MENOS precisão do que isto faria o
 * gerador se auto-reprovar.
 */
export function formatarReais(v: number): string {
  if (v >= 1e9) return `R$ ${(v / 1e9).toFixed(2).replace(".", ",")} bi`;
  if (v >= 1e6) return `R$ ${(v / 1e6).toFixed(1).replace(".", ",")} mi`;
  if (v >= 1e3) return `R$ ${Math.round(v / 1e3)} mil`;
  return `R$ ${Math.round(v)}`;
}

/** Valor que o texto de fato afirma, para o fato acompanhar o arredondamento. */
export function valorAfirmado(v: number): number {
  if (v >= 1e9) return Number((v / 1e9).toFixed(2)) * 1e9;
  if (v >= 1e6) return Number((v / 1e6).toFixed(1)) * 1e6;
  if (v >= 1e3) return Math.round(v / 1e3) * 1e3;
  return Math.round(v);
}

export function formatarInteiro(n: number): string {
  return n.toLocaleString("pt-BR");
}

/** Número decimal com uma casa, em pt-BR ("7,1"). */
export function pct(v: number): string {
  return v.toFixed(1).replace(".", ",");
}

/** O valor que `pct()` de fato afirma — o fato tem de acompanhar o arredondamento. */
export function valorAfirmadoDecimal(v: number): number {
  return Number(v.toFixed(1));
}

/**
 * Nome de cidade sempre com UF e região.
 *
 * Sem isso, "João Alfredo recebeu R$ 3,6 mi em emendas" lê como uma PESSOA
 * recebendo o dinheiro. PE tem vários municípios com nome de gente — João
 * Alfredo, Joaquim Nabuco, Vicência —, e num post de campanha a ambiguidade
 * não é só feia: sugere enriquecimento de alguém que não existe.
 */
export function cidadeCom(nome: string, regiao: string | null): string {
  if (!regiao) return `${nome} (PE)`;
  // "Recife (PE), na Região Metropolitana do Recife," é pleonasmo; a UF já
  // desfaz a ambiguidade quando o nome da cidade está no nome da região.
  if (regiao.includes(nome)) return `${nome} (PE)`;
  return `${nome} (PE), ${artigoDaRegiao(regiao)} ${regiao},`;
}

/** "É 1 emenda" / "São 4 emendas" — concordância, não interpolação cega. */
export function contagem(n: number, singular: string, plural: string): string {
  return n === 1 ? `É ${formatarInteiro(n)} ${singular}` : `São ${formatarInteiro(n)} ${plural}`;
}

/** Versão curta, para quando a frase já disse a região. */
export function cidadeUF(nome: string): string {
  return `${nome} (PE)`;
}

/** "Região"/"Zona" são femininos; "Agreste"/"Sertão", masculinos. */
export function artigoDaRegiao(regiao: string): string {
  return /^(Região|Zona)\b/.test(regiao) ? "na" : "no";
}

// ------------------------------------------------------------------ camadas

export type Camada = { texto: string; prioridade: number };

/**
 * Monta o post derrubando a camada de MENOR prioridade enquanto não couber.
 *
 * Não é zelo: "Vitória de Santo Antão" com valor de 7 dígitos e nome de autor
 * longo estoura 280 sem isso, e o post inteiro seria descartado por peso.
 */
export function montar(camadas: Camada[]): string {
  const vivas = [...camadas];
  const render = (): string =>
    limparPontuacao(
      vivas
        .map((c) => c.texto.trim())
        .filter((t) => t.length > 0)
        .join("\n\n"),
    );

  while (vivas.length > 1 && pesoX(render()) > 280) {
    let piorIdx = 0;
    for (let i = 1; i < vivas.length; i++) {
      if ((vivas[i]?.prioridade ?? 0) < (vivas[piorIdx]?.prioridade ?? 0)) piorIdx = i;
    }
    vivas.splice(piorIdx, 1);
  }
  return render();
}

/**
 * Conserta a pontuação que a composição produz.
 *
 * `cidadeCom()` fecha com vírgula porque quase sempre há oração depois; quando
 * a cidade encerra a frase, sai "no Agreste Setentrional,." — pequeno, mas num
 * texto que se propõe conferível a desatenção visível custa credibilidade.
 * Fica na montagem, e não em cada template, porque o problema nasce da junção.
 */
export function limparPontuacao(texto: string): string {
  return texto
    .replace(/,\s*([.!?])/g, "$1")
    .replace(/,{2,}/g, ",")
    .replace(/\s+,/g, ",")
    .replace(/[ \t]{2,}/g, " ");
}

/** Variante determinística: mesmo recorte → mesma redação, sempre. */
export function varianteDe(id: string, n: number): number {
  const hex = createHash("sha256").update(id).digest("hex").slice(0, 8);
  return Number(BigInt(`0x${hex}`) % BigInt(n));
}

function hashTexto(texto: string): string {
  return createHash("sha256")
    .update(texto.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------- eixo: cidade

// A UF e a região vão na PRIMEIRA linha, não numa camada de rodapé: é ali que
// a ambiguidade nasce, e rodapé é o primeiro a cair quando o post estoura.
const ABERTURA_CIDADE = [
  (m: AgregadoMunicipio) => `O município de ${cidadeCom(m.nome, m.regiao)} recebeu ${formatarReais(m.v)} em emendas parlamentares entre 2023 e 2026.`,
  (m: AgregadoMunicipio) => `${formatarReais(m.v)} em emendas parlamentares chegaram ao município de ${cidadeCom(m.nome, m.regiao)} de 2023 a 2026.`,
  (m: AgregadoMunicipio) => `Emendas parlamentares no município de ${cidadeCom(m.nome, m.regiao)} entre 2023 e 2026: ${formatarReais(m.v)}.`,
  (m: AgregadoMunicipio) => `O painel registra ${formatarReais(m.v)} em emendas com destino ao município de ${cidadeCom(m.nome, m.regiao)} desde 2023.`,
] as const;

function templateCidadeTotal(m: AgregadoMunicipio): { camadas: Camada[]; fatos: Fato[] } | null {
  if (m.v <= 0 || m.n <= 0) return null;
  const variante = varianteDe(`cidade:${m.municipio}:total`, ABERTURA_CIDADE.length);
  const abertura = ABERTURA_CIDADE[variante] ?? ABERTURA_CIDADE[0];

  return {
    camadas: [
      { texto: abertura(m), prioridade: 100 },
      {
        texto: `${contagem(m.n, "emenda", "emendas")} com execução orçamentária registrada, somando estaduais e federais.`,
        prioridade: 80,
      },
      { texto: "Dado do painel aberto, com a fonte oficial de cada linha.", prioridade: 30 },
    ],
    fatos: [
      { valor: valorAfirmado(m.v), rotulo: `emendas de ${m.municipio}` },
      { valor: m.n, rotulo: `nº de emendas de ${m.municipio}` },
    ],
  };
}

const ABERTURA_PER_CAPITA = [
  (m: AgregadoMunicipio) => `O município de ${cidadeCom(m.nome, m.regiao)} tem ${formatarReais(m.porHabitante)} por habitante em emendas parlamentares.`,
  (m: AgregadoMunicipio) => `No município de ${cidadeCom(m.nome, m.regiao)} a emenda parlamentar equivale a ${formatarReais(m.porHabitante)} por morador.`,
  (m: AgregadoMunicipio) => `${formatarReais(m.porHabitante)} por habitante: é o que o município de ${cidadeCom(m.nome, m.regiao)} recebeu em emendas.`,
  (m: AgregadoMunicipio) => `Divididas pela população, as emendas do município de ${cidadeCom(m.nome, m.regiao)} dão ${formatarReais(m.porHabitante)} por pessoa.`,
] as const;

function templateCidadePerCapita(m: AgregadoMunicipio): { camadas: Camada[]; fatos: Fato[] } | null {
  // Abaixo de R$ 100 mil o per capita vira centavos e a frase não informa nada.
  if (m.v < 1e5 || m.populacao <= 0 || m.porHabitante < 1) return null;
  const variante = varianteDe(`cidade:${m.municipio}:per-capita`, ABERTURA_PER_CAPITA.length);
  const abertura = ABERTURA_PER_CAPITA[variante] ?? ABERTURA_PER_CAPITA[0];

  return {
    camadas: [
      { texto: abertura(m), prioridade: 100 },
      {
        texto: `${formatarReais(m.v)} divididos entre ${formatarInteiro(m.populacao)} habitantes (Censo 2022).`,
        prioridade: 80,
      },
      { texto: "Comparar por habitante muda o ranking: cidade pequena com emenda grande sobe.", prioridade: 30 },
    ],
    fatos: [
      { valor: valorAfirmado(m.porHabitante), rotulo: `R$ por habitante em ${m.municipio}` },
      { valor: valorAfirmado(m.v), rotulo: `emendas de ${m.municipio}` },
      { valor: m.populacao, rotulo: `população de ${m.municipio}` },
    ],
  };
}

// O post em que cidade e pessoa dividem a mesma frase: sem "o município de"
// e sem a UF, "Em Joaquim Nabuco, quem mais aparece é Fulano" fica ilegível.
const ABERTURA_LIDER = [
  (l: AgregadoAutorMunicipio) => `No município de ${cidadeCom(l.nome, l.regiao)} quem mais aparece nas emendas de autoria confirmada é ${l.autorNome}: ${formatarReais(l.v)}.`,
  (l: AgregadoAutorMunicipio) => `${l.autorNome} lidera as emendas de autoria confirmada no município de ${cidadeCom(l.nome, l.regiao)} com ${formatarReais(l.v)}.`,
  (l: AgregadoAutorMunicipio) => `${formatarReais(l.v)} destinados ao município de ${cidadeCom(l.nome, l.regiao)} vêm de emendas assinadas por ${l.autorNome}.`,
] as const;

function templateCidadeLider(l: AgregadoAutorMunicipio): { camadas: Camada[]; fatos: Fato[] } | null {
  if (l.v < 2e5) return null;
  const variante = varianteDe(`cidade:${l.municipio}:lider`, ABERTURA_LIDER.length);
  const abertura = ABERTURA_LIDER[variante] ?? ABERTURA_LIDER[0];

  return {
    camadas: [
      { texto: abertura(l), prioridade: 100 },
      {
        texto: `${contagem(l.n, "emenda", "emendas")} com autoria confirmada na fonte — o painel não atribui nome por dedução.`,
        prioridade: 80,
      },
      { texto: "Onde o dado não diz quem assinou, ele mostra \"sem autor\".", prioridade: 30 },
    ],
    fatos: [
      { valor: valorAfirmado(l.v), rotulo: `emendas de ${l.autorNome} em ${l.municipio}` },
      { valor: l.n, rotulo: `nº de emendas de ${l.autorNome} em ${l.municipio}` },
    ],
  };
}

// ----------------------------------------------------------- eixo: autor

const ABERTURA_AUTOR_EST = [
  (a: AgregadoAutor) => `${a.nome} tem ${formatarReais(a.v)} em emendas estaduais com execução registrada.`,
  (a: AgregadoAutor) => `Emendas estaduais de ${a.nome}, 2023–2026: ${formatarReais(a.v)} empenhados.`,
  (a: AgregadoAutor) => `${formatarReais(a.v)} em emendas estaduais saíram com a assinatura de ${a.nome}.`,
  (a: AgregadoAutor) => `No painel, ${a.nome} aparece com ${formatarReais(a.v)} em emendas estaduais.`,
] as const;

function templateAutorEstadual(a: AgregadoAutor): { camadas: Camada[]; fatos: Fato[] } | null {
  // municipios = 0 acontece quando nenhuma emenda do autor teve o destino
  // municipal identificado. "0 municípios" não é fato do índice (add() exige
  // > 0) e a frase não informa nada.
  if (a.v < 1e5 || a.municipios < 1) return null;
  const variante = varianteDe(`autor:est:${a.chave}:total`, ABERTURA_AUTOR_EST.length);
  const abertura = ABERTURA_AUTOR_EST[variante] ?? ABERTURA_AUTOR_EST[0];

  return {
    camadas: [
      { texto: abertura(a), prioridade: 100 },
      {
        texto: `${formatarInteiro(a.n)} ${a.n === 1 ? "emenda" : "emendas"} em ${formatarInteiro(a.municipios)} ${a.municipios === 1 ? "município" : "municípios"}.`,
        prioridade: 80,
      },
      { texto: "Só autoria confirmada na fonte oficial entra nesta conta.", prioridade: 30 },
    ],
    fatos: [
      { valor: valorAfirmado(a.v), rotulo: `emendas estaduais de ${a.nome}` },
      { valor: a.n, rotulo: `nº de emendas estaduais de ${a.nome}` },
      { valor: a.municipios, rotulo: `municípios atendidos por ${a.nome}` },
    ],
  };
}

const ABERTURA_AUTOR_FED = [
  (a: AgregadoAutor) => `${a.nome} (${a.partido}) tem ${formatarReais(a.v)} em emendas federais empenhadas para Pernambuco.`,
  (a: AgregadoAutor) => `Emendas federais de ${a.nome} (${a.partido}) com foco em PE: ${formatarReais(a.v)}.`,
  (a: AgregadoAutor) => `${formatarReais(a.v)} em emendas federais para Pernambuco levam a assinatura de ${a.nome} (${a.partido}).`,
  (a: AgregadoAutor) => `No recorte federal, ${a.nome} (${a.partido}) responde por ${formatarReais(a.v)} em PE.`,
] as const;

function templateAutorFederal(a: AgregadoAutor): { camadas: Camada[]; fatos: Fato[] } | null {
  if (a.v < 1e6 || !a.partido) return null;
  const variante = varianteDe(`autor:fed:${a.chave}:total`, ABERTURA_AUTOR_FED.length);
  const abertura = ABERTURA_AUTOR_FED[variante] ?? ABERTURA_AUTOR_FED[0];

  return {
    camadas: [
      { texto: abertura(a), prioridade: 100 },
      { texto: `${contagem(a.n, "emenda", "emendas")} no arquivo da CGU.`, prioridade: 80 },
      { texto: "Boa parte é registrada como PERNAMBUCO (UF), sem cidade: o recorte municipal é piso, não teto.", prioridade: 30 },
    ],
    fatos: [
      { valor: valorAfirmado(a.v), rotulo: `emendas federais de ${a.nome}` },
      { valor: a.n, rotulo: `nº de emendas federais de ${a.nome}` },
    ],
  };
}

// ---------------------------------------------------------- eixo: função

/**
 * Exceções de redação que a lei impõe (skill fonte-oficial). Saúde lidera por
 * piso constitucional de 50%, não por escolha; "Encargos especiais" é a
 * rubrica das emendas Pix, que TÊM regra (art. 166-A) — o que falta é o
 * registro do setor.
 */
function ressalvaDaFuncao(funcao: string): string | null {
  if (/^sa[úu]de$/i.test(funcao)) return "Saúde lidera por obrigação: a Constituição exige o mínimo de 50% das emendas individuais na área (EC 86/2015 e EC 126/2022).";
  if (/encargos especiais/i.test(funcao)) return "É a rubrica onde entram as emendas Pix. Elas têm regra — mínimo de 70% em despesa de capital (art. 166-A) —, o que falta é o registro do setor.";
  return null;
}

const ABERTURA_FUNCAO = [
  (f: AgregadoFuncao) => `${f.funcao} concentra ${formatarReais(f.v)} em emendas federais empenhadas para Pernambuco.`,
  (f: AgregadoFuncao) => `Emendas federais para PE em ${f.funcao}: ${formatarReais(f.v)}.`,
  (f: AgregadoFuncao) => `${formatarReais(f.v)} das emendas federais de Pernambuco foram para ${f.funcao}.`,
  (f: AgregadoFuncao) => `No recorte por área, ${f.funcao} soma ${formatarReais(f.v)} em emendas federais em PE.`,
] as const;

function templateFuncao(f: AgregadoFuncao): { camadas: Camada[]; fatos: Fato[] } | null {
  if (f.v < 1e6) return null;
  const variante = varianteDe(`funcao:${f.funcao}:total`, ABERTURA_FUNCAO.length);
  const abertura = ABERTURA_FUNCAO[variante] ?? ABERTURA_FUNCAO[0];
  const ressalva = ressalvaDaFuncao(f.funcao);

  return {
    camadas: [
      { texto: abertura(f), prioridade: 100 },
      { texto: `${formatarInteiro(f.n)} ${f.n === 1 ? "emenda" : "emendas"}, de ${formatarInteiro(f.autores)} ${f.autores === 1 ? "autor" : "autores"} distintos.`, prioridade: 70 },
      { texto: ressalva ?? "Dado do arquivo aberto da CGU, conferível linha a linha.", prioridade: ressalva ? 90 : 30 },
    ],
    fatos: [
      { valor: valorAfirmado(f.v), rotulo: `emendas federais em ${f.funcao}` },
      { valor: f.n, rotulo: `nº de emendas federais em ${f.funcao}` },
      { valor: f.autores, rotulo: `autores de emendas federais em ${f.funcao}` },
    ],
  };
}

function templateFuncaoAno(f: AgregadoFuncaoAno): { camadas: Camada[]; fatos: Fato[] } | null {
  if (f.v < 1e7) return null;
  const ressalva = ressalvaDaFuncao(f.funcao);
  return {
    camadas: [
      { texto: `Em ${f.ano}, ${f.funcao} recebeu ${formatarReais(f.v)} em emendas federais empenhadas para Pernambuco.`, prioridade: 100 },
      { texto: `${formatarInteiro(f.n)} ${f.n === 1 ? "emenda" : "emendas"} no exercício.`, prioridade: 70 },
      { texto: ressalva ?? "Um ano de cada vez mostra o que o total esconde.", prioridade: ressalva ? 90 : 30 },
    ],
    fatos: [
      { valor: valorAfirmado(f.v), rotulo: `emendas federais em ${f.funcao} em ${f.ano}` },
      { valor: f.n, rotulo: `nº de emendas federais em ${f.funcao} em ${f.ano}` },
    ],
  };
}

function templateSubfuncao(s: AgregadoSubfuncao): { camadas: Camada[]; fatos: Fato[] } | null {
  if (s.v < 5e6) return null;
  return {
    camadas: [
      { texto: `${s.subfuncao} soma ${formatarReais(s.v)} em emendas federais empenhadas em Pernambuco.`, prioridade: 100 },
      { texto: `${contagem(s.n, "emenda", "emendas")}, dentro da função ${s.funcao}.`, prioridade: 70 },
      { texto: "A subfunção é o nível em que dá para ver o que o dinheiro comprou.", prioridade: 30 },
    ],
    fatos: [
      { valor: valorAfirmado(s.v), rotulo: `emendas federais em ${s.subfuncao}` },
      { valor: s.n, rotulo: `nº de emendas federais em ${s.subfuncao}` },
    ],
  };
}

// ------------------------------------------------------ eixo: curiosidade

/**
 * O eixo que o leitor local reconhece. Naturalidade e votação de 2022 são
 * dados públicos e verificáveis, e falam de gente e lugar em vez de rubrica
 * orçamentária — é o que faz alguém parar no feed.
 *
 * Regra que atravessa os quatro templates: nunca afirmar nada sobre a
 * candidatura de 2026 de quem aparece na votação de 2022. O dado citado é do
 * passado, e dizer que fulano "é candidato" exigiria o marcador do TSE
 * (NOTAS 29). Aqui só se diz o que aconteceu na urna de 2022.
 */

const ABERTURA_BERCO = [
  (c: CuriosidadeMunicipio) => `Curiosidade: o município de ${cidadeCom(c.nome, c.regiao)} é berço de ${formatarInteiro(c.nascidos)} ${c.nascidos === 1 ? "candidato" : "candidatos"} nas eleições de 2026.`,
  (c: CuriosidadeMunicipio) => `${formatarInteiro(c.nascidos)} ${c.nascidos === 1 ? "pessoa nascida" : "pessoas nascidas"} no município de ${cidadeCom(c.nome, c.regiao)} ${c.nascidos === 1 ? "disputa" : "disputam"} as eleições de 2026.`,
  (c: CuriosidadeMunicipio) => `De onde vêm os candidatos: ${formatarInteiro(c.nascidos)} ${c.nascidos === 1 ? "nasceu" : "nasceram"} no município de ${cidadeCom(c.nome, c.regiao)}.`,
] as const;

function templateCuriosidadeBerco(c: CuriosidadeMunicipio): { camadas: Camada[]; fatos: Fato[] } | null {
  if (c.nascidos < 1 || c.populacao <= 0) return null;
  const variante = varianteDe(`curiosidade:${c.municipio}:berco`, ABERTURA_BERCO.length);
  const abertura = ABERTURA_BERCO[variante] ?? ABERTURA_BERCO[0];

  return {
    camadas: [
      { texto: abertura(c), prioridade: 100 },
      {
        texto: `São ${pct(c.por100Mil)} candidatos por 100 mil habitantes — a cidade tem ${formatarInteiro(c.populacao)} moradores (Censo 2022).`,
        prioridade: 70,
      },
      { texto: "Naturalidade não é a região que alguém representa: em Pernambuco a eleição é em circunscrição única, o estado inteiro.", prioridade: 40 },
    ],
    fatos: [
      { valor: c.nascidos, rotulo: `candidatos de 2026 nascidos em ${c.municipio}` },
      { valor: valorAfirmadoDecimal(c.por100Mil), rotulo: `candidatos por 100 mil habitantes em ${c.municipio}` },
      { valor: c.populacao, rotulo: `população de ${c.municipio}` },
    ],
  };
}

const CARGOS_LOCAIS = ["Deputado Estadual", "Deputado Federal"] as const;

function templateCuriosidadeMaisVotado(
  c: CuriosidadeMunicipio,
  cargo: (typeof CARGOS_LOCAIS)[number],
): { camadas: Camada[]; fatos: Fato[] } | null {
  const t = c.top[cargo];
  if (!t || t.votos < 500) return null;
  const artigo = cargo === "Deputado Estadual" ? "estadual" : "federal";

  return {
    camadas: [
      {
        texto: `Em 2022, quem mais recebeu votos para deputado ${artigo} no município de ${cidadeCom(c.nome, c.regiao)} foi ${t.nome}${t.partido ? ` (${t.partido})` : ""}: ${formatarInteiro(t.votos)} votos.`,
        prioridade: 100,
      },
      {
        texto: `Naquela eleição, ${formatarInteiro(c.candidatos2022)} candidatos receberam ao menos um voto na cidade.`,
        prioridade: 70,
      },
      { texto: "Dado da apuração oficial do TSE, município por município.", prioridade: 30 },
    ],
    fatos: [
      { valor: t.votos, rotulo: `votos de ${t.nome} para ${cargo} em ${c.municipio} em 2022` },
      { valor: c.candidatos2022, rotulo: `candidatos que receberam voto em ${c.municipio} em 2022` },
    ],
  };
}

function templateCuriosidadeUrna(c: CuriosidadeMunicipio): { camadas: Camada[]; fatos: Fato[] } | null {
  if (c.candidatos2022 < 50 || c.totalVotos2022 <= 0) return null;
  return {
    camadas: [
      {
        // cidadeCom() já fecha com vírgula quando traz a região — acrescentar
        // outra produzia "no Sertão do Pajeú,, 172 candidatos".
        texto: `No município de ${cidadeCom(c.nome, c.regiao)} ${formatarInteiro(c.candidatos2022)} candidatos diferentes receberam voto em 2022.`,
        prioridade: 100,
      },
      { texto: `Foram ${formatarInteiro(c.totalVotos2022)} votos nominais somados na cidade.`, prioridade: 70 },
      { texto: "A urna de uma cidade pequena distribui voto entre muito mais nomes do que parece.", prioridade: 30 },
    ],
    fatos: [
      { valor: c.candidatos2022, rotulo: `candidatos que receberam voto em ${c.municipio} em 2022` },
      { valor: c.totalVotos2022, rotulo: `votos nominais em ${c.municipio} em 2022` },
    ],
  };
}

// ----------------------------------------------------------- posicionamento

/**
 * Fecho de campanha. Não é um eixo à parte: é a última camada de um post de
 * dado, trocada por posicionamento. Depende do fato "número de urna" que
 * `indiceDeFatos` passou a expor — sem ele todo post assinado é reprovado.
 */
const FECHOS_CAMPANHA = [
  "Levantei esses números porque quem quer fiscalizar precisa primeiro conseguir enxergar.\n\nHermes Alves · 300 · NOVO",
  "Transparência não é promessa de campanha: é o trabalho que dá para mostrar antes da eleição.\n\nHermes Alves · 300 · NOVO",
  "Construí este painel para que esse número não dependa de ninguém acreditar em mim.\n\nHermes Alves · 300 · NOVO",
  "Dado público conferível é o começo de qualquer controle sobre o orçamento.\n\nHermes Alves · 300 · NOVO",
  "É esse tipo de conta que eu quero que Pernambuco possa fazer sozinho, a qualquer hora.\n\nHermes Alves · 300 · NOVO",
  "Sou de Araripina e comecei este levantamento pelo sertão, que é de onde menos se fala.\n\nHermes Alves · 300 · NOVO",
] as const;

const FATO_URNA: Fato = { valor: 300, rotulo: "número de urna de HERMES ALVES (2º Suplente)" };

// -------------------------------------------------------------------- pool

type Candidato = {
  id: string;
  eixo: Eixo;
  template: string;
  camadas: Camada[];
  fatos: Fato[];
  chave: Record<string, string | number>;
  peso_editorial: number;
};

function candidatos(db: Database): Candidato[] {
  const out: Candidato[] = [];
  const push = (
    id: string,
    eixo: Eixo,
    template: string,
    chave: Record<string, string | number>,
    peso_editorial: number,
    r: { camadas: Camada[]; fatos: Fato[] } | null,
  ): void => {
    if (r) out.push({ id, eixo, template, chave, peso_editorial, camadas: r.camadas, fatos: r.fatos });
  };

  for (const m of agregadoPorMunicipio(db)) {
    push(`cidade:${m.municipio}:total`, "cidade", "cidade-total", { municipio: m.municipio }, m.v, templateCidadeTotal(m));
    push(`cidade:${m.municipio}:per-capita`, "cidade", "cidade-per-capita", { municipio: m.municipio }, m.v, templateCidadePerCapita(m));
  }
  for (const l of liderPorMunicipio(db)) {
    push(`cidade:${l.municipio}:lider`, "cidade", "cidade-lider", { municipio: l.municipio }, l.v, templateCidadeLider(l));
  }
  for (const a of agregadoPorAutorEstadual(db)) {
    push(`autor:est:${a.chave}:total`, "autor", "autor-estadual-total", { autor: a.chave }, a.v, templateAutorEstadual(a));
  }
  for (const a of agregadoPorAutorFederal(db)) {
    push(`autor:fed:${a.chave}:total`, "autor", "autor-federal-total", { autor: a.chave }, a.v, templateAutorFederal(a));
  }
  for (const f of agregadoPorFuncao(db)) {
    push(`funcao:${f.funcao}:total`, "funcao", "funcao-total", { funcao: f.funcao }, f.v, templateFuncao(f));
  }
  for (const f of agregadoPorFuncaoAno(db)) {
    push(`funcao:${f.funcao}:${f.ano}`, "funcao", "funcao-ano", { funcao: f.funcao, ano: f.ano }, f.v, templateFuncaoAno(f));
  }
  for (const s of agregadoPorSubfuncao(db)) {
    push(`funcao:sub:${s.subfuncao}`, "funcao", "funcao-subfuncao", { subfuncao: s.subfuncao }, s.v, templateSubfuncao(s));
  }
  for (const c of curiosidadesPorMunicipio(db)) {
    // Peso editorial = população: cidade grande nos horários de pico, cauda
    // longa na madrugada. Mesmo critério dos outros eixos, outro campo.
    push(`curiosidade:${c.municipio}:berco`, "curiosidade", "curiosidade-berco", { municipio: c.municipio }, c.populacao, templateCuriosidadeBerco(c));
    for (const cargo of CARGOS_LOCAIS) {
      const suf = cargo === "Deputado Estadual" ? "est" : "fed";
      push(
        `curiosidade:${c.municipio}:votado-${suf}`,
        "curiosidade",
        `curiosidade-mais-votado-${suf}`,
        { municipio: c.municipio, cargo },
        c.populacao,
        templateCuriosidadeMaisVotado(c, cargo),
      );
    }
    push(`curiosidade:${c.municipio}:urna`, "curiosidade", "curiosidade-urna", { municipio: c.municipio }, c.populacao, templateCuriosidadeUrna(c));
  }
  return out;
}

export type Pool = { posts: PostGerado[]; descartes: Descarte[] };

/**
 * Gera o pool inteiro. Cada post passa pelo verificador com o índice
 * pré-construído e com `rotulosEsperados` — casar por valor não basta.
 */
export function gerarPool(db: Database): Pool {
  const fatos = indiceDeFatos(db);
  const posts: PostGerado[] = [];
  const descartes: Descarte[] = [];
  const vistos = new Set<string>();

  for (const c of candidatos(db)) {
    // A versão de campanha é o mesmo recorte com a última camada trocada.
    for (const postura of ["dado", "campanha"] as const) {
      const id = postura === "campanha" ? `${c.id}:campanha` : c.id;
      const camadas =
        postura === "dado"
          ? c.camadas
          : [
              ...c.camadas.filter((x) => x.prioridade >= 70),
              { texto: FECHOS_CAMPANHA[varianteDe(id, FECHOS_CAMPANHA.length)] ?? FECHOS_CAMPANHA[0], prioridade: 90 },
            ];
      const postFatos = postura === "campanha" ? [...c.fatos, FATO_URNA] : c.fatos;

      const texto = montar(camadas);
      const peso = pesoX(texto);
      const hash = hashTexto(texto);

      if (vistos.has(hash)) {
        descartes.push({ id, regra: "texto-duplicado", detalhe: `hash ${hash} já usado` });
        continue;
      }

      const v = verificarPost(texto, db, {
        fatos,
        permitirLink: false,
        tom: "afirmativo",
        rotulosEsperados: postFatos.map((f) => f.rotulo),
        // O post de campanha assina com o número de urna, que é do domínio
        // das candidaturas — some com ele e a assinatura fica sem lastro.
        dominios: postura === "campanha"
          ? [...new Set([...DOMINIO_DO_EIXO[c.eixo], "candidaturas" as DominioFato])]
          : DOMINIO_DO_EIXO[c.eixo],
      });

      const bloqueio =
        !v.ok
          ? v.achados.filter((a) => a.severidade === "erro")
          : v.achados.filter((a) => a.regra === "pergunta-no-final" || a.regra === "piso-como-escolha");

      if (bloqueio.length > 0) {
        const a = bloqueio[0];
        descartes.push({ id, regra: a?.regra ?? "?", detalhe: a?.detalhe ?? "" });
        continue;
      }
      if (peso > 280) {
        descartes.push({ id, regra: "peso", detalhe: `${peso}/280` });
        continue;
      }

      vistos.add(hash);
      posts.push({
        id,
        eixo: c.eixo,
        template: c.template,
        variante: varianteDe(id, 4),
        postura,
        texto,
        peso,
        hash,
        fatos: postFatos,
        chave: c.chave,
        peso_editorial: c.peso_editorial,
        dominios: postura === "campanha"
          ? [...new Set([...DOMINIO_DO_EIXO[c.eixo], "candidaturas" as DominioFato])]
          : DOMINIO_DO_EIXO[c.eixo],
      });
    }
  }

  return { posts, descartes };
}
