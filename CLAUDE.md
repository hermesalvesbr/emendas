# emendas-pe

Coletor resiliente + painel público das emendas parlamentares de Pernambuco
(estaduais da ALEPE e federais com foco em PE). Bun + TypeScript, SQLite,
site estático em `docs/` no GitHub Pages.

`README.md` tem fontes e comandos. `NOTAS.md` tem 31 achados numerados — cada
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

## Verificar

`bun run check` (tsc + 96 testes) antes de qualquer commit. Nenhum teste toca
a rede: as fixtures são respostas reais capturadas, e é assim que devem
continuar.

Mudou `docs/`? Valide renderizado, não só por diff — vários bugs desta base
só aparecem no navegador (o `[hidden]` derrotado por `display:flex`, a coluna
que herdou alinhamento numérico). Sirva `docs/` estático e abra.
