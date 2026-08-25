import { describe, expect, test } from "bun:test";
import {
  corpoDoPost,
  escaparLittle,
  ESCOPOS,
  lerCredenciaisLinkedIn,
  textoParaLinkedIn,
  urlAutorizacao,
  urlDoPost,
} from "../src/post-linkedin.ts";

// Nenhum teste toca a rede nem publica nada.

describe("little text format", () => {
  // A regra está numa nota de rodapé da doc e é contraintuitiva: reservado
  // escapa SEMPRE, mesmo fora de elemento. Parêntese é o caso que nos atinge
  // em quase todo post — é o que separa texto publicado de 422.
  test("escapa parêntese em texto real da série", () => {
    const texto = "Salgueiro recebeu R$ 1,2 milhão em emendas (2024). Fonte: Alepe.";
    expect(escaparLittle(texto)).toBe("Salgueiro recebeu R$ 1,2 milhão em emendas \\(2024\\). Fonte: Alepe.");
  });

  test("escapa os 15 reservados", () => {
    expect(escaparLittle("| { } @ [ ] ( ) < > # * _ ~")).toBe(
      "\\| \\{ \\} \\@ \\[ \\] \\( \\) \\< \\> \\# \\* \\_ \\~",
    );
  });

  test("a barra invertida vai primeiro, sem cascata", () => {
    // Se \ fosse escapado depois de (, o "\(" viraria "\\(" e o parêntese
    // apareceria literal no feed, precedido de barra.
    expect(escaparLittle("a\\b")).toBe("a\\\\b");
    expect(escaparLittle("(x)")).toBe("\\(x\\)");
  });

  test("texto sem reservado passa intacto, acento inclusive", () => {
    const texto = "São Vicente Férrer lidera em valor por habitante.";
    expect(escaparLittle(texto)).toBe(texto);
  });

  test("não há limite de 280: texto longo não é truncado", () => {
    // O pesoX e os descartes por campanha-nao-coube são restrição do X. Aqui o
    // mesmo recorte cabe inteiro — o módulo não pode herdar o corte alheio.
    const longo = "a".repeat(1200);
    expect(escaparLittle(longo)).toHaveLength(1200);
  });
});

describe("corpo do post", () => {
  const autor = "urn:li:person:ABC123";

  test("monta os campos obrigatórios da Posts API", () => {
    const corpo = corpoDoPost("Teste", autor) as Record<string, unknown>;
    expect(corpo.author).toBe(autor);
    expect(corpo.commentary).toBe("Teste");
    expect(corpo.visibility).toBe("PUBLIC");
    expect(corpo.lifecycleState).toBe("PUBLISHED");
    expect(corpo.distribution).toEqual({
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    });
  });

  test("o commentary sai escapado, não cru", () => {
    const corpo = corpoDoPost("Araripina (R$ 900 mil)", autor) as Record<string, unknown>;
    expect(corpo.commentary).toBe("Araripina \\(R$ 900 mil\\)");
  });
});

describe("credenciais", () => {
  test("nomeia todas as que faltam, de uma vez", () => {
    expect(() => lerCredenciaisLinkedIn({})).toThrow(
      /LINKEDIN_CLIENT_ID.*LINKEDIN_CLIENT_SECRET.*LINKEDIN_ACCESS_TOKEN.*LINKEDIN_AUTOR_URN/s,
    );
  });

  test("aceita o conjunto completo", () => {
    const cred = lerCredenciaisLinkedIn({
      LINKEDIN_CLIENT_ID: "id",
      LINKEDIN_CLIENT_SECRET: "segredo",
      LINKEDIN_ACCESS_TOKEN: "token",
      LINKEDIN_AUTOR_URN: "urn:li:person:X",
    });
    expect(cred.autor).toBe("urn:li:person:X");
  });

  test("espaço em branco não conta como credencial", () => {
    expect(() =>
      lerCredenciaisLinkedIn({
        LINKEDIN_CLIENT_ID: "  ",
        LINKEDIN_CLIENT_SECRET: "s",
        LINKEDIN_ACCESS_TOKEN: "t",
        LINKEDIN_AUTOR_URN: "u",
      }),
    ).toThrow(/LINKEDIN_CLIENT_ID/);
  });
});

describe("autorização", () => {
  test("pede só os 3 escopos mínimos", () => {
    expect([...ESCOPOS]).toEqual(["openid", "profile", "w_member_social"]);
  });

  test("a URL leva code, state e o redirect exato", () => {
    const u = new URL(urlAutorizacao({ clientId: "cid", redirectUri: "http://localhost:8788/callback", state: "s1" }));
    expect(u.origin + u.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("state")).toBe("s1");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:8788/callback");
    expect(u.searchParams.get("scope")).toBe("openid profile w_member_social");
  });
});

describe("moldura do LinkedIn", () => {
  const LINK = "Confira linha a linha:\nhttps://hermesalvesbr.github.io/emendas/";
  const EIXOS = ["cidade", "autor", "funcao", "gabinete", "trem", "curiosidade"];

  test("todo eixo do pool tem moldura", () => {
    for (const eixo of EIXOS) {
      const t = textoParaLinkedIn("DADO", eixo, LINK);
      expect(t.startsWith("DADO\n\n")).toBe(true);
      expect(t.length).toBeGreaterThan(200);
    }
  });

  test("NENHUMA moldura contém dígito", () => {
    // A garantia do verificar-post.ts vale sobre o texto do X. Cifra ou
    // contagem na moldura entraria sem lastro — é assim que os três números
    // errados já publicados nasceram. Exceção: as ECs do eixo funcao, que
    // vivem no texto gerado, não aqui.
    for (const eixo of EIXOS) {
      const moldura = textoParaLinkedIn("", eixo, "").trim();
      expect({ eixo, digitos: moldura.match(/\d/g) ?? [] }).toEqual({ eixo, digitos: [] });
    }
  });

  test("o dado vem antes da moldura — o corte em ~200 chars não pode comer o número", () => {
    const dado = "R$ 81,2 mi em emendas foram empenhados para o município de Recife (PE).";
    const t = textoParaLinkedIn(dado, "cidade", LINK);
    expect(t.slice(0, 200)).toContain("R$ 81,2 mi");
    expect(t.indexOf("Emenda parlamentar tem autor")).toBeGreaterThan(t.indexOf(dado));
  });

  test("o link é sempre a última coisa", () => {
    for (const eixo of EIXOS) expect(textoParaLinkedIn("DADO", eixo, LINK).endsWith(LINK)).toBe(true);
  });

  test("nenhuma moldura usa verbo de entrega", () => {
    // "recebeu"/"chegou" sobre vlrempenhado é refutável com o próprio banco.
    for (const eixo of EIXOS) {
      expect(textoParaLinkedIn("", eixo, "")).not.toMatch(/receb[ei]|chegar|chegou|entregue/i);
    }
  });

  test("eixo desconhecido não quebra: sai dado + link, sem moldura", () => {
    expect(textoParaLinkedIn("DADO", "eixo-que-nao-existe", LINK)).toBe(`DADO\n\n${LINK}`);
  });
});

describe("url de exibição", () => {
  test("monta a partir do urn devolvido no x-restli-id", () => {
    expect(urlDoPost("urn:li:share:123")).toBe("https://www.linkedin.com/feed/update/urn:li:share:123/");
  });
});
