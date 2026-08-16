---
name: post-do-dia
description: Escreve e verifica texto público com números do painel de emendas, candidaturas ou bens. Use para a série automática de 3 em 3 horas (13/08 a 03/10/2026) e para qualquer texto avulso — rascunho, correção, errata, réplica. Não use para código nem para o painel.
---

# Post do dia

Há dois regimes, e eles não seguem a mesma regra:

- **A série** (de 3 em 3 horas, 8 por dia, até 03/10) é **gerada**, não escrita.
  Tom afirmativo, sem pergunta. Veja "A série não se escreve à mão".
- **O texto avulso** (errata, réplica, resposta a alguém) é escrito à mão e
  pode perguntar — porque há alguém para responder nos 30 minutos seguintes.

O que vale para os dois está abaixo.

## 1. Puxe o número do banco, nunca da memória

Isto não é zelo excessivo: **três erros já foram publicados** por números
escritos de cabeça — duas populações arredondadas e a contagem de emendas
inflada em todos os 12 posts regionais.

Não escreva SQL novo para um recorte que já existe. `src/agregados.ts` é a
fonte única: `agregadoPorMunicipio`, `agregadoPorAutorEstadual`,
`agregadoPorAutorFederal`, `agregadoPorFuncao`, `liderPorMunicipio`. Ele
existe porque duas cópias do mesmo SQL divergiram, e foi assim que a contagem
inflada nasceu.

```bash
bun -e 'import {Database} from "bun:sqlite";
import {agregadoPorMunicipio} from "./src/agregados.ts";
const d=new Database("data/emendas.sqlite",{readonly:true});
console.log(agregadoPorMunicipio(d).slice(0,5)); d.close();'
```

Contagem e valor precisam sair do **mesmo universo**. O erro publicado foi
contar emendas sem empenho no escopo e casar com um valor que só somava as
com empenho — duas populações diferentes na mesma frase. `agregados.ts`
devolve `n` e `v` na mesma linha justamente para tornar isso impossível.

## 2. Escreva na forma que o algoritmo distribui

- **Número na primeira linha, contexto na segunda, fecho declarativo na
  terceira.** A série é afirmativa: ela informa, não interroga.
- **Sem pergunta no fecho da série.** Pergunta só rende quando o autor está
  por perto para responder — resposta vale ~27x um like. A 8 posts por dia
  não há como ficar meia hora em cada um, e a pergunta sem resposta lê como
  automação. Em post avulso, pergunte à vontade.
- **Sem link no corpo** — custa de 50% a 90% de alcance; vai na 1ª resposta.
- **Post avulso, nunca resposta.** `publicarAvulso`, não `publicarThread`. A
  thread de agosto tinha 3 posts no ar e só 1 aparecia na aba "Posts" do
  perfil: os outros dois eram respostas, e o X os esconde ali.
- Tom construtivo: post combativo é distribuído menos mesmo engajando bem.

## 3. Verifique antes de publicar

```bash
bun run verificar-post -- --texto "$(cat rascunho.txt)"
```

O verificador reprova peso acima de 280, link no corpo, frase proibida e
**todo número que não casa com o banco**. Número que vem de fora (IBGE, lei)
precisa ser declarado como fato externo — declarar é o ato de assumir que
você conferiu.

**Casar por valor não garante casar por assunto.** Medido: `"Caruaru recebeu
R$ 45 por habitante"` era **aprovado**, porque 45 é o *número de emendas* de
Caruaru. O mesmo "R$ 45" também casava com o per capita de *Carpina*. Por
isso os posts gerados passam `rotulosEsperados`: o fato que casou tem de ser
o que o post afirma, não qualquer um do mesmo valor. Ao escrever à mão, leia
o rótulo que o verificador imprime em cada `numero-conferido`.

## 4. A série não se escreve à mão

```bash
bun run gerar:pool      # templates x banco -> data/pool-posts.json (revise os descartes)
bun run agendar         # pool -> data/fila-posts.json, 392 slots de 16/08 a 03/10
bun run ensaiar:fila    # verifica os 392 contra o banco de agora, sem rede
bun run postar:slot     # ensaio de um slot; --confirmar publica
```

Escrever um post da série à mão é sinal de que **falta um template**. O
caminho é acrescentar o template em `src/gerar-posts.ts` e regerar — assim o
recorte novo vale para os 183 municípios, não só para um.

Se o banco for recoletado, o pool fica defasado e o cron falha fechado (não
publica). `ensaiar:fila` é o que responde "a fila inteira ainda é verdade?".

Para uma data com texto próprio (7 de setembro, uma errata), use o bloco
`fixos` de `data/fila-posts.json`: ele sobrepõe o slot e sobrevive a um
`agendar`.

## 5. Depois de publicar

Post avulso: fique meia hora. Os primeiros 30 minutos definem o teto de
alcance, e resposta do autor é o sinal mais forte que existe.

Série: o cron publica sozinho e em silêncio. O que olhar é o resumo do dia
(`bun run postar:slot -- --resumo`), que lista os 8 slots com a URL de cada
um ou o motivo de não ter saído.

## Nunca

- Afirmar que alguém **não** é candidato — a lista do TSE só sustenta o
  positivo (NOTAS.md 29). O verificador reprova a frase.
- Dizer "represento a região X" — não existe distrito eleitoral no Brasil.
  O verificador reprova a frase.
- Tratar piso legal como escolha política: saúde lidera as emendas por
  obrigação constitucional de 50% (EC 86/2015 e EC 126/2022), não por decisão
  da bancada. "Emenda Pix" tem regra (art. 166-A, mínimo de 70% em capital);
  o que falta é o registro do setor.
- **Citar posição de ranking em número.** O verificador ignora ordinal de
  propósito (o "2" de "2º Suplente" casava com as emendas de Afrânio), então
  um "3º lugar" errado passaria sem lastro. Escreva "o maior de Pernambuco",
  "entre os dez maiores".
- **Declarar como fato externo um número que você mesmo calculou.** Isso
  transforma o verificador em carimbo: você declara o erro como conferido e
  ele vai ao ar assinado. Número derivado (per capita, união de conjuntos)
  entra em `indiceDeFatos`, para ser rederivado do banco na hora de publicar.
- **Citar cidade sem UF e sem região.** PE tem municípios com nome de gente —
  João Alfredo, Joaquim Nabuco, Vicência. "João Alfredo recebeu R$ 3,6 mi em
  emendas" lê como uma pessoa recebendo o dinheiro, o que num post de campanha
  sugere enriquecimento de alguém que não existe. Foi assim que o primeiro
  post da série de 3 h foi ao ar. Use `cidadeCom(nome, regiao)`, e ponha a
  identificação na PRIMEIRA linha: rodapé é a primeira camada a cair quando o
  texto estoura 280.
- Usar nome de autor que não está em `autoria_oficial`. O banco tem
  `"APORTE FINANCEIRO"` e `": EDUI"` com confiança alta — sobras de regex
  sobre texto livre. `agregados.ts` já os filtra; não contorne a catraca.
