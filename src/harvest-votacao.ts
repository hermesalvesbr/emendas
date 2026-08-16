// Votação nominal de 2022 por município (TSE, dados abertos).
//
// Existe para responder o que a naturalidade NÃO responde. O painel filtra
// candidato por região de NASCIMENTO, e o próprio projeto avisa que isso não
// é a região que ele representa: em PE a circunscrição é única (NOTAS 30).
// Base eleitoral é medível — naturalidade é só onde a pessoa nasceu.
//
// A junção é EXATA, por CPF, sem casar por nome:
//   candidato_2026.cpf → consulta_cand_2022.NR_CPF_CANDIDATO → SQ_CANDIDATO
//   → votacao_candidato_munzona_2022.SQ_CANDIDATO → votos por município
//
// Formatos conferidos contra o arquivo real em 16/08/2026 (a regra do
// CLAUDE.md: toda fonte aqui mente sobre o próprio formato em algum ponto):
//   - separador ";", encoding ISO-8859-1, aspas em todos os campos;
//   - votacao_candidato_munzona_2022_PE.csv tem 50 colunas e 205.656 linhas,
//     UMA POR ZONA ELEITORAL — é obrigatório somar por município;
//   - CD_MUNICIPIO é código do TSE (24279 = Gravatá), NÃO é o código do IBGE;
//     o casamento com o mapa de regiões é por NOME normalizado.

import type { Db } from "./db.ts";
import { normalizarAutor } from "./normalize.ts";
import { insist } from "./retry.ts";

const CDN = "https://cdn.tse.jus.br/estatistica/sead/odsele";

export const FONTES = {
  registro: {
    url: `${CDN}/consulta_cand/consulta_cand_2022.zip`,
    membro: "consulta_cand_2022_PE.csv",
    destino: "data/raw/tse/consulta_cand_2022.zip",
  },
  votacao: {
    url: `${CDN}/votacao_candidato_munzona/votacao_candidato_munzona_2022.zip`,
    membro: "votacao_candidato_munzona_2022_PE.csv",
    destino: "data/raw/tse/votacao_candidato_munzona_2022.zip",
  },
} as const;

// ------------------------------------------------------------------- CSV

/** Campo do TSE: sempre entre aspas, sem aspas escapadas no meio. */
export function campos(linha: string): string[] {
  return linha.split(";").map((c) => {
    const t = c.trim();
    return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
  });
}

/**
 * Lê o membro do zip em fluxo, decodificando ISO-8859-1.
 *
 * `unzip -p` extrai UM membro para stdout sem descompactar o resto — é o que
 * torna aceitável um zip nacional de 557 MB do qual só interessa PE (95 MB).
 * Mesmo padrão de harvest-federal.ts.
 */
export async function* linhasDoZip(zipPath: string, membro: string): AsyncGenerator<string> {
  const proc = Bun.spawn(["unzip", "-p", zipPath, membro], { stdout: "pipe", stderr: "pipe" });
  // O tipo de TextDecoder no @types/bun não lista os rótulos legados, mas o
  // runtime aceita "iso-8859-1" — mesmo cast pontual de harvest-federal.ts:294.
  const decoder = new TextDecoder("iso-8859-1" as unknown as undefined);
  let resto = "";

  for await (const chunk of proc.stdout) {
    const texto = resto + decoder.decode(chunk as Uint8Array, { stream: true });
    const partes = texto.split(/\r?\n/);
    resto = partes.pop() ?? "";
    for (const l of partes) if (l.length > 0) yield l;
  }
  if (resto.length > 0) yield resto;

  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`unzip -p ${membro} saiu com ${code}: ${await new Response(proc.stderr).text()}`);
  }
}

/** Índice de coluna por nome, a partir do cabeçalho real — nunca por posição fixa. */
export function indices(cabecalho: string, nomes: readonly string[]): Record<string, number> {
  const cols = campos(cabecalho);
  const out: Record<string, number> = {};
  for (const n of nomes) {
    const i = cols.indexOf(n);
    if (i < 0) throw new Error(`coluna "${n}" não existe no CSV do TSE — o layout mudou. Cabeçalho: ${cols.slice(0, 8).join(", ")}…`);
    out[n] = i;
  }
  return out;
}

// -------------------------------------------------------------- download

