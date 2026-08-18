---
name: publicar
description: Publica o painel de emendas em produção (GitHub Pages) com a validação de 4 frentes deste projeto. Use ao alterar docs/, os JSONs exportados, ou qualquer coisa servida pelo site. Não use para publicar no X nem para escrever posts.
---

# Publicar o painel

Sequência fixa. Cada passo existe porque algum deles já falhou silenciosamente
neste repositório.

## 1. Regerar e checar

```bash
bun run check          # tsc + 96 testes; nenhum toca a rede
bun run site           # regenera os 4 JSONs de docs/
```

`bun run site` **lança** se a soma de um JSON divergir do banco. Se lançou, o
dado mudou de verdade — investigue, não afrouxe o invariante.

## 2. Validar renderizado, não só o diff

Bugs desta base só aparecem no navegador: `[hidden]` derrotado por
`display:flex` nos filtros, coluna herdando alinhamento numérico de outro
modo, badge que não casa chave.

```bash
setsid bun -e 'Bun.serve({port:4173,fetch(r){const p=new URL(r.url).pathname;
  return new Response(Bun.file("docs"+(p==="/"?"/index.html":p)));}})' </dev/null >/dev/null 2>&1 & disown
```

Abra `http://localhost:4173/`. O painel é uma casca única com quatro abas e o
estado vive no hash da URL — percorra **as quatro abas** e, dentro de Emendas,
**as seis esferas** (estadual, dep. federais, senadores, bancada, gasto federal,
bens). Em cada uma confira: **zero erro E zero aviso de console**, KPIs
preenchidos, gráficos desenhados e tabela com as colunas daquela esfera.

Confira também, porque são caminhos que já quebraram:

- **Território:** as três vistas (por município, por 100 mil, base eleitoral de
  2022) e o mapa desenhando os 185 municípios. A escala linear apagava o estado,
  porque o Recife tem 387 candidatos e o segundo colocado tem 31.
- **Gabinetes:** clicar numa linha abre os nomes; filtrar por pessoa recalcula a
  contagem **e** o custo, sem perder o foco do campo.
- **Perfil:** trocar de deputado, entrar e sair da comparação, e o permalink
  (`#tab=deputados&dep=<slug>`) reabrindo no mesmo deputado.
- **Redirecionamentos:** `/deputado.html?d=<slug>`, `/gabinetes.html` e
  `/candidatos.html` têm de cair na aba certa — são links já compartilhados.
- **390px:** rolagem horizontal do `<body>` tem de ser zero. O canvas do ECharts
  fixa largura em px e arrasta a página inteira sem `min-width: 0` no item de
  grid (NOTAS 39).

## 3. Commit e push

Mensagem em português, explicando **por que** e não o quê. Se a mudança nasceu
de uma armadilha da fonte, cite o item do NOTAS.md.

## 4. Validar em produção

O Pages leva 1–5 min. Confirme que o arquivo novo está servido antes de dizer
que está no ar:

```bash
bun -e 'const U="https://hermesalvesbr.github.io/emendas/";
for(let i=0;i<24;i++){const r=await fetch(U+"dados.json",{cache:"no-store"});
  if(r.ok){console.log("no ar:",(await r.json()).geradoEm);process.exit(0)}
  await Bun.sleep(15000)}console.log("Pages nao atualizou")'
```

Depois abra a URL de produção e repita o passo 2 nela. "Fez push" não é
"está no ar".

## Ao terminar

Encerre servidor e navegador de validação — este projeto já deixou porta 3000
e perfil de Chrome pendurados em `/tmp`.
