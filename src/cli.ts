// §5.9 — parse de argv com util.parseArgs (nativo).

import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { openDb } from "./db.ts";
import { discover } from "./discover.ts";
import { harvestCkan } from "./harvest-ckan.ts";
import { harvestAlepe } from "./harvest-alepe.ts";
import { harvestFederal } from "./harvest-federal.ts";
import { harvestPentaho } from "./harvest-pentaho.ts";
import { consolidarLote, gerarCoberturaMarkdown } from "./normalize.ts";
import { exportarSite, exportarSiteFederal } from "./export-site.ts";
import { serve } from "./serve.ts";
import { vigiar } from "./watch.ts";

const COMMANDS = [
  "descobrir",
  "vigiar",
  "coletar",
  "coletar:ckan",
  "coletar:alepe",
  "coletar:federal",
  "normalizar",
  "relatorio",
  "site",
  "servir",
  "compilar",
  "cron:install",
  "cron:remove",
] as const satisfies readonly string[];

type Command = (typeof COMMANDS)[number];

function isCommand(value: string | undefined): value is Command {
  return COMMANDS.includes(value as Command);
}

async function main(): Promise<void> {
  const { positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, strict: false });
  const command = positionals[0];

  if (!isCommand(command)) {
    console.error(`Uso: bun run cli.ts <comando>\nComandos: ${COMMANDS.join(", ")}`);
    process.exitCode = command === undefined ? 0 : 1;
    return;
  }

  switch (command) {
    case "descobrir":
      await cmdDescobrir();
      break;
    case "vigiar":
      await cmdVigiar();
      break;
    case "coletar":
      await cmdColetar();
      break;
    case "coletar:ckan":
      await cmdColetarCkan();
      break;
    case "coletar:alepe":
      await cmdColetarAlepe();
      break;
    case "coletar:federal":
      await cmdColetarFederal();
      break;
    case "normalizar":
      await cmdNormalizar();
      break;
    case "relatorio":
      await cmdRelatorio();
      break;
    case "site":
      await cmdSite();
      break;
    case "servir":
      await cmdServir();
      break;
    case "compilar":
      await cmdCompilar();
      break;
    case "cron:install":
      await cmdCronInstall();
      break;
    case "cron:remove":
      await cmdCronRemove();
      break;
  }
}

/**
 * Dois painéis Pentaho independentes: o principal só tem o exercício
 * corrente (ver NOTAS.md item 11), e um "Painel Histórico" separado —
 * achado em 09/08/2026 navegando o portal de transparência, não linkado a
 * partir da spec original — cobre 2023-2025 com sua própria estrutura de
 * dados (ver NOTAS.md item 18). Descobrimos e coletamos dos dois.
 */
function paineisPentaho(config: Awaited<ReturnType<typeof loadConfig>>) {
  return [
    { alvo: "principal", endpointsPath: "data/endpoints.json", panelUrl: config.pentaho.panelUrl },
    { alvo: "historico", endpointsPath: "data/endpoints-historico.json", panelUrl: config.pentaho.panelUrlHistorico },
  ] as const;
}

async function cmdDescobrir(): Promise<void> {
  const config = await loadConfig();
  const db = openDb();
  try {
    let algumaFalha = false;
    for (const painel of paineisPentaho(config)) {
      const report = await discover(config, {
        panelUrl: painel.panelUrl,
        endpointsPath: painel.endpointsPath,
        label: `descobrir:painel-${painel.alvo}`,
      });

      if (report.ok) {
        db.logHarvest({
          alvo: `descobrir:painel-${painel.alvo}`,
          exercicio: null,
          status: "ok",
          tentativas: report.attempts,
          http_status: 200,
          duracao_ms: Math.round(report.elapsedMs),
          mensagem: `${report.result.callCount} chamadas CDA capturadas`,
        });
        console.log(`descoberta (${painel.alvo}) ok: ${report.result.callCount} chamadas em ${report.attempts} tentativa(s)`);
        console.log(`  endpoints: ${report.result.endpointsPath}`);
        console.log(`  screenshot: ${report.result.screenshotPath}`);
        continue;
      }

      algumaFalha = true;
      db.logHarvest({
        alvo: `descobrir:painel-${painel.alvo}`,
        exercicio: null,
        status: report.reason,
        tentativas: report.attempts,
        http_status: null,
        duracao_ms: null,
        mensagem: report.message,
      });
      console.error(`descoberta (${painel.alvo}) falhou (${report.reason}) após ${report.attempts} tentativa(s): ${report.message}`);
      if (report.screenshotPath) console.error(`  screenshot de diagnóstico: ${report.screenshotPath}`);
    }
    if (algumaFalha) process.exitCode = 1;
  } finally {
    db.close();
  }
}

