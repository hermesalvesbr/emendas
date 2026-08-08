// Tipos de domínio compartilhados entre módulos.

export const HARVEST_SOURCES = ["pentaho", "ckan"] as const;
export type HarvestSource = (typeof HARVEST_SOURCES)[number];

export const HARVEST_STATUSES = ["ok", "empty", "http", "timeout", "parse"] as const;
export type HarvestStatus = (typeof HARVEST_STATUSES)[number];

export const AUTOR_TIPOS = ["individual", "coletiva", "desconhecido"] as const;
export type AutorTipo = (typeof AUTOR_TIPOS)[number];

export const CONFIANCAS = ["alta", "media", "nula"] as const;
export type Confianca = (typeof CONFIANCAS)[number];

/** Linha crua tal como publicada pelo CKAN (colunas descritas em §3.2 da spec). */
export type EmpenhoBruto = {
  numero_empenho: string;
  unidade_gestora: string;
  credor: string;
  cd_nm_funcao: string;
  cd_nm_subfuncao: string;
  cd_nm_prog: string;
  cd_nm_acao: string;
  cd_nm_subacao: string;
  ds_modalidade_empenho: string;
  ds_tp_licitacao: string;
  obs: string | null;
  ds_tp_desp: string;
  cd_ds_fonte_recurso: string;
  cd_nm_categoria: string;
  cd_nm_grupo: string;
  cd_nm_modalidade: string;
  cd_nm_elemento: string;
  cd_nm_item_vlrliquidado: string;
  vlrempenhado: number;
  vlrliquidado: number;
  vlrtotalpago: number;
};

/** Linha da tabela `empenho` (schema exato em §5.6). */
export type EmpenhoRow = {
  id: number;
  exercicio: number;
  numero_empenho: string;
  unidade_gestora: string | null;
  credor: string | null;
  obs: string | null;
  cd_nm_subacao: string | null;
  cd_nm_funcao: string | null;
  vlrempenhado: number | null;
  vlrliquidado: number | null;
  vlrtotalpago: number | null;
  fonte: HarvestSource;
  hash: string;
  coletado_em: string;
};

/** Linha da tabela `emenda` (schema exato em §5.6). */
export type EmendaRow = {
  numero_emenda: string;
  exercicio_emenda: number;
  subacao_codigo: string | null;
  autor_bruto: string | null;
  autor_normalizado: string | null;
  autor_tipo: AutorTipo | null;
  // municipio/beneficiario_* estendem o schema literal de §5.6 — ver NOTAS.md item 8.
  municipio: string | null;
  beneficiario_cnpj: string | null;
  beneficiario_nome: string | null;
  confianca: Confianca;
};

/** Linha da tabela `harvest_log` (schema exato em §5.6). */
export type HarvestLogRow = {
  id: number;
  alvo: string;
  exercicio: number | null;
  status: HarvestStatus;
  tentativas: number | null;
  http_status: number | null;
  duracao_ms: number | null;
  mensagem: string | null;
  quando: string;
};

/** Registro derivado da normalização de `obs` (§5.5), antes de gravar em `emenda`. */
export type EmendaExtraida = {
  numero_emenda: string | null;
  exercicio_emenda: number | null;
  subacao_codigo: string | null;
  autor_bruto: string | null;
  autor_normalizado: string | null;
  autor_tipo: AutorTipo;
  confianca: Confianca;
};

export type CkanResource = {
  id: string;
  url: string;
  format: string;
  name: string;
};

export type CkanPackageShowResponse = {
  success: boolean;
  result: {
    id: string;
    resources: CkanResource[];
  };
};

/**
 * Uma chamada de rede capturada durante a descoberta (§5.2). Na prática o CDA
 * usa POST com corpo `application/x-www-form-urlencoded` (não GET com
 * querystring, como a spec hipotetizava) — `path`/`dataAccessId`/parâmetros do
 * ano (`parampara_ano`) vêm de `postData`, não da URL. Ver NOTAS.md.
 */
export type DiscoveredCall = {
  requestId: string;
  url: string;
  method: string;
  status: number;
  mimeType: string;
  postData?: string;
  path?: string;
  dataAccessId?: string;
  params: Record<string, string>;
};

/** `data/endpoints.json` — o que `harvest-pentaho.ts` consome. */
export type EndpointsFile = {
  discoveredAt: string;
  panelUrl: string;
  calls: DiscoveredCall[];
};

export type Config = {
  startYear: number;
  pentaho: {
    panelUrl: string;
    settleMs: number;
    concurrency: number;
  };
  ckan: {
    packageShowUrl: string;
    datasetUuid: string;
  };
  retry: {
    maxAttempts: number;
    baseMs: number;
    capMs: number;
    timeoutMs: number;
  };
  watch: {
    cronPattern: string;
  };
  http: {
    userAgent: string;
  };
  server: {
    port: number;
  };
};
