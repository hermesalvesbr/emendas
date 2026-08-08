// A parte do "insistir" — backoff exponencial com jitter, sem biblioteca (§5.1).

export type AttemptReason = "http" | "timeout" | "empty" | "parse";

export type Attempt<T> =
  | { ok: true; value: T; attempts: number; elapsedMs: number }
  | { ok: false; reason: AttemptReason; status?: number; attempts: number; lastError: Error };

export type InsistOptions = {
  maxAttempts?: number;
  baseMs?: number;
  capMs?: number;
  timeoutMs?: number;
};

const DEFAULT_OPTIONS = {
  maxAttempts: 12,
  baseMs: 1000,
  capMs: 60_000,
  timeoutMs: 30_000,
} satisfies Required<InsistOptions>;

/** Erro de domínio que `fn` deve lançar para comunicar a `insist()` por que falhou. */
export class HarvestError extends Error {
  readonly reason: AttemptReason;
  readonly status?: number;

  constructor(reason: AttemptReason, message: string, opts?: { status?: number; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "HarvestError";
    this.reason = reason;
    this.status = opts?.status;
  }
}

export async function insist<T>(
  label: string,
  fn: (signal: AbortSignal, attempt: number) => Promise<T>,
  opts?: InsistOptions,
): Promise<Attempt<T>> {
  const { maxAttempts, baseMs, capMs, timeoutMs } = { ...DEFAULT_OPTIONS, ...opts };
  const startNs = Bun.nanoseconds();

  let lastReason: AttemptReason = "http";
  let lastStatus: number | undefined;
  let lastError: Error = new Error(`${label}: nenhuma tentativa executada`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const value = await fn(signal, attempt);
      logAttempt(label, "ok", attempt, maxAttempts);
      return { ok: true, value, attempts: attempt, elapsedMs: nsToMs(Bun.nanoseconds() - startNs) };
    } catch (err) {
      const classified = classify(err);
      lastReason = classified.reason;
      lastStatus = classified.status;
      lastError = classified.error;

      const isLast = attempt === maxAttempts;
      if (!isRetryable(classified.reason, classified.status) || isLast) {
        logAttempt(label, "fail", attempt, maxAttempts);
        return { ok: false, reason: lastReason, status: lastStatus, attempts: attempt, lastError };
      }

      logAttempt(label, "retry", attempt, maxAttempts);
      const delay = fullJitterDelay(attempt, baseMs, capMs);
      await Bun.sleep(delay);
    }
  }

  return { ok: false, reason: lastReason, status: lastStatus, attempts: maxAttempts, lastError };
}

function fullJitterDelay(attempt: number, baseMs: number, capMs: number): number {
  const cappedExponential = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.random() * cappedExponential;
}

function classify(err: unknown): { reason: AttemptReason; status?: number; error: Error } {
  if (err instanceof HarvestError) {
    return { reason: err.reason, status: err.status, error: err };
  }
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return { reason: "timeout", error: err };
  }
  const error = err instanceof Error ? err : new Error(String(err));
  return { reason: "http", error };
}

// 503/504 são o modo de falha padrão do Pentaho e devem ser retentados; 404 é uma
// falha real de rota (ex.: proxy da ALEPE) e não deve ser confundida com o painel fora do ar.
function isRetryable(reason: AttemptReason, status?: number): boolean {
  switch (reason) {
    case "timeout":
    case "empty":
      return true;
    case "http":
      return status !== 404;
    case "parse":
      return false;
  }
}

function nsToMs(ns: number): number {
  return ns / 1_000_000;
}

function logAttempt(label: string, kind: "ok" | "retry" | "fail", attempt: number, maxAttempts: number): void {
  const colorName = kind === "ok" ? "green" : kind === "retry" ? "yellow" : "red";
  const symbol = kind === "ok" ? "OK" : kind === "retry" ? "RETRY" : "DESISTIU";
  const ansi = Bun.color(colorName, "ansi") ?? "";
  const reset = ansi ? "[0m" : "";
  console.error(`${ansi}[${symbol}]${reset} ${label} — tentativa ${attempt}/${maxAttempts}`);
}