async function baixar(db: Db, url: string, destino: string): Promise<string> {
  if (await Bun.file(destino).exists()) return destino;

  const r = await insist(
    `tse:download ${destino.split("/").pop()}`,
    async (signal) => {
      const res = await fetch(url, { signal, headers: { "User-Agent": "emendas-pe (hermes@softagon.com.br)" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0) throw new Error("corpo vazio");
      await Bun.write(destino, buf);
      return buf.byteLength;
    },
    { maxAttempts: 4, baseMs: 3000, timeoutMs: 1_800_000 },
  );

  if (!r.ok) {
    db.logHarvest({
      alvo: `tse:${destino}`, exercicio: 2022, status: r.reason,
      tentativas: r.attempts, http_status: null, duracao_ms: null,
      mensagem: r.lastError.message.slice(0, 300),
    });
    throw r.lastError;
  }
  return destino;
}

// -------------------------------------------------------------- pipeline

export type RelatorioVotacao = {
  /** Linhas do universo COMPLETO de 2022 (todos os candidatos de PE). */
  linhasTodos2022: number;
  candidatosDe2022: number;
  candidatosComCpf: number;
  casadosEm2022: number;
  municipiosComVoto: number;
  linhasGravadas: number;
  totalVotos: number;
};

/**
 * Popula votacao_2022 para os candidatos de 2026 que também concorreram em
 * 2022. Quem não concorreu simplesmente não aparece — ausência aqui NÃO é
 * "teve zero voto", é "não estava na urna" (o mesmo cuidado do NOTAS 29).
 */
export async function harvestVotacao(db: Db, opts?: { zipRegistro?: string; zipVotacao?: string }): Promise<RelatorioVotacao> {
  const zipRegistro = opts?.zipRegistro ?? (await baixar(db, FONTES.registro.url, FONTES.registro.destino));
  const zipVotacao = opts?.zipVotacao ?? (await baixar(db, FONTES.votacao.url, FONTES.votacao.destino));

  // 1. CPF dos candidatos de 2026.
  const porCpf = new Map<string, number>();
  for (const c of db.raw
    .query("SELECT id, cpf FROM candidato_2026 WHERE cpf IS NOT NULL AND cpf <> ''")
    .all() as Array<{ id: number; cpf: string }>) {
    porCpf.set(c.cpf.padStart(11, "0"), c.id);
  }

  // 2. Registro de 2022: CPF → SQ_CANDIDATO. Uma pessoa pode ter concorrido a
  //    mais de um cargo entre turnos, então guardamos todos os sq dela.
  const sqDoCandidato = new Map<string, number>();
  let cabecalhoRegistro: string | null = null;
  let idxReg: Record<string, number> = {};
  for await (const linha of linhasDoZip(zipRegistro, FONTES.registro.membro)) {
    if (cabecalhoRegistro === null) {
      cabecalhoRegistro = linha;
      idxReg = indices(linha, ["NR_CPF_CANDIDATO", "SQ_CANDIDATO"]);
      continue;
    }
    const c = campos(linha);
    const cpf = (c[idxReg.NR_CPF_CANDIDATO as number] ?? "").padStart(11, "0");
    const id = porCpf.get(cpf);
    if (id === undefined) continue;
    const sq = c[idxReg.SQ_CANDIDATO as number];
    if (sq) sqDoCandidato.set(sq, id);
  }

  // 3. Votação: soma por (sq, município, turno). O arquivo traz uma linha por
  //    ZONA ELEITORAL — sem somar, o mesmo município apareceria repetido e
  //    qualquer ranking sairia errado.
  type Acc = { cpfInvertido: number; municipio: string; cd: string; cargo: string; turno: number; votos: number };
  const acc = new Map<string, Acc>();

  // Universo COMPLETO de 2022, independente de quem voltou em 2026. É o que
  // sustenta a frase "o mais votado em X"; a tabela acima sustenta apenas
  // "o mais votado entre os que concorrem de novo".
  type AccTodos = { sq: string; nome: string; nomeCompleto: string; cargo: string; partido: string; municipio: string; votos: number };
  const todos = new Map<string, AccTodos>();
  let cabecalhoVot: string | null = null;
  let idxVot: Record<string, number> = {};

  for await (const linha of linhasDoZip(zipVotacao, FONTES.votacao.membro)) {
    if (cabecalhoVot === null) {
      cabecalhoVot = linha;
      idxVot = indices(linha, [
        "NR_TURNO", "CD_MUNICIPIO", "NM_MUNICIPIO", "DS_CARGO", "SQ_CANDIDATO", "QT_VOTOS_NOMINAIS",
        "NM_URNA_CANDIDATO", "NM_CANDIDATO", "SG_PARTIDO",
      ]);
      continue;
    }
    const c = campos(linha);
    const sq = c[idxVot.SQ_CANDIDATO as number] ?? "";
    const turnoLinha = Number(c[idxVot.NR_TURNO as number] ?? 1);
    const munLinha = normalizarAutor(c[idxVot.NM_MUNICIPIO as number] ?? "");
    const votosLinha = Number(c[idxVot.QT_VOTOS_NOMINAIS as number] ?? 0);

    if (turnoLinha === 1 && sq && munLinha && Number.isFinite(votosLinha) && votosLinha > 0) {
      const k = `${sq}|${munLinha}`;
      const cur = todos.get(k);
      if (cur) cur.votos += votosLinha;
      else {
        todos.set(k, {
          sq,
          nome: c[idxVot.NM_URNA_CANDIDATO as number] ?? "",
          nomeCompleto: c[idxVot.NM_CANDIDATO as number] ?? "",
          cargo: c[idxVot.DS_CARGO as number] ?? "",
          partido: c[idxVot.SG_PARTIDO as number] ?? "",
          municipio: munLinha,
          votos: votosLinha,
        });
      }
    }

    const idCand = sqDoCandidato.get(sq);
    if (idCand === undefined) continue;

    const turno = turnoLinha;
    const cd = c[idxVot.CD_MUNICIPIO as number] ?? "";
    const municipio = normalizarAutor(c[idxVot.NM_MUNICIPIO as number] ?? "");
    const votos = Number(c[idxVot.QT_VOTOS_NOMINAIS as number] ?? 0);
    if (!municipio || !Number.isFinite(votos)) continue;

    const chave = `${sq}|${cd}|${turno}`;
    const atual = acc.get(chave);
    if (atual) atual.votos += votos;
    else {
      acc.set(chave, {
        cpfInvertido: idCand, municipio, cd, turno, votos,
        cargo: c[idxVot.DS_CARGO as number] ?? "",
      });
    }
  }

  // 4. Grava. Espelho: a coleta é substituição, não acúmulo.
  const cpfPorId = new Map<number, string>();
  for (const [cpf, id] of porCpf) cpfPorId.set(id, cpf);

  const agora = new Date().toISOString();
  const municipios = new Set<string>();
  let totalVotos = 0;
  let linhasGravadas = 0;

  const inserirTodos = db.raw.query(`
    INSERT OR REPLACE INTO votacao_2022_municipio
      (sq_candidato, nome_urna, nome_completo, cargo, partido, municipio, votos, coletado_em)
    VALUES ($sq, $nome, $nomeCompleto, $cargo, $partido, $municipio, $votos, $coletado_em)
  `);

  const inserir = db.raw.query(`
    INSERT OR REPLACE INTO votacao_2022
      (sq_candidato, cpf, candidato_2026_id, cd_municipio, municipio, cargo, nr_turno, votos, coletado_em)
    VALUES ($sq, $cpf, $id, $cd, $municipio, $cargo, $turno, $votos, $coletado_em)
  `);

  db.raw.transaction(() => {
    db.raw.run("DELETE FROM votacao_2022_municipio");
    for (const t of todos.values()) inserirTodos.run({ ...t, coletado_em: agora });

    db.raw.run("DELETE FROM votacao_2022");
    for (const [chave, a] of acc) {
      const sq = chave.split("|")[0] as string;
      inserir.run({
        sq, cpf: cpfPorId.get(a.cpfInvertido) ?? "", id: a.cpfInvertido,
        cd: a.cd, municipio: a.municipio, cargo: a.cargo, turno: a.turno,
        votos: a.votos, coletado_em: agora,
      });
      municipios.add(a.municipio);
      totalVotos += a.votos;
      linhasGravadas++;
    }
  })();

  db.logHarvest({
    alvo: "tse:votacao-2022", exercicio: 2022, status: "ok",
    tentativas: 1, http_status: 200, duracao_ms: null,
    mensagem: `${sqDoCandidato.size} candidatos casados por CPF, ${linhasGravadas} linhas, ${totalVotos} votos`,
  });

  return {
    linhasTodos2022: todos.size,
    candidatosDe2022: new Set([...todos.values()].map((t) => t.sq)).size,
    candidatosComCpf: porCpf.size,
    casadosEm2022: new Set(sqDoCandidato.values()).size,
    municipiosComVoto: municipios.size,
    linhasGravadas,
    totalVotos,
  };
}
