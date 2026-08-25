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

## 27. Município: validação IBGE e a semântica "beneficiário ≠ destino"

Pergunta do usuário (leitura crítica do BI): "Socorro delegou milhões para
Recife e só 150 mil para Araripina?" A investigação linha a linha mostrou
dois problemas distintos:

1. **Heurística estreita demais**: os textos dizem "NO MUNICÍPIO DE BODOCÓ"
   (sem sufixo -PE) e o credor vem como "MUNICIPIO DE ARARIPINA" (sem
   "PREFEITURA"/"MUNICIPAL") — nada disso casava. Correção: padrões amplos
   ("MUNICÍPIO DE X", "X-PE", "EM X") com TODO candidato validado contra a
   lista oficial do IBGE (src/municipios-pe.ts, 185 municípios, gerada da API
   de localidades em 11/08/2026) — amplitude sem falso positivo. No caso
   concreto: Ouricuri saltou de R$ 135 mil para R$ 635 mil, Araripina de
   R$ 150 mil para R$ 531 mil, e os 8 municípios dos poços artesianos
   (Bodocó, Exu, Parnamirim...) passaram a aparecer (com R$ 0 empenhado —
   orçado e não executado, como está na fonte).

2. **Semântica que nenhuma heurística resolve**: o campo município (nativo
   do painel ou extraído) reflete por vezes a SEDE do beneficiário, não o
   destino do gasto. O maior "RECIFE" dela (R$ 1,77 mi, emenda 3/2025) é
   compra centralizada da Secretaria de Saúde numa concessionária de
   veículos (NOCARVEL) — o destino final dos veículos não consta nos dados.
   Instituições estaduais sediadas em Recife (UPE, IMIP, HEMOPE, Casa do
   Estudante) também concentram valor "em Recife" servindo o estado todo.
   Documentado no rodapé do site como limitação de leitura.

## 28. Camada FEDERAL: emendas da União com foco em PE (fonte melhor, recorte é o desafio)

Pedido do usuário: botões separados para Deputados Federais e Senadores de PE,
com BI próprio, em dois JSONs. Fonte escolhida: **arquivo único de emendas da
CGU/Portal da Transparência** (`/download-de-dados/emendas-parlamentares/UNICO`
→ `EmendasParlamentares.zip`, 32MB, 94.304 linhas, atualizado semanalmente).

Diferença fundamental em relação ao estadual: **a autoria já vem nominal na
fonte** (coluna "Nome do Autor da Emenda"), junto com UF/município do gasto,
tipo de emenda, função e valores. Zero mineração de texto — todo o esforço
aqui é o *recorte de PE*, não a autoria.

**Formato real conferido antes de codificar (regra 1.2):** CSV com `;`,
**codificado em ISO-8859-1** (decodificar como UTF-8 corrompe todo acento),
valores no formato brasileiro ("1500000,50"). O tipo de `TextDecoder` no
@types/bun não lista rótulos legados, mas o runtime aceita "iso-8859-1"
(verificado) — daí o cast pontual em `extrairCsv`.

