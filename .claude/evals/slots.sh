#!/usr/bin/env bash
# Evals das travas do job de 3 em 3 horas. Cada caso quebra uma trava de
# propósito e exige que ela segure. Restaura tudo ao final.
#
# Complementa cron.sh, que cobre a série diária antiga (postar:agenda).
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
BUN=/home/hermes/.bun/bin/bun
PASSOU=0; FALHOU=0

caso() { # nome, padrão esperado na saída, comando...
  local nome="$1" esperado="$2"; shift 2
  local out; out=$("$@" 2>&1 | grep -vE '^\$ |tentativa')
  if echo "$out" | grep -qE "$esperado"; then
    printf "  ok    %s\n" "$nome"; PASSOU=$((PASSOU+1))
  else
    printf "  FALHA %s\n        esperava /%s/, obteve: %s\n" "$nome" "$esperado" "$(echo "$out" | head -3 | tr '\n' ' ')"
    FALHOU=$((FALHOU+1))
  fi
}

BACKUP=$(mktemp -d)
cp data/fila-posts.json data/pool-posts.json "$BACKUP/" 2>/dev/null
[ -f data/x-publicados.json ] && cp data/x-publicados.json "$BACKUP/publicados.json"

restaurar() {
  cp "$BACKUP/fila-posts.json" data/fila-posts.json 2>/dev/null
  cp "$BACKUP/pool-posts.json" data/pool-posts.json 2>/dev/null
  if [ -f "$BACKUP/publicados.json" ]; then
    cp "$BACKUP/publicados.json" data/x-publicados.json
  else
    rm -f data/x-publicados.json
  fi
}
limpar() { restaurar; rm -rf "$BACKUP"; }
trap limpar EXIT

