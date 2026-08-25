// Publicação no LinkedIn via Posts API — POST /rest/posts.
//
// Autenticação: OAuth 2.0 three-legged. Não existe chave estática no LinkedIn
// (o equivalente ao OAuth 1.0a do X não é oferecido): um post sai de um membro,
// e o membro precisa consentir uma vez no navegador. O token que sai daí dura
// 2 meses e vai no .env — ver `linkedin-auth.ts` para o fluxo de obtenção.
//
// App: "social-softagon-app" (id 226108894), o mesmo do X. Produtos já
// provisionados desde 13/05/2025: "Share on LinkedIn" (dá o w_member_social) e
// "Sign In with LinkedIn using OpenID Connect" (dá openid/profile, de onde sai
// o Person URN). Nada aqui depende de aprovação de parceiro.
//
// Fontes conferidas em 25/08/2026:
//   https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
//   https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format
//   https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin

import { HarvestError, insist } from "./retry.ts";

const API = "https://api.linkedin.com";
const OAUTH = "https://www.linkedin.com/oauth/v2";

/**
 * Header `LinkedIn-Version`, formato YYYYMM. Não é decorativo: versão ausente
 * ou fora da janela suportada devolve 426. O LinkedIn aposenta uma versão por
 * vez (a 202508 foi desligada em 17/08/2026), então isto envelhece — se
 * aparecer 426, suba o mês e confira em .../marketing/versioning.
 */
const VERSAO = "202608";

export type CredenciaisLinkedIn = {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  /** Person URN do autor: "urn:li:person:{sub}". Sai do /v2/userinfo. */
  autor: string;
};

// ---------------------------------------------------------------- credenciais

const VARS = {
  clientId: "LINKEDIN_CLIENT_ID",
  clientSecret: "LINKEDIN_CLIENT_SECRET",
  accessToken: "LINKEDIN_ACCESS_TOKEN",
  autor: "LINKEDIN_AUTOR_URN",
} as const satisfies Record<keyof CredenciaisLinkedIn, string>;

/** Lê as 4 chaves do ambiente. Falha alto e nomeando o que falta, como no X. */
export function lerCredenciaisLinkedIn(
  env: Record<string, string | undefined> = Bun.env,
): CredenciaisLinkedIn {
  const faltando: string[] = [];
  const cred = {} as CredenciaisLinkedIn;

  for (const [campo, nomeVar] of Object.entries(VARS) as Array<[keyof CredenciaisLinkedIn, string]>) {
    const valor = env[nomeVar]?.trim();
    if (!valor) {
      faltando.push(nomeVar);
      continue;
    }
    cred[campo] = valor;
  }

  if (faltando.length > 0) {
    throw new Error(
      `credenciais do LinkedIn ausentes: ${faltando.join(", ")}.\n` +
        `Rode "bun run src/linkedin-auth.ts" para obter o token — ele grava tudo no .env.`,
    );
  }
  return cred;
}

// ------------------------------------------------------------- little format

/**
 * O `commentary` não é texto puro: é "little text format", e a regra que pega
 * todo mundo está numa nota de rodapé da doc — **todo caractere reservado
 * precisa de barra invertida, mesmo quando não faz parte de nenhum elemento**.
 * Um post nosso como "Salgueiro (R$ 1,2 mi)" tem dois reservados; sem escapar,
 * o parser do LinkedIn come o trecho ou devolve 422.
 *
 * A barra invertida vai primeiro, senão o escape se auto-escapa em cascata.
 */
const RESERVADOS = ["\\", "|", "{", "}", "@", "[", "]", "(", ")", "<", ">", "#", "*", "_", "~"] as const;

export function escaparLittle(texto: string): string {
  let saida = texto;
  for (const c of RESERVADOS) saida = saida.split(c).join(`\\${c}`);
  return saida;
}

// ------------------------------------------------------------------- OAuth

/** Escopos mínimos: publicar + descobrir quem é o autor. Nada de leitura. */
export const ESCOPOS = ["openid", "profile", "w_member_social"] as const;

export function urlAutorizacao(opts: { clientId: string; redirectUri: string; state: string }): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    scope: ESCOPOS.join(" "),
  });
  return `${OAUTH}/authorization?${q}`;
}

export type TokenLinkedIn = { access_token: string; expires_in: number; scope?: string };

