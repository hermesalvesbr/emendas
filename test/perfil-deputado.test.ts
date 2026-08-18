import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db.ts";
import type { Db } from "../src/db.ts";
import { perfisDeputados, slugDeputado } from "../src/perfil-deputado.ts";

// Banco em memória montado à mão com os casos que a produção tem: nome de
// urna diferente do nome parlamentar, nome com acento e espaço à direita do
// lado do TSE, deputado sem emenda e deputado sem votação casável.

let db: Db;

function gab(chave: string, nome: string, opts: { civil?: string | null; partido?: string; total: number }) {
  return {
    chave,
    rotulo_api: `GAB.DEP. ${chave}`,
    rotulo_legado: null,
    codigo_setor: null,
    codigo_lotacao: null,
    deputado_nome: nome,
    deputado_normalizado: chave,
    deputado_matricula: null,
    deputado_nome_civil: opts.civil ?? null,
    partido: opts.partido ?? null,
    total: opts.total,
    total_legado: null,
    demissionarios: null,
    atualizado_em: "2026-08-18",
  };
}

function servidor(chaveGab: string, nome: string, cargo: string, admissao: string) {
  return {
    snapshot: "2026-08-18",
    chave: `${chaveGab}-${nome}`,
    matricula: null,
    nome,
    nome_normalizado: nome,
    cargo,
    cargo_codigo: null,
    vinculo: "Comissionado",
    codigo_lotacao: null,
    nome_lotacao: `GAB.DEP. ${chaveGab}`,
    gabinete_chave: chaveGab,
    data_admissao: admissao,
    no_legado: 0,
  };
}

beforeEach(() => {
  db = openDb(":memory:");
  const raw = db.raw;

  db.gravarSnapshotPessoal(
    "2026-08-18",
    [
      gab("SILENO GUEDES", "Sileno Guedes", { civil: "SILENO SOUSA GUEDES", partido: "PSB", total: 3 }),
      gab("SOCORRO PIMENTEL", "Socorro Pimentel", { partido: "PSD", total: 2 }),
      gab("ESTREANTE SEM NADA", "Estreante Sem Nada", { partido: "NOVO", total: 1 }),
    ],
    [
      servidor("SILENO GUEDES", "ANA", "Assessor Especial", "2023-02-10"),
      servidor("SILENO GUEDES", "BRUNO", "Assessor Especial", "2023-05-02"),
      servidor("SILENO GUEDES", "CARLA", "Chefe de Gabinete", "2025-03-01"),
      servidor("SOCORRO PIMENTEL", "DINA", "Assessor Especial", "2022-01-04"),
      servidor("SOCORRO PIMENTEL", "ELI", "Coordenador de Expediente", "2026-04-01"),
      servidor("ESTREANTE SEM NADA", "FLAVIO", "Assessor Especial", "2026-06-01"),
    ],
    [],
  );

  // Universo de emendas: o elo do painel exige empenho + emenda + dicionário
  // oficial. Reproduzido inteiro para o perfil bater com o agregado publicado.
  raw.query(`INSERT INTO empenho (exercicio, numero_empenho, unidade_gestora, credor, obs, cd_nm_subacao,
              cd_nm_funcao, vlrempenhado, vlrliquidado, vlrtotalpago, fonte, hash, coletado_em)
             VALUES (2025, '1', 'SEC SAUDE', 'PREFEITURA', 'emenda', '1234 - OBRA', 'Saude',
                     100000, 100000, 60000, 'ckan', 'h1', '2026-08-18')`).run();
  raw.query(`INSERT INTO empenho (exercicio, numero_empenho, unidade_gestora, credor, obs, cd_nm_subacao,
              cd_nm_funcao, vlrempenhado, vlrliquidado, vlrtotalpago, fonte, hash, coletado_em)
             VALUES (2026, '2', 'SEC SAUDE', 'PREFEITURA', 'emenda', '1234 - OBRA', 'Saude',
                     50000, 0, 0, 'ckan', 'h2', '2026-08-18')`).run();
  raw.query(`INSERT INTO empenho (exercicio, numero_empenho, unidade_gestora, credor, obs, cd_nm_subacao,
              cd_nm_funcao, vlrempenhado, vlrliquidado, vlrtotalpago, fonte, hash, coletado_em)
             VALUES (2025, '3', 'SEC EDUCACAO', 'PREFEITURA', 'emenda', '5678 - ESCOLA', 'Educacao',
                     20000, 20000, 20000, 'ckan', 'h3', '2026-08-18')`).run();

  db.upsertEmenda({
    numero_emenda: "10", exercicio_emenda: 2025, subacao_codigo: "1234",
    autor_bruto: "Sileno Guedes", autor_normalizado: "SILENO GUEDES", autor_tipo: "individual",
    municipio: "ARARIPINA", beneficiario_cnpj: null, beneficiario_nome: "PREFEITURA", confianca: "alta",
  });
  db.upsertEmenda({
    numero_emenda: "11", exercicio_emenda: 2025, subacao_codigo: "5678",
    autor_bruto: "Socorro Pimentel", autor_normalizado: "SOCORRO PIMENTEL", autor_tipo: "individual",
    municipio: "OURICURI", beneficiario_cnpj: null, beneficiario_nome: "PREFEITURA", confianca: "alta",
  });
  for (const [n, autor] of [["10", "Sileno Guedes"], ["11", "Socorro Pimentel"]] as const) {
    db.upsertAutoriaOficial({
      numero_emenda: n, exercicio_apresentacao: 2024, exercicio_loa: 2025,
      autor_nome: autor, autor_normalizado: autor.toUpperCase(), autor_tipo: "individual", ploa: "1/2024",
    });
  }

  // Votação de 2022 com as anomalias reais do dado do TSE: acento e espaço à
  // direita no nome de urna, e urna que não parece com o nome parlamentar.
  const votos = raw.query(`INSERT INTO votacao_2022_municipio
      (sq_candidato, nome_urna, nome_completo, cargo, partido, municipio, votos, coletado_em)
      VALUES ($sq, $urna, $civil, 'Deputado Estadual', $partido, $municipio, $votos, '2026-08-18')`);
  votos.run({ sq: "A", urna: "SILENO", civil: "SILENO SOUSA GUEDES", partido: "PSB", municipio: "RECIFE", votos: 3000 });
  votos.run({ sq: "A", urna: "SILENO", civil: "SILENO SOUSA GUEDES", partido: "PSB", municipio: "OLINDA", votos: 1000 });
  votos.run({ sq: "B", urna: "SOCORRO PIMENTEL ", civil: null, partido: "PSD", municipio: "ARARIPINA", votos: 8000 });
});

