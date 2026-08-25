// Redação dos posts do LinkedIn — texto natural e didático, escrito por um
// modelo a partir do recorte JÁ VERIFICADO da série do X.
//
// Por que existe, se "a série não se escreve à mão": porque não é à mão. É um
// gerador, como `gerar-posts.ts` — só que o template é um prompt, e o produto
// passa pelo mesmo `verificarPost` antes de ser guardado. O que muda é a forma,
// nunca o fato.
//
// TRÊS DECISÕES QUE SUSTENTAM A SEGURANÇA DISTO:
//
// 1. **Gera na hora de montar o pool, não na hora de publicar.** O cron é
//    silencioso em sucesso; um modelo escrevendo texto lá dentro, sem ninguém
//    lendo, é exatamente como uma alegação sem lastro chega ao feed de um
//    candidato. Gerado aqui, o texto vira arquivo — revisável, versionado,
//    e reconferido por `ensaiar:fila` antes de qualquer publicação.
//
// 2. **Passa pelo verificador, com o limite de 280 desligado e só ele.** Todo
//    número continua tendo de casar com o banco E com o rótulo certo. Um
//    modelo que invente cifra, troque cidade ou converta "empenhado" em
//    "recebeu" é reprovado e a redação é refeita.
//
// 3. **Falha fechada.** Post que não passa em N tentativas fica sem texto de
//    LinkedIn, e `postar:slot` cai no molde determinístico. Nunca publica o
//    que não passou.

import type { Database } from "bun:sqlite";
import type { DominioFato, Fato } from "./verificar-post.ts";
import { verificarPost } from "./verificar-post.ts";

/** Recorte da série, como vive em `data/pool-posts.json`. */
export type PostDaSerie = {
  id: string;
  eixo: string;
  texto: string;
  hash: string;
  fatos: Array<{ valor: number; rotulo: string }>;
  dominios?: DominioFato[];
};

export type TextoLinkedIn = {
  post_id: string;
  /** Hash do recorte de origem. Mudou o dado, o texto guardado não serve mais. */
  hash: string;
  texto: string;
  modelo: string;
  tentativas: number;
  em: string;
};

/** Haiku por escolha do candidato: a tarefa é reescrever dentro de regra dura,
 *  e quem garante o número é o verificador. Trocável por --modelo. */
export const MODELO_PADRAO = "haiku";

// -------------------------------------------------------------------- prompt

const REGRAS = `
REGRAS DURAS (violar qualquer uma reprova o texto):

1. NÃO INVENTE NÚMERO. Use exclusivamente as cifras, contagens, anos e
   percentuais que aparecem no RECORTE. Não some, não arredonde, não converta,
   não calcule per capita, não estime. Se um número não está no recorte, ele
   não existe. Isso vale inclusive dentro de exemplo, hipótese ou comparação:
   NÃO escreva "se três cidades concentram 80%..." — um leitor apressado lê
   hipótese como dado.
2. NÃO ACRESCENTE FATO que não esteja no recorte. Nada de região, mesorregião,
   partido, cargo, data ou contexto histórico que o recorte não traga. Se você
   sabe de fora, não serve: aqui só entra o que foi conferido.
3. NÃO INTERPRETE o dado como se a leitura fosse fato. Explicar o que o número
   é e o que ele não é, sim. Afirmar o que ele significa politicamente, não.
4. Verbo de EMPENHO, nunca de entrega. "empenhado para", "com destino a",
   "destinadas a". Jamais "recebeu", "chegou", "foi entregue", "investiu" —
   empenho é compromisso com a despesa, não pagamento feito.
5. NÃO ASSINE e não fale em primeira pessoa. Nada de "eu", "minha campanha",
   "vamos". O texto é de um levantamento, não de um candidato.
6. NÃO FAÇA PERGUNTA. Tom afirmativo: o texto informa, não interroga.
7. NÃO use posição de ranking em número ("3º lugar"). Em palavra, se precisar:
   "entre os maiores".
8. NÃO diga "salário" de assessor. O dado é vencimento de CARGO.
9. NÃO prometa. Sobre ferrovia: possibilidade não é promessa; nada de "quando
   o trem chegar".
10. NÃO afirme que alguém não é candidato, e não diga "represento a região X".
11. Sem markdown, sem asterisco, sem emoji. O LinkedIn não renderiza nada disso.
`.trim();

