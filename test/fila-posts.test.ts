import { describe, expect, test } from "bun:test";
import {
  HORAS_PADRAO,
  atrasoNoSlot,
  baseDe,
  distribuir,
  ordenarIntercalado,
  slot,
  slotAgora,
  slotsEntre,
  somarDias,
} from "../src/fila-posts.ts";
import type { PostGerado } from "../src/gerar-posts.ts";

// Nenhum teste toca a rede nem o banco.

function fake(id: string, eixo: PostGerado["eixo"], postura: PostGerado["postura"], municipio?: string, v = 1): PostGerado {
  return {
    id,
    eixo,
    template: "t",
    variante: 0,
    postura,
    texto: id,
    peso: 100,
    hash: id,
    fatos: [],
    chave: municipio ? { municipio } : {},
    peso_editorial: v,
    dominios: ["emendas"],
  };
}

describe("calendário de slots", () => {
  test("a série de 16/08 a 03/10 tem exatamente 392 slots", () => {
    const s = slotsEntre("2026-08-16", "2026-10-03");
    expect(s.length).toBe(392);
    expect(s[0]).toBe("2026-08-16T00:00");
    expect(s.at(-1)).toBe("2026-10-03T21:00");
    expect(new Set(s).size).toBe(392);
  });

  test("atravessa a virada de mês sem pular nem duplicar dia", () => {
    const s = slotsEntre("2026-08-30", "2026-09-02", [9]);
    expect(s).toEqual(["2026-08-30T09:00", "2026-08-31T09:00", "2026-09-01T09:00", "2026-09-02T09:00"]);
  });

  test("somarDias faz aritmética de calendário, não de fuso", () => {
    expect(somarDias("2026-08-31", 1)).toBe("2026-09-01");
    expect(somarDias("2026-09-01", -1)).toBe("2026-08-31");
    expect(somarDias("2026-12-31", 1)).toBe("2027-01-01");
  });

  test("a ordem é cronológica", () => {
    const s = slotsEntre("2026-08-16", "2026-08-20");
    expect([...s].sort()).toEqual(s);
  });
});

describe("slot corrente", () => {
  // Recife não adota horário de verão desde 2019. Se voltar a adotar, este
  // teste quebra ANTES de a fila publicar no horário errado.
  test("arredonda para baixo até o slot de 3 em 3 horas", () => {
    // 2026-08-16T13:59 em Recife (UTC-3) = 16:59Z
    expect(slotAgora(new Date("2026-08-16T16:59:00Z"))).toBe("2026-08-16T12:00");
    expect(slotAgora(new Date("2026-08-16T15:00:00Z"))).toBe("2026-08-16T12:00");
    expect(slotAgora(new Date("2026-08-16T14:59:00Z"))).toBe("2026-08-16T09:00");
  });

  test("Recife é UTC-3 o ano inteiro — janeiro e julho dão o mesmo deslocamento", () => {
    expect(slotAgora(new Date("2026-01-15T15:00:00Z"))).toBe("2026-01-15T12:00");
    expect(slotAgora(new Date("2026-07-15T15:00:00Z"))).toBe("2026-07-15T12:00");
  });

  test("antes do primeiro slot do dia, pertence ao último slot do dia anterior", () => {
    // 05:00Z = 02:00 em Recife; com horas [6,12,18] o slot é o de ontem às 18h.
    expect(slotAgora(new Date("2026-08-16T05:00:00Z"), [6, 12, 18])).toBe("2026-08-15T18:00");
  });

  test("atraso é medido em minutos desde o início do slot", () => {
    expect(atrasoNoSlot(new Date("2026-08-16T12:30:00Z"), "2026-08-16T09:00")).toBe(30);
    expect(atrasoNoSlot(new Date("2026-08-16T12:00:00Z"), "2026-08-16T09:00")).toBe(0);
  });

  test("atraso atravessa a meia-noite local sem virar negativo enorme", () => {
    // 02:30 em Recife (05:30Z) contra o slot das 21:00 do dia anterior.
    expect(atrasoNoSlot(new Date("2026-08-17T05:30:00Z"), "2026-08-16T21:00")).toBe(330);
  });
});

