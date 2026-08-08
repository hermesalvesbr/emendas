// Insistência de longo prazo (§5.7): o painel pode ficar dias fora, o watchdog
// cobre isso rodando `discover()` de novo assim que ele voltar.

import { discover } from "./discover.ts";
import type { DiscoveryReport } from "./discover.ts";
import type { Config } from "./types.ts";

export type PingResult = { ok: boolean; status?: number };

export async function pingPentaho(config: Config): Promise<PingResult> {
  try {
    const response = await fetch(config.pentaho.panelUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(config.retry.timeoutMs),
      headers: { "User-Agent": config.http.userAgent },
    });
    if (response.status === 405) {
      // alguns servidores Pentaho não aceitam HEAD; cai para GET.
      const getResponse = await fetch(config.pentaho.panelUrl, {
        signal: AbortSignal.timeout(config.retry.timeoutMs),
        headers: { "User-Agent": config.http.userAgent },
      });
      return { ok: getResponse.ok, status: getResponse.status };
    }
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false };
  }
}

/**
 * Fica reinsistindo em `config.watch.cronPattern` (default `*\/15 * * * *`,
 * divisor de 60) até o painel responder, dispara uma descoberta e para
 * sozinho. `Bun.cron` já garante não-sobreposição — sem lock manual.
 */
export async function vigiar(config: Config): Promise<DiscoveryReport | null> {
  process.on("unhandledRejection", (reason) => {
    console.error("[vigiar] rejeição não tratada (seguindo em frente):", reason);
  });

  let resolveDone!: (report: DiscoveryReport | null) => void;
  const done = new Promise<DiscoveryReport | null>((resolve) => {
    resolveDone = resolve;
  });

  using job = Bun.cron(config.watch.cronPattern, async function (this: Bun.CronJob) {
    console.error(`[vigiar] verificando painel Pentaho (padrão: ${config.watch.cronPattern})...`);
    const ping = await pingPentaho(config);

    if (!ping.ok) {
      console.error(`[vigiar] ainda indisponível (status=${ping.status ?? "erro de rede"}) — tenta de novo no próximo tick`);
      return;
    }

    console.error(`[vigiar] painel respondeu ${ping.status} — disparando descoberta`);
    const report = await discover(config);
    this.stop();
    resolveDone(report);
  });

  return await done;
}
