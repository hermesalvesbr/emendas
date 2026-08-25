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
import { harvestVotacao } from "./harvest-votacao.ts";
import { harvestPentaho } from "./harvest-pentaho.ts";
import { harvestPessoal } from "./harvest-pessoal.ts";
import { consolidarLote, gerarCoberturaMarkdown } from "./normalize.ts";
import { exportarMalhaPE, exportarSite, exportarSiteBens, exportarSiteCandidatos, exportarSiteFederal, exportarSiteOrigem, exportarSitePessoal, exportarSiteDeputados, exportarIndiceDeputados } from "./export-site.ts";
import { MUNICIPIO_REGIAO, REGIOES_PE } from "./regioes-pe.ts";
import { lerCredenciaisLinkedIn, publicarNoLinkedIn, textoParaLinkedIn } from "./post-linkedin.ts";
import type { TextoLinkedIn } from "./redigir-linkedin.ts";
import { MODELO_PADRAO, redigirVerificado } from "./redigir-linkedin.ts";
import type { EstadoThread } from "./post-x.ts";
import {
  apagarPost,
  diagnosticarApp,
  lerCredenciais,
  parsePostsMarkdown,
  pesoX,
  publicarAvulso,
  publicarThread,
  responderPost,
  usuarioAtual,
  verificarCredenciais,
} from "./post-x.ts";
import type { Pool } from "./gerar-posts.ts";
import { gerarPool } from "./gerar-posts.ts";
import type { Fila } from "./fila-posts.ts";
import { FUSO, HORAS_PADRAO, atrasoNoSlot, distribuir, slotAgora, slotsEntre } from "./fila-posts.ts";
import { serve } from "./serve.ts";
import { indiceDeFatos, verificarPost } from "./verificar-post.ts";
import { vigiar } from "./watch.ts";

