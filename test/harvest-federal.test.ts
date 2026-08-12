import { describe, expect, test } from "bun:test";
import { filtrarPE, parseDeputados, parseSenadoresPE } from "../src/harvest-federal.ts";
import type { BancadaPE } from "../src/harvest-federal.ts";
import { normalizarAutor } from "../src/normalize.ts";

// Formatos conferidos contra as fontes reais em 12/08/2026 (regra 1.2).
// Nenhum teste toca a internet.

const CSV = [
  '"Código da Emenda";"Ano da Emenda";"Tipo de Emenda";"Código do Autor da Emenda";"Nome do Autor da Emenda";"Número da emenda";"Localidade de aplicação do recurso";"Código Município IBGE";"Município";"Código UF IBGE";"UF";"Região";"Código Função";"Nome Função";"Código Subfunção";"Nome Subfunção";"Código Programa";"Nome Programa";"Código Ação";"Nome Ação";"Código Plano Orçamentário";"Nome Plano Orçamentário";"Valor Empenhado";"Valor Liquidado";"Valor Pago";"Valor Restos A Pagar Inscritos";"Valor Restos A Pagar Cancelados";"Valor Restos A Pagar Pagos"',
  // deputado de PE, município válido
  '"202412340001";"2024";"Emenda Individual - Transferências com Finalidade Definida";"111";"ANDRE FERREIRA";"0001";"RECIFE - PE";"2611606";"RECIFE";"2600000";"PERNAMBUCO";"Nordeste";"10";"Saúde";"301";"Atenção básica";"1";"P";"1";"A";"0000";"PO";"1500000,50";"1000000,00";"900000,00";"0,00";"0,00";"0,00"',
  // senador de PE, localidade estadual (sem município)
  '"202456780001";"2025";"Emenda Individual - Transferências Especiais";"222";"HUMBERTO COSTA";"0002";"PERNAMBUCO (UF)";"";"";"2600000";"PERNAMBUCO";"Nordeste";"12";"Educação";"361";"Ensino";"1";"P";"1";"A";"0000";"PO";"2000000,00";"0,00";"0,00";"0,00";"0,00";"0,00"',
  // bancada coletiva
  '"202471180001";"2025";"Emenda de Bancada";"7118";"BANCADA DE PERNAMBUCO";"0003";"MÚLTIPLO";"";"";"2600000";"PERNAMBUCO";"Nordeste";"26";"Transporte";"782";"Rodoviário";"1";"P";"1";"A";"0000";"PO";"5000000,00";"0,00";"0,00";"0,00";"0,00";"0,00"',
  // autor de fora com gasto em PE
  '"202499990001";"2024";"Emenda Individual - Transferências com Finalidade Definida";"999";"FULANO DE OUTRO ESTADO";"0004";"CARUARU - PE";"2604106";"CARUARU";"2600000";"PERNAMBUCO";"Nordeste";"10";"Saúde";"301";"Atenção básica";"1";"P";"1";"A";"0000";"PO";"300000,00";"0,00";"0,00";"0,00";"0,00";"0,00"',
  // fora do recorte: outro estado
  '"202400010001";"2024";"Emenda Individual - Transferências com Finalidade Definida";"888";"ALGUEM DA BAHIA";"0005";"SALVADOR - BA";"2927408";"SALVADOR";"2900000";"BAHIA";"Nordeste";"10";"Saúde";"301";"Atenção básica";"1";"P";"1";"A";"0000";"PO";"999999,00";"0,00";"0,00";"0,00";"0,00";"0,00"',
  // fora do recorte: ano anterior, mesmo sendo deputado de PE
  '"202212340001";"2022";"Emenda Individual - Transferências com Finalidade Definida";"111";"ANDRE FERREIRA";"0006";"RECIFE - PE";"2611606";"RECIFE";"2600000";"PERNAMBUCO";"Nordeste";"10";"Saúde";"301";"Atenção básica";"1";"P";"1";"A";"0000";"PO";"777000,00";"0,00";"0,00";"0,00";"0,00";"0,00"',
].join("\n");