export async function trocarCodePorToken(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<TokenLinkedIn> {
  const res = await fetch(`${OAUTH}/accessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
    }),
  });

  const texto = await res.text();
  if (!res.ok) throw new Error(`POST /oauth/v2/accessToken -> ${res.status} ${texto.slice(0, 300)}`);
  return JSON.parse(texto) as TokenLinkedIn;
}

export type Perfil = { sub: string; name?: string };

/**
 * Quem é o dono do token. É o OIDC padrão (`/v2/userinfo`), fora do
 * versionamento da Marketing API — não leva LinkedIn-Version.
 *
 * O `sub` daqui é o que monta o Person URN. Diferente do X, aqui não dá para
 * cachear e esquecer: o `author` é campo obrigatório de todo post, e um URN
 * errado é 403, não texto errado.
 */
export async function perfilDoToken(accessToken: string): Promise<Perfil> {
  const res = await fetch(`${API}/v2/userinfo`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const texto = await res.text();
  if (!res.ok) throw new Error(`GET /v2/userinfo -> ${res.status} ${texto.slice(0, 300)}`);
  return JSON.parse(texto) as Perfil;
}

// --------------------------------------------------------------------- rede

function cabecalhos(cred: CredenciaisLinkedIn): Record<string, string> {
  return {
    Authorization: `Bearer ${cred.accessToken}`,
    "X-Restli-Protocol-Version": "2.0.0",
    "LinkedIn-Version": VERSAO,
    "Content-Type": "application/json",
  };
}

/** Corpo do POST /rest/posts. Puro, para o teste conferir o escape sem rede. */
export function corpoDoPost(texto: string, autor: string): Record<string, unknown> {
  return {
    author: autor,
    commentary: escaparLittle(texto),
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
}

/**
 * Publica no feed do membro. Devolve o URN do post (urn:li:share:... ou
 * urn:li:ugcPost:...), que vem no header `x-restli-id` — o corpo da resposta
 * 201 é vazio, então ler `await res.json()` aqui dá erro de parse.
 */
export async function publicarNoLinkedIn(cred: CredenciaisLinkedIn, texto: string): Promise<string> {
  const label = "linkedin:POST /rest/posts";

  const r = await insist(
    label,
    async (signal) => {
      const res = await fetch(`${API}/rest/posts`, {
        method: "POST",
        signal,
        headers: cabecalhos(cred),
        body: JSON.stringify(corpoDoPost(texto, cred.autor)),
      });

      const corpo = await res.text();

      if (!res.ok) {
        const detalhe = `${res.status} ${corpo.slice(0, 400)}`;
        // 401 = token venceu (2 meses) ou foi revogado; 403 = falta escopo.
        // Insistir nos dois só queima tentativa: o erro é de credencial.
        // 422 costuma ser reservado não escapado — também não melhora com retry.
        if (res.status === 401 || res.status === 403 || res.status === 422) {
          throw new HarvestError("parse", `${label}: ${detalhe}`);
        }
        throw new HarvestError("http", `${label}: ${detalhe}`, { status: res.status });
      }

      const id = res.headers.get("x-restli-id");
      if (!id) throw new HarvestError("parse", `${label}: 201 sem x-restli-id (corpo: ${corpo.slice(0, 200)})`);
      return id;
    },
    { maxAttempts: 4, baseMs: 2000, capMs: 60_000 },
  );

  if (!r.ok) throw r.lastError;
  return r.value;
}

/** URL de exibição do post publicado. */
export function urlDoPost(urn: string): string {
  return `https://www.linkedin.com/feed/update/${urn}/`;
}

// -------------------------------------------------------------- link do painel

/**
 * Monta o texto do LinkedIn com o link do painel NO CORPO.
 *
 * No X o link vai na 1ª resposta, porque no corpo derruba o alcance de 50–90%
 * (§36). Aqui não dá para espelhar isso: comentar por API exige o escopo
 * `w_member_social_feed`, que é de parceiro aprovado — "Share on LinkedIn" não
 * concede, e a tentativa devolve
 * `403 ACCESS_DENIED partnerApiSocialActions.CREATE` (medido em 25/08/2026).
 *
 * Das saídas possíveis, link no corpo é a única que preserva a decisão do
 * candidato de que dado conferível tem endereço. A penalidade de alcance por
 * link externo é medida no X, não aqui; e no LinkedIn não há custo por post
 * nem limite de 280, então o link no corpo não tira nada de outra camada.
 */
/**
 * Moldura por eixo: o que a série é, de onde vem o dado e o que o número não
 * é. Existe porque o texto do X é o 68º de uma série de 6 em 6 horas — quem
 * acompanha tem o contexto acumulado, quem chega pelo perfil não tem nenhum.
 *
 * Três regras a manter ao editar:
 *
 * 1. **Nenhum número aqui.** A garantia do `verificar-post.ts` vale sobre o
 *    texto do X. Cifra ou contagem na moldura entraria sem lastro, e é
 *    exatamente assim que os três números errados já publicados nasceram.
 * 2. **Impessoal.** Não é a voz do candidato: eixos como `autor` e
 *    `curiosidade` citam terceiros com cifra, e post que cita terceiro nunca
 *    leva assinatura (§43). Uma abertura em 1ª pessoa seria assinatura por
 *    outro nome.
 * 3. **Verbo de empenho.** "Empenhado para", nunca "recebeu"/"chegou" — o
 *    banco tem município com empenho alto e pagamento zero.
 */
/** Fecho de todo post. Aponta o endereço sem gastar uma URL. */
const FECHO = "O painel completo, com a fonte oficial de cada linha, está no perfil.";

const MOLDURA: Record<string, string> = {
  cidade:
    "Emenda parlamentar tem autor, valor e destino. Os três são públicos e quase nunca aparecem juntos: este painel reúne o que a Alepe e a CGU abrem em dado aberto, município por município.\n\n" +
    "Empenhado é o compromisso formal com a despesa; pago é o que saiu do caixa. As duas colunas aparecem lado a lado, porque a distância entre elas costuma ser a parte que não se conta.",
  autor:
    "De quem é a emenda? A pergunta parece simples, mas nos arquivos oficiais a autoria vem em texto livre, e precisa ser reconstruída registro a registro.\n\n" +
    "Entra na conta só o que tem autoria confirmada na fonte oficial. Onde o arquivo não nomeia quem propôs, o registro fica fora da soma.",
  funcao:
    "Para onde vai a emenda parlamentar em Pernambuco, por área de aplicação, a partir dos arquivos abertos da CGU e da Alepe.\n\n" +
    "Empenhado é compromisso com a despesa, não pagamento efetuado. E liderança de uma área nem sempre é escolha política: onde existe piso legal, quem manda é a lei.",
  gabinete:
    "Quanto custa a estrutura de um gabinete na Assembleia Legislativa de Pernambuco, pelos próprios dados abertos da Casa.\n\n" +
    "O custo é estimado e bruto: soma dos vencimentos dos cargos ocupados, sem décimo terceiro e sem encargos. Contar cabeças e contar custo produzem rankings diferentes, e o painel mostra os dois — o maior gabinete em pessoas não é o mais caro.",
  trem:
    "Sobre a Transnordestina e o transporte de passageiros, o que existe em documento — contrato, lei e prazo — e não em promessa.\n\n" +
    "Possibilidade não é promessa. O que está acima é o que os documentos sustentam hoje, e nada além disso.",
  curiosidade:
    "O painel cruza a naturalidade declarada ao TSE com a população de cada município, para todos os candidatos de Pernambuco.\n\n" +
    "Naturalidade é onde a pessoa nasceu, não onde vive nem onde concorre. O painel mostra também a votação por município na última eleição geral.",
};

/**
 * Aberturas por eixo — o anzol, e o que faltava na primeira versão: solto no
 * feed, o post abria numa cifra sem dizer do que se tratava.
 *
 * Curta de propósito. A dobra do LinkedIn no celular fica por volta de **140
 * caracteres** (57% do tráfego é mobile), e a abertura precisa caber com a
 * primeira linha do dado ainda visível.
 *
 * Enquadramento de estudo, não de campanha: conteúdo educativo alcança de 3 a
 * 5 vezes mais que os outros formatos, e é o que estes posts de fato são.
 * São VÁRIAS por eixo, e não uma: a 4 posts por dia, abertura fixa vira
 * assinatura de robô em dois dias, e o leitor para de ler antes do número.
 * Vale aqui a mesma regra da moldura: nenhum número.
 */
const ABERTURAS: Record<string, readonly string[]> = {
  cidade: [
    "Um estudo aberto das emendas parlamentares de Pernambuco, cidade por cidade.",
    "Emenda parlamentar tem autor, valor e destino. Aqui os três aparecem juntos.",
    "Quanto foi empenhado em emendas para cada município de Pernambuco.",
    "Dinheiro de emenda tem endereço. Este levantamento mostra qual.",
    "O que a Alepe e a CGU publicam sobre emendas, reunido município a município.",
  ],
  autor: [
    "Um estudo aberto das emendas parlamentares de Pernambuco, autor por autor.",
    "Nos arquivos oficiais, a autoria da emenda vem em texto livre, não em campo.",
    "Levantamento por autor das emendas parlamentares destinadas a Pernambuco.",
    "Só entra na conta a emenda cuja autoria a fonte oficial confirma.",
    "Quanto cada parlamentar tem empenhado em emendas para Pernambuco.",
  ],
  funcao: [
    "Um estudo aberto das emendas parlamentares de Pernambuco, área por área.",
    "Para onde vai a emenda parlamentar em Pernambuco, por área de aplicação.",
    "Saúde, educação, infraestrutura: em que área a emenda de PE é aplicada.",
    "Levantamento por área das emendas federais destinadas a Pernambuco.",
    "Nem toda liderança de área é escolha política. Às vezes é piso legal.",
  ],
  gabinete: [
    "Um estudo aberto da estrutura dos gabinetes na Assembleia de Pernambuco.",
    "Quanto custa por mês a estrutura de um gabinete na Alepe.",
    "Contar cabeças e contar custo produzem rankings diferentes na Alepe.",
    "O tamanho do gabinete não é escolha do deputado: vem de ato da Mesa.",
    "Levantamento dos gabinetes da Alepe pelos dados abertos da própria Casa.",
  ],
  trem: [
    "Um estudo aberto sobre a Transnordestina, a partir dos documentos.",
    "O que o contrato da Transnordestina diz sobre trem de passageiros.",
    "Sobre a ferrovia, o que está em documento — e não em promessa.",
    "Transnordestina e passageiros: o que existe hoje em contrato e em lei.",
    "Levantamento documental sobre a Transnordestina em Pernambuco.",
  ],
  curiosidade: [
    "Um estudo aberto sobre de onde vêm os candidatos de Pernambuco.",
    "A naturalidade declarada ao TSE, cruzada com a população de cada cidade.",
    "De onde vêm os candidatos de Pernambuco, segundo o próprio TSE.",
    "Onde nasceram os candidatos deste ano em Pernambuco.",
    "Levantamento das naturalidades declaradas por quem concorre em PE.",
  ],
};

/**
 * Escolhe a abertura pelo texto do post — determinístico, nunca aleatório.
 *
 * `Math.random()` daria abertura diferente a cada chamada, e o mesmo recorte
 * republicado (por falha de rede, por retomada) sairia com outra cara. Pior:
 * quebraria a reprodutibilidade que o resto do projeto assume, dos hashes de
 * idempotência aos testes. Somar os códigos do texto é estável entre execuções
 * e distribui bem o suficiente para o que se quer aqui — não é criptografia,
 * é evitar que 4 posts por dia abram com a mesma frase.
 */
export function escolherAbertura(texto: string, eixo: string): string | undefined {
  const opcoes = ABERTURAS[eixo];
  if (opcoes === undefined || opcoes.length === 0) return undefined;
  let soma = 0;
  for (let i = 0; i < texto.length; i++) soma = (soma + texto.charCodeAt(i) * (i + 1)) % 100_000;
  return opcoes[soma % opcoes.length];
}

/**
 * Monta o texto do LinkedIn: abertura + dado, moldura depois, link no fim.
 *
 * A ordem não é estética, e a QUEBRA também não. O trecho visível termina no
 * primeiro parágrafo em branco — dois "\n" seguidos encerram o snippet antes
 * mesmo dos 140 caracteres. Por isso a abertura se une à primeira linha do
 * dado com UMA quebra só: as duas cabem na dobra, e o número aparece sem que
 * ninguém precise clicar em "…mais". Moldura e link, com quebra dupla, ficam
 * para quem expandir.
 *
 * SEM URL NENHUMA. Link externo custa ~60% de alcance, e as três saídas
 * conhecidas estão fechadas: comentar por API exige `w_member_social_feed`, de
 * parceiro aprovado (403 medido em 25/08/2026); o link no 1º comentário
 * deixou de funcionar em 2026, com o LinkedIn soterrando o comentário do
 * autor; e "comenta aqui que eu mando" é engagement bait, que os
 * classificadores do 360Brew suprimem desde março de 2026. Decisão do
 * candidato: o endereço do painel vive no perfil, e o post aponta para lá.
 */
export function textoParaLinkedIn(texto: string, eixo: string): string {
  const abertura = escolherAbertura(texto, eixo);
  // Quebra SIMPLES entre abertura e dado: a dupla cortaria o snippet aqui.
  const cabeca = abertura === undefined ? texto : `${abertura}\n${texto}`;
  const moldura = MOLDURA[eixo];
  const partes = moldura === undefined ? [cabeca, FECHO] : [cabeca, moldura, FECHO];
  return partes.join("\n\n");
}

/**
 * Apaga um post. Como no X, é irreversível. 204 é sucesso e a operação é
 * idempotente: apagar o que já sumiu também devolve 204.
 */
export async function apagarPostLinkedIn(cred: CredenciaisLinkedIn, urn: string): Promise<boolean> {
  const res = await fetch(`${API}/rest/posts/${encodeURIComponent(urn)}`, {
    method: "DELETE",
    headers: { ...cabecalhos(cred), "X-RestLi-Method": "DELETE" },
  });
  if (res.status === 204 || res.status === 404) return true;
  throw new Error(`DELETE /rest/posts -> ${res.status} ${(await res.text()).slice(0, 300)}`);
}
