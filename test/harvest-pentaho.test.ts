import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db.ts";
import type { Db } from "../src/db.ts";
import { harvestPentaho } from "../src/harvest-pentaho.ts";
import { loadConfig } from "../src/config.ts";
import type { EndpointsFile } from "../src/types.ts";

/**
 * A tabela principal do painel Pentaho tem coluna `autor` nativa (§ NOTAS.md
 * item 11/14) — quando presente, `harvestPentaho` deve gravar `emenda` direto
 * com `confianca: "alta"`, sem passar pela mineração de texto de `obs`.
 * Nenhum teste toca a internet: `fetch` é substituído em `beforeEach`.
 */
describe("harvestPentaho — autoria nativa do painel", () => {
  const endpointsPath = "test/fixtures/fake-endpoints.json";
  const dbPath = ":memory:";
  let db: Db;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    db = openDb(dbPath);
    originalFetch = globalThis.fetch;

    const endpoints: EndpointsFile = {
      discoveredAt: new Date(0).toISOString(),
      panelUrl: "https://fake.pentaho.local/",
      calls: [
        {
          requestId: "1",
          url: "https://fake.pentaho.local/pentaho/plugin/cda/api/doQuery?",
          method: "POST",
          status: 200,
          mimeType: "application/json",
          postData: "path=x&dataAccessId=sql_tabela&parampara_ano=2024",
          dataAccessId: "sql_tabela",
          params: { path: "x", dataAccessId: "sql_tabela", parampara_ano: "2024" },
        },
      ],
    };
    await Bun.write(endpointsPath, JSON.stringify(endpoints));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    db.close();
    await Bun.$`rm -f ${endpointsPath}`.quiet().nothrow();
  });

  test("linha com autor nativo grava emenda com confiança alta, sem minerar obs", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          metadata: [
            { colName: "numero_empenho", colType: "String", colIndex: 0 },
            { colName: "autor", colType: "String", colIndex: 1 },
            { colName: "nome_credor", colType: "String", colIndex: 2 },
            { colName: "observacao_empenho", colType: "String", colIndex: 3 },
            { colName: "subacao", colType: "String", colIndex: 4 },
            { colName: "valor_empenhado", colType: "Numeric", colIndex: 5 },
          ],
          resultset: [
            [
              "2024NE009999",
              "Socorro Pimentel",
              "11040854000118 - MUNICIPIO DE ARARIPINA",
              "EMENDA PARLAMENTAR Nº 999/2024",
              "EZZZ - EMENDA PARLAMENTAR",
              12345.67,
            ],
          ],
          queryInfo: { totalRows: "1" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const config = await loadConfig();
    const results = await harvestPentaho(db, config, { years: [2024], endpointsPath, concurrency: 1 });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("ok");
    expect(results[0]?.inserted).toBe(1);
    expect(results[0]?.comAutorNativo).toBe(1);

    const emendas = db.emendasPorAutor("SOCORRO PIMENTEL");
    expect(emendas).toHaveLength(1);
    expect(emendas[0]?.numero_emenda).toBe("999");
    expect(emendas[0]?.confianca).toBe("alta");
    expect(emendas[0]?.beneficiario_nome).toBe("MUNICIPIO DE ARARIPINA");

    expect(db.countEmpenhos()).toBe(1);
  });

  test("linha sem autor (coluna vazia) não grava emenda — só o empenho", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          metadata: [
            { colName: "numero_empenho", colType: "String", colIndex: 0 },
            { colName: "autor", colType: "String", colIndex: 1 },
            { colName: "observacao_empenho", colType: "String", colIndex: 2 },
            { colName: "subacao", colType: "String", colIndex: 3 },
          ],
          resultset: [["2024NE000001", "", "EMENDA PARLAMENTAR Nº 1/2024", "EAAA - X"]],
          queryInfo: { totalRows: "1" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const config = await loadConfig();
    const results = await harvestPentaho(db, config, { years: [2024], endpointsPath, concurrency: 1 });

    expect(results[0]?.comAutorNativo).toBe(0);
    expect(db.countEmpenhos()).toBe(1);
    expect(db.emendasPorAutor("SOCORRO PIMENTEL")).toHaveLength(0);
  });

  test("autoria nativa (alta) sobrevive a uma reexecução de normalizar (não é rebaixada)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          metadata: [
            { colName: "numero_empenho", colType: "String", colIndex: 0 },
            { colName: "autor", colType: "String", colIndex: 1 },
            { colName: "observacao_empenho", colType: "String", colIndex: 2 },
            { colName: "subacao", colType: "String", colIndex: 3 },
          ],
          resultset: [["2024NE000002", "Socorro Pimentel", "SEM PADRAO RECONHECIVEL DE NUMERO", "EZZZ - EMENDA PARLAMENTAR NO. 999/2024"]],
          queryInfo: { totalRows: "1" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const config = await loadConfig();
    await harvestPentaho(db, config, { years: [2024], endpointsPath, concurrency: 1 });
    expect(db.emendasPorAutor("SOCORRO PIMENTEL")).toHaveLength(1);

    // simula normalizar() tentando regravar a mesma emenda com confiança pior
    db.upsertEmenda({
      numero_emenda: "999",
      exercicio_emenda: 2024,
      subacao_codigo: "EZZZ",
      autor_bruto: null,
      autor_normalizado: null,
      autor_tipo: "desconhecido",
      municipio: null,
      beneficiario_cnpj: null,
      beneficiario_nome: null,
      confianca: "nula",
    });

    const depois = db.emendasPorAutor("SOCORRO PIMENTEL");
    expect(depois).toHaveLength(1);
    expect(depois[0]?.confianca).toBe("alta");
  });
});
