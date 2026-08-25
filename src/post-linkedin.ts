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
