import { describe, expect, test } from "bun:test";
import { casarCandidato, indexarPorNome, parseCandidatos, parseDetalhe, parseSuplentes } from "../src/harvest-candidatos.ts";
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

describe("parseSuplentes — outro padrão de campo na mesma API", () => {
  // Chaves em SCREAMING_SNAKE conferidas na resposta real de 13/08/2026.
  const DETALHE = {
    nomeUrna: "CARLOS SANT'ANNA",
    vices: [
      { sq_CANDIDATO: 170002530098, nm_URNA: "CARLA PINHEIRO", nm_CANDIDATO: "CARLA MARIA PINHEIRO", nr_CANDIDATO: 700, ds_CARGO: "1º Suplente", sg_PARTIDO: "NOVO", descricaoTotalizacao: "Concorrendo" },
      { sq_CANDIDATO: 170002530099, nm_URNA: "HERMES ALVES", nm_CANDIDATO: null, ds_CARGO: "2º Suplente", sg_PARTIDO: "NOVO" },
      { sq_CANDIDATO: null, nm_URNA: "SEM ID" },
    ],
  };

  test("extrai suplentes e amarra ao titular", () => {
    const r = parseSuplentes(DETALHE, 170002530097);
    expect(r).toHaveLength(2); // o sem id fica de fora
    expect(r[0]).toMatchObject({
      id: 170002530098,
      nome_urna: "CARLA PINHEIRO",
      nome_completo_normalizado: "CARLA MARIA PINHEIRO",
      cargo: "1º Suplente",
      cargo_codigo: 5,
      partido: "NOVO",
      id_titular: 170002530097,
    });
    expect(r[1]?.nome_completo).toBeNull();
  });

  test("candidato sem vices devolve lista vazia em vez de quebrar", () => {
    expect(parseSuplentes({ nomeUrna: "X" }, 1)).toEqual([]);
    expect(parseSuplentes({ vices: null }, 1)).toEqual([]);
  });
});

describe("parseDetalhe — bens e região", () => {
  test("lê patrimônio, contagem de itens e deriva a região da naturalidade", () => {
    const d = parseDetalhe({
      totalDeBens: 889100,
      bens: [{ valor: 125000 }, { valor: 7600 }],
      nomeMunicipioNascimento: "ARARIPINA",
      sgUfNascimento: "PE",
      ocupacao: "Advogado",
      grauInstrucao: "Superior completo",
      descricaoSexo: "MASC.",
    });
    expect(d).toMatchObject({
      total_bens: 889100,
      qtd_bens: 2,
      municipio_nascimento: "ARARIPINA",
      regiao: "Sertão do Araripe",
      ocupacao: "Advogado",
    });
  });

  test("nascido fora de PE não recebe região — é candidato do estado, não da região", () => {
    const d = parseDetalhe({ totalDeBens: 0, bens: [], nomeMunicipioNascimento: "SAO PAULO", sgUfNascimento: "SP" });
    expect(d.regiao).toBeNull();
    expect(d.uf_nascimento).toBe("SP");
  });

  test("sem bens declarados vira zero explícito, não null", () => {
    const d = parseDetalhe({ totalDeBens: 0, bens: [] });
    expect(d.total_bens).toBe(0);
    expect(d.qtd_bens).toBe(0);
  });

  test("campos ausentes viram null em vez de undefined ou string vazia", () => {
    const d = parseDetalhe({});
    expect(d).toEqual({
      total_bens: null, qtd_bens: null, municipio_nascimento: null, uf_nascimento: null,
      regiao: null, ocupacao: null, grau_instrucao: null, sexo: null,
      cpf: null, data_nascimento: null,
    });
  });

  test("CPF sai só com dígitos e preserva zero à esquerda", () => {
    // O TSE devolve sem máscara em 2026 e com zeros à esquerda em
    // consulta_cand_2022. Perder um zero silenciaria o casamento do candidato
    // com a própria votação — falha muda, não erro.
    expect(parseDetalhe({ cpf: "02260496474" }).cpf).toBe("02260496474");
    expect(parseDetalhe({ cpf: "022.604.964-74" }).cpf).toBe("02260496474");
    expect(parseDetalhe({ cpf: "" }).cpf).toBeNull();
  });

  test("data de nascimento é preservada como o TSE manda", () => {
    expect(parseDetalhe({ dataDeNascimento: "1982-10-27" }).data_nascimento).toBe("1982-10-27");
  });
});
