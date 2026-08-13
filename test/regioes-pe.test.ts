import { describe, expect, test } from "bun:test";
import { MUNICIPIO_REGIAO, REGIOES_PE, regiaoDoMunicipio } from "../src/regioes-pe.ts";
import { MUNICIPIOS_PE } from "../src/municipios-pe.ts";

describe("mapa de regiões de PE", () => {
  test("cobre os 185 municípios do estado, sem sobra nem falta", () => {
    expect(MUNICIPIO_REGIAO.size).toBe(185);
    const semRegiao = [...MUNICIPIOS_PE].filter((m) => !MUNICIPIO_REGIAO.has(m));
    expect(semRegiao).toEqual([]);
  });

  test("são 12 regiões e toda região tem pelo menos um município", () => {
    expect(REGIOES_PE).toHaveLength(12);
    const usadas = new Set(MUNICIPIO_REGIAO.values());
    expect([...REGIOES_PE].filter((r) => !usadas.has(r))).toEqual([]);
  });

  test("aceita nome com acento e caixa variada", () => {
    expect(regiaoDoMunicipio("Araripina")).toBe("Sertão do Araripe");
    expect(regiaoDoMunicipio("SÃO JOSÉ DO EGITO")).toBe("Sertão do Pajeú");
    expect(regiaoDoMunicipio("recife")).toBe("Região Metropolitana do Recife");
  });

  test("Vitória de Santo Antão fica na RMR — o agrupamento publicado em POSTS-X.md", () => {
    expect(regiaoDoMunicipio("VITORIA DE SANTO ANTAO")).toBe("Região Metropolitana do Recife");
  });

  test("município de fora ou nome inválido devolve null", () => {
    expect(regiaoDoMunicipio("SALVADOR")).toBeNull();
    expect(regiaoDoMunicipio(null)).toBeNull();
    expect(regiaoDoMunicipio("")).toBeNull();
  });
});
