// Handler scheduled() do cron OS-level (§5.7), instalado via `bun run cron:install`.

import { loadConfig } from "./src/config.ts";
import { openDb } from "./src/db.ts";
import { discover } from "./src/discover.ts";
import { harvestCkan } from "./src/harvest-ckan.ts";

export default {
  async scheduled(controller: Bun.CronController) {
    const quando = new Date(controller.scheduledTime).toISOString();
    console.error(`[worker] disparado por "${controller.cron}" em ${quando}`);

    const config = await loadConfig();
    const db = openDb();
    try {
      const ckanResults = await harvestCkan(db, config);
      const ckanOk = ckanResults.filter((r) => r.status === "ok").length;
      console.error(`[worker] coletar:ckan — ${ckanOk}/${ckanResults.length} exercícios ok`);

      const report = await discover(config);
      if (report.ok) {
        console.error(`[worker] descobrir — ok, ${report.result.callCount} chamadas capturadas`);
      } else {
        console.error(`[worker] descobrir — falhou (${report.reason}): ${report.message}`);
      }
    } finally {
      db.close();
    }
  },
};
