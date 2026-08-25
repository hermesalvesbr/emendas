import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { montarPrompt, numerosForaDoRecorte, redigirVerificado } from "../src/redigir-linkedin.ts";

// Nenhum teste chama modelo nem toca a rede: `redigir` é injetado.

const POST = {
  id: "funcao:Educação:2025",
  eixo: "funcao",
  hash: "abc123",
  texto: "Em 2025, Educação somou R$ 22,4 mi em emendas federais empenhadas para Pernambuco.\n\nSão 28 emendas.",
  fatos: [{ valor: 22400000, rotulo: "emendas de Educação em 2025" }],
};


describe("números fora do recorte", () => {
  test("pega a hipótese com percentual inventado", () => {
    // O caso real da 1ª redação de teste: "se três cidades concentram 80%, o
    // resto fica com 20%". O verificador aprova — ele não olha porcentagem.
    expect(numerosForaDoRecorte("Se três cidades concentram 80%, o resto fica com 20%.", POST.texto)).toEqual([
      "80",
      "20",
    ]);
  });

  test("reformatar o mesmo número passa", () => {
    // "R$ 22,4 mi" -> "R$ 22,4 milhões" preserva o token numérico.
    expect(numerosForaDoRecorte("R$ 22,4 milhões em 2025, com 28 emendas.", POST.texto)).toEqual([]);
  });

  test("texto sem número nenhum passa", () => {
    expect(numerosForaDoRecorte("Empenho não é pagamento.", POST.texto)).toEqual([]);
  });

  test("não repete o mesmo inventado duas vezes", () => {
    expect(numerosForaDoRecorte("São 99 e depois 99 de novo.", POST.texto)).toEqual(["99"]);
  });
});

describe("prompt", () => {
  test("carrega recorte, fatos e link", () => {
    const p = montarPrompt(POST);
    expect(p).toContain(POST.texto);
    expect(p).toContain("emendas de Educação em 2025: 22400000");
    expect(p).not.toMatch(/https?:\/\//);
    expect(p).toContain("NUNCA escreva uma URL");
  });

  test("proíbe explicitamente hipótese com número e fato de fora", () => {
    const p = montarPrompt(POST);
    expect(p).toContain("NÃO INVENTE NÚMERO");
    expect(p).toContain("NÃO ACRESCENTE FATO");
    expect(p).toMatch(/hipótese|hipotese/i);
  });
});

describe("redação verificada", () => {
  // Banco vazio: nenhum número casa, então serve para exercitar a reprovação.
  const dbVazio = () => new Database(":memory:");

  test("reprova pergunta no meio do texto, não só no fecho", async () => {
    // O `tom: afirmativo` do verificador só olha o fecho; "O que esse número
    // revela?" no meio passava. Caso real da 2ª redação de teste.
    const db = dbVazio();
    const r = await redigirVerificado(POST, {
      db,
      fatos: [],
      maxTentativas: 1,
      redigir: async () => `Em 2025, R$ 22,4 mi. O que esse número revela? Nada além do registro.\n\nO painel completo está no perfil.`,
    });
    db.close();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivos.join(" ")).toContain("pergunta-no-texto");
  });

  test("reprova número inventado mesmo com o verificador satisfeito", async () => {
    const db = dbVazio();
    const r = await redigirVerificado(POST, {
      db,
      fatos: [{ valor: 22400000, rotulo: "emendas de Educação em 2025" } as never],
      maxTentativas: 1,
      redigir: async () => `Se três cidades concentram 80%, o resto fica com 20%.\n\nO painel completo está no perfil.`,
    });
    db.close();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivos.join(" ")).toContain("numero-fora-do-recorte");
  });

  test("insiste até o limite e devolve os motivos de cada tentativa", async () => {
    const db = dbVazio();
    let chamadas = 0;
    const r = await redigirVerificado(POST, {
      db,
      fatos: [],
      maxTentativas: 3,
      redigir: async () => {
        chamadas++;
        return `Texto com 777 inventado.\n\nO painel completo está no perfil.`;
      },
    });
    db.close();
    expect(chamadas).toBe(3);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivos).toHaveLength(3);
  });

  test("erro de rede não derruba o lote: vira motivo e tenta de novo", async () => {
    const db = dbVazio();
    let chamadas = 0;
    const r = await redigirVerificado(POST, {
      db,
      fatos: [],
      maxTentativas: 2,
      redigir: async () => {
        chamadas++;
        throw new Error("claude -p saiu com 1");
      },
    });
    db.close();
    expect(chamadas).toBe(2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivos.join(" ")).toContain("claude -p saiu com 1");
  });
});

describe("nenhuma URL no texto gerado", () => {
  test("uma URL que escape é reprovada", async () => {
    // Sem esta trava a penalidade de 60% volta pela porta dos fundos: o
    // verificador roda com permitirLink:true e não a barraria.
    const db = new Database(":memory:");
    const r = await redigirVerificado(POST, {
      db,
      fatos: [],
      maxTentativas: 1,
      redigir: async () => "Texto correto. Veja em https://hermesalvesbr.github.io/emendas/",
    });
    db.close();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivos.join(" ")).toContain("url-no-texto");
  });

  test("domínio solto, sem esquema, também é pego", async () => {
    const db = new Database(":memory:");
    const r = await redigirVerificado(POST, {
      db,
      fatos: [],
      maxTentativas: 1,
      redigir: async () => "Confira em hermesalvesbr.github.io/emendas para os detalhes.",
    });
    db.close();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivos.join(" ")).toContain("url-no-texto");
  });
});

describe("nada de primeira pessoa", () => {
  test('"a gente" é reprovado — plural inclusivo é assinatura disfarçada', async () => {
    // Caso real do Sonnet: "perto dos números que a gente vê em capital".
    const db = new Database(":memory:");
    const r = await redigirVerificado(POST, {
      db,
      fatos: [],
      maxTentativas: 1,
      redigir: async () => "Parece pouco, perto do que a gente vê em capital.",
    });
    db.close();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivos.join(" ")).toContain("primeira-pessoa");
  });

  test("texto impessoal passa nessa trava", async () => {
    const db = new Database(":memory:");
    const r = await redigirVerificado(POST, {
      db,
      fatos: [],
      maxTentativas: 1,
      redigir: async () => "O valor é modesto perto do que se vê em capitais.",
    });
    db.close();
    if (!r.ok) expect(r.motivos.join(" ")).not.toContain("primeira-pessoa");
  });
});
