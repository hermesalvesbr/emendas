// §5.9 — parse de argv com util.parseArgs (nativo).

import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { openDb } from "./db.ts";
import { discover } from "./discover.ts";
import { harvestCkan } from "./harvest-ckan.ts";
import { harvestAlepe } from "./harvest-alepe.ts";
import { detalharCandidatos, harvestCandidatos } from "./harvest-candidatos.ts";
import { harvestFederal } from "./harvest-federal.ts";
import { harvestPentaho } from "./harvest-pentaho.ts";
import { consolidarLote, gerarCoberturaMarkdown } from "./normalize.ts";
import { exportarSite, exportarSiteBens, exportarSiteCandidatos, exportarSiteFederal } from "./export-site.ts";
import { MUNICIPIO_REGIAO, REGIOES_PE } from "./regioes-pe.ts";
import type { EstadoThread } from "./post-x.ts";
import { diagnosticarApp, lerCredenciais, parsePostsMarkdown, pesoX, publicarThread, responderPost, verificarCredenciais } from "./post-x.ts";
import { serve } from "./serve.ts";
import { vigiar } from "./watch.ts";

const COMMANDS = [
  "descobrir",
  "vigiar",
  "coletar",
  "coletar:ckan",
  "coletar:alepe",
  "coletar:federal",
  "coletar:candidatos",
  "normalizar",
  "relatorio",
  "site",
  "servir",
  "compilar",
  "postar:x",
  "cron:install",
  "cron:remove",
] as const satisfies readonly string[];

type Command = (typeof COMMANDS)[number];

function isCommand(value: string | undefined): value is Command {
  return COMMANDS.includes(value as Command);
}

async function main(): Promise<void> {
  // As opções com valor PRECISAM ser declaradas: em strict:false e sem esta
  // config, "--apenas 3" vira {apenas: true} e o 3 cai em positionals — o
  // valor some silenciosamente. Só flags booleanas sobrevivem sem declaração.
  const { positionals, values } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    strict: false,
    options: {
      apenas: { type: "string" },
      intervalo: { type: "string" },
      responder: { type: "string" },
      texto: { type: "string" },
      confirmar: { type: "boolean" },
      diagnostico: { type: "boolean" },
      "so-detalhe": { type: "boolean" },
    },
  });
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
    case "coletar:candidatos":
      await cmdColetarCandidatos(values);
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
    case "postar:x":
      await cmdPostarX(values);
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