const ESTRATEGIA = `
COMO ESCREVER PARA O LINKEDIN. O público chega pelo perfil profissional do
autor, não acompanha a série e não sabe o que é uma emenda parlamentar.

O ANZOL (as duas ou três primeiras linhas decidem tudo):
- O corte "…ver mais" cai por volta de 140 caracteres no celular, e um
  parágrafo em branco encerra o trecho visível ANTES disso. Primeira linha com
  enquadramento E número juntos, sem linha em branco no meio.
- O que prende: número, credibilidade da fonte, ou uma tensão. Nada de
  saudação, nada de rodeio, nada de anunciar o que você vai dizer.

O CORPO:
- Explique. Este público responde a conteúdo didático: o que é o dado, de onde
  vem, por que a distinção importa. Vale explicar o que é empenho, o que a
  fonte não diz, por que o recorte é piso e não teto.
- Escreva como quem explica a um colega inteligente de outra área. Frases
  curtas. Sem jargão de campanha, sem adjetivo de indignação.
- Parágrafos de uma a três linhas, com linha em branco entre eles.
- Entre 600 e 1200 caracteres. Não existe limite de 280 aqui.
- Termine com a linha de link exatamente como fornecida.

NÃO SOE COMO TEXTO DE MÁQUINA. Desde março de 2026 o LinkedIn rebaixa em até
47% o alcance de texto que soa gerado, e diz acertar a detecção em 94% dos
casos. O que ele reconhece:
- Frases todas do mesmo tamanho. VARIE: alterne períodos curtos e longos.
- Reafirmar a mesma ideia três vezes com palavras diferentes. Diga uma vez.
- Fórmulas de abertura e virada: "Aqui está o que", "O resultado?", "Não é X,
  é Y", "Vamos ao que importa", "Em um mundo onde". Nenhuma delas.
- Transição formal encadeada: "Além disso", "Por fim", "Em resumo".
- Frase genérica sem lastro ("transparência é fundamental"). Toda afirmação
  deste texto tem de estar amarrada ao dado concreto que está no recorte.
- Fecho motivacional ou chamada para engajar ("o que você acha?", "comente
  abaixo"). Não peça engajamento.
O que passa é especificidade: cidade com nome, cifra conferida, fonte nomeada,
a ressalva metodológica exata. Isso o recorte já tem — use.
`.trim();

/**
 * Números do texto gerado que NÃO aparecem no recorte de origem.
 *
 * Existe porque o `verificarPost` não olha porcentagem: "80%" passa, "999
 * emendas" não. No X isso nunca importou — os textos vinham de template e
 * nenhum inventava percentual. Com um modelo escrevendo prosa, a primeira
 * redação de teste produziu "se três cidades concentram 80%, o resto fica com
 * 20%" — uma hipótese que um leitor apressado lê como dado.
 *
 * A regra aqui é mais dura que a do verificador de propósito: todo token
 * numérico do texto tem de existir no recorte. Reformatação continua passando
 * ("R$ 984,4 mi" -> "R$ 984,4 milhões" preserva "984,4"); invenção, não.
 */
export function numerosForaDoRecorte(gerado: string, recorte: string): string[] {
  const doRecorte = new Set(recorte.match(/\d+(?:[.,]\d+)*/g) ?? []);
  const usados = gerado.match(/\d+(?:[.,]\d+)*/g) ?? [];
  return [...new Set(usados.filter((n) => !doRecorte.has(n)))];
}

export function montarPrompt(post: PostDaSerie, link: string): string {
  const fatos = post.fatos.map((f) => `  - ${f.rotulo}: ${f.valor}`).join("\n");
  return `Você reescreve, para o LinkedIn, um recorte de um levantamento público sobre
emendas parlamentares de Pernambuco. O recorte abaixo JÁ FOI CONFERIDO contra
o banco de dados oficial — os números dele são verdadeiros e são os únicos que
você pode usar.

RECORTE (eixo "${post.eixo}"):
"""
${post.texto}
"""

NÚMEROS CONFERIDOS (rótulo: valor) — nenhum outro número pode aparecer:
${fatos || "  (nenhum)"}

LINHA DE LINK, para terminar o texto, copiada sem alteração:
"""
${link}
"""

${ESTRATEGIA}

${REGRAS}

Responda APENAS com o texto final do post, sem comentário, sem aspas em volta,
sem título. Nada além do texto que vai ao ar.`;
}

