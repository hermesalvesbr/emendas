import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  curiosidadesPorMunicipio,
  todosCandidatos,
  baseEleitoral,
  origemPorMunicipio,
  origemPorRegiao,
  agregadoPorAutorEstadual,
  agregadoPorFuncao,
  agregadoPorMunicipio,
  agregadoPorRegiao,
  liderPorMunicipio,
} from "../src/agregados.ts";

// Nenhum teste toca a rede nem o banco de produção.

const SCHEMA_MINIMO = `
CREATE TABLE empenho (
  id INTEGER PRIMARY KEY, exercicio INTEGER, numero_empenho TEXT,
  cd_nm_subacao TEXT, cd_nm_funcao TEXT,
  vlrempenhado REAL, vlrliquidado REAL, vlrtotalpago REAL,
  fonte TEXT, hash TEXT, coletado_em TEXT
);
CREATE TABLE emenda (
  numero_emenda TEXT, exercicio_emenda INTEGER, subacao_codigo TEXT,
  autor_bruto TEXT, autor_normalizado TEXT, autor_tipo TEXT,
  municipio TEXT, confianca TEXT,
  PRIMARY KEY (numero_emenda, exercicio_emenda)
);
CREATE TABLE emenda_federal (
  id INTEGER PRIMARY KEY, ano INTEGER, autor TEXT, autor_normalizado TEXT,
  cat TEXT, partido TEXT, municipio TEXT, funcao TEXT, subfuncao TEXT,
  vlrempenhado REAL
);
CREATE TABLE autoria_oficial (
  numero_emenda TEXT, autor_nome TEXT, autor_normalizado TEXT
);
CREATE TABLE parlamentar_federal (nome_normalizado TEXT, nome TEXT, tipo TEXT);
CREATE TABLE candidato_2026 (
  id INTEGER PRIMARY KEY, nome_urna TEXT, numero INTEGER, cargo TEXT, cargo_codigo INTEGER,
  partido TEXT, municipio_nascimento TEXT, uf_nascimento TEXT, regiao TEXT, cpf TEXT
);
CREATE TABLE votacao_2022 (
  sq_candidato TEXT, cpf TEXT, candidato_2026_id INTEGER, cd_municipio TEXT,
  municipio TEXT, cargo TEXT, nr_turno INTEGER, votos INTEGER, coletado_em TEXT
);
CREATE TABLE votacao_2022_municipio (
  sq_candidato TEXT, nome_urna TEXT, nome_completo TEXT, cargo TEXT,
  partido TEXT, municipio TEXT, votos INTEGER, coletado_em TEXT,
  PRIMARY KEY (sq_candidato, municipio)
);
`;

let db: Database;

/** Uma emenda com empenho: entra na contagem E no valor. */
function comEmpenho(numero: string, subacao: string, municipio: string, valor: number, autor: string | null = null): void {
  db.run(
    `INSERT INTO emenda (numero_emenda, exercicio_emenda, subacao_codigo, municipio, autor_normalizado, confianca)
     VALUES (?, 2024, ?, ?, ?, ?)`,
    [numero, subacao, municipio, autor, autor ? "alta" : "nula"],
  );
  db.run(
    `INSERT INTO empenho (exercicio, numero_empenho, cd_nm_subacao, vlrempenhado, fonte, hash, coletado_em)
     VALUES (2024, ?, ?, ?, 'ckan', ?, '2026-08-16')`,
    [`NE${numero}`, `${subacao} - EMENDA`, valor, `h${numero}${subacao}`],
  );
}

/** Emenda SEM empenho no escopo: não entra em nenhum dos dois. */
function semEmpenho(numero: string, subacao: string, municipio: string): void {
  db.run(
    `INSERT INTO emenda (numero_emenda, exercicio_emenda, subacao_codigo, municipio, confianca)
     VALUES (?, 2024, ?, ?, 'nula')`,
    [numero, subacao, municipio],
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA_MINIMO);
});

