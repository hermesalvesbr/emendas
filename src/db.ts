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

    close() {
      raw.close();
    },
  };
}

export type { AutorTipo, Confianca, HarvestSource, HarvestStatus };
