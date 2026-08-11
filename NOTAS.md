# NOTAS — divergências entre a spec e a doc real do Bun

Levantadas por leitura das docs oficiais (`bun.com/docs`) e teste direto contra o
Bun instalado (`1.3.14`) antes de escrever cada módulo, conforme regra 1.2 da spec.

## 1. `Bun.Markdown` não existe

A seção 5.5 pede para emitir `cobertura.md` "via `Bun.Markdown` para render HTML".
Testado (`typeof Bun.Markdown === "undefined"`) e não há essa API na doc do Bun
1.3.x. `cobertura.md` é escrito como markdown puro, direto com `Bun.write()`, sem
nenhuma etapa de conversão para HTML.

## 2. `Bun.Color` (tabela §2.1) é `Bun.color()` minúsculo

A tabela de mapeamento no índice (§2.1) escreve `Bun.Color`; a API real (e o
próprio corpo da spec, §5.1) é a função `Bun.color(input, formato)`, minúscula.
Sem impacto — usamos a forma correta em `retry.ts`.

## 3. `Bun.YAML` só tem `.parse()`

Não existe `Bun.YAML.stringify()`. Sem problema: `config.yaml` é somente lido
pelo programa (via `Bun.YAML.parse(await Bun.file("config.yaml").text())`),
nunca escrito.

## 4. `Bun.WebView` e `Bun.cron` conferem com a spec

Confirmado nas docs oficiais: `Bun.WebView` implementa `EventTarget` (então
`addEventListener("Network.responseReceived", ...)` funciona como descrito),
exige `navigate()` antes de `cdp()`, permite só uma operação em voo por tipo por
view (`ERR_INVALID_STATE` se violar), e implementa `Symbol.dispose` /
`Symbol.asyncDispose`. `Bun.cron` tem as duas formas descritas na spec: in-process
(`Bun.cron(schedule, handler)` retornando `CronJob` com `Symbol.dispose`) e
OS-level (`Bun.cron(path, schedule, title): Promise<void>` + `Bun.cron.remove()`).
Implementado como especificado, sem ajuste.

## 5. `bun build --compile --minify --bytecode` confere

As três flags existem e funcionam como descrito (binário standalone, sem Bun
instalado na máquina alvo).

## 6. `HTMLRewriter` (tabela §2.1) — fallback de raspagem do CKAN

A tabela §2.1 marca `HTMLRewriter` como obrigatório para "Fallback: raspar links
do CKAN", mas o corpo do §5.4 só descreve o caminho normal (`package_show`).
Implementado como um terceiro nível de fallback em `harvest-ckan.ts`: se
`package_show` falhar mesmo depois de esgotar `insist()`, o coletor raspa
`https://dados.pe.gov.br/dataset/emendasparlamentaresestaduais` com
`HTMLRewriter` (seletores `li.resource-item`, `a.heading[title]`,
`span.format-label[data-format]`, `a.resource-url-analytics[href]` — verificados
contra o HTML real do site em 08/08/2026, batendo 1:1 com os 30 recursos que a
API retorna) para reconstruir a lista de recursos e seguir o fluxo normal.

## 7. `Bun.SQL` (export Postgres) citado na tabela §2.1 mas sem módulo especificado

A tabela de mapeamento cita `Bun.SQL` para "export opcional p/ Postgres", mas
nenhuma seção 5.x do documento especifica esse módulo (não há `src/export-pg.ts`
nem menção nos critérios de aceite §7). Tratado como fora de escopo desta
implementação — não bloqueia nenhum critério de aceite.

## 8. Schema de `emenda` (§5.6) estendido para caber os campos derivados de §5.5

A tabela de "campos derivados" em §5.5 exige produzir `municipio`, `beneficiario_cnpj`
e `beneficiario_nome`, e a rota `GET /api/municipio/:nome` (§5.8) depende de poder
consultar por município — mas o `CREATE TABLE emenda` em §5.6 não tem colunas para
nenhum dos três. Isso não é uma divergência de API do Bun, é uma inconsistência
interna da spec entre a seção de normalização e a de schema.

Resolução adotada: `emenda` ganhou três colunas `TEXT` nullable extras —
`municipio`, `beneficiario_cnpj`, `beneficiario_nome` — mantendo intacto tudo o
que §5.6 especifica. Sem isso, os campos derivados ficariam calculados em memória
e descartados, e a rota de município seria impossível de implementar.