async function cmdVigiar(): Promise<void> {
  const config = await loadConfig();
  console.log(`vigiando painel Pentaho (padrão ${config.watch.cronPattern})... Ctrl+C para parar.`);
  const report = await vigiar(config);
  if (report?.ok) {
    console.log(`descoberta disparada com sucesso: ${report.result.callCount} chamadas capturadas`);
  } else if (report) {
    console.error(`descoberta disparada mas falhou: ${report.message}`);
  }
}

/**
 * Pentaho é melhor-esforço (o endpoint principal pode responder 200 sem
 * linhas — ver NOTAS.md item 11); CKAN roda sempre em seguida como base
 * garantida, o que satisfaz o critério de aceite 4 mesmo com Pentaho fora.
 */
async function cmdColetar(): Promise<void> {
  const config = await loadConfig();
  const db = openDb();
  try {
    for (const painel of paineisPentaho(config)) {
      if (!(await Bun.file(painel.endpointsPath).exists())) {
        console.log(`${painel.endpointsPath} não existe ainda (rode "bun run descobrir" primeiro) — pulando painel ${painel.alvo}.`);
        continue;
      }
      console.log(`coletando via Pentaho (${painel.alvo})...`);
      const results = await harvestPentaho(db, config, { endpointsPath: painel.endpointsPath });
      const inserted = results.reduce((sum, r) => sum + r.inserted, 0);
      const comAutorNativo = results.reduce((sum, r) => sum + r.comAutorNativo, 0);
      console.log(`  ${painel.alvo}: ${results.length} chamada(s), ${inserted} linha(s) nova(s), ${comAutorNativo} com autor nativo`);
    }

    await runCkan(db, config);
  } finally {
    db.close();
  }
}

async function cmdColetarCkan(): Promise<void> {
  const config = await loadConfig();
  const db = openDb();
  try {
    await runCkan(db, config);
  } finally {
    db.close();
  }
}

