// Fluxo de autorização do LinkedIn — roda UMA vez, à mão, e grava no .env.
//
// Por que existe um servidor aqui, se a regra do projeto é disparo manual:
// o OAuth 2.0 do LinkedIn não tem client_credentials para publicar (app-only
// não posta) nem device flow. O único caminho é o navegador devolver um `code`
// num redirect registrado — daí o servidorzinho em localhost:8788, que vive
// os ~30 segundos do consentimento e morre.
//
// O token dura 2 meses e app self-serve NÃO recebe refresh token (refresh
// programático é só para parceiro MDP aprovado). Da autorização até a véspera
// do 1º turno cabe um token só; depois de 03/10/2026, rodar isto de novo.
//
// Uso:
//   bun run src/linkedin-auth.ts
//
// Pré-requisito: LINKEDIN_CLIENT_ID e LINKEDIN_CLIENT_SECRET no .env, e
// http://localhost:8788/callback na lista de Authorized redirect URLs do app
// (já cadastrado em 25/08/2026).

import { randomBytes } from "node:crypto";
import { perfilDoToken, trocarCodePorToken, urlAutorizacao } from "./post-linkedin.ts";

const PORTA = 8788;
const REDIRECT = `http://localhost:${PORTA}/callback`;
const ENV = ".env";

const clientId = Bun.env.LINKEDIN_CLIENT_ID?.trim();
const clientSecret = Bun.env.LINKEDIN_CLIENT_SECRET?.trim();

if (!clientId || !clientSecret) {
  console.error(
    `faltam LINKEDIN_CLIENT_ID e/ou LINKEDIN_CLIENT_SECRET no ${ENV}.\n` +
      `Pegue os dois em https://www.linkedin.com/developers/apps/226108894/auth`,
  );
  process.exit(1);
}

// O `state` é o que impede um terceiro de injetar um `code` de outra conta no
// nosso callback. Comparado na volta; divergiu, descarta.
const state = randomBytes(16).toString("hex");
const url = urlAutorizacao({ clientId, redirectUri: REDIRECT, state });

console.log("\nAbra no navegador onde você está logado como o autor da série:\n");
console.log(`  ${url}\n`);
console.log("Aguardando o consentimento…\n");

const recebido = Promise.withResolvers<{ code: string; state: string }>();

const servidor = Bun.serve({
  port: PORTA,
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname !== "/callback") return new Response("nada aqui", { status: 404 });

    const erro = u.searchParams.get("error");
    if (erro) {
      const desc = u.searchParams.get("error_description") ?? "";
      recebido.reject(new Error(`o LinkedIn recusou: ${erro} ${desc}`));
      return new Response(`Recusado: ${erro} ${desc}`, { status: 400 });
    }

    const code = u.searchParams.get("code");
    const devolvido = u.searchParams.get("state");
    if (!code || !devolvido) return new Response("callback sem code/state", { status: 400 });

    recebido.resolve({ code, state: devolvido });
    return new Response("Autorizado. Pode fechar esta aba e voltar ao terminal.", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
});

// Rede pode não vir: sem prazo, o processo ficaria pendurado para sempre num cron.
const prazo = setTimeout(() => recebido.reject(new Error("ninguém autorizou em 5 minutos")), 5 * 60_000);

try {
  const { code, state: devolvido } = await recebido.promise;
  clearTimeout(prazo);

  if (devolvido !== state) throw new Error("state divergente — descartando o code por segurança");

  const token = await trocarCodePorToken({ clientId, clientSecret, code, redirectUri: REDIRECT });
  const perfil = await perfilDoToken(token.access_token);
  const autor = `urn:li:person:${perfil.sub}`;
  const vence = new Date(Date.now() + token.expires_in * 1000);

  const bloco =
    `\n# --- LinkedIn (app "social-softagon-app", id 226108894) ---\n` +
    `# Gerado por src/linkedin-auth.ts em ${new Date().toISOString()}.\n` +
    `# Escopos: ${token.scope ?? "(não devolvidos)"}\n` +
    `# VENCE EM ${vence.toISOString().slice(0, 10)} — não há refresh token em app self-serve.\n` +
    `LINKEDIN_ACCESS_TOKEN=${token.access_token}\n` +
    `LINKEDIN_AUTOR_URN=${autor}\n`;

  const atual = await Bun.file(ENV).text();
  await Bun.write(ENV, atual + bloco);

  console.log(`autorizado como ${perfil.name ?? autor}`);
  console.log(`token gravado em ${ENV}, vence em ${vence.toISOString().slice(0, 10)}`);
} finally {
  servidor.stop(true);
}
