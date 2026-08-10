// Handler scheduled() do cron OS-level (§5.7), instalado via `bun run cron:install`.
//
// Originalmente uma missão de "insistir até validar" (Socorro Pimentel como
// critério, ver NOTAS.md itens 13–15) — a validação já teve sucesso numa
// sessão anterior. Agora funciona como rede de segurança contínua: a cada
// disparo, descobre+coleta os DOIS painéis Pentaho (principal + histórico,
// ver NOTAS.md item 18) e registra a situação em data/PENTAHO_STATUS.md, sem
// se autoremover — os painéis publicam dado novo com o tempo (novos
// empenhos, o ano corrente avançando), então vale manter sincronizado.

import { appendFileSync } from "node:fs";

// O cron do sistema executa com cwd=$HOME — sem isto, TODOS os caminhos
// relativos (config.yaml, data/...) quebram e a rodada morre no primeiro
// passo. Bug real: o disparo de 09/08/2026 20:00 falhou exatamente assim,
// deixando ~/data/PENTAHO_STATUS.md como rastro (ver NOTAS.md item 22).
process.chdir(import.meta.dir);

import { loadConfig } from "./src/config.ts";
import type { Db } from "./src/db.ts";
import { openDb } from "./src/db.ts";
import { discover } from "./src/discover.ts";
import { harvestAlepe } from "./src/harvest-alepe.ts";
import { harvestCkan } from "./src/harvest-ckan.ts";
import { harvestPentaho } from "./src/harvest-pentaho.ts";

const AUTOR_VALIDACAO = "SOCORRO PIMENTEL";
const STATUS_PATH = "data/PENTAHO_STATUS.md";
// Log append-only, uma linha por disparo do cron: o que funcionou e o que
// não, legível com `tail data/cron.log`. Pedido explícito do usuário.
const CRON_LOG_PATH = "data/cron.log";

const PAINEIS = [
  { alvo: "principal", endpointsPath: "data/endpoints.json", panelUrlKey: "panelUrl" as const },
  { alvo: "historico", endpointsPath: "data/endpoints-historico.json", panelUrlKey: "panelUrlHistorico" as const },
];

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
      logRodada(`FALHOU | erro inesperado: ${errorMessage(err)}`);
      await escreverStatus({ resultadosPorPainel: [], validacao: { sucesso: false, detalhe: `erro inesperado: ${errorMessage(err)}` } });
    }
  },
};