async function cmdColetarAlepe(): Promise<void> {
  const config = await loadConfig();
  const db = openDb();
  try {
    console.log("coletando autoria oficial na API da ALEPE (PLOAs de todas as legislaturas)...");
    const report = await harvestAlepe(db, config);
    const ok = report.ploas.filter((p) => p.status === "ok");
    console.log(`alepe: ${ok.length}/${report.ploas.length} PLOA(s) coletado(s), dicionário com ${report.totalAutoriaOficial} autoria(s)`);
    console.log(`  órfãs elevadas para confiança média (dicionário oficial, ciclo PARLAMENTAR, ano-LOA): ${report.elevadas}`);
    if (report.discordancias > 0) {
      console.log(`  ATENÇÃO: ${report.discordancias} discordância(s) entre texto e ALEPE — ver tabela autoria_oficial vs emenda`);
    }
    if (ok.length === 0) {
      console.log("  (a API da ALEPE costuma ficar fora do ar — o cron de 4h reexecuta sozinho até conseguir)");
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

async function cmdColetarFederal(): Promise<void> {
  const config = await loadConfig();
  const db = openDb();
  try {
    console.log("coletando emendas FEDERAIS com foco em PE (CGU/Portal da Transparência + bancada Câmara/Senado)...");
    const r = await harvestFederal(db, config);
    console.log(`bancada PE: ${r.parlamentares.deputados} deputado(s), ${r.parlamentares.senadores} senador(es)`);
    console.log(`arquivo: ${r.linhasArquivo} linha(s); recorte PE ${r.anos.join("-")}: ${r.inseridas} gravada(s)`);
    console.log(`  por categoria: ${JSON.stringify(r.porCategoria)}`);
    if (r.autoresNaoCasados.length > 0) {
      console.log(`  ATENÇÃO — ${r.autoresNaoCasados.length} autor(es) com gasto em PE não casaram com a bancada (classificados como "gasto-pe"):`);
      console.log(`    ${r.autoresNaoCasados.slice(0, 15).join(" · ")}${r.autoresNaoCasados.length > 15 ? " …" : ""}`);
    }
  } finally {
    db.close();
  }
}

async function runCkan(db: Db, config: Awaited<ReturnType<typeof loadConfig>>): Promise<void> {
  console.log("coletando via CKAN...");
  const results = await harvestCkan(db, config);
  const inserted = results.reduce((sum, r) => sum + r.inserted, 0);
  const falhas = results.filter((r) => r.status !== "ok");
  console.log(`ckan: ${results.length} exercício(s), ${inserted} linha(s) nova(s)`);
  if (falhas.length > 0) {
    console.log(`  exercícios com falha: ${falhas.map((f) => `${f.exercicio}(${f.status})`).join(", ")}`);
  }
}

async function cmdNormalizar(): Promise<void> {
  const db = openDb();
  try {
    const empenhos = db.listEmpenhos();
    console.log(`normalizando ${empenhos.length} empenho(s)...`);

    const consolidadas = consolidarLote(empenhos);
    for (const e of consolidadas) {
      if (!e.numero_emenda || e.exercicio_emenda === null) continue;
      db.upsertEmenda({
        numero_emenda: e.numero_emenda,
        exercicio_emenda: e.exercicio_emenda,
        subacao_codigo: e.subacao_codigo,
        autor_bruto: e.autor_bruto,
        autor_normalizado: e.autor_normalizado,
        autor_tipo: e.autor_tipo,
        municipio: e.municipio,
        beneficiario_cnpj: e.beneficiario_cnpj,
        beneficiario_nome: e.beneficiario_nome,
        confianca: e.confianca,
      });
    }
    console.log(`gravadas ${consolidadas.length} emenda(s) em "emenda".`);
  } finally {
    db.close();
  }
}

async function cmdRelatorio(): Promise<void> {
  const db = openDb();
  try {
    const totalEmpenhos = db.countEmpenhos();
    const autores = db.listAutores();
    const orfaos = db.orfaos();

    // Conta só o universo de execução (emendas vinculadas a algum empenho no
    // escopo do projeto, 2022→hoje). Emendas guardadas apenas como dicionário
    // de autoria (aprendidas de textos históricos ou da ALEPE, sem empenho no
    // escopo) ficam de fora para não inflar numerador nem denominador.
    const contagem = db.raw
      .query(`
        SELECT e.confianca, COUNT(*) as total FROM emenda e
        WHERE EXISTS (SELECT 1 FROM empenho em WHERE substr(em.cd_nm_subacao,1,4) = e.subacao_codigo)
        GROUP BY e.confianca
      `)
      .all() as Array<{ confianca: string; total: number }>;
    const porConfianca = Object.fromEntries(contagem.map((c) => [c.confianca, c.total]));
    const totalEmendas = contagem.reduce((sum, c) => sum + c.total, 0);

    const markdown = gerarCoberturaMarkdown(
      {
        totalEmpenhos,
        totalEmendas,
        comAutorAlta: porConfianca.alta ?? 0,
        comAutorMedia: porConfianca.media ?? 0,
        semAutor: porConfianca.nula ?? 0,
        orfaos: orfaos.map((o) => ({ subacao_codigo: o.cd_nm_subacao, exercicio: o.exercicio, total: o.total })),
      },
      new Date(),
    );

    await Bun.write("data/cobertura.md", markdown);
    console.log(`relatório gravado em data/cobertura.md (${totalEmendas} emenda(s) identificada(s), ${autores.length} autor(es) distinto(s))`);
  } finally {
    db.close();
  }
}

async function cmdSite(): Promise<void> {
  const db = openDb();
  try {
    const dados = exportarSite(db);
    await Bun.write("docs/dados.json", JSON.stringify(dados));
    console.log(`docs/dados.json gerado: ${dados.linhas.length} linha(s) (subação × exercício)`);

    const federal = exportarSiteFederal(db);
    await Bun.write("docs/dados-federal.json", JSON.stringify(federal));
    console.log(`docs/dados-federal.json gerado: ${federal.linhas.length} linha(s) federais de PE`);
  } finally {
    db.close();
  }
}

async function cmdServir(): Promise<void> {
  const config = await loadConfig();
  const server = serve(config);
  console.log(`servindo em http://localhost:${server.port}`);
}

async function cmdCompilar(): Promise<void> {
  console.log("compilando binário standalone...");
  const result = await Bun.$`bun build --compile --minify --bytecode ./src/cli.ts --outfile emendas-pe`.nothrow();
  if (result.exitCode !== 0) {
    console.error("falha ao compilar:", result.stderr.toString());
    process.exitCode = 1;
    return;
  }
  console.log("binário gerado: ./emendas-pe");
}

async function cmdCronInstall(): Promise<void> {
  // Bun.cron(path, ...) no modo OS-level escreve o caminho literal na
  // crontab, que roda com outro cwd — precisa ser absoluto ou o próprio
  // cron falha ao resolver o script depois. "./worker.ts" (como no exemplo
  // da spec) não funciona; resolvido relativo a este arquivo (src/cli.ts).
  const workerPath = new URL("../worker.ts", import.meta.url).pathname;
  await Bun.cron(workerPath, "0 */4 * * *", "emendas-pe");
  console.log(`cron OS-level instalado: "emendas-pe" (0 */4 * * *) executando ${workerPath}`);
}

async function cmdCronRemove(): Promise<void> {
  await Bun.cron.remove("emendas-pe");
  console.log('cron OS-level "emendas-pe" removido.');
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error("erro fatal:", err instanceof Error ? err.stack : err);
    process.exitCode = 1;
  });
}
