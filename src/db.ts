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
-- resultante ("650/2023" nos empenhos). Medido em 10/08/2026: a semântica
-- dominante das citações é o ano da LOA — a aplicação casa SÓ por ele.
CREATE TABLE IF NOT EXISTS autoria_oficial (
  numero_emenda TEXT NOT NULL, exercicio_apresentacao INTEGER NOT NULL, exercicio_loa INTEGER NOT NULL,
  autor_nome TEXT NOT NULL, autor_normalizado TEXT NOT NULL, autor_tipo TEXT NOT NULL,
  ploa TEXT NOT NULL, coletado_em TEXT NOT NULL,
  PRIMARY KEY (numero_emenda, exercicio_apresentacao)
);

-- === Camada FEDERAL (emendas ao orçamento da União com foco em PE) ===
-- Fonte: arquivo único de emendas da CGU/Portal da Transparência, que já traz
-- autor nominal, UF/município do gasto e valores — sem mineração de texto.
-- Independente do pipeline estadual: outra esfera, outra chave, outro painel.
CREATE TABLE IF NOT EXISTS parlamentar_federal (
  nome_normalizado TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  nome_civil TEXT,
  tipo TEXT NOT NULL CHECK (tipo IN ('deputado','senador')),
  partido TEXT,
  coletado_em TEXT NOT NULL
);

-- cat: como a linha entrou no recorte de PE (auditável, nunca inferido depois)
--   deputado / senador = autor é da bancada federal de PE
--   bancada            = emenda coletiva "Bancada de Pernambuco"
--   gasto-pe           = autor de fora, mas recurso aplicado em PE
CREATE TABLE IF NOT EXISTS emenda_federal (
  id INTEGER PRIMARY KEY,
  codigo_emenda TEXT NOT NULL,
  ano INTEGER NOT NULL,
  numero_emenda TEXT,
  tipo_emenda TEXT,
  autor TEXT NOT NULL,
  autor_normalizado TEXT NOT NULL,
  cat TEXT NOT NULL CHECK (cat IN ('deputado','senador','bancada','gasto-pe')),
  partido TEXT,
  localidade TEXT,
  municipio TEXT,
  uf TEXT,
  funcao TEXT,
  subfuncao TEXT,
  vlrempenhado REAL, vlrliquidado REAL, vlrpago REAL,
  hash TEXT NOT NULL UNIQUE,
  coletado_em TEXT NOT NULL
);

