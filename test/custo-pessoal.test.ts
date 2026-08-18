import { describe, expect, test } from "bun:test";
import { chaveCargo, custoDaPessoa, custoDoGabinete, indexarRemuneracao } from "../src/custo-pessoal.ts";
import type { RemuneracaoCargo } from "../src/custo-pessoal.ts";
import type { ServidorAlepeRow } from "../src/db.ts";
import { parseRemuneracao } from "../src/harvest-pessoal.ts";

// Valores reais da tabela da Alepe, competência 08/2026.
const TABELA_JSON = JSON.stringify([
  { cargo: "Assessor Especial", remuneracao: "10363.58", tipoCargo: "Cargo Comissionado de Gabinete", mesCompetencia: 8, anoCompetencia: 2026 },
  { cargo: "Assessor Especial Adjunto", remuneracao: "3238.64", tipoCargo: "Cargo Comissionado de Gabinete", mesCompetencia: 8, anoCompetencia: 2026 },
  { cargo: "Coordenador de Expediente", remuneracao: "2267.01", tipoCargo: "Cargo Comissionado de Gabinete", mesCompetencia: 8, anoCompetencia: 2026 },
  { cargo: "Chefe de Gabinete", remuneracao: "11685.70", tipoCargo: "Cargo Comissionado de Gabinete", mesCompetencia: 8, anoCompetencia: 2026 },
]);

function pessoa(cargo: string | null, vinculo = "Comissionado"): ServidorAlepeRow {
  return {
    snapshot: "2026-08-18", chave: `x-${cargo}-${vinculo}`, matricula: null,
    nome: "ALGUEM", nome_normalizado: "ALGUEM", cargo, cargo_codigo: null,
    vinculo, codigo_lotacao: null, nome_lotacao: "GAB.DEP. X",
    gabinete_chave: "X", data_admissao: "2023-02-10", no_legado: 0,
  };
}

const tabela = indexarRemuneracao(parseRemuneracao(TABELA_JSON));

describe("parseRemuneracao", () => {
  test("remuneracao vem como STRING na API e precisa virar número", () => {
    const linhas = parseRemuneracao(TABELA_JSON);
    expect(linhas).toHaveLength(4);
    expect(linhas[0]?.remuneracao).toBe(10363.58);
    expect(typeof linhas[0]?.remuneracao).toBe("number");
  });

  test("monta a competência como YYYY-MM, com mês zero-padded", () => {
    expect(parseRemuneracao(TABELA_JSON)[0]?.competencia).toBe("2026-08");
  });

  test("descarta linha sem cargo ou sem valor utilizável", () => {
    const sujo = JSON.stringify([
      { cargo: "", remuneracao: "100", mesCompetencia: 8, anoCompetencia: 2026 },
      { cargo: "Válido", remuneracao: "abc", mesCompetencia: 8, anoCompetencia: 2026 },
      { cargo: "Válido", remuneracao: "100", mesCompetencia: 8, anoCompetencia: 2026 },
    ]);
    expect(parseRemuneracao(sujo)).toHaveLength(1);
  });

  test("corpo que não é JSON vira erro de parse", () => {
    expect(() => parseRemuneracao("<html>")).toThrow(/não é JSON/);
  });
});

describe("chaveCargo", () => {
  test("junta apesar de caixa e acento — os dois lados vêm da Alepe com grafias diferentes", () => {
    expect(chaveCargo("Assessor Especial")).toBe(chaveCargo("ASSESSOR ESPECIAL"));
    expect(chaveCargo("Coordenador de Expediente")).toBe("COORDENADOR DE EXPEDIENTE");
  });
});

describe("custoDaPessoa", () => {
  test("comissionado com cargo na tabela recebe o vencimento do cargo", () => {
    expect(custoDaPessoa(pessoa("Assessor Especial"), tabela).remuneracaoCargo).toBe(10363.58);
    expect(custoDaPessoa(pessoa("Chefe de Gabinete"), tabela).remuneracaoCargo).toBe(11685.70);
  });

  test("à disposição fica fora, mesmo ocupando cargo comissionado", () => {
    // 6 casos reais em 18/08/2026: cedido pode optar pela remuneração do órgão
    // de origem, e a Alepe não publica qual. Contar seria inventar despesa.
    const c = custoDaPessoa(pessoa("Chefe de Gabinete", "À Disposição"), tabela);
    expect(c.remuneracaoCargo).toBeNull();
    expect(c.motivoSemValor).toBe("a-disposicao");
  });

  test("sem cargo informado fica fora, com o motivo registrado", () => {
    const c = custoDaPessoa(pessoa(null), tabela);
    expect(c.remuneracaoCargo).toBeNull();
    expect(c.motivoSemValor).toBe("sem-cargo-informado");
  });

  test("cargo que não está na tabela fica fora — nunca estimado por semelhança", () => {
    const c = custoDaPessoa(pessoa("Assessor Sideral"), tabela);
    expect(c.remuneracaoCargo).toBeNull();
    expect(c.motivoSemValor).toBe("cargo-fora-da-tabela");
  });
});

describe("custoDoGabinete", () => {
  test("soma só quem tem estimativa e conta o resto separado", () => {
    const c = custoDoGabinete(
      [
        pessoa("Assessor Especial"),
        pessoa("Assessor Especial"),
        pessoa("Coordenador de Expediente"),
        pessoa("Chefe de Gabinete"),
        pessoa(null, "À Disposição"),
      ],
      tabela,
    );
    // Arredondado ao centavo: a soma bruta em float dá 34679.869999999995.
    expect(c.mensal).toBe(34679.87);
    expect(c.comValor).toBe(4);
    expect(c.semValor).toBe(1);
    expect(c.motivos).toEqual({ "a-disposicao": 1 });
  });

  test("gabinete vazio custa zero, não NaN", () => {
    expect(custoDoGabinete([], tabela)).toEqual({ mensal: 0, comValor: 0, semValor: 0, motivos: {} });
  });

  test("tabela ausente não zera o quadro em silêncio — todos ficam sem valor", () => {
    const c = custoDoGabinete([pessoa("Assessor Especial")], indexarRemuneracao([]));
    expect(c.mensal).toBe(0);
    expect(c.semValor).toBe(1);
    expect(c.motivos).toEqual({ "cargo-fora-da-tabela": 1 });
  });

  test("headcount igual pode dar custo diferente — é o ponto da tela", () => {
    const caro = custoDoGabinete([pessoa("Assessor Especial"), pessoa("Assessor Especial")], tabela);
    const barato = custoDoGabinete([pessoa("Coordenador de Expediente"), pessoa("Coordenador de Expediente")], tabela);
    expect(caro.comValor).toBe(barato.comValor);
    expect(caro.mensal).toBeGreaterThan(barato.mensal * 4);
  });

  test("competência distinta não se mistura no índice", () => {
    const duas: RemuneracaoCargo[] = [
      { competencia: "2026-07", cargo: "Assessor Especial", cargo_normalizado: "ASSESSOR ESPECIAL", tipo_cargo: null, remuneracao: 9000 },
      { competencia: "2026-08", cargo: "Assessor Especial", cargo_normalizado: "ASSESSOR ESPECIAL", tipo_cargo: null, remuneracao: 10363.58 },
    ];
    // indexarRemuneracao recebe UMA competência (o Db filtra antes); se vierem
    // duas, a última vence — o que torna obrigatório filtrar na consulta.
    expect(indexarRemuneracao(duas).get("ASSESSOR ESPECIAL")?.remuneracao).toBe(10363.58);
  });
});
