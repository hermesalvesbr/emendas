# emendas-pe

Coletor resiliente + painel público das emendas parlamentares de Pernambuco
(estaduais da ALEPE e federais com foco em PE). Bun + TypeScript, SQLite,
site estático em `docs/` no GitHub Pages.

`README.md` tem fontes e comandos. `NOTAS.md` tem 43 achados numerados — cada
um documenta uma armadilha real, medida contra a fonte. **Leia o item citado
antes de mexer na área correspondente**; o resto pode ficar fora do contexto.

## O que não se descobre lendo o código

**Zero dependências de runtime é regra dura.** `"dependencies": {}` no
package.json não é acidente. Tudo usa nativo: `fetch`, `bun:sqlite`,
`HTMLRewriter`, `Bun.$`, `node:crypto`. Antes de sugerir um pacote, verifique
se o Bun já faz.

**Confira o formato real da fonte antes de codar o parser.** Todas as fontes
aqui mentem sobre o próprio formato em algum ponto. Baixe, inspecione o
cabeçalho, e só então escreva o mapeamento. Foi assim que se achou o CSV em
ISO-8859-1 da CGU e as chaves `sq_CANDIDATO` no meio de uma API camelCase.

**O dado é publicado sob o nome de um candidato.** O autor do painel concorre
em 2026 (ver memória do projeto). Erro numérico aqui não é bug, é material de
adversário. Quando um número for para texto público, confira contra o banco —
dois números publicados já saíram errados por terem sido arredondados de
memória (NOTAS 31, e a errata no topo de `POSTS-X.md`).

## Armadilhas por área

