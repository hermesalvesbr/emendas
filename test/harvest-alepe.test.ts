import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db.ts";
import type { Db } from "../src/db.ts";
import { extrairPloas, harvestAlepe, parseEmendasXml } from "../src/harvest-alepe.ts";
import { loadConfig } from "../src/config.ts";

// XML no formato provado pelo parser do bundle oficial do portal
// proposicoes.alepe.pe.gov.br (ver NOTAS.md item 19). Nenhum teste toca a
// internet: fetch é substituído.

const LISTA_XML = `<?xml version='1.0' encoding='utf-8'?>
<projetos>
  <projeto docid="12474" numero="1297" ano="2023" legislatura="VIGÉSIMA " tipo="PROJETO DE LEI ORÇAMENTÁRIA ANUAL" ementa="Estima a Receita e fixa a Despesa"><autores><autor nome="Poder Executivo" tipo="EXTERNO"/></autores></projeto>
  <projeto docid="9999" numero="10" ano="2023" legislatura="VIGÉSIMA " tipo="PROJETO DE LEI ORDINÁRIA" ementa="Outra coisa"><autores><autor nome="Fulano" tipo="DEPUTADO"/></autores></projeto>
</projetos>`;

const DETALHE_XML = `<?xml version='1.0' encoding='utf-8'?>
<projetos>
  <projeto docid="12474" numero="1297" ano="2023" tipo="PROJETO DE LEI ORÇAMENTÁRIA ANUAL">
    <autores><autor nome="Poder Executivo" tipo="EXTERNO"/></autores>
    <emendas>
      <emenda numero="650" ano="2023" tipo="MODIFICATIVA" legislatura="20">
        <ementa>Obra de reforma com ampliação</ementa>
        <autores><autor nome="Socorro Pimentel" tipo="DEPUTADO"/></autores>
      </emenda>
      <emenda numero="382" ano="2023" tipo="ADITIVA" legislatura="20">
        <autores><autor nome="Teresa Leitão" tipo="DEPUTADO"/></autores>
      </emenda>
      <emenda numero="77" ano="2023" tipo="ADITIVA" legislatura="20">
        <autores></autores>
      </emenda>
      <emenda numero="800" ano="2023" tipo="ADITIVA" legislatura="20">
        <autores><autor nome="Juntas" tipo="DEPUTADO"/><autor nome="Outra Dep" tipo="DEPUTADO"/></autores>
      </emenda>
    </emendas>
  </projeto>
</projetos>`;

describe("parsers da API da ALEPE", () => {
  test("extrairPloas filtra só PROJETO DE LEI ORÇAMENTÁRIA ANUAL", () => {
    const ploas = extrairPloas(LISTA_XML);
    expect(ploas).toEqual([{ docid: "12474", numero: "1297", ano: 2023 }]);
  });

  test("parseEmendasXml extrai numero/ano/autores, inclusive múltiplos autores e zero autores", () => {
    const emendas = parseEmendasXml(DETALHE_XML);
    expect(emendas).toHaveLength(4);
    expect(emendas[0]).toEqual({ numero: "650", ano: 2023, autores: [{ nome: "Socorro Pimentel", tipo: "DEPUTADO" }] });
    expect(emendas[2]?.autores).toHaveLength(0);
    expect(emendas[3]?.autores).toHaveLength(2);
  });
});

describe("harvestAlepe — fluxo completo com fetch mockado", () => {
  let db: Db;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    db = openDb(":memory:");
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("legislatura=20")) return new Response(LISTA_XML, { status: 200 });
      if (u.includes("legislatura=")) return new Response("<?xml version='1.0'?><projetos></projetos>", { status: 200 });
      if (u.includes("numero=1297")) return new Response(DETALHE_XML, { status: 200 });
      return new Response("<error><message>rota inesperada</message></error>", { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });

  test("grava autoria oficial e eleva emendas órfãs pelos dois anos (LOA e apresentação)", async () => {
    // órfã citada pelo ano da LOA (650/2024 = PLOA 1297/2023 orça 2024)
    db.upsertEmenda({
      numero_emenda: "650",
      exercicio_emenda: 2024,
      subacao_codigo: "EKZF",
      autor_bruto: null,
      autor_normalizado: null,
      autor_tipo: "desconhecido",
      municipio: null,
      beneficiario_cnpj: null,
      beneficiario_nome: null,
      confianca: "nula",
    });
    // órfã citada pelo ano de apresentação (382/2023)
    db.upsertEmenda({
      numero_emenda: "382",
      exercicio_emenda: 2023,
      subacao_codigo: "EKCP",
      autor_bruto: null,
      autor_normalizado: null,
      autor_tipo: "desconhecido",
      municipio: null,
      beneficiario_cnpj: null,
      beneficiario_nome: null,
      confianca: "nula",
    });

    const config = await loadConfig();
    const report = await harvestAlepe(db, config);

    expect(report.totalAutoriaOficial).toBe(3); // 650, 382 e 800 (a 77 não tem autor)
    expect(report.elevadas).toBe(2);
    expect(report.discordancias).toBe(0);

    const e650 = db.emendasPorAutor("SOCORRO PIMENTEL");
    expect(e650.some((e) => e.numero_emenda === "650" && e.exercicio_emenda === 2024 && e.confianca === "alta")).toBe(true);
    const e382 = db.emendasPorAutor("TERESA LEITAO");
    expect(e382.some((e) => e.numero_emenda === "382" && e.exercicio_emenda === 2023 && e.confianca === "alta")).toBe(true);
    // subação preexistente não pode ser apagada pela aplicação
    expect(e650[0]?.subacao_codigo).toBe("EKZF");
  });

  test("emenda com múltiplos autores vira coletiva", async () => {
    db.upsertEmenda({
      numero_emenda: "800",
      exercicio_emenda: 2024,
      subacao_codigo: null,
      autor_bruto: null,
      autor_normalizado: null,
      autor_tipo: "desconhecido",
      municipio: null,
      beneficiario_cnpj: null,
      beneficiario_nome: null,
      confianca: "nula",
    });
    const config = await loadConfig();
    await harvestAlepe(db, config);
    const r = db.raw.query("SELECT autor_tipo, autor_normalizado FROM emenda WHERE numero_emenda='800'").get() as {
      autor_tipo: string;
      autor_normalizado: string;
    };
    expect(r.autor_tipo).toBe("coletiva");
    expect(r.autor_normalizado).toBe("JUNTAS E OUTRA DEP");
  });

  test("autoria já alta divergente vira discordância, não sobrescrita", async () => {
    db.upsertEmenda({
      numero_emenda: "650",
      exercicio_emenda: 2024,
      subacao_codigo: "EKZF",
      autor_bruto: "OUTRO NOME",
      autor_normalizado: "OUTRO NOME",
      autor_tipo: "individual",
      municipio: null,
      beneficiario_cnpj: null,
      beneficiario_nome: null,
      confianca: "alta",
    });
    const config = await loadConfig();
    const report = await harvestAlepe(db, config);
    expect(report.discordancias).toBe(1);
    const r = db.raw.query("SELECT autor_normalizado FROM emenda WHERE numero_emenda='650'").get() as { autor_normalizado: string };
    expect(r.autor_normalizado).toBe("OUTRO NOME");
  });
});