describe("distribuição", () => {
  const posts = [
    ...Array.from({ length: 300 }, (_, i) => fake(`cidade:C${i}:total`, "cidade", "dado", `C${i}`, 300 - i)),
    ...Array.from({ length: 200 }, (_, i) => fake(`curiosidade:K${i}:berco`, "curiosidade", "dado", `K${i}`, 200 - i)),
    ...Array.from({ length: 120 }, (_, i) => fake(`autor:A${i}:total`, "autor", "dado", undefined, 120 - i)),
    ...Array.from({ length: 80 }, (_, i) => fake(`funcao:F${i}:total`, "funcao", "dado", undefined, 80 - i)),
    ...Array.from({ length: 200 }, (_, i) => fake(`cidade:D${i}:total:campanha`, "cidade", "campanha", `D${i}`, 200 - i)),
  ];

  test("preenche todos os slots com ids distintos", () => {
    const slots = slotsEntre("2026-08-16", "2026-10-03");
    const { slots: mapa, faltas } = distribuir(slots, posts);
    expect(Object.keys(mapa).length).toBe(392);
    expect(new Set(Object.values(mapa)).size).toBe(392);
    expect(faltas).toEqual([]);
  });

  /**
   * Ciclo de 8 = um dia: 3 cidade, 2 curiosidade, 1 autor, 1 função, 1
   * campanha. Curiosidade entrou porque naturalidade e votação de 2022 falam
   * de gente e lugar, não de rubrica — é o eixo que o leitor local reconhece.
   */
  test("respeita o ciclo do dia", () => {
    const { slots: mapa } = distribuir(slotsEntre("2026-08-16", "2026-10-03"), posts);
    const conta = { cidade: 0, curiosidade: 0, autor: 0, funcao: 0, campanha: 0 };
    for (const id of Object.values(mapa)) {
      if (id.endsWith(":campanha")) conta.campanha++;
      else if (id.startsWith("cidade:")) conta.cidade++;
      else if (id.startsWith("curiosidade:")) conta.curiosidade++;
      else if (id.startsWith("autor:")) conta.autor++;
      else conta.funcao++;
    }
    expect(conta).toEqual({ cidade: 147, curiosidade: 98, autor: 49, funcao: 49, campanha: 49 });
    expect(Object.values(conta).reduce((a, b) => a + b, 0)).toBe(392);
  });

  test("nunca publica o mesmo recorte duas vezes, nem como dado e depois como campanha", () => {
    const dobro = [fake("cidade:X:total", "cidade", "dado", "X", 10), fake("cidade:X:total:campanha", "cidade", "campanha", "X", 10)];
    const { slots: mapa } = distribuir(slotsEntre("2026-08-16", "2026-08-16"), dobro);
    const bases = Object.values(mapa).map(baseDe);
    expect(new Set(bases).size).toBe(bases.length);
  });

  test("reporta a falta quando um eixo acaba antes da fila", () => {
    const magro = [
      ...Array.from({ length: 400 }, (_, i) => fake(`cidade:C${i}:total`, "cidade", "dado", `C${i}`, i)),
      fake("autor:A0:total", "autor", "dado"),
    ];
    const { faltas } = distribuir(slotsEntre("2026-08-16", "2026-10-03"), magro);
    // Cap silencioso é o que faz um plano parecer completo quando não é.
    expect(faltas.some((f) => f.eixo === "autor")).toBe(true);
  });

  test("o eixo não cai sempre na mesma hora — o ciclo roda com o dia", () => {
    const { slots: mapa } = distribuir(slotsEntre("2026-08-16", "2026-08-20"), posts);
    const naHora = (h: string) =>
      Object.entries(mapa)
        .filter(([s]) => s.endsWith(`T${h}:00`))
        .map(([, id]) => (id.endsWith(":campanha") ? "campanha" : (id.split(":")[0] as string)));
    expect(new Set(naHora("00")).size).toBeGreaterThan(1);
  });
});

describe("ordenação intercalada", () => {
  test("não emite dois posts seguidos da mesma região quando há alternativa", () => {
    const posts = [
      fake("a", "cidade", "dado", "RECIFE", 9),
      fake("b", "cidade", "dado", "OLINDA", 8),
      fake("c", "cidade", "dado", "ARARIPINA", 7),
      fake("d", "cidade", "dado", "OURICURI", 6),
    ];
    const ordem = ordenarIntercalado(posts).map((p) => p.chave.municipio);
    // RECIFE/OLINDA são RMR; ARARIPINA/OURICURI são Araripe. Devem alternar.
    expect(ordem[0]).not.toBe(ordem[1]);
    expect(ordem.length).toBe(4);
  });

  test("é determinística", () => {
    const posts = [fake("a", "cidade", "dado", "RECIFE", 9), fake("b", "cidade", "dado", "ARARIPINA", 7)];
    expect(ordenarIntercalado(posts).map((p) => p.id)).toEqual(ordenarIntercalado(posts).map((p) => p.id));
  });
});

describe("chaves", () => {
  test("slot formata a hora com dois dígitos", () => {
    expect(slot("2026-08-16", 0)).toBe("2026-08-16T00:00");
    expect(slot("2026-08-16", 9)).toBe("2026-08-16T09:00");
    expect(slot("2026-08-16", 21)).toBe("2026-08-16T21:00");
  });

  test("baseDe remove o sufixo de campanha e só ele", () => {
    expect(baseDe("cidade:RECIFE:total:campanha")).toBe("cidade:RECIFE:total");
    expect(baseDe("cidade:RECIFE:total")).toBe("cidade:RECIFE:total");
  });

  test("as horas padrão são de 3 em 3, cobrindo 24h", () => {
    expect([...HORAS_PADRAO]).toEqual([0, 3, 6, 9, 12, 15, 18, 21]);
  });
});