describe("universo único: n e v saem da mesma query", () => {
  /**
   * Regressão nomeada do bug publicado. Os 12 posts regionais contavam TODAS
   * as emendas ligadas ao município — inclusive as sem empenho no escopo — e
   * casavam com um valor que só somava as com empenho. O Agreste Central saiu
   * como "317 emendas: R$ 90,2 mi" quando as que produzem esse valor são 204.
   */
  test("emenda sem empenho não infla a contagem nem o valor", () => {
    comEmpenho("1", "AAAA", "RECIFE", 1000);
    comEmpenho("2", "BBBB", "RECIFE", 2000);
    semEmpenho("3", "CCCC", "RECIFE");
    semEmpenho("4", "DDDD", "RECIFE");

    const [recife] = agregadoPorMunicipio(db);
    expect(recife?.n).toBe(2);
    expect(recife?.v).toBe(3000);
  });

  test("a mesma emenda em dois municípios conta uma vez em cada, e a região não soma em dobro", () => {
    // Uma subação, dois municípios da MESMA região (RMR).
    db.run(`INSERT INTO emenda (numero_emenda, exercicio_emenda, subacao_codigo, municipio, confianca)
            VALUES ('9', 2024, 'ZZZZ', 'RECIFE', 'nula')`);
    db.run(`INSERT INTO emenda (numero_emenda, exercicio_emenda, subacao_codigo, municipio, confianca)
            VALUES ('9', 2025, 'ZZZZ', 'OLINDA', 'nula')`);
    db.run(`INSERT INTO empenho (exercicio, numero_empenho, cd_nm_subacao, vlrempenhado, fonte, hash, coletado_em)
            VALUES (2024, 'NE9', 'ZZZZ - EMENDA', 500, 'ckan', 'h9', '2026-08-16')`);

    const rmr = agregadoPorRegiao(db).find((r) => r.regiao === "Região Metropolitana do Recife");
    // 2 pares (numero, exercicio) distintos na região — contados uma vez cada,
    // pela query regional, não pela soma dos municípios.
    expect(rmr?.n).toBe(2);
  });

  test("federal e estadual somam no mesmo município sem se atropelar", () => {
    comEmpenho("1", "AAAA", "ARARIPINA", 1000);
    db.run(`INSERT INTO emenda_federal (ano, autor, autor_normalizado, cat, partido, municipio, funcao, vlrempenhado)
            VALUES (2024, 'Fulano', 'FULANO', 'deputado', 'X', 'ARARIPINA', 'Saúde', 4000)`);

    const [ararip] = agregadoPorMunicipio(db);
    expect(ararip?.n).toBe(2);
    expect(ararip?.v).toBe(5000);
  });

  test("municípios existentes e com emenda são universos declaradamente diferentes", () => {
    comEmpenho("1", "AAAA", "ARARIPINA", 1000);
    const araripe = agregadoPorRegiao(db).find((r) => r.regiao === "Sertão do Araripe");
    expect(araripe?.municipiosComEmenda).toBe(1);
    expect(araripe?.municipiosExistentes).toBeGreaterThan(1);
  });
});

describe("per capita", () => {
  test("divide pela população do Censo e zera quando ela é desconhecida", () => {
    comEmpenho("1", "AAAA", "CASINHAS", 12_967_000);
    const [c] = agregadoPorMunicipio(db);
    expect(c?.populacao).toBe(12967);
    expect(c?.porHabitante).toBeCloseTo(1000, 5);

    db.run(`INSERT INTO emenda_federal (ano, autor, autor_normalizado, cat, municipio, funcao, vlrempenhado)
            VALUES (2024, 'F', 'F', 'deputado', 'CIDADE QUE NAO EXISTE', 'Saúde', 100)`);
    const inexistente = agregadoPorMunicipio(db).find((m) => m.municipio === "CIDADE QUE NAO EXISTE");
    expect(inexistente?.porHabitante).toBe(0);
  });

  test("o nome de exibição sai acentuado", () => {
    comEmpenho("1", "AAAA", "SAO VICENTE FERRER", 1000);
    expect(agregadoPorMunicipio(db)[0]?.nome).toBe("São Vicente Férrer");
  });
});

