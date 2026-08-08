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
