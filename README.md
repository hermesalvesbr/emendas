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

## Stack

[Bun](https://bun.com) + TypeScript, **zero dependências de runtime**
(`dependencies: {}`) — HTTP nativo, `bun:sqlite`, `HTMLRewriter`, `Bun.WebView`
(descoberta dos endpoints Pentaho por observação de rede via CDP) e `Bun.cron`.
O site é 100% estático (ECharts vendorizado + JSON gerado em build), hospedado
no GitHub Pages a partir de [`docs/`](docs/).

## Comandos

```bash
bun install
bun run check          # typecheck + testes
bun run descobrir      # descobre endpoints dos painéis Pentaho (precisa de Chrome)
bun run coletar        # painéis Pentaho + CKAN
bun run coletar:alepe  # dicionário oficial de autoria (PLOAs da ALEPE)
bun run coletar:federal # emendas federais com foco em PE (CGU + Câmara + Senado)
bun run normalizar     # extrai autoria/município dos textos
bun run relatorio      # data/cobertura.md (órfãs prontas para pedido de LAI)
bun run site           # regenera docs/dados.json e docs/dados-federal.json
bun run servir         # API local de consulta
bun run cron:install   # sincronização automática a cada 4h (crontab)
```

## Limitações conhecidas

- ~14% das emendas executadas seguem **sem autor identificável** em fonte
  pública (maioria: "emendas derivadas" fora do PLOA) — a lista completa está
  em `data/orfas.csv` e o pedido de LAI pronto em
  [`LAI-PEDIDO.md`](LAI-PEDIDO.md).
- O campo **município** pode refletir a sede do beneficiário, não o destino
  final do gasto (ex.: compras centralizadas de secretarias em fornecedores da
  capital) — ver nota metodológica no rodapé do painel.
- Raw imutável de todas as respostas em `data/raw/` (fora do repositório) como
  prova de proveniência.