describe("catraca do dicionário oficial de autoria", () => {
  /**
   * A trava que impede o pior post possível. `confianca='alta'` no banco real
   * tem ": EDUI", "APORTE FINANCEIRO" e "ADALTO SANTOS." — sobras de regex
   * sobre texto livre. Sem cruzar com autoria_oficial, "APORTE FINANCEIRO
   * lidera com R$ 3,2 mi" ia ao ar sozinho, às 3 da manhã.
   */
  test("autor que não está no dicionário da ALEPE fica de fora", () => {
    db.run(`INSERT INTO autoria_oficial VALUES ('1', 'Socorro Pimentel', 'SOCORRO PIMENTEL')`);
    comEmpenho("1", "AAAA", "ARARIPINA", 1000, "SOCORRO PIMENTEL");
    comEmpenho("2", "BBBB", "ARARIPINA", 9000, "APORTE FINANCEIRO");

    const autores = agregadoPorAutorEstadual(db);
    expect(autores.map((a) => a.chave)).toEqual(["SOCORRO PIMENTEL"]);
    expect(autores[0]?.nome).toBe("Socorro Pimentel");
  });

  test("o líder por município também respeita a catraca", () => {
    db.run(`INSERT INTO autoria_oficial VALUES ('1', 'Socorro Pimentel', 'SOCORRO PIMENTEL')`);
    comEmpenho("1", "AAAA", "ARARIPINA", 1000, "SOCORRO PIMENTEL");
    comEmpenho("2", "BBBB", "ARARIPINA", 9000, ": EDUI");

    const lideres = liderPorMunicipio(db);
    expect(lideres).toHaveLength(1);
    expect(lideres[0]?.autorNome).toBe("Socorro Pimentel");
    expect(lideres[0]?.v).toBe(1000);
  });

  test("autoria inferida (confiança média) não entra em ranking de autor", () => {
    db.run(`INSERT INTO autoria_oficial VALUES ('1', 'Socorro Pimentel', 'SOCORRO PIMENTEL')`);
    db.run(`INSERT INTO emenda (numero_emenda, exercicio_emenda, subacao_codigo, municipio, autor_normalizado, confianca)
            VALUES ('1', 2024, 'AAAA', 'ARARIPINA', 'SOCORRO PIMENTEL', 'media')`);
    db.run(`INSERT INTO empenho (exercicio, numero_empenho, cd_nm_subacao, vlrempenhado, fonte, hash, coletado_em)
            VALUES (2024, 'NE1', 'AAAA - EMENDA', 1000, 'ckan', 'h1', '2026-08-16')`);

    expect(agregadoPorAutorEstadual(db)).toEqual([]);
  });
});

describe("função federal", () => {
  test("conta emendas e autores distintos separadamente", () => {
    for (const [autor, v] of [["A", 100], ["B", 200], ["A", 300]] as const) {
      db.run(`INSERT INTO emenda_federal (ano, autor, autor_normalizado, cat, municipio, funcao, vlrempenhado)
              VALUES (2024, ?, ?, 'deputado', 'RECIFE', 'Saúde', ?)`, [autor, autor, v]);
    }
    const [saude] = agregadoPorFuncao(db);
    expect(saude?.n).toBe(3);
    expect(saude?.autores).toBe(2);
    expect(saude?.v).toBe(600);
  });
});


