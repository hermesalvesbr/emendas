import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { agregadoPorGabinete, gabinetesOuNada, totaisGabinete } from "../src/agregados-gabinete.ts";

// Nenhum teste toca a rede nem o banco de produção.

const SCHEMA_MINIMO = `
CREATE TABLE gabinete (
  chave TEXT PRIMARY KEY, rotulo_api TEXT, rotulo_legado TEXT,
  codigo_setor TEXT, codigo_lotacao TEXT,
  deputado_nome TEXT, deputado_normalizado TEXT, deputado_matricula TEXT,
  deputado_nome_civil TEXT, partido TEXT, total INTEGER, total_legado INTEGER
);
CREATE TABLE servidor_alepe (
  snapshot TEXT, chave TEXT, matricula TEXT, nome TEXT, nome_normalizado TEXT,
  cargo TEXT, cargo_codigo TEXT, vinculo TEXT, codigo_lotacao TEXT,
  nome_lotacao TEXT, gabinete_chave TEXT, data_admissao TEXT, no_legado INTEGER
);
CREATE TABLE remuneracao_cargo (
  competencia TEXT, cargo TEXT, cargo_normalizado TEXT, tipo_cargo TEXT, remuneracao REAL
);
`;

const CHEFE = 11685.7;
const ASSESSOR = 10363.58;
const COORDENADOR = 2267.01;

let db: Database;

function gabinete(chave: string, nome: string, partido: string, total: number): void {
  db.run(
    `INSERT INTO gabinete (chave, deputado_nome, deputado_normalizado, partido, total)
     VALUES (?, ?, ?, ?, ?)`,
    [chave, nome, nome.toUpperCase(), partido, total],
  );
}

