import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { extrairNumeros, verificarPost, type Fato } from "../src/verificar-post.ts";

// Nenhum teste toca a rede. O índice é injetado, então nenhum toca o banco:
// `fatos` substitui indiceDeFatos(db) e o Database só existe porque a
// assinatura o exige.
const db = new Database(":memory:");

const achado = (texto: string, fatos: Fato[], opts: Parameters<typeof verificarPost>[2] = {}) =>
  verificarPost(texto, db, { fatos, ...opts });

const regras = (v: ReturnType<typeof verificarPost>) => v.achados.map((a) => a.regra);

describe("índice injetável", () => {
  test("com `fatos` passado, o banco não é consultado", () => {
    const v = achado("São 42 emendas.", [{ valor: 42, rotulo: "nº de emendas de X" }]);
    expect(v.ok).toBe(true);
    expect(regras(v)).toContain("numero-conferido");
  });

  test("número fora do índice injetado é reprovado", () => {
    expect(achado("São 43 emendas.", [{ valor: 42, rotulo: "nº de emendas de X" }]).ok).toBe(false);
  });
});

describe("tom", () => {
  test("por padrão a série é afirmativa: pergunta no fecho vira aviso", () => {
    const v = achado("Recife recebeu muito.\n\nE a sua cidade?", []);
    expect(regras(v)).toContain("pergunta-no-final");
    // Aviso não barra: quem barra é o portão do gerador.
    expect(v.ok).toBe(true);
  });

  test("pergunta no meio do texto não dispara a regra — só o fecho conta", () => {
    expect(regras(achado("Quem assinou? O painel responde.\n\nDado aberto.", []))).not.toContain("pergunta-no-final");
  });

  test('tom:"pergunta" preserva a semântica antiga, para errata e réplica', () => {
    expect(regras(achado("Recife recebeu muito.", [], { tom: "pergunta" }))).toContain("sem-pergunta");
    expect(regras(achado("Recife recebeu muito. E a sua?", [], { tom: "pergunta" }))).not.toContain("sem-pergunta");
  });
});

describe("rótulo esperado", () => {
  const fatos: Fato[] = [
    { valor: 45, rotulo: "nº de emendas de CARUARU" },
    { valor: 45, rotulo: "R$ por habitante em CARPINA" },
    { valor: 60, rotulo: "R$ por habitante em CARUARU" },
  ];

  /**
   * O caso medido. Antes desta regra o texto abaixo era APROVADO: 45 é o
   * número de emendas de Caruaru, e o post afirma reais por habitante.
   * Número plausível, cidade certa, afirmação errada — a falha dominante num
   * regime de 8 posts por dia sem revisão humana.
   */
  test("casar por valor não basta: o fato que casou tem de ser o afirmado", () => {
    const v = achado("Caruaru recebeu R$ 45 por habitante em emendas.", fatos, {
      rotulosEsperados: ["R$ por habitante em CARUARU"],
    });
    expect(v.ok).toBe(false);
    expect(regras(v)).toContain("numero-rotulo-divergente");
  });

  test("o mesmo texto com o número certo passa", () => {
    const v = achado("Caruaru recebeu R$ 60 por habitante em emendas.", fatos, {
      rotulosEsperados: ["R$ por habitante em CARUARU"],
    });
    expect(v.ok).toBe(true);
  });

  test("sem rotulosEsperados, o comportamento antigo é preservado", () => {
    expect(achado("Caruaru recebeu R$ 45 por habitante em emendas.", fatos).ok).toBe(true);
  });
});

describe("números que não são grandeza", () => {
  test("ano solto continua ignorado", () => {
    expect(extrairNumeros("de 2023 a 2026").length).toBe(0);
  });

  /** "2º Suplente" casava com as emendas de Afrânio. Ordinal não é medida. */
  test("ordinal é ignorado", () => {
    expect(extrairNumeros("Sou 2º Suplente e 1ª opção.").length).toBe(0);
    expect(achado("Concorro como 2º Suplente.", []).ok).toBe(true);
  });

  /**
   * As duas ressalvas que a lei OBRIGA a escrever reprovavam o post que as
   * escrevia: "EC 86/2015" fazia o 86 casar com um per capita de outra cidade,
   * e "art. 166-A" ficava sem lastro.
   */
  test("citação legal é identificador, não medida", () => {
    expect(extrairNumeros("mínimo de 50% (EC 86/2015 e EC 126/2022)").map((n) => n.bruto)).toEqual(["50%"]);
    expect(extrairNumeros("mínimo de 70% em despesa de capital (art. 166-A)").map((n) => n.bruto)).toEqual(["70%"]);
    expect(extrairNumeros("na forma da Lei 9.504/97").length).toBe(0);
    expect(achado("A Constituição exige o mínimo de 50% (EC 86/2015 e EC 126/2022).", []).ok).toBe(true);
  });

  test("número precedido de palavra comum continua sendo conferido", () => {
    // "são 86 emendas" não é citação legal e tem de casar com o índice.
    expect(achado("São 86 emendas.", []).ok).toBe(false);
  });

  /**
   * "7,1 candidatos por 100 mil habitantes": o 100 mil é o denominador da
   * taxa, não uma afirmação. Sem esta regra, todo post per capita exigia um
   * fato de valor 100.000 e casava com qualquer emenda desse tamanho, em
   * qualquer cidade — 98 posts foram descartados por isso.
   */
  test("denominador de taxa é unidade, não medida", () => {
    expect(extrairNumeros("São 7,1 candidatos por 100 mil habitantes").map((n) => n.bruto)).toEqual(["7,1"]);
    expect(extrairNumeros("R$ 45 por 100 mil moradores").map((n) => n.bruto)).toEqual(["R$ 45"]);
    expect(achado("São 7,1 candidatos por 100 mil habitantes.", [{ valor: 7.1, rotulo: "x" }]).ok).toBe(true);
  });

  test("mas '100 mil habitantes' sem 'por' continua sendo medida", () => {
    // "a cidade tem 100 mil habitantes" AFIRMA a população e precisa de lastro.
    expect(extrairNumeros("A cidade tem 100 mil habitantes").map((n) => n.bruto)).toEqual(["100 mil"]);
  });

  test("percentual segue fora do índice", () => {
    expect(achado("Representa 57,7% do total.", []).ok).toBe(true);
  });
});

