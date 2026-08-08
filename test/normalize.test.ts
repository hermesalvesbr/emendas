import { describe, expect, test } from "bun:test";
import {
  consolidarEmenda,
  consolidarLote,
  extrairEmenda,
  extrairBeneficiario,
  extrairMunicipio,
  gerarCoberturaMarkdown,
  propagarPorSubacao,
} from "../src/normalize.ts";
import type { AutorTipo, Confianca } from "../src/types.ts";
import fixtures from "./fixtures/obs-samples.json";

describe("extrairEmenda — padrões reais de obs (§5.5)", () => {
  for (const fixture of fixtures as Array<{
    descricao: string;
    obs: string | null;
    cd_nm_subacao: string;
    credor: string;
    exercicioArquivo: number;
    expected: {
      numero_emenda: string | null;
      exercicio_emenda: number | null;
      subacao_codigo: string;
      autor_normalizado: string | null;
      autor_tipo: AutorTipo;
      confianca: Confianca;
    };
  }>) {
    test(fixture.descricao, () => {
      const result = extrairEmenda({ obs: fixture.obs, cd_nm_subacao: fixture.cd_nm_subacao }, fixture.exercicioArquivo);
      expect(result.numero_emenda).toBe(fixture.expected.numero_emenda);
      expect(result.exercicio_emenda).toBe(fixture.expected.exercicio_emenda);
      expect(result.subacao_codigo).toBe(fixture.expected.subacao_codigo);
      expect(result.autor_normalizado).toBe(fixture.expected.autor_normalizado);
      expect(result.autor_tipo).toBe(fixture.expected.autor_tipo);
      expect(result.confianca).toBe(fixture.expected.confianca);
    });
  }
});

describe("extrairEmenda — casos adicionais", () => {
  test("número de emenda presente mas sem nenhum rótulo de autor reconhecível", () => {
    const result = extrairEmenda(
      { obs: "EMENDA PARLAMENTAR Nº 77/2024 REFERENTE A OBRAS DIVERSAS SEM AUTOR CITADO", cd_nm_subacao: "ZZZZ" },
      2024,
    );
    expect(result.numero_emenda).toBe("77");
    expect(result.autor_normalizado).toBeNull();
    expect(result.autor_tipo).toBe("desconhecido");
    expect(result.confianca).toBe("nula");
  });

  test("obs sem nenhum número de emenda reconhecível", () => {
    const result = extrairEmenda({ obs: "PAGAMENTO REFERENTE A CONVÊNIO SEM RELAÇÃO COM EMENDAS", cd_nm_subacao: "AAAA" }, 2024);
    expect(result.numero_emenda).toBeNull();
    expect(result.exercicio_emenda).toBeNull();
    expect(result.confianca).toBe("nula");
  });
});

describe("consolidarEmenda", () => {
  test("combina extração de autor, beneficiário e município a partir de uma linha de empenho", () => {
    const result = consolidarEmenda({
      obs: "EMENDA PARLAMENTAR N° 50060/2024 - DO DEPUTADO JOÃOZINHO TENORIO, SALGUEIRO-PE",
      cd_nm_subacao: "EN6Z - EMENDA PARLAMENTAR",
      credor: "12345678000199 - PREFEITURA MUNICIPAL DE SALGUEIRO",
      exercicio: 2024,
    });
    expect(result.numero_emenda).toBe("50060");
    expect(result.autor_normalizado).toBe("JOAOZINHO TENORIO");
    expect(result.beneficiario_cnpj).toBe("12345678000199");
    expect(result.beneficiario_nome).toBe("PREFEITURA MUNICIPAL DE SALGUEIRO");
    expect(result.municipio).toBe("SALGUEIRO");
  });
});

