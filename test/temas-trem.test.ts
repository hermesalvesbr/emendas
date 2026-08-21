import { describe, expect, test } from "bun:test";
import { montar } from "../src/gerar-posts.ts";
import { pesoX } from "../src/post-x.ts";
import { FECHOS_TREM, temasTrem } from "../src/temas-trem.ts";
import { FATOS_TRANSNORDESTINA, fatoTrem } from "../src/transnordestina.ts";
import { extrairNumeros } from "../src/verificar-post.ts";

// Nenhum teste toca a rede nem o banco: os temas são dados puros.

const TEMAS = temasTrem();

// A assinatura real da série. Copiada (e travada aqui) porque é ela que come
// o orçamento de 280 do post assinado — foi o que derrubou TODOS os temas de
// campanha na primeira geração.
const ASSINATURA = "Hermes Alves, 2º suplente na chapa Carlos Sant'Anna 300 · NOVO";

describe("temas da Transnordestina", () => {
  test("há material para um post por dia até o fim da série", () => {
    // A fila vai de 16/08 a 03/10 com um slot de trem por dia. Menos temas do
    // que dias faz o eixo cair no substituto — em silêncio, se ninguém olhar
    // as faltas.
    expect(TEMAS.length).toBeGreaterThanOrEqual(44);
  });

  test("slug é único", () => {
    const slugs = TEMAS.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  /**
   * A trava que fez os temas de campanha existirem.
   *
   * Na versão assinada, `gerarPool` mantém as camadas de prioridade >= 70 e
   * acrescenta fecho + assinatura. Com duas camadas de dado, nenhum tema
   * cabia em 280 e todos eram descartados por "campanha-nao-coube" — o eixo
   * inteiro sairia sem nenhum post assinado, sem erro nenhum aparecer.
   */
  test("todo tema assinado cabe em 280 com o fecho mais longo", () => {
    const maiorFecho = [...FECHOS_TREM].sort((a, b) => b.length - a.length)[0] ?? "";
    for (const t of TEMAS.filter((x) => x.postura === "campanha")) {
      const corpo = t.camadas.filter((c) => c.prioridade >= 70).map((c) => c.texto);
      const completo = [...corpo, `${maiorFecho}\n\n${ASSINATURA}`].join("\n\n");
      expect({ slug: t.slug, peso: pesoX(completo) }).toEqual({ slug: t.slug, peso: expect.any(Number) });
      expect(pesoX(completo)).toBeLessThanOrEqual(280);
    }
  });

  test("todo tema cabe em 280 na versão de dado", () => {
    for (const t of TEMAS) {
      expect(pesoX(montar(t.camadas))).toBeLessThanOrEqual(280);
    }
  });

  /**
   * Possibilidade não é promessa (nota 1 de redação do dossiê). Não existe
   * projeto, estudo, contrato nem interessado: qualquer futuro do indicativo
   * sobre a chegada do trem afirma o que nenhuma fonte sustenta.
   */
  test("nenhum tema promete obra, data ou chegada", () => {
    const proibidas = [
      /quando o trem (chegar|passar|vier)/i,
      /\b(vou|vamos|irei)\s+(trazer|construir|levar)\b/i,
      /\bo trem (vai|irá) chegar\b/i,
      /\bem \d{4} o trem\b/i,
    ];
    for (const t of TEMAS) {
      const texto = t.camadas.map((c) => c.texto).join(" ");
      for (const re of proibidas) {
        expect({ slug: t.slug, casa: re.test(texto) }).toEqual({ slug: t.slug, casa: false });
      }
    }
  });

  /**
   * O quadro do estudo ambiental é internamente inconsistente: 28,25 km não
   * fecha nem com os marcos quilométricos (23 km) nem com o total do
   * subcompartimento (29,00 km). Só a ordem de grandeza e a comparação com
   * Trindade se sustentam.
   */
  test("os quilômetros de ferrovia em Araripina nunca saem com casa decimal", () => {
    for (const t of TEMAS) {
      const texto = t.camadas.map((c) => c.texto).join(" ");
      if (!/Araripina/.test(texto)) continue;
      expect({ slug: t.slug, achou: /28,25|29,00|22,\d|23 km/.test(texto) }).toEqual({ slug: t.slug, achou: false });
    }
  });

  /**
   * Todo número escrito precisa estar declarado como fato do tema. Sem isto o
   * post é reprovado por `numero-sem-lastro` na geração — mas só ali, e um
   * tema novo entraria mudo no descarte.
   */
  test("todo número citado está declarado como fato do próprio tema", () => {
    for (const t of TEMAS) {
      const texto = t.camadas.map((c) => c.texto).join("\n\n");
      for (const n of extrairNumeros(texto)) {
        const casa = t.fatos.some((f) => Math.abs(f.valor - n.valor) <= n.tolerancia);
        expect({ slug: t.slug, numero: n.bruto, casa }).toEqual({ slug: t.slug, numero: n.bruto, casa: true });
      }
    }
  });

  test("todo fato declarado aponta para uma entrada versionada, com id de fonte", () => {
    const rotulos = new Set(FATOS_TRANSNORDESTINA.map((f) => `${f.rotulo} [${f.fonte}]`));
    for (const t of TEMAS) {
      for (const f of t.fatos) {
        expect({ slug: t.slug, rotulo: f.rotulo, conhecido: rotulos.has(f.rotulo) }).toEqual({
          slug: t.slug,
          rotulo: f.rotulo,
          conhecido: true,
        });
      }
    }
  });
});

describe("índice de fatos externos", () => {
  test("pedir um rótulo que não existe quebra alto, em vez de devolver zero", () => {
    expect(() => fatoTrem("km que ninguém mediu")).toThrow(/não existe/);
  });

  /**
   * 100 mil toneladas é ao mesmo tempo o teto da rodovia hoje e a expectativa
   * da ferrovia amanhã. Valor igual, assunto diferente: é exatamente a
   * colisão que derrubou "R$ 45 por habitante" em Caruaru, e o rótulo é o que
   * a separa.
   */
  test("valores iguais com assuntos diferentes têm rótulos diferentes", () => {
    const cem = FATOS_TRANSNORDESTINA.filter((f) => f.valor === 100000);
    expect(cem.length).toBeGreaterThan(1);
    expect(new Set(cem.map((f) => f.rotulo)).size).toBe(cem.length);
  });

  test("todo fato tem id de fonte", () => {
    for (const f of FATOS_TRANSNORDESTINA) {
      expect({ rotulo: f.rotulo, fonte: f.fonte }).toEqual({ rotulo: f.rotulo, fonte: expect.stringMatching(/^(F\d+|dossiê )/) });
    }
  });
});
