// Publicação da thread no X (Twitter) via API v2 — POST /2/tweets.
//
// Autenticação: OAuth 1.0a User Context, assinada à mão com HMAC-SHA1
// (node:crypto), preservando a regra 1.1 do projeto: zero dependências de
// runtime. A alternativa (OAuth 2.0 PKCE) exigiria um servidor de callback e
// refresh de token para um trabalho que é disparado à mão — 1.0a com as
// chaves do console é mais simples e não expira.
//
// Fontes conferidas em 12/08/2026:
//   https://docs.x.com/x-api/posts/creation-of-a-post
//   https://docs.x.com/resources/fundamentals/authentication/oauth-1-0a/creating-a-signature
//   https://docs.x.com/x-api/fundamentals/rate-limits

import { createHmac, randomBytes } from "node:crypto";
import { HarvestError, insist } from "./retry.ts";

const API = "https://api.x.com/2";

export type Credenciais = {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
};

export type Post = {
  /** Índice declarado no markdown (## 0, ## 1, ...) — é a chave do estado. */
  indice: number;
  titulo: string;
  texto: string;
};

export type Publicado = { indice: number; id: string; url: string };

/** Estado da thread em disco: permite retomar sem republicar o que já foi. */
export type EstadoThread = {
  usuario: string;
  iniciada_em: string;
  publicados: Publicado[];
};

// ---------------------------------------------------------------- credenciais

const VARS = {
  consumerKey: "X_API_KEY",
  consumerSecret: "X_API_SECRET",
  accessToken: "X_ACCESS_TOKEN",
  accessTokenSecret: "X_ACCESS_TOKEN_SECRET",
} as const satisfies Record<keyof Credenciais, string>;

/** Lê as 4 chaves do ambiente (Bun carrega .env sozinho). Falha alto e nomeando o que falta. */
export function lerCredenciais(env: Record<string, string | undefined> = Bun.env): Credenciais {
  const faltando: string[] = [];
  const cred = {} as Credenciais;

  for (const [campo, nomeVar] of Object.entries(VARS) as Array<[keyof Credenciais, string]>) {
    const valor = env[nomeVar]?.trim();
    if (!valor) {
      faltando.push(nomeVar);
      continue;
    }
    cred[campo] = valor;
  }

  if (faltando.length > 0) {
    throw new Error(
      `credenciais do X ausentes: ${faltando.join(", ")}.\n` +
        `Crie um arquivo .env na raiz do projeto (já está no .gitignore) com as 4 chaves\n` +
        `do console do X → app "social-softagon-app" → Keys & Tokens → OAuth 1.0 Keys.`,
    );
  }
  return cred;
}

// ------------------------------------------------------------------ OAuth 1.0a

/**
 * RFC 3986: só A-Z a-z 0-9 - . _ ~ ficam intactos. encodeURIComponent deixa
 * passar ! * ' ( ), que a X rejeita na assinatura.
 */
export function percentEncode(valor: string): string {
  return encodeURIComponent(valor).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export type ParamsAssinatura = {
  method: string;
  url: string;
  cred: Credenciais;
  /** Parâmetros de query. O corpo JSON NÃO entra na assinatura — só entraria se fosse form-urlencoded. */
  query?: Record<string, string>;
  /** Injetáveis para o teste reproduzir uma assinatura conhecida. */
  nonce?: string;
  timestamp?: string;
};

export function cabecalhoOAuth({ method, url, cred, query = {}, nonce, timestamp }: ParamsAssinatura): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: cred.consumerKey,
    oauth_nonce: nonce ?? randomBytes(32).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp ?? Math.floor(Date.now() / 1000).toString(),
    oauth_token: cred.accessToken,
    oauth_version: "1.0",
  };

  const paramString = Object.entries({ ...query, ...oauth })
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const base = [method.toUpperCase(), percentEncode(url), percentEncode(paramString)].join("&");
  const chave = `${percentEncode(cred.consumerSecret)}&${percentEncode(cred.accessTokenSecret)}`;
  const assinatura = createHmac("sha1", chave).update(base).digest("base64");

  return `OAuth ${Object.entries({ ...oauth, oauth_signature: assinatura })
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(", ")}`;
}