function bancadaFake(): BancadaPE {
  const dep = { nome: "André Ferreira", nome_civil: null, tipo: "deputado" as const, partido: "PL", nome_normalizado: "ANDRE FERREIRA" };
  const sen = {
    nome: "Humberto Costa",
    nome_civil: "Humberto Sérgio Costa Lima",
    tipo: "senador" as const,
    partido: "PT",
    nome_normalizado: "HUMBERTO COSTA",
  };
  return {
    deputados: new Map([[dep.nome_normalizado, dep]]),
    senadores: new Map([
      [sen.nome_normalizado, sen],
      [normalizarAutor(sen.nome_civil), sen],
    ]),
  };
}

describe("parsers das APIs de bancada", () => {
  test("parseDeputados extrai nome e partido da resposta da Câmara", () => {
    const r = parseDeputados({ dados: [{ nome: "André Ferreira", siglaPartido: "PL" }, { nome: "Iza Arruda", siglaPartido: "MDB" }] });
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ nome: "André Ferreira", nome_civil: null, tipo: "deputado", partido: "PL", nome_normalizado: "ANDRE FERREIRA" });
  });

  test("parseSenadoresPE filtra por UF no cliente (a API ignora ?uf=)", () => {
    const json = {
      ListaParlamentarEmExercicio: {
        Parlamentares: {
          Parlamentar: [
            { IdentificacaoParlamentar: { NomeParlamentar: "Humberto Costa", NomeCompletoParlamentar: "Humberto Sérgio Costa Lima", UfParlamentar: "PE", SiglaPartidoParlamentar: "PT" } },
            { IdentificacaoParlamentar: { NomeParlamentar: "Alguém da Bahia", UfParlamentar: "BA", SiglaPartidoParlamentar: "X" } },
          ],
        },
      },
    };
    const r = parseSenadoresPE(json);
    expect(r).toHaveLength(1);
    expect(r[0]?.nome).toBe("Humberto Costa");
    expect(r[0]?.tipo).toBe("senador");
  });
});

describe("filtrarPE — recorte e classificação", () => {
  const anos = [2023, 2024, 2025, 2026];

  test("classifica cada linha na categoria certa e descarta o que está fora do recorte", () => {
    const r = filtrarPE(CSV, anos, bancadaFake());
    expect(r.porCategoria).toEqual({ deputado: 1, senador: 1, bancada: 1, "gasto-pe": 1 });
    expect(r.linhas).toHaveLength(4); // Bahia e 2022 ficam de fora
    expect(r.linhasArquivo).toBe(6);
  });

  test("valores no formato brasileiro viram número", () => {
    const dep = filtrarPE(CSV, anos, bancadaFake()).linhas.find((l) => l.cat === "deputado");
    expect(dep?.vlrempenhado).toBe(1500000.5);
    expect(dep?.vlrliquidado).toBe(1000000);
    expect(dep?.autor).toBe("ANDRE FERREIRA");
    expect(dep?.partido).toBe("PL");
  });

  test("município só é aceito se existir na lista oficial do IBGE", () => {
    const linhas = filtrarPE(CSV, anos, bancadaFake()).linhas;
    expect(linhas.find((l) => l.cat === "deputado")?.municipio).toBe("RECIFE");
    // "PERNAMBUCO (UF)" não é município — fica null, não vira lixo
    expect(linhas.find((l) => l.cat === "senador")?.municipio).toBeNull();
    expect(linhas.find((l) => l.cat === "bancada")?.municipio).toBeNull();
  });

  test("autor de fora com gasto em PE entra como gasto-pe e vai para a auditoria", () => {
    const r = filtrarPE(CSV, anos, bancadaFake());
    const fora = r.linhas.find((l) => l.cat === "gasto-pe");
    expect(fora?.autor).toBe("FULANO DE OUTRO ESTADO");
    expect(fora?.municipio).toBe("CARUARU");
    expect(r.autoresNaoCasados).toContain("FULANO DE OUTRO ESTADO");
  });

  test("senador casa também pelo nome civil (o CSV usa ora um, ora outro)", () => {
    const csv = CSV.replace("HUMBERTO COSTA", "HUMBERTO SERGIO COSTA LIMA");
    const r = filtrarPE(csv, anos, bancadaFake());
    expect(r.porCategoria.senador).toBe(1);
    expect(r.autoresNaoCasados).not.toContain("HUMBERTO SERGIO COSTA LIMA");
  });

  test("cabeçalho inesperado falha alto em vez de gravar lixo", () => {
    expect(() => filtrarPE('"Coluna A";"Coluna B"\n"1";"2"', anos, bancadaFake())).toThrow(/cabeçalho inesperado/);
  });
});
