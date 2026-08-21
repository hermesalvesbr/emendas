// Fatos da Transnordestina (EF-232), do dossiê de 20/08/2026.
//
// Fato EXTERNO ao banco, versionado aqui pela mesma razão que
// `populacao-pe.ts`: número escrito de memória já foi publicado errado duas
// vezes. Cada entrada carrega o id da fonte no dossiê
// (~/Projetos/CHINA/transnordestina/fontes.md), que é onde estão URL, data de
// acesso e o arquivo baixado.
//
// Este módulo NÃO calcula nada. Se um número não está aqui com um [Fxx] ao
// lado, ele não pode ir para um post — declarar como "conferido" um número
// derivado transforma o verificador em carimbo (NOTAS 33).
//
// Regras de redação herdadas da seção 11 do dossiê, mecanizadas onde deu:
//
//   - Possibilidade não é promessa. Nada aqui autoriza "quando o trem
//     chegar": o verificador reprova a frase.
//   - Suape não é o Recife, e a bitola quebra no caminho. As duas ressalvas
//     andam juntas com qualquer menção a chegar à capital.
//   - Os quilômetros de ferrovia em Araripina não têm casa decimal: o quadro
//     do estudo ambiental é internamente inconsistente. Só "mais de vinte" e
//     a comparação com Trindade.
//   - O ganho do gesso não é automático: o próprio TCU aponta desvantagem da
//     bitola larga para granel leve.
//   - Divergência de fonte se exibe, não se arbitra (82% x 81%).

/** Data de corte da apuração do dossiê. Status voláteis expiram a partir daqui. */
export const APURACAO_TRANSNORDESTINA = "2026-08-20";

export type FatoExterno = {
  valor: number;
  rotulo: string;
  /** Id da fonte no dossiê, para rastrear até o documento. */
  fonte: string;
};

/**
 * Todo número citável da pauta. O rótulo é a frase que descreve o valor — é
 * ele que o verificador exige que o post esteja de fato afirmando, e não
 * qualquer outro fato de mesmo valor.
 */
export const FATOS_TRANSNORDESTINA: readonly FatoExterno[] = [
  // --- corredor principal, rumo ao Ceará
  { valor: 1206, rotulo: "km da fase 1 da Transnordestina", fonte: "F15" },
  { valor: 777, rotulo: "km concluídos da fase 1 em julho de 2026", fonte: "F15" },
  { valor: 82, rotulo: "% de execução da fase 1 pela Agência Brasil", fonte: "F15" },
  { valor: 81, rotulo: "% de execução da fase 1 pelo release da CSN", fonte: "F15" },
  { valor: 679, rotulo: "km liberados ao tráfego em regime de comissionamento", fonte: "F01" },
  { valor: 163, rotulo: "km entre Trindade e Salgueiro", fonte: "F01" },
  { valor: 96, rotulo: "km entre Salgueiro e Missão Velha", fonte: "F36" },
  { valor: 420, rotulo: "km entre Eliseu Martins e Trindade", fonte: "F36" },
  { valor: 527, rotulo: "km entre Missão Velha e Pecém", fonte: "F36" },
  { valor: 676, rotulo: "km de grade ferroviária montada em 31/12/2025", fonte: "F36" },
  { valor: 80, rotulo: "% da fase 1 declarado pela concessionária em 31/12/2025", fonte: "F36" },
  { valor: 41, rotulo: "km/h mínimos da classificação C31 de comissionamento", fonte: "F01" },
  { valor: 64, rotulo: "km/h máximos da classificação C31 de comissionamento", fonte: "F01" },

  // --- ramal pernambucano
  { valor: 544, rotulo: "km do ramal de Salgueiro a Suape", fonte: "F25" },
  { valor: 38, rotulo: "% executado do ramal de Salgueiro a Suape", fonte: "F25" },
  { valor: 238, rotulo: "km do ramal que não tiveram obra iniciada", fonte: "F25" },
  { valor: 179, rotulo: "km concluídos nos lotes SPS 01 a 03", fonte: "F25" },
  { valor: 73, rotulo: "km do lote SPS 04", fonte: "F06" },
  { valor: 312800000, rotulo: "valor contratado do lote SPS 04", fonte: "F06" },
  { valor: 1.6, rotulo: "bitola da Transnordestina, em metros", fonte: "F25" },

  // --- Araripe
  { valor: 35, rotulo: "km de rodovia entre Araripina e Trindade", fonte: "F42" },
  { valor: 15000, rotulo: "toneladas por mês que a Siqueira Mineração move pela ferrovia", fonte: "F17" },
  { valor: 100000, rotulo: "toneladas por mês esperadas na operação plena", fonte: "F17" },
  // Os dois lados do mesmo salto, com rótulos distintos de propósito: 100 mil
  // é ao mesmo tempo o teto do que a rodovia move hoje e a expectativa da
  // ferrovia na operação plena. Valor igual, assunto diferente — é a colisão
  // que `rotulosEsperados` existe para pegar.
  { valor: 70000, rotulo: "toneladas por mês escoadas por rodovia, piso", fonte: "F17" },
  { valor: 100000, rotulo: "toneladas por mês escoadas por rodovia, teto", fonte: "F17" },
  { valor: 20000, rotulo: "toneladas mensais de grãos previstas no comissionamento", fonte: "F01" },
  { valor: 10000, rotulo: "toneladas mensais de gipsita previstas no comissionamento", fonte: "F01" },
  { valor: 3000, rotulo: "toneladas mensais de gesso agrícola previstas no comissionamento", fonte: "F01" },

  // --- malha antiga e precedentes
  { valor: 608, rotulo: "km da linha histórica do Recife a Salgueiro", fonte: "F21" },
  { valor: 3001, rotulo: "km da malha nordestina devolvidos pela FTL", fonte: "F22" },
  { valor: 1780000000, rotulo: "indenização acordada na devolução da malha", fonte: "F22" },
  { valor: 2, rotulo: "pares de trens de passageiros por dia no contrato de 1997", fonte: "F33" },
  { valor: 17, rotulo: "km/h autorizados ao Trem do Forró", fonte: "F24" },
  { valor: 120, rotulo: "km do estudo de trem de passageiros entre Recife e Caruaru", fonte: "F20" },
  { valor: 240, rotulo: "km do corredor de Fortaleza a Sobral", fonte: "F23" },
  { valor: 6, rotulo: "corredores-piloto de trem regional do Ministério dos Transportes", fonte: "F19" },
  { valor: 13, rotulo: "trens turísticos em operação com outorga da ANTT", fonte: "F19" },
  { valor: 90, rotulo: "dias de antecedência para pedir Contrato Operacional Específico", fonte: "F37" },
  { valor: 7, rotulo: "condições da cadeia para um trem de passageiros no Araripe", fonte: "dossiê 9.6" },
];

/** Índice por rótulo, para o template pedir o fato pelo nome e não pelo valor. */
export const FATO_TREM = new Map(FATOS_TRANSNORDESTINA.map((f) => [f.rotulo, f] as const));

/** Pega um fato pelo rótulo, quebrando alto se o rótulo mudou. */
export function fatoTrem(rotulo: string): FatoExterno {
  const f = FATO_TREM.get(rotulo);
  if (!f) throw new Error(`transnordestina: fato "${rotulo}" não existe — rótulo mudou ou número não versionado`);
  return f;
}