// ---------------------------------------------------------------------- rede

/**
 * Chama o modelo pelo CLI do Claude Code em modo headless.
 *
 * Não usa a Claude API direta porque não há `ANTHROPIC_API_KEY` nesta máquina:
 * o `claude -p` reaproveita o login já existente, e o consumo sai do plano em
 * vez de virar fatura por token. O custo aqui é cota e tempo, não dinheiro.
 */
export async function redigirComClaude(prompt: string, modelo: string): Promise<string> {
  const proc = Bun.spawn(["claude", "-p", "--model", modelo, prompt], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [saida, erro, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`claude -p saiu com ${code}: ${erro.slice(0, 300)}`);

  const texto = saida.trim();
  if (texto === "") throw new Error("claude -p devolveu vazio");
  return texto;
}

// ----------------------------------------------------------------- verificação

export type Resultado =
  | { ok: true; texto: string; tentativas: number }
  | { ok: false; tentativas: number; motivos: string[] };

export type OpcoesRedacao = {
  db: Database;
  link: string;
  fatos?: Fato[];
  modelo?: string;
  maxTentativas?: number;
  /** Injetável para o teste rodar sem tocar em modelo nenhum. */
  redigir?: (prompt: string, modelo: string) => Promise<string>;
};

/**
 * Redige e verifica, repetindo enquanto o verificador reprovar.
 *
 * O `limitePeso: null` desliga SÓ a regra dos 280 — que é do X e não deste
 * canal. Todas as outras continuam: número sem lastro, rótulo divergente,
 * frase proibida, verbo de entrega. `permitirLink` é true porque aqui o link
 * vai no corpo por falta de alternativa (comentar exige escopo de parceiro).
 */
export async function redigirVerificado(post: PostDaSerie, opts: OpcoesRedacao): Promise<Resultado> {
  const modelo = opts.modelo ?? MODELO_PADRAO;
  const max = opts.maxTentativas ?? 3;
  const redigir = opts.redigir ?? redigirComClaude;
  const prompt = montarPrompt(post, opts.link);
  const motivos: string[] = [];

  for (let tentativa = 1; tentativa <= max; tentativa++) {
    let texto: string;
    try {
      texto = await redigir(prompt, modelo);
    } catch (err) {
      motivos.push(`tentativa ${tentativa}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const veredito = verificarPost(texto, opts.db, {
      permitirLink: true,
      limitePeso: null,
      tom: "afirmativo",
      rotulosEsperados: post.fatos.map((f) => f.rotulo),
      ...(post.dominios === undefined ? {} : { dominios: post.dominios }),
      ...(opts.fatos === undefined ? {} : { fatos: opts.fatos }),
    });

    // O `tom: "afirmativo"` do verificador só olha o FECHO. Um modelo põe
    // pergunta retórica no meio ("O que esse número revela?"), que é
    // igualmente proibida: a série é afirmativa porque ninguém responde nos
    // 30 minutos seguintes, e isso não muda por a pergunta estar no meio.
    const perguntas = (texto.match(/\?/g) ?? []).length;
    const inventados = numerosForaDoRecorte(texto, post.texto);
    if (veredito.ok && inventados.length === 0 && perguntas === 0) {
      return { ok: true, texto, tentativas: tentativa };
    }

    const extras: string[] = [];
    if (inventados.length > 0) extras.push(`numero-fora-do-recorte (${inventados.join(", ")})`);
    if (perguntas > 0) extras.push(`pergunta-no-texto (${perguntas})`);
    if (extras.length > 0) {
      motivos.push(`tentativa ${tentativa}: ${extras.join("; ")}`);
      continue;
    }

    motivos.push(
      `tentativa ${tentativa}: ` +
        veredito.achados
          .filter((a) => a.severidade === "erro")
          .map((a) => `${a.regra} (${a.detalhe})`)
          .join("; "),
    );
  }

  return { ok: false, tentativas: max, motivos };
}
