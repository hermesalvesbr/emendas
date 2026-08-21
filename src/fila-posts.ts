// Fila de slots: qual post do pool sai em cada horário, de 16/08 a 03/10/2026.
//
// Slot é uma etiqueta de calendário local ("2026-08-16T09:00", America/Recife),
// não um instante UTC. É o mesmo idioma que cmdPostarAgenda já usava com
// toLocaleDateString("en-CA", {timeZone:"America/Recife"}), e evita que um
// disparo às 08:59:58 caia no dia anterior.

import type { Eixo, PostGerado, Postura } from "./gerar-posts.ts";
import { MUNICIPIO_REGIAO, REGIOES_PE, type RegiaoPE } from "./regioes-pe.ts";

export const FUSO = "America/Recife";
export const HORAS_PADRAO = [0, 3, 6, 9, 12, 15, 18, 21] as const;

/** Horários em que o alcance compensa o melhor material. */
const HORAS_PICO = new Set([9, 12, 18, 21]);

export type Fila = {
  nota: string;
  fuso: string;
  inicio: string;
  fim: string;
  horas: number[];
  /** slot -> id do post no pool. */
  slots: Record<string, string>;
  /** Sobrepõe `slots`. Para datas com post escrito à mão (7 de setembro etc.). */
  fixos: Record<string, string>;
};

// --------------------------------------------------------------- calendário

function ymd(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: FUSO });
}

