import { describe, expect, test } from "bun:test";
import { casarCandidato, indexarPorNome, parseCandidatos } from "../src/harvest-candidatos.ts";
import type { Candidato } from "../src/harvest-candidatos.ts";

// Formato conferido contra a resposta real do TSE em 13/08/2026.
// Nenhum teste toca a internet.

const RESPOSTA = {
  cargo: { codigo: 7, nome: "Deputado Estadual" },
  candidatos: [
    {
      id: 170002539230,
      nomeUrna: "ANDRÉ FERREIRA",
      nomeCompleto: "ANDRÉ FERREIRA RODRIGUES",
      numero: 22622,
      partido: { sigla: "PL" },
      descricaoSituacao: "Aguardando julgamento",
      st_REELEICAO: false,
    },
    // sem id: linha inútil, não deve virar registro
    { nomeUrna: "FULANO SEM ID", nomeCompleto: null, partido: { sigla: "X" } },
  ],
};

function cand(over: Partial<Candidato> & Pick<Candidato, "id" | "nome_urna_normalizado">): Candidato {
  return {
    nome_urna: over.nome_urna ?? over.nome_urna_normalizado,
    nome_completo: null,
    nome_completo_normalizado: null,
    numero: null,
    cargo_codigo: 7,
    cargo: "Deputado Estadual",
    partido: null,
    situacao: "Aguardando julgamento",
    ...over,
  };
}

describe("parseCandidatos", () => {
  test("extrai o registro e normaliza nome de urna e nome civil", () => {
    const r = parseCandidatos(RESPOSTA, 7);
    expect(r).toHaveLength(1); // a linha sem id fica de fora
    expect(r[0]).toMatchObject({
      id: 170002539230,
      nome_urna: "ANDRÉ FERREIRA",
      nome_urna_normalizado: "ANDRE FERREIRA",
      nome_completo_normalizado: "ANDRE FERREIRA RODRIGUES",
      cargo: "Deputado Estadual",
      partido: "PL",
      situacao: "Aguardando julgamento",
    });
  });

  test("resposta fora do formato falha alto em vez de gravar lista vazia", () => {
    expect(() => parseCandidatos({ mensagem: "erro" }, 7)).toThrow(/sem array/);
  });
});

describe("casarCandidato — conservador por desenho", () => {
  const indice = indexarPorNome([
    cand({ id: 1, nome_urna_normalizado: "SOCORRO PIMENTEL", cargo: "Deputado Federal", cargo_codigo: 6, partido: "PSD" }),
    cand({ id: 2, nome_urna_normalizado: "TERESA LEITAO", cargo: "Senador", cargo_codigo: 5, partido: "PT" }),
    // dois homônimos, partidos diferentes
    cand({ id: 3, nome_urna_normalizado: "JOAO SILVA", cargo: "Deputado Estadual", partido: "PP" }),
    cand({ id: 4, nome_urna_normalizado: "JOAO SILVA", cargo: "Deputado Federal", cargo_codigo: 6, partido: "PSB" }),
  ]);

  test("mesmo cargo do mandato atual conta como reeleição", () => {
    const v = casarCandidato("SOCORRO PIMENTEL", "Deputado Federal", indice);
    expect(v).toEqual({ situacao: "candidato", cargo_2026: "Deputado Federal", partido: "PSD", reeleicao: true, candidato_id: 1 });
  });

  test("cargo diferente NÃO é reeleição — deputada estadual concorrendo a federal", () => {
    const v = casarCandidato("SOCORRO PIMENTEL", "Deputado Estadual", indice);
    expect(v).toMatchObject({ situacao: "candidato", cargo_2026: "Deputado Federal", reeleicao: false });
  });

  test("ausente da lista vira sem-registro, nunca 'não é candidato'", () => {
    expect(casarCandidato("QUEM NAO REGISTROU", "Deputado Estadual", indice)).toEqual({ situacao: "sem-registro" });
  });

  test("homônimo sem partido conhecido não recebe marcador", () => {
    const v = casarCandidato("JOAO SILVA", "Deputado Estadual", indice);
    expect(v.situacao).toBe("ambiguo");
  });

  test("homônimo é resolvido quando o partido desempata", () => {
    const v = casarCandidato("JOAO SILVA", "Deputado Federal", indice, "PSB");
    expect(v).toMatchObject({ situacao: "candidato", candidato_id: 4, reeleicao: true });
  });

  test("partido que não bate com nenhum homônimo continua ambíguo", () => {
    expect(casarCandidato("JOAO SILVA", "Deputado Estadual", indice, "MDB").situacao).toBe("ambiguo");
  });
});

describe("indexarPorNome", () => {
  test("indexa por nome de urna e por nome civil, sem duplicar o candidato", () => {
    const c = cand({
      id: 9,
      nome_urna_normalizado: "ZE DA SILVA",
      nome_completo: "JOSE DA SILVA SOBRINHO",
      nome_completo_normalizado: "JOSE DA SILVA SOBRINHO",
    });
    const idx = indexarPorNome([c]);
    expect(idx.get("ZE DA SILVA")).toHaveLength(1);
    expect(idx.get("JOSE DA SILVA SOBRINHO")).toHaveLength(1);
    // achado pelos dois caminhos, mas é uma pessoa só
    const v = casarCandidato("JOSE DA SILVA SOBRINHO", "Deputado Estadual", idx);
    expect(v).toMatchObject({ situacao: "candidato", candidato_id: 9 });
  });
});
