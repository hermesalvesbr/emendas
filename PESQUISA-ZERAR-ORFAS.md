# PROMPT DE PESQUISA — Zerar a autoria de 252 emendas parlamentares estaduais de Pernambuco

> Use este prompt em uma ferramenta de pesquisa profunda (Claude, deep research,
> ou um pesquisador humano). Ele é autocontido: contexto, o que já foi esgotado,
> ganchos concretos, critérios de validação e formato de saída. O anexo
> `data/orfas.csv` (252 linhas) acompanha.

---

## MISSÃO

Descobrir o **deputado estadual autor** de cada uma das 252 emendas
parlamentares estaduais de Pernambuco listadas no anexo `orfas.csv`
(exercícios 2023–2025, 20ª legislatura da ALEPE, R$ 35,5 milhões empenhados),
para as quais nenhuma fonte pública já explorada revela a autoria. O objetivo
é **zerar** a lista, com evidência citável para cada atribuição.

## CONTEXTO

Um coletor de dados abertos consolidou 4.193 empenhos de emendas estaduais de
PE (2023–2026) a partir de: CKAN dados.pe.gov.br, dois painéis Pentaho do
Portal da Transparência (atual + histórico) e a API de dados abertos da ALEPE.
85,3% das emendas executadas já têm autor identificado. As 252 restantes se
dividem em:

- **210 "emendas derivadas"** (rótulo `EMENDA DERIVADA` na subação orçamentária):
  transferências especiais/impositivas com **numeração própria, fora do PLOA** —
  o dicionário legislativo não as cobre por definição.
- **25 "parlamentares" ambíguas**: o número existe no dicionário de emendas ao
  PLOA, mas não no ano citado (aplicar seria ~50% de chute).
- **17 "parlamentares" fora do dicionário**: número não existe em nenhum PLOA
  2020–2026 (possivelmente emendas à LDO ou outra numeração).

## O QUE JÁ FOI ESGOTADO — NÃO REPETIR

Verificado com requisições HTTP reais em 08–10/08/2026:

1. **CKAN dados.pe.gov.br** (`emendasparlamentaresestaduais`, 2012–2026): campo
   `obs` minerado à exaustão com regex validada; as 252 são exatamente os casos
   onde o texto NÃO cita o autor.
2. **Painel Pentaho atual** (`Painel_Emendas_Parlamentares.wcdf`): tem coluna
   `autor` nativa, mas só cobre o exercício corrente (2026).
3. **Painel Pentaho histórico** (`Painel_Emendas_Historico.wcdf`, 2023–2025):
   NÃO tem coluna de autor (estrutura igual ao CKAN).
4. **API ALEPE** (`dadosabertos.alepe.pe.gov.br/api/v1/proposicoes/`): blocos
   `<emendas>` dos 7 PLOAs (LOA 2020→2026) já coletados — 7.289 autorias
   oficiais. Não cobre derivadas. ATENÇÃO: o número de emenda REPETE todo ano e
   há ciclos paralelos de numeração — nunca case só por (numero, ano).
5. **TCE-PE** (Tome Conta, API DadosAbertos, painéis Qlik): não publica autoria
   de emendas para 2014–2025. A Resolução TC nº 302/2025 obriga órgãos a
   publicar "nome do parlamentar autor" nos portais próprios **a partir de
   2026** (não retroativo).
6. **PDF da LOA sancionada** (anexo "Emendas Parlamentares Aprovadas"): lista
   emendas SEM coluna de autor.

## GANCHOS CONCRETOS (minerados dos textos das 252)

- **Processos SEI** citados nos empenhos, por raiz autuadora:
  `2300000029.*` = **98 casos** (Secretaria Estadual de Saúde — maior alvo único),
  `4400000039.*` e `4400000060.*` = 10, `2000000054.*` = 4, outros ~10.
  A pesquisa pública do SEI-PE existe:
  `https://sei.pe.gov.br/sei/modulos/pesquisa/md_pesq_processo_pesquisar.php?acao_externa=protocolo_pesquisar&acao_origem_externa=protocolo_pesquisar&id_orgao_acesso_externo=0`
  — verificar se o andamento/autuação revela o gabinete parlamentar de origem.
