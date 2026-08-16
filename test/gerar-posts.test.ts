import { describe, expect, test } from "bun:test";
import { artigoDaRegiao, cidadeCom, contagem, formatarInteiro, formatarReais, limparPontuacao, montar, varianteDe, valorAfirmado } from "../src/gerar-posts.ts";
import { pesoX } from "../src/post-x.ts";
import { extrairNumeros } from "../src/verificar-post.ts";

// Nenhum teste toca a rede. Os templates são puros, então testam sem banco.

describe("formatação de reais", () => {
  test("escolhe a escala pela grandeza", () => {
    expect(formatarReais(3_480_000_000)).toBe("R$ 3,48 bi");
    expect(formatarReais(8_012_345)).toBe("R$ 8,0 mi");
    expect(formatarReais(849_300)).toBe("R$ 849 mil");
    expect(formatarReais(618)).toBe("R$ 618");
  });

  /**
   * O teste que impede o gerador de se auto-reprovar.
   *
   * `extrairNumeros` deriva a tolerância da precisão ESCRITA: "R$ 8,0 mi"
   * afirma ±50 mil. Se `formatarReais` arredondasse com erro maior que essa
   * metade, o número escrito não casaria com o fato que o originou e o post
   * seria descartado por numero-sem-lastro — sem nenhum erro de dado.
   */
  test("o arredondamento nunca excede a tolerância que o próprio texto declara", () => {
    let piorFolga = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 10_000; i++) {
      // Cobre as quatro faixas de escala.
      const v = Math.floor(10 ** (Math.random() * 9.7)) + 1;
      const texto = formatarReais(v);
      const [n] = extrairNumeros(texto);
      expect(n).toBeDefined();
      if (!n) continue;
      const erro = Math.abs(n.valor - v);
      expect(erro).toBeLessThanOrEqual(n.tolerancia);
      piorFolga = Math.min(piorFolga, n.tolerancia - erro);
    }
    expect(piorFolga).toBeGreaterThanOrEqual(0);
  });

  test("valorAfirmado devolve o número que o texto de fato diz", () => {
    expect(valorAfirmado(8_012_345)).toBeCloseTo(8_000_000, 0);
    expect(valorAfirmado(849_300)).toBe(849_000);
    expect(valorAfirmado(618.4)).toBe(618);
  });

  test("inteiro sai em pt-BR", () => {
    expect(formatarInteiro(12967)).toBe("12.967");
    expect(formatarInteiro(8)).toBe("8");
  });
});

describe("montagem por camadas", () => {
  const longa = (n: number): string => "palavra ".repeat(n).trim();

  test("junta as camadas com linha em branco", () => {
    expect(montar([{ texto: "a", prioridade: 100 }, { texto: "b", prioridade: 50 }])).toBe("a\n\nb");
  });

  test("derruba a camada de menor prioridade até caber em 280", () => {
    const texto = montar([
      { texto: longa(20), prioridade: 100 },
      { texto: longa(20), prioridade: 80 },
      { texto: longa(20), prioridade: 10 },
    ]);
    expect(pesoX(texto)).toBeLessThanOrEqual(280);
    expect(texto.split("\n\n").length).toBeLessThan(3);
  });

  test("preserva a camada de maior prioridade — a que carrega o número", () => {
    const texto = montar([
      { texto: "NUMERO", prioridade: 100 },
      { texto: longa(60), prioridade: 10 },
    ]);
    expect(texto).toContain("NUMERO");
  });

  test("nunca devolve vazio, mesmo com uma única camada estourada", () => {
    const texto = montar([{ texto: longa(80), prioridade: 100 }]);
    expect(texto.length).toBeGreaterThan(0);
  });

  test("ignora camadas vazias", () => {
    expect(montar([{ texto: "a", prioridade: 100 }, { texto: "  ", prioridade: 50 }])).toBe("a");
  });
});