**Classificação (`cat`), auditável por linha:** `deputado`/`senador` (autor
casa com a bancada federal de PE), `bancada` (emenda coletiva "Bancada de
Pernambuco") e `gasto-pe` (autor de fora, recurso aplicado em PE).

**Duas descobertas que a auditoria de matching forçou** (o coletor lista os
autores com gasto em PE que não casaram — nunca silencia):
1. `deputados?siglaUf=PE` devolve só os **25 em exercício**; com
   `idLegislatura=57` vêm **36** (inclui quem saiu e suplentes). Sem isso,
   Ossésio Silva — deputado federal de PE — caía em "gasto-pe".
2. Emendas executadas em 2023 vêm da LOA aprovada em **2022**, pela
   legislatura anterior: foi preciso incluir também a **56ª**. Isso levou os
   não-casados de 14 para 2.
3. Os 2 restantes eram **ex-senadores de PE** (Fernando Bezerra Coelho e
   Jarbas Vasconcelos, mandato até jan/2023). A API do Senado só expõe quem
   está em exercício — `lista/atual`, `lista/legislatura/56` (com ou sem
   `?exercicio=S`) devolvem 2 nomes de PE e `lista/legislatura/56/PE` dá 404.
   Resolvido com uma lista explícita de 2 nomes em `harvest-federal.ts`,
   documentada com a limitação da API: rotulá-los "gasto-pe" seria
   factualmente errado. **Resultado: 0 autores não classificados.**

Recorte final (2023–2026): **1.167 linhas, R$ 5,6 bilhões** — deputados 949
(R$ 3,51 bi), senadores 172 (R$ 731 mi), bancada 46 (R$ 1,36 bi), gasto-pe 0.

**Nota de leitura no painel:** só 130 das 1.167 linhas têm município (11%) —
não é bug: a maioria das emendas federais tem localidade "PERNAMBUCO (UF)"
(497) ou "MÚLTIPLO" (466). Por isso o segundo gráfico no modo federal ranqueia
por **função** (sempre preenchida), não por município.

---

## 29. Marcador de candidatura 2026 (TSE) — o que a fonte não entrega

Fonte: **DivulgaCandContas** (`divulgacandcontas.tse.jus.br/divulga/rest/v1`),
API não documentada oficialmente. Contrato conferido contra as respostas reais
e contra a documentação não-oficial em `github.com/augusto-herrmann/divulgacandcontas-doc`.

Chamada usada (uma por cargo):
`/candidatura/listar/2026/PE/20322002026/{cargo}/candidatos`, onde
`20322002026` é o id da "Eleição Geral Federal 2026" obtido de
`/eleicao/ordinarias`. Cargos: 3 Governador, 5 Senador, 6 Dep. Federal,
7 Dep. Estadual. Presidente (1) é nacional e retorna vazio para PE.

Coleta de 13/08/2026: **811 candidaturas** — 7 Governador, 9 Senador,
333 Dep. Federal, 462 Dep. Estadual.

**Três achados que moldaram o desenho:**

1. **`st_REELEICAO` vem `false` para os 811.** O campo existe e seria a
   resposta pronta, mas só é preenchido depois do julgamento. A reeleição é
   **derivada** aqui: cargo atual (nosso banco) × cargo de 2026 (TSE). Por
   isso o painel distingue "reeleição 2026" de "Deputado Federal 2026" —
   trocar de cargo é fato diferente de tentar o mesmo, e é o mais noticiável.

2. **Todas estão "Aguardando julgamento"** e o prazo de registro só fechou em
   15/08/2026. Logo, **ausência da lista não é negativa**: o painel só exibe
   marcador positivo e nunca afirma que alguém não é candidato. Na coleta de
   13/08, nomes como Priscila Krause, Teresa Leitão e André de Paula ainda não
   apareciam. Reexecutar `bun run coletar:candidatos` após o julgamento
   substitui a lista inteira (a tabela é espelho do dia, não acumulada).

3. **Homônimo é risco real, e o partido nem sempre desempata.** "ANDRE
   FERREIRA", deputado federal do PL, casa com um candidato a Deputado
   **Estadual** também do PL. Parecia homônimo; o nome civil da API da Câmara
   (`ANDRÉ FERREIRA RODRIGUES`) bate exatamente com o `nomeCompleto` do TSE —
   **é a mesma pessoa**, um federal concorrendo a estadual. Os 8 casos de
   troca de cargo foram conferidos um a um contra o nome civil; todos
   confirmados (Maria Arraes só ganhou um sobrenome a mais no TSE). Ainda
   assim `casarCandidato()` devolve `ambiguo` — sem marcador — quando há mais
   de um candidato com o mesmo nome e o partido não resolve. Errar aqui é
   afirmar publicamente que alguém está concorrendo quando não está.

**Recorte do cruzamento:** estaduais só com `confianca = 'alta'`. Marcar como
candidato alguém cuja autoria foi apenas inferida somaria duas incertezas num
rótulo público, em ano eleitoral.

Resultado da coleta de 13/08: 68 autores marcados (60 ao mesmo cargo, 8 a
outro), zero ambíguos. No modo estadual, o filtro "só candidatos em 2026"
recorta R$ 198,1 mi de R$ 601,7 mi e 45 dos 119 parlamentares.

---

## 30. Bens declarados e o que "região" pode e não pode significar

Fase 2 da coleta do TSE: o endpoint de detalhe
`/candidatura/buscar/2026/PE/20322002026/candidato/{id}` traz o que a listagem
não traz — `totalDeBens`, a lista `bens` item a item, naturalidade, ocupação,
grau de instrução e os **suplentes** (campo `vices`). Um request por
candidatura, ~830 no total, com pausa de 350 ms: a API não publica limite e a
documentação não-oficial pede intervalo. Retomável por `--so-detalhe`, que
pula quem já tem `detalhado = 1`.

**Suplentes.** Só senadores têm, e eles vêm dentro do detalhe do titular com
os campos em OUTRO padrão de nomenclatura (`sq_CANDIDATO`, `nm_URNA`,
`ds_CARGO`) — resquício de outra geração da API. Por isso a coleta tem duas
passadas: a primeira descobre os suplentes como linhas novas, a segunda busca
o detalhe deles. Sem a segunda passada, suplente ficaria no ranking com
patrimônio nulo. Eles entram no painel marcados como "suplente" porque um
suplente de senador pode assumir o mandato sem nunca ter recebido voto
nominal, e o patrimônio dele é dado público igual ao do titular.

**O aviso mais importante do painel inteiro.** O filtro por região usa o
**município de nascimento**. Deputado estadual, deputado federal, senador e
governador são eleitos em **circunscrição única** — o estado inteiro. Não
existe, no dado do TSE, "a região que o candidato representa"; não existe
distrito eleitoral no Brasil. Alguém nascido no Recife pode ser a principal
liderança política do Araripe, e vice-versa. Por isso:

- a coluna e o filtro se chamam "Região (nascimento)" / "Região de nascimento",
  nunca "região que representa";
- quem nasceu fora de PE fica com região nula e aparece agrupado como
  "(nascido fora de PE)", em vez de ser jogado numa região qualquer;
- o rodapé do modo de bens traz a ressalva em negrito.

Nos modos de emenda, o mesmo filtro tem outro significado, este sólido: a
região do **município que recebeu** o recurso.

**Agregação por mediana, não média.** Os gráficos por região e por cargo usam
mediana. A média de qualquer recorte aqui é definida por um único candidato
muito rico e diria mais sobre ele do que sobre o grupo.

**Zero declarado é informação; sem coleta, não.** Quem declarou nada aparece
com R$ 0 e é contado no KPI "declararam zero". Já quem ainda não teve o
detalhe coletado fica **fora** do JSON e é contado em `semDetalhe`, para não
virar um zero falso no ranking.

**Mapa de regiões** (`src/regioes-pe.ts`, gerado da API de localidades do
IBGE): as 19 microrregiões agrupadas nas 12 regiões de uso corrente no estado.
Vitória de Santo Antão entra na RMR — não porque seja a RMR legal (que tem 15
municípios), mas porque foi assim que os números publicados em `POSTS-X.md`
foram calculados: lá a RMR aparece com 19 municípios, o que só fecha com essa
microrregião dentro. Painel e thread pública precisam contar a mesma história.

---

## 31. Saúde no topo é piso legal, não escolha — e a emenda Pix

Correção apontada pelo Hermes em 14/08/2026, depois de o plano editorial
tratar "Saúde leva quase tudo" como achado. Não é achado: é a Constituição.

**A regra.** EC 86/2015, consolidada pela EC 126/2022 (art. 166 CF): no mínimo
**50% das emendas individuais impositivas** vão obrigatoriamente para ações e
serviços públicos de saúde. O mesmo piso de 50% vale para emendas de comissão,
e o Executivo aplicou o mesmo critério às de bancada estadual. Logo, qualquer
leitura do ranking de função que trate a liderança da saúde como decisão
política da bancada está errada.

**O que os dados de PE mostram quando a pergunta é a certa** (2023–2026):

| recorte | valor | saúde |
|---|---|---|
| Emendas individuais (universo do piso) | R$ 4,24 bi | **57,7%** |
| — com finalidade definida | R$ 2,93 bi | 83,5% |
| — transferências especiais (Pix) | R$ 1,31 bi | **0%** |
| Emenda de bancada | R$ 1,36 bi | 75,7% |

A margem de escolha real da bancada é a diferença entre 57,7% e o piso de 50%:
**R$ 325,5 mi**. Todo o resto é lei cumprida.

**A emenda Pix.** As transferências especiais (EC 105/2019, art. 166-A) somam
R$ 1,31 bi em 133 registros, todos com função "Encargos especiais" e subfunção
"Outras transferências"; em 121 deles a localidade é "MÚLTIPLO", sem município.
Cuidado com a leitura fácil: **não é dinheiro sem regra**. A lei exige no
mínimo **70% em despesas de capital** (investimento), no máximo 30% em custeio,
e proíbe pessoal e serviço da dívida. O que falta não é a regra — é o
*registro do setor* no dado federal. Para saber o que foi comprado é preciso
ir à contabilidade do município, não ao portal da União.

**Efeito no painel:** a nota do modo federal e o subtítulo do gráfico de
funções passam a dizer as duas coisas, porque o gráfico sozinho induz
exatamente ao erro que originou este item.

---

## 32. O painel contava empenho solto como emenda

Achado em 14/08/2026 ao auditar o painel depois de o mesmo erro aparecer nos
posts publicados: **casar contagem de um universo com valor de outro**.

O KPI dizia "3.269 emendas (subações)". A contagem vinha de
`new Set(linhas.map(l => l.s))`, e a chave `s` do export tem três formas:

| forma | o que é | quantas |
|---|---|---|
| `XXXX` | código de subação — emenda de verdade | 2.320 |
| `T:num/ano` | elo textual numero/ano — emenda de verdade | 548 |
| `E:<id>` | **empenho sem vínculo nenhum** | 401 |

As 401 chaves `E:` existem para que a linha não desapareça da tabela quando
não há elo com emenda alguma (ver item 20). Mas contá-las como emenda inflava
o KPI em 401 unidades, R$ 61,2 mi. O número honesto é **2.868**.

O KPI agora exclui `E:` e o rótulo passa a declarar o resto:
"2.868 emendas · 401 empenhos sem vínculo". As linhas continuam na tabela —
esconder o que não casou seria o erro oposto.

**Padrão a vigiar em todo número público deste projeto:** contagem e valor
precisam vir do mesmo conjunto. Já falhou três vezes — nos 12 posts regionais
(item 31 da errata em POSTS-X.md), no índice de fatos do verificador, e aqui.

## 33. Série de 3 em 3 horas: o gerador, e as três colisões que o verificador não pegava

Pedido do usuário em 16/08/2026: trocar a série diária de 17 posts escritos à
mão por publicação **de 3 em 3 horas até a eleição**, com tom afirmativo em
vez de pergunta, e **posts avulsos em vez de thread**. São 392 slots
(16/08 a 03/10, 8 por dia) — uma ordem de grandeza acima do que dá para
escrever à mão, e a terceira vez que escrever à mão produziria erro.

Três diagnósticos separados por trás da mesma queixa:

1. **Tom.** A regra estava escrita: `post-do-dia/SKILL.md` mandava "pergunta
   na 3ª linha", e `verificarPost` emitia aviso quando o post **não** tinha
   pergunta. Invertido: `tom: "afirmativo"` é o padrão e `pergunta-no-final`
   é o aviso; `tom: "pergunta"` preserva o comportamento antigo para errata e
   réplica.
2. **Formato.** `publicarThread` encadeia cada post como resposta ao anterior.
   O X esconde resposta da aba "Posts": a thread tinha 3 posts no ar e só 1
   aparecia no perfil. Novo `publicarAvulso` publica sem `reply`.
3. **Volume.** Novo `src/gerar-posts.ts` produz **1.334 posts** a partir de 8
   templates × recortes do banco, todos aprovados pelo verificador antes de
   entrar no pool. Contra 392 necessários: folga de 3,4×.

### O que só apareceu medindo

**(a) O verificador aprovava número derivado por colisão acidental.** Medido:

```
verificarPost("Caruaru recebeu R$ 45 por habitante em emendas.")  → ok: true
  aviso numero-conferido: "R$ 45" confere com "emendas de CARUARU"
```

45 é o **número de emendas** de Caruaru; o texto afirma reais por habitante.
O mesmo "R$ 45" também casava com o per capita de **Carpina**. Num regime de
8 posts/dia sem revisão humana essa é a falha dominante — silenciosa, com
número plausível e cidade certa. Resolvido com `rotulosEsperados`: o fato que
casou tem de ser o que o post afirma, não qualquer um do mesmo valor.

**(b) Ordinal e citação legal casavam por acidente.** `"2º Suplente"` casava
com as emendas de Afrânio; `"EC 86/2015"` fazia o 86 casar com o per capita
de Santa Cruz da Baixa Verde e `"art. 166-A"` ficava sem lastro. Ou seja: as
duas ressalvas que a lei **obriga** a escrever (piso de 50% da saúde, regra
das emendas Pix) reprovavam o post que as escrevia. Ambos passaram a ser
ignorados em `extrairNumeros`, como o ano solto já era. Em contrapartida,
template da série é proibido de citar posição de ranking em número.

**(c) O universo de autoria estava sujo.** `confianca='alta'` tem 110 autores
distintos, entre eles `": EDUI"`, `"APORTE FINANCEIRO"` e `"ADALTO SANTOS."`
— sobras de regex sobre texto livre. Sem catraca, "APORTE FINANCEIRO lidera
com R$ 3,2 mi" iria ao ar sozinho às 3 da manhã. `agregados.ts` cruza com
`autoria_oficial` (dicionário da ALEPE): sobram 63 autores estaduais, com
nome canônico e acentuado.

### Decisão: fato derivado vai para `indiceDeFatos`, não para `fatosExternos`

A alternativa era o gerador calcular o per capita e declará-lo como fato
externo. Seria tautologia — o gerador calcula X, declara X como conferido e
pede ao verificador para confirmar X. O verificador vira carimbo e um erro de
universo entra no ar assinado como "conferido". Vindo do índice, o número é
**rederivado do banco no instante da publicação**, que é a trava que importa
quando o texto foi escrito num dia e o dado mudou no outro.

Corolário estrutural: para gerador e verificador não terem duas cópias
divergentes do mesmo SQL — que é literalmente como o bug de 1,9× nasceu — o
agregado virou módulo único, `src/agregados.ts`, com a regra dura de que
`n` e `v` nunca saem de queries diferentes.

### Outras mudanças

- `src/nomes-pe.ts` (novo, gerado do IBGE): 185 nomes acentuados. O banco
  guarda `"SAO VICENTE FERRER"`; um post publicado escreve "São Vicente
  Férrer". Os 17 posts antigos foram acentuados à mão; 392 não podem ser.
- `verificarPost` aceita índice pré-construído (`opts.fatos`). Reconstruir a
  cada chamada custava ~300 ms; verificar os 392 slots caiu de minutos para
  **0,45 s**, e a suíte de evals de 5.440 ms para 6 ms.
- `usuarioAtual` cacheia o `@usuário` (TTL 7 dias). A X migrou para
  pay-per-use em fev/2026 e `cmdPostarAgenda` gastava um `GET /users/me`
  (~US$ 0,010) **antes de cada** publicação — ~US$ 3,90 até a eleição para
  confirmar um dado que não muda. O `@` só monta a URL de exibição;
  credencial ruim já falha claro no `POST /2/tweets`.
- Idempotência tripla em `data/x-publicados.json`: slot, recorte e hash do
  texto. O terceiro existe porque o X rejeita texto duplicado com 403.
- Cron: job `914e88efc013` reconfigurado de `0 9 * * *` para
  `0 0,3,6,9,12,15,18,21 * * *`, script `emendas-post-slot.sh`, **silencioso
  em sucesso** (a 8 posts/dia, avisar a cada acerto vira ruído e o alerta
  perde valor). Novo job `cacf7878dc8e` às 21:30 entrega o resumo do dia.
- `deliver` dos dois jobs está em `local`, não `telegram`: o
  `~/.hermes/channel_directory.json` está com `platforms: {}` e o alias
  genérico não resolve — era a causa do `no delivery target resolved` que o
  job antigo vinha acumulando calado.

`cmdPostarAgenda` e `POSTS-X.md` ficam congelados, com os 5 evals de
`cron.sh` verdes. Não há ganho em reescrever um comando testado para
reaproveitar o nome.

### 33.1 Cidade não pode parecer pessoa (16/08/2026, mesmo dia)

O primeiro post da série foi ao ar como:

```
João Alfredo recebeu R$ 3,6 mi em emendas parlamentares entre 2023 e 2026.
```

João Alfredo é município do Agreste Setentrional. Lido assim, é uma pessoa
recebendo R$ 3,6 mi — e num post assinado por candidato isso sugere
enriquecimento de alguém que não existe. PE tem vários casos (Joaquim Nabuco,
Vicência, João Alfredo).

Corrigido em `cidadeCom(nome, regiao)`: toda menção a cidade sai como
"O município de João Alfredo (PE), no Agreste Setentrional,". Três detalhes
que só apareceram aplicando:

1. **A identificação vai na primeira linha.** A região já existia no post, mas
   na camada de prioridade 30 — a primeira que `montar()` derruba quando o
   texto passa de 280. A informação que desfaz a ambiguidade era a mais
   descartável.
2. **"(PE)" sozinho não bastava** no template de líder por município, onde
   cidade e pessoa dividem a frase. Daí o "O município de".
3. **Pleonasmo na capital:** "Recife (PE), na Região Metropolitana do Recife".
   Quando o nome da cidade está dentro do nome da região, fica só a UF.

A regeração expôs um segundo defeito de redação que estava latente desde o
início: `São ${n} ${n===1?"emenda":"emendas"}` produzia **"São 1 emenda"** em
todo município com uma emenda só. Virou `contagem(n, sing, plur)`, que também
resolve o verbo. Os dois casos estão travados em teste.

`cmdAgendar` passou a ler `data/x-publicados.json` antes de distribuir:
exclui do pool os ids já publicados e refixa os slots que já saíram com o id
que de fato saiu. Sem isso, regerar a fila depois de a série começar ou
republicaria (barrado pelo ledger, deixando o slot vazio **em silêncio**) ou
reembaralharia o histórico, e o resumo diário passaria a mentir sobre o que
foi publicado.

O resumo diário ganhou verificação de saúde: roda `ensaiar:fila` contra o
banco, conta slots restantes e — o que importa — separa **slot vencido sem
publicar** de **slot futuro**. Contá-los juntos esconderia exatamente o
sintoma que o relatório existe para mostrar (máquina desligada, gateway
caído, credencial vencida). A tolerância de 90 min impede publicar horário
vencido, então slot perdido é perdido.

**Durabilidade auditada:** `hermes-gateway.service` é `enabled` no systemd de
usuário com `WantedBy=default.target`, `Restart=always`, `RestartSec=5` e
`StartLimitIntervalSec=0` (reinício sem teto), e o usuário tem `Linger=yes` —
sobe no boot sem login. As chaves OAuth 1.0a não expiram. A coleta de dados
segue desligada (item 24), então o banco está congelado e o pool não deriva.

## 34. De onde são os candidatos: naturalidade é proxy inválido, votação é o dado

Pedido do usuário em 16/08/2026: uma tela nova mostrando de onde são os
candidatos, por região de nascimento, cruzando com onde tiveram voto em
eleições passadas.

O pedido corrige um limite que o painel já carregava. O modo de bens filtra por
região de NASCIMENTO e o item 30 avisa que isso não é a região representada —
em PE a circunscrição é única. Até aqui o painel oferecia um proxy inválido de
base territorial sem ter como mostrar o dado real. Agora tem os dois lado a
lado, e quando divergem quem manda é o voto.

**Página própria, não 6º modo.** `docs/index.html` discrimina modo por
predicado negativo: `eFederal = () => modo !== "estadual" && modo !== "bens"`.
É um catch-all — qualquer modo novo é renderizado como federal até que 14
pontos imperativos sejam editados. Somam-se o teto de 10 `<th>`
(`aplicarTitulos()` descarta a 11ª coluna em silêncio), as 3 instâncias fixas
de gráfico e o handler de ordenação sem guarda de modo. `docs/candidatos.html`
evita os quatro e não pesa o first paint do painel.

### A junção é exata, por CPF

```
candidato_2026.cpf  →  consulta_cand_2022_PE.NR_CPF_CANDIDATO
                    →  SQ_CANDIDATO
                    →  votacao_candidato_munzona_2022_PE  →  votos por município
```

O detalhe do TSE 2026 devolve `cpf`, `dataDeNascimento` e `tituloEleitor` — o
projeto simplesmente não guardava. Com CPF o casamento sobe de 246 (por nome
civil) para **254 candidatos**, sem nenhum caso ambíguo para descartar.

**CPF não sai para `docs/`.** É chave de junção interna; o JSON público leva o
`id` do TSE, que já era publicado. Coletá-lo exigiu `--forcar`, que zera
`detalhado` — sem isso, um campo novo no parser ficaria nulo para sempre nos
836 já coletados.

### O que só apareceu medindo

- **O zip nacional tem 557 MB e não há recorte por UF** (testei
  `..._2022_PE.zip` e `.csv`: 404). Mas o membro `votacao_candidato_munzona_2022_PE.csv`
  existe dentro dele, e `unzip -p` extrai só ele (95 MB) — mesmo padrão de
  `harvest-federal.ts`. O consulta_cand é pequeno (4,4 MB).
- **Uma linha por ZONA ELEITORAL**, não por município. São 205.656 linhas para
  PE. Sem somar por município, "onde teve mais votos" apontaria para a maior
  zona, não para a maior cidade.
- **`CD_MUNICIPIO` do TSE não é o código do IBGE** (24279 = Gravatá). A malha
  do IBGE é chaveada por `codarea` de 7 dígitos. O casamento é por nome
  normalizado, e `src/nomes-pe.ts` passou a exportar `COD_IBGE`.
- **Layout com 50 colunas** e ISO-8859-1 com `;`, a mesma armadilha do CSV da
  CGU. Os índices são resolvidos pelo NOME da coluna e falham alto se sumirem —
  posição fixa leria partido como voto quando o TSE acrescentar campo.

### Dois bugs de front que a validação renderizada pegou

1. **`symbolSize` do scatter recebe `(valor, params)`**, e `valor` é o array
   `[x, y]` — não o objeto do dado. Ler `d.b.totalVotos` devolvia `undefined`,
   quebrava o render e levava a tabela junto. É exatamente o tipo de defeito
   que o passo 2 do skill `publicar` existe para pegar: o typecheck passa.
2. **Escala linear do mapa apagava o estado.** Recife tem 387 candidatos
   nascidos e o segundo colocado tem 31; numa rampa contínua PE vira mancha
   única. Virou `visualMap` por faixas, com cortes calculados sobre os valores
   presentes — serve às três vistas sem número mágico.

Também: o JSON saiu com 2,4 MB porque repetia o nome do município nas ~44 mil
linhas de votação. Compactado para `[códigoIBGE, votos]` → **578 KB**.

### Números da coleta (16/08/2026)

254 de 836 candidatos casados por CPF · 241 com votos de 1º turno · 44.955
linhas candidato×município×turno · 17,3 milhões de votos · 96 de 185 municípios
com algum nativo candidato · Recife concentra 387 (46,3%).

O per capita inverte o ranking: **Ibirajuba tem 28,0 candidatos nascidos por
100 mil habitantes contra 26,0 do Recife**. É o recorte que mostra quais
municípios de fato produzem quadros políticos, e não só quais são grandes.

Caso que ilustra a tese: **Waldemar Oliveira nasceu no Recife, mas teve mais
votos em Custódia** e só 14,0% da votação na região onde nasceu.

## 35. Eixo de curiosidade — e a diluição do índice, que reabriu dois erros

Pedido do usuário em 16/08/2026: usar naturalidade e votação de 2022 como
curiosidade nos posts do X. Virou um eixo novo, `curiosidade`, com quatro
templates (berço, mais votado para deputado estadual, mais votado para
deputado federal, e quantos candidatos receberam voto na cidade). No ciclo do
dia são 2 de 8 slots — 98 dos 392 posts da série.

### Universo: "o mais votado" exigiu recoletar 2022 inteiro

`votacao_2022` só tem os 254 candidatos de 2026 que também concorreram em
2022. Perguntar a ela quem foi "o mais votado em Araripina" devolveria "o mais
votado ENTRE OS QUE VOLTARAM" — outra frase. Foi criada
`votacao_2022_municipio` com o universo COMPLETO: **979 candidatos, 71.478
linhas** candidato×município de PE.

E o recorte é **por cargo**, não geral: senador e governador disputam o estado
inteiro e levam centenas de milhares de votos, então "o mais votado" solto
seria quase sempre o mesmo nome nos 185 municípios. Quem revela base local é o
deputado.

### O achado que mais importa: mais fatos = verificador mais fraco

Ao ganhar candidaturas e votação, `indiceDeFatos` foi de ~1,7 mil para ~4,4
mil fatos. E **dois evals que guardavam erros já publicados voltaram a
passar**:

```
"235" confere com candidatos que receberam voto em VERDEJANTE em 2022
```

O 235 é a contagem inflada do Agreste Setentrional, que foi ao ar em 13/08 e
estava travada por eval desde então. Com o índice inchado, encontrou lastro
num fato de urna — número certo, assunto sem nenhuma relação.

Isto é uma propriedade estrutural, não um bug pontual: **cada fato novo
enfraquece `numero-sem-lastro` para todos os outros**. `rotulosEsperados`
protege os posts gerados, mas não o texto escrito à mão.

A correção foi escopar por domínio: cada fato nasce com
`emendas | candidaturas | votacao | geo`, e `verificarPost` aceita
`dominios`. Um post de emenda não pode mais ser validado por um número de
urna. "geo" (população, malha, nº de municípios) é transversal e entra
sempre; fato externo declarado à mão não tem domínio e vale sempre, porque
declarar já é assumir que se conferiu. Dois evals novos travam exatamente
esta regressão.

### Outras armadilhas medidas

- **Denominador de taxa é unidade.** "7,1 candidatos por 100 mil habitantes"
  fazia o verificador exigir um fato de valor 100.000, que casava com qualquer
  emenda desse tamanho em qualquer cidade — **98 posts descartados**. Números
  precedidos de "por" e seguidos de "habitantes/moradores/eleitores" passaram
  a ser ignorados, como ano solto, ordinal e citação legal. "A cidade tem 100
  mil habitantes", sem o "por", continua sendo medida e exige lastro.
- **`cidadeCom()` fecha com vírgula** porque quase sempre há oração depois.
  Quando a cidade encerra a frase saía "no Agreste Setentrional,." e, no
  template de urna, "no Sertão do Pajeú,, 172 candidatos". Virou
  `limparPontuacao()` na montagem — o problema nasce da junção, não do
  template.
- **Nome de urna do TSE vem com espaço sobrando** ("SOCORRO PIMENTEL "). Num
  texto que se propõe conferível, a desatenção visível custa credibilidade.
- **Um `replace` de âncora errada não falha, só não faz nada.** A primeira
  tentativa de registrar o eixo novo mirou `for (const f of
  agregadoPorSubfuncao(db))` quando a variável do laço é `s`; o gerador seguiu
  produzindo os mesmos 1.334 posts e só a conferência da contagem denunciou.

### Regra editorial do eixo

Nenhum template afirma nada sobre a candidatura de 2026 de quem aparece na
votação de 2022. O dado citado é do passado; dizer que fulano "é candidato"
exigiria o marcador do TSE (item 29). Os posts de berço repetem a ressalva do
item 30: naturalidade não é a região que alguém representa.

## 36. Auditoria de credibilidade da série — "quando ele assina, some a fonte"

Pedido do candidato em 16/08/2026: revisar as 386 postagens pendentes — "os
dados estão corretos e verificáveis? meu nome tem que agregar confiabilidade".
Uma revisão adversarial (49 assinados + amostra dos 12 templates, conferida
contra o banco) respondeu que não: **a série trabalhava contra o nome dele**.
Os posts assinados eram sistematicamente os menos documentados do conjunto.

### Os três achados estruturais

1. **O join antigo dos agregados contava empenho em dobro.** O elo
   `substr(cd_nm_subacao,1,4) = subacao_codigo` soma o mesmo empenho N vezes
   quando a subação casa com N emendas: R$ 240,97 mi contra R$ 220,82 mi de
   empenhos únicos (+9,1%). Pior: o painel usa o elo sofisticado de
   export-site (código / T:num-ano / E:órfão, NOTAS 26/32), então **o post
   mandava o leitor conferir no painel um número que o painel não mostra**
   (Recife: post R$ 80,5 mi, painel R$ 81,2 mi). Correção estrutural: o elo
   virou módulo próprio (`src/elo-painel.ts`, com o invariante embutido) e
   TUDO — export do site, agregados dos posts, índice de fatos — o consome.
   Paridade agregados × dados.json verificada: exata, 0 divergências.
2. **"Chegaram"/"recebeu" descreviam valor EMPENHADO.** Itacuruba, no join
   antigo: R$ 250 mil "chegaram", R$ 0,00 pagos. Empenhar é reservar; pagar é
   outra coluna. Todos os verbos de entrega morreram; o post de cidade agora
   mostra empenhado E pago lado a lado ("R$ X já efetivamente pagos" / "nada
   pago até aqui").
3. **A camada de campanha removia as ressalvas.** O fecho assinado
   SUBSTITUÍA a linha de fonte e a de contagem — os posts com o nome do
   candidato eram os menos verificáveis. Regra nova: o fecho é acréscimo; se
   o conjunto camadas-de-dado + fecho não cabe em 280, a versão assinada NÃO
   EXISTE (regra `campanha-nao-coube`, 662 descartes no pool atual).

### Decisões do candidato

- **Link do painel na 1ª resposta de TODO post** (custo ~US$ 0,015/reply — a
  cifra está errada, é US$ 0,200 por post com URL; ver §45):
  "dado conferível" sem endereço era a definição de alegação não-verificável.
  `postar:slot` publica a reply após o post (falha na reply não desfaz o
  post); backfill feito nos 6 já publicados de 16/08.
- **Assinatura vira** "Hermes Alves, 2º suplente na chapa Carlos Sant'Anna
  300 · NOVO" — a antiga ("Hermes Alves · 300 · NOVO") omitia que o 300 é a
  chapa do titular.
- **Post que cita terceiro nunca leva assinatura** (líder por cidade e mais
  votado de 2022 são sempre posts de dado): seis assinados citavam seis
  candidatos adversários com cifra, um deles com a construção "Fulana:
  R$ 531 mil" — leitura de apropriação, direito de resposta em bandeja.

### Correções de texto (todas travadas em teste ou eval)

"emendas **estaduais** de autoria confirmada" no líder (o líder federal do
mesmo município pode ser outro: Coronel Meira R$ 1,0 mi × Socorro Pimentel
R$ 531 mil em Araripina) · contagem do mais-votado por CARGO (442 era a soma
de 4 cargos sob uma frase sobre deputado estadual) · "cada eleitor vota em
até quatro cargos" no post de urna (total de votos > população era munição
de negacionismo) · partido fora dos posts de emenda federal (o campo da CGU
não é datável; Bivar saía MDB num post e UNIÃO noutro) · per capita exibido =
total exibido / população (a conta do leitor não fechava em 18 posts) ·
nomes de urna em title-case (`nomeProprio`) · "a única emenda" quando n=1
(ranking de um item não é ranking) · fecho "comecei pelo sertão" só em post
do Sertão (caía num post sobre o Recife) · concordância por construção ("a
função X soma"; "Em [subfunção]: R$") · sem "dentro da função X" (a CGU
classifica Atenção básica sob Defesa nacional; repetir sem ressalva faz o
erro deles parecer nosso).

### Efeitos colaterais assumidos

Os números mudaram levemente com o elo (RMR 125,5→125,4 mi; Agreste Central
204→201 emendas; Casinhas R$ 8,0→8,2 mi; "238 órfãs"→"167 identificadas sem
autor" + 401 empenhos sem vínculo, o recorte do KPI do painel). Os evals
foram REANCORADOS ao universo novo — os posts publicados sob o universo
antigo ficam como estão (diferenças na casa de 1%, dentro do que a errata de
POSTS-X.md já ensinou a tratar). A fila ganhou anti-monotonia (46 pares
vizinhos de mesmo template → 0; mesma cidade 3× no dia → 1 caso de fallback).

---

## 37. Assessores por gabinete: a Alepe publica em quatro lugares e três deles mentem sobre hoje

Pergunta: quantos assessores cada deputado estadual tem, e quais os nomes. A
Alepe publica isso — mas em quatro endpoints que **não concordam entre si**, e
o mais fácil de achar é o mais desatualizado. Tudo abaixo foi medido em
18/08/2026 contra a fonte, não presumido.

### As quatro fontes

| | Endpoint | O que dá |
|---|---|---|
| **A** | `dadosabertos.alepe.pe.gov.br/api/v1/servidores/?formato=json` | 1.987 pessoas, **1.292 em 49 gabinetes**. Nome, lotação, cargo, vínculo, data de admissão |
| **D** | `dadosabertos.alepe.pe.gov.br/api/v1/parlamentares/?formato=json` | os 49 titulares com partido |
| **B** | `www.alepe.pe.gov.br/servicos/transparencia/fun/funcionarios.php?formato=csv` | 2.121 linhas com **matrícula**, código de cargo e código de setor; 51 linhas `PARLAMENTAR` com nome civil |
| **C** | `www.alepe.pe.gov.br/servicos/transparencia/fun/mapaocupacaosetores.php` | 206 setores com contagem e **código de setor** (`1110xxx`), incluindo demissionários |

O Portal da Transparência da Alepe (`transparencia.alepe.pe.gov.br`) é um SPA
React que consome exatamente A e D — não é uma quinta fonte. Ele não publica
**remuneração individual**: `/api/v1/remuneracao/` devolve tabela **por cargo**,
não por pessoa. Custo de gabinete, portanto, só é estimável (nº de cargos ×
tabela), nunca medido. A verba indenizatória por deputado/mês existe em
`adm/verbaindenizatoria*.php` e continua não coletada.

### O legado está defasado, e a defasagem é grande

B e C vêm do mesmo sistema antigo e batem perfeitamente entre si (mesmos 49
rótulos, mesmos códigos de setor). O que eles **não** batem é a realidade:

- dos **101 admitidos desde 01/06/2026** que A lista, só **18** aparecem em B;
- 626 pessoas só em A, 758 só em B;
- **31 dos 45 gabinetes comparáveis têm contagem diferente**;
- 4 gabinetes ainda estão em nome de quem saiu (Waldemar Borges, Roberta
  Arraes, Lula Cabral, Cleber Chaparral), enquanto A e D já mostram os
  substitutos (Antonio Coelho, Cayo Albino, Pastor Cleiton Collins, Wanderson
  Florêncio).

Por isso a regra do coletor: **a contagem sai só de A**. B e C entram como
enriquecimento (matrícula, código de setor, código de cargo) e como
divergência gravada em `pessoal_divergencia` — 41 linhas hoje, publicadas
junto no painel. Nada é silenciado para o número fechar.

### Casar por semelhança de conteúdo dá deputado errado

Antes de assumir a defasagem, foi testado casar os gabinetes de A com os de B
por **sobreposição dos nomes lotados** — parecia a solução data-driven. O
resultado, medido:

```
ANTONIO COELHO       -> EDSON VIEIRA      overlap=18
CAYO ALBINO          -> WALDEMAR BORGES   overlap= 5
WANDERSON FLORENCIO  -> (nenhum)          overlap= 0
```

Gente circula entre gabinetes, então sobreposição alta não prova identidade.
O casamento ficou sendo por **rótulo, com alias explícito e auditável** —
`ALIAS_PARLAMENTAR` (2 entradas) e `ALIAS_LEGADO` (4) em `harvest-pessoal.ts`.
Listas curtas, revisáveis a olho. O que não casa vira divergência, não palpite:
num painel assinado por um candidato, atribuir assessor ao deputado errado é o
pior erro possível.

Pela mesma razão a matrícula do deputado casa em só 30 dos 49: B guarda o
**nome civil** ("FRANZ ARAUJO HACKER"), e nome de urna nem sempre deriva dele
("France Hacker", "Socorro Pimentel"). A regra é tokens em ordem **com trava de
unicidade** — "JOAO PAULO" casaria com dois deputados e por isso não casa com
nenhum. Os 19 restantes ficam nulos de propósito; a junção de verdade é por
`deputado_normalizado`, a matrícula é enfeite.

### Armadilhas de formato (todas custaram uma rodada)

- **A barra final é obrigatória.** `…/api/v1/servidores?formato=json` responde
  **301** e o `fetch` entrega o HTML do redirect. Com `/` antes da query, 200.
- **A doc do portal promete campos que não vêm.** `SEQ` e `SITUACAO` estão
  documentados; nas 1.987 linhas, `SITUACAO` é `null` e `SEQ` não existe.
- **`DATA_ADMISSAO` não é string ISO**, é objeto
  `{ date, timezone_type, timezone }` (serialização de `DateTime` do PHP).
- **O CSV de B diz `charset=UTF-8` no header e é ISO-8859-1** — mesmo engano do
  arquivo da CGU (NOTAS 3). Sem o decoder certo, "CONCEIÇÃO" vira lixo.
- **`CODIGO_LOTACAO` de A e `setor` de B são espaços de código diferentes**
  (`256` × `1110270`); os de B e C são o mesmo. Casar por código entre A e B
  não funciona.

### Efeito colateral bom

Isto criou a tabela `gabinete` — a **âncora de deputado estadual** que o
projeto não tinha. Até aqui o parlamentar existia só como string em
`emenda.autor_normalizado`; agora há nome oficial, partido e chave estável
para cruzar tamanho de gabinete com autoria de emendas.

---

## 38. Perfil do deputado: cinco fontes, cinco nomes para a mesma pessoa

A tela de perfil junta o que o projeto já sabia de cada deputado estadual —
gabinete, emendas, votação de 2022, candidatura e bens. O trabalho não foi
desenhar a página; foi descobrir que **cada camada chama a mesma pessoa de um
jeito diferente**, e resolver isso num lugar só, com teste.

| Camada | Como ela nomeia Sileno Guedes |
|---|---|
| Alepe, `/api/v1/parlamentares` | `Sileno Guedes` (nome parlamentar) |
| Alepe, `funcionarios.php` | `SILENO SOUSA GUEDES` (nome civil) |
| TSE, votação 2022 | `SILENO` (nome de urna daquele ano) |
| PLOA da Alepe | `Sileno Guedes`, normalizado para `SILENO GUEDES` |

A chave canônica é `gabinete.deputado_normalizado`, e a junção mora em
`src/perfil-deputado.ts` — **não no navegador**. Fazer no cliente seria repetir
a regra em quatro páginas e deixá-la sem teste; o painel já pagou esse preço
uma vez (NOTAS 26: `agregados.ts` tinha reimplementado o elo e inflado 9,1%).

### Cobertura medida (18/08/2026, 49 gabinetes)

| Camada | Casam | O que fica de fora |
|---|---|---|
| Emendas (autoria oficial + execução) | **47/49** | Cayo Albino e João Paulo do PT — sem emenda executada no universo do painel |
| Votação de 2022 | **47/49** | João Paulo do PT e Wanderson Florêncio |
| Candidatura 2026 | **42/49** | marcador positivo-only (NOTAS 29) |
| Bens declarados | 42/49 | depende da candidatura |

Toda ausência vira uma frase na tela, no bloco "o que este perfil não sabe" —
lacuna explicada não é lacuna escondida. "Sem emenda" ali significa *sem
emenda executada com autoria confirmada*, não "não apresentou emendas", e a
tela diz isso com todas as letras.

### `votacao_2022_municipio.nome_urna` guarda o valor CRU do TSE

Casar por nome de urna dava só **36 dos 49**. O motivo não é o dado ser
incompleto: a coluna guarda o texto do TSE sem tratamento — `JEFERSON TIMÓTEO`
com acento, `KAIO MANIÇOBA` com cedilha, `SOCORRO PIMENTEL ` com **espaço à
direita**. Isso nunca apareceu antes porque `agregados.ts` junta por
`candidato_2026_id`, não por nome.

Normalizando os dois lados: 36 → 42. Usando o **nome civil** como segunda
chave (que o CSV legado da Alepe fornece): 42 → **47**. Os dois que sobram
mudaram de nome de urna entre 2022 e hoje e não têm nome civil no cadastro —
ficam vazios. `WANDERSON` (2022) **não** vira `WANDERSON FLORENCIO` (hoje) por
decreto: poderia ser outra pessoa.

Ambos os casamentos exigem resultado **único**. Dois candidatos com o mesmo
nome devolvem nada — atribuir a votação de outra pessoa a um deputado é
exatamente o erro que este painel não pode cometer, e há teste para isso.

### O invariante que segura a tela

`exportarSiteDeputados` compara, deputado a deputado, o valor do perfil com o
de `agregadoPorAutorEstadual` — o agregado que o painel publica — e **lança**
se divergirem em mais de R$ 1 ou numa emenda. O perfil convida o leitor a
"conferir no painel"; chegar lá e achar outro número seria pior do que não ter
a tela. Mesmo espírito do invariante de soma de `export-site.ts`.

Duas armadilhas de contagem resolvidas por esse invariante durante a
implementação: a identidade da emenda é `numero/ano`, não a linha — uma emenda
executada em três exercícios são **três linhas e uma emenda**; e o recorte tem
de ser o mesmo do painel (`conf === "alta"` **e** presente em
`autoria_oficial`), senão o perfil somaria as sobras de regex que a catraca do
dicionário oficial existe para barrar.

### Ranking com ressalva embutida

O tamanho de gabinete varia de **23 a 32** — ±17% em torno de 26,4. Os cargos
são fixados por ato da Mesa, não pela vontade de cada deputado. Publicar "5º
maior gabinete" sem dizer isso convida a leitura de excesso onde há variação
pequena, então a ressalva sai junto do número, no rodapé do próprio gráfico —
não numa nota de fim de página.

O gráfico de dispersão **assessores × valor empenhado** existe pela mesma
razão: mostra que as duas grandezas não se explicam, o que é a informação
honesta a dar.

### Índice enxuto para os links

`docs/dados-deputados.json` tem 210 KB. Fazer a tabela do painel virar link
não pode custar isso, e derivar o slug no cliente linkaria autor federal e
sobra de regex para perfis inexistentes. Daí `docs/deputados-indice.json`
(5 KB): `autor_normalizado → slug` dos 49. Só quem está nele vira link.

---

## 39. Quatro cópias do mesmo CSS, e a que já tinha divergido

Ao acrescentar `gabinetes.html` e `deputado.html`, o sistema de cores passou a
existir em **quatro cópias**, cada uma com o comentário "duplicado de
propósito: a página é autônoma". A autonomia era real; a duplicação já tinha
cobrado o preço:

- `--mapa-0` só existia em `candidatos.html`, `--s4` só em `deputado.html`;
- o `esc()` de `gabinetes.html` **não escapava aspa simples** — as outras três
  escapavam. Uma cópia divergida silenciosamente, exatamente o modo de falha
  que "duplicado de propósito" não previne.

Agora há `docs/tema.css` (paleta + 18 regras que eram byte a byte idênticas nas
quatro páginas) e `docs/comum.js` (`esc`, `css`, `num`, `moeda`, `brlCurto`,
`dataBR`, `baseOption`, `eixoTexto`, `linhaGrade`, `aoTrocarTema`). O que é
específico de cada tela continua no `<style>` dela, carregado depois e vencendo
no empate — a autonomia que importava era a de layout, não a da paleta.

`brl` não foi unificado às cegas: em `index.html` era um `Intl.NumberFormat` e
em `deputado.html` uma função de escala ("R$ 3,7 mi"). Mesmo nome, semânticas
diferentes. Viraram `PE.moeda` e `PE.brlCurto`, com o nome dizendo qual é qual.

**Como a refatoração foi validada:** screenshot de página inteira antes e
depois, comparado por md5. `index.html` e `candidatos.html` ficaram **byte a
byte idênticas**. Refatoração de CSS sem prova visual é aposta.

### Dois defeitos achados no caminho

1. **Console 404 em toda página.** Nenhuma declarava favicon, então o navegador
   pedia `/favicon.ico` e registrava erro em todas as telas. `docs/favicon.svg`
   + um `<link rel="icon">` por página: zero erro de console no site inteiro.

2. **Rolagem horizontal no celular, só em `deputado.html`.** Medido em 390px:
   a página estourava 374px. Causa: item de grid tem `min-width: auto`, que é
   `min-content` — e o ECharts fixa a largura do canvas em pixel. O gráfico
   virava o piso da coluna e arrastava o `<body>` junto. `candidatos.html`
   escapava por acaso, pela altura fixa dos seus gráficos.

   Correção em `tema.css`: `.cards > * { min-width: 0; }`. Uma linha, vale para
   as quatro telas, e é invisível no desktop — `min-width: 0` só age quando o
   conteúdo excederia a coluna. Depois: overflow 0 nas quatro páginas em 390px.

---

## 40. Salário de assessor: a Alepe não publica — e o que ela publica é melhor

A pergunta era listar nome e salário de cada assessor, com ranking. Metade tem
resposta e metade não, e a metade que não tem é a que importa dizer em voz alta.

### O que a Alepe publica e o que não publica

`/api/v1/remuneracao/` devolve **50 linhas: o vencimento de cada CARGO**, não de
cada pessoa. Competência única (08/2026 na coleta). Não existe contracheque
nominal em lugar nenhum do portal — o SPA de `transparencia.alepe.pe.gov.br`
consome exatamente esse endpoint na rota `/pessoal/servidores-remuneracao`.

> **Atualização (NOTAS 41):** esta seção dizia apenas que a Alepe "não publica",
> como se fosse característica da fonte. Uma varredura posterior mostrou que é
> uma lacuna medida por avaliação externa e judicializada. Ver item 41.

Então **"o assessor Fulano ganha R$ X" não é afirmável**. O que é afirmável:
*"Fulano ocupa o cargo Y, cujo vencimento de tabela é R$ X"*. A tela escreve
assim, e a distinção não é preciosismo — o valor de tabela é bruto, sem IR,
sem previdência, sem 13º, sem férias, sem gratificação e sem encargo patronal,
e quem entrou no dia 20 não recebeu o mês inteiro.

Cobertura do cruzamento em 18/08/2026, nos 1.292 lotados em gabinete:

| Cargo | Pessoas | Vencimento de tabela |
|---|---:|---:|
| Chefe de Gabinete | 49 | R$ 11.685,70 |
| Assessor Especial | 817 | R$ 10.363,58 |
| Assessor Especial Adjunto | 218 | R$ 3.238,64 |
| Coordenador de Expediente | 139 | R$ 2.267,01 |
| (sem cargo informado) | 69 | — |

Os 69 sem cargo são **exatamente** os "À Disposição" sem posto comissionado:
cedidos de outros órgãos, pagos pela origem. Outros 6 estão à disposição *e*
ocupam cargo de gabinete — cedido pode optar pela remuneração do órgão de
origem e a Alepe não publica qual, então também ficam fora. Contar seria
inventar despesa. A tela marca com `*` os gabinetes que têm gente fora da conta.

### O ranking de assessores por salário é degenerado — o de gabinete não

Ranquear 1.292 pessoas por vencimento produz **quatro blocos**, porque todo
mundo no mesmo cargo tem o mesmo valor. Não é ranking, é a tabela de cargos
repetida 1.292 vezes.

O ranking útil é o de **custo mensal do gabinete**, e ele contradiz o de
headcount, que era o que a tela mostrava antes:

| Deputado | Pessoas | Custo mensal estimado |
|---|---|---|
| France Hacker | 32 — **1º** | R$ 193.372 — **38º** |
| Dani Portela | 24 — **47º** | R$ 228.673 — **5º** |
| Rodrigo Farias | 29 — **5º** | R$ 170.054 — **48º** |
| João de Nadegi | 25 — **43º** | R$ 245.190 — **3º** |

A causa é a composição: um Assessor Especial custa **4,6×** um Coordenador de
Expediente. Quem monta o gabinete com muitos cargos altos gasta mais com menos
gente. A amplitude sobe de 1,39× (cabeças) para 1,48× (custo).

Total: **R$ 10.008.884,11/mês** nos 49 gabinetes, R$ 120,1 mi em 12 meses —
sem 13º, férias e encargos, que a estimativa não cobre.

**Contar cabeças engana.** Foi por isso que a coluna de custo entrou, com o
ranking de headcount ao lado no perfil ("5º de 49 em custo, 47º em nº de
pessoas") em vez de substituí-lo.

### Detalhes de formato

- `remuneracao` vem como **string** (`"11685.70"`) numa API que devolve
  `mesCompetencia` e `anoCompetencia` como número.
- A junção cargo↔cargo é por nome normalizado: a tabela escreve
  `COORDENADOR CHEFE` em caixa alta e `Assessor Especial` em caixa mista, no
  mesmo array.
- Cargo fora da tabela **não** é estimado por semelhança. Fica sem valor, com o
  motivo gravado — mesma regra do casamento de nomes (NOTAS 37/38).

---

## 41. "A Alepe não publica" era fraco demais — a varredura, e o que ela achou

O item 40 registrou que a Alepe publica vencimento por cargo e não por pessoa.
Estava certo no fato e **errado no enquadramento**: apresentei como
característica da fonte o que é uma lacuna de transparência medida por terceiro
independente e, hoje, objeto de ação judicial. A provocação que forçou a
revisão foi simples e correta: *é dinheiro público, concorda?*

Rodei então uma varredura de 8 ângulos com 27 verificações adversariais — cada
achado refeito por um cético que executava a própria requisição. **Zero
confirmações.** O negativo passou de presumido a provado.

### O que foi testado e não existe

| Fonte | O que tem | O que falta |
|---|---|---|
| `dadosabertos.alepe` `/servidores/` | 1.987 nomes + cargo + lotação | nenhum campo monetário |
| `dadosabertos.alepe` `/remuneracao/` | 50 cargos + valor | nenhum nome |
| Portal legado da Alepe | 316 URLs fuzzeadas em `/fun/`, `/adm/`, `/dep/` | nada com nome + valor |
| SPA da transparência | consome 4 endpoints; a rota `servidores-remuneracao` é rotulada **no próprio código** como "Tabelas de Remuneração" | — |
| Diário Oficial do Legislativo | portarias com nome + cargo + símbolo (PL-ASC…) | nunca valor em R$ |
| `dados.pe.gov.br` (Executivo) | 183.511 servidores ativos, nominais | `grep -c "^ASSEMBLEIA LEGISLATIVA"` → **0** |
| Intranet da Alepe | contracheque existe | HTTP 401 |
| TCE-PE `ListaServidores` | 9.715 vínculos da Alepe, 6.469 pessoas | **zero campo monetário** |

As únicas 195 linhas da Alepe em `dados.pe.gov.br` estão no arquivo de
**inativos** e são 100% `BNF-PENSIONISTA PREVIDENCIÁRIO` com `cargo = NA` — é o
beneficiário da pensão, não o servidor. Mesmo padrão em TJPE (720), MPPE (111) e
TCE (58). Usar essa base para falar de "servidor da Alepe" é erro factual.

### A medida externa — e um número que NÃO se sustentou

Baixei o banco de dados do **ITGP Legislativo Estadual** da Transparência
Internacional – Brasil (XLSX, 38 KB) e li a aba `Indicadores`. O indicador
**TA01** é literalmente *"Publica mensalmente, bases de dados com o salário dos
servidores efetivos e comissionados de forma nominal"*.

- **PE = 0.** O indicador irmão **TL12** (salário nominal dos parlamentares) também **= 0**.
- Nota cheia em TA01: **só CE, ES, GO e RS** — 4 das 27.
- Ficha de PE: 11º lugar, 45,2/100, conceito "Regular". Pior dimensão:
  **Transparência Administrativa, 30,6**.

**Correção importante:** circulou na imprensa local que "PE é uma de três
assembleias das 27 que escondem a lista de salários". Cheguei a repetir isso. O
dado primário do ITGP **não sustenta o número**: 11 estados tiram zero em TA01.
Os critérios podem medir coisas diferentes (o TA01 exige periodicidade mensal,
formato legível por máquina e série histórica), mas por isso mesmo o que vai
para texto público é a métrica que eu baixei e conferi — não o número do jornal.

### O dado existe, e está com o TCE-PE

O manual do Sagres Pessoal (v1.3.12), publicado pelo próprio TCE, prova que os
arquivos `FolhaPagamento` e `VantagemDesconto` integram a **remessa mensal
obrigatória** (Resoluções TCE-PE nº 20/2016 e nº 26/2016), chaveados por
`NomeServidor`/`CPFServidor`. O manual chega a orientar que não sejam omitidas
"quaisquer vantagens ou descontos recebidos por meio da folha de pagamento,
independente da natureza da rubrica, evitando-se também a simples menção à
remuneração bruta ou líquida percebida".

Ou seja: o TCE **recebe** a remuneração nominal de cada servidor da Alepe todo
mês e publica só a parte cadastral. Isso muda o alvo do pedido de LAI — ao TCE
não cabe "não temos o dado".

### Subproduto aproveitável

`ListaServidores` do TCE (UJ 778) traz o que a API da Alepe não tem:
**histórico**. 9.715 vínculos, 6.469 pessoas, 74 cargos, **7.461 afastamentos**
com data — matéria-prima para série de rotatividade por gabinete, que o snapshot
diário não produz. Baixado em `data/tce-servidores-alepe.json`.

Armadilha de formato, de novo: o endpoint declara
`application/json;charset=ISO-8859-1` — e desta vez o header **não** mente. O
parâmetro `AnoRemessa` é aceito e ignorado (devolve sempre os mesmos 9.715).

---

## 42. Redesign: quatro páginas viraram uma casca com quatro abas

O painel eram quatro HTML independentes, cada um com sua casca, seus filtros e
sua navegação. Virou **uma casca única** com quatro abas e o estado no hash da
URL, seguindo o canvas de redesign entregue em `template/`.

### O que mudou de arquitetura

| Antes | Depois |
|---|---|
| 4 páginas com casca duplicada | `index.html` (casca) + 4 renderizadores |
| navegação por link entre páginas | abas, sem recarregar |
| estado só na memória | estado no hash: `#tab=emendas&esfera=estadual&mun=RECIFE` |
| cada página baixava o que queria | carregamento sob demanda, um conjunto por aba |
| CSS e JS repetidos por página | `tema.css` · `comum.js` · `painel.js` |

`painel.js` tem quatro blocos com uma responsabilidade cada: `Dados` (fetch sob
demanda), `Estado` (estado + hash), `Graficos` (os quatro formatos usados, nada
além) e `Abas` (uma função de render por aba, sem lógica de dado).

### Decisões que se afastaram do canvas, de propósito

**Tipografia.** O canvas pedia Gotham (Hoefler & Frere-Jones) e Hugein
(MaulanaCreative) e trazia os arquivos. Publicar `.otf` licenciado no GitHub
Pages é redistribuição — a EULA da H&FJ veda expressamente. O site usa
**Montserrat** (SIL OFL), o geométrico livre mais próximo. Foi verificado lendo
os metadados dos próprios arquivos, não presumido.

**Tabelas.** O canvas monta as tabelas com `display:grid` e repete o
`grid-template-columns` no cabeçalho **e em cada linha** — duplicação que
divergiria na primeira coluna nova. Viraram `<table>` de verdade: mesmo
resultado visual, semântica correta, e a largura definida num lugar só.

**Sexta esfera.** O canvas listava cinco (estadual, dep. federais, senadores,
bancada, bens). O banco tem uma sexta categoria, `gasto-pe` — autor de fora com
recurso aplicado em PE. Omiti-la esconderia linha já coletada, então virou chip.

### Dois defeitos achados na validação

1. **`A form field element should have an id or name attribute`** — o DevTools
   reporta como *issue*, não como erro, e passaria batido em quem só olha o
   console. Dez campos gerados por template estavam sem `id`/`name`.

2. **Topo fixo comendo a tela no celular.** Empilhado em 390px, o cabeçalho
   passa de 240px; `position: sticky` deixava um terço da tela permanentemente
   ocupado. Agora ele solta abaixo de 720px.

### O que não pode quebrar

As telas antigas viraram redirecionamentos que **preservam o parâmetro**:
`/deputado.html?d=socorro-pimentel` cai em `#tab=deputados&dep=socorro-pimentel`.
São links já compartilhados e já citados em post publicado — o `LINK_REPLY` de
`cli.ts` apontava para `/candidatos.html` e passou a apontar para a aba.

---

## 43. Dois eixos novos na série: gabinetes com nome e a Transnordestina de passageiros

Pedido do usuário em 21/08/2026: acrescentar à série de 3 em 3 horas (a) os
deputados com mais assessores, com "crítica leve citando nomes", e (b) posts
positivos sobre a hipótese de a Transnordestina levar passageiros. Um post de
cada por dia, decisão tomada depois de quatro perguntas com as alternativas na
mesa.

O primeiro achado apareceu antes da primeira linha de código, e mudou o pedido.

### O ranking de assessores é quase plano — e a pauta é outra

| | |
|---|---|
| Maior gabinete | 32 pessoas (France Hacker, PP) |
| Menor gabinete | 23 pessoas (Antonio Coelho) |
| Média | 26,4 |
| Amplitude | 1,39x |

Crítica montada sobre isso é frágil: responde-se com "a média é 26" e o post
vira material do adversário. Some-se que **o tamanho não é escolha do
deputado** — os cargos são fixados por ato da Mesa (NOTAS 38) —, e "fulano tem
o maior gabinete" acusa alguém de uma decisão que não é dele. É a mesma classe
de erro do piso da saúde tratado como escolha política (NOTAS 31).

O que se sustenta é o contraste que NOTAS 40 já tinha medido: **cabeças
contradizem custo**. France Hacker é o maior em pessoas e está entre os mais
baratos; Dani Portela é um dos menores em pessoas e um dos mais caros; Álvaro
Porto é o único no topo dos dois. A causa é a composição de cargos, que **é**
escolha do gabinete: um Chefe de Gabinete custa 5,2x um Coordenador de
Expediente.

Daí a decisão de enquadramento: todo post nominal traz pessoas **e** custo, e
os 49 gabinetes entram — cobrir a Casa inteira é o que separa levantamento de
perseguição, e é o que torna o recorte defensável se alguém pedir direito de
resposta.

### Postura: dado no nome, opinião no agregado

Post nominal sai **sem assinatura**, como já era a regra de `cidade-lider`:
nome de deputado com cifra em post de candidato é pedido de direito de resposta
em período eleitoral. A opinião em primeira pessoa fica nos cinco posts de
agregado (custo total, custo em 12 meses, amplitude, tabela de cargos,
transparência), onde não há alvo individual. `Candidato.posturas` passou a
existir para isso, e `Candidato.fechosCampanha` porque o fecho genérico da
série fala do painel de emendas — colado num post sobre ferrovia, muda de
assunto no último parágrafo.

### O que só apareceu medindo

**(a) A ressalva que mais importa era a primeira a cair.** `montar()` derruba
por prioridade, e no post de "Claudiano Martins Filho (PP)" — o nome mais longo
entre os que citam posição no ranking — o texto estourava 280 e a camada
derrubada era justamente a do ato da Mesa. Ou seja: **o único post que citava
posição era o único que saía sem dizer que a posição não é escolha do
deputado.** Corrigido de duas formas: a ressalva sobe de prioridade **quando há
faixa de ranking no texto** (`faixa ? 87 : 70`), e as duas ressalvas foram
encurtadas até caberem juntas com o nome mais longo da Casa. Há teste que
varre o pool inteiro e falha se algum post com posição sair sem ela.

**(b) Todo post assinado dos dois eixos novos foi descartado na primeira
geração.** `campanha-nao-coube`, 12 de 12. A assinatura tem 62 caracteres e o
fecho outros 50 a 90; sobram ~140 para o dado, e os temas tinham duas ou três
camadas. A correção não é técnica, é de redação: **tema assinado tem uma
camada, e curta**. Está travado em teste (`test/temas-trem.test.ts`), que monta
cada tema de campanha com o fecho mais longo e exige 280.

**(c) "fase 1" pedia lastro.** `extrairNumeros` ignora ano solto, ordinal e
citação legal — não ordinal de fase. "A fase 1 da Transnordestina" fazia o `1`
ser cobrado do índice. Virou "a primeira fase". Não se afrouxou a regra: um `1`
solto em texto público *deve* ser conferido; o que não podia era o gerador
escrever numeral onde a palavra serve.

**(d) Portaria, decreto e acórdão não eram citação legal.** `RE_CITACAO_LEGAL`
cobria lei, EC, artigo, resolução e súmula. A pauta da ferrovia obriga a citar
**três acórdãos distintos do TCU** (1.121, 1.217 e 1.875/2026 — fundi-los é
erro de fato) e a Portaria 870/2025. Pior: o marcador exigia o número colado,
e "Resolução nº 5.943/2021" tem o `nº` no meio, então o 5.943 era cobrado. Os
dois casos entraram na regex, com teste.

### Fato externo versionado, não declarado na hora

Nenhum número da Transnordestina existe no banco. A saída **não** foi
`fatosExternos` no momento da geração — isso é tautologia (o gerador declara o
próprio número como conferido e o verificador vira carimbo, NOTAS 33). Foi
`src/transnordestina.ts`, no mesmo espírito de `populacao-pe.ts`: cada valor
versionado no projeto **com o id da fonte no dossiê** (`[F25]`, `[F32]`), e o
rótulo publicado no índice carrega esse id. Dois domínios novos em
`DominioFato` (`gabinete`, `transnordestina`) isolam as pautas — sem isso, um
gabinete de 26 pessoas casaria com as 26 emendas de algum município, e "38% do
ramal" com qualquer percentual de orçamento.

Um detalhe que já quase virou erro: **100 mil toneladas é ao mesmo tempo o teto
do que a rodovia move hoje e a expectativa da ferrovia amanhã**. Valor igual,
assunto diferente — a colisão de "R$ 45 por habitante" em Caruaru outra vez.
São duas entradas com rótulos distintos, e há teste exigindo que valores
repetidos tenham rótulos diferentes.

### As regras de redação do dossiê que viraram código

O dossiê (`~/Projetos/CHINA/transnordestina/`, apuração encerrada em
20/08/2026) responde **não** à pergunta central: não existe projeto, estudo,
contrato, autorização, orçamento nem interessado em transporte de passageiros
neste eixo. O positivo que se sustenta é a porta aberta que ninguém atravessou
— o contrato de 2014 **obriga** a concessionária a assegurar passagem de trens
de passageiros quando um operador requerer, a Lei 14.273/2021 criou o operador
desvinculado da infraestrutura, e a janela concreta é o contrato de
desestatização do ramal, em estudo agora.

Três notas de redação do dossiê viraram trava mecânica:

1. **Possibilidade não é promessa.** "Quando o trem chegar" e "vou trazer o
   trem" são `frase-proibida`, com eval.
2. **Os quilômetros em Araripina não têm casa decimal** — o quadro do estudo
   ambiental é internamente inconsistente (28,25 + 6,60 > 29,00 do
   subcompartimento inteiro). Só "mais de vinte" e a comparação com Trindade.
   Há eval que reprova o 28,25.
3. **Suape não é o Recife, e a bitola quebra no caminho** (1,60 m contra a
   métrica da CBTU). A ressalva entra com prioridade alta para sobreviver ao
   corte de 280.

Ficam também duas ressalvas obrigatórias que nenhum post pode omitir: o ganho
do gesso **não é automático** (o TCU aponta desvantagem da bitola larga para
granel leve), e percentual de obra declarado pela concessionária **não é
auditado**.

### O ciclo do dia

`CICLO` trocou uma cidade e uma curiosidade por `trem` e `gabinete`: 2 cidade,
1 curiosidade, 1 autor, 1 função, 1 trem, 1 gabinete, 1 campanha. Os dois
eixos novos levam as duas posturas **no mesmo balde** — nessas pautas a
postura é do tema, não uma segunda versão do mesmo recorte —, e por isso saem
do balde genérico de campanha; sem isso o mesmo post disputaria dois slots e o
eixo esvaziaria pela metade.

Estoque contra os 44 dias restantes: 50 temas de trem e 74 posts de gabinete
(49 nominais, 20 de contraste, 5 de agregado). A fila regerada usa 43 de cada,
com `0 reprovados` no `ensaiar:fila`.

## 44. A conta passou a ser dividida com o estudo da Alepe: 8 slots viraram 4

Decisão do usuário em 25/08/2026. O projeto irmão
(`~/Projetos/probabilidade`, https://estaduais.softagon.app) ganhou uma série
própria de posts, e as duas publicam pela MESMA conta, `@hermes_alves`. Manter
os dois a 8 por dia daria 16 posts diários — volume que a timeline não
sustenta. Então a grade foi partida ao meio:

| | horários (America/Recife) |
|---|---|
| emendas-pe | **00, 06, 12, 18** |
| Prognóstico Alepe | 03, 09, 15, 21 |

`bun run agendar --horas 0,6,12,18` foi o único comando; o ledger congelou os
dois slots já publicados de 25/08 e nenhum post publicado voltou para o futuro
(conferido antes e depois). A fila caiu de **392 para 160 slots**.

**O que se perde, e por que a perda é ordenada.** Cabem 160 recortes onde
cabiam 392. Como `ordenarIntercalado()` classifica por `peso_editorial`
decrescente e `distribuir()` serve o pico primeiro, o que fica de fora é o
material de menor valor em R$ — degradação graciosa, não corte cego. Nada a
fazer: é consequência aceita da decisão.

**Cuidado ao reagendar daqui em diante.** `agendar` sem `--horas` volta para as
8 horas padrão de `fila-posts.ts` e reocupa os horários do estudo, criando
colisão de dois posts no mesmo minuto. Passe `--horas 0,6,12,18` sempre. O job
`emendas-post-slot` em `~/.hermes/cron/jobs.json` já roda só nesses quatro.

O rótulo do eval que dizia "os 392 slots" virou "a fila inteira" — contagem
fixa em texto de teste envelhece no primeiro reagendamento.

## 45. O saldo da X não tem endpoint — e a reply com link custa 13× o que estava anotado

Duas perguntas de 25/08/2026: dá para publicar também no LinkedIn, e como
conferir o saldo em R$ da API do X antes que ele esgote no meio da série.

### Não existe API de saldo

O índice de documentação da X (`docs.x.com/llms.txt`) não tem nada de
billing/credits/balance, e a própria página de preços diz que o saldo mora no
Developer Console (`console.x.com`) — só lá dá para ver crédito restante,
mudar o auto-recharge e o spend cap. O único sinal programático é o
`GET /2/usage/tweets`, que é **gratuito** (não aparece na tabela de preços),
aceita app-only bearer e devolve consumo de LEITURA contra o teto do plano:

```
{"data":{"cap_reset_day":29,"project_cap":"3000000",
         "project_id":"2087642834413273088","project_usage":"21"}}
```

21 de 3.000.000 — irrelevante para nós, que quase não lemos. **Esse número não
é dinheiro**: o teto de 3M é de Post reads por ciclo, e escrita nem entra nele.
Quem publica não tem como saber o saldo sem abrir o console.

### A tabela de preços, e o item que ninguém tinha lido

Escrita é cobrada por requisição:

| Ação | Preço |
|---|---|
| Post: Create | US$ 0,015 |
| **Post: Create (with URL)** | **US$ 0,200** |
| Post: Create (summoned) | US$ 0,010 |

A seção 36 anotou "Link do painel na 1ª resposta de TODO post (custo
~US$ 0,015/reply)". Está errado: a reply do `LINK_REPLY` **é um post com URL**,
US$ 0,200. Treze vezes mais. Cada slot custa 0,015 (post, sem link) + 0,200
(reply, com link) = **US$ 0,215**.

Conferido contra `data/x-publicados.json`: 67 publicados entre 16 e 25/08, os
67 com `reply_id`. Gasto real ≈ **US$ 14,41 (R$ 74)** a 5,15 — não os US$ 2,01
que a conta antiga previa. Até a véspera do 1º turno (39 dias), a 4 slots/dia
da grade nova: **US$ 33,54 (R$ 173)**; se o Prognóstico Alepe usar a mesma
conta e a mesma reply, dobra para ~R$ 345.

### Por que a reply fica assim mesmo

Passar o link para o corpo do post não economiza — o post é que passaria a ser
"with URL", US$ 0,200, e ainda pagaria o preço de alcance que a seção 36 já
tinha medido. Escrever o domínio sem `https://` não escapa: a X monta a
entidade de URL do mesmo jeito. As saídas reais são cortar o link (perde a
verificabilidade que foi decisão do candidato) ou reduzir a frequência da reply
— e R$ 173 até a eleição é preço aceitável por "dado conferível com endereço".
Fica como está; o que muda é a nota de custo e a obrigação de olhar o console.

**Operacional: manter auto-recharge ligado no console com gatilho acima de
US$ 5.** Sem ele, o saldo pode ficar negativo e a X bloqueia as requisições —
num cron silencioso em sucesso, isso vira série interrompida sem aviso.

### LinkedIn: possível, e sem custo — mas não com "API key"

Não existe chave estática. Publicar exige OAuth 2.0 three-legged, token do
membro. O caminho curto, sem fila de aprovação:

1. App no Developer Portal, aba Products → adicionar **"Share on LinkedIn"**
   (self-serve, liberação imediata) → concede o escopo `w_member_social`.
2. Somar `openid profile` do "Sign In with LinkedIn using OpenID Connect" para
   pegar o `sub`, que vira o `urn:li:person:{id}` do campo `author`.
3. Fluxo de autorização uma vez no navegador, trocar o `code` por access token.
4. `POST https://api.linkedin.com/rest/posts`, headers
   `Authorization: Bearer`, `X-Restli-Protocol-Version: 2.0.0` e
   `LinkedIn-Version: YYYYMM`. Corpo mínimo: `author`, `commentary`,
   `visibility: PUBLIC`, `distribution.feedDistribution: MAIN_FEED`,
   `lifecycleState: PUBLISHED`. Resposta 201, id no header `x-restli-id`.
   (`/v2/ugcPosts` ainda responde, mas a Posts API o substitui.)

Três coisas mudam em relação ao X:

- **De graça.** A API do LinkedIn não cobra por post. Limite de 150
  requisições/dia por membro — a 4 posts/dia sobra folga.
- **O token expira em 60 dias e app self-serve não tem refresh token**
  (refresh programático é só para parceiro MDP aprovado). Da autorização até
  03/10/2026 são menos de 60 dias: **um token cobre a série inteira**. Se for
  usado depois da eleição, precisa reautorizar à mão.
- **Sem limite de 280.** O `pesoX` e os 662 descartes por `campanha-nao-coube`
  são restrição da X, não do LinkedIn — o mesmo recorte cabe com a fonte e o
  link no corpo, e lá link no corpo não custa nem penaliza alcance como no X.

Página de empresa (`w_organization_social`) é outra história: passa pela
Community Management API, com revisão de parceiro. Perfil pessoal não precisa.

### 45.1 O LinkedIn ligado, e o que a autorização revelou (25/08/2026, mesmo dia)

O caminho da §45 foi percorrido e é mais curto do que parecia — **o app do X
já servia**. `social-softagon-app` (id 226108894), criado em 13/05/2025, já
tinha "Share on LinkedIn" e "Sign In with LinkedIn using OpenID Connect"
provisionados e a página Softagon Sistemas verificada. Os dois obstáculos que
a doc anuncia (associar a uma Page, esperar o super admin verificar) já
estavam vencidos havia mais de um ano. Nenhuma aprovação foi pedida.

Única alteração no portal: `http://localhost:8788/callback` somado aos
Authorized redirect URLs. Os três de `social.softagon.app` continuam lá — e
aquele domínio está morto (não resolve em DNS), resquício de integração
antiga. O `mission-control` declara esperar um `LINKEDIN_ACCESS_TOKEN`, mas
não guarda nenhum: não havia token reaproveitável.

**Token vence em 24/10/2026** — depois do 1º turno, então a série cabe inteira
num token só. App self-serve não recebe refresh token; renovar é rodar
`src/linkedin-auth.ts` de novo.

**Medido, não suposto:**

- `POST /rest/posts` aceitou de primeira, duas vezes, texto com `( ) # % —` e
  cifra. Escape faltando dá 422; não deu. O `escaparLittle()` está correto no
  que a API valida.
- **O id do post vem no header `x-restli-id`, não no corpo.** A resposta 201
  tem corpo vazio: `await res.json()` ali estoura.
- `GET /rest/posts/{urn}` do próprio post devolve **403**. Ler exige
  `r_member_social`, que é restrito a aprovados — o que "Share on LinkedIn"
  não dá. Consequência prática: **não dá para verificar por API o que foi
  publicado**. Diferente do X, aqui o único jeito de conferir o texto no ar é
  olhar o post. Se algum dia entrar verificação pós-publicação, ela não pode
  ser desenhada como no `verificar-post.ts`.
- `DELETE` funciona com o escopo que temos, e é idempotente.

Fica em aberto: **ninguém viu ainda um post renderizado**. Os dois testes
foram apagados antes de serem olhados (o navegador fechou no meio). A barra
invertida à vista no feed é a falha que o 201 não pegaria — conferir na
estreia, a olho, antes de automatizar.

`w_organization_social` também está liberado no app, o que permitiria publicar
na página da Softagon. Não implementado por opção: conteúdo de campanha sob a
marca da empresa é decisão do candidato, não default de código.