// Casos achados validando contra dados reais do CKAN (08/08/2026, busca por
// "SOCORRO PIMENTEL" e amostragem de registros "confiança alta" suspeitos).
describe("extrairEmenda — casos reais de validação pós-coleta", () => {
  test('rótulo "DO (A) PARLAMENTAR <nome> PARA O MUNICÍPIO" (achado: ~29% dos órfãos usavam esse formato)', () => {
    const result = extrairEmenda(
      {
        obs: "EMPENHO REFERENTE AO PAGAMENTO DA EP 179/2024 NA MODALIDADE DE TRANSFERÊNCIAS ESPECIAIS DO (A) PARLAMENTAR CLÉBER CHAPARRAL PARA O MUNICÍPIO DE  OROBÓ. GD 4.  DECRETO Nº 56.110, DE 31 DE JANEIRO DE 2024.",
        cd_nm_subacao: "EABC",
      },
      2024,
    );
    expect(result.numero_emenda).toBe("179");
    expect(result.autor_normalizado).toBe("CLEBER CHAPARRAL");
    expect(result.confianca).toBe("alta");
  });

  test("nome seguido de descrição sem espaço duplo (typo de origem) não vaza para autor_normalizado", () => {
    const result = extrairEmenda(
      { obs: "EMENDA PARLAMENTAR N º 60082/2024 - AUTORA: SOCORRO PIMENTEL PERFURAÇÃODE POÇOS ARTESIANOS EM IPUBI", cd_nm_subacao: "EM4H" },
      2024,
    );
    expect(result.autor_normalizado).toBe("SOCORRO PIMENTEL");
  });

  test('rótulo "DEP." colado sem espaço, nome seguido de ponto e mais texto', () => {
    const result = extrairEmenda(
      {
        obs: "VALOR EMPENHADO AO REPASSE,FEM III/15 AO MUNICIPIO DE SERRA TALHADA/PE 2ª PARCELA,EP 571/18 DEP.TERESA LEITÃO.AVIMENTAÇÃO ASFÁLTICA NA RUA: LUIZ ALVES DE MELO LIMA",
        cd_nm_subacao: "EG1H",
      },
      2022,
    );
    expect(result.autor_normalizado).toBe("TERESA LEITAO");
  });

  test('rótulo "DEPUTADO" seguido de hífen e nome, com texto de quantidade depois', () => {
    const result = extrairEmenda(
      {
        obs: "SERVIÇO DE PERFURAÇÃO DE POÇOS - EMENDA PARLAMENTAR Nº 3010/2022 - DERIVADA, EM MACAPARANA -DEPUTADO - AGLAILSON VICTOR .OBS; 2.59 X 38.500,00 = 99.715,00 .",
        cd_nm_subacao: "EIN6",
      },
      2022,
    );
    expect(result.autor_normalizado).toBe("AGLAILSON VICTOR");
  });

  test("texto descritivo sem nome real não vira autor falso-positivo (sem rótulo nem hífen inicial)", () => {
    const result = extrairEmenda(
      {
        obs: "EMENDA PARLAMENTAR Nº 236/2021 DESTINADA PARA GARANTIA DE OFERTA DE PROCEDIMENTOS DE MEDIA E ALTA COMPLEXIDADE AMBULATORIAL E HOSPITALAR.",
        cd_nm_subacao: "EZZZ",
      },
      2021,
    );
    expect(result.autor_normalizado).toBeNull();
    expect(result.confianca).toBe("nula");
  });

  test("hífen seguido de descrição (não nome) é rejeitado pelo fallback bare-dash", () => {
    const result = extrairEmenda(
      { obs: "EMENDA PARLAMENTAR Nº 93/2022 - PARA CURSOS PROFISSIONALIZANTES COM O INTUITO DE REINSERCAO", cd_nm_subacao: "EZZZ" },
      2022,
    );
    expect(result.autor_normalizado).toBeNull();
  });
});

