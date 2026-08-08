import { describe, expect, jest, test } from "bun:test";
import { HarvestError, insist } from "../src/retry.ts";

/**
 * `Bun.sleep()` respeita `jest.useFakeTimers()` (verificado empiricamente), mas
 * cada rodada de retry só agenda o próximo `Bun.sleep` depois que a promise de
 * `fn()` rejeita — por isso alternamos "libera microtasks" com "avança o relógio"
 * até a tentativa final assentar, em vez de um único `advanceTimersByTime`.
 */
async function settleWithFakeTimers<T>(promise: Promise<T>, rounds = 20): Promise<T> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
    jest.advanceTimersByTime(1_000_000);
  }
  return promise;
}

const FAST_OPTS = { baseMs: 5, capMs: 20, timeoutMs: 1000 } as const;

describe("insist", () => {
  test("503 é retentado até suceder", async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      const promise = insist(
        "teste-503",
        async () => {
          calls++;
          if (calls < 3) throw new HarvestError("http", "indisponível", { status: 503 });
          return "ok";
        },
        { ...FAST_OPTS, maxAttempts: 5 },
      );
      const result = await settleWithFakeTimers(promise);
      expect(result.ok).toBe(true);
      expect(calls).toBe(3);
      if (result.ok) {
        expect(result.attempts).toBe(3);
        expect(result.value).toBe("ok");
      }
    } finally {
      jest.useRealTimers();
    }
  });

  test("504 também é retentado", async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      const promise = insist(
        "teste-504",
        async () => {
          calls++;
          if (calls < 2) throw new HarvestError("http", "gateway timeout", { status: 504 });
          return "ok";
        },
        { ...FAST_OPTS, maxAttempts: 5 },
      );
      const result = await settleWithFakeTimers(promise);
      expect(result.ok).toBe(true);
      expect(calls).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test("404 não é retentado", async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      const promise = insist(
        "teste-404",
        async () => {
          calls++;
          throw new HarvestError("http", "não encontrado", { status: 404 });
        },
        { ...FAST_OPTS, maxAttempts: 5 },
      );
      const result = await settleWithFakeTimers(promise);
      expect(result.ok).toBe(false);
      expect(calls).toBe(1);
      if (!result.ok) {
        expect(result.reason).toBe("http");
        expect(result.status).toBe(404);
        expect(result.attempts).toBe(1);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  test("corpo vazio (HTTP 200 sem conteúdo) é retentado", async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      const promise = insist(
        "teste-vazio",
        async () => {
          calls++;
          if (calls < 2) throw new HarvestError("empty", "corpo vazio");
          return { linhas: 1330 };
        },
        { ...FAST_OPTS, maxAttempts: 5 },
      );
      const result = await settleWithFakeTimers(promise);
      expect(result.ok).toBe(true);
      expect(calls).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test("teto de tentativas é respeitado ao falhar sempre", async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      const promise = insist(
        "teste-teto",
        async () => {
          calls++;
          throw new HarvestError("http", "sempre 503", { status: 503 });
        },
        { ...FAST_OPTS, maxAttempts: 4 },
      );
      const result = await settleWithFakeTimers(promise);
      expect(result.ok).toBe(false);
      expect(calls).toBe(4);
      if (!result.ok) {
        expect(result.attempts).toBe(4);
        expect(result.reason).toBe("http");
      }
    } finally {
      jest.useRealTimers();
    }
  });

  test("erro de parse não é retentado", async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      const promise = insist(
        "teste-parse",
        async () => {
          calls++;
          throw new HarvestError("parse", "JSON malformado");
        },
        { ...FAST_OPTS, maxAttempts: 5 },
      );
      const result = await settleWithFakeTimers(promise);
      expect(result.ok).toBe(false);
      expect(calls).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("erro de timeout do AbortSignal é classificado e retentado", async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      const promise = insist(
        "teste-timeout",
        async () => {
          calls++;
          if (calls < 2) throw new DOMException("timed out", "TimeoutError");
          return "ok";
        },
        { ...FAST_OPTS, maxAttempts: 5 },
      );
      const result = await settleWithFakeTimers(promise);
      expect(result.ok).toBe(true);
      expect(calls).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test("mede tempo decorrido com Bun.nanoseconds", async () => {
    const result = await insist("teste-elapsed", async () => "ok", { maxAttempts: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    }
  });
});
