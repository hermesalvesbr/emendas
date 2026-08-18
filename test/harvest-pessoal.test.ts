import { describe, expect, test } from "bun:test";
import {
  ALIAS_LEGADO,
  ALIAS_PARLAMENTAR,
  casarNomeCivil,
  chaveGabinete,
  parseFuncionariosCsv,
  parseMapaOcupacao,
  parseParlamentares,
  parseServidoresApi,
  reconciliar,
} from "../src/harvest-pessoal.ts";

// Fixtures são recortes das respostas reais das quatro fontes da ALEPE,
// capturadas em 18/08/2026. Nenhum teste toca a rede. O CSV está gravado em
// ISO-8859-1 de propósito: é assim que a ALEPE serve, rotulando como UTF-8.

const DIR = `${import.meta.dir}/fixtures/pessoal`;

async function fixtures() {
  const [servidores, parlamentares, mapa, csvBytes] = await Promise.all([
    Bun.file(`${DIR}/servidores.json`).text(),
    Bun.file(`${DIR}/parlamentares.json`).text(),
    Bun.file(`${DIR}/mapa-setores.json`).text(),
    Bun.file(`${DIR}/funcionarios.csv`).arrayBuffer(),
  ]);
  return {
    api: parseServidoresApi(servidores),
    parlamentares: parseParlamentares(parlamentares),
    mapa: parseMapaOcupacao(mapa),
    csv: parseFuncionariosCsv(csvBytes),
  };
}

describe("chaveGabinete", () => {
  test("aceita as duas grafias que a própria ALEPE usa", () => {
    expect(chaveGabinete("GAB.DEP. IZAIAS REGIS")).toBe("IZAIAS REGIS");
    expect(chaveGabinete("GAB.DEP.IZAIAS REGIS")).toBe("IZAIAS REGIS");
  });

  test("ignora acento e caixa", () => {
    expect(chaveGabinete("gab.dep. joão paulo do pt")).toBe("JOAO PAULO DO PT");
  });

  test("devolve null para lotação que não é gabinete parlamentar", () => {
    expect(chaveGabinete("Gerência de Apoio à Sistematização da Legislação Estadual")).toBeNull();
    expect(chaveGabinete("AUDITORIA")).toBeNull();
    expect(chaveGabinete(null)).toBeNull();
  });
});

describe("parseServidoresApi", () => {
  test("DATA_ADMISSAO vem como objeto, não como string ISO", async () => {
    const { api } = await fixtures();
    expect(api[0]?.data_admissao).toBe("2026-05-05");
    expect(api.find((s) => s.nome === "JOSE ANDRADE")?.data_admissao).toBeNull();
  });

  test("campo vazio vira null, não string vazia", async () => {
    const { api } = await fixtures();
    expect(api.find((s) => s.nome === "JOSE ANDRADE")?.cargo_efetivo).toBeNull();
  });

  test("corpo que não é JSON vira erro de parse, não retentado", () => {
    expect(() => parseServidoresApi("<html>301</html>")).toThrow(/não é JSON/);
  });
});

describe("parseFuncionariosCsv", () => {
  test("decodifica ISO-8859-1 apesar do header dizer UTF-8", async () => {
    const { csv } = await fixtures();
    const nomes = csv.map((f) => f.nome);
    expect(nomes).toContain("JOAO NEPOMUCENO DA CONCEIÇÃO");
    expect(nomes.join("")).not.toContain("�");
  });

  test("traz matrícula e código de setor, que os dados abertos não têm", async () => {
    const { csv } = await fixtures();
    const adalnery = csv.find((f) => f.nome.startsWith("ADALNERY"));
    expect(adalnery?.matricula).toBe("24746");
    expect(adalnery?.codigo_setor).toBe("1110270");
  });
});

describe("casarNomeCivil", () => {
  test("casa nome parlamentar com nome civil por tokens em ordem", async () => {
    const { csv } = await fixtures();
    const roster = csv.filter((f) => f.vinculo === "PARLAMENTAR");
    expect(casarNomeCivil("IZAIAS REGIS", roster)?.matricula).toBe("50025");
  });

  test("nome de urna que não deriva do civil fica sem matrícula, não chuta", async () => {
    const { csv } = await fixtures();
    const roster = csv.filter((f) => f.vinculo === "PARLAMENTAR");
    // "France Hacker" é Franz Araújo Hacker: FRANCE não é token do nome civil.
    expect(casarNomeCivil("FRANCE HACKER", roster)).toBeUndefined();
  });

  test("casamento ambíguo devolve undefined em vez de escolher um", () => {
    const roster = [
      { matricula: "1", nome: "JOAO PAULO DA COSTA CAVALCANTI", cargo: "", cargo_codigo: "", nome_setor: "", codigo_setor: "", vinculo: "PARLAMENTAR" },
      { matricula: "2", nome: "JOAO PAULO LIMA E SILVA", cargo: "", cargo_codigo: "", nome_setor: "", codigo_setor: "", vinculo: "PARLAMENTAR" },
    ];
    expect(casarNomeCivil("JOAO PAULO", roster)).toBeUndefined();
  });
});