/** Data local (America/Recife) somada de `n` dias, como "YYYY-MM-DD". */
export function somarDias(data: string, n: number): string {
  const [a, m, d] = data.split("-").map(Number);
  // UTC de propósito: aritmética de calendário puro, sem deslocamento de fuso.
  const t = Date.UTC(a ?? 0, (m ?? 1) - 1, (d ?? 1)) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function slot(data: string, hora: number): string {
  return `${data}T${String(hora).padStart(2, "0")}:00`;
}

/** Todos os slots entre duas datas locais, inclusive, em ordem cronológica. */
export function slotsEntre(inicio: string, fim: string, horas: readonly number[] = HORAS_PADRAO): string[] {
  const out: string[] = [];
  const ordenadas = [...horas].sort((a, b) => a - b);
  for (let d = inicio; d <= fim; d = somarDias(d, 1)) {
    for (const h of ordenadas) out.push(slot(d, h));
  }
  return out;
}

/**
 * O slot vigente no instante dado — a hora corrente arredondada PARA BAIXO
 * até o horário de slot mais próximo. 10:59 pertence ao slot das 09:00.
 *
 * Recife não adota horário de verão desde 2019; se voltar a adotar, o teste
 * que fixa isto quebra antes da fila sair errada.
 */
export function slotAgora(agora: Date, horas: readonly number[] = HORAS_PADRAO): string {
  // "sv-SE" dá "2026-08-16 00:31:40" — ISO-like e estável entre versões de ICU.
  const local = agora.toLocaleString("sv-SE", { timeZone: FUSO });
  const data = local.slice(0, 10);
  const hora = Number(local.slice(11, 13));
  const ordenadas = [...horas].sort((a, b) => a - b);

  let escolhida = -1;
  for (const h of ordenadas) if (h <= hora) escolhida = h;
  // Antes do primeiro slot do dia: pertence ao último slot do dia anterior.
  if (escolhida < 0) return slot(somarDias(data, -1), ordenadas.at(-1) ?? 0);
  return slot(data, escolhida);
}

/** Minutos decorridos desde o início do slot — para a tolerância de atraso. */
export function atrasoNoSlot(agora: Date, slotAlvo: string): number {
  const local = agora.toLocaleString("sv-SE", { timeZone: FUSO });
  const minutosAgora = Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
  const minutosSlot = Number(slotAlvo.slice(11, 13)) * 60;
  const dias = (Date.parse(`${local.slice(0, 10)}T00:00:00Z`) - Date.parse(`${slotAlvo.slice(0, 10)}T00:00:00Z`)) / 86_400_000;
  return dias * 1440 + (minutosAgora - minutosSlot);
}

// ------------------------------------------------------------- ordenação

function regiaoDoPost(p: PostGerado): RegiaoPE | null {
  const mun = p.chave.municipio;
  return typeof mun === "string" ? (MUNICIPIO_REGIAO.get(mun) ?? null) : null;
}

/**
 * Round-robin pelas 12 regiões, para não sair três posts seguidos do mesmo
 * lugar. Dentro da região, ordem decrescente de valor. Posts sem região
 * (autor, função) entram intercalados no fim de cada volta.
 */
export function ordenarIntercalado(posts: PostGerado[]): PostGerado[] {
  const baldes = new Map<string, PostGerado[]>();
  for (const p of [...posts].sort((a, b) => b.peso_editorial - a.peso_editorial)) {
    const chave = regiaoDoPost(p) ?? "—";
    const lista = baldes.get(chave);
    if (lista) lista.push(p);
    else baldes.set(chave, [p]);
  }

  const ordem = [...REGIOES_PE, "—"].filter((r) => baldes.has(r));
  const out: PostGerado[] = [];
  let restam = true;
  while (restam) {
    restam = false;
    for (const r of ordem) {
      const lista = baldes.get(r);
      const p = lista?.shift();
      if (p) {
        out.push(p);
        restam = restam || (lista?.length ?? 0) > 0;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------ distribuição

/**
 * Ciclo de 8, do tamanho de um dia. Rotacionado pelo índice do dia para que o
 * mesmo eixo não caia sempre na mesma hora — sem isso, quem acompanha às 12h
 * veria só função, todo dia.
 */
// 21/08/2026: "trem" e "gabinete" entraram no lugar de uma cidade e de uma
// curiosidade — um de cada por dia, decisão do candidato. Cidade continua
// sendo o maior estoque e o substituto quando um eixo acaba.
export const CICLO: ReadonlyArray<Eixo | "campanha"> = [
  "cidade",
  "curiosidade",
  "autor",
  "funcao",
  "cidade",
  "trem",
  "gabinete",
  "campanha",
];

/** Recorte por trás do post: "cidade:RECIFE:total:campanha" -> "cidade:RECIFE:total". */
export function baseDe(id: string): string {
  return id.endsWith(":campanha") ? id.slice(0, -":campanha".length) : id;
}

export type Distribuicao = {
  slots: Record<string, string>;
  /** Eixos que acabaram antes da fila e caíram no substituto. */
  faltas: Array<{ eixo: string; pedidos: number; disponiveis: number }>;
};

/**
 * Casa slots com posts. Consome cada eixo em ordem intercalada; quando um
 * eixo acaba, cai para "cidade" (o maior estoque) e REPORTA a falta — cap
 * silencioso é o que faz um plano parecer completo quando não é.
 */
export function distribuir(slots: string[], posts: PostGerado[], horas: readonly number[] = HORAS_PADRAO): Distribuicao {
  const porEixo = (eixo: Eixo, postura: Postura): PostGerado[] =>
    ordenarIntercalado(posts.filter((p) => p.eixo === eixo && p.postura === postura));

  // "trem" e "gabinete" levam as duas posturas no mesmo balde: nessas pautas a
  // postura é do tema, não uma segunda versão do mesmo recorte. Por isso eles
  // saem do balde "campanha" — senão o mesmo post disputaria dois slots e o
  // eixo esvaziaria pela metade.
  const porPauta = (eixo: Eixo): PostGerado[] => ordenarIntercalado(posts.filter((p) => p.eixo === eixo));

  const filas = new Map<string, PostGerado[]>([
    ["cidade", porEixo("cidade", "dado")],
    ["curiosidade", porEixo("curiosidade", "dado")],
    ["autor", porEixo("autor", "dado")],
    ["funcao", porEixo("funcao", "dado")],
    ["trem", porPauta("trem")],
    ["gabinete", porPauta("gabinete")],
    [
      "campanha",
      ordenarIntercalado(
        posts.filter((p) => p.postura === "campanha" && p.eixo !== "trem" && p.eixo !== "gabinete"),
      ),
    ],
  ]);

  const pedidos = new Map<string, number>();
  const disponiveis = new Map([...filas].map(([k, v]) => [k, v.length] as const));
  const usados = new Set<string>();
  const basesUsadas = new Set<string>();
  const saida: Record<string, string> = {};

  // Slots de pico recebem o material de maior valor: as filas já vêm
  // ordenadas por peso editorial, então basta atendê-los primeiro.
  const ordemDeAtendimento = [...slots].sort((a, b) => {
    const pa = HORAS_PICO.has(Number(a.slice(11, 13))) ? 0 : 1;
    const pb = HORAS_PICO.has(Number(b.slice(11, 13))) ? 0 : 1;
    return pa !== pb ? pa - pb : a < b ? -1 : 1;
  });

  const ordenadas = [...horas].sort((x, y) => x - y);
  const diaZero = slots[0]?.slice(0, 10) ?? "";

  // Anti-monotonia: a fila regerada em 16/08 tinha 46 pares vizinhos com o
  // MESMO template e dias com a mesma cidade três vezes — timeline de robô.
  // Antes de aceitar um post, olhamos os vizinhos cronológicos já atribuídos
  // e as cidades do dia; quando o estoque não permite, aceita-se mesmo assim
  // (melhor repetir do que deixar slot vazio).
  const slotsOrdenados = [...slots].sort();
  const posSlot = new Map(slotsOrdenados.map((x, i) => [x, i] as const));
  const templatePorSlot = new Map<string, string>();
  const cidadesPorDia = new Map<string, Set<string>>();
  const porId = new Map(posts.map((p) => [p.id, p] as const));

  const violaMonotonia = (slotAtual: string, p: PostGerado): boolean => {
    const i = posSlot.get(slotAtual) ?? -1;
    for (const viz of [slotsOrdenados[i - 1], slotsOrdenados[i + 1]]) {
      if (viz && templatePorSlot.get(viz) === p.template) return true;
    }
    const mun = typeof p.chave.municipio === "string" ? p.chave.municipio : null;
    if (mun && cidadesPorDia.get(slotAtual.slice(0, 10))?.has(mun)) return true;
    return false;
  };

  const registrar = (slotAtual: string, p: PostGerado): void => {
    templatePorSlot.set(slotAtual, p.template);
    const mun = typeof p.chave.municipio === "string" ? p.chave.municipio : null;
    if (mun) {
      const dia = slotAtual.slice(0, 10);
      const set = cidadesPorDia.get(dia) ?? new Set<string>();
      set.add(mun);
      cidadesPorDia.set(dia, set);
    }
  };

  for (const s of ordemDeAtendimento) {
    const dia = Math.round(
      (Date.parse(`${s.slice(0, 10)}T00:00:00Z`) - Date.parse(`${diaZero}T00:00:00Z`)) / 86_400_000,
    );
    const idxHora = ordenadas.indexOf(Number(s.slice(11, 13)));
    const alvo = CICLO[(idxHora + dia) % CICLO.length] ?? "cidade";
    pedidos.set(alvo, (pedidos.get(alvo) ?? 0) + 1);

    let escolhido: PostGerado | undefined;
    // Duas passadas: primeiro respeitando a anti-monotonia, depois sem ela.
    for (const relaxado of [false, true]) {
      for (const tentativa of [alvo, "curiosidade", "cidade", "autor", "funcao", "campanha"]) {
        const fila = filas.get(tentativa);
        if (!fila) continue;
        const devolver: PostGerado[] = [];
        while (fila.length > 0) {
          const p = fila.shift();
          if (!p) break;
          if (usados.has(p.id) || basesUsadas.has(baseDe(p.id))) continue;
          if (!relaxado && violaMonotonia(s, p)) {
            devolver.push(p);
            continue;
          }
          escolhido = p;
          break;
        }
        if (devolver.length > 0) fila.unshift(...devolver);
        if (escolhido) break;
      }
      if (escolhido) break;
    }
    if (!escolhido) continue;
    usados.add(escolhido.id);
    basesUsadas.add(baseDe(escolhido.id));
    registrar(s, escolhido);
    saida[s] = escolhido.id;
  }

  const faltas: Distribuicao["faltas"] = [];
  for (const [eixo, pedido] of pedidos) {
    const disp = disponiveis.get(eixo) ?? 0;
    if (pedido > disp) faltas.push({ eixo, pedidos: pedido, disponiveis: disp });
  }

  return { slots: Object.fromEntries(slots.filter((s) => saida[s]).map((s) => [s, saida[s] as string])), faltas };
}