-- Candidaturas de PE em 2026 (TSE/DivulgaCandContas). Espelho do dia: a lista
-- é substituída inteira a cada coleta, porque candidatura é retirada,
-- substituída e indeferida — acumular linhas antigas viraria fantasma. O
-- marcador de reeleição NÃO vem daqui (st_REELEICAO vem vazio antes do
-- julgamento); é derivado no cruzamento. Ver NOTAS.md item 29.
CREATE TABLE IF NOT EXISTS candidato_2026 (
  id INTEGER PRIMARY KEY,
  nome_urna TEXT NOT NULL,
  nome_completo TEXT,
  nome_urna_normalizado TEXT NOT NULL,
  nome_completo_normalizado TEXT,
  numero INTEGER,
  cargo_codigo INTEGER NOT NULL,
  cargo TEXT NOT NULL,
  partido TEXT,
  situacao TEXT,
  -- Fase 2 (detalhe, um request por candidato): bens declarados, naturalidade
  -- e perfil. A coluna regiao é DERIVADA da naturalidade (município de
  -- nascimento), que NÃO é o mesmo que a região representada — NOTAS.md 30.
  total_bens REAL,
  qtd_bens INTEGER,
  municipio_nascimento TEXT,
  uf_nascimento TEXT,
  regiao TEXT,
  ocupacao TEXT,
  grau_instrucao TEXT,
  sexo TEXT,
  id_titular INTEGER,
  detalhado INTEGER NOT NULL DEFAULT 0,
  coletado_em TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cand_urna ON candidato_2026(nome_urna_normalizado);
CREATE INDEX IF NOT EXISTS idx_cand_civil ON candidato_2026(nome_completo_normalizado);

-- Votação nominal de 2022 por município, do repositório de dados abertos do
-- TSE. Existe para responder à pergunta que a naturalidade NÃO responde: onde
-- o candidato de fato tem voto. Circunscrição em PE é única, então "região que
-- representa" não existe no dado (NOTAS 30) — base eleitoral, sim.
--
-- Só entram os candidatos de 2026 que também concorreram em 2022, casados por
-- CPF. A coluna municipio já vem normalizada (maiúsculas, sem acento) para
-- casar com MUNICIPIO_REGIAO.
CREATE TABLE IF NOT EXISTS votacao_2022 (
  sq_candidato TEXT NOT NULL,
  cpf TEXT NOT NULL,
  candidato_2026_id INTEGER,
  cd_municipio TEXT NOT NULL,
  municipio TEXT NOT NULL,
  cargo TEXT,
  nr_turno INTEGER NOT NULL,
  votos INTEGER NOT NULL,
  coletado_em TEXT NOT NULL,
  PRIMARY KEY (sq_candidato, cd_municipio, nr_turno)
);

-- Votação de 2022 de TODOS os candidatos de PE, não só dos que voltam em 2026.
--
-- Existe porque "o mais votado em Araripina em 2022" não pode ser respondido
-- pela tabela acima: lá só estão os 254 que concorrem de novo, e o topo dela
-- seria "o mais votado ENTRE OS QUE VOLTARAM". Casar essa contagem com a
-- frase "o mais votado" é o mesmo erro de universo que já foi publicado.
-- Uma linha por (candidato, município), 1º turno, zonas já somadas.
CREATE TABLE IF NOT EXISTS votacao_2022_municipio (
  sq_candidato TEXT NOT NULL,
  nome_urna TEXT NOT NULL,
  nome_completo TEXT,
  cargo TEXT NOT NULL,
  partido TEXT,
  municipio TEXT NOT NULL,
  votos INTEGER NOT NULL,
  coletado_em TEXT NOT NULL,
  PRIMARY KEY (sq_candidato, municipio)
);

CREATE INDEX IF NOT EXISTS idx_vm_municipio ON votacao_2022_municipio(municipio);
CREATE INDEX IF NOT EXISTS idx_vm_cargo ON votacao_2022_municipio(cargo);

-- === Camada PESSOAL (quem trabalha no gabinete de cada deputado estadual) ===
--
-- Também é a âncora de "deputado estadual" que o projeto não tinha: até aqui o
-- parlamentar existia só como string em emenda.autor_normalizado. A tabela
-- gabinete dá nome oficial, partido e chave de junção estáveis.
--
-- A contagem sai SÓ dos dados abertos (/api/v1/servidores). O sistema legado
-- (funcionarios.php + mapaocupacaosetores.php) está defasado — medido em
-- 18/08/2026: dos 101 admitidos desde 01/06/2026, só 18 aparecem lá. Ele entra
-- como enriquecimento (matrícula, código de setor) e como divergência
-- registrada, nunca alterando quem está lotado onde. Ver NOTAS.md item 37.
CREATE TABLE IF NOT EXISTS gabinete (
  chave TEXT PRIMARY KEY,              -- rótulo de lotação normalizado, sem "GAB.DEP."
  rotulo_api TEXT NOT NULL,
  rotulo_legado TEXT,
  codigo_setor TEXT,                   -- 1110xxx, do legado; estável entre trocas de titular
  codigo_lotacao TEXT,                 -- código curto dos dados abertos (outro espaço de códigos)
  deputado_nome TEXT NOT NULL,
  deputado_normalizado TEXT NOT NULL,  -- junta com autoria_oficial.autor_normalizado
  deputado_matricula TEXT,
  deputado_nome_civil TEXT,
  partido TEXT,
  total INTEGER NOT NULL,              -- pessoas lotadas, dos dados abertos
  total_legado INTEGER,                -- o que o mapa de ocupação diz; pode divergir
  demissionarios INTEGER,
  atualizado_em TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gab_deputado ON gabinete(deputado_normalizado);

-- Foto nominal da lotação. NÃO é upsert: cada coleta grava um snapshot novo e a
-- série temporal nasce do acúmulo, porque as fontes só expõem o estado de hoje
-- (a única data histórica publicada é a de admissão).
CREATE TABLE IF NOT EXISTS servidor_alepe (
  snapshot TEXT NOT NULL,              -- YYYY-MM-DD da coleta
  chave TEXT NOT NULL,                 -- matrícula quando o legado a fornece, senão nome normalizado
  matricula TEXT,
  nome TEXT NOT NULL,
  nome_normalizado TEXT NOT NULL,
  cargo TEXT,
  cargo_codigo TEXT,
  vinculo TEXT NOT NULL,
  codigo_lotacao TEXT,
  nome_lotacao TEXT,
  gabinete_chave TEXT,                 -- NULL quando a lotação não é gabinete parlamentar
  data_admissao TEXT,
  no_legado INTEGER NOT NULL,          -- 1 = também aparece no CSV legado
  PRIMARY KEY (snapshot, chave)
);

CREATE INDEX IF NOT EXISTS idx_serv_gabinete ON servidor_alepe(snapshot, gabinete_chave);
CREATE INDEX IF NOT EXISTS idx_serv_nome ON servidor_alepe(nome_normalizado);

-- Toda diferença entre as fontes fica registrada. Nada é silenciado para o
-- número fechar — é o mesmo princípio do invariante de soma do export.
CREATE TABLE IF NOT EXISTS pessoal_divergencia (
  snapshot TEXT NOT NULL,
  escopo TEXT NOT NULL CHECK (escopo IN ('gabinete','pessoa')),
  chave TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('contagem','so-atual','so-legado','sem-titular','homonimo')),
  detalhe TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pdiv_snapshot ON pessoal_divergencia(snapshot);

CREATE INDEX IF NOT EXISTS idx_vot_cpf ON votacao_2022(cpf);
CREATE INDEX IF NOT EXISTS idx_vot_cand ON votacao_2022(candidato_2026_id);
CREATE INDEX IF NOT EXISTS idx_vot_mun ON votacao_2022(municipio);

CREATE INDEX IF NOT EXISTS idx_fed_autor ON emenda_federal(autor_normalizado);
CREATE INDEX IF NOT EXISTS idx_fed_ano ON emenda_federal(ano);
CREATE INDEX IF NOT EXISTS idx_fed_cat ON emenda_federal(cat);

CREATE INDEX IF NOT EXISTS idx_emp_subacao ON empenho(cd_nm_subacao);
CREATE INDEX IF NOT EXISTS idx_emp_exercicio ON empenho(exercicio);
CREATE INDEX IF NOT EXISTS idx_emenda_subacao ON emenda(subacao_codigo);
`;

/**
 * Colunas acrescentadas a candidato_2026 depois da primeira versão da tabela.
 * `CREATE TABLE IF NOT EXISTS` não altera tabela existente, então bancos já
 * criados precisam do ALTER — silencioso quando a coluna já existe.
 */
const COLUNAS_CANDIDATO_FASE2: ReadonlyArray<readonly [string, string]> = [
  ["total_bens", "REAL"],
  ["qtd_bens", "INTEGER"],
  ["municipio_nascimento", "TEXT"],
  ["uf_nascimento", "TEXT"],
  ["regiao", "TEXT"],
  ["ocupacao", "TEXT"],
  ["grau_instrucao", "TEXT"],
  ["sexo", "TEXT"],
  ["id_titular", "INTEGER"],
  ["detalhado", "INTEGER NOT NULL DEFAULT 0"],
  // Chave de junção com o histórico eleitoral do TSE. É dado pessoal: fica no
  // banco local (gitignorado) e NUNCA sai para docs/. O TSE publica o CPF nos
  // dois lados — no detalhe de 2026 e em consulta_cand_2022 —, e é o que
  // permite casar candidato com sua votação sem adivinhar por nome.
  ["cpf", "TEXT"],
  ["data_nascimento", "TEXT"],
];

export type NewCandidato = {
  id: number;
  nome_urna: string;
  nome_completo: string | null;
  nome_urna_normalizado: string;
  nome_completo_normalizado: string | null;
  numero: number | null;
  cargo_codigo: number;
  cargo: string;
  partido: string | null;
  situacao: string | null;
};

/** Campos que só existem depois da fase 2 (um request de detalhe por candidato). */
export type DetalheCandidato = {
  total_bens: number | null;
  qtd_bens: number | null;
  municipio_nascimento: string | null;
  uf_nascimento: string | null;
  regiao: string | null;
  ocupacao: string | null;
  grau_instrucao: string | null;
  sexo: string | null;
  cpf: string | null;
  data_nascimento: string | null;
};

export type CandidatoRow = NewCandidato &
  Partial<DetalheCandidato> & { coletado_em: string; id_titular: number | null; detalhado: number };

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

export type NewParlamentarFederal = {
  nome: string;
  nome_civil: string | null;
  tipo: "deputado" | "senador";
  partido: string | null;
  nome_normalizado: string;
};

export type CategoriaFederal = "deputado" | "senador" | "bancada" | "gasto-pe";

export type NewEmendaFederal = {
  codigo_emenda: string;
  ano: number;
  numero_emenda: string | null;
  tipo_emenda: string | null;
  autor: string;
  autor_normalizado: string;
  cat: CategoriaFederal;
  partido: string | null;
  localidade: string | null;
  municipio: string | null;
  uf: string | null;
  funcao: string | null;
  subfuncao: string | null;
  vlrempenhado: number | null;
  vlrliquidado: number | null;
  vlrpago: number | null;
};

export type EmendaFederalRow = NewEmendaFederal & { id: number; hash: string; coletado_em: string };

export type NewGabinete = {
  chave: string;
  rotulo_api: string;
  rotulo_legado: string | null;
  codigo_setor: string | null;
  codigo_lotacao: string | null;
  deputado_nome: string;
  deputado_normalizado: string;
  deputado_matricula: string | null;
  deputado_nome_civil: string | null;
  partido: string | null;
  total: number;
  total_legado: number | null;
  demissionarios: number | null;
  atualizado_em: string;
};

export type NewServidorAlepe = {
  snapshot: string;
  chave: string;
  matricula: string | null;
  nome: string;
  nome_normalizado: string;
  cargo: string | null;
  cargo_codigo: string | null;
  vinculo: string;
  codigo_lotacao: string | null;
  nome_lotacao: string | null;
  gabinete_chave: string | null;
  data_admissao: string | null;
  no_legado: number;
};

export type NewPessoalDivergencia = {
  snapshot: string;
  escopo: "gabinete" | "pessoa";
  chave: string;
  tipo: "contagem" | "so-atual" | "so-legado" | "sem-titular" | "homonimo";
  detalhe: string;
};

export type GabineteRow = NewGabinete;
export type ServidorAlepeRow = NewServidorAlepe;
export type PessoalDivergenciaRow = NewPessoalDivergencia;

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
  upsertParlamentarFederal(row: NewParlamentarFederal): void;
  listParlamentaresFederais(): Array<NewParlamentarFederal & { coletado_em: string }>;
  insertEmendaFederal(row: NewEmendaFederal): { inserted: boolean };
  listEmendasFederais(): EmendaFederalRow[];
  countEmendasFederais(): number;
  limparEmendasFederais(): number;
  substituirCandidatos(candidatos: NewCandidato[], coletadoEm: string): void;
  listCandidatos(): CandidatoRow[];
  inserirSuplentes(suplentes: Array<NewCandidato & { id_titular: number }>, coletadoEm: string): number;
  candidatosSemDetalhe(): Array<{ id: number; nome_urna: string }>;
  gravarDetalheCandidato(id: number, d: DetalheCandidato): void;
  /** Grava um snapshot de pessoal inteiro em transação — tudo ou nada. */
  gravarSnapshotPessoal(
    snapshot: string,
    gabinetes: NewGabinete[],
    servidores: NewServidorAlepe[],
    divergencias: NewPessoalDivergencia[],
  ): void;
  ultimoSnapshotPessoal(): string | null;
  listGabinetes(): GabineteRow[];
  /** Assessores de um gabinete no snapshot indicado (padrão: o mais recente). */
  assessoresDoGabinete(chave: string, snapshot?: string): ServidorAlepeRow[];
  /** Mesma coisa, mas partindo do nome normalizado do deputado (junta com autoria). */
  assessoresDoDeputado(nomeNormalizado: string, snapshot?: string): ServidorAlepeRow[];
  divergenciasPessoal(snapshot?: string): PessoalDivergenciaRow[];
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

  // Migração das colunas da fase 2 para bancos criados antes delas.
  const colunasExistentes = new Set(
    (raw.query("PRAGMA table_info(candidato_2026)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const [nome, tipo] of COLUNAS_CANDIDATO_FASE2) {
    if (!colunasExistentes.has(nome)) raw.exec(`ALTER TABLE candidato_2026 ADD COLUMN ${nome} ${tipo}`);
  }

  const ultimoSnapshotPessoal = (): string | null => {
    const r = raw.query("SELECT MAX(snapshot) as s FROM servidor_alepe").get() as { s: string | null } | null;
    return r?.s ?? null;
  };

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
      // Guardas medidas empiricamente em 10/08/2026 (ver NOTAS.md item 23):
      // (numero, ano) NÃO identifica emenda unicamente — há ciclos paralelos
      // de numeração (PLOA, LDO, derivadas/impositivas). O dicionário do PLOA
      // só concorda com o autor extraído de texto em 81% dentro do ciclo
      // "EMENDA PARLAMENTAR" (21% fora dele). Portanto: casar SÓ pelo ano da
      // LOA (semântica dominante das citações), elevar SÓ órfãs (nula), SÓ
      // quando a subação declara o ciclo PARLAMENTAR, e com confiança
      // "media" — nunca "alta", nunca sobrescrevendo texto.
      const discordancias = raw
        .query(`
          SELECT e.numero_emenda, e.exercicio_emenda, e.autor_normalizado as autor_texto, a.autor_normalizado as autor_oficial
          FROM emenda e
          JOIN autoria_oficial a ON a.numero_emenda = e.numero_emenda
            AND a.exercicio_loa = e.exercicio_emenda
          WHERE e.confianca = 'alta' AND e.autor_normalizado IS NOT NULL
            AND e.autor_normalizado != a.autor_normalizado
        `)
        .all() as DiscordanciaAutoria[];

      const r = raw
        .query(`
          UPDATE emenda SET
            autor_bruto = a.autor_nome,
            autor_normalizado = a.autor_normalizado,
            autor_tipo = a.autor_tipo,
            confianca = 'media'
          FROM autoria_oficial a
          WHERE a.numero_emenda = emenda.numero_emenda
            AND a.exercicio_loa = emenda.exercicio_emenda
            AND emenda.confianca = 'nula'
            AND EXISTS (
              SELECT 1 FROM empenho em
              WHERE substr(em.cd_nm_subacao, 1, 4) = emenda.subacao_codigo
                AND UPPER(em.cd_nm_subacao) LIKE '%EMENDA PARLAMENTAR%'
            )
        `)
        .run();
      return { elevadas: r.changes, discordancias };
    },

    upsertParlamentarFederal(row) {
      raw
        .query(`
          INSERT INTO parlamentar_federal (nome_normalizado, nome, nome_civil, tipo, partido, coletado_em)
          VALUES ($nome_normalizado, $nome, $nome_civil, $tipo, $partido, $coletado_em)
          ON CONFLICT (nome_normalizado) DO UPDATE SET
            nome = excluded.nome, nome_civil = excluded.nome_civil,
            tipo = excluded.tipo, partido = excluded.partido, coletado_em = excluded.coletado_em
        `)
        .run({ ...row, coletado_em: new Date().toISOString() });
    },

    listParlamentaresFederais() {
      return raw.query("SELECT nome, nome_civil, tipo, partido, nome_normalizado, coletado_em FROM parlamentar_federal ORDER BY tipo, nome").all() as Array<
        NewParlamentarFederal & { coletado_em: string }
      >;
    },

    insertEmendaFederal(row) {
      // Uma emenda pode ter várias linhas (uma por localidade/função) — o hash
      // cobre a granularidade real da fonte para manter a idempotência.
      const hash = Bun.hash(
        [row.codigo_emenda, row.ano, row.autor, row.localidade ?? "", row.funcao ?? "", row.vlrempenhado ?? ""].join("|"),
      ).toString(16);
      const r = raw
        .query(`
          INSERT OR IGNORE INTO emenda_federal
            (codigo_emenda, ano, numero_emenda, tipo_emenda, autor, autor_normalizado, cat, partido,
             localidade, municipio, uf, funcao, subfuncao, vlrempenhado, vlrliquidado, vlrpago, hash, coletado_em)
          VALUES ($codigo_emenda, $ano, $numero_emenda, $tipo_emenda, $autor, $autor_normalizado, $cat, $partido,
                  $localidade, $municipio, $uf, $funcao, $subfuncao, $vlrempenhado, $vlrliquidado, $vlrpago, $hash, $coletado_em)
        `)
        .run({ ...row, hash, coletado_em: new Date().toISOString() });
      return { inserted: r.changes > 0 };
    },

    listEmendasFederais() {
      return raw.query("SELECT * FROM emenda_federal ORDER BY ano, autor_normalizado").all() as EmendaFederalRow[];
    },

    countEmendasFederais() {
      const r = raw.query("SELECT COUNT(*) as c FROM emenda_federal").get() as { c: number } | null;
      return r?.c ?? 0;
    },

    limparEmendasFederais() {
      return raw.query("DELETE FROM emenda_federal").run().changes;
    },

    // Espelho do dia, em transação: se a coleta falhar no meio, o painel
    // continua com a lista anterior inteira em vez de uma lista pela metade.
    substituirCandidatos(candidatos, coletadoEm) {
      const insert = raw.query(`
        INSERT INTO candidato_2026
          (id, nome_urna, nome_completo, nome_urna_normalizado, nome_completo_normalizado,
           numero, cargo_codigo, cargo, partido, situacao, coletado_em)
        VALUES ($id, $nome_urna, $nome_completo, $nome_urna_normalizado, $nome_completo_normalizado,
                $numero, $cargo_codigo, $cargo, $partido, $situacao, $coletado_em)
      `);
      raw.transaction(() => {
        raw.query("DELETE FROM candidato_2026").run();
        for (const c of candidatos) insert.run({ ...c, coletado_em: coletadoEm });
      })();
    },

    listCandidatos() {
      return raw.query("SELECT * FROM candidato_2026 ORDER BY cargo_codigo, nome_urna").all() as CandidatoRow[];
    },

    // Suplentes chegam dentro do detalhe do titular (campo `vices`), então
    // entram depois do espelho inicial — daí ser INSERT OR IGNORE e não parte
    // de substituirCandidatos().
    inserirSuplentes(suplentes, coletadoEm) {
      const st = raw.query(`
        INSERT OR IGNORE INTO candidato_2026
          (id, nome_urna, nome_completo, nome_urna_normalizado, nome_completo_normalizado,
           numero, cargo_codigo, cargo, partido, situacao, id_titular, coletado_em)
        VALUES ($id, $nome_urna, $nome_completo, $nome_urna_normalizado, $nome_completo_normalizado,
                $numero, $cargo_codigo, $cargo, $partido, $situacao, $id_titular, $coletado_em)
      `);
      let n = 0;
      raw.transaction(() => {
        for (const s of suplentes) n += st.run({ ...s, coletado_em: coletadoEm }).changes;
      })();
      return n;
    },

    candidatosSemDetalhe() {
      return raw.query("SELECT id, nome_urna FROM candidato_2026 WHERE detalhado = 0 ORDER BY id").all() as Array<{
        id: number;
        nome_urna: string;
      }>;
    },

    gravarDetalheCandidato(id, d) {
      raw
        .query(`
          UPDATE candidato_2026 SET
            total_bens = $total_bens, qtd_bens = $qtd_bens,
            municipio_nascimento = $municipio_nascimento, uf_nascimento = $uf_nascimento,
            regiao = $regiao, ocupacao = $ocupacao, grau_instrucao = $grau_instrucao,
            sexo = $sexo, cpf = $cpf, data_nascimento = $data_nascimento, detalhado = 1
          WHERE id = $id
        `)
        .run({ ...d, id });
    },

    // Snapshot inteiro em transação: uma coleta interrompida no meio deixaria o
    // painel dizendo que um gabinete tem 3 assessores em vez de 26.
    gravarSnapshotPessoal(snapshot, gabinetes, servidores, divergencias) {
      const insGab = raw.query(`
        INSERT INTO gabinete
          (chave, rotulo_api, rotulo_legado, codigo_setor, codigo_lotacao, deputado_nome,
           deputado_normalizado, deputado_matricula, deputado_nome_civil, partido, total, total_legado,
           demissionarios, atualizado_em)
        VALUES ($chave, $rotulo_api, $rotulo_legado, $codigo_setor, $codigo_lotacao, $deputado_nome,
                $deputado_normalizado, $deputado_matricula, $deputado_nome_civil, $partido, $total, $total_legado,
                $demissionarios, $atualizado_em)
        ON CONFLICT (chave) DO UPDATE SET
          rotulo_api = excluded.rotulo_api, rotulo_legado = excluded.rotulo_legado,
          codigo_setor = excluded.codigo_setor, codigo_lotacao = excluded.codigo_lotacao,
          deputado_nome = excluded.deputado_nome, deputado_normalizado = excluded.deputado_normalizado,
          deputado_matricula = excluded.deputado_matricula, deputado_nome_civil = excluded.deputado_nome_civil,
          partido = excluded.partido,
          total = excluded.total, total_legado = excluded.total_legado,
          demissionarios = excluded.demissionarios, atualizado_em = excluded.atualizado_em
      `);
      const insServ = raw.query(`
        INSERT OR REPLACE INTO servidor_alepe
          (snapshot, chave, matricula, nome, nome_normalizado, cargo, cargo_codigo, vinculo,
           codigo_lotacao, nome_lotacao, gabinete_chave, data_admissao, no_legado)
        VALUES ($snapshot, $chave, $matricula, $nome, $nome_normalizado, $cargo, $cargo_codigo, $vinculo,
                $codigo_lotacao, $nome_lotacao, $gabinete_chave, $data_admissao, $no_legado)
      `);
      const insDiv = raw.query(`
        INSERT INTO pessoal_divergencia (snapshot, escopo, chave, tipo, detalhe)
        VALUES ($snapshot, $escopo, $chave, $tipo, $detalhe)
      `);

      raw.transaction(() => {
        // Recoletar o mesmo dia sobrescreve o dia; snapshots anteriores ficam.
        raw.query("DELETE FROM servidor_alepe WHERE snapshot = $snapshot").run({ snapshot });
        raw.query("DELETE FROM pessoal_divergencia WHERE snapshot = $snapshot").run({ snapshot });
        // Gabinete é estado atual, não série: some quem deixou de existir.
        raw.query("DELETE FROM gabinete").run();
        for (const g of gabinetes) insGab.run({ ...g });
        for (const s of servidores) insServ.run({ ...s });
        for (const d of divergencias) insDiv.run({ ...d });
      })();
    },

    ultimoSnapshotPessoal: ultimoSnapshotPessoal,

    listGabinetes() {
      return raw.query("SELECT * FROM gabinete ORDER BY total DESC, deputado_nome").all() as GabineteRow[];
    },

    assessoresDoGabinete(chave, snapshot) {
      const alvo = snapshot ?? ultimoSnapshotPessoal();
      if (!alvo) return [];
      return raw
        .query("SELECT * FROM servidor_alepe WHERE snapshot = $snapshot AND gabinete_chave = $chave ORDER BY nome")
        .all({ snapshot: alvo, chave }) as ServidorAlepeRow[];
    },

    assessoresDoDeputado(nomeNormalizado, snapshot) {
      const alvo = snapshot ?? ultimoSnapshotPessoal();
      if (!alvo) return [];
      return raw
        .query(`
          SELECT s.* FROM servidor_alepe s
          JOIN gabinete g ON g.chave = s.gabinete_chave
          WHERE s.snapshot = $snapshot AND g.deputado_normalizado = $nome
          ORDER BY s.nome
        `)
        .all({ snapshot: alvo, nome: nomeNormalizado }) as ServidorAlepeRow[];
    },

    divergenciasPessoal(snapshot) {
      const alvo = snapshot ?? ultimoSnapshotPessoal();
      if (!alvo) return [];
      return raw
        .query("SELECT * FROM pessoal_divergencia WHERE snapshot = $snapshot ORDER BY escopo, tipo, chave")
        .all({ snapshot: alvo }) as PessoalDivergenciaRow[];
    },

    close() {
      raw.close();
    },
  };
}

export type { AutorTipo, Confianca, HarvestSource, HarvestStatus };
