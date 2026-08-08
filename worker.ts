// Handler scheduled() do cron OS-level (§5.7), instalado via `bun run cron:install`.
//
// Missão específica pedida pelo usuário: insistir em
// https://api.pentaho.transparencia.pe.gov.br até a tabela principal do
// painel (`sql_tabela`) voltar a responder com dados de verdade — usando as
// emendas de Socorro Pimentel como critério concreto de sucesso, já que ela
// tem emendas confirmadas via CKAN para cruzar (ver NOTAS.md itens 13–15).
// Autoconfigura-se para parar (`Bun.cron.remove`) assim que validar.

import { loadConfig } from "./src/config.ts";
import type { Db } from "./src/db.ts";
import { openDb } from "./src/db.ts";
import { discover } from "./src/discover.ts";
import { harvestPentaho } from "./src/harvest-pentaho.ts";

const CRON_TITLE = "emendas-pe";
const AUTOR_VALIDACAO = "SOCORRO PIMENTEL";
const STATUS_PATH = "data/PENTAHO_STATUS.md";

process.on("unhandledRejection", (reason) => {
  console.error("[worker] rejeição não tratada (seguindo em frente):", reason);
});

export default {
  async scheduled(controller: Bun.CronController) {
    const quando = new Date(controller.scheduledTime).toISOString();
    console.error(`[worker] disparado por "${controller.cron}" em ${quando}`);

    try {
      await rodar();
    } catch (err) {
      console.error("[worker] erro inesperado nesta rodada (tenta de novo no próximo tick):", err);
      await escreverStatus({ sucesso: false, detalhe: `erro inesperado: ${errorMessage(err)}`, totalAutorNativo: 0 });
    }
  },
};

async function rodar(): Promise<void> {
  const config = await loadConfig();
  const db = openDb();

  try {
    const report = await discover(config);
    if (!report.ok) {
      console.error(`[worker] descobrir — falhou (${report.reason}): ${report.message}. Tenta de novo no próximo tick.`);
      await escreverStatus({ sucesso: false, detalhe: `descoberta falhou (${report.reason}): ${report.message}`, totalAutorNativo: 0 });
      return;
    }
    console.error(`[worker] descobrir — ok, ${report.result.callCount} chamada(s) CDA capturada(s)`);

    const resultados = await harvestPentaho(db, config);
    const totalAutorNativo = resultados.reduce((soma, r) => soma + r.comAutorNativo, 0);
    const totalLinhas = resultados.reduce((soma, r) => soma + r.total, 0);
    console.error(
      `[worker] coletar (pentaho) — ${resultados.length} chamada(s), ${totalLinhas} linha(s) no total, ${totalAutorNativo} com autor nativo`,
    );

    const validacao = validarSucesso(db);
    console.error(`[worker] validação (${AUTOR_VALIDACAO}): ${validacao.sucesso ? "SUCESSO" : "ainda não"} — ${validacao.detalhe}`);
    await escreverStatus({ ...validacao, totalAutorNativo });

    if (validacao.sucesso) {
      console.error(`[worker] objetivo alcançado — removendo o cron OS-level "${CRON_TITLE}"`);
      await Bun.cron.remove(CRON_TITLE);
    }
  } finally {
    db.close();
  }
}

/**
 * Sucesso = pelo menos uma emenda de `AUTOR_VALIDACAO` está associada a um
 * empenho com `fonte = 'pentaho'` (não só via CKAN, que já tínhamos desde o
 * início) — prova concreta de que a tabela principal do painel voltou a
 * responder com dados de verdade, não só HTTP 200.
 */
function validarSucesso(db: Db): { sucesso: boolean; detalhe: string } {
  const emendas = db.emendasPorAutor(AUTOR_VALIDACAO);
  if (emendas.length === 0) {
    return { sucesso: false, detalhe: `nenhuma emenda de ${AUTOR_VALIDACAO} encontrada ainda (nem via CKAN)` };
  }

  for (const emenda of emendas) {
    if (!emenda.subacao_codigo) continue;
    const contagem = db.raw
      .query("SELECT COUNT(*) as total FROM empenho WHERE substr(cd_nm_subacao, 1, 4) = ? AND fonte = 'pentaho'")
      .get(emenda.subacao_codigo) as { total: number } | null;
    if ((contagem?.total ?? 0) > 0) {
      return {
        sucesso: true,
        detalhe: `emenda ${emenda.numero_emenda}/${emenda.exercicio_emenda} (subação ${emenda.subacao_codigo}) confirmada via Pentaho`,
      };
    }
  }

  return {
    sucesso: false,
    detalhe: `${AUTOR_VALIDACAO} já tem ${emendas.length} emenda(s) via CKAN, mas nenhuma confirmada via Pentaho ainda`,
  };
}

async function escreverStatus(v: { sucesso: boolean; detalhe: string; totalAutorNativo: number }): Promise<void> {
  const md = `# Status — insistência no painel Pentaho

**Última verificação:** ${new Date().toISOString()}
**Situação:** ${v.sucesso ? `✅ SUCESSO — validado com ${AUTOR_VALIDACAO}` : "⏳ ainda insistindo"}
**Linhas com autor nativo nesta rodada:** ${v.totalAutorNativo}

${v.detalhe}

${v.sucesso ? "O cron OS-level foi removido — objetivo alcançado." : 'Rode `crontab -l` para conferir se o cron ainda está agendado, ou `bun run relatorio` para ver o estado atual da cobertura.'}
`;
  await Bun.write(STATUS_PATH, md);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
