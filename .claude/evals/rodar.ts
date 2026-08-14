#!/usr/bin/env bun
// Runner dos evals de post. Mede taxa de aprovação, tempo e o que falhou.
//
// Cada caso declara o veredito ESPERADO. O eval passa quando o verificador
// chega ao mesmo veredito — e, quando o caso nomeia uma regra, quando é
// exatamente essa regra que dispara. Um verificador que reprova tudo teria
// 100% nos casos negativos e 0% nos positivos; por isso os dois tipos entram.

import { Database } from "bun:sqlite";
import { verificarPost } from "../../src/verificar-post.ts";
import type { Fato } from "../../src/verificar-post.ts";

type Caso = {
  id: string;
  esperado: "aprovar" | "reprovar";
  regra?: string;
  texto: string;
  fatosExternos?: Fato[];
  nota?: string;
};

const casos = (await Bun.file(new URL("posts.jsonl", import.meta.url)).text())
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Caso);

const db = new Database("data/emendas.sqlite", { readonly: true });
const inicio = Bun.nanoseconds();
let passou = 0;
const falhas: string[] = [];

for (const c of casos) {
  const v = verificarPost(c.texto, db, { fatosExternos: c.fatosExternos });
  const veredito = v.ok ? "aprovar" : "reprovar";
  const regras = v.achados.map((a) => a.regra);

  const vereditoOk = veredito === c.esperado;
  const regraOk = !c.regra || regras.includes(c.regra);
  const ok = vereditoOk && regraOk;

  if (ok) passou++;
  else {
    falhas.push(
      `${c.id}: esperava ${c.esperado}${c.regra ? ` por "${c.regra}"` : ""}, ` +
        `obteve ${veredito}${regras.length ? ` (${[...new Set(regras)].join(", ")})` : ""}`,
    );
  }

  const marca = ok ? "ok  " : "FALHA";
  console.log(`  ${marca} ${c.id.padEnd(26)} peso ${String(v.peso).padStart(3)}  ${[...new Set(regras)].join(", ") || "—"}`);
}

const ms = (Bun.nanoseconds() - inicio) / 1e6;
console.log(`\ntaxa de aprovação: ${passou}/${casos.length} (${((100 * passou) / casos.length).toFixed(0)}%) em ${ms.toFixed(0)} ms`);
if (falhas.length > 0) {
  console.log("\nfalhas:");
  for (const f of falhas) console.log(`  - ${f}`);
}
db.close();
process.exitCode = passou === casos.length ? 0 : 1;
