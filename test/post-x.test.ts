import { describe, expect, test } from "bun:test";
import { cabecalhoOAuth, lerCredenciais, parsePostsMarkdown, percentEncode, pesoX } from "../src/post-x.ts";

// Nenhum teste toca a rede nem publica nada.

describe("assinatura OAuth 1.0a", () => {
  // Vetor oficial da documentação do X ("Creating a signature"). Se a nossa
  // matemática bater com ele, bate com a do servidor — sem gastar cota da API
  // descobrindo isso com 401 na cara.
  const cred = {
    consumerKey: "xvz1evFS4wEEPTGEFPHBog",
    consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
    accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
    accessTokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
  };

  test("reproduz a assinatura do exemplo oficial", () => {
    const header = cabecalhoOAuth({
      method: "POST",
      url: "https://api.twitter.com/1.1/statuses/update.json",
      cred,
      query: {
        status: "Hello Ladies + Gentlemen, a signed OAuth request!",
        include_entities: "true",
      },
      nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      timestamp: "1318622958",
    });

    expect(header).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
  });

  test("o header traz os 7 parâmetros exigidos, todos percent-encoded", () => {
    const header = cabecalhoOAuth({ method: "POST", url: "https://api.x.com/2/tweets", cred, nonce: "abc", timestamp: "1" });
    expect(header.startsWith("OAuth ")).toBe(true);
    for (const p of ["oauth_consumer_key", "oauth_nonce", "oauth_signature_method", "oauth_timestamp", "oauth_token", "oauth_version", "oauth_signature"]) {
      expect(header).toContain(`${p}="`);
    }
    expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
  });

  test("nonce diferente muda a assinatura (não é constante acidental)", () => {
    const base = { method: "POST", url: "https://api.x.com/2/tweets", cred, timestamp: "1" } as const;
    expect(cabecalhoOAuth({ ...base, nonce: "a" })).not.toBe(cabecalhoOAuth({ ...base, nonce: "b" }));
  });

  test("percentEncode escapa ! * ' ( ) que encodeURIComponent deixa passar", () => {
    expect(percentEncode("Ladies + Gentlemen")).toBe("Ladies%20%2B%20Gentlemen");
    expect(percentEncode("a!b*c'd(e)")).toBe("a%21b%2Ac%27d%28e%29");
    expect(percentEncode("~_-.")).toBe("~_-."); // não-reservados ficam intactos
  });
});

describe("credenciais", () => {
  const cheio = {
    X_API_KEY: "k",
    X_API_SECRET: "s",
    X_ACCESS_TOKEN: "t",
    X_ACCESS_TOKEN_SECRET: "ts",
  };

  test("lê as quatro chaves do ambiente", () => {
    expect(lerCredenciais(cheio)).toEqual({ consumerKey: "k", consumerSecret: "s", accessToken: "t", accessTokenSecret: "ts" });
  });

  test("falha nomeando exatamente o que falta (em vez de 401 misterioso)", () => {
    expect(() => lerCredenciais({ ...cheio, X_ACCESS_TOKEN: "", X_ACCESS_TOKEN_SECRET: undefined })).toThrow(
      /X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET/,
    );
  });
});

describe("contagem de peso do X", () => {
  test("url conta 23 fixos, não o comprimento real", () => {
    const url = "https://hermesalvesbr.github.io/emendas/"; // 40 caracteres
    expect(url.length).toBe(40);
    expect(pesoX(url)).toBe(23);
  });

  test("latim pesa 1 e emoji pesa 2", () => {
    expect(pesoX("abc")).toBe(3);
    expect(pesoX("🌵")).toBe(2);
    expect(pesoX("Sertão")).toBe(6); // acento latino segue pesando 1
  });

  test("só o post de fecho carrega link — os demais pagariam alcance", async () => {
    const posts = parsePostsMarkdown(await Bun.file("POSTS-X.md").text());
    const comLink = posts.filter((p) => /https?:\/\//.test(p.texto)).map((p) => p.indice);
    expect(comLink).toEqual([15]);
  });

  test("todos os posts reais cabem em 280", async () => {
    const posts = parsePostsMarkdown(await Bun.file("POSTS-X.md").text());
    const estourados = posts.filter((p) => pesoX(p.texto) > 280);
    expect(estourados.map((p) => `${p.indice}:${pesoX(p.texto)}`)).toEqual([]);
  });
});

describe("parse de POSTS-X.md", () => {
  const md = [
    "# titulo do doc",
    "",
    "texto solto que não é post",
    "",
    "## 0 · abertura  `276 chars`",
    "",
    "```",
    "primeiro post",
    "com duas linhas",
    "```",
    "",
    "## 2 · RMR  `257 chars`",
    "",
    "```",
    "terceiro post",
    "```",
    "",
  ].join("\n");

  test("extrai índice, título e texto de cada bloco", () => {
    const posts = parsePostsMarkdown(md);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual({ indice: 0, titulo: "abertura", texto: "primeiro post\ncom duas linhas" });
    expect(posts[1]?.indice).toBe(2);
    expect(posts[1]?.titulo).toBe("RMR");
  });

  test("o arquivo real rende a thread inteira, em ordem e sem buracos", async () => {
    const posts = parsePostsMarkdown(await Bun.file("POSTS-X.md").text());
    // 17 desde 14/08/2026: o link virou o post 15 (link no corpo custa de 50%
    // a 90% de alcance) e o 16 é o post de limites do dado, do dia 15/08.
    expect(posts).toHaveLength(17);
    expect(posts.map((p) => p.indice)).toEqual([...Array(17).keys()]);
    expect(posts.every((p) => p.texto.length > 0)).toBe(true);
  });

  test("markdown sem blocos falha alto em vez de publicar nada silenciosamente", () => {
    expect(() => parsePostsMarkdown("# só um título\n\nsem posts")).toThrow(/nenhum post encontrado/);
  });
});