async function cmdColetarCandidatos(values: Record<string, unknown>): Promise<void> {
  const db = openDb();
  try {
    // --so-detalhe retoma a fase 2 sem refazer o espelho (que zeraria o
    // progresso de ~830 requests já feitos).
    if (values["so-detalhe"] !== true) {
      console.log("coletando candidaturas de PE nas Eleições 2026 (TSE/DivulgaCandContas)...");
      const r = await harvestCandidatos(db);
      console.log(`${r.total} candidatura(s) gravada(s) em ${r.coletadoEm}`);
      console.log(`  por cargo:    ${JSON.stringify(r.porCargo)}`);
      console.log(`  por situação: ${JSON.stringify(r.porSituacao)}`);
    }

    console.log("buscando detalhe de cada candidatura (bens, naturalidade, suplentes)...");
    const d = await detalharCandidatos(db);
    console.log(`detalhe: ${d.detalhados} candidato(s), ${d.suplentes} suplente(s) descoberto(s)`);
    console.log(`  com bens declarados: ${d.comBens}`);
    console.log(`  sem região (nascidos fora de PE ou sem naturalidade): ${d.semRegiao}`);
    if (d.falhas > 0) console.log(`  ATENÇÃO: ${d.falhas} falha(s) — rode com --so-detalhe para retomar`);
    return;
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

    const cand = exportarSiteCandidatos(db);
    await Bun.write("docs/dados-candidatos.json", JSON.stringify(cand));
    const reel = cand.marcadores.filter((m) => m.reeleicao).length;
    console.log(`docs/dados-candidatos.json gerado: ${cand.marcadores.length} autor(es) marcado(s) como candidato(s) em 2026`);
    console.log(`  ${reel} concorrendo ao mesmo cargo (reeleição), ${cand.marcadores.length - reel} a outro cargo`);
    const bens = exportarSiteBens(db);
    await Bun.write("docs/dados-bens.json", JSON.stringify(bens));
    const comBens = bens.linhas.filter((l) => l.bens > 0).length;
    console.log(`docs/dados-bens.json gerado: ${bens.linhas.length} candidato(s) detalhado(s), ${comBens} com patrimônio declarado`);
    if (bens.semDetalhe > 0) console.log(`  ${bens.semDetalhe} sem detalhe coletado — ficam FORA do ranking (não viram zero falso)`);

    // Mapa município -> região, usado pelo filtro regional do painel nos dois
    // sentidos: destino da emenda (sólido) e naturalidade do candidato (proxy).
    await Bun.write(
      "docs/regioes.json",
      JSON.stringify({ regioes: REGIOES_PE, municipios: Object.fromEntries(MUNICIPIO_REGIAO) }),
    );
    console.log(`docs/regioes.json gerado: ${MUNICIPIO_REGIAO.size} municípios em ${REGIOES_PE.length} regiões`);

    if (cand.ambiguos.length > 0) {
      console.log(`  ${cand.ambiguos.length} nome(s) ambíguo(s) sem marcador: ${cand.ambiguos.map((a) => a.autor).join(", ")}`);
    }
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

const POSTS_MD = "POSTS-X.md";
const ESTADO_THREAD = "data/x-thread.json";

/**
 * Publica POSTS-X.md como thread no X. Ensaio por padrão: publicar é
 * irreversível e público, então só sai do lugar com --confirmar explícito.
 * O estado em data/x-thread.json permite retomar uma thread interrompida
 * sem republicar o que já foi ao ar.
 */
async function cmdPostarX(values: Record<string, unknown>): Promise<void> {
  // Checagem do app sozinha: só precisa da Consumer Key/Secret e responde se
  // vale a pena sequer gerar o Access Token.
  if (values.diagnostico === true) {
    const key = Bun.env.X_API_KEY?.trim();
    const secret = Bun.env.X_API_SECRET?.trim();
    if (!key || !secret) {
      console.error("faltam X_API_KEY / X_API_SECRET no .env");
      process.exitCode = 1;
      return;
    }
    const d = await diagnosticarApp({ consumerKey: key, consumerSecret: secret });
    console.log(`consumer key/secret válidos: ${d.chavesValidas ? "sim" : "NÃO"}`);
    console.log(`app habilitado na API v2:    ${d.v2Liberado ? "sim" : "NÃO"}`);
    console.log(`detalhe: ${d.detalhe}`);
    if (!d.v2Liberado) {
      console.log(`\nSem o v2 liberado, publicar é impossível — e nenhum Access Token contorna isso.`);
      console.log(`Resolva o plano do app no console.x.com (Pricing -> Pay Per Use + créditos) e rode este comando de novo.`);
      process.exitCode = 1;
    }
    return;
  }

  const confirmar = values.confirmar === true;
  const intervaloMs = Number(values.intervalo ?? 6000);

  // Resposta avulsa a um post existente (errata, réplica). Fora do fluxo da
  // thread: não entra no estado, porque não é parte da série planejada.
  if (typeof values.responder === "string") {
    const texto = typeof values.texto === "string" ? values.texto : await Bun.stdin.text();
    const limpo = texto.trim();
    if (!limpo) {
      console.error("nada a publicar: passe --texto ou envie o texto por stdin");
      process.exitCode = 1;
      return;
    }
    console.log(`peso ${pesoX(limpo)}/280\n---\n${limpo}\n---`);
    if (pesoX(limpo) > 280) {
      console.error("acima de 280 de peso — encurte antes de publicar.");
      process.exitCode = 1;
      return;
    }
    const credR = lerCredenciais();
    const userR = await verificarCredenciais(credR);
    if (!confirmar) {
      console.log(`\nENSAIO — nada publicado. Responderia ao post ${values.responder} como @${userR}.`);
      console.log(`Para publicar: acrescente --confirmar`);
      return;
    }
    const id = await responderPost(credR, limpo, values.responder);
    console.log(`\nresposta publicada: https://x.com/${userR}/status/${id}`);
    return;
  }

  const posts = parsePostsMarkdown(await Bun.file(POSTS_MD).text());
  const apenas = values.apenas === undefined ? null : Number(values.apenas);
  const selecionados = apenas === null ? posts : posts.filter((p) => p.indice === apenas);
  if (selecionados.length === 0) {
    console.error(`nenhum post com índice ${apenas} em ${POSTS_MD}`);
    process.exitCode = 1;
    return;
  }

  // O limite do X é 280 em "peso": url conta 23, emoji conta 2 (ver post-x.ts).
  const excedidos = selecionados.filter((p) => pesoX(p.texto) > 280);
  for (const p of selecionados) {
    console.log(`  [${String(p.indice).padStart(2)}] ${p.titulo.padEnd(22)} peso ${pesoX(p.texto)}/280`);
  }
  if (excedidos.length > 0) {
    console.error(`\n${excedidos.length} post(s) acima de 280 de peso — corrija ${POSTS_MD} antes de publicar.`);
    process.exitCode = 1;
    return;
  }

  const estadoArquivo = Bun.file(ESTADO_THREAD);
  const estado: EstadoThread | null = (await estadoArquivo.exists()) ? ((await estadoArquivo.json()) as EstadoThread) : null;
  if (estado) {
    console.log(`\nthread já iniciada em ${estado.iniciada_em}: ${estado.publicados.length} post(s) no ar.`);
    console.log(`  primeiro: ${estado.publicados[0]?.url ?? "—"}`);
  }

  const cred = lerCredenciais();
  const usuario = await verificarCredenciais(cred);
  console.log(`\ncredenciais ok — autenticado como @${usuario}`);

  const jaNoAr = new Set(estado?.publicados.map((p) => p.indice) ?? []);
  const pendentes = selecionados.filter((p) => !jaNoAr.has(p.indice));

  if (pendentes.length === 0) {
    console.log("nada pendente: todos os posts selecionados já estão publicados.");
    return;
  }

  if (!confirmar) {
    console.log(`\nENSAIO — nada foi publicado. ${pendentes.length} post(s) seriam publicados como thread em @${usuario}.`);
    console.log(`Para publicar de verdade: bun run postar:x -- --confirmar`);
    return;
  }

  console.log(`\npublicando ${pendentes.length} post(s) em @${usuario}, ${intervaloMs}ms entre cada...`);
  const final = await publicarThread({
    cred,
    posts: selecionados,
    usuario,
    estado,
    intervaloMs,
    aoPublicar: (p, restantes) => console.log(`  [${String(p.indice).padStart(2)}] ${p.url}  (faltam ${restantes})`),
    salvarEstado: async (e) => {
      await Bun.write(ESTADO_THREAD, JSON.stringify(e, null, 2));
    },
  });

  console.log(`\nthread no ar: ${final.publicados.length} post(s).`);
  console.log(`  ${final.publicados[0]?.url ?? "—"}`);
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