# O slot de teste é escolhido em tempo de execução entre os NÃO publicados:
# fixar uma data fazia o eval apodrecer assim que aquele slot ia ao ar de
# verdade (a trava de idempotência dispara antes das que se quer exercitar).
export ALVO=$(python3 -c '
import json,os
fila=json.load(open("data/fila-posts.json"))
pub=set()
if os.path.exists("data/x-publicados.json"):
    pub={p["slot"] for p in json.load(open("data/x-publicados.json"))["publicados"]}
print(next(s for s in sorted(fila["slots"]) if s not in pub))
')
# O caso 3 (rótulo divergente) injeta um recorte de CIDADE, e o índice de
# fatos é restrito pelos `dominios` do post substituído. Num post de
# curiosidade ou trem o valor não acha lastro nenhum e a trava reprova por
# numero-sem-lastro — segura, mas pelo motivo errado, testando outra coisa.
# Por isso esse caso tem slot próprio, do eixo que ele de fato exercita.
export ALVO_CIDADE=$(python3 -c '
import json,os
fila=json.load(open("data/fila-posts.json"))
pool={p["id"]: p for p in json.load(open("data/pool-posts.json"))["posts"]}
pub=set()
if os.path.exists("data/x-publicados.json"):
    pub={p["slot"] for p in json.load(open("data/x-publicados.json"))["publicados"]}
print(next(s for s in sorted(fila["slots"])
           if s not in pub and pool.get(fila["slots"][s], {}).get("eixo") == "cidade"))
')
echo "travas do job emendas-post-slot (slot de teste: $ALVO, cidade: $ALVO_CIDADE)"

# 1. Slot fora da fila = silêncio. O job não incomoda fora da série.
caso "slot sem nada agendado fica em silêncio" "nada agendado" \
  $BUN run src/cli.ts postar:slot --slot 2026-12-25T09:00

# 2. Número que não bate mais com o banco = não publica (falha fechada).
python3 - <<'PY'
import json,os
d=json.load(open('data/pool-posts.json'))
alvo=json.load(open('data/fila-posts.json'))['slots'][os.environ['ALVO']]
for p in d['posts']:
    if p['id']==alvo:
        # 999.999 emendas: plausível na forma, inexistente no banco.
        p['texto']="Foram 999.999 emendas federais em Saúde em Pernambuco."
        p['fatos']=[{"valor":999999,"rotulo":"nº de emendas federais em Saúde"}]
json.dump(d,open('data/pool-posts.json','w'),ensure_ascii=False,indent=2)
PY
caso "número fora do banco barra a publicação" "NÃO PUBLICADO|numero-sem-lastro" \
  $BUN run src/cli.ts postar:slot --slot "$ALVO"
restaurar

# 3. Valor que existe no banco mas descreve OUTRA coisa. É a falha dominante
#    num regime sem revisão humana: número plausível, cidade certa, afirmação
#    errada. Medido: "R$ 45 por habitante" em Caruaru casava com a contagem de
#    emendas da própria Caruaru.
python3 - <<'PY'
import json,os
d=json.load(open('data/pool-posts.json'))
alvo=json.load(open('data/fila-posts.json'))['slots'][os.environ['ALVO_CIDADE']]
for p in d['posts']:
    if p['id']==alvo:
        p['texto']="Araripina recebeu R$ 8,0 mi em emendas parlamentares."
        p['fatos']=[{"valor":8000000,"rotulo":"emendas de ARARIPINA"}]
json.dump(d,open('data/pool-posts.json','w'),ensure_ascii=False,indent=2)
PY
caso "valor certo de outra cidade é barrado pelo rótulo" "numero-rotulo-divergente" \
  $BUN run src/cli.ts postar:slot --slot "$ALVO_CIDADE"
restaurar

# 4. Fila apontando para id que não existe no pool = erro alto, não silêncio.
python3 - <<'PY'
import json
d=json.load(open('data/fila-posts.json'))
d['slots']['2026-09-02T09:00']='cidade:CIDADE-QUE-NAO-EXISTE:total'
json.dump(d,open('data/fila-posts.json','w'),ensure_ascii=False,indent=2)
PY
caso "fila apontando para post inexistente falha alto" "não existe no pool" \
  $BUN run src/cli.ts postar:slot --slot 2026-09-02T09:00
restaurar

# 5. Propaganda eleitoral antes de 16/08 = não publica.
python3 - <<'PY'
import json,os
d=json.load(open('data/fila-posts.json'))
alvo=d['slots'][os.environ['ALVO']]
d['slots']['2026-08-14T09:00']=alvo
json.dump(d,open('data/fila-posts.json','w'),ensure_ascii=False,indent=2)
PY
caso "slot anterior a 16/08 é barrado" "anterior a 2026-08-16" \
  $BUN run src/cli.ts postar:slot --slot 2026-08-14T09:00
restaurar

# 6. Idempotência: o que já saiu não sai de novo, nem por slot, nem por
#    recorte, nem por texto idêntico.
python3 - <<'PY'
import json,os
fila=json.load(open('data/fila-posts.json'))
pool=json.load(open('data/pool-posts.json'))
slot=os.environ['ALVO']
alvo=fila['slots'][slot]
post=next(p for p in pool['posts'] if p['id']==alvo)
json.dump({"usuario":"hermes_alves","publicados":[
  {"slot":slot,"post_id":alvo,"hash":post['hash'],
   "id":"1","url":"https://x.com/hermes_alves/status/1","em":"2026-08-16T12:00:00Z"}
]}, open('data/x-publicados.json','w'), ensure_ascii=False, indent=2)
PY
caso "slot já publicado é pulado" "já publicado" \
  $BUN run src/cli.ts postar:slot --slot "$ALVO"

# Mesmo texto num slot diferente: o hash barra.
python3 - <<'PY'
import json,os
fila=json.load(open('data/fila-posts.json'))
fila['slots']['2026-09-03T09:00']=fila['slots'][os.environ['ALVO']]
json.dump(fila,open('data/fila-posts.json','w'),ensure_ascii=False,indent=2)
PY
caso "mesmo recorte em outro slot é barrado pelo hash" "já publicado" \
  $BUN run src/cli.ts postar:slot --slot 2026-09-03T09:00
restaurar

# 7. A fila inteira ainda é verdade contra o banco de agora.
caso "a fila inteira confere com o banco" "0 reprovados" \
  $BUN run src/cli.ts ensaiar:fila

echo
echo "$PASSOU passou, $FALHOU falhou"
[ "$FALHOU" -eq 0 ]