function pessoa(chave: string, nome: string, cargo: string | null, vinculo = "Comissionado", snapshot = "2026-08-18"): void {
  db.run(
    `INSERT INTO servidor_alepe (snapshot, chave, nome, nome_normalizado, cargo, vinculo, gabinete_chave)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [snapshot, `${chave}-${nome}`, nome, nome.toUpperCase(), cargo, vinculo, chave],
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA_MINIMO);
  for (const [cargo, venc] of [
    ["Chefe de Gabinete", CHEFE],
    ["Assessor Especial", ASSESSOR],
    ["Coordenador de Expediente", COORDENADOR],
  ] as const) {
    db.run(`INSERT INTO remuneracao_cargo (competencia, cargo, cargo_normalizado, remuneracao) VALUES (?, ?, ?, ?)`, [
      "2026-08",
      cargo,
      cargo.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, ""),
      venc,
    ]);
  }
});

describe("agregado de gabinete", () => {
  test("pessoas e custo saem das mesmas linhas", () => {
    gabinete("g1", "Fulana", "XYZ", 3);
    pessoa("g1", "A", "Assessor Especial");
    pessoa("g1", "B", "Coordenador de Expediente");
    pessoa("g1", "C", "Chefe de Gabinete");

    const [g] = agregadoPorGabinete(db);
    expect(g?.pessoas).toBe(3);
    expect(g?.custoMensal).toBeCloseTo(ASSESSOR + COORDENADOR + CHEFE, 2);
    expect(g?.semCusto).toBe(0);
  });

  /**
   * A regra de NOTAS 40 que mais custa dinheiro se for violada: cedido é pago
   * pelo órgão de origem e a Alepe não publica quanto. Contá-lo seria inventar
   * despesa — o número sairia maior do que a Casa gasta, com um nome ao lado.
   */
  test("quem está à disposição conta como pessoa e NÃO conta como custo", () => {
    gabinete("g1", "Fulana", "XYZ", 2);
    pessoa("g1", "A", "Assessor Especial");
    pessoa("g1", "B", "Assessor Especial", "À Disposição");

    const [g] = agregadoPorGabinete(db);
    expect(g?.pessoas).toBe(2);
    expect(g?.custoMensal).toBeCloseTo(ASSESSOR, 2);
    expect(g?.semCusto).toBe(1);
  });

  test("cargo fora da tabela fica sem valor em vez de ser estimado por semelhança", () => {
    gabinete("g1", "Fulana", "XYZ", 2);
    pessoa("g1", "A", "Assessor Especial");
    pessoa("g1", "B", "Cargo Que Não Existe Na Tabela");

    const [g] = agregadoPorGabinete(db);
    expect(g?.custoMensal).toBeCloseTo(ASSESSOR, 2);
    expect(g?.semCusto).toBe(1);
  });

  /**
   * O achado que obriga a publicar os dois rankings juntos: quem tem mais
   * gente pode ser mais barato. Se este teste quebrar, o contraste sumiu do
   * agregado — e a série passaria a publicar só metade do quadro.
   */
  test("posto de pessoas e posto de custo podem se contradizer", () => {
    gabinete("muitos", "Muitos", "AAA", 4);
    for (const n of ["A", "B", "C", "D"]) pessoa("muitos", n, "Coordenador de Expediente");
    gabinete("caros", "Caros", "BBB", 2);
    for (const n of ["E", "F"]) pessoa("caros", n, "Chefe de Gabinete");

    const linhas = agregadoPorGabinete(db);
    const muitos = linhas.find((l) => l.deputado === "Muitos");
    const caros = linhas.find((l) => l.deputado === "Caros");
    expect(muitos?.postoPessoas).toBe(1);
    expect(muitos?.postoCusto).toBe(2);
    expect(caros?.postoPessoas).toBe(2);
    expect(caros?.postoCusto).toBe(1);
  });

  test("lança quando a foto do snapshot diverge do total gravado", () => {
    gabinete("g1", "Fulana", "XYZ", 5);
    pessoa("g1", "A", "Assessor Especial");
    expect(() => agregadoPorGabinete(db)).toThrow(/total 5 mas 1 pessoa/);
  });

  test("só o snapshot mais recente entra na conta", () => {
    gabinete("g1", "Fulana", "XYZ", 1);
    pessoa("g1", "A", "Assessor Especial", "Comissionado", "2026-08-18");
    pessoa("g1", "VELHO", "Chefe de Gabinete", "Comissionado", "2026-07-01");

    const [g] = agregadoPorGabinete(db);
    expect(g?.pessoas).toBe(1);
    expect(g?.custoMensal).toBeCloseTo(ASSESSOR, 2);
  });
});

describe("totais de gabinete", () => {
  test("soma a Casa e mede a razão entre o cargo mais caro e o mais barato", () => {
    gabinete("g1", "Fulana", "XYZ", 2);
    pessoa("g1", "A", "Chefe de Gabinete");
    pessoa("g1", "B", "Coordenador de Expediente");
    gabinete("g2", "Beltrano", "ABC", 1);
    pessoa("g2", "C", "Assessor Especial");

    const t = totaisGabinete(db);
    expect(t?.gabinetes).toBe(2);
    expect(t?.pessoas).toBe(3);
    expect(t?.custoMensal).toBeCloseTo(CHEFE + COORDENADOR + ASSESSOR, 2);
    expect(t?.custoAnualSimples).toBeCloseTo((CHEFE + COORDENADOR + ASSESSOR) * 12, 2);
    expect(t?.menorGabinete).toBe(1);
    expect(t?.maiorGabinete).toBe(2);
    expect(t?.cargoTopo).toBe("Chefe de Gabinete");
    expect(t?.cargoBase).toBe("Coordenador de Expediente");
    expect(t?.razaoTopoBase).toBeCloseTo(5.2, 1);
  });

  /**
   * "(sem cargo informado)" tem vencimento zero. Se entrasse na razão, o post
   * publicaria "um cargo custa Infinity vezes o outro" — ou, pior, um número
   * finito e errado.
   */
  test("cargo sem vencimento não vira base da razão", () => {
    gabinete("g1", "Fulana", "XYZ", 2);
    pessoa("g1", "A", "Chefe de Gabinete");
    pessoa("g1", "B", null, "À Disposição");

    const t = totaisGabinete(db);
    expect(t?.cargoBase).toBe("Chefe de Gabinete");
    expect(Number.isFinite(t?.razaoTopoBase ?? Number.NaN)).toBe(true);
  });

  test("banco sem pessoal devolve null em vez de quebrar", () => {
    expect(totaisGabinete(db)).toBeNull();
  });
});

describe("contenção da falha", () => {
  /**
   * O raio de alcance importa mais que a falha. `indiceDeFatos` é reconstruído
   * a cada publicação; se o agregado de gabinete lançasse dali, uma divergência
   * no snapshot de pessoal pararia a série INTEIRA — inclusive o post de
   * cidade, que não cita pessoal nenhum.
   */
  test("snapshot divergente devolve vazio com motivo, em vez de lançar", () => {
    gabinete("g1", "Fulana", "XYZ", 5);
    pessoa("g1", "A", "Assessor Especial");

    expect(() => agregadoPorGabinete(db)).toThrow();

    const r = gabinetesOuNada(db);
    expect(r.linhas).toEqual([]);
    expect(r.totais).toBeNull();
    expect(r.erro).toMatch(/total 5 mas 1 pessoa/);
  });

  test("com dado íntegro, devolve os agregados e nenhum erro", () => {
    gabinete("g1", "Fulana", "XYZ", 1);
    pessoa("g1", "A", "Assessor Especial");

    const r = gabinetesOuNada(db);
    expect(r.linhas.length).toBe(1);
    expect(r.totais?.pessoas).toBe(1);
    expect(r.erro).toBeNull();
  });
});
