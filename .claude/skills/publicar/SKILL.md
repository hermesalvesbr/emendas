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

Abra `http://localhost:4173/`, percorra **os cinco modos** (estadual, dep.
federais, senadores, bancada, bens) e confira: zero erro de console além do
favicon, KPIs preenchidos, gráficos desenhados, tabela com as colunas do modo.

Depois abra **`/candidatos.html`**, que é página própria e não um modo — o
`eFederal()` do index.html é um catch-all (`modo !== "estadual" && modo !==
"bens"`), então um 6º modo seria renderizado como federal até 14 pontos serem
editados. Nela, confira as três vistas (por município, por 100 mil habitantes,
base eleitoral de 2022), que o mapa desenha os 185 municípios, e que clicar
numa linha da tabela troca o mapa para a votação daquele candidato. Dois erros
já nasceram aqui: `symbolSize` do scatter recebe `(valor, params)` e ler o
objeto direto derrubava o render inteiro; e a escala linear do mapa apagava o
estado, porque o Recife tem 387 candidatos e o segundo colocado tem 31.

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