// ------------------------------------------------------------ contagem do X

// twitter-text v3: o limite é 280 em "peso", não em caracteres. Latin pesa 1,
// o resto (emoji, CJK) pesa 2, e QUALQUER url conta como 23 fixos — por isso
// um post de 277 caracteres com link cabe com folga.
const URL_RE = /https?:\/\/\S+/g;
const PESO_1 = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
] as const;

export function pesoX(texto: string): number {
  // VS16 (U+FE0F) e ZWJ compõem um emoji só; descontá-los evita superestimar.
  const semUrls = texto.replace(URL_RE, "").replace(/[️‍]/g, "");
  const urls = texto.match(URL_RE)?.length ?? 0;

  let peso = 0;
  for (const ch of semUrls) {
    const cp = ch.codePointAt(0) ?? 0;
    peso += PESO_1.some(([lo, hi]) => cp >= lo && cp <= hi) ? 1 : 2;
  }
  return peso + urls * 23;
}

// ------------------------------------------------------------------ markdown

/** Extrai os posts de POSTS-X.md: cada "## N · titulo" seguido de um bloco cercado. */
export function parsePostsMarkdown(md: string): Post[] {
  const posts: Post[] = [];
  const re = /^##\s+(\d+)\s*·\s*(.+?)\s*(?:`[^`]*`)?\s*$\n+```\n([\s\S]*?)\n```/gm;

  for (const m of md.matchAll(re)) {
    const [, indice, titulo, texto] = m;
    if (indice === undefined || titulo === undefined || texto === undefined) continue;
    posts.push({ indice: Number(indice), titulo: titulo.trim(), texto: texto.trim() });
  }

  if (posts.length === 0) throw new Error("nenhum post encontrado no markdown — o formato mudou?");
  return posts.sort((a, b) => a.indice - b.indice);
}

// -------------------------------------------------------------------- rede

type RespostaX = { data?: { id?: string; username?: string }; detail?: string; title?: string };

