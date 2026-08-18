# emendas-pe

Coletor resiliente e painel de consulta das **emendas parlamentares ligadas a
Pernambuco** — estaduais (ALEPE) e federais (Câmara e Senado) — execução
2023–2026. Dados públicos, metodologia aberta, proveniência rastreável.

**Painel de consulta:** https://hermesalvesbr.github.io/emendas/ — quatro
modos (Estaduais · Dep. Federais de PE · Senadores de PE · Bancada de PE),
filtros por parlamentar/município/exercício e links de conferência na fonte
oficial em cada linha.

## Fontes — estaduais

| Fonte | O que fornece |
|---|---|
| [Dataset CKAN (SCGE-PE)](https://dados.pe.gov.br/dataset/emendasparlamentaresestaduais) | Empenhos por exercício (CSV/JSON, sem campo de autoria) |
| [Painel de emendas — Portal da Transparência](https://transparencia.pe.gov.br/gestao-estadual/emendas-parlamentares/emendas-parlamentares-estaduais/painel-emendas-parlamentares-estaduais/) | Exercício corrente, com autoria nativa |
| [Painel histórico 2023–2025](https://transparencia.pe.gov.br/painel-historico-de-emendas-parlamentares-estaduais/) | Empenhos 2023–2025 (sem autoria) |
| [API de dados abertos da ALEPE](https://dadosabertos.alepe.pe.gov.br/api/v1/proposicoes/) | Autoria oficial das emendas aos PLOAs (dicionário) |

A autoria é resolvida em camadas: coluna nativa do painel > texto do próprio
empenho (regex validada contra dados reais) > dicionário oficial da ALEPE
(confiança média, com guardas medidas) > propagação por subação. Cada registro
carrega o rótulo de confiança (`alta`/`media`/`nula`); nada é sobrescrito
silenciosamente e as divergências ficam auditáveis. Detalhes, medições e
post-mortems de cada decisão: [`NOTAS.md`](NOTAS.md).

## Fontes — federais (foco PE)

| Fonte | O que fornece |
|---|---|
| [Emendas parlamentares (CGU/Portal da Transparência)](https://portaldatransparencia.gov.br/download-de-dados/emendas-parlamentares/UNICO) | Arquivo único com autor nominal, localidade, função e valores |
| [API da Câmara](https://dadosabertos.camara.leg.br/swagger/api.html) | Bancada federal de PE (56ª e 57ª legislaturas) |
| [API do Senado](https://legis.senado.leg.br/dadosabertos/) | Senadores de PE em exercício |

No federal a autoria **já vem nominal da fonte** — o trabalho é o recorte de
PE, classificado por linha em `deputado`, `senador`, `bancada` ou `gasto-pe`
(autor de fora com recurso aplicado em PE). O casamento com a bancada é
auditado: autores com gasto em PE que não casam são listados, nunca
silenciados. Ver [`NOTAS.md`](NOTAS.md) item 28.

## Fontes — candidaturas 2026

- **TSE/DivulgaCandContas** — `divulgacandcontas.tse.jus.br/divulga/rest/v1`
  (API não documentada oficialmente). Candidaturas de PE a Governador,
  Senador, Deputado Federal e Estadual nas Eleições Gerais 2026.
  Alimenta o marcador de candidatura no painel. Ver NOTAS.md item 29 —
  em especial: o painel **nunca** afirma que alguém não é candidato.

### Bens declarados e regiões

O modo **Bens dos candidatos 2026** ranqueia o patrimônio declarado no
registro de candidatura, incluindo **suplentes de senador**. Agregados usam
**mediana** (a média seria definida por um único caso).

O filtro por região tem **dois significados diferentes**, e isso é
deliberado:

| Modo | O que "região" significa |
|---|---|
| Emendas (estadual/federal) | região do **município que recebeu** o recurso — dado sólido |
| Bens dos candidatos | região de **nascimento** do candidato — proxy |

Não existe "região que o candidato representa": deputado estadual, federal,
senador e governador são eleitos em circunscrição única, o estado inteiro.
Ver NOTAS.md item 30.

## Fontes — gabinetes da Alepe

- **Dados Abertos da Alepe** — `dadosabertos.alepe.pe.gov.br/api/v1/servidores/`
  e `/api/v1/parlamentares/`. Lotação nominal: quem trabalha no gabinete de
  cada um dos 49 deputados estaduais, com cargo, vínculo e data de admissão.
  **É a fonte canônica da contagem.**
- **Portal legado da Alepe** — `servicos/transparencia/fun/funcionarios.php`
  (CSV, matrícula e código de setor) e `fun/mapaocupacaosetores.php`
  (contagem por setor). Entram só como **enriquecimento e conferência**: estão
  desatualizados (dos 101 admitidos desde 01/06/2026, só 18 aparecem lá), e as
  diferenças ficam gravadas em `pessoal_divergencia` e publicadas no painel.

A Alepe **não publica remuneração individual** — `/api/v1/remuneracao/` traz
tabela por cargo, não por pessoa. Ver NOTAS.md item 37.

### Perfil por deputado

`docs/deputado.html?d=<slug>` reúne, num lugar só, o que as cinco camadas
sabem de cada um dos 49: gabinete e ranking de assessores, emendas executadas
por exercício, destino do recurso por município e região, base eleitoral de
2022, candidatura e bens de 2026. Cada gráfico carrega a **fonte do seu
próprio bloco** — são órgãos e datas diferentes.

A junção mora em `src/perfil-deputado.ts`, não no navegador, e é conferida
contra o agregado publicado no painel: se divergir, `bun run site` falha. Cada
camada que não casa vira uma frase explícita na tela. Ver NOTAS.md item 38.

## Stack

[Bun](https://bun.com) + TypeScript, **zero dependências de runtime**
(`dependencies: {}`) — HTTP nativo, `bun:sqlite`, `HTMLRewriter`, `Bun.WebView`
(descoberta dos endpoints Pentaho por observação de rede via CDP) e `Bun.cron`.
O site é 100% estático (ECharts vendorizado + JSON gerado em build), hospedado
no GitHub Pages a partir de [`docs/`](docs/) — quatro telas que compartilham
`docs/tema.css` (paleta) e `docs/comum.js` (formatação e base dos gráficos).

## Comandos

```bash
bun install
bun run check          # typecheck + testes
bun run descobrir      # descobre endpoints dos painéis Pentaho (precisa de Chrome)
bun run coletar        # painéis Pentaho + CKAN
bun run coletar:alepe  # dicionário oficial de autoria (PLOAs da ALEPE)
bun run coletar:federal # emendas federais com foco em PE (CGU + Câmara + Senado)
bun run coletar:candidatos # candidaturas de PE em 2026 (TSE/DivulgaCandContas)
bun run coletar:candidatos -- --so-detalhe # retoma só a fase de detalhe (bens/suplentes)
bun run coletar:pessoal # lotação dos gabinetes da Alepe (snapshot datado)
bun run normalizar     # extrai autoria/município dos textos
bun run relatorio      # data/cobertura.md (órfãs prontas para pedido de LAI)
bun run site           # regenera docs/*.json (emendas, pessoal, perfis dos deputados)
bun run servir         # API local de consulta
bun run cron:install   # sincronização automática a cada 4h (crontab)
```

## Limitações conhecidas

- **Marcador de candidatura é positivo-only.** Ausência do selo não significa
  que o parlamentar não concorre em 2026 — a lista do TSE é espelho do dia e
  as candidaturas passam por julgamento. Reexecute `coletar:candidatos` para
  atualizar.

- **Lotação de gabinete é foto do dia, não série.** As fontes da Alepe só
  expõem o estado atual (a única data histórica publicada é a de admissão). A
  série temporal nasce do acúmulo de snapshots — o cron grava um por dia.

- ~14% das emendas executadas seguem **sem autor identificável** em fonte
  pública (maioria: "emendas derivadas" fora do PLOA) — a lista completa está
  em `data/orfas.csv` e o pedido de LAI pronto em
  [`LAI-PEDIDO.md`](LAI-PEDIDO.md).
- O campo **município** pode refletir a sede do beneficiário, não o destino
  final do gasto (ex.: compras centralizadas de secretarias em fornecedores da
  capital) — ver nota metodológica no rodapé do painel.
- Raw imutável de todas as respostas em `data/raw/` (fora do repositório) como
  prova de proveniência.
