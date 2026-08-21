// Temas da série sobre trem de passageiros na Transnordestina.
//
// Diferente dos outros eixos, aqui não há recorte de banco para varrer: o
// material é um dossiê fechado em 20/08/2026, e cada tema é um fato dele. Por
// isso a lista é escrita à mão — mas os NÚMEROS não são: vêm de
// `transnordestina.ts`, com o id da fonte colado, e o verificador confere cada
// um contra esse índice antes de o post entrar no pool.
//
// A regra que organiza o arquivo: **possibilidade não é promessa**. O dossiê
// conclui que, em 20/08/2026, não existe projeto, estudo, contrato,
// autorização, orçamento nem interessado em transporte de passageiros neste
// eixo. O que existe é uma porta jurídica aberta que ninguém atravessou. Post
// que trate a hipótese como agendada afirma o que nenhuma fonte sustenta — e
// o verificador reprova as frases mais óbvias desse tipo.
//
// Três ressalvas são obrigatórias e por isso entram com prioridade alta, para
// sobreviverem ao corte de 280 e à versão assinada:
//
//   - Suape não é o Recife, e a bitola quebra no caminho;
//   - o ganho logístico do gesso não é automático (o TCU aponta desvantagem
//     da bitola larga para granel leve);
//   - percentual de obra declarado pela concessionária não é auditado.

import type { Camada } from "./gerar-posts.ts";
import type { Fato } from "./verificar-post.ts";
import { fatoTrem } from "./transnordestina.ts";

export type Postura = "dado" | "campanha";

export type TemaTrem = {
  /** Sufixo do id: vira "trem:<slug>". */
  slug: string;
  postura: Postura;
  camadas: Camada[];
  fatos: Fato[];
  /** Ordena o eixo: quanto maior, mais cedo (e em horário de pico). */
  peso_editorial: number;
};

/**
 * Fato do índice pelo rótulo. O rótulo do post tem de ser IGUAL ao que
 * `indiceDeFatos` publica ("<rótulo> [Fxx]"), senão o número casa por valor e
 * é reprovado por rótulo divergente — que é exatamente o que se quer.
 */
function f(rotulo: string): Fato {
  const achado = fatoTrem(rotulo);
  return { valor: achado.valor, rotulo: `${achado.rotulo} [${achado.fonte}]` };
}

/**
 * Fechos assinados desta pauta. Os genéricos da série falam do painel de
 * emendas; colados num post sobre ferrovia, mudam de assunto no último
 * parágrafo.
 */
export const FECHOS_TREM: readonly string[] = [
  "Defendo que Pernambuco peça o seu trem de passageiros.",
  "Sou de Araripina e quero essa pergunta em cima da mesa.",
  "Levantei isso porque ninguém tinha levantado.",
  "Não é sonho: é cláusula em vigor esperando quem acione.",
  "Quem mora no sertão paga a conta da distância todo mês.",
];