describe("consolidarLote", () => {
  test("reduz múltiplos empenhos da mesma emenda a um registro, mantendo a melhor confiança", () => {
    const empenhos = [
      {
        obs: "EMENDA PARLAMENTAR Nº 51/2021",
        cd_nm_subacao: "E865 - X",
        credor: "111 - PREFEITURA MUNICIPAL DE VERTENTES",
        exercicio: 2024,
      },
      {
        obs: "EMENDA PARLAMENTAR N° 50060/2024 - DO DEPUTADO JOÃOZINHO TENORIO, SALGUEIRO-PE",
        cd_nm_subacao: "EN6Z - Y",
        credor: "222 - FULANO LTDA",
        exercicio: 2024,
      },
      {
        obs: "PAGAMENTO REFERENTE AO EMPENHO ANTERIOR",
        cd_nm_subacao: "E865 - X",
        credor: "333 - OUTRO CREDOR",
        exercicio: 2024,
      },
    ];

    const resultado = consolidarLote(empenhos);
    expect(resultado).toHaveLength(2);

    const emenda51 = resultado.find((e) => e.numero_emenda === "51");
    expect(emenda51?.confianca).toBe("nula");
    expect(emenda51?.municipio).toBe("VERTENTES");

    const emenda50060 = resultado.find((e) => e.numero_emenda === "50060");
    expect(emenda50060?.autor_normalizado).toBe("JOAOZINHO TENORIO");
    expect(emenda50060?.municipio).toBe("SALGUEIRO");
  });

  test("propaga autor entre empenhos consolidados que compartilham subação", () => {
    const empenhos = [
      {
        obs: "EMENDA PARLAMENTAR Nº 10/2024 - AUTORA: MARIA SILVA",
        cd_nm_subacao: "ABCD - X",
        credor: "111 - PREFEITURA MUNICIPAL DE OLINDA",
        exercicio: 2024,
      },
      {
        obs: "EMENDA PARLAMENTAR Nº 20/2024",
        cd_nm_subacao: "ABCD - X",
        credor: "222 - OUTRO CREDOR",
        exercicio: 2024,
      },
    ];

    const resultado = consolidarLote(empenhos);
    const emenda20 = resultado.find((e) => e.numero_emenda === "20");
    expect(emenda20?.confianca).toBe("media");
    expect(emenda20?.autor_normalizado).toBe("MARIA SILVA");
  });

  test("descarta empenhos sem número de emenda reconhecível", () => {
    const resultado = consolidarLote([{ obs: "SEM RELAÇÃO COM EMENDAS", cd_nm_subacao: "ZZZZ", credor: null, exercicio: 2024 }]);
    expect(resultado).toHaveLength(0);
  });
});

describe("extrairBeneficiario", () => {
  test("split no primeiro espaço-hífen-espaço", () => {
    expect(extrairBeneficiario("11867116000149 - FERNANDO GUERRA PLANEJAMENTO LTDA")).toEqual({
      cnpj: "11867116000149",
      nome: "FERNANDO GUERRA PLANEJAMENTO LTDA",
    });
  });

  test("sem separador — tudo vira nome", () => {
    expect(extrairBeneficiario("FUNDO ESTADUAL DE SAÚDE")).toEqual({ cnpj: null, nome: "FUNDO ESTADUAL DE SAÚDE" });
  });

  test("credor nulo", () => {
    expect(extrairBeneficiario(null)).toEqual({ cnpj: null, nome: null });
  });
});

describe("extrairMunicipio", () => {
  test("padrão CIDADE-PE em obs", () => {
    expect(extrairMunicipio(null, "DO DEPUTADO JOÃOZINHO TENORIO, SALGUEIRO-PE")).toBe("SALGUEIRO");
  });

  test("padrão PREFEITURA MUNICIPAL DE X em credor", () => {
    expect(extrairMunicipio("12345678000199 - PREFEITURA MUNICIPAL DE CARUARU", null)).toBe("CARUARU");
  });

  test("sem heurística aplicável retorna null", () => {
    expect(extrairMunicipio("11867116000149 - FERNANDO GUERRA PLANEJAMENTO LTDA", "SEM PADRÃO RECONHECIDO")).toBeNull();
  });
});

