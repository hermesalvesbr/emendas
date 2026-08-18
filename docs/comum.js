/* Utilitários compartilhados do painel: formatação, tema e base do ECharts.
 *
 * Um único lugar para cada regra. Cópias divergentes já custaram caro aqui —
 * o `esc` de uma tela deixou de escapar aspa simples sem ninguém notar
 * (NOTAS 39).
 *
 * Namespace global em vez de módulo ES: o site é estático no GitHub Pages e os
 * scripts já rodam em IIFE. `type="module"` só traria CORS em file:// sem
 * ganho nenhum.
 */
(function (global) {
  "use strict";

  /* ------------------------------------------------------------- formato */

  /** Escapa para interpolação em HTML. Aspa simples inclusa. */
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const num = (v) => (v == null ? "—" : Number(v).toLocaleString("pt-BR"));

  const moeda = (v) =>
    v == null ? "—" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

  /**
   * Reais em escala legível ("R$ 3,7 mi"), para eixo e rótulo de gráfico.
   * Nunca usar em texto publicado sem o valor exato ao lado: arredondar de
   * memória já colocou dois números errados no ar (ver POSTS-X.md).
   */
  function curto(v) {
    if (v == null) return "—";
    const a = Math.abs(v);
    if (a >= 1e9) return "R$ " + (v / 1e9).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " bi";
    if (a >= 1e6) return "R$ " + (v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mi";
    if (a >= 1e3) return "R$ " + (v / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + " mil";
    return "R$ " + Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 0 });
  }

  const data = (iso) => (iso ? String(iso).slice(0, 10).split("-").reverse().join("/") : "—");

  /** Caixa alta do banco vira nome próprio legível, preservando partículas. */
  const MINUSCULAS = new Set(["de", "da", "do", "das", "dos", "e", "em", "a", "o"]);
  function cap(s) {
    if (!s) return "—";
    return String(s)
      .toLocaleLowerCase("pt-BR")
      .split(/\s+/)
      .map((p, i) => (i > 0 && MINUSCULAS.has(p) ? p : p.charAt(0).toLocaleUpperCase("pt-BR") + p.slice(1)))
      .join(" ");
  }

  /* --------------------------------------------------------------- tema */

  const CHAVE_TEMA = "emendas-pe-tema";

  /** Valor atual de um token do tema — muda sozinho com claro/escuro. */
  const cor = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#888";

  function temaSalvo() {
    try {
      const v = localStorage.getItem(CHAVE_TEMA);
      return v === "dark" || v === "light" ? v : null;
    } catch {
      return null;
    }
  }

  function aplicarTema(t) {
    document.documentElement.setAttribute("data-theme", t);
    try {
      localStorage.setItem(CHAVE_TEMA, t);
    } catch {
      /* modo privado: o tema vale só para esta sessão */
    }
  }

  /** Tema efetivo agora, considerando escolha salva e preferência do sistema. */
  function temaAtual() {
    const escolhido = document.documentElement.getAttribute("data-theme");
    if (escolhido) return escolhido;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  /** Executa `cb` quando a preferência do sistema mudar (sem escolha explícita). */
  function aoTrocarTema(cb) {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", cb);
  }

  /* ------------------------------------------------------------ echarts */

  /** Base de toda opção: fonte, tooltip e eixo já no tema corrente. */
  function baseOption() {
    return {
      animation: false,
      textStyle: { fontFamily: cor("--pe-sans") || "system-ui, sans-serif" },
      tooltip: {
        backgroundColor: cor("--pe-surface"),
        borderColor: cor("--pe-border"),
        textStyle: { color: cor("--pe-text"), fontSize: 12 },
        confine: true,
      },
    };
  }

  const eixo = () => ({
    axisLabel: { color: cor("--pe-text3"), fontSize: 11 },
    axisLine: { lineStyle: { color: cor("--pe-grid") } },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: cor("--pe-grid") } },
  });

  global.PE = { esc, num, moeda, curto, data, cap, cor, baseOption, eixo, temaSalvo, aplicarTema, temaAtual, aoTrocarTema };
})(window);