async function chamar(
  metodo: "GET" | "POST",
  caminho: string,
  cred: Credenciais,
  corpo?: unknown,
): Promise<RespostaX> {
  const url = `${API}${caminho}`;
  const label = `x:${metodo} ${caminho}`;

  const r = await insist(
    label,
    async (signal) => {
      const res = await fetch(url, {
        method: metodo,
        signal,
        headers: {
          Authorization: cabecalhoOAuth({ method: metodo, url, cred }),
          ...(corpo === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
      });

      const texto = await res.text();

      if (!res.ok) {
        // 401/403 são erro de credencial ou permissão: insistir só gasta cota.
        // 429 traz o reset no header e vale a pena aguardar via backoff.
        const restante = res.headers.get("x-rate-limit-remaining");
        const detalhe = `${res.status} ${texto.slice(0, 400)}${restante ? ` (restam ${restante} na janela)` : ""}`;
        if (res.status === 401 || res.status === 403) throw new HarvestError("parse", `${label}: ${detalhe}`);
        throw new HarvestError("http", `${label}: ${detalhe}`, { status: res.status });
      }

      try {
        return JSON.parse(texto) as RespostaX;
      } catch (cause) {
        throw new HarvestError("parse", `${label}: resposta não-JSON: ${texto.slice(0, 200)}`, { cause });
      }
    },
    { maxAttempts: 4, baseMs: 2000, capMs: 60_000 },
  );

  if (!r.ok) throw r.lastError;
  return r.value;
}

/**
 * Checa só o par Consumer Key/Secret (app-only bearer, client_credentials) e
 * se o app está habilitado no v2. Separa dois problemas que dão erro parecido:
 * chave errada (falha no /oauth2/token) e app sem plano ativo (403
 * "client-not-enrolled" no v2, que nenhum Access Token resolve).
 * É tudo leitura — não publica nada e não precisa do Access Token.
 */
export async function diagnosticarApp(cred: Pick<Credenciais, "consumerKey" | "consumerSecret">): Promise<{
  chavesValidas: boolean;
  v2Liberado: boolean;
  detalhe: string;
}> {
  const basic = Buffer.from(`${percentEncode(cred.consumerKey)}:${percentEncode(cred.consumerSecret)}`).toString("base64");

  const tokenRes = await fetch("https://api.x.com/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "grant_type=client_credentials",
  });

  if (!tokenRes.ok) {
    return { chavesValidas: false, v2Liberado: false, detalhe: `POST /oauth2/token -> ${tokenRes.status} ${(await tokenRes.text()).slice(0, 200)}` };
  }

  const bearer = (await tokenRes.json() as { access_token?: string }).access_token;
  if (!bearer) return { chavesValidas: false, v2Liberado: false, detalhe: "token endpoint respondeu 200 sem access_token" };

  // A sonda precisa ser um endpoint METRIFICADO. /2/openapi.json responde 200
  // para qualquer um (é rota pública) e daria falso positivo; /2/users/me
  // recusa app-only por natureza, o que também não diz nada sobre o plano.
  const res = await fetch("https://api.x.com/2/tweets/search/recent?query=teste&max_results=10", {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (res.ok) return { chavesValidas: true, v2Liberado: true, detalhe: "app habilitado no v2" };

  const corpo = await res.text();
  const naoMatriculado = corpo.includes("client-not-enrolled") || corpo.includes("attached to a Project");
  return {
    chavesValidas: true,
    v2Liberado: false,
    detalhe: naoMatriculado
      ? `app SEM plano ativo na API v2 (client-not-enrolled, HTTP ${res.status}) — é bloqueio de billing/plano, não de credencial`
      : `v2 -> ${res.status} ${corpo.slice(0, 300)}`,
  };
}

/** Confirma que as chaves funcionam e devolve o @usuário. É leitura — não publica nada. */
export async function verificarCredenciais(cred: Credenciais): Promise<string> {
  const r = await chamar("GET", "/users/me", cred);
  const username = r.data?.username;
  if (!username) throw new Error(`resposta inesperada de /users/me: ${JSON.stringify(r).slice(0, 200)}`);
  return username;
}

async function publicarUm(cred: Credenciais, texto: string, responderA: string | null): Promise<string> {
  const corpo = responderA === null ? { text: texto } : { text: texto, reply: { in_reply_to_tweet_id: responderA } };
  const r = await chamar("POST", "/tweets", cred, corpo);
  const id = r.data?.id;
  if (!id) throw new Error(`post aceito mas sem id na resposta: ${JSON.stringify(r).slice(0, 200)}`);
  return id;
}

// ------------------------------------------------------------------- thread

export type OpcoesThread = {
  cred: Credenciais;
  posts: Post[];
  usuario: string;
  estado: EstadoThread | null;
  intervaloMs: number;
  /** Chamado a cada post publicado, para o CLI narrar o progresso. */
  aoPublicar: (p: Publicado, restantes: number) => void;
  /** Persiste o estado após CADA post — se cair no meio, retomar não duplica. */
  salvarEstado: (e: EstadoThread) => Promise<void>;
};

/**
 * Publica os posts em thread (cada um respondendo ao anterior), retomando de
 * onde parou. O estado é gravado a cada post porque uma falha no post 9 de 15
 * não pode significar republicar os 8 primeiros.
 */
export async function publicarThread(opts: OpcoesThread): Promise<EstadoThread> {
  const { cred, posts, usuario, intervaloMs, aoPublicar, salvarEstado } = opts;

  const estado: EstadoThread = opts.estado ?? {
    usuario,
    iniciada_em: new Date().toISOString(),
    publicados: [],
  };

  const jaPublicados = new Set(estado.publicados.map((p) => p.indice));
  const pendentes = posts.filter((p) => !jaPublicados.has(p.indice));

  // Encadeia na ponta da thread já existente (último id publicado).
  let anterior = estado.publicados.at(-1)?.id ?? null;

  for (const [i, post] of pendentes.entries()) {
    const id = await publicarUm(cred, post.texto, anterior);
    const publicado: Publicado = { indice: post.indice, id, url: `https://x.com/${usuario}/status/${id}` };

    estado.publicados.push(publicado);
    await salvarEstado(estado);
    aoPublicar(publicado, pendentes.length - i - 1);

    anterior = id;
    if (i < pendentes.length - 1) await Bun.sleep(intervaloMs);
  }

  return estado;
}