| Área | Armadilha | Onde |
|---|---|---|
| Pentaho | São **dois** painéis; o histórico tem `nm_subacao` sem prefixo — `substr(...,1,4)` cego inventa a subação "EMEN" | NOTAS 18, 20 |
| SQLite | `bun:sqlite` em modo estrito rejeita chave JS com `$`; o SQL mantém `$nome`, o objeto não | NOTAS 7 |
| Autoria | Confiança é catraca: o UPSERT nunca rebaixa `alta` para `media` | `db.ts`, NOTAS 23 |
| Export | `exportarSite*` lança se a soma do JSON divergir do banco. Se quebrou, o dado mudou — não afrouxe o invariante | `export-site.ts` |
| Candidaturas | Marcador é **positivo-only**: ausência na lista do TSE nunca vira "não é candidato" | NOTAS 29 |
| Região | Nos modos de emenda é o município que **recebeu**; no de bens é a **naturalidade**. Significados diferentes, mesmo filtro | NOTAS 30 |
| Função federal | Saúde lidera por **piso constitucional de 50%**, não por escolha. "Encargos especiais" são as emendas Pix | NOTAS 31 |
| CLI | `parseArgs` roda em `strict:false`; opção com valor **precisa** estar em `options`, senão vira booleano e o valor some | `cli.ts` |
| X | Link dentro do post derruba o alcance de 50–90% — vai na primeira resposta | `POSTS-X.md` |
| X | A conta é DIVIDIDA com o estudo da Alepe: esta série só usa 00, 06, 12 e 18h. `agendar` sem `--horas 0,6,12,18` reocupa os horários do irmão | NOTAS 44 |
| X | `publicarThread` encadeia como resposta e o X esconde isso da aba "Posts". A série usa `publicarAvulso` | `post-x.ts` |
| Agregados | `n` e `v` **sempre** da mesma query. Duas cópias do SQL divergindo foi o que inflou 12 posts em até 1,9x | `agregados.ts` |
| Autoria | `confianca='alta'` tem `"APORTE FINANCEIRO"` e `": EDUI"` — sobras de regex. Cruze com `autoria_oficial` | `agregados.ts` |
| Pessoal | A Alepe publica lotação em 4 endpoints; os 2 do portal legado estão defasados (só 18 dos 101 admitidos recentes). Contagem sai **só** dos dados abertos | NOTAS 37 |
| Pessoal | Gabinete casa com deputado por **rótulo + alias explícito**, nunca por semelhança: sobreposição de nomes casou Antonio Coelho com Edson Vieira | `harvest-pessoal.ts` |
| Pessoal | A Alepe publica vencimento **por cargo**, nunca por pessoa. Nada na tela pode dizer "salário do assessor" — é "vencimento do cargo", bruto, sem 13º/encargos, sem quem está à disposição | NOTAS 40 |
| Pessoal | Ausência de dado público tem de vir com a medida externa (ITGP TA01 = 0), não como característica da fonte. Número de jornal não citado sem conferir na fonte primária — o "3 de 27" não se sustentou | NOTAS 41 |
| Pessoal | Ranking de headcount **contradiz** o de custo (France Hacker: 1º em pessoas, 38º em custo). Publicar só um dos dois engana | NOTAS 40 |
| Perfil | Cada camada nomeia a pessoa de um jeito (parlamentar/civil/urna 2022). A junção é só em `perfil-deputado.ts`, e o export **lança** se o perfil divergir do agregado do painel | NOTAS 38 |
| TSE | `votacao_2022_municipio.nome_urna` é o texto CRU do TSE — acento, cedilha e espaço à direita. Normalize os dois lados antes de casar por nome | NOTAS 38 |
| docs/ | Casca única: `index.html` + `tema.css` (paleta/componentes) + `comum.js` (formato) + `painel.js` (dados/estado/render). Não recriar `esc`/`cor`/`baseOption` — uma cópia já divergiu | NOTAS 39, 42 |
| docs/ | Estado da tela vive no **hash** da URL. Telas antigas são redirecionamentos: link compartilhado não pode quebrar | NOTAS 42 |
| docs/ | Fonte do redesign é Gotham (licenciada, não redistribuível). O site usa Montserrat (SIL OFL) | NOTAS 42 |
| docs/ | Item de grid precisa de `min-width: 0`: o canvas do ECharts fixa largura em px e arrasta a página inteira no celular | NOTAS 39 |
| Verificação | Casar por valor não é casar por assunto: "R$ 45 por habitante" em Caruaru casava com a **contagem** de emendas de Caruaru. Use `rotulosEsperados` | `verificar-post.ts` |
| Verificação | Ordinal e citação legal são ignorados de propósito — "2º" casava com Afrânio, "EC 86/2015" com um per capita. Portaria, decreto e acórdão entraram depois, com "nº" opcional | `verificar-post.ts` |
| Gabinete | Post nominal traz pessoas **e** custo, sempre. Cabeças contradizem custo, e o tamanho é fixado por ato da Mesa — citar posição sem essa ressalva acusa alguém de decisão que não é dele | NOTAS 43, `agregados-gabinete.ts` |
| Gabinete | Nome de deputado com cifra sai **sem assinatura**. A opinião em 1ª pessoa só nos posts de agregado, onde não há alvo individual | NOTAS 43 |
| Trem | Não existe projeto de passageiros neste eixo. Possibilidade não é promessa: "quando o trem chegar" é frase proibida, e os km em Araripina nunca saem com casa decimal | NOTAS 43, `temas-trem.ts` |
| Trem | Número da ferrovia é fato EXTERNO versionado com id de fonte (`[F25]`), nunca `fatosExternos` na hora — declarar o próprio cálculo transforma o verificador em carimbo | `transnordestina.ts` |
| Série | Tema assinado tem UMA camada, e curta: assinatura + fecho comem ~140 dos 280. Com duas, os 12 primeiros temas de campanha foram descartados em bloco | NOTAS 43 |

## Verificar

`bun run check` (tsc + 280 testes + 40 evals + as travas dos dois jobs) antes de qualquer commit. Nenhum teste toca
a rede: as fixtures são respostas reais capturadas, e é assim que devem
continuar.

Mudou `docs/`? Valide renderizado, não só por diff — e em 390px também, não
só no desktop. Refatoração de CSS pede screenshot de página inteira antes e
depois, comparado por md5 (NOTAS 39). Console tem de ficar limpo: zero erro,
zero aviso — vários bugs desta base
só aparecem no navegador (o `[hidden]` derrotado por `display:flex`, a coluna
que herdou alinhamento numérico). Sirva `docs/` estático e abra.
