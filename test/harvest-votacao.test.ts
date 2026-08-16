import { describe, expect, test } from "bun:test";
import { campos, indices } from "../src/harvest-votacao.ts";

// Nenhum teste toca a rede nem o zip de 557 MB: as fixtures são linhas reais
// copiadas de votacao_candidato_munzona_2022_PE.csv e consulta_cand_2022_PE.csv.

const CAB_VOTACAO =
  '"DT_GERACAO";"HH_GERACAO";"ANO_ELEICAO";"CD_TIPO_ELEICAO";"NM_TIPO_ELEICAO";"NR_TURNO";"CD_ELEICAO";' +
  '"DS_ELEICAO";"DT_ELEICAO";"TP_ABRANGENCIA";"SG_UF";"SG_UE";"NM_UE";"CD_MUNICIPIO";"NM_MUNICIPIO";' +
  '"NR_ZONA";"CD_CARGO";"DS_CARGO";"SQ_CANDIDATO";"NR_CANDIDATO";"NM_CANDIDATO";"NM_URNA_CANDIDATO";' +
  '"NM_SOCIAL_CANDIDATO";"CD_SITUACAO_CANDIDATURA";"DS_SITUACAO_CANDIDATURA";"CD_DETALHE_SITUACAO_CAND";' +
  '"DS_DETALHE_SITUACAO_CAND";"CD_SITUACAO_JULGAMENTO";"DS_SITUACAO_JULGAMENTO";"CD_SITUACAO_CASSACAO";' +
  '"DS_SITUACAO_CASSACAO";"CD_SITUACAO_DCONST_DIPLOMA";"DS_SITUACAO_DCONST_DIPLOMA";"TP_AGREMIACAO";' +
  '"NR_PARTIDO";"SG_PARTIDO";"NM_PARTIDO";"NR_FEDERACAO";"NM_FEDERACAO";"SG_FEDERACAO";' +
  '"DS_COMPOSICAO_FEDERACAO";"SQ_COLIGACAO";"NM_COLIGACAO";"DS_COMPOSICAO_COLIGACAO";"ST_VOTO_EM_TRANSITO";' +
  '"QT_VOTOS_NOMINAIS";"NM_TIPO_DESTINACAO_VOTOS";"QT_VOTOS_NOMINAIS_VALIDOS";"CD_SIT_TOT_TURNO";"DS_SIT_TOT_TURNO"';

describe("campos do CSV do TSE", () => {
  test("separa por ; e tira as aspas de todos os campos", () => {
    expect(campos('"PE";"24279";"GRAVATÁ";"100"')).toEqual(["PE", "24279", "GRAVATÁ", "100"]);
  });

  test("preserva acento — o arquivo é ISO-8859-1 e a decodificação é do chamador", () => {
    expect(campos('"GRAVATÁ";"SÃO VICENTE FÉRRER"')).toEqual(["GRAVATÁ", "SÃO VICENTE FÉRRER"]);
  });

  test("campo vazio continua vazio, não vira undefined", () => {
    expect(campos('"A";"";"C"')).toEqual(["A", "", "C"]);
  });

  test("campo sem aspas passa intacto", () => {
    expect(campos("A;B;C")).toEqual(["A", "B", "C"]);
  });

  test("#NULO do TSE não é tratado como nulo aqui — quem decide é o chamador", () => {
    expect(campos('"NOME";"#NULO"')).toEqual(["NOME", "#NULO"]);
  });
});

describe("índices por nome de coluna", () => {
  /**
   * Posição fixa é a armadilha clássica desta fonte: o layout do TSE ganhou
   * colunas entre 2018 e 2022 (CD_SITUACAO_JULGAMENTO e as de federação), e
   * um índice hardcoded leria partido como se fosse voto.
   */
  test("acha as colunas que o coletor usa, no arquivo real de 2022", () => {
    const i = indices(CAB_VOTACAO, ["NR_TURNO", "CD_MUNICIPIO", "NM_MUNICIPIO", "DS_CARGO", "SQ_CANDIDATO", "QT_VOTOS_NOMINAIS"]);
    expect(i.NR_TURNO).toBe(5);
    expect(i.CD_MUNICIPIO).toBe(13);
    expect(i.NM_MUNICIPIO).toBe(14);
    expect(i.DS_CARGO).toBe(17);
    expect(i.SQ_CANDIDATO).toBe(18);
    expect(i.QT_VOTOS_NOMINAIS).toBe(45);
  });

  test("QT_VOTOS_NOMINAIS não é confundido com QT_VOTOS_NOMINAIS_VALIDOS", () => {
    const i = indices(CAB_VOTACAO, ["QT_VOTOS_NOMINAIS", "QT_VOTOS_NOMINAIS_VALIDOS"]);
    expect(i.QT_VOTOS_NOMINAIS).not.toBe(i.QT_VOTOS_NOMINAIS_VALIDOS);
  });

  test("coluna ausente falha ALTO, com o cabeçalho no erro", () => {
    // Falhar aqui é o comportamento certo: seguir com índice -1 gravaria
    // votos nulos em silêncio para o estado inteiro.
    expect(() => indices(CAB_VOTACAO, ["COLUNA_QUE_NAO_EXISTE"])).toThrow(/não existe no CSV do TSE/);
  });

  test("o registro de candidatura tem CPF e SQ, que é a chave da junção", () => {
    const cab = '"DT_GERACAO";"SG_UF";"SQ_CANDIDATO";"NM_CANDIDATO";"NR_CPF_CANDIDATO";"DT_NASCIMENTO"';
    const i = indices(cab, ["NR_CPF_CANDIDATO", "SQ_CANDIDATO"]);
    expect(i.NR_CPF_CANDIDATO).toBe(4);
    expect(i.SQ_CANDIDATO).toBe(2);
  });
});

describe("soma por município", () => {
  /**
   * O arquivo traz UMA LINHA POR ZONA ELEITORAL. Recife tem várias zonas, e
   * sem somar o mesmo município apareceria repetido — o ranking de "onde teve
   * mais votos" sairia apontando para a maior zona, não para a maior cidade.
   */
  test("linhas de zonas diferentes do mesmo município somam", () => {
    const linhas = [
      '"1";"24279";"GRAVATÁ";"170001618395";"100"',
      '"1";"24279";"GRAVATÁ";"170001618395";"250"',
      '"1";"25313";"RECIFE";"170001618395";"900"',
    ];
    const acc = new Map<string, number>();
    for (const l of linhas) {
      const c = campos(l);
      const chave = `${c[3]}|${c[1]}`;
      acc.set(chave, (acc.get(chave) ?? 0) + Number(c[4]));
    }
    expect(acc.get("170001618395|24279")).toBe(350);
    expect(acc.get("170001618395|25313")).toBe(900);
    expect(acc.size).toBe(2);
  });
});