describe("origem dos candidatos", () => {
  function candidato(id: number, nome: string, municipio: string | null, uf: string, regiao: string | null): void {
    db.run(
      `INSERT INTO candidato_2026 (id, nome_urna, cargo, cargo_codigo, partido, municipio_nascimento, uf_nascimento, regiao)
       VALUES (?, ?, 'Deputado Estadual', 7, 'NOVO', ?, ?, ?)`,
      [id, nome, municipio, uf, regiao],
    );
  }

  test("devolve os 185 municípios, inclusive os sem nenhum candidato nativo", () => {
    candidato(1, "A", "ARARIPINA", "PE", "Sertão do Araripe");
    const om = origemPorMunicipio(db);
    expect(om).toHaveLength(185);
    expect(om.find((m) => m.municipio === "ARARIPINA")?.candidatos).toBe(1);
    // O zero é a informação, não a ausência de informação: são os municípios
    // que não produziram nenhum candidato. NUNCA "ninguém disputa lá".
    expect(om.filter((m) => m.candidatos === 0).length).toBe(184);
  });

  test("todo município leva código IBGE, que é a chave do mapa", () => {
    const om = origemPorMunicipio(db);
    expect(om.every((m) => m.codIbge !== null)).toBe(true);
    expect(om.find((m) => m.municipio === "ARARIPINA")?.codIbge).toBe("2601102");
  });

  test("nascido fora de PE não entra em município nenhum de PE", () => {
    candidato(1, "A", "ARARIPINA", "PE", "Sertão do Araripe");
    candidato(2, "B", "SAO PAULO", "SP", null);
    expect(origemPorMunicipio(db).reduce((s, m) => s + m.candidatos, 0)).toBe(1);
  });

  test("naturalidade acentuada do TSE casa com a chave normalizada", () => {
    candidato(1, "A", "JABOATÃO DOS GUARARAPES", "PE", "Região Metropolitana do Recife");
    expect(origemPorMunicipio(db).find((m) => m.municipio === "JABOATAO DOS GUARARAPES")?.candidatos).toBe(1);
  });

  test("quem nasceu fora de PE vira um grupo próprio, nunca redistribuído", () => {
    candidato(1, "A", "ARARIPINA", "PE", "Sertão do Araripe");
    candidato(2, "B", "SAO PAULO", "SP", null);
    const rs = origemPorRegiao(db);
    const fora = rs.find((r) => r.regiao === null);
    expect(fora?.rotulo).toBe("(nascido fora de PE)");
    expect(fora?.candidatos).toBe(1);
    // Sem população de referência: são 19 UFs diferentes, o per capita não existe.
    expect(fora?.por100Mil).toBe(0);
  });

  test("as 12 regiões aparecem mesmo com zero candidatos", () => {
    expect(origemPorRegiao(db).filter((r) => r.regiao !== null)).toHaveLength(12);
  });
});

describe("base eleitoral e concentração", () => {
  function comVotos(id: number, nascimento: string, regiao: string | null, votos: Array<[string, number]>): void {
    db.run(
      `INSERT INTO candidato_2026 (id, nome_urna, cargo, cargo_codigo, partido, municipio_nascimento, uf_nascimento, regiao)
       VALUES (?, 'FULANO', 'Deputado Estadual', 7, 'NOVO', ?, ?, ?)`,
      [id, nascimento, regiao === null ? "SP" : "PE", regiao],
    );
    for (const [m, v] of votos) {
      db.run(
        `INSERT INTO votacao_2022 (sq_candidato, cpf, candidato_2026_id, cd_municipio, municipio, cargo, nr_turno, votos, coletado_em)
         VALUES (?, '1', ?, ?, ?, 'DEPUTADO ESTADUAL', 1, ?, '2026-08-16')`,
        [`sq${id}`, id, m, m, v],
      );
    }
  }

  test("HHI = 1 quando todo o voto está num município só", () => {
    comVotos(1, "ARARIPINA", "Sertão do Araripe", [["ARARIPINA", 1000]]);
    expect(baseEleitoral(db)[0]?.concentracao).toBeCloseTo(1, 6);
  });

  test("HHI cai conforme o voto se pulveriza", () => {
    comVotos(1, "ARARIPINA", "Sertão do Araripe", [["ARARIPINA", 250], ["OURICURI", 250], ["EXU", 250], ["TRINDADE", 250]]);
    // 4 municípios iguais: 4 * 0,25² = 0,25
    expect(baseEleitoral(db)[0]?.concentracao).toBeCloseTo(0.25, 6);
  });

  test("% na região natal soma os municípios daquela região, não só o de nascimento", () => {
    // Araripina e Ouricuri são ambos do Sertão do Araripe; Recife não é.
    comVotos(1, "ARARIPINA", "Sertão do Araripe", [["ARARIPINA", 300], ["OURICURI", 200], ["RECIFE", 500]]);
    const b = baseEleitoral(db)[0];
    expect(b?.pctNaRegiaoNatal).toBeCloseTo(50, 6);
    expect(b?.pctNoMunicipioNatal).toBeCloseTo(30, 6);
  });

  test("nascido fora de PE tem % na região natal NULO, não zero", () => {
    // Zero afirmaria "não teve voto na região onde nasceu"; a verdade é que
    // não existe região natal em PE para comparar.
    comVotos(1, "SAO PAULO", null, [["RECIFE", 1000]]);
    const b = baseEleitoral(db)[0];
    expect(b?.pctNaRegiaoNatal).toBeNull();
    expect(b?.pctNoMunicipioNatal).toBeNull();
  });

  test("o município de maior votação é o de maior soma, não o primeiro lido", () => {
    comVotos(1, "ARARIPINA", "Sertão do Araripe", [["ARARIPINA", 100], ["RECIFE", 900]]);
    const b = baseEleitoral(db)[0];
    expect(b?.municipioTop).toBe("RECIFE");
    expect(b?.votosTop).toBe(900);
    expect(b?.nomeMunicipioTop).toBe("Recife");
    expect(b?.regiaoTop).toBe("Região Metropolitana do Recife");
  });

  test("votos vão para o front compactos, como [códigoIBGE, votos]", () => {
    comVotos(1, "ARARIPINA", "Sertão do Araripe", [["ARARIPINA", 100], ["RECIFE", 900]]);
    const vm = baseEleitoral(db)[0]?.votosPorMunicipio;
    // Ordenado do maior para o menor, e sem repetir o nome do município — que
    // sairia 44 mil vezes no JSON público.
    expect(vm?.[0]).toEqual(["2611606", 900]);
    expect(vm?.[1]).toEqual(["2601102", 100]);
  });

  test("só 1º turno: misturar turnos somaria universos diferentes", () => {
    comVotos(1, "ARARIPINA", "Sertão do Araripe", [["ARARIPINA", 100]]);
    db.run(`INSERT INTO votacao_2022 (sq_candidato, cpf, candidato_2026_id, cd_municipio, municipio, cargo, nr_turno, votos, coletado_em)
            VALUES ('sq1', '1', 1, 'ARARIPINA', 'ARARIPINA', 'X', 2, 5000, '2026-08-16')`);
    expect(baseEleitoral(db)[0]?.totalVotos).toBe(100);
  });

  test("candidato de 2026 que não concorreu em 2022 simplesmente não aparece", () => {
    // Ausência é "não estava na urna", nunca "teve zero voto" (NOTAS 29).
    db.run(`INSERT INTO candidato_2026 (id, nome_urna, cargo, cargo_codigo) VALUES (9, 'NOVATO', 'Deputado Estadual', 7)`);
    expect(baseEleitoral(db).find((b) => b.candidatoId === 9)).toBeUndefined();
  });
});


