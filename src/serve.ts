// API de consulta local (§5.8): Bun.serve com rotas nomeadas, sem framework.

import type { Db } from "./db.ts";
import { openDb } from "./db.ts";
import type { Config } from "./types.ts";
import page from "./index.html";

export function serve(config: Config, db: Db = openDb()) {
  return Bun.serve({
    port: config.server.port,
    routes: {
      "/": page,

      "/api/autores": () => Response.json(db.listAutores()),

      "/api/autor/:nome": (req) => Response.json(db.emendasPorAutor(req.params.nome)),

      "/api/municipio/:nome": (req) => Response.json(db.empenhosPorMunicipio(req.params.nome)),

      "/api/exercicio/:ano": (req) => {
        const ano = Number(req.params.ano);
        if (!Number.isInteger(ano)) return Response.json({ erro: "ano inválido" }, { status: 400 });
        return Response.json(db.empenhosPorExercicio(ano));
      },

      "/api/orfaos": () => Response.json(db.orfaos()),

      "/api/saude": () => Response.json(db.harvestLogTail(50)),
    },
    error(err) {
      console.error("[servir] erro não tratado:", err);
      return Response.json({ erro: "erro interno" }, { status: 500 });
    },
  });
}