describe("propagarPorSubacao — segundo passe", () => {
  test("propaga autor de um registro alta-confiança para os demais da mesma subação, com confiança média", () => {
    const extraidas = [
      {
        numero_emenda: "10",
        exercicio_emenda: 2024,
        subacao_codigo: "EM4A",
        autor_bruto: "FULANO",
        autor_normalizado: "FULANO",
        autor_tipo: "individual" as const,
        confianca: "alta" as const,
      },
      {
        numero_emenda: null,
        exercicio_emenda: null,
        subacao_codigo: "EM4A",
        autor_bruto: null,
        autor_normalizado: null,
        autor_tipo: "desconhecido" as const,
        confianca: "nula" as const,
      },
      {
        numero_emenda: null,
        exercicio_emenda: null,
        subacao_codigo: "EM4A",
        autor_bruto: null,
        autor_normalizado: null,
        autor_tipo: "desconhecido" as const,
        confianca: "nula" as const,
      },
    ];

    const resultado = propagarPorSubacao(extraidas);
    expect(resultado[0]?.confianca).toBe("alta");
    expect(resultado[1]?.confianca).toBe("media");
    expect(resultado[1]?.autor_normalizado).toBe("FULANO");
    expect(resultado[2]?.confianca).toBe("media");
  });

  test("subação sem nenhum registro de alta confiança fica órfã (nula)", () => {
    const extraidas = [
      {
        numero_emenda: null,
        exercicio_emenda: null,
        subacao_codigo: "XXXX",
        autor_bruto: null,
        autor_normalizado: null,
        autor_tipo: "desconhecido" as const,
        confianca: "nula" as const,
      },
    ];
    const resultado = propagarPorSubacao(extraidas);
    expect(resultado[0]?.confianca).toBe("nula");
  });

  test("nunca eleva propagação para confiança alta", () => {
    const extraidas = [
      {
        numero_emenda: "1",
        exercicio_emenda: 2024,
        subacao_codigo: "AAAA",
        autor_bruto: "X",
        autor_normalizado: "X",
        autor_tipo: "individual" as const,
        confianca: "alta" as const,
      },
      {
        numero_emenda: null,
        exercicio_emenda: null,
        subacao_codigo: "AAAA",
        autor_bruto: null,
        autor_normalizado: null,
        autor_tipo: "desconhecido" as const,
        confianca: "nula" as const,
      },
    ];
    const resultado = propagarPorSubacao(extraidas);
    expect(resultado.every((e) => e.confianca !== "alta" || e === resultado[0])).toBe(true);
  });
});

describe("gerarCoberturaMarkdown", () => {
  test("gera relatório com percentuais e lista de órfãos", () => {
    const md = gerarCoberturaMarkdown(
      {
        totalEmpenhos: 1000,
        totalEmendas: 100,
        comAutorAlta: 60,
        comAutorMedia: 20,
        semAutor: 20,
        orfaos: [{ subacao_codigo: "EM4A", exercicio: 2024, total: 5 }],
      },
      new Date("2026-08-08T12:00:00.000Z"),
    );

    expect(md).toContain("# Cobertura de autoria");
    expect(md).toContain("1000");
    expect(md).toContain("60 (60.0%)");
    expect(md).toContain("20 (20.0%)");
    expect(md).toContain("`EM4A`");
  });

  test("lida com zero emendas sem dividir por zero", () => {
    const md = gerarCoberturaMarkdown(
      { totalEmpenhos: 0, totalEmendas: 0, comAutorAlta: 0, comAutorMedia: 0, semAutor: 0, orfaos: [] },
      new Date("2026-08-08T12:00:00.000Z"),
    );
    expect(md).toContain("0.0%");
    expect(md).toContain("nenhum código de subação órfão");
  });
});
