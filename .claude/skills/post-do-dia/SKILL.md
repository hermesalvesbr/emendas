---
name: post-do-dia
description: Escreve e verifica um post da série diária de Pernambuco (13/08 a 01/10/2026) para publicar no X. Use ao redigir qualquer texto público com números do painel de emendas, candidaturas ou bens — inclusive rascunho, correção e errata. Não use para código nem para o painel.
---

# Post do dia

O calendário dos 50 dias define o assunto de cada data. Este skill cuida do
que vem depois: transformar o assunto num post que não pode ser desmentido.

## 1. Puxe o número do banco, nunca da memória

Isto não é zelo excessivo: **três erros já foram publicados** por números
escritos de cabeça — duas populações arredondadas e a contagem de emendas
inflada em todos os 12 posts regionais.

```bash
bun -e 'const {Database}=require("bun:sqlite");
const d=new Database("data/emendas.sqlite",{readonly:true});
console.log(d.query("SELECT ...").all()); d.close();'
```

Contagem e valor precisam sair do **mesmo universo**. O erro publicado foi
contar emendas sem empenho no escopo e casar com um valor que só somava as
com empenho — duas populações diferentes na mesma frase.

## 2. Escreva na forma que o algoritmo distribui

- número na primeira linha, contexto na segunda, pergunta na terceira;
- **sem link no corpo** — custa de 50% a 90% de alcance; vai na 1ª resposta;
- pergunta final tem que ser respondível por quem é da região ("quanto sua
  cidade recebeu?"), não genérica ("o que você acha?");
- tom construtivo: post combativo é distribuído menos mesmo engajando bem.

## 3. Verifique antes de publicar

```bash
bun run verificar-post -- --texto "$(cat rascunho.txt)"
```

O verificador reprova peso acima de 280, link no corpo e **todo número que
não casa com o banco**. Número que vem de fora (IBGE, lei) precisa ser
declarado como fato externo — declarar é o ato de assumir que você conferiu.

Ele também imprime, para cada número aceito, **com qual fato ele casou**.
Leia: casar por valor não garante casar por assunto. "R$ 47,9 mi" já casou
com um total sem nenhuma relação.

## 4. Publique e fique meia hora

```bash
bun run postar:x -- --responder <id-do-post> --confirmar --texto "link ..."
```

Os primeiros 30 minutos definem o teto de alcance, e resposta do autor é o
sinal mais forte que existe (~150x um like). Publicar e sumir desperdiça o
post.

## Nunca

- Afirmar que alguém **não** é candidato — a lista do TSE só sustenta o
  positivo (NOTAS.md 29).
- Dizer "represento a região X" — não existe distrito eleitoral no Brasil.
- Tratar piso legal como escolha política: saúde lidera as emendas por
  obrigação constitucional de 50%, não por decisão da bancada (NOTAS.md 31).