describe("nenhuma candidatura pode sumir da tela", () => {
  /**
   * Regressão do defeito relatado pelo próprio usuário: a tela listava só quem
   * tinha votação de 2022 e, com isso, sumia com 595 das 836 candidaturas —
   * inclusive a dele. Num painel de transparência, o estreante é exatamente
   * quem mais precisa aparecer: é de quem menos se sabe.
   */
  test("candidato sem votação de 2022 continua na lista", () => {
    db.run(`INSERT INTO candidato_2026 (id, nome_urna, cargo, cargo_codigo, partido, municipio_nascimento, uf_nascimento, regiao)
            VALUES (1, 'HERMES ALVES', '2º Suplente', 5, 'NOVO', 'ARARIPINA', 'PE', 'Sertão do Araripe')`);
    const todos = todosCandidatos(db);
    expect(todos).toHaveLength(1);
    expect(todos[0]?.nome).toBe("HERMES ALVES");
    // FALSE é "não estava na urna em 2022", nunca "teve zero voto" (NOTAS 29).
    expect(todos[0]?.temVotacao2022).toBe(false);
  });

  test("quem concorreu em 2022 vem marcado", () => {
    db.run(`INSERT INTO candidato_2026 (id, nome_urna, cargo, cargo_codigo) VALUES (2, 'VETERANO', 'Deputado Federal', 6)`);
    db.run(`INSERT INTO votacao_2022 (sq_candidato, cpf, candidato_2026_id, cd_municipio, municipio, nr_turno, votos, coletado_em)
            VALUES ('sq2', '1', 2, 'RECIFE', 'RECIFE', 1, 500, '2026-08-16')`);
    expect(todosCandidatos(db).find((c) => c.id === 2)?.temVotacao2022).toBe(true);
  });

  test("naturalidade leva código IBGE só quando o nascimento foi em PE", () => {
    db.run(`INSERT INTO candidato_2026 (id, nome_urna, cargo, cargo_codigo, municipio_nascimento, uf_nascimento, regiao)
            VALUES (3, 'DAQUI', 'Deputado Estadual', 7, 'ARARIPINA', 'PE', 'Sertão do Araripe')`);
    db.run(`INSERT INTO candidato_2026 (id, nome_urna, cargo, cargo_codigo, municipio_nascimento, uf_nascimento, regiao)
            VALUES (4, 'DE FORA', 'Deputado Estadual', 7, 'SAO PAULO', 'SP', NULL)`);
    const todos = todosCandidatos(db);
    expect(todos.find((c) => c.id === 3)?.codIbgeNascimento).toBe("2601102");
    // Sem código: o mapa é de PE e acender um município daqui seria mentira.
    expect(todos.find((c) => c.id === 4)?.codIbgeNascimento).toBeNull();
  });
});