describe("frases que a lei ou o dado não sustentam", () => {
  test('"não é candidato" é erro — o marcador do TSE só sustenta o positivo', () => {
    const v = achado("Fulano não é candidato em 2026.", []);
    expect(v.ok).toBe(false);
    expect(regras(v)).toContain("frase-proibida");
  });

  test('"não são candidatos" também', () => {
    expect(achado("Eles não são candidatos.", []).ok).toBe(false);
  });

  test('"represento a região" é erro — não há distrito eleitoral no Brasil', () => {
    expect(achado("Represento a região do Araripe.", []).ok).toBe(false);
    expect(achado("Representa a região do Araripe.", []).ok).toBe(false);
  });

  test("afirmar que alguém É candidato continua permitido", () => {
    expect(achado("Fulano é candidato em 2026.", []).ok).toBe(true);
  });

  test("piso legal como escolha é aviso, e o gerador o rejeita", () => {
    expect(regras(achado("A bancada priorizou a saúde.", []))).toContain("piso-como-escolha");
    expect(regras(achado("Saúde lidera por obrigação constitucional.", []))).not.toContain("piso-como-escolha");
  });

  /**
   * A Alepe publica o vencimento de cada CARGO, nunca contracheque (NOTAS
   * 40/41). "O assessor Fulano ganha R$ X" não é afirmável com esta fonte;
   * "ocupa cargo cujo vencimento de tabela é R$ X" é.
   */
  test('"salário do assessor" é erro — a fonte não sustenta valor individual', () => {
    expect(achado("O salário do assessor é de R$ 10.363,58.", []).ok).toBe(false);
    expect(achado("A soma dos salários dos servidores comissionados.", []).ok).toBe(false);
    expect(achado("O vencimento do cargo é de R$ 10.363,58.", [{ valor: 10363.58, rotulo: "x" }]).ok).toBe(true);
  });

  /**
   * Possibilidade não é promessa: não há projeto, estudo, contrato nem
   * interessado em trem de passageiros no eixo do Araripe. Tratar a hipótese
   * como agendada afirma o que nenhuma fonte sustenta.
   */
  test("promessa de trem é erro; a hipótese declarada como hipótese, não", () => {
    expect(achado("Quando o trem chegar, o sertão muda.", []).ok).toBe(false);
    expect(achado("Vou trazer o trem para Araripina.", []).ok).toBe(false);
    expect(achado("O contrato já obriga a concessionária a deixar passar trem de passageiros.", []).ok).toBe(true);
  });
});

describe("citação de norma", () => {
  /**
   * A pauta da Transnordestina obriga a citar acórdão pelo número (fundir os
   * três do TCU é erro de fato) e resolução com "nº" no meio. Sem estas duas
   * extensões, o post que cita a norma corretamente era reprovado por
   * numero-sem-lastro.
   */
  test("portaria, decreto e acórdão são identificadores, como lei e EC", () => {
    expect(extrairNumeros("instituída pela Portaria 870/2025").length).toBe(0);
    expect(extrairNumeros("o Decreto 1.832/1996").length).toBe(0);
    expect(extrairNumeros("o Acórdão 1.217/2026 do TCU").length).toBe(0);
  });

  test('"nº" entre o marcador e o número não quebra a regra', () => {
    expect(extrairNumeros("a Resolução nº 5.943/2021 da ANTT").length).toBe(0);
    expect(extrairNumeros("a Lei nº 14.273/2021").length).toBe(0);
  });

  test("número solto depois de palavra comum continua sendo conferido", () => {
    expect(extrairNumeros("são 870 quilômetros").map((n) => n.bruto)).toEqual(["870"]);
  });
});

describe("regras herdadas", () => {
  test("link no corpo é erro, salvo quando permitido", () => {
    expect(achado("Veja em https://exemplo.org", []).ok).toBe(false);
    expect(achado("Veja em https://exemplo.org", [], { permitirLink: true }).ok).toBe(true);
  });

  test("peso acima de 280 é erro", () => {
    expect(achado("palavra ".repeat(60), []).ok).toBe(false);
  });
});
