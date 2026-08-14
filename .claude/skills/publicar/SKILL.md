---
name: publicar
description: Publica mudanças do painel de emendas em produção (GitHub Pages) com a validação de 4 frentes que este projeto exige. Use ao alterar docs/, os JSONs exportados ou qualquer coisa que o site sirva.
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