- **Numeração das derivadas**: 236 das 252 têm número < 2000; faixas 1xxx/2xxx/
  3xxx/4xxx/5xxx/6xxx/7xxx/8xxx/9xxx sugerem prefixo por secretaria/ciclo
  (ex.: 6xxx–7xxx aparecem em agricultura). Descobrir a tabela de faixas pode
  desbloquear atribuição em lote.
- **Um caso-prova de que ainda há texto recuperável**: a emenda 421/2022 tem
  `"...Nº 421/2022 DO PARLAMENTAR WANDERSON FLORÊNCIO A SER EXECUTADO..."` no
  próprio obs — extração assistida por IA (linha a linha, sem regex) sobre os
  252 obs do anexo é a via mais barata e deve ser a PRIMEIRA.

## LINHAS DE INVESTIGAÇÃO, EM ORDEM

1. **Releitura por IA dos 252 `obs` do anexo** — extrair qualquer menção de
   autor que os padrões automáticos perderam (caso 421/2022 acima). Custo ~zero.
2. **Decretos de abertura de crédito / transferências especiais no DOE-PE**
   (diariooficial.pe.gov.br, CEPE): decretos como o nº 56.110/2024 e 58.070/2025
   regulamentam os repasses das emendas de transferência especial — os anexos
   podem listar emenda → parlamentar. Buscar também "emenda impositiva" e a
   norma estadual que criou as derivadas (EC estadual/lei de emendas
   impositivas de PE) — a regulamentação pode publicar a lista anual por autor.
3. **Portais dos órgãos concedentes** (Res. TC 302/2025): a SES-PE
   (portal.saude.pe.gov.br / transparência própria) responde por 98 casos —
   procurar seção "emendas parlamentares" nos portais de SES, SEDUC, Agricultura
   (prefixos SEI 23*, 44*, 20*); alguns órgãos podem ter publicado retroativo.
4. **SEI-PE pesquisa pública** com os números de processo do anexo — o
   interessado/autuador pode ser o gabinete do deputado.
5. **Jornalismo e sociedade civil**: JC/Folha de PE/Diario/Marco Zero Conteúdo
   publicam rankings anuais de emendas por deputado — não é fonte primária, mas
   aponta onde a lista oficial circulou.
6. **LAI/e-SIC (fallback garantido, prazo legal 20 dias)**: minutar UM pedido à
   SCGE-PE (gestora do dataset) e/ou à Secretaria da Fazenda pedindo "a relação
   de emendas parlamentares estaduais 2023–2025 com nome do parlamentar autor,
   incluindo as emendas derivadas/transferências especiais, conforme anexo" —
   anexar o `orfas.csv`. Nota: pedido LAI não é vedado em período eleitoral.

## VALIDAÇÃO OBRIGATÓRIA

Qualquer fonte nova deve acertar estes ground truths (derivadas com autoria já
confirmada por texto do próprio empenho):

- **60026/2024** → SOCORRO PIMENTEL · **3010/2022** → AGLAILSON VICTOR ·
  **50060/2024** → JOÃOZINHO TENÓRIO

Se a fonte errar qualquer um, descartar ou explicar a divergência.

## FORMATO DE SAÍDA

CSV `numero_emenda;exercicio;autor;fonte;url_ou_documento;trecho_evidencia`
— uma linha por emenda resolvida. Para as não resolvidas, listar
separadamente com o motivo. Nunca inventar: toda atribuição precisa de
evidência literal citável.

## REGRAS

- Fontes oficiais primeiro; imprensa só como trilha para chegar ao documento.
- Máx. ~30 requisições por site; os sistemas públicos de PE são frágeis.
- `robots.txt` da ALEPE permite crawling; não martelar `sei.pe.gov.br`.
- Registrar TODA fonte tentada, mesmo as que falharem (evita retrabalho futuro).