async function rodar(): Promise<void> {
  const config = await loadConfig();
  const db = openDb();

  try {
    const resultadosPorPainel: Array<{ alvo: string; totalLinhas: number; comAutorNativo: number; inserted: number }> = [];

    for (const painel of PAINEIS) {
      const panelUrl = config.pentaho[painel.panelUrlKey];
      const report = await discover(config, { panelUrl, endpointsPath: painel.endpointsPath, label: `descobrir:painel-${painel.alvo}` });

      if (!report.ok) {
        console.error(`[worker] descobrir (${painel.alvo}) — falhou (${report.reason}): ${report.message}`);
        resultadosPorPainel.push({ alvo: painel.alvo, totalLinhas: 0, comAutorNativo: 0, inserted: 0 });
        continue;
      }
      console.error(`[worker] descobrir (${painel.alvo}) — ok, ${report.result.callCount} chamada(s) CDA capturada(s)`);

      const resultados = await harvestPentaho(db, config, { endpointsPath: painel.endpointsPath });
      const totalAutorNativo = resultados.reduce((soma, r) => soma + r.comAutorNativo, 0);
      const totalLinhas = resultados.reduce((soma, r) => soma + r.total, 0);
      const totalInserted = resultados.reduce((soma, r) => soma + r.inserted, 0);
      console.error(
        `[worker] coletar (${painel.alvo}) — ${resultados.length} chamada(s), ${totalLinhas} linha(s), ${totalInserted} nova(s), ${totalAutorNativo} com autor nativo`,
      );
      resultadosPorPainel.push({ alvo: painel.alvo, totalLinhas, comAutorNativo: totalAutorNativo, inserted: totalInserted });
    }

    // CKAN — fonte histórica estável; principal utilidade no cron: detectar
    // quando o arquivo de 2026 (hoje publicado com 0 bytes) ganhar conteúdo.
    let ckanStatus: string;
    try {
      const ckan = await harvestCkan(db, config);
      const okAnos = ckan.filter((r) => r.status === "ok").length;
      const novas = ckan.reduce((s, r) => s + r.inserted, 0);
      ckanStatus = `ckan: OK ${okAnos}/${ckan.length} exercício(s), ${novas} nova(s)`;
      console.error(`[worker] ${ckanStatus}`);
    } catch (err) {
      ckanStatus = `ckan: FALHOU (${errorMessage(err)})`;
      console.error("[worker] ckan — erro inesperado (segue no próximo tick):", err);
    }

    // Autoria oficial da ALEPE — a API deles cai com frequência; cada
    // disparo do cron tenta de novo até o dicionário estar completo.
    let alepeStatus: string | null = null;
    try {
      const alepe = await harvestAlepe(db, config);
      const okPloas = alepe.ploas.filter((p) => p.status === "ok").length;
      console.error(
        `[worker] alepe — ${okPloas}/${alepe.ploas.length} PLOA(s), dicionário=${alepe.totalAutoriaOficial}, elevadas=${alepe.elevadas}, discordâncias=${alepe.discordancias}`,
      );
      alepeStatus =
        okPloas > 0
          ? `alepe: OK ${okPloas}/${alepe.ploas.length} PLOA(s), dicionário=${alepe.totalAutoriaOficial}, elevadas=${alepe.elevadas}`
          : `alepe: FALHOU (0/${alepe.ploas.length} PLOA(s) — API/banco fora?)`;
    } catch (err) {
      console.error("[worker] alepe — erro inesperado (segue no próximo tick):", err);
      alepeStatus = `alepe: FALHOU (${errorMessage(err)})`;
    }

    const validacao = validarSucesso(db);
    console.error(`[worker] validação (${AUTOR_VALIDACAO}): ${validacao.sucesso ? "SUCESSO" : "ainda não"} — ${validacao.detalhe}`);
    await escreverStatus({ resultadosPorPainel, validacao });

    const paineisResumo = resultadosPorPainel
      .map((r) => `${r.alvo}: ${r.totalLinhas > 0 ? `OK ${r.totalLinhas} linha(s), ${r.inserted} nova(s)` : "FALHOU"}`)
      .join(" | ");
    const alepeResumo = alepeStatus ?? "alepe: não rodou";
    const tudoOk =
      resultadosPorPainel.every((r) => r.totalLinhas > 0) && ckanStatus.includes("OK") && (alepeStatus?.includes("OK") ?? false);
    logRodada(`${tudoOk ? "OK" : "PARCIAL"} | ${paineisResumo} | ${ckanStatus} | ${alepeResumo} | validação: ${validacao.sucesso ? "ok" : "pendente"}`);
  } finally {
    db.close();
  }
}

/**
 * Sucesso = pelo menos uma emenda de `AUTOR_VALIDACAO` está associada a um
 * empenho com `fonte = 'pentaho'` — prova concreta de que os painéis estão
 * respondendo com dados de verdade, não só HTTP 200.
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

async function escreverStatus(v: {
  resultadosPorPainel: Array<{ alvo: string; totalLinhas: number; comAutorNativo: number; inserted: number }>;
  validacao: { sucesso: boolean; detalhe: string };
}): Promise<void> {
  const linhasPainel = v.resultadosPorPainel
    .map((r) => `- **${r.alvo}:** ${r.totalLinhas} linha(s), ${r.inserted} nova(s), ${r.comAutorNativo} com autor nativo`)
    .join("\n");

  const md = `# Status — sincronização dos painéis Pentaho

**Última verificação:** ${new Date().toISOString()}
**Validação (${AUTOR_VALIDACAO}):** ${v.validacao.sucesso ? "✅ confirmada via Pentaho" : "⏳ ainda não"} — ${v.validacao.detalhe}

${linhasPainel || "_nenhum painel processado nesta rodada._"}

Rode \`crontab -l\` para conferir se o cron ainda está agendado, ou \`bun run relatorio\` para ver o estado atual da cobertura.
`;
  await Bun.write(STATUS_PATH, md);
}

function logRodada(linha: string): void {
  try {
    appendFileSync(CRON_LOG_PATH, `${new Date().toISOString()} | ${linha}\n`);
  } catch (err) {
    console.error("[worker] falha ao escrever cron.log:", err);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