afterEach(() => db.close());

describe("slugDeputado", () => {
  test("deriva da chave normalizada, não do nome exibido", () => {
    expect(slugDeputado("SOCORRO PIMENTEL")).toBe("socorro-pimentel");
    expect(slugDeputado("DEL. GLEIDE ANGELO")).toBe("del-gleide-angelo");
    expect(slugDeputado("JOAO PAULO DO PT")).toBe("joao-paulo-do-pt");
  });
});

describe("perfisDeputados", () => {
  test("um perfil por gabinete, em ordem alfabética", () => {
    const p = perfisDeputados(db);
    expect(p.map((x) => x.nome)).toEqual(["Estreante Sem Nada", "Sileno Guedes", "Socorro Pimentel"]);
  });

  test("agrega emendas pelo mesmo elo do painel, sem contar a emenda duas vezes", () => {
    const sileno = perfisDeputados(db).find((p) => p.chave === "SILENO GUEDES");
    // A emenda 10/2025 executa em 2025 e 2026: duas linhas, UMA emenda.
    expect(sileno?.emendas?.n).toBe(1);
    expect(sileno?.emendas?.vemp).toBe(150000);
    expect(sileno?.emendas?.vpago).toBe(60000);
    expect(sileno?.emendas?.porExercicio).toEqual([
      { ex: 2025, n: 1, vemp: 100000, vpago: 60000 },
      { ex: 2026, n: 1, vemp: 50000, vpago: 0 },
    ]);
  });

  test("resolve município, região e valor por habitante", () => {
    const sileno = perfisDeputados(db).find((p) => p.chave === "SILENO GUEDES");
    const top = sileno?.emendas?.topMunicipios[0];
    expect(top?.nome).toBe("Araripina");
    expect(top?.regiao).toBe("Sertão do Araripe");
    expect(top?.porHabitante).toBeGreaterThan(0);
  });

  test("ranqueia por valor e por assessores, sobre o conjunto todo", () => {
    const p = perfisDeputados(db);
    const sileno = p.find((x) => x.chave === "SILENO GUEDES");
    const socorro = p.find((x) => x.chave === "SOCORRO PIMENTEL");
    expect(sileno?.emendas?.posicaoValor).toBe(1);
    expect(socorro?.emendas?.posicaoValor).toBe(2);
    expect(sileno?.gabinete.posicao).toBe(1);
    expect(socorro?.gabinete.posicao).toBe(2);
  });

  test("casa a votação de 2022 pelo nome civil quando o de urna não bate", () => {
    const sileno = perfisDeputados(db).find((p) => p.chave === "SILENO GUEDES");
    expect(sileno?.votacao2022?.casadoPor).toBe("nome-civil");
    expect(sileno?.votacao2022?.totalVotos).toBe(4000);
    expect(sileno?.votacao2022?.nomeMunicipioTop).toBe("Recife");
  });

  test("normaliza o nome de urna cru do TSE (acento e espaço à direita)", () => {
    const socorro = perfisDeputados(db).find((p) => p.chave === "SOCORRO PIMENTEL");
    expect(socorro?.votacao2022?.casadoPor).toBe("nome-de-urna");
    expect(socorro?.votacao2022?.totalVotos).toBe(8000);
    // Um único município: concentração máxima.
    expect(socorro?.votacao2022?.concentracao).toBe(1);
  });

  test("quem não tem emenda nem votação recebe null e uma lacuna explicada", () => {
    const novo = perfisDeputados(db).find((p) => p.chave === "ESTREANTE SEM NADA");
    expect(novo?.emendas).toBeNull();
    expect(novo?.votacao2022).toBeNull();
    expect(novo?.candidatura2026).toBeNull();
    expect(novo?.lacunas).toHaveLength(3);
    expect(novo?.lacunas.join(" ")).toContain("positivo-only");
  });

  test("composição do gabinete e renovação na legislatura", () => {
    const sileno = perfisDeputados(db).find((p) => p.chave === "SILENO GUEDES");
    expect(sileno?.gabinete.cargos).toEqual([
      { cargo: "Assessor Especial", n: 2 },
      { cargo: "Chefe de Gabinete", n: 1 },
    ]);
    expect(sileno?.gabinete.admissoesPorAno).toEqual([{ ano: 2023, n: 2 }, { ano: 2025, n: 1 }]);
    expect(sileno?.gabinete.admitidosNaLegislatura).toBe(3);

    // Admitida em 2022: veio de antes da 20ª legislatura.
    const socorro = perfisDeputados(db).find((p) => p.chave === "SOCORRO PIMENTEL");
    expect(socorro?.gabinete.admitidosNaLegislatura).toBe(1);
  });

  test("votação de outro cargo não entra no perfil do deputado estadual", () => {
    db.raw
      .query(`INSERT INTO votacao_2022_municipio
                (sq_candidato, nome_urna, nome_completo, cargo, partido, municipio, votos, coletado_em)
              VALUES ('C', 'SOCORRO PIMENTEL', NULL, 'Deputado Federal', 'PSD', 'RECIFE', 99999, '2026-08-18')`)
      .run();
    const socorro = perfisDeputados(db).find((p) => p.chave === "SOCORRO PIMENTEL");
    expect(socorro?.votacao2022?.totalVotos).toBe(8000);
  });

  test("homônimo na votação deixa o campo vazio em vez de escolher um", () => {
    db.raw
      .query(`INSERT INTO votacao_2022_municipio
                (sq_candidato, nome_urna, nome_completo, cargo, partido, municipio, votos, coletado_em)
              VALUES ('D', 'SOCORRO PIMENTEL', 'OUTRA PESSOA', 'Deputado Estadual', 'PT', 'RECIFE', 500, '2026-08-18')`)
      .run();
    const socorro = perfisDeputados(db).find((p) => p.chave === "SOCORRO PIMENTEL");
    expect(socorro?.votacao2022).toBeNull();
    expect(socorro?.lacunas.join(" ")).toContain("Votação de 2022 não casada");
  });
});
