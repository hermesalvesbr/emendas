/* Utilitários compartilhados pelas quatro telas do painel.
 *
 * Cada página tinha sua cópia de `esc`, `css` e `baseOption`. As cópias já
 * haviam divergido: a de gabinetes.html não escapava aspa simples. Um único
 * lugar, um único comportamento.
 *
 * Namespace global em vez de módulo ES: as páginas são servidas como arquivos
 * estáticos no GitHub Pages e os scripts já rodam em IIFE. `type="module"`
 * traria CORS em file:// e adiaria a execução sem ganho nenhum aqui.
 */
(function (global) {
  "use strict";

  /** Escapa para interpolação em HTML. Aspa simples inclusa: atributo com aspa simples é comum. */
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  /** Valor atual de uma custom property do tema — muda sozinho com claro/escuro. */
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  const num = new Intl.NumberFormat("pt-BR");

  /** Reais por extenso, sem centavos. Para valor exato em tabela e tooltip. */
  const moeda = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

  /** Reais com centavos. Onde o centavo importa (valor por habitante). */
  const moedaExata = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

  /**
   * Reais em escala legível ("R$ 3,7 mi") para eixo e rótulo de gráfico.
   * Nunca usar em texto publicado sem o valor exato ao lado: arredondar de
   * memória já colocou dois números errados no ar (ver POSTS-X.md).
   */
  function brlCurto(v) {
    if (v == null) return "—";
    if (Math.abs(v) >= 1e6) return "R$ " + (v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mi";
    if (Math.abs(v) >= 1e3) return "R$ " + (v / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + " mil";
    return "R$ " + v.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  }

  /** ISO (YYYY-MM-DD) para o formato que o leitor brasileiro espera. */
  const dataBR = (iso) => (iso ? String(iso).slice(0, 10).split("-").reverse().join("/") : "—");

  /** Base de toda opção do ECharts: fonte do sistema e tooltip no tema atual. */
  function baseOption() {
    return {
      animationDuration: 300,
      textStyle: { fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif" },
      tooltip: {
        backgroundColor: css("--surface"),
        borderColor: css("--grid"),
        textStyle: { color: css("--ink-1"), fontSize: 12 },
        confine: true,
      },
    };
  }

  const eixoTexto = () => ({ color: css("--ink-2"), fontSize: 11 });
  const linhaGrade = () => ({ lineStyle: { color: css("--grid") } });

  /**
   * Executa `cb` quando o tema do sistema mudar. As cores do ECharts são lidas
   * uma vez na montagem do gráfico, então cada página precisa redesenhar.
   */
  function aoTrocarTema(cb) {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", cb);
  }

  global.PE = { esc, css, num, moeda, moedaExata, brlCurto, dataBR, baseOption, eixoTexto, linhaGrade, aoTrocarTema };
})(window);
