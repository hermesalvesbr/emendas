// §5.9 — parse de argv com util.parseArgs (nativo).

import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { openDb } from "./db.ts";
import { discover } from "./discover.ts";
import { harvestCkan } from "./harvest-ckan.ts";
import { harvestPentaho } from "./harvest-pentaho.ts";
import { consolidarLote, gerarCoberturaMarkdown } from "./normalize.ts";
import { serve } from "./serve.ts";
import { vigiar } from "./watch.ts";

const COMMANDS = [
  "descobrir",
  "vigiar",
  "coletar",
  "coletar:ckan",
  "normalizar",
  "relatorio",
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
    case "normalizar":
      await cmdNormalizar();
      break;
    case "relatorio":
      await cmdRelatorio();
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

async function cmdDescobrir(): Promise<void> {
  const config = await loadConfig();
  const db = openDb();
  try {
    const report = await discover(config);

    if (report.ok) {
      db.logHarvest({
        alvo: "descobrir:painel",
        exercicio: null,
        status: "ok",
        tentativas: report.attempts,
        http_status: 200,
        duracao_ms: Math.round(report.elapsedMs),
        mensagem: `${report.result.callCount} chamadas CDA capturadas`,
      });
      console.log(`descoberta ok: ${report.result.callCount} chamadas em ${report.attempts} tentativa(s)`);
      console.log(`endpoints: ${report.result.endpointsPath}`);
      console.log(`screenshot: ${report.result.screenshotPath}`);
      return;
    }

    db.logHarvest({
      alvo: "descobrir:painel",
      exercicio: null,
      status: report.reason,
      tentativas: report.attempts,
      http_status: null,
      duracao_ms: null,
      mensagem: report.message,
    });
    console.error(`descoberta falhou (${report.reason}) após ${report.attempts} tentativa(s): ${report.message}`);
    if (report.screenshotPath) console.error(`screenshot de diagnóstico: ${report.screenshotPath}`);
    process.exitCode = 1;
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
    if (await Bun.file("data/endpoints.json").exists()) {
      console.log("coletando via Pentaho (endpoints descobertos)...");
      const results = await harvestPentaho(db, config);
      const inserted = results.reduce((sum, r) => sum + r.inserted, 0);
      console.log(`pentaho: ${results.length} chamada(s), ${inserted} linha(s) nova(s)`);
    } else {
      console.log('data/endpoints.json não existe ainda (rode "bun run descobrir" primeiro) — seguindo direto para o CKAN.');
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

    const contagem = db.raw
      .query(`SELECT confianca, COUNT(*) as total FROM emenda GROUP BY confianca`)
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
  await Bun.cron("./worker.ts", "0 */6 * * *", "emendas-pe");
  console.log('cron OS-level instalado: "emendas-pe" (0 */6 * * *) executando worker.ts');
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