Também não há coluna de FK explícita ligando `empenho` a `emenda` — o vínculo é
por design via `subacao_codigo` (prefixo de 4 chars de `cd_nm_subacao`), sozinho,
sem exigir que `exercicio` bata com `exercicio_emenda`: uma emenda de 2021 pode
ter empenhos pagos em 2023–2025, e a subação é o identificador estável entre anos
(§5.5: "a subação é estável por emenda"). As rotas de consulta
(`/api/autor/:nome`, `/api/municipio/:nome`, `/api/orfaos`) fazem esse join em
tempo de consulta.

## 9. Painel Pentaho estava no ar durante a implementação

A spec (§0) registra 503 em todas as tentativas de 06/08/2026. Testado em
08/08/2026 antes de iniciar: o painel respondeu HTTP 200 e a API CKAN também.
`discover.ts` foi implementado e testado contra o painel real, não apenas
"pronto e armado" — mas o `insist()` e o tratamento de falha continuam cobrindo
o caso 503, que é o modo de falha padrão documentado.

## 10. CDA usa POST com corpo form-urlencoded, não GET com querystring

A hipótese do §3.1 ("tipicamente em `/pentaho/plugin/cda/api/doQuery` com
`path`, `dataAccessId` e parâmetros") sugeria querystring GET. A descoberta
real (`discover.ts` rodado contra o painel ao vivo em 08/08/2026) mostrou que
é **POST** com corpo `application/x-www-form-urlencoded` — a URL de resposta
(`Network.responseReceived`) vem sem querystring nenhuma; `path`,
`dataAccessId` e o parâmetro do ano (`parampara_ano`) só aparecem no corpo do
pedido, visível via `Network.requestWillBeSent`. Por isso `discover.ts`
correlaciona os dois eventos CDP pelo mesmo `requestId` antes de montar cada
`DiscoveredCall`, e `harvest-pentaho.ts` faz replay via `fetch` com `method:
"POST"` e `body` form-encoded, não GET.

Achado adicional: a tabela principal (`dataAccessId: "sql_tabela"`) é paginada
via `paramlimit_`/`paramoffset_` (50 linhas por página no painel) e suas
colunas (`nome_ug`, `numero_empenho`, `nm_credor`, `obs`, `vlr_emp_original`)
**não batem 1:1 com as colunas do CKAN** (§3.2) — não há `cd_nm_subacao` nem
`cd_nm_funcao` nessa tabela específica. `harvest-pentaho.ts` faz o mapeamento
por um dicionário de aliases best-effort e detecta a "tabela de linhas" por
duck-typing (presença de uma coluna `numero_empenho` no metadata), em vez de
fixar o nome `sql_tabela` no código — mantém o espírito de "descoberta por
observação" mesmo se o painel for atualizado no futuro. Colunas ausentes ficam
`null`, e a propagação por `subacao_codigo` naturalmente não alcança as linhas
vindas do Pentaho enquanto essa lacuna existir — reportado, não escondido.

## 11. `sql_tabela` (tabela principal do painel) responde 200 mas com 0 linhas

A tabela principal capturada em 08/08/2026 tem colunas ricas — `ano`, `autor`,
`nome_ug`, `municipio`, `subacao`, `numero_empenho`, `nome_credor`,
`valor_empenhado`, `valor_liquidado`, `valor_pago`, entre ~40 colunas — que já
trazem autoria nativa (`autor`), o que eliminaria boa parte do trabalho de
`normalize.ts` se estivesse populada. Mas o replay via `fetch`, com os
parâmetros exatamente como capturados (inclusive limpando o valor suspeito
`parampara_numero_emenda: "para_numero_emenda"`, testando com e sem cookie de
sessão `JSESSIONID`, com header `Referer`, e para os exercícios 2024 e 2025),
sempre retorna `totalRows: 0`.

O próprio console do navegador, capturado por `discover.ts` durante a
navegação ao vivo, mostra um erro JS não tratado no carregamento do painel
(`TypeError: Cannot read properties of undefined (reading 'checked')` na
função `accessbility`) — plausivelmente esse bug de inicialização deixa algum
filtro interno do dashboard num estado que zera a consulta principal para
todo mundo, não só para o replay automatizado. Não é um defeito do coletor:
`harvest-pentaho.ts` grava a resposta crua (prova de que o endpoint responde
200 com um envelope CDA válido, só que vazio) e não trata resultset vazio
como falha, porque é uma resposta bem formada — diferente do caso CKAN de
corpo vazio (§3.2). Os endpoints de apoio (`sql_ano`, `sql_ug`, `sql_autor`,
`sql_municipio` etc.) funcionam normalmente e retornam dados reais (listas de
filtro).

Como o §8 da spec já prevê, isso deixa o caminho Pentaho "pronto e armado": o
código está correto e testado estruturalmente (replay POST, paginação,
parsing, storage), mas os dados de fato dependem do painel voltar a funcionar
sem esse bug de front-end. O caminho CKAN continua sendo a fonte íntegra e
completa para o projeto hoje.

## 12. `bun run check` precisa de `bunx tsc`, não `tsc` puro

A regra 1.1 proíbe `typescript` como devDependency (só `@types/bun` é
permitido), então não existe `node_modules/.bin/tsc` local — `tsc --noEmit`
puro falha com "comando não encontrado". `bunx tsc` resolve isso: baixa e
cacheia o pacote `typescript` sob demanda sem declará-lo em `package.json`.
O script `check` usa `bunx tsc --noEmit && bun test`.

## 13. Validação pós-coleta contra dados reais achou dois buracos em `normalize.ts`

Pedido do usuário: validar a coleta buscando pelas emendas da deputada Socorro
Pimentel (conferido contra `https://www.alepe.pe.gov.br/parlamentar/socorro-pimentel/`
— a página não lista emendas, só confirma que é uma parlamentar real, PSD;
`robots.txt` do domínio permite crawling geral, então uma consulta pontual foi
autorizada pelo usuário e feita). A checagem achou:

1. **Rótulo "DO (A) PARLAMENTAR \<nome\> PARA O MUNICÍPIO..."** não estava em
   nenhum dos padrões de §5.5 — 216+ empenhos usam exatamente esse formato nos
   repasses "Transferências Especiais", ~29% dos registros que ficavam órfãos.
   Adicionado como novo padrão em `AUTOR_PATTERNS`.
2. **O separador de "espaço duplo" (§5.5) não é confiável sozinho** — nos dados
   reais, ~22% dos registros "confiança alta" tinham a descrição do objeto inteira
   grudada no nome (`"SOCORRO PIMENTEL PERFURAÇÃODE POÇOS ARTESIANOS EM
   IPUBI"`, `"WILLIAM BRIGIDO Nº 252 DESTINADA A CAPACITACAO..."`), por typos
   de origem (espaço faltando) ou rótulos sem separador nenhum (`"DEPUTADO -
   AGLAILSON VICTOR .OBS; 2.59 X 38.500"`). Adicionada uma etapa de limpeza
   (`limparNomeCapturado`) que corta no primeiro marcador de "isso é descrição,
   não nome" (`STOP_MARKERS`) ou no primeiro ponto, e um validador
   (`LEADING_NON_NAME` + checagem de dígito/tamanho) que rejeita a captura
   inteira — volta pra `confianca: "nula"` — em vez de aceitar um nome
   claramente errado.

Resultado antes/depois no dataset completo (2022–2025, 4383 empenhos): confiança
alta subiu de 43,0% para 52,6% (627→768 emendas), capturas visivelmente
garbled (autor com mais de 4 palavras) caíram de 138 (22% dos "alta") para 0.
`autor_bruto` continua guardando o trecho cru capturado pelo regex, sem
tratamento — só `autor_normalizado` passa pela limpeza — preservando o que
§5.5 pede.

## 14. Ranking regional achou mais um garbled ("DERIVADA") e motivou proteção contra rebaixamento de confiança

Pedido do usuário: ranking de deputados por emendas para o Sertão do Araripe.
Cruzando `credor`/`obs` contra os 10 municípios da microrregião achei
`"DERIVADA"` como "autor" de uma emenda de R$ 1,1 milhão — não é nome de
pessoa, é resíduo de "EMENDA ... DERIVADA". Causa raiz: o rótulo `DEPUTADA
ESTADUAL <nome>` não pulava o qualificador "ESTADUAL", a limpeza rejeitava a
captura inteira, e o fallback bare-dash pegava a palavra errada antes do nome
real (`"- DERIVADA  DEPUTADA ESTADUAL ROBERTA ARRAES - EM ARARIPINA"`).
Corrigido: `DEPUTAD[AO]S?\s+(?:ESTADUAL\s+)?(...)`, `" - "` isolado adicionado
como marcador de parada em todos os rótulos, e `"DERIVADA"`/`"EMENDA"`
adicionados a `LEADING_NON_NAME` como segunda linha de defesa.

Isso expôs um risco maior: `db.upsertEmenda` sobrescrevia sem checar
confiança — uma rodada futura de `normalizar` (ou uma harvest do Pentaho com
autoria nativa, ver item seguinte) podia rebaixar um registro `"alta"` para
`"nula"`/`"media"` sem querer. Corrigido no UPSERT em si (não em código JS):
`ON CONFLICT ... DO UPDATE ... WHERE rank(emenda.confianca) <=
rank(excluded.confianca)` — uma tentativa de gravar confiança pior que a já
salva vira no-op. Testado (`db.ts` embute o teste isolado da cláusula SQL,
`harvest-pentaho.test.ts` cobre o caso de ponta a ponta).

## 15. Painel Pentaho tem coluna `autor` nativa — agora capturada, protegida contra rebaixamento

Pedido do usuário: instalar cron OS-level persistente insistindo no painel,
usando Socorro Pimentel como critério de sucesso. Isso expôs que
`harvest-pentaho.ts` descartava a coluna `autor` nativa da tabela principal
(ver item 11) — mapeava só as colunas no formato do CKAN. Corrigido:
`COLUMN_ALIASES` ganhou `autor`/`municipio` nativos; quando uma linha tem
`autor` não vazio, `harvest-pentaho.ts` grava `emenda` direto com `confianca:
"alta"` **sem** passar pela mineração de texto de `normalize.ts` — só
reaproveita `extrairNumeroEmenda`/`extrairBeneficiario`/`extrairMunicipio`
para os demais campos. Protegido contra rebaixamento pelo item 14.

Isso por sua vez expôs outro achado: `extrairNumeroEmenda` (usada agora
também sobre `cd_nm_subacao`, não só `obs`) não reconhecia o formato `"NO."`
(letra O, não `º`/`°`) — comum em `cd_nm_subacao`
(`"EKZF - EMENDA PARLAMENTAR NO.650/2023"`). O teste sintético de
`harvest-pentaho.test.ts` pegou isso antes de rodar contra dado real.
Corrigido: `N\s*(?:[º°]|O\.?)?\s*(\d+)`. Rodando de novo contra o dataset
completo (que já não tem "NO." em `obs`, só em `cd_nm_subacao` às vezes)
subiu 1459→1460 emendas identificadas — o ganho real deste fix é para o
caminho Pentaho, ainda não mensurável porque o painel está com `sql_tabela`
vazio (item 11).

Também corrigido um gap de tipos pré-existente: `EmendaRow` (types.ts) não
incluía `municipio`/`beneficiario_*`, embora a tabela real tenha essas
colunas desde o item 8 — `db.ts` reconstruía isso com um `& { municipio }`
ad-hoc que já tinha esquecido `beneficiario_nome`. Consolidado: `EmendaRow`
agora é a fonte de verdade do schema real, `NewEmenda` é só um alias dele.

## 16. Conferência 2022→hoje: Pentaho é painel do ano corrente, não arquivo histórico

Pedido do usuário: conferir se o SQLite está completo e correto de 2022 até
hoje via Pentaho. Rodei descoberta+coleta em todos os `dataAccessId`, todos os
anos, zero falhas no `harvest_log`. Achado central, confirmado direto na
fonte: `sql_tabela_count` retorna **0** para 2022–2025 e **2076** só para
2026 — o painel não é um arquivo histórico, é operacional do exercício
corrente (os lookups `sql_autor`/`sql_subacao`/`sql_n_emenda` para anos
antigos também só têm o placeholder `"TODOS"`, sem dado real). CKAN continua
sendo a única fonte para 2022–2025, e já está confirmado 100% coletado
(1.561/718/1.330/774 empenhos, batendo com os totais que a própria spec
registrou para 2024/2025).

Dentro de 2026: dos 2.076 registros do painel, só 354 têm `numero_empenho`
preenchido (os outros 1.722 são linhas de orçamento alocado mas ainda não
empenhado — plausível em agosto, ~2/3 do ano fiscal). Conferido arquivo por
arquivo (42 páginas) que os 354 batem exato com o que está no banco. Zero
hashes duplicados na base inteira.

## 17. Segunda rodada de regex ampliou ~29% dos "órfãos que citam EMENDA/EP mas não casavam"

Pedido do usuário: como ampliar os 38,1% sem autor identificado. Investigando
achei que 2.644 empenhos não linkavam a NENHUMA emenda (não só sem autor —
sem número extraído), e 860 desses citavam "EMENDA"/"EP" no texto sem casar
com `NUMERO_EMENDA_RE`/`NUMERO_EP_RE`. Padrões reais faltando:

- `"EMENDA PARLAMENTAR 675/2019"` — sem "Nº"/"N°" nenhum entre PARLAMENTAR e o número.
- `"EMENDA  N° 864/2019"` — sem a palavra PARLAMENTAR.
- `"EMENDA PAR. <nome> N 477/2020"` — abreviado.
- Anos com 2 dígitos (`"368/17"`) já funcionavam (o grupo de ano é opcional),
  não eram o problema.

Corrigido: `PARLAMENTAR`/`PAR.`/`N[º°/O.]` viraram todos opcionais em
`NUMERO_EMENDA_RE`, mantendo `EMENDA` como âncora obrigatória — testado contra
os 860 casos reais (416 passaram a casar, amostra de 20 conferida uma a uma,
zero falso-positivo óbvio) antes de aplicar.

Resultado no dataset completo: emendas *identificadas* (com número, mesmo sem
autor) subiram de 1.751 para 1.936; emendas com autor confirmado subiram de
1.083 para 1.120. O percentual de "confiança alta" caiu de 61,9% para 57,9%
— **isso não é regressão**, é o denominador crescendo mais rápido que o
numerador: os 185 registros recém-identificados agora aparecem como órfãos
visíveis (antes eram invisíveis, nem contavam) na lista de subações órfãs do
`cobertura.md`, prontos para virar item de pedido de LAI. Zero nomes
"garbled" na base inteira (checado: nenhum `autor_normalizado` com mais de 4
palavras entre os 1.120 de confiança alta).

## 18. Existe um segundo painel Pentaho — "Painel Histórico" (2023-2025) — não linkado da spec original

Pedido do usuário: usar os artifícios técnicos disponíveis para reduzir ao
máximo as emendas sem autor. `transparencia.pe.gov.br/gestao-estadual/
emendas-parlamentares/emendas-parlamentares-estaduais/` lista **dois**
painéis: o principal (`Painel_Emendas_Parlamentares`, só o exercício
corrente — item 11) e um separado, `Painel_Emendas_Historico`, cobrindo
2023–2025. A spec original só linkava o principal; achado navegando o
próprio portal de transparência com `Bun.WebView`, mesma técnica de
`discover.ts`, contra
`.../OpenReports/Portal_Producao/Painel_Emendas_Historico/Painel_Emendas_Historico.wcdf/generatedContent`.

O `dataAccessId` principal desse painel é `sql_jndi` (não `sql_tabela`), com
colunas próprias: `ano_emenda`, `numero_empenho`, `unidade_gestora`,
`credor`, `nm_funcao`, `nm_subfuncao`, `nm_prog`, `nm_acao`, `nm_subacao`,
`detalhamento_empenho` (o equivalente a `obs`), `valor_empenhado`,
`valor_liquidado`, `valor_pago`, entre outras. **Sem coluna `autor` nativa**
— ao contrário do painel principal (item 15), este é estruturalmente igual
ao CKAN (autoria só em texto livre dentro de `detalhamento_empenho`).
`nm_subacao` também não tem o prefixo de código de 4 caracteres que
`cd_nm_subacao` do CKAN tem (vem só como `"EMENDA PARLAMENTAR NO.181/2022"`,
sem `"EKZF - "` na frente) — `subacao_codigo` fica `null` para essas linhas,
então elas não participam da propagação por subação, só da extração direta.

`discover()` e `harvestPentaho()` ganharam `opts.panelUrl`/`opts.endpointsPath`
para suportar múltiplos painéis sem duplicar código; `config.pentaho.
panelUrlHistorico` foi adicionado, e `cli.ts`/`worker.ts` agora descobrem e
coletam dos dois painéis Pentaho a cada rodada, não só do principal.

**Resultado, mesmo sem autoria nativa:** o painel histórico tem seu próprio
snapshot dos empenhos, com hash natural evitando duplicata contra o CKAN
(mesma fórmula `exercicio|numero_empenho|obs|vlrempenhado`) — 2023 bateu
100% com o que o CKAN já tinha (0 linhas novas, confirma consistência entre
fontes), mas **2024 trouxe 8 empenhos novos e 2025 trouxe 1.009 empenhos
novos** que o CKAN nunca teve (o arquivo CKAN de 2025 provavelmente foi
publicado antes de fechar o ano; este painel está mais atualizado). Rodando
`normalizar` de novo: confiança alta subiu de 1.120 para 1.240, e a
propagação por subação saltou de ~4 para 69 (mais linhas share subação
agora). Zero hash duplicado na base inteira (5.754 empenhos, checado).

## 19. Autoria OFICIAL existe na API da ALEPE — infraestrutura pronta, aguardando o banco deles voltar

Pedido do usuário: buscar na internet fontes para zerar as emendas sem autor.
Varredura orquestrada (4 investigadores paralelos + aprofundamentos) sobre
TCE-PE, ALEPE, CKAN/SCGE e portal de transparência. Consolidado:

- **TCE-PE**: nada para 2014-2025 (Tome Conta sem módulo de emendas; API de
  dados abertos sem entidade de emendas; painel Qlik 404). A Resolução TC nº
  302/2025 (10/12/2025) obriga órgãos a publicar "Nome do parlamentar autor"
  nos portais próprios **a partir de 2026** — fonte futura a monitorar.
- **PDF da LOA sancionada** (ex. Lei 18.123/2022): tem "ANEXO DAS EMENDAS
  PARLAMENTARES APROVADAS" mas SEM coluna de autor. Confirmou, porém, que a
  ALEPE numera emendas pelo ano de APRESENTAÇÃO (650/2022 no anexo da LOA
  2023 = "650/2023" nos empenhos) — o casamento precisa tentar os dois anos.
- **ALEPE (o achado)**: o detalhe de cada PLOA na API
  `dadosabertos.alepe.pe.gov.br/api/v1/proposicoes/projetos/?numero=X&ano=Y`
  inclui `<emendas><emenda numero ano><autores><autor nome tipo>` — o
  mapeamento oficial (numero, ano) → deputado autor. Formato provado pelo
  parser do bundle JS oficial do portal proposicoes.alepe.pe.gov.br
  (main.29724183.js). O banco da API estava fora em toda a janela
  ("Erro na conexão com o banco de dados", HTTP 200, ~26s por resposta).

Implementado `src/harvest-alepe.ts` + comando `coletar:alepe` + integração no
worker do cron (a cada 6h): descobre os PLOAs de todas as legislaturas
(17ª-20ª, 2011-2026), baixa o bloco de emendas de cada um, grava no dicionário
`autoria_oficial` (tabela nova, com exercicio_apresentacao E exercicio_loa) e
aplica sobre `emenda` elevando só registros não-alta — sem inflar o
denominador da cobertura com emendas nunca executadas, e reportando
discordâncias com autoria já extraída de texto em vez de sobrescrever. Testado
de ponta a ponta com XML sintético no formato provado (5 testes).

## 20. Escopo restaurado para 2022→hoje; anos 2012-2021 viraram só camada de conhecimento

O usuário apontou (corretamente) que a spec define o escopo como 2022 → ano
corrente. Os 10.171 empenhos de 2012-2021 coletados no item 19 foram
removidos da tabela `empenho` (o raw imutável em `data/raw/ckan/` fica, como
proveniência). O que a coleta histórica ensinou sobre autoria FICA: as
emendas resolvidas por textos antigos permanecem em `emenda` como dicionário
(34 órfãos do escopo atual foram resolvidos por elas), e 1.301 emendas nulas
sem nenhum vínculo com empenho do escopo foram descartadas. O relatório
`cobertura.md` agora conta apenas o universo de execução (emendas vinculadas
a empenho 2022+), então nem numerador nem denominador são inflados pelo
dicionário.

Também a pedido do usuário: cron OS-level mudou de 6h para 4h
(`0 */4 * * *` — o Bun materializa como `0 0,4,8,12,16,20 * * *` na crontab)
e o worker agora escreve `data/cron.log`, append-only, uma linha por
disparo: `<timestamp> | OK/PARCIAL/FALHOU | principal: ... | historico: ...
| alepe: ... | validação: ...` — legível com `tail data/cron.log`.

## 21. Escopo final: 20ª legislatura (2023-2026), os últimos 4 anos

Definição do usuário em 09/08/2026: o objetivo é a legislatura atual da
ALEPE. `startYear: 2023`; empenhos de 2022 removidos da base operacional
(raw preservado); 291 emendas nulas que só tinham vínculo com 2022 foram
descartadas. Medido que os órfãos do escopo (empenhos 2023+) citam emendas
de 2019-2025 — por isso o dicionário da ALEPE cobre as legislaturas 19ª e
20ª (PLOAs de 2019-2025), e nada anterior: emendas de legislaturas mais
antigas não aparecem em nenhuma citação do escopo.

## 22. Bug real do cron: cwd=$HOME quebrava todos os caminhos relativos

O primeiro disparo real do cron OS-level (09/08/2026 20:00, provado no
syslog) morreu com "config.yaml não encontrado": o cron do sistema executa
com cwd=$HOME, e worker.ts usava caminhos relativos para tudo (config.yaml,
data/emendas.sqlite, data/cron.log...). Pior: a linha de falha do
data/cron.log também se perdeu, porque appendFileSync não cria diretório
pai (~/data ainda não existia no momento do logRodada; o Bun.write do
escreverStatus criou ~/data logo depois, deixando um PENTAHO_STATUS.md
órfão em ~/data como único rastro). Reproduzido rodando o comando exato da
crontab a partir de $HOME.

Fix: `process.chdir(import.meta.dir)` no topo do worker.ts — ancora o
processo no diretório do projeto independente de onde o cron o invoque
(imports de módulo ES são içados, mas nenhum módulo importado depende de
cwd em tempo de import; o chdir roda antes de scheduled()). Verificado
reexecutando a invocação idêntica à da crontab a partir de $HOME.

## 23. (numero, ano) NÃO identifica emenda unicamente — aplicação da ALEPE ganhou guardas medidas

O banco da ALEPE voltou em 10/08/2026 e os 7 PLOAs (LOA 2020→2026) foram
coletados: dicionário com 7.289 autorias oficiais. A primeira aplicação
elevou 563 órfãs para "alta" — e gerou 1.340 discordâncias com o autor já
extraído de texto. Auditoria em massa revelou dois fatos:

1. **O número de emenda repete todo ano** (650 existe nos 7 PLOAs, com
   autor diferente em cada um). O casamento pelo ano de APRESENTAÇÃO estava
   errado na maioria: comparando com os autores extraídos de texto, a
   interpretação "ano citado = exercício da LOA" concorda 52,7% vs 8,1% da
   interpretação por apresentação.
2. **Há ciclos paralelos de numeração** (PLOA, LDO/PPA, emendas
   derivadas/impositivas): 45,7% dos casos verificáveis não batiam com
   NENHUMA interpretação. O rótulo do ciclo na subação discrimina: dentro de
   "EMENDA PARLAMENTAR NO." a concordância LOA sobe para 81,1%; fora dele
   despenca para 21,3%.

Correção aplicada (com reversão completa das 563 elevações via reset +
reconstrução determinística das três fontes): `aplicarAutoriaOficial` agora
casa SÓ pelo ano da LOA, eleva SÓ órfãs (nula), SÓ quando a subação declara
o ciclo "EMENDA PARLAMENTAR", e grava com confiança **media** — 81% de
acerto estimado não é "alta", e o rótulo de confiança existe para dizer a
verdade. O autor extraído do texto do próprio empenho nunca é sobrescrito;
as 223 discordâncias texto×oficial remanescentes ficam como auditoria
consultável (JOIN emenda × autoria_oficial), não como sobrescrita.

Resultado honesto no escopo (20ª legislatura): 85,3% das emendas executadas
com autor (61,9% alta + 23,4% média), 252 órfãs (14,7%) — na maioria
emendas "derivadas" cuja numeração não existe no PLOA e citações de ciclos
que o dicionário legislativo não cobre.

## 24. Cron desligado (período eleitoral) e prompt de pesquisa para as 252 órfãs

Em 10/08/2026 o usuário determinou o desligamento do cron: 2026 é ano
eleitoral e a execução de novas emendas está vedada no período (art. 73 da
Lei 9.504/97) — não há dado novo a esperar das fontes. `cron:remove`
executado (crontab limpa) e o monitor de log encerrado. Para reativar
quando a execução voltar: `bun run cron:install`.

Criado `PESQUISA-ZERAR-ORFAS.md`: prompt autocontido de pesquisa profunda
para descobrir a autoria das 252 emendas restantes, com o que já foi
esgotado (para não repetir), ganchos minerados dos textos (98 casos vêm de
processos SEI da raiz 2300000029 = Secretaria de Saúde; 236/252 têm número
< 2000 sugerindo faixas por secretaria; caso-prova 421/2022 com autor no
texto que a regex rejeita), seis linhas de investigação priorizadas
(releitura por IA dos obs → decretos DOE-PE → portais dos órgãos → SEI →
imprensa → LAI), ground truths de validação e formato de saída. Anexo
`data/orfas.csv` com as 252 (numero, exercício, subação, UG, credor, valor,
obs completo).

## 25. Releitura por IA dos obs resolveu 14 órfãs; LAI minutado para as 238 restantes

O usuário executou a Linha 1 do PESQUISA-ZERAR-ORFAS.md (releitura dos 252
obs por IA) e trouxe 15 candidatas. Verificação contra a fonte primária (o
próprio obs no banco): 14/14 confirmadas com evidência literal (a 726/2021
foi corretamente descartada pelo próprio relatório — o texto cita outra
emenda). Os padrões revelados viraram fix genérico de regex ("AUTOR :" com
espaço, "A SER"/"ATRAVÉS" como marcadores de parada), que sozinho resolveu
7; as outras 7 foram aplicadas por atribuição direta verificada, com
proveniência em harvest_log (alvo "releitura-ia:N/ano"). 252 → 238 órfãs;
cobertura 86,1% (62,8% alta + 23,3% média). Zero garbled.

Criados LAI-PEDIDO.md (texto pronto para o e-SIC: pedido principal à SCGE +
espelho opcional à SES, fundamentação na Lei 12.527/2011 e na Res. TC
302/2025) e data/orfas-ses-processos.csv (96 casos da SES com número de
processo SEI — o maior bloco único). orfas.csv regenerado com as 238.

## 26. Site de consulta (docs/, GitHub Pages) — e o BI expôs a pseudo-subação "EMEN"

Pedido do usuário: site estático de BI (ECharts) para consulta por
parlamentar/município, hospedável no GitHub Pages. Implementado em `docs/`
(index.html + echarts.min.js vendorizado + dados.json gerado por
`bun run site`). Paleta e regras do guia de dataviz (slots categóricos
validados pelo validador nos dois modos; barras top-N em uma cor; stack de
qualidade da autoria com 3 séries; tabela drill-down como table-view de
acessibilidade; dark mode nativo).

O primeiro render do BI expôs um bug grave de dados: R$ 183 mi atribuídos a
uma única parlamentar. Causa: o `nm_subacao` do painel histórico vem SEM o
prefixo de código ("EMENDA PARLAMENTAR NO.6/2024"), e o corte cego
`substr(...,1,4)` fazia todas as 1.017 linhas dele colidirem na
pseudo-subação "EMEN" — um agregador falso que somava R$ 177 mi e os
atribuía à primeira emenda "alta" com esse código fantasma. Correção:
`extrairCodigoSubacao()` (código só quando o formato "XXXX - " existe;
null caso contrário) aplicado em normalize/harvest-pentaho; 194 emendas
com subacao_codigo='EMEN' corrigidas para null; e o export do site ganhou
elo textual — quando não há código, a linha liga à emenda pelo numero/ano
extraído do texto. Invariante de integridade no export: a soma do site tem
de bater com SUM(vlrempenhado) do banco (R$ 601,7 mi — que INCLUI R$ 177 mi
reais do painel histórico que o arquivo CKAN parcial de 2025 não tinha).