describe("variante determinística", () => {
  test("o mesmo id sempre rende a mesma variante", () => {
    expect(varianteDe("cidade:RECIFE:total", 4)).toBe(varianteDe("cidade:RECIFE:total", 4));
  });

  test("fica dentro do intervalo pedido", () => {
    for (const id of ["a", "b", "c", "cidade:ARARIPINA:total", "funcao:Saúde:total"]) {
      const v = varianteDe(id, 4);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(4);
    }
  });

  test("ids diferentes se espalham pelas variantes", () => {
    const vistas = new Set(Array.from({ length: 200 }, (_, i) => varianteDe(`id-${i}`, 4)));
    expect(vistas.size).toBe(4);
  });
});

describe("cidade não pode parecer pessoa", () => {
  /**
   * PE tem municípios com nome de gente — João Alfredo, Joaquim Nabuco,
   * Vicência. "João Alfredo recebeu R$ 3,6 mi em emendas" lê como uma pessoa
   * recebendo o dinheiro, o que num post de campanha sugere enriquecimento de
   * alguém que não existe. Foi assim que o primeiro post da série saiu.
   */
  test("toda menção a cidade leva UF", () => {
    expect(cidadeCom("João Alfredo", "Agreste Setentrional")).toContain("(PE)");
    expect(cidadeCom("Jataúba", null)).toBe("Jataúba (PE)");
  });

  test("leva também a região, com o artigo certo", () => {
    expect(cidadeCom("João Alfredo", "Agreste Setentrional")).toBe("João Alfredo (PE), no Agreste Setentrional,");
    expect(cidadeCom("Paudalho", "Zona da Mata Norte")).toBe("Paudalho (PE), na Zona da Mata Norte,");
  });

  test("artigo segue o gênero do nome da região", () => {
    expect(artigoDaRegiao("Zona da Mata Sul")).toBe("na");
    expect(artigoDaRegiao("Região Metropolitana do Recife")).toBe("na");
    expect(artigoDaRegiao("Agreste Central")).toBe("no");
    expect(artigoDaRegiao("Sertão do Araripe")).toBe("no");
  });

  test("não repete o nome da cidade dentro do nome da região", () => {
    // "Recife (PE), na Região Metropolitana do Recife," é pleonasmo.
    expect(cidadeCom("Recife", "Região Metropolitana do Recife")).toBe("Recife (PE)");
  });
});

describe("concordância", () => {
  test("uma emenda é singular", () => {
    expect(contagem(1, "emenda", "emendas")).toBe("É 1 emenda");
  });

  test("mais de uma é plural, com separador de milhar", () => {
    expect(contagem(4, "emenda", "emendas")).toBe("São 4 emendas");
    expect(contagem(1334, "emenda", "emendas")).toBe("São 1.334 emendas");
  });

  test("zero é plural", () => {
    expect(contagem(0, "emenda", "emendas")).toBe("São 0 emendas");
  });
});

describe("pontuação da composição", () => {
  /**
   * cidadeCom() fecha com vírgula porque quase sempre há oração depois. Quando
   * a cidade encerra a frase, a junção produzia "no Agreste Setentrional,." —
   * pequeno, mas num texto que se propõe conferível a desatenção visível custa
   * credibilidade.
   */
  test("vírgula antes de ponto final some", () => {
    expect(limparPontuacao("nasceram em Recife (PE), na Região Metropolitana do Recife,.")).toBe(
      "nasceram em Recife (PE), na Região Metropolitana do Recife.",
    );
  });

  test("vírgula dupla vira uma só", () => {
    expect(limparPontuacao("no Sertão do Pajeú,, 172 candidatos")).toBe("no Sertão do Pajeú, 172 candidatos");
  });

  test("espaço antes de vírgula some", () => {
    expect(limparPontuacao("Recife (PE) , no Agreste")).toBe("Recife (PE), no Agreste");
  });

  test("vírgula legítima no meio da frase é preservada", () => {
    expect(limparPontuacao("Araripina (PE), no Sertão do Araripe, recebeu R$ 2,7 mi.")).toBe(
      "Araripina (PE), no Sertão do Araripe, recebeu R$ 2,7 mi.",
    );
  });

  test("montar aplica a limpeza no texto final", () => {
    const t = montar([{ texto: "Nasceram em Araripina (PE), no Sertão do Araripe,.", prioridade: 100 }]);
    expect(t).not.toContain(",.");
  });
});