describe("curiosidades por município", () => {
  function voto(sq: string, nome: string, cargo: string, partido: string, municipio: string, votos: number): void {
    db.run(
      `INSERT INTO votacao_2022_municipio (sq_candidato, nome_urna, nome_completo, cargo, partido, municipio, votos, coletado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, '2026-08-16')`,
      [sq, nome, nome, cargo, partido, municipio, votos],
    );
  }

  /**
   * Senador e governador disputam o estado inteiro e levam centenas de
   * milhares de votos. Um "mais votado" solto seria quase sempre o mesmo nome
   * em todos os 185 municípios — quem revela base local é o deputado.
   */
  test("o mais votado é apurado POR CARGO", () => {
    voto("s1", "SENADOR FAMOSO", "Senador", "PT", "ARARIPINA", 100000);
    voto("d1", "DEPUTADO LOCAL", "Deputado Estadual", "PP", "ARARIPINA", 9000);
    voto("d2", "OUTRO DEPUTADO", "Deputado Estadual", "PL", "ARARIPINA", 8000);

    const c = curiosidadesPorMunicipio(db).find((x) => x.municipio === "ARARIPINA");
    expect(c?.top["Deputado Estadual"]?.nome).toBe("DEPUTADO LOCAL");
    expect(c?.top["Deputado Estadual"]?.votos).toBe(9000);
    expect(c?.top.Senador?.nome).toBe("SENADOR FAMOSO");
  });

  test("nome de urna do TSE vem com espaço sobrando e é aparado", () => {
    // "SOCORRO PIMENTEL " no arquivo real. Publicar assim deixa a marca do
    // descuido num texto que se propõe a ser conferível.
    voto("d1", "SOCORRO PIMENTEL ", "Deputado Estadual", "UNIÃO ", "ARARIPINA", 19290);
    const c = curiosidadesPorMunicipio(db).find((x) => x.municipio === "ARARIPINA");
    expect(c?.top["Deputado Estadual"]?.nome).toBe("SOCORRO PIMENTEL");
    expect(c?.top["Deputado Estadual"]?.partido).toBe("UNIÃO");
  });

  test("conta candidatos distintos e soma os votos do município", () => {
    voto("d1", "A", "Deputado Estadual", "PP", "ARARIPINA", 100);
    voto("d2", "B", "Deputado Estadual", "PL", "ARARIPINA", 200);
    voto("d3", "C", "Deputado Federal", "PT", "ARARIPINA", 300);
    const c = curiosidadesPorMunicipio(db).find((x) => x.municipio === "ARARIPINA");
    expect(c?.candidatos2022).toBe(3);
    expect(c?.totalVotos2022).toBe(600);
  });

  test("devolve os 185 municípios, com zero para quem não tem nativo candidato", () => {
    const cs = curiosidadesPorMunicipio(db);
    expect(cs).toHaveLength(185);
    expect(cs.every((c) => c.nascidos === 0)).toBe(true);
  });

  test("nascidos e per capita saem da mesma cidade, com o nome acentuado", () => {
    db.run(`INSERT INTO candidato_2026 (id, nome_urna, cargo, cargo_codigo, municipio_nascimento, uf_nascimento, regiao)
            VALUES (1, 'A', 'Deputado Estadual', 7, 'ARARIPINA', 'PE', 'Sertão do Araripe')`);
    const c = curiosidadesPorMunicipio(db).find((x) => x.municipio === "ARARIPINA");
    expect(c?.nascidos).toBe(1);
    expect(c?.nome).toBe("Araripina");
    // 1 candidato / 85.088 habitantes * 100 mil
    expect(c?.por100Mil).toBeCloseTo((1 / (c?.populacao ?? 1)) * 1e5, 6);
  });
});
