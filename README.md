# emendas-pe

Coletor resiliente e painel de consulta das **emendas parlamentares estaduais de
Pernambuco** (20ª Legislatura da ALEPE, execução 2023–2026). Dados públicos,
metodologia aberta, proveniência rastreável.

**Painel de consulta:** https://hermesalvesbr.github.io/emendas/ — filtre por
parlamentar ou município; cada linha tem links de conferência na fonte oficial.

## Fontes

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
bun run normalizar     # extrai autoria/município dos textos
bun run relatorio      # data/cobertura.md (órfãs prontas para pedido de LAI)
bun run site           # regenera docs/dados.json para o painel
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
