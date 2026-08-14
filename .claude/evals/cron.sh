#!/usr/bin/env bash
# Evals das travas do job automático. Cada caso quebra uma trava de propósito
# e exige que ela segure. Restaura tudo ao final via git.
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
    printf "  FALHA %s\n        esperava /%s/, obteve: %s\n" "$nome" "$esperado" "$(echo "$out" | head -2 | tr '\n' ' ')"
    FALHOU=$((FALHOU+1))
  fi
}

restaurar() { git checkout -- POSTS-X.md data/agenda-posts.json 2>/dev/null; }
trap restaurar EXIT

echo "travas do job emendas-post-do-dia"

# 1. dia sem agenda = silêncio
caso "dia sem agenda fica em silêncio" "nada agendado" \
  $BUN run src/cli.ts postar:agenda --data 2026-12-25

# 2. número que não bate mais com o banco = não publica
python3 - <<'PY'
# troca "41 emendas" por "999 emendas" no post do Araripe: número plausível,
# mas que não existe no banco.
s=open('POSTS-X.md').read()
open('POSTS-X.md','w').write(s.replace('41 emendas com município', '999 emendas com município'))
PY
caso "número fora do banco barra a publicação" "NÃO PUBLICADO|numero-sem-lastro" \
  $BUN run src/cli.ts postar:agenda --data 2026-08-16
restaurar

# 3. conteúdo de campanha antes de 16/08 = não publica
python3 - <<'PY'
import json
d=json.load(open('data/agenda-posts.json'))
d['agenda']['2026-08-14']=12
json.dump(d,open('data/agenda-posts.json','w'),ensure_ascii=False,indent=2)
PY
caso "campanha antes de 16/08 é barrada" "anterior a 2026-08-16" \
  $BUN run src/cli.ts postar:agenda --data 2026-08-14
restaurar

# 4. post já publicado não é republicado
python3 - <<'PY'
import json
d=json.load(open('data/agenda-posts.json'))
d['agenda']['2026-09-01']=0
json.dump(d,open('data/agenda-posts.json','w'),ensure_ascii=False,indent=2)
PY
caso "post 0, já publicado, é pulado" "já está no ar" \
  $BUN run src/cli.ts postar:agenda --data 2026-09-01
restaurar

# 5. agenda apontando para post inexistente = erro claro
python3 - <<'PY'
import json
d=json.load(open('data/agenda-posts.json'))
d['agenda']['2026-09-02']=99
json.dump(d,open('data/agenda-posts.json','w'),ensure_ascii=False,indent=2)
PY
caso "agenda apontando para post inexistente falha alto" "não existe em" \
  $BUN run src/cli.ts postar:agenda --data 2026-09-02
restaurar

echo
echo "$PASSOU passou, $FALHOU falhou"
[ "$FALHOU" -eq 0 ]