describe("reconciliar", () => {
  test("conta a partir dos dados abertos e só deles", async () => {
    const f = await fixtures();
    const { gabinetes, servidores } = reconciliar("2026-08-18", f.api, f.csv, f.mapa, f.parlamentares);

    expect(gabinetes).toHaveLength(3);
    expect(servidores).toHaveLength(5);

    const izaias = gabinetes.find((g) => g.chave === "IZAIAS REGIS");
    // O legado diz 3 comissionados; os dados abertos listam 2. Vale o atual.
    expect(izaias?.total).toBe(2);
    expect(izaias?.total_legado).toBe(3);
    expect(izaias?.demissionarios).toBe(1);
  });

  test("liga o gabinete ao titular e ao partido, com alias quando os rótulos divergem", async () => {
    const f = await fixtures();
    const { gabinetes } = reconciliar("2026-08-18", f.api, f.csv, f.mapa, f.parlamentares);

    const nino = gabinetes.find((g) => g.chave === "NINO ENOQUE");
    expect(ALIAS_PARLAMENTAR["NINO ENOQUE"]).toBe("NINO DE ENOQUE");
    expect(nino?.deputado_nome).toBe("Nino de Enoque");
    expect(nino?.partido).toBe("PSD");
    // Alias do legado: o código de setor só é achável pelo rótulo antigo.
    expect(nino?.codigo_setor).toBe("1110310");
  });

  test("gabinete só no legado é registrado como troca de titular, não some nem entra na contagem", async () => {
    const f = await fixtures();
    const { gabinetes, divergencias } = reconciliar("2026-08-18", f.api, f.csv, f.mapa, f.parlamentares);

    expect(gabinetes.map((g) => g.chave)).not.toContain("CLEBER CHAPARRAL");
    const d = divergencias.find((x) => x.chave === "CLEBER CHAPARRAL");
    expect(d?.tipo).toBe("so-legado");
    expect(d?.detalhe).toContain("2 pessoa(s)");
  });

  test("gabinete só nos dados abertos é registrado, e fica sem código de setor", async () => {
    const f = await fixtures();
    const { gabinetes, divergencias } = reconciliar("2026-08-18", f.api, f.csv, f.mapa, f.parlamentares);

    const wanderson = gabinetes.find((g) => g.chave === "WANDERSON FLORENCIO");
    expect(wanderson?.total).toBe(1);
    expect(wanderson?.codigo_setor).toBeNull();
    expect(divergencias.some((d) => d.chave === "WANDERSON FLORENCIO" && d.tipo === "so-atual")).toBe(true);
  });

  test("homônimo no legado não recebe matrícula de outra pessoa", async () => {
    const f = await fixtures();
    const { servidores, divergencias } = reconciliar("2026-08-18", f.api, f.csv, f.mapa, f.parlamentares);

    // "MARIA DA SILVA" aparece com duas matrículas diferentes no CSV legado.
    const maria = servidores.find((s) => s.nome === "MARIA DA SILVA");
    expect(maria?.matricula).toBeNull();
    expect(maria?.no_legado).toBe(0);
    expect(divergencias.some((d) => d.tipo === "homonimo" && d.chave === "MARIA DA SILVA")).toBe(true);
  });

  test("quem não está em gabinete entra no snapshot com gabinete_chave nulo", async () => {
    const f = await fixtures();
    const { servidores } = reconciliar("2026-08-18", f.api, f.csv, f.mapa, f.parlamentares);
    const thiago = servidores.find((s) => s.nome === "THIAGO FREITAS LIRA");
    expect(thiago?.gabinete_chave).toBeNull();
  });

  test("a soma dos gabinetes é exatamente quem está lotado em gabinete", async () => {
    const f = await fixtures();
    const { gabinetes, servidores } = reconciliar("2026-08-18", f.api, f.csv, f.mapa, f.parlamentares);
    const soma = gabinetes.reduce((acc, g) => acc + g.total, 0);
    expect(soma).toBe(servidores.filter((s) => s.gabinete_chave !== null).length);
  });

  test("os alias cobrem exatamente os rótulos divergentes conhecidos", () => {
    expect(Object.keys(ALIAS_LEGADO).sort()).toEqual([
      "CLAUDIANO MARTINS FILHO",
      "DEL. GLEIDE ANGELO",
      "JOAO PAULO DO PT",
      "NINO ENOQUE",
    ]);
  });
});
