import { Database, type Statement } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AutorTipo, Confianca, EmendaRow, EmpenhoRow, HarvestLogRow, HarvestSource, HarvestStatus } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS empenho (
  id INTEGER PRIMARY KEY,
  exercicio INTEGER NOT NULL,
  numero_empenho TEXT NOT NULL,
  unidade_gestora TEXT, credor TEXT, obs TEXT,
  cd_nm_subacao TEXT, cd_nm_funcao TEXT,
  vlrempenhado REAL, vlrliquidado REAL, vlrtotalpago REAL,
  fonte TEXT NOT NULL CHECK (fonte IN ('pentaho','ckan')),
  hash TEXT NOT NULL UNIQUE,
  coletado_em TEXT NOT NULL
);

-- Estendida além do §5.6 literal: municipio/beneficiario_* são exigidos pelos
-- "campos derivados" de §5.5 e pela rota GET /api/municipio/:nome (§5.8), mas
-- não tinham coluna no schema original. Ver NOTAS.md item 7.
CREATE TABLE IF NOT EXISTS emenda (
  numero_emenda TEXT, exercicio_emenda INTEGER, subacao_codigo TEXT,
  autor_bruto TEXT, autor_normalizado TEXT, autor_tipo TEXT,
  municipio TEXT, beneficiario_cnpj TEXT, beneficiario_nome TEXT,
  confianca TEXT NOT NULL,
  PRIMARY KEY (numero_emenda, exercicio_emenda)
);

CREATE TABLE IF NOT EXISTS harvest_log (
  id INTEGER PRIMARY KEY,
  alvo TEXT NOT NULL, exercicio INTEGER,
  status TEXT NOT NULL CHECK (status IN ('ok','empty','http','timeout','parse')),
  tentativas INTEGER, http_status INTEGER,
  duracao_ms INTEGER, mensagem TEXT, quando TEXT NOT NULL
);

-- Dicionário oficial de autoria vindo da API da ALEPE (bloco <emendas> do
-- detalhe de cada PLOA — ver NOTAS.md item 19). Tabela separada de "emenda"
-- de propósito: "emenda" é o universo com execução orçamentária; isto aqui é
-- o universo aprovado pela ALEPE. A aplicação (aplicarAutoriaOficial) só
-- eleva registros existentes — não infla o denominador da cobertura.
-- exercicio_apresentacao = ano em que a emenda foi apresentada ao PLOA (como
-- a ALEPE numera: "650/2022"); exercicio_loa = exercício orçado pela LOA
-- resultante ("650/2023" nos empenhos). Os textos de empenho citam ora um,
-- ora outro — a aplicação tenta os dois.
CREATE TABLE IF NOT EXISTS autoria_oficial (
  numero_emenda TEXT NOT NULL, exercicio_apresentacao INTEGER NOT NULL, exercicio_loa INTEGER NOT NULL,
  autor_nome TEXT NOT NULL, autor_normalizado TEXT NOT NULL, autor_tipo TEXT NOT NULL,
  ploa TEXT NOT NULL, coletado_em TEXT NOT NULL,
  PRIMARY KEY (numero_emenda, exercicio_apresentacao)
);

