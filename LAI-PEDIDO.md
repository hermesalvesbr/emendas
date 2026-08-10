# Pedido de Acesso à Informação — autoria de emendas parlamentares estaduais

> **Como protocolar:** e-SIC de Pernambuco (via portal da transparência /
> Controladoria-Geral do Estado — SCGE). Recomenda-se UM pedido à SCGE (gestora
> do dataset de emendas) e, opcionalmente, um espelho à Secretaria Estadual de
> Saúde (SES-PE), que concentra 96 dos 238 casos com processo SEI identificado.
> Anexar: `orfas.csv` (lista geral, 238 casos) e `orfas-ses-processos.csv`
> (recorte SES com números de processo SEI).
> Prazo legal de resposta: 20 dias, prorrogáveis por 10 (art. 11, Lei 12.527/2011).

---

## Texto do pedido (copiar e colar)

**Destinatário:** Secretaria da Controladoria-Geral do Estado de Pernambuco (SCGE-PE)

**Assunto:** Autoria de emendas parlamentares estaduais — exercícios 2023 a 2025

Com fundamento na Lei Federal nº 12.527/2011 (Lei de Acesso à Informação),
solicito o fornecimento, em formato aberto e legível por máquina (CSV ou
planilha), da **relação completa das emendas parlamentares estaduais dos
exercícios de 2023 a 2025 com o nome do parlamentar autor de cada emenda**,
contendo, no mínimo, as colunas: número da emenda, exercício, nome do
parlamentar autor, valor e órgão/unidade gestora executora.

Solicito que a relação inclua expressamente as **emendas ditas "derivadas"**
(também tratadas como transferências especiais/impositivas), que possuem
numeração própria e não constam dos anexos de emendas ao Projeto de Lei
Orçamentária Anual.

Esclareço o contexto e a motivação do pedido:

1. O dataset aberto "Emendas Parlamentares Estaduais" publicado por esta SCGE
   em dados.pe.gov.br **não possui campo de autoria**; o nome do parlamentar
   aparece apenas, e de forma inconsistente, no texto livre do histórico do
   empenho.
2. Após cruzamento com todas as fontes públicas disponíveis (dataset aberto,
   painéis de emendas do Portal da Transparência e a relação de emendas aos
   PLOAs na API de dados abertos da ALEPE), **restam 238 emendas executadas,
   somando aproximadamente R$ 33 milhões empenhados, sem autoria
   identificável publicamente** — relacionadas no arquivo anexo `orfas.csv`
   (número da emenda, exercício, subação orçamentária, unidade gestora,
   credor, valor e histórico do empenho).
3. Destas, **96 tramitaram em processos SEI da Secretaria Estadual de Saúde**,
   relacionados no anexo `orfas-ses-processos.csv` com os respectivos números
   de processo — o que deve facilitar a localização da informação na origem.
4. A Resolução TC nº 302/2025 do TCE-PE, ao exigir dos órgãos estaduais a
   publicação do "nome do parlamentar autor da emenda" a partir de 2026,
   reconhece que essa informação integra o dever de transparência ativa; o
   presente pedido busca a mesma informação para o período 2023–2025.

A informação solicitada é produzida e mantida pela administração estadual no
curso normal da execução orçamentária (a indicação do autor é requisito do
próprio rito das emendas), não se enquadrando em nenhuma hipótese legal de
sigilo.

Peço, por fim, que, caso a informação esteja distribuída entre órgãos
distintos, o pedido seja encaminhado aos órgãos competentes, nos termos do
art. 11, III, da Lei nº 12.527/2011, com indicação do encaminhamento dado.

---

## Espelho opcional à SES-PE (96 casos)

Mesmo texto, substituindo o destinatário e restringindo ao anexo
`orfas-ses-processos.csv`: *"...solicito o nome do parlamentar autor da emenda
parlamentar vinculada a cada um dos 96 processos SEI relacionados no anexo,
todos autuados nesta Secretaria (raiz 2300000029), com o respectivo número de
emenda e exercício."*

## Acompanhamento

- Protocolo e acompanhamento: guardar o número do protocolo; resposta em até
  20+10 dias. Negativa ou resposta incompleta comporta recurso à autoridade
  superior (art. 15) e, em instância final, à CGE/ouvidoria.
- Quando a resposta chegar em planilha, o dicionário `autoria_oficial` do
  projeto ingere o CSV diretamente (mesmo formato numero;exercicio;autor) e o
  relatório `cobertura.md` reflete o resultado — o objetivo é fechar os 238
  restantes de uma vez.