export function temasTrem(): TemaTrem[] {
  const t: TemaTrem[] = [];
  const add = (
    slug: string,
    postura: Postura,
    peso_editorial: number,
    camadas: Camada[],
    fatos: Fato[] = [],
  ): void => {
    t.push({ slug, postura, peso_editorial, camadas, fatos });
  };

  // ---------------------------------------------- a porta que já está aberta
  //
  // O achado central do dossiê, e o material mais forte da pauta: a barreira
  // que todo mundo supõe intransponível não existe.

  add("contrato-passagem", "dado", 100, [
    { texto: "O contrato da Transnordestina obriga a concessionária a assegurar a passagem de trens de passageiros, sempre que um operador ferroviário requerer.", prioridade: 100 },
    { texto: "A cláusula está em vigor desde 2014.", prioridade: 90 },
    { texto: "Nenhum operador requereu até hoje.", prioridade: 80 },
  ]);

  add("ninguem-pediu", "campanha", 98, [
    { texto: "A obrigação de deixar passar trem de passageiros está no contrato da Transnordestina há mais de uma década. Ninguém em Pernambuco bateu nessa porta.", prioridade: 100 },
  ]);

  add("falta-pedido", "campanha", 96, [
    { texto: "Para um trem de passageiros no sertão de Pernambuco, o que falta não é permissão: é ferrovia construída, alguém que peça e dinheiro que sustente.", prioridade: 100 },
  ]);

  add("lei-atf", "dado", 92, [
    { texto: "A Lei 14.273/2021 criou o agente transportador ferroviário: quem transporta passageiros sem ser dono dos trilhos.", prioridade: 100 },
    { texto: "Basta registro no regulador para requerer acesso à via de terceiro.", prioridade: 90 },
    { texto: "Neste eixo, ninguém se registrou.", prioridade: 80 },
  ]);

  add("politica-nacional", "dado", 90, [
    { texto: "Em novembro de 2025 o Ministério dos Transportes instituiu a Política Nacional de Transporte Ferroviário de Passageiros.", prioridade: 100 },
    { texto: "Ela define como objetivo aproveitar a malha existente para passageiros, inclusive a ociosa ou subutilizada.", prioridade: 90 },
    { texto: "Em Pernambuco, malha ociosa é a linha antiga do Recife a Salgueiro.", prioridade: 80 },
  ]);

  add("subsidio-previsto", "dado", 84, [
    { texto: "A política nacional de trens de passageiros admite que esses serviços sejam sustentados por subsídio ou subvenção.", prioridade: 100 },
    { texto: "O Estado brasileiro já reconheceu, em norma, que trem regional de gente pode não se pagar pela tarifa.", prioridade: 90 },
    { texto: "Deixa de ser argumento contra e passa a ser decisão de orçamento.", prioridade: 70 },
  ]);

  add("malha-antiga-dois-pares", "dado", 82, [
    { texto: "O contrato da malha antiga que serve o Recife, de 1997, obriga a assegurar a passagem de até 2 pares de trens de passageiros por dia.", prioridade: 100 },
    { texto: "A obrigação é quantificada e só depende de um patamar de tráfego na linha.", prioridade: 90 },
    { texto: "Essa linha está abandonada.", prioridade: 70 },
  ], [f("pares de trens de passageiros por dia no contrato de 1997")]);

  add("coe-90-dias", "dado", 70, [
    { texto: "Para rodar sobre trilho de terceiro existe um instrumento pronto: o Contrato Operacional Específico, regulado pela ANTT.", prioridade: 100 },
    { texto: "O pedido precisa ser feito com pelo menos 90 dias de antecedência, e a celebração é obrigatória.", prioridade: 90 },
    { texto: "É burocracia conhecida, não obstáculo novo.", prioridade: 70 },
  ], [f("dias de antecedência para pedir Contrato Operacional Específico")]);

  add("sem-prioridade", "dado", 74, [
    { texto: "A norma de compartilhamento ferroviário não fixa prioridade entre trem de passageiros e trem de carga na mesma via.", prioridade: 100 },
    { texto: "Numa ferrovia feita para minério, grãos e gesso, a pontualidade dependeria de negociação, não de garantia.", prioridade: 90 },
    { texto: "É aqui que mora a fragilidade real, e não na permissão para circular.", prioridade: 80 },
  ]);

  add("janela-desestatizacao", "campanha", 94, [
    { texto: "O ramal pernambucano da Transnordestina está em estudo para ser concedido. É no desenho desse contrato que uma obrigação de levar passageiros pode entrar.", prioridade: 100 },
  ]);

  add("precedente-vale", "dado", 88, [
    { texto: "Os dois únicos trens regulares de passageiros de longa distância do Brasil são os da Vale, em Minas e no Pará.", prioridade: 100 },
    { texto: "Eles não existem por viabilidade de mercado: nasceram de obrigação assumida na renovação das concessões, em 2020.", prioridade: 90 },
    { texto: "No Brasil, trem de gente sobre ferrovia de carga tem sido contrapartida de contrato.", prioridade: 80 },
  ]);

  add("outorgas-turisticas", "dado", 60, [
    { texto: "A ANTT registra cerca de 13 trens turísticos e histórico-culturais em operação no país.", prioridade: 100 },
    { texto: "É um regime próprio, autorizado caso a caso, mais simples que o serviço regular.", prioridade: 90 },
    { texto: "Nenhum deles usa a Transnordestina.", prioridade: 80 },
  ], [f("trens turísticos em operação com outorga da ANTT")]);

  add("evtea-passageiros", "dado", 76, [
    { texto: "O estudo de viabilidade da própria Transnordestina já contabilizou trens de passageiros no dimensionamento diário da via.", prioridade: 100 },
    { texto: "Foi em outro ramal, no Piauí e no Maranhão — mas mostra que a hipótese nunca foi estranha ao projeto.", prioridade: 90 },
  ]);

  add("antt-carga", "dado", 78, [
    { texto: "A ANTT liberou ao tráfego cerca de 679 km da Transnordestina em regime de teste, em outubro de 2025.", prioridade: 100 },
    { texto: "A autorização é expressa: transporte público ferroviário de cargas. Passageiro não aparece em nenhuma linha dela.", prioridade: 90 },
  ], [f("km liberados ao tráfego em regime de comissionamento")]);

  // ------------------------------------------------- a ferrovia que existe

  add("fase1-avanco", "dado", 86, [
    { texto: "A primeira fase da Transnordestina, de Eliseu Martins ao Porto do Pecém, tinha 777 dos 1.206 km concluídos em julho de 2026.", prioridade: 100 },
    { texto: "É a obra que avança, e ela vai para o Ceará.", prioridade: 90 },
    { texto: "O trecho que chegaria a Pernambuco é outro.", prioridade: 80 },
  ], [f("km concluídos da fase 1 em julho de 2026"), f("km da fase 1 da Transnordestina")]);

  add("divergencia-82-81", "dado", 58, [
    { texto: "A execução da primeira fase da Transnordestina aparece como 82% na Agência Brasil e como 81% no release da própria CSN.", prioridade: 100 },
    { texto: "São apurações de datas e critérios distintos.", prioridade: 90 },
    { texto: "As duas ficam registradas, sem arbitrar a mais conveniente.", prioridade: 80 },
  ], [f("% de execução da fase 1 pela Agência Brasil"), f("% de execução da fase 1 pelo release da CSN")]);

  add("trindade-salgueiro", "dado", 80, [
    { texto: "Entre Trindade e Salgueiro há 163 km de ferrovia construídos e já liberados ao tráfego de carga em regime de teste.", prioridade: 100 },
    { texto: "É trilho pronto, dentro do sertão de Pernambuco.", prioridade: 90 },
    { texto: "Não há nenhuma estação de passageiros nesse trecho.", prioridade: 80 },
  ], [f("km entre Trindade e Salgueiro")]);

  add("velocidade-c31", "dado", 56, [
    { texto: "No regime de teste, a Transnordestina roda entre 41 e 64 km/h.", prioridade: 100 },
    { texto: "É a classificação declarada à ANTT para o período de comissionamento, com restrição adicional onde há pendências na via.", prioridade: 90 },
  ], [f("km/h mínimos da classificação C31 de comissionamento"), f("km/h máximos da classificação C31 de comissionamento")]);

  add("grade-montada", "dado", 54, [
    { texto: "A concessionária declarou 676 km de grade ferroviária montada ao fim de 2025.", prioridade: 100 },
    { texto: "O número é declaração da administração: a própria companhia registra que esses percentuais não passaram pelos auditores independentes.", prioridade: 85 },
  ], [f("km de grade ferroviária montada em 31/12/2025")]);

  add("eliseu-trindade", "dado", 52, [
    { texto: "O trecho de Eliseu Martins a Trindade tem 420 km e avanço declarado de 80% ao fim de 2025.", prioridade: 100 },
    { texto: "Percentual informado pela concessionária, fora do escopo de exame dos auditores independentes.", prioridade: 85 },
  ], [f("km entre Eliseu Martins e Trindade"), f("% da fase 1 declarado pela concessionária em 31/12/2025")]);

  add("salgueiro-missao-velha", "dado", 50, [
    { texto: "O trecho de Salgueiro a Missão Velha, 96 km, está declarado como concluído.", prioridade: 100 },
    { texto: "É a costura da ferrovia pernambucana com o corredor que segue para o Ceará.", prioridade: 90 },
    { texto: "Percentual declarado pela concessionária, não auditado.", prioridade: 85 },
  ], [f("km entre Salgueiro e Missão Velha")]);

  // ------------------------------------------------ o ramal pernambucano

  add("ramal-544", "dado", 96, [
    { texto: "O ramal que ligaria Salgueiro a Suape tem cerca de 544 km e está em torno de 38% executado.", prioridade: 100 },
    { texto: "É o trecho que traria a ferrovia para dentro de Pernambuco, e é o que não anda.", prioridade: 90 },
  ], [f("km do ramal de Salgueiro a Suape"), f("% executado do ramal de Salgueiro a Suape")]);

  add("238-sem-obra", "dado", 94, [
    { texto: "No ramal de Salgueiro a Suape, cerca de 238 km sequer tiveram obra iniciada.", prioridade: 100 },
    { texto: "Não é obra atrasada nesse pedaço: é obra que não começou.", prioridade: 90 },
  ], [f("km do ramal que não tiveram obra iniciada")]);

  add("lote-sps04", "dado", 72, [
    { texto: "O primeiro lote do ramal pernambucano, com 73 km, foi contratado em abril de 2026 por R$ 312,8 mi.", prioridade: 100 },
    { texto: "A execução física continua vedada: o contrato existe, a obra não começou.", prioridade: 90 },
  ], [f("km do lote SPS 04"), f("valor contratado do lote SPS 04")]);

  add("tcu-vedacao", "dado", 90, [
    { texto: "Em maio de 2026 o TCU determinou que o Ministério dos Transportes e a Infra S.A. não assumam novos compromissos financeiros no ramal de Suape.", prioridade: 100 },
    { texto: "A condição é demonstrar, em base técnica atual e idônea, a vantajosidade do empreendimento.", prioridade: 90 },
  ]);

  add("tcu-tres-acordaos", "dado", 44, [
    { texto: "Sobre a Transnordestina existem três decisões distintas do TCU em 2026, e elas não se confundem.", prioridade: 100 },
    { texto: "Uma trata da devolução da malha antiga, outra veda novos compromissos no ramal de Suape, a terceira é uma liberação parcial que manteve a obra vedada.", prioridade: 90 },
  ]);

  add("tracado-suape-pendente", "dado", 68, [
    { texto: "O traçado do trecho final do ramal, junto ao Porto de Suape, ainda está pendente de definição.", prioridade: 100 },
    { texto: "Não é detalhe de engenharia: é o pedaço que decide onde a ferrovia encosta no litoral.", prioridade: 90 },
  ]);

  add("suape-nao-e-recife", "dado", 92, [
    { texto: "O ramal da Transnordestina termina em Suape, não no Recife.", prioridade: 100 },
    { texto: "Não há ligação ferroviária prevista entre um ponto e outro, e a bitola muda: a Transnordestina é de 1,60 m e a malha metropolitana é métrica.", prioridade: 95 },
    { texto: "Um trem da Transnordestina não roda nos trilhos do Recife.", prioridade: 80 },
  ], [f("bitola da Transnordestina, em metros")]);

  add("terceiro-trilho", "dado", 46, [
    { texto: "Em outubro de 2025, a ANTT autorizou retirar provisoriamente o terceiro trilho em trechos que teriam bitola mista.", prioridade: 100 },
    { texto: "Isso reduz ainda mais a possibilidade de um trem passar de uma malha para a outra.", prioridade: 90 },
  ]);

  // ------------------------------------------------------------- o Araripe

  add("araripina-trilhos", "campanha", 99, [
    { texto: "A Transnordestina corta Araripina por mais de vinte quilômetros, mais de três vezes o que corta Trindade. O terminal previsto fica em Trindade.", prioridade: 100 },
  ]);

  add("araripina-parada", "campanha", 97, [
    { texto: "Se um dia houver trem de passageiros nessa ferrovia, Araripina não precisa de trilho novo: os trilhos já cruzam o município. Falta uma parada.", prioridade: 100 },
  ]);

  add("terminal-trindade", "dado", 76, [
    { texto: "O equipamento da Transnordestina previsto para o Araripe é um terminal de carga em Trindade, voltado ao polo gesseiro.", prioridade: 100 },
    { texto: "Dois fluxos declarados: gesso agrícola para o sul do Piauí, e gipsita e gesso para exportação pelo Pecém.", prioridade: 90 },
    { texto: "O Araripe entrou no mapa como carregador, não como origem de gente.", prioridade: 80 },
  ]);

  add("araripina-trindade-35km", "dado", 66, [
    { texto: "Entre Araripina e Trindade há cerca de 35 km de rodovia.", prioridade: 100 },
    { texto: "Mesmo no melhor cenário imaginável, um passageiro de Araripina começaria a viagem de carro ou de ônibus até o terminal.", prioridade: 90 },
  ], [f("km de rodovia entre Araripina e Trindade")]);

  add("gesso-ja-andou", "dado", 82, [
    { texto: "O gesso do Araripe já andou de trem: uma mineradora embarca em Trindade e move hoje cerca de 15 mil toneladas por mês pela ferrovia.", prioridade: 100 },
    { texto: "A expectativa da empresa é chegar a 100 mil toneladas quando a operação estiver consolidada.", prioridade: 90 },
  ], [f("toneladas por mês que a Siqueira Mineração move pela ferrovia"), f("toneladas por mês esperadas na operação plena")]);

  add("rodovia-hoje", "dado", 64, [
    { texto: "Os produtores do polo gesseiro escoam hoje entre 70 mil e 100 mil toneladas por mês por rodovia.", prioridade: 100 },
    { texto: "É o tamanho do que a ferrovia pode tirar do asfalto do sertão.", prioridade: 90 },
  ], [f("toneladas por mês escoadas por rodovia, piso"), f("toneladas por mês escoadas por rodovia, teto")]);

  add("previsao-comissionamento", "dado", 48, [
    { texto: "Para o período de teste, a concessionária previu à ANTT 20 mil toneladas mensais de grãos, 10 mil de gipsita e 3 mil de gesso agrícola.", prioridade: 100 },
    { texto: "O Araripe aparece nessa conta como carga.", prioridade: 90 },
  ], [
    f("toneladas mensais de grãos previstas no comissionamento"),
    f("toneladas mensais de gipsita previstas no comissionamento"),
    f("toneladas mensais de gesso agrícola previstas no comissionamento"),
  ]);

  add("gesso-ressalva-tcu", "dado", 62, [
    { texto: "O ganho da ferrovia para o gesso do Araripe é real, mas não é automático.", prioridade: 100 },
    { texto: "O TCU registra que a bitola larga adotada no trecho pernambucano tem desvantagem econômica para granéis leves, como o gesso.", prioridade: 95 },
  ]);

  add("arcoverde-locomotiva", "dado", 42, [
    { texto: "O TCU aponta que o trecho a partir de Arcoverde tem geometria, rampas e curvas que provavelmente exigirão uma terceira locomotiva de apoio.", prioridade: 100 },
    { texto: "Isso elevaria os custos operacionais do segmento, segundo o próprio tribunal.", prioridade: 90 },
  ]);

  // ------------------------------------------- o que Pernambuco tem hoje

  add("linha-antiga-608", "dado", 86, [
    { texto: "A linha histórica que ligava o Recife a Salgueiro tem cerca de 608 km e está abandonada.", prioridade: 100 },
    { texto: "A estação de Salgueiro deixou de operar em 1992. Hoje há trilho furtado e faixa de domínio ocupada.", prioridade: 90 },
    { texto: "É essa a malha ociosa que a política nacional manda aproveitar.", prioridade: 80 },
  ], [f("km da linha histórica do Recife a Salgueiro")]);

  add("devolucao-3001", "dado", 60, [
    { texto: "Em novembro de 2025 foi firmado no TCU um acordo para devolver cerca de 3.001 km da malha nordestina, com indenização da ordem de R$ 1,78 bi.", prioridade: 100 },
    { texto: "O acordo ainda depende de deliberação final do plenário do tribunal.", prioridade: 90 },
  ], [f("km da malha nordestina devolvidos pela FTL"), f("indenização acordada na devolução da malha")]);

  add("trem-do-forro", "dado", 56, [
    { texto: "O único trem de passageiros interurbano de Pernambuco fora do sistema metropolitano é o Trem do Forró, que circula poucos dias por ano.", prioridade: 100 },
    { texto: "Em autorização anterior, a ANTT fixou velocidade máxima de 17 km/h.", prioridade: 90 },
  ], [f("km/h autorizados ao Trem do Forró")]);

  add("estudo-recife-caruaru", "dado", 74, [
    { texto: "O único estudo de trem de passageiros em Pernambuco liga o Recife a Caruaru, com cerca de 120 km.", prioridade: 100 },
    { texto: "Ele para no Agreste. Do Araripe, a distância é de outra ordem.", prioridade: 90 },
    { texto: "O resultado, previsto para o primeiro semestre de 2026, não foi publicado até agora.", prioridade: 80 },
  ], [f("km do estudo de trem de passageiros entre Recife e Caruaru")]);

  add("seis-corredores", "dado", 78, [
    { texto: "O programa federal de retomada de trens regionais trabalha com 6 corredores-piloto.", prioridade: 100 },
    { texto: "Brasília, Londrina, Pelotas, Salvador, Fortaleza e São Luís. Nenhum deles em Pernambuco.", prioridade: 90 },
  ], [f("corredores-piloto de trem regional do Ministério dos Transportes")]);

  add("fortaleza-sobral", "dado", 70, [
    { texto: "O Ceará já tem estudo contratado para um corredor de cerca de 240 km entre Fortaleza e Sobral, com modelo compartilhado entre carga e passageiros.", prioridade: 100 },
    { texto: "É o desenho institucional que um dia poderia ser repetido aqui.", prioridade: 90 },
  ], [f("km do corredor de Fortaleza a Sobral")]);

  add("cadeia-7-condicoes", "dado", 88, [
    { texto: "Entre o que existe hoje e um trem de passageiros do Araripe ao Recife há 7 condições encadeadas.", prioridade: 100 },
    { texto: "Vão da liberação da obra pelo TCU até uma parada no sertão, passando por um operador interessado e por uma fonte de custeio.", prioridade: 90 },
    { texto: "Nenhuma delas foi iniciada.", prioridade: 80 },
  ], [f("condições da cadeia para um trem de passageiros no Araripe")]);

  add("cenario-turistico", "campanha", 84, [
    { texto: "O mais perto do possível não é um trem até o Recife: é um trem eventual dentro do sertão, sobre trilho que já existe. Hoje não há nenhum.", prioridade: 100 },
  ]);

  add("operador-subsidio", "dado", 66, [
    { texto: "O presidente da concessionária já disse que transporte de passageiros é deficitário e que a empresa não tem interesse em operá-lo.", prioridade: 100 },
    { texto: "Na mesma entrevista, afirmou que nada impede o compartilhamento se o Estado entrar com infraestrutura e subsídio.", prioridade: 90 },
  ]);

  add("operador-nao-interfere", "dado", 72, [
    { texto: "Sobre trem de gente dividir trilho com trem de carga, o presidente da concessionária foi direto: nem um interfere no outro, e isso existe no Brasil todo.", prioridade: 100 },
    { texto: "O argumento técnico contra a convivência, portanto, não vem nem da empresa.", prioridade: 90 },
  ]);

  add("ninguem-de-pe-pediu", "dado", 80, [
    { texto: "As cogitações públicas de usar a Transnordestina para passageiros partiram do Ceará.", prioridade: 100 },
    { texto: "Em Pernambuco, a audiência da Assembleia sobre a ferrovia tratou de cronograma e investimento, e os seminários no Araripe trataram de porto seco e gesso.", prioridade: 90 },
    { texto: "Passageiro não entrou na pauta.", prioridade: 80 },
  ]);

  add("dossie-publico", "campanha", 90, [
    { texto: "Apurei se a Transnordestina pode levar gente de Araripina ao Recife. Hoje, não pode. Levantei também tudo que precisaria mudar para poder.", prioridade: 100 },
  ]);

  return t;
}