CREATE INDEX IF NOT EXISTS idx_emp_subacao ON empenho(cd_nm_subacao);
CREATE INDEX IF NOT EXISTS idx_emp_exercicio ON empenho(exercicio);
CREATE INDEX IF NOT EXISTS idx_emenda_subacao ON emenda(subacao_codigo);
`;

export type NewEmpenho = Omit<EmpenhoRow, "id" | "hash" | "coletado_em">;
export type NewEmenda = EmendaRow;
export type NewHarvestLog = Omit<HarvestLogRow, "id" | "quando">;

export type OrfaoRow = {
  cd_nm_subacao: string | null;
  exercicio: number;
  total: number;
};

export type NewAutoriaOficial = {
  numero_emenda: string;
  exercicio_apresentacao: number;
  exercicio_loa: number;
  autor_nome: string;
  autor_normalizado: string;
  autor_tipo: AutorTipo;
  ploa: string;
};

export type DiscordanciaAutoria = {
  numero_emenda: string;
  exercicio_emenda: number;
  autor_texto: string;
  autor_oficial: string;
};

export type Db = {
  readonly raw: Database;
  insertEmpenho(row: NewEmpenho): { inserted: boolean; hash: string };
  upsertEmenda(row: NewEmenda): void;
  logHarvest(entry: NewHarvestLog): void;
  countEmpenhos(): number;
  listEmpenhos(): EmpenhoRow[];
  listAutores(): Array<{ autor_normalizado: string; total_emendas: number }>;
  emendasPorAutor(nome: string): EmendaRow[];
  empenhosPorMunicipio(municipio: string): EmpenhoRow[];
  empenhosPorExercicio(exercicio: number): EmpenhoRow[];
  orfaos(): OrfaoRow[];
  harvestLogTail(limit?: number): HarvestLogRow[];
  upsertAutoriaOficial(row: NewAutoriaOficial): void;
  countAutoriaOficial(): number;
  /** Eleva emendas não-alta usando o dicionário oficial da ALEPE; retorna quantas subiram e as discordâncias com autoria já alta. */
  aplicarAutoriaOficial(): { elevadas: number; discordancias: DiscordanciaAutoria[] };
  close(): void;
};

function hashEmpenho(row: NewEmpenho): string {
  const key = `${row.exercicio}|${row.numero_empenho}|${row.obs ?? ""}|${row.vlrempenhado ?? ""}`;
  return Bun.hash(key).toString(16);
}

export function openDb(path = "data/emendas.sqlite"): Db {
  // bun:sqlite não cria o diretório pai automaticamente (ao contrário de Bun.write).
  mkdirSync(dirname(path), { recursive: true });
  const raw = new Database(path, { create: true, strict: true });
  raw.run("PRAGMA journal_mode = WAL;");
  raw.run("PRAGMA foreign_keys = ON;");
  raw.exec(SCHEMA);

  const stmts = {
    insertEmpenho: raw.query(`
      INSERT OR IGNORE INTO empenho
        (exercicio, numero_empenho, unidade_gestora, credor, obs, cd_nm_subacao, cd_nm_funcao,
         vlrempenhado, vlrliquidado, vlrtotalpago, fonte, hash, coletado_em)
      VALUES ($exercicio, $numero_empenho, $unidade_gestora, $credor, $obs, $cd_nm_subacao, $cd_nm_funcao,
              $vlrempenhado, $vlrliquidado, $vlrtotalpago, $fonte, $hash, $coletado_em)
    `),
    // A cláusula WHERE evita que uma reexecução de "normalizar" (regex sobre
    // obs) rebaixe um registro que já veio com confiança melhor — em especial
    // autoria nativa do Pentaho (confianca "alta" sem mineração de texto),
    // que não deve ser sobrescrita por um "nula"/"media" de uma nova rodada.
    upsertEmenda: raw.query(`
      INSERT INTO emenda
        (numero_emenda, exercicio_emenda, subacao_codigo, autor_bruto, autor_normalizado, autor_tipo,
         municipio, beneficiario_cnpj, beneficiario_nome, confianca)
      VALUES ($numero_emenda, $exercicio_emenda, $subacao_codigo, $autor_bruto, $autor_normalizado, $autor_tipo,
              $municipio, $beneficiario_cnpj, $beneficiario_nome, $confianca)
      ON CONFLICT (numero_emenda, exercicio_emenda) DO UPDATE SET
        subacao_codigo = excluded.subacao_codigo,
        autor_bruto = excluded.autor_bruto,
        autor_normalizado = excluded.autor_normalizado,
        autor_tipo = excluded.autor_tipo,
        municipio = excluded.municipio,
        beneficiario_cnpj = excluded.beneficiario_cnpj,
        beneficiario_nome = excluded.beneficiario_nome,
        confianca = excluded.confianca
      WHERE (CASE emenda.confianca WHEN 'alta' THEN 2 WHEN 'media' THEN 1 ELSE 0 END)
          <= (CASE excluded.confianca WHEN 'alta' THEN 2 WHEN 'media' THEN 1 ELSE 0 END)
    `),
    logHarvest: raw.query(`
      INSERT INTO harvest_log (alvo, exercicio, status, tentativas, http_status, duracao_ms, mensagem, quando)
      VALUES ($alvo, $exercicio, $status, $tentativas, $http_status, $duracao_ms, $mensagem, $quando)
    `),
    countEmpenhos: raw.query(`SELECT COUNT(*) as total FROM empenho`),
    listEmpenhos: raw.query(`SELECT * FROM empenho ORDER BY id`),
    listAutores: raw.query(`
      SELECT autor_normalizado, COUNT(*) as total_emendas
      FROM emenda
      WHERE autor_normalizado IS NOT NULL
      GROUP BY autor_normalizado
      ORDER BY total_emendas DESC
    `),
    emendasPorAutor: raw.query(`
      SELECT * FROM emenda WHERE autor_normalizado = $nome ORDER BY exercicio_emenda DESC
    `),
    empenhosPorMunicipio: raw.query(`
      SELECT em.* FROM empenho em
      JOIN emenda e ON e.subacao_codigo = substr(em.cd_nm_subacao, 1, 4)
      WHERE e.municipio = $municipio
      ORDER BY em.exercicio DESC
    `),
    empenhosPorExercicio: raw.query(`SELECT * FROM empenho WHERE exercicio = $exercicio ORDER BY id`),
    orfaos: raw.query(`
      SELECT em.cd_nm_subacao, em.exercicio, COUNT(*) as total
      FROM empenho em
      WHERE NOT EXISTS (
        SELECT 1 FROM emenda e WHERE e.subacao_codigo = substr(em.cd_nm_subacao, 1, 4)
      )
      GROUP BY em.cd_nm_subacao, em.exercicio
      ORDER BY total DESC
    `),
    harvestLogTail: raw.query(`SELECT * FROM harvest_log ORDER BY id DESC LIMIT $limit`),
  } satisfies Record<string, Statement>;

  return {
    raw,

    insertEmpenho(row) {
      const hash = hashEmpenho(row);
      const result = stmts.insertEmpenho.run({
        exercicio: row.exercicio,
        numero_empenho: row.numero_empenho,
        unidade_gestora: row.unidade_gestora,
        credor: row.credor,
        obs: row.obs,
        cd_nm_subacao: row.cd_nm_subacao,
        cd_nm_funcao: row.cd_nm_funcao,
        vlrempenhado: row.vlrempenhado,
        vlrliquidado: row.vlrliquidado,
        vlrtotalpago: row.vlrtotalpago,
        fonte: row.fonte,
        hash: hash,
        coletado_em: new Date().toISOString(),
      });
      return { inserted: result.changes > 0, hash };
    },

    upsertEmenda(row) {
      stmts.upsertEmenda.run({
        numero_emenda: row.numero_emenda,
        exercicio_emenda: row.exercicio_emenda,
        subacao_codigo: row.subacao_codigo,
        autor_bruto: row.autor_bruto,
        autor_normalizado: row.autor_normalizado,
        autor_tipo: row.autor_tipo,
        municipio: row.municipio,
        beneficiario_cnpj: row.beneficiario_cnpj,
        beneficiario_nome: row.beneficiario_nome,
        confianca: row.confianca,
      });
    },

    logHarvest(entry) {
      stmts.logHarvest.run({
        alvo: entry.alvo,
        exercicio: entry.exercicio,
        status: entry.status,
        tentativas: entry.tentativas,
        http_status: entry.http_status,
        duracao_ms: entry.duracao_ms,
        mensagem: entry.mensagem,
        quando: new Date().toISOString(),
      });
    },

    countEmpenhos() {
      const row = stmts.countEmpenhos.get() as { total: number } | null;
      return row?.total ?? 0;
    },

    listEmpenhos() {
      return stmts.listEmpenhos.all() as EmpenhoRow[];
    },

    listAutores() {
      return stmts.listAutores.all() as Array<{ autor_normalizado: string; total_emendas: number }>;
    },

    emendasPorAutor(nome) {
      return stmts.emendasPorAutor.all({ nome: nome }) as EmendaRow[];
    },

    empenhosPorMunicipio(municipio) {
      return stmts.empenhosPorMunicipio.all({ municipio: municipio }) as EmpenhoRow[];
    },

    empenhosPorExercicio(exercicio) {
      return stmts.empenhosPorExercicio.all({ exercicio: exercicio }) as EmpenhoRow[];
    },

    orfaos() {
      return stmts.orfaos.all() as OrfaoRow[];
    },

    harvestLogTail(limit = 50) {
      return stmts.harvestLogTail.all({ limit: limit }) as HarvestLogRow[];
    },

    upsertAutoriaOficial(row) {
      raw
        .query(`
          INSERT INTO autoria_oficial
            (numero_emenda, exercicio_apresentacao, exercicio_loa, autor_nome, autor_normalizado, autor_tipo, ploa, coletado_em)
          VALUES ($numero_emenda, $exercicio_apresentacao, $exercicio_loa, $autor_nome, $autor_normalizado, $autor_tipo, $ploa, $coletado_em)
          ON CONFLICT (numero_emenda, exercicio_apresentacao) DO UPDATE SET
            exercicio_loa = excluded.exercicio_loa,
            autor_nome = excluded.autor_nome,
            autor_normalizado = excluded.autor_normalizado,
            autor_tipo = excluded.autor_tipo,
            ploa = excluded.ploa,
            coletado_em = excluded.coletado_em
        `)
        .run({ ...row, coletado_em: new Date().toISOString() });
    },

    countAutoriaOficial() {
      const r = raw.query("SELECT COUNT(*) as c FROM autoria_oficial").get() as { c: number } | null;
      return r?.c ?? 0;
    },

    aplicarAutoriaOficial() {
      // Auditoria ANTES de aplicar: onde o texto do empenho já deu autor
      // (alta) e a ALEPE discorda — sinal de bug de extração ou de numeração
      // ambígua; nunca sobrescrevemos silenciosamente.
      const discordancias = raw
        .query(`
          SELECT e.numero_emenda, e.exercicio_emenda, e.autor_normalizado as autor_texto, a.autor_normalizado as autor_oficial
          FROM emenda e
          JOIN autoria_oficial a ON a.numero_emenda = e.numero_emenda
            AND (a.exercicio_loa = e.exercicio_emenda OR a.exercicio_apresentacao = e.exercicio_emenda)
          WHERE e.confianca = 'alta' AND e.autor_normalizado IS NOT NULL
            AND e.autor_normalizado != a.autor_normalizado
        `)
        .all() as DiscordanciaAutoria[];

      // Dois passes determinísticos: primeiro casa pelo exercício da LOA
      // (como os empenhos costumam citar), depois pelo ano de apresentação
      // (como a ALEPE numera) para o que sobrou.
      let elevadas = 0;
      for (const campo of ["exercicio_loa", "exercicio_apresentacao"] as const) {
        const r = raw
          .query(`
            UPDATE emenda SET
              autor_bruto = a.autor_nome,
              autor_normalizado = a.autor_normalizado,
              autor_tipo = a.autor_tipo,
              confianca = 'alta'
            FROM autoria_oficial a
            WHERE a.numero_emenda = emenda.numero_emenda
              AND a.${campo} = emenda.exercicio_emenda
              AND emenda.confianca != 'alta'
          `)
          .run();
        elevadas += r.changes;
      }
      return { elevadas, discordancias };
    },

    close() {
      raw.close();
    },
  };
}

export type { AutorTipo, Confianca, HarvestSource, HarvestStatus };