const COMMANDS = [
  "descobrir",
  "vigiar",
  "coletar",
  "coletar:ckan",
  "coletar:alepe",
  "coletar:federal",
  "coletar:candidatos",
  "coletar:votacao",
  "coletar:pessoal",
  "normalizar",
  "relatorio",
  "site",
  "servir",
  "compilar",
  "postar:x",
  "verificar-post",
  "apagar:x",
  "postar:agenda",
  "gerar:pool",
  "agendar",
  "ensaiar:fila",
  "postar:slot",
  "gerar:linkedin",
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
      "com-link": { type: "boolean" },
      ids: { type: "string" },
      tudo: { type: "boolean" },
      data: { type: "string" },
      confirmar: { type: "boolean" },
      diagnostico: { type: "boolean" },
      "so-detalhe": { type: "boolean" },
      forcar: { type: "boolean" },
      slot: { type: "string" },
      inicio: { type: "string" },
      fim: { type: "string" },
      horas: { type: "string" },
      tolerancia: { type: "string" },
      resumo: { type: "boolean" },
      modelo: { type: "string" },
      limite: { type: "string" },
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
    case "coletar:votacao":
      await cmdColetarVotacao();
      break;
    case "coletar:pessoal":
      await cmdColetarPessoal();
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
    case "verificar-post":
      await cmdVerificarPost(values);
      break;
    case "apagar:x":
      await cmdApagarX(values);
      break;
    case "postar:agenda":
      await cmdPostarAgenda(values);
      break;
    case "gerar:pool":
      await cmdGerarPool();
      break;
    case "agendar":
      await cmdAgendar(values);
      break;
    case "ensaiar:fila":
      await cmdEnsaiarFila(values);
      break;
    case "postar:slot":
      await cmdPostarSlot(values);
      break;
    case "gerar:linkedin":
      await cmdGerarLinkedIn(values);
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

// A folha muda devagar e cada execução grava um snapshot datado — rodar isto de
// hora em hora só engorda a tabela sem acrescentar informação. Ver cmdCronInstall.
async function cmdColetarPessoal(): Promise<void> {
  const config = await loadConfig();
  const db = openDb();
  try {
    console.log("coletando lotação de pessoal da ALEPE (dados abertos + espelho legado)...");
    const r = await harvestPessoal(db, config);
    console.log(`pessoal: snapshot ${r.snapshot} — ${r.gabinetes} gabinete(s), ${r.pessoasEmGabinete} pessoa(s) lotada(s) em gabinete, ${r.totalServidores} servidor(es) no total`);
    for (const f of r.fontesFalhas) {
      console.log(`  fonte indisponível: ${f.fonte} — ${f.motivo}`);
    }
    if (r.divergencias > 0) {
      console.log(`  ${r.divergencias} divergência(s) registrada(s) em pessoal_divergencia (o legado da ALEPE está defasado — NOTAS 37)`);
      for (const d of db.divergenciasPessoal(r.snapshot).filter((x) => x.escopo === "gabinete").slice(0, 5)) {
        console.log(`    [${d.tipo}] ${d.chave}: ${d.detalhe}`);
      }
    }
    for (const g of db.listGabinetes().slice(0, 5)) {
      console.log(`  ${String(g.total).padStart(3)}  ${g.deputado_nome}${g.partido ? ` (${g.partido})` : ""}`);
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

/**
 * Votação de 2022 por município, para os candidatos de 2026 que já concorreram.
 * O zip nacional tem 557 MB e só o membro de PE é lido — ver harvest-votacao.ts.
 */
async function cmdColetarVotacao(): Promise<void> {
  const db = openDb();
  try {
    console.log("coletando votação nominal de 2022 por município (TSE)...");
    const r = await harvestVotacao(db);
    console.log(`${r.casadosEm2022} de ${r.candidatosComCpf} candidatos de 2026 também concorreram em 2022`);
    console.log(`  ${r.linhasGravadas} linhas (candidato x município x turno) em ${r.municipiosComVoto} municípios`);
    console.log(`  ${r.totalVotos.toLocaleString("pt-BR")} votos nominais somados`);
    console.log(`universo completo de 2022: ${r.candidatosDe2022} candidatos, ${r.linhasTodos2022} linhas candidato x município`);
  } finally {
    db.close();
  }
}

async function cmdColetarCandidatos(values: Record<string, unknown>): Promise<void> {
  const db = openDb();
  try {
    // --so-detalhe retoma a fase 2 sem refazer o espelho (que zeraria o
    // progresso de ~830 requests já feitos).
    // --forcar rebusca o detalhe de quem já tem detalhado=1. Necessário quando
    // o parser passa a extrair um campo novo (foi o caso do CPF, que só entrou
    // depois dos 836 já coletados) — sem isto, o campo novo ficaria nulo para
    // sempre e o espelho completo mentiria por omissão.
    if (values.forcar === true) {
      const n = db.raw.query("UPDATE candidato_2026 SET detalhado = 0").run().changes;
      console.log(`--forcar: ${n} candidato(s) marcados para rebuscar o detalhe.`);
    }

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

    // Gabinetes: só exporta se já houve coleta de pessoal, para "bun run site"
    // continuar funcionando em banco que ainda não rodou coletar:pessoal.
    if (db.ultimoSnapshotPessoal()) {
      const pessoal = exportarSitePessoal(db);
      await Bun.write("docs/dados-pessoal.json", JSON.stringify(pessoal));
      console.log(`docs/dados-pessoal.json gerado: ${pessoal.totalGabinetes} gabinete(s), ${pessoal.totalEmGabinete} pessoa(s) — snapshot ${pessoal.snapshot}`);
      if (pessoal.divergencias.length > 0) {
        console.log(`  ${pessoal.divergencias.length} divergência(s) com o portal legado da Alepe, publicadas junto`);
      }

      const deps = exportarSiteDeputados(db);
      await Bun.write("docs/dados-deputados.json", JSON.stringify(deps));
      const comVoto = deps.perfis.filter((p) => p.votacao2022).length;
      const comCand = deps.perfis.filter((p) => p.candidatura2026).length;
      await Bun.write("docs/deputados-indice.json", JSON.stringify(exportarIndiceDeputados(deps.perfis)));
      console.log(`docs/dados-deputados.json gerado: ${deps.totais.deputados} perfil(is) — ${deps.totais.comEmendas} com emendas, ${comVoto} com votação de 2022, ${comCand} com candidatura em 2026`);
    } else {
      console.log("docs/dados-pessoal.json NÃO gerado: rode `bun run coletar:pessoal` primeiro");
    }

    // Mapa município -> região, usado pelo filtro regional do painel nos dois
    // sentidos: destino da emenda (sólido) e naturalidade do candidato (proxy).
    await Bun.write(
      "docs/regioes.json",
      JSON.stringify({ regioes: REGIOES_PE, municipios: Object.fromEntries(MUNICIPIO_REGIAO) }),
    );
    console.log(`docs/regioes.json gerado: ${MUNICIPIO_REGIAO.size} municípios em ${REGIOES_PE.length} regiões`);

    // Tela de origem dos candidatos. Aba "território" do painel:
    // o index.html discrimina modo por predicado negativo, e um 6º modo cairia
    // no catch-all de eFederal() até 14 pontos serem editados à mão.
    const nBase = await exportarSiteOrigem(db);
    console.log(`docs/candidatos-origem.json gerado: ${nBase} candidato(s) com votação de 2022`);
    if (!(await Bun.file("docs/malha-pe.json").exists())) {
      const feicoes = await exportarMalhaPE();
      console.log(`docs/malha-pe.json gerado: ${feicoes} municípios (malha IBGE)`);
    }

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

/**
 * Confere um texto antes de ele virar post: peso, link no corpo e — o que
 * importa — se cada número citado existe no banco. Nasceu de três erros já
 * publicados por números escritos de memória.
 */
/**
 * Apaga a thread inteira registrada em data/x-thread.json, mais quaisquer ids
 * extras (--extras a,b). Ensaio por padrão: exclusão na X é definitiva.
 * O estado é reescrito ao final para que uma nova publicação comece limpa.
 */
async function cmdApagarX(values: Record<string, unknown>): Promise<void> {
  const arquivo = Bun.file(ESTADO_THREAD);
  const estado: EstadoThread | null = (await arquivo.exists()) ? ((await arquivo.json()) as EstadoThread) : null;
  const avulsos = typeof values.ids === "string" ? values.ids.split(",").map((x) => x.trim()).filter(Boolean) : [];

  // Apagar a thread inteira exige --tudo explícito. Antes, passar um id
  // avulso levava junto tudo que estivesse no estado: foi assim que a
  // abertura já publicada foi apagada por engano em 14/08/2026.
  if (avulsos.length > 0 && values.tudo !== true) {
    console.log(`modo avulso: ${avulsos.length} id(s). A thread em ${ESTADO_THREAD} NÃO será tocada.`);
    if (values.confirmar !== true) {
      console.log("ENSAIO — nada apagado. Acrescente --confirmar.");
      return;
    }
    const credA = lerCredenciais();
    await verificarCredenciais(credA);
    for (const id of avulsos) console.log(`  ${id}: ${(await apagarPost(credA, id)) ? "apagado" : "a X não confirmou"}`);
    return;
  }

  if (values.tudo !== true) {
    console.error("apagar:x apaga a THREAD INTEIRA. Use --tudo para confirmar a intenção, ou --ids a,b para apagar posts avulsos.");
    process.exitCode = 1;
    return;
  }

  const ids = [...(estado?.publicados.map((p) => p.id) ?? []), ...avulsos];

  if (ids.length === 0) {
    console.log("nada a apagar.");
    return;
  }

  console.log(`${ids.length} post(s) a apagar da conta @${estado?.usuario ?? "?"}:`);
  for (const p of estado?.publicados ?? []) console.log(`  [${String(p.indice).padStart(2)}] ${p.url}`);
  for (const e of avulsos) console.log(`  [avulso] ${e}`);

  if (values.confirmar !== true) {
    console.log("\nENSAIO — nada foi apagado. Exclusão na X é DEFINITIVA (não há lixeira).");
    console.log("Para apagar de verdade: acrescente --confirmar");
    return;
  }

  const cred = lerCredenciais();
  const usuario = await verificarCredenciais(cred);
  console.log(`\napagando como @${usuario}...`);

  let apagados = 0;
  const falhas: string[] = [];
  for (const id of ids) {
    try {
      if (await apagarPost(cred, id)) apagados++;
      else falhas.push(`${id}: a X não confirmou deleted`);
    } catch (err) {
      falhas.push(`${id}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
    }
    await Bun.sleep(1200);
  }

  console.log(`\n${apagados}/${ids.length} apagado(s).`);
  for (const f of falhas) console.log(`  FALHA ${f}`);

  // Zera o estado só se tudo saiu — senão a próxima publicação duplicaria o
  // que sobrou no ar.
  if (falhas.length === 0) {
    await Bun.write(ESTADO_THREAD, JSON.stringify({ usuario, iniciada_em: new Date().toISOString(), publicados: [] }, null, 2));
    console.log("estado zerado: uma nova publicação começa do post 0.");
  } else {
    console.log("estado PRESERVADO por causa das falhas — resolva antes de republicar.");
    process.exitCode = 1;
  }
}

const AGENDA = "data/agenda-posts.json";
/** Propaganda eleitoral só é permitida a partir desta data (calendário do TSE). */
const INICIO_PROPAGANDA = "2026-08-16";

/**
 * Publica o post agendado para hoje — feito para rodar sem ninguém olhando.
 *
 * Três travas, nesta ordem, porque cada uma já falhou de verdade neste
 * projeto: (1) só publica o que a agenda mandar, (2) só publica se o
 * verificador aprovar contra o BANCO no momento da postagem — o texto foi
 * escrito num dia e o dado pode ter mudado —, e (3) conteúdo de campanha só
 * a partir de 16/08. Nada é publicado duas vezes: o estado da thread manda.
 */
async function cmdPostarAgenda(values: Record<string, unknown>): Promise<void> {
  const hoje = typeof values.data === "string" ? values.data : new Date().toLocaleDateString("en-CA", { timeZone: "America/Recife" });
  const { agenda } = (await Bun.file(AGENDA).json()) as { agenda: Record<string, number> };
  const indice = agenda[hoje];

  if (indice === undefined) {
    console.log(`${hoje}: nada agendado.`);
    return;
  }

  const posts = parsePostsMarkdown(await Bun.file(POSTS_MD).text());
  const post = posts.find((p) => p.indice === indice);
  if (!post) {
    console.error(`${hoje}: post ${indice} está na agenda mas não existe em ${POSTS_MD}.`);
    process.exitCode = 1;
    return;
  }

  const estadoArquivo = Bun.file(ESTADO_THREAD);
  const estado: EstadoThread | null = (await estadoArquivo.exists()) ? ((await estadoArquivo.json()) as EstadoThread) : null;
  if (estado?.publicados.some((p) => p.indice === indice)) {
    console.log(`${hoje}: post ${indice} (${post.titulo}) já está no ar — nada a fazer.`);
    return;
  }

  const db = openDb();
  let veredito;
  try {
    veredito = verificarPost(post.texto, db.raw, {
      permitirLink: indice === 15,
      fatosExternos: [
        { valor: 12967, rotulo: "população de Casinhas (IBGE 2022)" },
        { valor: 10247, rotulo: "população de Jaqueira (IBGE 2022)" },
      ],
    });
  } finally {
    db.close();
  }

  console.log(`${hoje} · post ${indice} · ${post.titulo} · peso ${veredito.peso}/280`);

  if (!veredito.ok) {
    console.log("NÃO PUBLICADO — o verificador reprovou:");
    for (const a of veredito.achados.filter((x) => x.severidade === "erro")) console.log(`  ${a.regra}: ${a.detalhe}`);
    console.log("Os números mudaram desde que o texto foi escrito. Reescreva antes.");
    process.exitCode = 1;
    return;
  }

  if (hoje < INICIO_PROPAGANDA && indice !== 16) {
    console.log(`NÃO PUBLICADO — ${hoje} é anterior a ${INICIO_PROPAGANDA}, quando começa a propaganda eleitoral.`);
    process.exitCode = 1;
    return;
  }

  if (values.confirmar !== true) {
    console.log("ENSAIO — aprovado, mas nada publicado. Use --confirmar.");
    return;
  }

  const cred = lerCredenciais();
  const usuario = await verificarCredenciais(cred);
  const final = await publicarThread({
    cred,
    posts: [post],
    usuario,
    estado,
    intervaloMs: 0,
    aoPublicar: (p) => console.log(`PUBLICADO: ${p.url}`),
    salvarEstado: async (e) => {
      await Bun.write(ESTADO_THREAD, JSON.stringify(e, null, 2));
    },
  });
  console.log(`thread agora com ${final.publicados.length} post(s).`);
}

// ------------------------------------------------- série de 3 em 3 horas

const POOL = "data/pool-posts.json";

/**
 * Texto da 1ª resposta, por eixo: cada post aponta para a tela que de fato
 * mostra o número citado — mandar o leitor de curiosidade para o painel de
 * emendas seria prometer verificação e entregar outra página.
 */
const LINK_REPLY: Record<string, string> = {
  cidade: "Confira linha a linha, com a fonte oficial de cada registro:\nhttps://hermesalvesbr.github.io/emendas/",
  autor: "Confira linha a linha, com a fonte oficial de cada registro:\nhttps://hermesalvesbr.github.io/emendas/",
  funcao: "Confira linha a linha, com a fonte oficial de cada registro:\nhttps://hermesalvesbr.github.io/emendas/",
  curiosidade: "Naturalidade e votação de 2022, com a fonte do TSE:\nhttps://hermesalvesbr.github.io/emendas/#tab=territorio",
};
const FILA = "data/fila-posts.json";
const PUBLICADOS = "data/x-publicados.json";
const LOG_POSTS = "data/log-posts.jsonl";

/** Fim da série: véspera do 1º turno (04/10/2026). */
const FIM_SERIE = "2026-10-03";

async function lerPool(): Promise<Pool & { gerado_em: string }> {
  const f = Bun.file(POOL);
  if (!(await f.exists())) throw new Error(`${POOL} não existe — rode 'bun run gerar:pool' primeiro.`);
  return (await f.json()) as Pool & { gerado_em: string };
}

async function lerFila(): Promise<Fila> {
  const f = Bun.file(FILA);
  if (!(await f.exists())) throw new Error(`${FILA} não existe — rode 'bun run agendar' primeiro.`);
  return (await f.json()) as Fila;
}

type Publicados = {
  usuario: string;
  publicados: Array<{
    slot: string;
    post_id: string;
    hash: string;
    id: string;
    url: string;
    em: string;
    /** Ausentes nos 67 publicados antes de 25/08/2026, quando só havia o X. */
    reply_id?: string;
    linkedin_urn?: string;
  }>;
};

async function lerPublicados(): Promise<Publicados> {
  const f = Bun.file(PUBLICADOS);
  if (!(await f.exists())) return { usuario: "", publicados: [] };
  return (await f.json()) as Publicados;
}

/** Gera o pool inteiro a partir do banco e imprime o relatório de revisão. */
async function cmdGerarPool(): Promise<void> {
  const db = openDb();
  let pool: Pool;
  try {
    pool = gerarPool(db.raw);
  } finally {
    db.close();
  }

  const porTemplate = new Map<string, number>();
  for (const p of pool.posts) porTemplate.set(p.template, (porTemplate.get(p.template) ?? 0) + 1);

  console.log(`pool: ${pool.posts.length} posts aprovados, ${pool.descartes.length} descartados`);
  for (const [t, n] of [...porTemplate].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${t}`);

  if (pool.descartes.length > 0) {
    console.log("\ndescartes (revise antes de agendar):");
    for (const d of pool.descartes) console.log(`  [${d.regra}] ${d.id}: ${d.detalhe.slice(0, 160)}`);
  }

  const pesos = pool.posts.map((p) => p.peso);
  console.log(`\npeso: ${Math.min(...pesos)}–${Math.max(...pesos)}/280`);

  await Bun.write(
    POOL,
    `${JSON.stringify(
      {
        nota: "Gerado por 'bun run gerar:pool'. Não editar à mão — regere.",
        gerado_em: new Date().toISOString(),
        posts: pool.posts,
        descartes: pool.descartes,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`escrito ${POOL}`);
}

/** Casa os slots do período com os posts do pool. */
async function cmdAgendar(values: Record<string, unknown>): Promise<void> {
  const pool = await lerPool();
  const inicio = typeof values.inicio === "string" ? values.inicio : hojeLocal();
  const fim = typeof values.fim === "string" ? values.fim : FIM_SERIE;
  const horas =
    typeof values.horas === "string"
      ? values.horas.split(",").map((h) => Number(h.trim())).filter((h) => Number.isInteger(h) && h >= 0 && h < 24)
      : [...HORAS_PADRAO];

  const anterior = (await Bun.file(FILA).exists()) ? await lerFila() : null;
  const todos = slotsEntre(inicio, fim, horas);

  // O que já foi ao ar é imutável: a X não deixa editar post publicado. Um
  // reagendamento que ignorasse isso ou republicaria (barrado pelo ledger,
  // deixando o slot vazio em silêncio) ou reembaralharia o histórico e o
  // resumo diário passaria a mentir sobre o que saiu.
  const publicados = await lerPublicados();
  const idsPublicados = new Set(publicados.publicados.map((p) => p.post_id));
  const slotsPublicados = new Map(publicados.publicados.map((p) => [p.slot, p.post_id]));

  const livres = todos.filter((s) => !slotsPublicados.has(s));
  const disponiveis = pool.posts.filter((p) => !idsPublicados.has(p.id));
  const { slots: novos, faltas } = distribuir(livres, disponiveis, horas);

  // Slots já publicados voltam com o id que de fato saiu, em ordem.
  const mapa: Record<string, string> = {};
  for (const s of todos) {
    const fixado = slotsPublicados.get(s);
    if (fixado) mapa[s] = fixado;
    else if (novos[s]) mapa[s] = novos[s];
  }

  console.log(`${todos.length} slots de ${inicio} a ${fim}, horas ${horas.join(",")}`);
  if (slotsPublicados.size > 0) console.log(`${slotsPublicados.size} já publicados, preservados como saíram`);
  console.log(`preenchidos: ${Object.keys(mapa).length}`);
  // Cap silencioso é o que faz um plano parecer completo quando não é.
  for (const f of faltas) console.log(`  ATENÇÃO eixo "${f.eixo}": ${f.pedidos} slots pedidos, ${f.disponiveis} posts disponíveis`);

  const fila: Fila = {
    nota: "slot local (America/Recife) -> id do post no pool. 'fixos' sobrepõe 'slots'.",
    fuso: FUSO,
    inicio,
    fim,
    horas,
    slots: mapa,
    fixos: anterior?.fixos ?? {},
  };
  await Bun.write(FILA, `${JSON.stringify(fila, null, 2)}\n`);
  console.log(`escrito ${FILA}`);
}

function hojeLocal(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: FUSO });
}

/**
 * Verifica TODOS os slots contra o banco de agora, sem rede e sem publicar.
 * É o que responde "a fila inteira ainda é verdade?" depois de uma recoleta.
 */
async function cmdEnsaiarFila(values: Record<string, unknown>): Promise<void> {
  const pool = await lerPool();
  const fila = await lerFila();
  const porId = new Map(pool.posts.map((p) => [p.id, p]));

  const db = openDb();
  let falhas = 0;
  let conferidos = 0;
  try {
    const fatos = indiceDeFatos(db.raw);
    const entradas = Object.entries({ ...fila.slots, ...fila.fixos }).sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [slotChave, postId] of entradas) {
      const post = porId.get(postId);
      if (!post) {
        console.log(`FALHA ${slotChave}  id "${postId}" não existe no pool`);
        falhas++;
        continue;
      }
      const v = verificarPost(post.texto, db.raw, {
        fatos,
        permitirLink: false,
        tom: "afirmativo",
        rotulosEsperados: post.fatos.map((f) => f.rotulo),
        dominios: post.dominios,
      });
      conferidos++;
      if (!v.ok) {
        falhas++;
        console.log(`FALHA ${slotChave}  ${postId}`);
        for (const a of v.achados.filter((x) => x.severidade === "erro")) console.log(`         ${a.regra}: ${a.detalhe.slice(0, 160)}`);
      } else if (values.tudo === true) {
        console.log(`ok    ${slotChave}  peso ${String(post.peso).padStart(3)}  ${postId}`);
      }
    }
  } finally {
    db.close();
  }

  console.log(`\n${conferidos} slots conferidos contra o banco, ${falhas} reprovados.`);
  if (falhas > 0) process.exitCode = 1;
}

/**
 * Publica o post do slot corrente. É o entrypoint do cron de 3 em 3 horas.
 *
 * Roda sem ninguém olhando, então falha fechada: cada trava abaixo já falhou
 * de verdade neste projeto. A ordem importa — o verificador vem ANTES da
 * checagem de data porque um número errado é pior que um post atrasado.
 */
async function cmdPostarSlot(values: Record<string, unknown>): Promise<void> {
  if (values.resumo === true) return await cmdResumoDia(values);

  const fila = await lerFila();
  const agora = new Date();
  const alvo = typeof values.slot === "string" ? values.slot : slotAgora(agora, fila.horas);

  // 1. Disparo muito atrasado não republica um slot vencido horas atrás.
  const tolerancia = typeof values.tolerancia === "string" ? Number(values.tolerancia) : 90;
  if (typeof values.slot !== "string") {
    const atraso = atrasoNoSlot(agora, alvo);
    if (atraso > tolerancia) {
      console.log(`fora de slot: ${alvo} venceu há ${Math.round(atraso)} min (tolerância ${tolerancia}).`);
      return;
    }
  }

  // 2. A fila manda. Fora dela, silêncio — o job não incomoda.
  const postId = fila.fixos[alvo] ?? fila.slots[alvo];
  if (!postId) {
    console.log(`${alvo}: nada agendado.`);
    return;
  }

  const pool = await lerPool();
  const post = pool.posts.find((p) => p.id === postId);
  if (!post) {
    console.error(`${alvo}: post "${postId}" está na fila mas não existe no pool.`);
    process.exitCode = 1;
    return;
  }

  // 3. Idempotência tripla: slot, recorte e texto. Reexecução não duplica.
  const publicados = await lerPublicados();
  const repetido = publicados.publicados.find(
    (p) => p.slot === alvo || p.post_id === postId || p.hash === post.hash,
  );
  if (repetido) {
    console.log(`${alvo}: já publicado (${repetido.url}) — nada a fazer.`);
    return;
  }

  // 4. O texto foi escrito num dia; o dado pode ter mudado. Confere agora.
  const db = openDb();
  let veredito;
  try {
    veredito = verificarPost(post.texto, db.raw, {
      permitirLink: false,
      tom: "afirmativo",
      rotulosEsperados: post.fatos.map((f) => f.rotulo),
      dominios: post.dominios,
    });
  } finally {
    db.close();
  }

  if (!veredito.ok) {
    console.log(`${alvo} · ${postId} · peso ${veredito.peso}/280`);
    console.log("NÃO PUBLICADO — o verificador reprovou:");
    for (const a of veredito.achados.filter((x) => x.severidade === "erro")) console.log(`  ${a.regra}: ${a.detalhe}`);
    console.log("Os números mudaram desde que o pool foi gerado. Rode 'gerar:pool' e 'agendar'.");
    process.exitCode = 1;
    return;
  }

  // 5. Propaganda eleitoral só a partir de 16/08 (calendário do TSE).
  if (alvo.slice(0, 10) < INICIO_PROPAGANDA) {
    console.log(`NÃO PUBLICADO — ${alvo} é anterior a ${INICIO_PROPAGANDA}, quando começa a propaganda eleitoral.`);
    process.exitCode = 1;
    return;
  }

  if (values.confirmar !== true) {
    console.log(`ENSAIO ${alvo} · ${postId} · peso ${veredito.peso}/280\n`);
    console.log(post.texto);
    console.log("\naprovado, mas nada publicado. Use --confirmar.");
    return;
  }

  const cred = lerCredenciais();
  const usuario = await usuarioAtual(cred);
  const id = await publicarAvulso(cred, post.texto);
  const url = `https://x.com/${usuario}/status/${id}`;

  publicados.usuario = usuario;
  publicados.publicados.push({ slot: alvo, post_id: postId, hash: post.hash, id, url, em: new Date().toISOString() });
  await Bun.write(PUBLICADOS, `${JSON.stringify(publicados, null, 2)}\n`);

  // O link do painel vai na 1ª RESPOSTA de todo post (decisão do candidato,
  // 16/08/2026): no corpo mataria 50–90% do alcance, e sem ele "dado
  // conferível" era promessa sem endereço. Falha aqui NÃO desfaz o post — o
  // post vale sozinho; a resposta é reforço.
  let replyId: string | null = null;
  try {
    replyId = await responderPost(cred, LINK_REPLY[post.eixo] ?? (LINK_REPLY.cidade as string), id);
    const ultimo = publicados.publicados.at(-1);
    if (ultimo) (ultimo as { reply_id?: string }).reply_id = replyId;
    await Bun.write(PUBLICADOS, `${JSON.stringify(publicados, null, 2)}\n`);
  } catch (err) {
    console.log(`aviso: post publicado, mas a resposta com o link falhou: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
  }

  // O MESMO recorte vai para o LinkedIn, com o link no comentário — espelho
  // exato da decisão do X. Publicar lá é de graça (o X cobra US$ 0,215 por
  // slot, §45) e não há limite de 280, mas o texto é o mesmo de propósito:
  // dois textos para o mesmo dado seriam duas versões para o verificador
  // conferir, e é assim que nascem divergências publicadas.
  //
  // Falha no LinkedIn NÃO desfaz o post do X, pela mesma razão que a reply não
  // desfaz: o post do X vale sozinho. Só o perfil pessoal — publicar sob a
  // marca da Softagon é decisão do candidato, não default (§45.1).
  let liUrn: string | null = null;
  try {
    const credLi = lerCredenciaisLinkedIn();
    const link = LINK_REPLY[post.eixo] ?? (LINK_REPLY.cidade as string);
    // Texto redigido por modelo, se existir E ainda corresponder a este
    // recorte. O hash é a trava: dado recoletado invalida a redação antiga, e
    // o molde determinístico assume — nunca se publica texto de um número que
    // mudou. Sem redação guardada, o molde também assume: falha aberta aqui é
    // aceitável porque o molde é seguro por construção.
    const redigido = (await lerTextosLinkedIn()).textos.find(
      (t) => t.post_id === postId && t.hash === post.hash,
    );
    const textoLi = redigido?.texto ?? textoParaLinkedIn(post.texto, post.eixo, link);
    liUrn = await publicarNoLinkedIn(credLi, textoLi);
    const ultimo = publicados.publicados.at(-1);
    if (ultimo) (ultimo as { linkedin_urn?: string }).linkedin_urn = liUrn;
    await Bun.write(PUBLICADOS, `${JSON.stringify(publicados, null, 2)}\n`);
  } catch (err) {
    // Token do LinkedIn vence em 24/10/2026 e não há refresh. Quando vencer,
    // é aqui que aparece — e o X continua saindo normalmente.
    console.log(`aviso: publicado no X, mas o LinkedIn falhou: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
  }

  await appendJsonl(LOG_POSTS, {
    slot: alvo,
    post_id: postId,
    url,
    reply_id: replyId,
    linkedin_urn: liUrn,
    peso: post.peso,
    em: new Date().toISOString(),
  });

  // Sucesso é silencioso: a 8 posts/dia, avisar a cada acerto vira ruído e o
  // alerta perde valor. O que interessa está no log e no resumo das 21:30.
}

async function appendJsonl(caminho: string, linha: unknown): Promise<void> {
  const anterior = (await Bun.file(caminho).exists()) ? await Bun.file(caminho).text() : "";
  await Bun.write(caminho, `${anterior}${JSON.stringify(linha)}\n`);
}

/** Digest do dia: os 8 slots, com url ou o motivo de não ter saído. */
async function cmdResumoDia(values: Record<string, unknown>): Promise<void> {
  const fila = await lerFila();
  const dia = typeof values.data === "string" ? values.data : hojeLocal();
  const publicados = await lerPublicados();
  const porSlot = new Map(publicados.publicados.map((p) => [p.slot, p]));

  const doDia = Object.keys({ ...fila.slots, ...fila.fixos })
    .filter((s) => s.startsWith(dia))
    .sort();

  console.log(`Emendas PE — ${dia}`);
  let ok = 0;
  for (const s of doDia) {
    const p = porSlot.get(s);
    if (p) {
      ok++;
      console.log(`  ${s.slice(11)}  ${p.url}`);
    } else {
      console.log(`  ${s.slice(11)}  NÃO PUBLICADO (${fila.fixos[s] ?? fila.slots[s]})`);
    }
  }
  console.log(`\n${ok}/${doDia.length} publicados.`);
  if (ok < doDia.length) process.exitCode = 1;
}

async function cmdVerificarPost(values: Record<string, unknown>): Promise<void> {
  const texto = (typeof values.texto === "string" ? values.texto : await Bun.stdin.text()).trim();
  if (!texto) {
    console.error("nada a verificar: passe --texto ou envie por stdin");
    process.exitCode = 1;
    return;
  }

  const db = openDb();
  try {
    const v = verificarPost(texto, db.raw, { permitirLink: values["com-link"] === true });
    console.log(`peso ${v.peso}/280`);
    for (const a of v.achados) {
      const cor = a.severidade === "erro" ? "red" : a.regra === "numero-conferido" ? "green" : "yellow";
      const ansi = Bun.color(cor, "ansi") ?? "";
      console.log(`  ${ansi}[${a.severidade}]\u001b[0m ${a.regra}: ${a.detalhe}`);
    }
    console.log(v.ok ? "\npode publicar." : "\nNÃO publique: corrija os erros acima.");
    if (!v.ok) process.exitCode = 1;
  } finally {
    db.close();
  }
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

const TEXTOS_LI = "data/linkedin-posts.json";

type TextosLinkedIn = { textos: TextoLinkedIn[] };

async function lerTextosLinkedIn(): Promise<TextosLinkedIn> {
  const f = Bun.file(TEXTOS_LI);
  if (!(await f.exists())) return { textos: [] };
  return (await f.json()) as TextosLinkedIn;
}

/**
 * Redige os textos do LinkedIn para os recortes da fila — em lote, à parte,
 * NUNCA dentro do cron.
 *
 * O cron é silencioso em sucesso. Um modelo escrevendo texto lá dentro, sem
 * ninguém lendo, é como uma alegação sem lastro chega ao feed de um candidato.
 * Aqui o produto vira arquivo: revisável, versionável, e reconferido pelo
 * hash na hora de publicar.
 *
 * Cada texto passa por `verificarPost` com o limite de 280 desligado e só ele.
 * Reprovado três vezes, o recorte fica sem redação e o molde determinístico
 * assume na publicação. Falha fechada em relação ao dado, aberta em relação ao
 * canal: nunca publica número não conferido, e nunca deixa de publicar.
 */
async function cmdGerarLinkedIn(values: Record<string, unknown>): Promise<void> {
  const fila = await lerFila();
  const pool = await lerPool();
  const guardados = await lerTextosLinkedIn();
  const modelo = typeof values.modelo === "string" ? values.modelo : MODELO_PADRAO;
  const limite = typeof values.limite === "string" ? Number(values.limite) : Number.POSITIVE_INFINITY;

  const jaTem = new Set(guardados.textos.map((t) => `${t.post_id}|${t.hash}`));
  const naFila = [...new Set(Object.values(fila.slots))];
  const pendentes = naFila
    .map((id) => pool.posts.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => p !== undefined && !jaTem.has(`${p.id}|${p.hash}`));

  if (pendentes.length === 0) {
    console.log("nada a redigir: todos os recortes da fila já têm texto para o hash atual.");
    return;
  }

  const alvos = pendentes.slice(0, limite);
  console.log(`redigindo ${alvos.length} de ${pendentes.length} pendentes com "${modelo}"…\n`);

  const db = openDb();
  let ok = 0;
  let falhou = 0;
  try {
    // Índice de fatos construído UMA vez: reconstruir por post custa ~300 ms
    // cada, e aqui são centenas de chamadas (mesma razão da §36).
    const fatos = indiceDeFatos(db.raw);

    for (const [i, post] of alvos.entries()) {
      const link = LINK_REPLY[post.eixo] ?? (LINK_REPLY.cidade as string);
      const r = await redigirVerificado(post, { db: db.raw, link, fatos, modelo });

      if (r.ok) {
        guardados.textos = guardados.textos.filter((t) => t.post_id !== post.id);
        guardados.textos.push({
          post_id: post.id,
          hash: post.hash,
          texto: r.texto,
          modelo,
          tentativas: r.tentativas,
          em: new Date().toISOString(),
        });
        await Bun.write(TEXTOS_LI, `${JSON.stringify(guardados, null, 2)}\n`);
        ok++;
        console.log(`  ok    [${i + 1}/${alvos.length}] ${post.id} (${r.tentativas}x, ${r.texto.length} chars)`);
      } else {
        falhou++;
        console.log(`  FALHA [${i + 1}/${alvos.length}] ${post.id} — ${r.motivos.at(-1)?.slice(0, 160)}`);
      }
    }
  } finally {
    db.close();
  }

  console.log(`\n${ok} redigidos, ${falhou} sem texto (vão sair com o molde determinístico).`);
  console.log(`Revise ${TEXTOS_LI} antes de deixar o cron publicar.`);
}
