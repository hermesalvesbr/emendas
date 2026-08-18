/* Painel de emendas de Pernambuco — casca única com quatro abas.
 *
 * Organização (uma responsabilidade por bloco):
 *   Dados     carrega os JSON sob demanda, um conjunto por aba
 *   Estado    estado da tela + espelho no hash da URL (permalink)
 *   Graficos  os quatro formatos de gráfico usados, nada além
 *   Abas      uma função de render por aba, sem lógica de dado
 *
 * As telas antigas (candidatos/gabinetes/deputado) viraram redirecionamentos
 * para as abas correspondentes, para não quebrar link já compartilhado.
 */
(function () {
  "use strict";

  const { esc, num, moeda, curto, data, cap, cor, baseOption, eixo } = PE;
  const $ = (s, raiz = document) => raiz.querySelector(s);

  /* =================================================================== dados */

  const ARQUIVOS = {
    estadual: "dados.json",
    federal: "dados-federal.json",
    bens: "dados-bens.json",
    regioes: "regioes.json",
    cand: "dados-candidatos.json",
    indice: "deputados-indice.json",
    origem: "candidatos-origem.json",
    malha: "malha-pe.json",
    pessoal: "dados-pessoal.json",
    deps: "dados-deputados.json",
  };

  /** Quais arquivos cada aba precisa. A de emendas depende da esfera escolhida. */
  const DEPENDENCIAS = {
    emendas: (esfera) => ["regioes", "indice", "cand", esfera === "bens" ? "bens" : esfera === "estadual" ? "estadual" : "federal"],
    territorio: () => ["origem", "malha"],
    gabinetes: () => ["pessoal"],
    deputados: () => ["deps"],
  };

  const Dados = {
    cache: {},
    pendentes: new Set(),

    async carregar(nomes) {
      const faltando = nomes.filter((n) => !this.cache[n] && !this.pendentes.has(n));
      if (!faltando.length) return false;

      faltando.forEach((n) => this.pendentes.add(n));
      const resultados = await Promise.all(
        faltando.map((n) =>
          fetch(ARQUIVOS[n])
            .then((r) => {
              if (!r.ok) throw new Error(`${ARQUIVOS[n]} respondeu ${r.status}`);
              return r.json();
            })
            .catch((err) => {
              // Uma base indisponível não pode derrubar a aba inteira: a tela
              // mostra o que tem e diz o que faltou.
              console.warn("[painel] falha ao carregar", ARQUIVOS[n], err.message);
              return null;
            }),
        ),
      );
      faltando.forEach((n, i) => {
        if (resultados[i]) this.cache[n] = resultados[i];
        this.pendentes.delete(n);
      });
      return true;
    },

    get: function (n) {
      return this.cache[n] || null;
    },
  };

  /* ================================================================== estado */

  const ABAS = ["emendas", "territorio", "gabinetes", "deputados"];
  const ESFERAS = ["estadual", "deputado", "senador", "bancada", "gasto-pe", "bens"];
  const VISTAS = ["absoluto", "percapita", "votos"];
  const POR_PAGINA = 40;
  const TOP_N = 12;

  const Estado = {
    aba: "emendas",
    esfera: "estadual",
    f: { autor: "", mun: "", ex: "", conf: "", regiao: "", partido: "" },
    ordem: { k: "vemp", dir: -1 },
    limite: POR_PAGINA,
    vista: "absoluto",
    ordemTerr: { k: "candidatos", dir: -1 },
    gf: { dep: "", partido: "", pessoa: "" },
    gabAberto: null,
    ordemGab: { k: "total", dir: -1 },
    depA: "",
    depB: "",
    comparando: false,
    carregando: true,

    lerHash() {
      const bruto = (location.hash || "").replace(/^#/, "");
      if (!bruto) return;
      const q = {};
      for (const par of bruto.split("&")) {
        const [k, v] = par.split("=");
        if (k) q[k] = decodeURIComponent(v || "");
      }
      if (ABAS.includes(q.tab)) this.aba = q.tab;
      if (ESFERAS.includes(q.esfera)) this.esfera = q.esfera;
      if (VISTAS.includes(q.vista)) this.vista = q.vista;
      for (const k of Object.keys(this.f)) if (q[k]) this.f[k] = q[k];
      if (q.dep) this.depA = q.dep;
      if (q.depB) {
        this.depB = q.depB;
        this.comparando = true;
      }
    },

    escreverHash() {
      const partes = ["tab=" + this.aba];
      if (this.aba === "emendas") {
        partes.push("esfera=" + this.esfera);
        for (const [k, v] of Object.entries(this.f)) if (v) partes.push(k + "=" + encodeURIComponent(v));
      }
      if (this.aba === "territorio") partes.push("vista=" + this.vista);
      if (this.aba === "deputados") {
        if (this.depA) partes.push("dep=" + this.depA);
        if (this.comparando && this.depB) partes.push("depB=" + this.depB);
      }
      const novo = "#" + partes.join("&");
      if (novo !== location.hash) history.replaceState(null, "", novo);
    },
  };

  /* ================================================================ gráficos */

  const Graficos = {
    vivos: new Map(),

    /** Cria ou reaproveita a instância. Container sem largura ainda não pinta. */
    montar(id, option, aoClicar) {
      const el = document.getElementById(id);
      if (!el || !window.echarts || !el.clientWidth) return null;

      let c = echarts.getInstanceByDom(el);
      if (!c) {
        c = echarts.init(el, null, { renderer: "canvas" });
        this.vivos.set(id, c);
      }
      c.setOption(option, true);
      c.off("click");
      if (aoClicar) c.on("click", aoClicar);
      return c;
    },

    descartar() {
      for (const c of this.vivos.values()) c.dispose();
      this.vivos.clear();
    },

    redimensionar() {
      for (const c of this.vivos.values()) c.resize();
    },

    /** Barras horizontais com rótulo à direita — o formato mais usado do painel. */
    barras(id, itens, corBarra, fmt, aoClicar) {
      const b = baseOption();
      const dados = itens.slice().reverse();
      this.montar(
        id,
        {
          ...b,
          tooltip: { ...b.tooltip, formatter: (p) => `${esc(p.name)}<br><strong>${fmt(p.value)}</strong>` },
          grid: { left: 6, right: 78, top: 8, bottom: 4, containLabel: true },
          xAxis: { type: "value", show: true, ...eixo(), axisLabel: { show: false }, axisLine: { show: false } },
          yAxis: {
            type: "category",
            ...eixo(),
            splitLine: { show: false },
            data: dados.map((x) => x.nome),
            axisLabel: {
              ...eixo().axisLabel,
              width: 104,
              overflow: "truncate",
              margin: 10,
              formatter: (n) => String(n).replace(/^Região /, "").replace(/^Sertão d[eo] /, "Sertão "),
            },
          },
          series: [
            {
              type: "bar",
              barWidth: "62%",
              cursor: aoClicar ? "pointer" : "default",
              data: dados.map((x) => x.valor),
              itemStyle: { color: corBarra, borderRadius: [0, 5, 5, 0] },
              label: { show: true, position: "right", formatter: (p) => fmt(p.value), color: cor("--pe-text3"), fontSize: 11 },
            },
          ],
        },
        aoClicar ? (p) => aoClicar(dados[p.dataIndex]) : null,
      );
    },

    /** Colunas verticais, empilhadas ou não. */
    colunas(id, g) {
      const b = baseOption();
      this.montar(id, {
        ...b,
        tooltip: { ...b.tooltip, trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (x) => curto(x) },
        legend: { top: 0, textStyle: { color: cor("--pe-text2"), fontSize: 11 }, itemHeight: 9, itemWidth: 14 },
        grid: { left: 6, right: 20, top: 34, bottom: 4, containLabel: true },
        xAxis: { type: "category", ...eixo(), splitLine: { show: false }, data: g.cats },
        yAxis: { type: "value", ...eixo(), axisLabel: { ...eixo().axisLabel, formatter: (x) => curto(x) } },
        series: g.series.map((se) => ({
          name: se.nome,
          type: "bar",
          stack: se.stack || null,
          barMaxWidth: 46,
          data: se.dados,
          itemStyle: { color: se.cor, borderRadius: se.stack ? 0 : [4, 4, 0, 0] },
        })),
      });
    },

    donut(id, itens) {
      const b = baseOption();
      const paleta = [cor("--pe-blue"), cor("--pe-amber"), cor("--pe-red"), cor("--pe-cyan"), cor("--pe-text3")];
      this.montar(id, {
        ...b,
        tooltip: { ...b.tooltip, formatter: (p) => `${esc(p.name)}<br><strong>${p.value}</strong> pessoas` },
        legend: { orient: "vertical", right: 0, top: "middle", textStyle: { color: cor("--pe-text2"), fontSize: 11 }, itemHeight: 9, itemWidth: 12 },
        series: [
          {
            type: "pie",
            radius: ["48%", "72%"],
            center: ["34%", "50%"],
            avoidLabelOverlap: true,
            itemStyle: { borderColor: cor("--pe-surface"), borderWidth: 2 },
            label: { show: false },
            data: itens.map((x, i) => ({ name: x.nome, value: x.valor, itemStyle: { color: paleta[i % paleta.length] } })),
          },
        ],
      });
    },

    mapaRegistrado: false,

    mapa(id, pontos, fmt, unidade) {
      const origem = Dados.get("origem");
      const malha = Dados.get("malha");
      if (!origem || !malha || !window.echarts) return;

      if (!this.mapaRegistrado) {
        // O geojson do IBGE só traz `codarea`; o nome vem do nosso lado.
        const nomePorCod = new Map(origem.municipios.filter((m) => m.codIbge).map((m) => [m.codIbge, m.nome]));
        echarts.registerMap("PE", {
          type: "FeatureCollection",
          features: malha.features.map((f) => ({
            ...f,
            properties: { ...f.properties, name: nomePorCod.get(String(f.properties.codarea)) || String(f.properties.codarea) },
          })),
        });
        this.mapaRegistrado = true;
      }

      const b = baseOption();
      const max = pontos.reduce((m, x) => Math.max(m, x.value || 0), 0) || 1;
      this.montar(id, {
        ...b,
        tooltip: {
          ...b.tooltip,
          formatter: (p) =>
            `${esc(p.name)}<br><strong>${p.value == null || Number.isNaN(p.value) ? "sem registro" : fmt(p.value)}</strong> ${esc(unidade)}`,
        },
        visualMap: {
          min: 0,
          max,
          left: 6,
          bottom: 10,
          orient: "vertical",
          calculable: false,
          showLabel: true,
          textStyle: { color: cor("--pe-text3"), fontSize: 10 },
          inRange: { color: [cor("--pe-blue-soft"), cor("--pe-cyan"), cor("--pe-blue"), cor("--pe-deep")] },
          formatter: (x) => fmt(Math.round(x)),
        },
        series: [
          {
            type: "map",
            map: "PE",
            roam: false,
            left: 40,
            right: 8,
            top: 8,
            bottom: 8,
            itemStyle: { borderColor: cor("--pe-border"), borderWidth: 0.6, areaColor: cor("--pe-line") },
            emphasis: { itemStyle: { areaColor: cor("--pe-amber") }, label: { show: false } },
            data: pontos,
          },
        ],
      });
    },
  };

  /* ============================================================== auxiliares */

  /** Soma `valor` agrupando por `chave` e devolve os `n` maiores. */
  function topo(linhas, chave, valor, n) {
    const m = new Map();
    for (const l of linhas) {
      const k = chave(l);
      if (!k) continue;
      m.set(k, (m.get(k) || 0) + (valor(l) || 0));
    }
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => ({ chave: k, nome: cap(k), valor: v }));
  }

  /** Ordena por chave, tratando número e texto, na direção pedida. */
  function ordenar(linhas, k, dir) {
    return linhas.slice().sort((a, b) => {
      const va = a[k] ?? "";
      const vb = b[k] ?? "";
      if (typeof va === "number" || typeof vb === "number") return ((vb || 0) - (va || 0)) * (dir === -1 ? 1 : -1);
      return String(va).localeCompare(String(vb), "pt-BR") * (dir === -1 ? -1 : 1);
    });
  }

  const kpiHtml = (k) =>
    `<div class="kpi"><div class="kpi-v">${esc(k.v)}</div><div class="kpi-l">${esc(k.l)}</div>${
      k.r ? `<div class="kpi-r">${esc(k.r)}</div>` : ""
    }</div>`;

  const destaqueHtml = (d) =>
    `<div class="destaque" style="border-left-color:${esc(d.cor)}">
       <div class="destaque-t">${esc(d.titulo)}</div>
       <div class="destaque-v">${esc(d.valor)}</div>
       <div class="destaque-d">${esc(d.detalhe)}</div>
     </div>`;

  const cabecalhoHtml = (colunas, ordemAtual) =>
    colunas
      .map(
        (c) =>
          `<th data-col="${esc(c.k)}" class="${c.alinha === "right" ? "num" : ""}"${
            ordemAtual.k === c.k ? ` aria-sort="${ordemAtual.dir === -1 ? "descending" : "ascending"}"` : ""
          }>${esc(c.t)}</th>`,
      )
      .join("");

  /* ================================================================== abas */

  const TITULOS = {
    emendas: [
      "Para onde vai o dinheiro das emendas",
      "Execução orçamentária das emendas parlamentares em Pernambuco: quem indicou, qual município recebeu e quanto foi efetivamente pago. Clique nos gráficos para filtrar.",
    ],
    territorio: [
      "De onde são os candidatos de 2026",
      "Naturalidade declarada ao TSE e base eleitoral medida na votação de 2022. Nascer num município não é representá-lo: no Brasil não existe distrito eleitoral.",
    ],
    gabinetes: [
      "Quem trabalha nos gabinetes da ALEPE",
      "Lotação de pessoal publicada pela Casa, com custo mensal estimado a partir da tabela de vencimentos por cargo.",
    ],
    deputados: [
      "Perfil dos deputados estaduais",
      "Emendas executadas, tamanho e custo do gabinete, patrimônio declarado e base eleitoral — um deputado por vez ou dois lado a lado.",
    ],
  };

  const Abas = {};

  /* --------------------------------------------------------- aba: emendas */

  const ROTULO_ESFERA = {
    estadual: "Estaduais (ALEPE)",
    deputado: "Dep. federais de PE",
    senador: "Senadores de PE",
    bancada: "Bancada de PE",
    "gasto-pe": "Gasto federal em PE",
    bens: "Bens dos candidatos 2026",
  };

  function filtrarEmendas() {
    const { esfera, f } = Estado;
    const reg = Dados.get("regioes")?.municipios || {};
    const contem = (campo, v) => !v || String(campo || "").toLowerCase().includes(v.toLowerCase());

    if (esfera === "bens") {
      return (Dados.get("bens")?.linhas || []).filter(
        (l) => contem(l.nome, f.autor) && (!f.regiao || l.regiao === f.regiao) && (!f.partido || l.partido === f.partido),
      );
    }
    if (esfera === "estadual") {
      return (Dados.get("estadual")?.linhas || []).filter((l) => {
        if (!contem(l.autor, f.autor) || !contem(l.mun, f.mun)) return false;
        if (f.ex && String(l.ex) !== f.ex) return false;
        if (f.conf && l.conf !== f.conf) return false;
        if (f.regiao && reg[l.mun] !== f.regiao) return false;
        return true;
      });
    }
    return (Dados.get("federal")?.linhas || []).filter((l) => {
      if (l.cat !== esfera) return false;
      if (!contem(l.autor, f.autor) || !contem(l.mun || l.loc, f.mun)) return false;
      if (f.ex && String(l.ano) !== f.ex) return false;
      if (f.partido && l.partido !== f.partido) return false;
      if (f.regiao && reg[l.mun] !== f.regiao) return false;
      return true;
    });
  }

  Abas.emendas = function () {
    const s = Estado;
    const linhas = filtrarEmendas();
    const bens = s.esfera === "bens";
    const federal = !bens && s.esfera !== "estadual";
    const g = {};

    if (bens) {
      const ordenados = linhas.slice().sort((a, b) => (b.bens || 0) - (a.bens || 0));
      const total = linhas.reduce((a, l) => a + (l.bens || 0), 0);
      const mediana = ordenados.length ? ordenados[Math.floor(ordenados.length / 2)].bens : null;
      const milhao = linhas.filter((l) => (l.bens || 0) >= 1e6);

      g.kpis = [
        { v: curto(total), l: "patrimônio declarado somado" },
        { v: num(linhas.length), l: "candidaturas no filtro" },
        { v: curto(mediana), l: "patrimônio mediano" },
        { v: num(new Set(linhas.map((l) => l.partido)).size), l: "partidos" },
      ];
      g.autores = ordenados.slice(0, TOP_N).map((l) => ({ chave: l.nome, nome: cap(l.nome), valor: l.bens || 0 }));
      g.segundo = topo(linhas, (l) => l.regiao, (l) => l.bens, TOP_N);
      g.chaveSegundo = "regiao";
      const porCargo = topo(linhas, (l) => l.cargo, (l) => l.bens, 8);
      g.terceiro = { cats: porCargo.map((x) => x.nome), series: [{ nome: "Patrimônio declarado", dados: porCargo.map((x) => x.valor), cor: cor("--pe-blue") }] };
      g.tituloAutores = "Maiores patrimônios declarados";
      g.tituloSegundo = "Patrimônio por região de nascimento";
      g.tituloTerceiro = "Patrimônio declarado por cargo em disputa";
      g.subTerceiro = Dados.get("bens")?.ressalva || "Patrimônio declarado pelo próprio candidato ao TSE.";
      g.colunas = [
        { k: "cargo", t: "Cargo 2026" }, { k: "nome", t: "Candidato" }, { k: "regiao", t: "Região de nascimento" },
        { k: "ocup", t: "Ocupação declarada" }, { k: "qtd", t: "Itens", alinha: "right" },
        { k: "bens", t: "Patrimônio", alinha: "right" }, { k: "sup", t: "Suplente", alinha: "right" },
        { k: "partido", t: "Partido", alinha: "right" },
      ];
      const chave = ["bens", "qtd"].includes(s.ordem.k) ? s.ordem.k : "bens";
      g.visiveis = ordenar(ordenados, chave, s.ordem.dir).slice(0, s.limite).map((l) => ({
        celulas: [l.cargo, cap(l.nome), l.regiao || "fora de PE", l.ocup || "—", num(l.qtd), moeda(l.bens), l.sup ? "sim" : "—"],
        tag: { texto: l.partido, classe: "tag-alta" },
      }));
      g.totalOrdenado = ordenados.length;
      g.info = `${num(linhas.length)} candidaturas · ${num(Math.min(s.limite, ordenados.length))} visíveis`;
      g.destaques = [
        { titulo: "Maior patrimônio", valor: ordenados.length ? cap(ordenados[0].nome) : "—", detalhe: ordenados.length ? `${moeda(ordenados[0].bens)} · ${ordenados[0].cargo} · ${ordenados[0].partido}` : "", cor: "var(--pe-blue)" },
        { titulo: "Metade declara menos que", valor: moeda(mediana), detalhe: `mediana entre ${num(linhas.length)} candidaturas no filtro`, cor: "var(--pe-amber)" },
        { titulo: "Acima de R$ 1 milhão", valor: `${num(milhao.length)} candidaturas`, detalhe: `somam ${curto(milhao.reduce((a, l) => a + l.bens, 0))}`, cor: "var(--pe-red)" },
      ];
      g.rotuloAutor = "Candidato";
      g.mostraAutoria = false;
      g.mostraPartido = true;
      g.titulo = "Candidaturas do filtro atual";
    } else {
      const vemp = (l) => l.vemp || 0;
      const total = linhas.reduce((a, l) => a + vemp(l), 0);
      const pago = linhas.reduce((a, l) => a + (l.vpago || 0), 0);

      g.kpis = [
        { v: curto(total), l: "valor empenhado" },
        { v: num(linhas.length), l: federal ? "emendas" : "emendas (subações)" },
        { v: num(new Set(linhas.map((l) => l.autor).filter(Boolean)).size), l: "parlamentares" },
        { v: num(new Set(linhas.map((l) => l.mun).filter(Boolean)).size), l: "municípios" },
      ];
      g.autores = topo(linhas, (l) => l.autor, vemp, TOP_N);
      g.segundo = topo(linhas, (l) => (federal ? l.mun || l.loc : l.mun), vemp, TOP_N);
      g.chaveSegundo = "mun";
      g.tituloAutores = "Top parlamentares por valor empenhado";
      g.tituloSegundo = federal ? "Top destinos por valor empenhado" : "Top municípios por valor empenhado";

      const anos = [...new Set(linhas.map((l) => (federal ? l.ano : l.ex)))].filter(Boolean).sort();
      const somaAno = (a, filtro) => linhas.filter((l) => (federal ? l.ano : l.ex) === a && filtro(l)).reduce((x, l) => x + vemp(l), 0);

      if (federal) {
        g.terceiro = {
          cats: anos,
          series: [
            { nome: "Empenhado", dados: anos.map((a) => somaAno(a, () => true)), cor: cor("--pe-blue") },
            { nome: "Pago", dados: anos.map((a) => linhas.filter((l) => l.ano === a).reduce((x, l) => x + (l.vpago || 0), 0)), cor: cor("--pe-amber") },
          ],
        };
        g.tituloTerceiro = "Empenhado × pago por exercício";
        g.subTerceiro = "Empenhar é reservar o recurso; pagar é a transferência efetiva. A diferença mede execução, não intenção.";
      } else {
        const confs = [
          { k: "alta", nome: "Autoria confirmada", cor: cor("--pe-blue") },
          { k: "media", nome: "Autoria inferida", cor: cor("--pe-amber") },
          { k: "nula", nome: "Sem autor identificado", cor: cor("--pe-text3") },
        ];
        g.terceiro = { cats: anos, series: confs.map((c) => ({ nome: c.nome, stack: "conf", cor: c.cor, dados: anos.map((a) => somaAno(a, (l) => l.conf === c.k)) })) };
        g.tituloTerceiro = "Evolução por exercício e qualidade da autoria";
        g.subTerceiro =
          "confirmada = citada em fonte oficial ou no texto do empenho · inferida = propagação ou dicionário da ALEPE · sem autor = candidata a pedido de LAI";
      }

      g.colunas = federal
        ? [{ k: "cod", t: "Código" }, { k: "autor", t: "Parlamentar" }, { k: "mun", t: "Destino" }, { k: "func", t: "Função" },
           { k: "ano", t: "Exercício", alinha: "right" }, { k: "vemp", t: "Empenhado", alinha: "right" },
           { k: "vpago", t: "Pago", alinha: "right" }, { k: "partido", t: "Partido", alinha: "right" }]
        : [{ k: "em", t: "Emenda" }, { k: "autor", t: "Parlamentar" }, { k: "mun", t: "Município" }, { k: "benef", t: "Beneficiário" },
           { k: "ex", t: "Exercício", alinha: "right" }, { k: "vemp", t: "Empenhado", alinha: "right" },
           { k: "vpago", t: "Pago", alinha: "right" }, { k: "conf", t: "Autoria", alinha: "right" }];

      const ordenadas = ordenar(linhas, s.ordem.k, s.ordem.dir);
      const TAG = { alta: ["tag-alta", "confirmada"], media: ["tag-media", "inferida"], nula: ["tag-nula", "sem autor"] };
      g.visiveis = ordenadas.slice(0, s.limite).map((l) => {
        if (federal) {
          return {
            celulas: [l.num || l.cod, cap(l.autor), cap(l.mun || l.loc), l.func || "—", l.ano, moeda(l.vemp), moeda(l.vpago)],
            tag: { texto: l.partido || "—", classe: "tag-alta" },
          };
        }
        const t = TAG[l.conf] || TAG.nula;
        return {
          celulas: [l.em || l.s || "—", l.autor ? cap(l.autor) : "não identificado", cap(l.mun), cap(l.benef || l.ug), l.ex, moeda(l.vemp), moeda(l.vpago)],
          tag: { texto: t[1], classe: t[0] },
        };
      });
      g.totalOrdenado = ordenadas.length;
      g.info = `${num(linhas.length)} linhas no filtro · ${num(Math.min(s.limite, ordenadas.length))} visíveis · clique num título para ordenar`;

      const topAutor = g.autores[0];
      const topMun = g.segundo[0];
      const semAutor = linhas.filter((l) => !l.autor || l.conf === "nula").reduce((a, l) => a + vemp(l), 0);
      g.destaques = [
        { titulo: "Maior indicação no filtro", valor: topAutor ? topAutor.nome : "—",
          detalhe: topAutor ? `${moeda(topAutor.valor)} empenhados em ${num(linhas.filter((l) => l.autor === topAutor.chave).length)} emendas` : "", cor: "var(--pe-blue)" },
        { titulo: "Município que mais recebeu", valor: topMun ? topMun.nome : "—",
          detalhe: topMun ? `${moeda(topMun.valor)} · ${Dados.get("regioes")?.municipios?.[topMun.chave] || "—"}` : "", cor: "var(--pe-amber)" },
        federal
          ? { titulo: "Efetivamente pago", valor: total ? `${Math.round((pago / total) * 100)}% do empenhado` : "—", detalhe: `${moeda(pago)} de ${moeda(total)}`, cor: "var(--pe-red)" }
          : { titulo: "Sem autoria identificada", valor: total ? `${Math.round((semAutor / total) * 100)}% do valor` : "—",
              detalhe: `${moeda(semAutor)} sem parlamentar confirmado — candidatos a pedido de LAI`, cor: "var(--pe-red)" },
      ];
      g.rotuloAutor = "Parlamentar";
      g.mostraAutoria = !federal;
      g.mostraPartido = federal;
      g.anos = anos;
      g.titulo = "Emendas do filtro atual";
    }

    g.anos = g.anos || [];
    g.regioes = (Dados.get("regioes")?.regioes || []).slice().sort();
    g.partidos = [...new Set(linhas.map((l) => l.partido).filter(Boolean))].sort();
    g.listaAutores = [...new Set(linhas.map((l) => (bens ? l.nome : l.autor)).filter(Boolean))].sort().slice(0, 400);
    g.listaMunicipios = [...new Set(linhas.map((l) => l.mun || l.loc).filter(Boolean))].sort().slice(0, 400);

    const html = `
      <div class="chips" data-acao="esfera">
        ${ESFERAS.map((id) => `<button type="button" class="chip" data-esfera="${id}" aria-pressed="${s.esfera === id}">${esc(ROTULO_ESFERA[id])}</button>`).join("")}
      </div>

      <div class="grade grade-destaque">${g.destaques.map(destaqueHtml).join("")}</div>

      <div class="filtros">
        <label class="campo"><span>${esc(g.rotuloAutor)}</span>
          <input data-f="autor" name="f-autor" id="f-autor" list="pe-autores" placeholder="todos" autocomplete="off" value="${esc(s.f.autor)}"></label>
        <label class="campo"><span>Município</span>
          <input data-f="mun" name="f-mun" id="f-mun" list="pe-municipios" placeholder="todos" autocomplete="off" value="${esc(s.f.mun)}"></label>
        <label class="campo" style="flex:0 1 130px"><span>Exercício</span>
          <select data-f="ex" name="f-ex" id="f-ex"><option value="">todos</option>${g.anos.map((a) => `<option value="${esc(a)}"${String(s.f.ex) === String(a) ? " selected" : ""}>${esc(a)}</option>`).join("")}</select></label>
        <label class="campo"><span>Região</span>
          <select data-f="regiao" name="f-regiao" id="f-regiao"><option value="">todas</option>${g.regioes.map((r) => `<option value="${esc(r)}"${s.f.regiao === r ? " selected" : ""}>${esc(r)}</option>`).join("")}</select></label>
        ${g.mostraAutoria ? `<label class="campo"><span>Autoria</span>
          <select data-f="conf" name="f-conf" id="f-conf"><option value="">todas</option>
            <option value="alta"${s.f.conf === "alta" ? " selected" : ""}>confirmada</option>
            <option value="media"${s.f.conf === "media" ? " selected" : ""}>inferida</option>
            <option value="nula"${s.f.conf === "nula" ? " selected" : ""}>sem autor</option></select></label>` : ""}
        ${g.mostraPartido ? `<label class="campo" style="flex:1 1 140px"><span>Partido</span>
          <select data-f="partido" name="f-partido" id="f-partido"><option value="">todos</option>${g.partidos.map((p) => `<option value="${esc(p)}"${s.f.partido === p ? " selected" : ""}>${esc(p)}</option>`).join("")}</select></label>` : ""}
        <button type="button" class="btn" data-acao="limpar">Limpar</button>
      </div>

      <datalist id="pe-autores">${g.listaAutores.map((x) => `<option value="${esc(x)}"></option>`).join("")}</datalist>
      <datalist id="pe-municipios">${g.listaMunicipios.map((x) => `<option value="${esc(x)}"></option>`).join("")}</datalist>

      <div class="grade grade-kpi">${g.kpis.map(kpiHtml).join("")}</div>

      <div class="grade grade-graficos">
        <section class="cartao cartao-corpo">
          <h2>${esc(g.tituloAutores)}</h2><p class="sub">clique numa barra para filtrar</p>
          <div id="chAutores" class="gr"></div>
        </section>
        <section class="cartao cartao-corpo">
          <h2>${esc(g.tituloSegundo)}</h2><p class="sub">clique numa barra para filtrar</p>
          <div id="chSegundo" class="gr"></div>
        </section>
      </div>

      <section class="cartao cartao-corpo">
        <h2>${esc(g.tituloTerceiro)}</h2><p class="sub">${esc(g.subTerceiro)}</p>
        <div id="chTerceiro" class="gr gr-baixo"></div>
      </section>

      <section class="cartao">
        <div class="cartao-corpo" style="padding-bottom:12px">
          <h2>${esc(g.titulo)}</h2><p class="sub" style="margin:0">${esc(g.info)}</p>
        </div>
        <div class="rolagem">
          <table>
            <thead><tr data-acao="ordenar">${cabecalhoHtml(g.colunas, s.ordem)}</tr></thead>
            <tbody>${g.visiveis.map((l) => `<tr>${l.celulas
              .map((c, i) => `<td class="${i >= 4 ? "num" : "corta"}${i === 1 ? " forte" : ""}">${esc(c)}</td>`)
              .join("")}<td class="num"><span class="tag ${l.tag.classe}">${esc(l.tag.texto)}</span></td></tr>`).join("")}</tbody>
          </table>
        </div>
        ${g.totalOrdenado > s.limite ? `<div class="centro"><button type="button" class="btn btn-azul" data-acao="mais">Mostrar mais linhas</button></div>` : ""}
      </section>`;

    return {
      html,
      pintar() {
        Graficos.barras("chAutores", g.autores, cor("--pe-blue"), curto, (it) => alternarFiltro("autor", it.chave));
        Graficos.barras("chSegundo", g.segundo, cor("--pe-amber"), curto, (it) => alternarFiltro(g.chaveSegundo, it.chave));
        Graficos.colunas("chTerceiro", g.terceiro);
      },
    };
  };

  /* ------------------------------------------------------ aba: território */

  const ROTULO_VISTA = { absoluto: "Candidatos por município", percapita: "Por 100 mil habitantes", votos: "Base eleitoral de 2022" };

  Abas.territorio = function () {
    const s = Estado;
    const o = Dados.get("origem");
    const chips = `<div class="chips" data-acao="vista">${VISTAS.map(
      (id) => `<button type="button" class="chip" data-vista="${id}" aria-pressed="${s.vista === id}">${esc(ROTULO_VISTA[id])}</button>`,
    ).join("")}</div>`;

    if (!o) return { html: chips + `<div class="nota">Base de candidatos indisponível no momento.</div>`, pintar() {} };

    const votosPorCod = new Map();
    for (const c of o.base || []) for (const [cod, n] of c.votosPorMunicipio || []) votosPorCod.set(cod, (votosPorCod.get(cod) || 0) + n);
    const muns = o.municipios.map((m) => ({ ...m, votos: votosPorCod.get(m.codIbge) || 0 }));

    const valorDaVista = (m) => (s.vista === "absoluto" ? m.candidatos : s.vista === "percapita" ? Number(m.por100Mil.toFixed(1)) : m.votos);
    const pontos = muns.map((m) => ({ name: m.nome, value: valorDaVista(m) }));
    const fmt = s.vista === "percapita" ? (x) => Number(x).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) : num;
    const unidade = s.vista === "absoluto" ? "candidatos nascidos ali" : s.vista === "percapita" ? "candidatos por 100 mil hab." : "votos em 2022";
    const tituloMapa =
      s.vista === "absoluto" ? "Município de nascimento dos candidatos"
      : s.vista === "percapita" ? "Candidatos nascidos por 100 mil habitantes"
      : "Votos recebidos em 2022, por município";

    const regioes = (o.regioes || []).slice().sort((a, b) => b.candidatos - a.candidatos)
      .map((rg) => ({ chave: rg.regiao, nome: rg.rotulo, valor: s.vista === "percapita" ? Number(rg.por100Mil.toFixed(1)) : rg.candidatos }));

    const colunas = [
      { k: "nome", t: "Município" }, { k: "regiao", t: "Região" }, { k: "populacao", t: "População", alinha: "right" },
      { k: "candidatos", t: "Candidatos", alinha: "right" }, { k: "por100Mil", t: "Por 100 mil", alinha: "right" },
      { k: "votos", t: "Votos 2022", alinha: "right" },
    ];
    const visiveis = ordenar(muns, s.ordemTerr.k, s.ordemTerr.dir).slice(0, 60);

    const kpis = [
      { v: num(o.totalCandidatos), l: "candidaturas em 2026" },
      { v: num(o.nascidosForaDePE), l: "nasceram fora de Pernambuco" },
      { v: num(o.municipiosSemNativoCandidato), l: "municípios sem nenhum nativo candidato" },
      { v: num(o.totalVotos2022), l: "votos somados em 2022" },
    ];

    const html = `
      ${chips}
      <div class="grade grade-kpi">${kpis.map(kpiHtml).join("")}</div>
      <div class="grade grade-graficos">
        <section class="cartao cartao-corpo">
          <h2>${esc(tituloMapa)}</h2><p class="sub">a cor mede o valor da vista escolhida</p>
          <div id="chMapa" class="gr gr-alto"></div>
        </section>
        <section class="cartao cartao-corpo">
          <h2>Por região de nascimento</h2>
          <p class="sub">quem nasceu fora de PE aparece separado, nunca redistribuído</p>
          <div id="chRegioes" class="gr gr-alto"></div>
        </section>
      </div>
      <div class="nota">${esc(`${o.ressalvaRegiao} ${o.ressalvaBase}`)}</div>
      <section class="cartao">
        <div class="cartao-corpo" style="padding-bottom:12px">
          <h2>Municípios</h2><p class="sub" style="margin:0">${esc(num(muns.length))} municípios · 60 primeiros pela ordenação atual</p>
        </div>
        <div class="rolagem">
          <table>
            <thead><tr data-acao="ordenarTerr">${cabecalhoHtml(colunas, s.ordemTerr)}</tr></thead>
            <tbody>${visiveis.map((m) => `<tr>
              <td class="forte">${esc(m.nome)}</td><td>${esc(m.regiao)}</td>
              <td class="num">${esc(num(m.populacao))}</td><td class="num forte">${esc(num(m.candidatos))}</td>
              <td class="num">${esc(m.por100Mil.toFixed(1))}</td><td class="num">${esc(num(m.votos))}</td></tr>`).join("")}</tbody>
          </table>
        </div>
      </section>`;

    return {
      html,
      pintar() {
        Graficos.mapa("chMapa", pontos, fmt, unidade);
        Graficos.barras("chRegioes", regioes, cor("--pe-blue"), num);
      },
    };
  };

  /* ------------------------------------------------------- aba: gabinetes */

  Abas.gabinetes = function () {
    const s = Estado;
    const p = Dados.get("pessoal");
    if (!p) return { html: `<div class="nota">Base de pessoal indisponível no momento.</div>`, pintar() {} };

    const gf = s.gf;
    const filtradas = p.linhas.filter((l) => {
      if (gf.dep && !l.dep.toLowerCase().includes(gf.dep.toLowerCase())) return false;
      if (gf.partido && l.partido !== gf.partido) return false;
      if (gf.pessoa && !(l.pessoas || []).some((x) => (x.nome || "").toLowerCase().includes(gf.pessoa.toLowerCase()))) return false;
      return true;
    });

    const maxTotal = filtradas.reduce((m, l) => Math.max(m, l.total), 0) || 1;
    const custo = filtradas.reduce((a, l) => a + (l.custo || 0), 0);
    const pessoas = filtradas.reduce((a, l) => a + l.total, 0);

    const kpis = [
      { v: num(filtradas.length), l: "gabinetes no filtro" },
      { v: num(pessoas), l: "pessoas lotadas" },
      { v: curto(custo), l: "custo mensal estimado" },
      { v: curto(custo * 12), l: "por ano (12×, sem 13º)" },
    ];

    const colunas = [
      { k: "dep", t: "Deputado" }, { k: "partido", t: "Partido" },
      { k: "total", t: "Pessoas", alinha: "right" }, { k: "custo", t: "Custo mensal estimado", alinha: "right" }, { k: "", t: "" },
    ];

    const corDaBarra = (t) => (t >= maxTotal * 0.8 ? "var(--pe-red)" : t >= maxTotal * 0.5 ? "var(--pe-amber)" : "var(--pe-blue)");

    const corpo = ordenar(filtradas, s.ordemGab.k, s.ordemGab.dir)
      .map((l) => {
        const aberto = s.gabAberto === l.slug;
        const lista = (l.pessoas || []).slice().sort((a, b) => String(a.nome).localeCompare(String(b.nome), "pt-BR"));
        const cargos = Object.entries(l.cargos || {}).map(([c, n]) => `${n} ${c.toLowerCase()}`).join(" · ");
        const detalhe = aberto
          ? `<tr><td colspan="5" style="padding:0"><div class="detalhe-gab">
               <div class="detalhe-t">${esc(`${l.total} pessoas lotadas · ${cargos}`)}</div>
               <div class="grade grade-pessoas">${lista.map((x) => `<div class="pessoa">
                 <div class="pessoa-n">${esc(cap(x.nome))}</div>
                 <div class="pessoa-d">${esc(`${x.cargo || "sem cargo informado"} · ${x.vinculo || "—"} · desde ${data(x.desde)}${x.venc ? ` · ${moeda(x.venc)}` : ""}`)}</div>
               </div>`).join("")}</div></div></td></tr>`
          : "";
        return `<tr class="linha-gab" data-gab="${esc(l.slug)}">
            <td class="forte">${esc(l.dep)}</td><td>${esc(l.partido || "—")}</td>
            <td class="num forte">${esc(num(l.total))}</td><td class="num">${esc(moeda(l.custo))}</td>
            <td><span class="barra"><span style="width:${Math.round((l.total / maxTotal) * 100)}%;background:${corDaBarra(l.total)}"></span></span></td>
          </tr>${detalhe}`;
      })
      .join("");

    const html = `
      <div class="grade grade-kpi">${kpis.map(kpiHtml).join("")}</div>
      <div class="filtros">
        <label class="campo" style="flex:1 1 220px"><span>Deputado</span>
          <input data-gf="dep" name="gf-dep" id="gf-dep" placeholder="todos" autocomplete="off" value="${esc(gf.dep)}"></label>
        <label class="campo" style="flex:0 1 150px"><span>Partido</span>
          <select data-gf="partido" name="gf-partido" id="gf-partido"><option value="">todos</option>${[...new Set(p.linhas.map((l) => l.partido))].sort()
            .map((x) => `<option value="${esc(x)}"${gf.partido === x ? " selected" : ""}>${esc(x)}</option>`).join("")}</select></label>
        <label class="campo" style="flex:1 1 220px"><span>Pessoa no gabinete</span>
          <input data-gf="pessoa" name="gf-pessoa" id="gf-pessoa" placeholder="nome ou parte" autocomplete="off" value="${esc(gf.pessoa)}"></label>
        <button type="button" class="btn" data-acao="gLimpar">Limpar</button>
      </div>
      <section class="cartao">
        <div class="cartao-corpo" style="padding-bottom:12px">
          <h2>Gabinetes</h2>
          <p class="sub" style="margin:0">${esc(`${num(filtradas.length)} de ${num(p.totalGabinetes)} gabinetes · foto de ${data(p.snapshot)} · clique numa linha para ver quem está lotado`)}</p>
        </div>
        <div class="rolagem">
          <table>
            <thead><tr data-acao="ordenarGab">${cabecalhoHtml(colunas, s.ordemGab)}</tr></thead>
            <tbody data-acao="abrirGab">${corpo}</tbody>
          </table>
        </div>
      </section>
      <div class="nota">${esc(`${p.ressalvaCusto} ${p.ressalva}`)}</div>
      <div class="nota">${esc(p.fonteTransparencia || "")}</div>`;

    return { html, pintar() {} };
  };

  /* ------------------------------------------------------- aba: deputados */

  function segundoSlug(evitar) {
    const perfis = Dados.get("deps")?.perfis || [];
    const outro = perfis.find((x) => x.slug !== evitar);
    return outro ? outro.slug : "";
  }

  Abas.deputados = function () {
    const s = Estado;
    const dd = Dados.get("deps");
    if (!dd) return { html: `<div class="nota">Base de perfis indisponível no momento.</div>`, pintar() {} };

    const perfis = dd.perfis;
    const slugA = perfis.some((x) => x.slug === s.depA) ? s.depA : perfis[0].slug;
    const A = perfis.find((x) => x.slug === slugA);
    const slugB = s.depB && s.depB !== slugA ? s.depB : segundoSlug(slugA);
    const B = s.comparando ? perfis.find((x) => x.slug === slugB) : null;

    const opcoes = perfis.slice().sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    const seletor = (nome, valor) =>
      `<select data-dep="${nome}" name="dep-${nome}" id="dep-${nome}">${opcoes.map((x) => `<option value="${esc(x.slug)}"${x.slug === valor ? " selected" : ""}>${esc(`${x.nome} · ${x.partido}`)}</option>`).join("")}</select>`;

    const kpis = [
      { v: curto(A.emendas?.vemp), l: "empenhado em emendas confirmadas", r: moeda(A.emendas?.vemp) },
      { v: num(A.emendas?.municipios), l: "municípios atendidos", r: `${num(A.emendas?.n)} emendas` },
      { v: num(A.gabinete.total), l: "pessoas no gabinete", r: `${A.gabinete.posicao}º maior dos 49` },
      { v: curto(A.gabinete.custoMensal), l: "custo mensal do gabinete", r: `${A.gabinete.posicaoCusto}º mais caro` },
      { v: A.votacao2022 ? num(A.votacao2022.totalVotos) : "—", l: "votos em 2022", r: A.votacao2022 ? `pico em ${A.votacao2022.nomeMunicipioTop}` : "sem votação registrada" },
      { v: A.bens ? curto(A.bens.total) : "—", l: "patrimônio declarado 2026", r: A.bens ? `${A.bens.qtd} itens declarados` : "sem declaração" },
    ];

    const anos = [...new Set([...(A.emendas?.porExercicio || []).map((x) => x.ex), ...((B?.emendas?.porExercicio) || []).map((x) => x.ex)])].sort();
    const serie = (perfil, campo) => anos.map((a) => (perfil.emendas?.porExercicio || []).find((x) => x.ex === a)?.[campo] || 0);
    const gAno = {
      cats: anos,
      series: B
        ? [{ nome: A.nome, dados: serie(A, "vemp"), cor: cor("--pe-blue") }, { nome: B.nome, dados: serie(B, "vemp"), cor: cor("--pe-red") }]
        : [{ nome: "Empenhado", dados: serie(A, "vemp"), cor: cor("--pe-blue") }, { nome: "Pago", dados: serie(A, "vpago"), cor: cor("--pe-amber") }],
    };

    const comparacao = B
      ? [
          ["Partido", A.partido, B.partido],
          ["Empenhado em emendas", moeda(A.emendas?.vemp), moeda(B.emendas?.vemp)],
          ["Pago", moeda(A.emendas?.vpago), moeda(B.emendas?.vpago)],
          ["Emendas executadas", num(A.emendas?.n), num(B.emendas?.n)],
          ["Municípios atendidos", num(A.emendas?.municipios), num(B.emendas?.municipios)],
          ["Pessoas no gabinete", num(A.gabinete.total), num(B.gabinete.total)],
          ["Custo mensal do gabinete", moeda(A.gabinete.custoMensal), moeda(B.gabinete.custoMensal)],
          ["Votos em 2022", A.votacao2022 ? num(A.votacao2022.totalVotos) : "—", B.votacao2022 ? num(B.votacao2022.totalVotos) : "—"],
          ["Município de maior votação", A.votacao2022?.nomeMunicipioTop || "—", B.votacao2022?.nomeMunicipioTop || "—"],
          ["Patrimônio declarado 2026", A.bens ? moeda(A.bens.total) : "—", B.bens ? moeda(B.bens.total) : "—"],
          ["Candidatura em 2026", A.candidatura2026 ? `${A.candidatura2026.cargo} · ${A.candidatura2026.partido}` : "sem registro",
            B.candidatura2026 ? `${B.candidatura2026.cargo} · ${B.candidatura2026.partido}` : "sem registro"],
        ]
      : [];

    const html = `
      <div class="filtros">
        <label class="campo" style="flex:1 1 240px"><span>Deputado</span>${seletor("A", slugA)}</label>
        <button type="button" class="btn" data-acao="comparar" aria-pressed="${!!B}">${B ? "Sair da comparação" : "Comparar com outro"}</button>
        ${B ? `<label class="campo" style="flex:1 1 240px"><span>Comparar com</span>${seletor("B", B.slug)}</label>` : ""}
      </div>

      ${A.lacunas?.length ? `<div class="nota nota-alerta"><strong>O que este perfil não sabe.</strong> ${esc(A.lacunas.join(" "))}</div>` : ""}

      ${B ? `<section class="cartao"><div class="rolagem"><table>
          <thead><tr><th>Indicador</th><th class="num">${esc(A.nome)}</th><th class="num">${esc(B.nome)}</th></tr></thead>
          <tbody>${comparacao.map(([l, a, b]) => `<tr><td>${esc(l)}</td><td class="num forte">${esc(a)}</td><td class="num forte">${esc(b)}</td></tr>`).join("")}</tbody>
        </table></div></section>`
        : `<div class="grade grade-kpi">${kpis.map(kpiHtml).join("")}</div>`}

      <section class="cartao cartao-corpo">
        <h2>Emendas executadas por exercício</h2>
        <p class="sub">empenhado × efetivamente pago, só emendas de autoria confirmada</p>
        <div id="chDepAno" class="gr gr-baixo"></div>
      </section>

      ${B ? "" : `<div class="grade grade-graficos-med">
        <section class="cartao cartao-corpo"><h2>Para onde foi o dinheiro</h2>
          <p class="sub">municípios que mais receberam, por valor empenhado</p><div id="chDepMun" class="gr"></div></section>
        <section class="cartao cartao-corpo"><h2>Base eleitoral em 2022</h2>
          <p class="sub">${esc(A.votacao2022
            ? `${num(A.votacao2022.totalVotos)} votos em ${num(A.votacao2022.municipiosComVoto)} municípios · concentração ${(A.votacao2022.concentracao * 100).toFixed(1)}%`
            : "sem votação de 2022 registrada para este nome de urna")}</p><div id="chDepVotos" class="gr"></div></section>
        <section class="cartao cartao-corpo"><h2>Composição do gabinete</h2>
          <p class="sub">${esc(`${A.gabinete.total} pessoas · ${num(A.gabinete.admitidosNaLegislatura)} admitidas nesta legislatura`)}</p>
          <div id="chDepGab" class="gr"></div></section>
        <section class="cartao cartao-corpo"><h2>Destino por região</h2>
          <p class="sub">deputado estadual é eleito no estado inteiro — isto é destino do recurso, não distrito</p>
          <div id="chDepReg" class="gr"></div></section>
      </div>`}`;

    return {
      html,
      pintar() {
        Graficos.colunas("chDepAno", gAno);
        if (B) return;
        Graficos.barras("chDepMun", (A.emendas?.topMunicipios || []).slice(0, 10).map((m) => ({ nome: m.nome, valor: m.v })), cor("--pe-blue"), curto);
        Graficos.barras("chDepVotos", (A.votacao2022?.porRegiao || []).slice(0, 10).map((r) => ({ nome: r.regiao, valor: r.votos })), cor("--pe-red"), num);
        Graficos.donut("chDepGab", (A.gabinete.cargos || []).map((c) => ({ nome: c.cargo, valor: c.n })));
        Graficos.barras("chDepReg", (A.emendas?.porRegiao || []).slice(0, 10).map((r) => ({ nome: r.regiao, valor: r.v })), cor("--pe-amber"), curto);
      },
    };
  };

  /* ================================================================= busca */

  function resultadosBusca(termo) {
    const t = termo.trim().toLowerCase();
    if (t.length < 2) return [];
    const saida = [];
    const add = (tipo, rotulo, id) => saida.push({ id: `${tipo}::${id}`, tipo, rotulo });

    for (const it of Dados.get("indice")?.itens || []) if (it.nome.toLowerCase().includes(t)) add("dep", `${it.nome} · ${it.partido}`, it.slug);
    for (const m of Object.keys(Dados.get("regioes")?.municipios || {})) if (m.toLowerCase().includes(t)) add("mun", cap(m), m);
    for (const c of Dados.get("cand")?.marcadores || []) if (c.autor.toLowerCase().includes(t)) add("autor", `${cap(c.autor)} · ${c.partido}`, c.autor);
    return saida.slice(0, 8);
  }

  const NOME_TIPO = { dep: "deputado", mun: "município", autor: "parlamentar" };

  async function aplicarBusca(tipo, valor) {
    $("#busca").value = "";
    $("#buscaLista").hidden = true;
    if (tipo === "dep") {
      Estado.aba = "deputados";
      Estado.depA = valor;
    } else if (tipo === "mun") {
      Estado.aba = "emendas";
      Estado.esfera = "estadual";
      Estado.f = { ...Estado.f, mun: valor, autor: "" };
    } else {
      Estado.aba = "emendas";
      Estado.f = { ...Estado.f, autor: valor, mun: "" };
    }
    Estado.limite = POR_PAGINA;
    await render();
  }

  /* ================================================================ render */

  function alternarFiltro(campo, valor) {
    Estado.f[campo] = Estado.f[campo] === valor ? "" : valor;
    Estado.limite = POR_PAGINA;
    render();
  }

  let renderizando = false;

  async function render() {
    if (renderizando) return;
    renderizando = true;
    try {
      const s = Estado;
      const precisa = DEPENDENCIAS[s.aba](s.esfera);
      const faltam = precisa.filter((n) => !Dados.get(n));
      if (faltam.length) {
        s.carregando = true;
        desenharCasca();
        await Dados.carregar(precisa);
        s.carregando = false;
      }

      Graficos.descartar();
      desenharCasca();

      const vista = Abas[s.aba]();
      $("#conteudo").innerHTML = vista.html;
      s.escreverHash();

      // Os gráficos só medem certo depois do layout — daí o rAF.
      requestAnimationFrame(() => vista.pintar());
    } finally {
      renderizando = false;
    }
  }

  function desenharCasca() {
    const s = Estado;
    const [titulo, subtitulo] = TITULOS[s.aba];
    $("#titulo").textContent = titulo;
    $("#subtitulo").textContent = subtitulo;
    $("#carregando").hidden = !s.carregando;
    for (const b of document.querySelectorAll(".aba")) b.setAttribute("aria-selected", String(b.dataset.tab === s.aba));

    const gerado = Dados.get("estadual")?.geradoEm || Dados.get("deps")?.geradoEm || Dados.get("pessoal")?.geradoEm;
    $("#rodapeAtualizacao").textContent = gerado
      ? `Dados coletados em ${data(gerado)}. Cada aba carrega a base oficial mais recente publicada pelos órgãos.`
      : "Carregando metadados da coleta.";
  }

  /* ================================================================ eventos */

  function ligarEventos() {
    // Abas
    $("#abas").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-tab]");
      if (!b) return;
      Estado.aba = b.dataset.tab;
      Estado.gabAberto = null;
      render();
    });

    // Tema
    $("#btnTema").addEventListener("click", () => {
      const novo = PE.temaAtual() === "dark" ? "light" : "dark";
      PE.aplicarTema(novo);
      $("#btnTema").lastChild.textContent = novo === "dark" ? "Tema claro" : "Tema escuro";
      render();
    });

    // Busca global
    const campoBusca = $("#busca");
    campoBusca.addEventListener("input", () => {
      const itens = resultadosBusca(campoBusca.value);
      const lista = $("#buscaLista");
      lista.innerHTML = itens
        .map((r) => `<button type="button" class="busca-item" data-busca="${esc(r.id)}">
            <span class="busca-rotulo">${esc(r.rotulo)}</span><span class="busca-tipo">${esc(NOME_TIPO[r.tipo])}</span></button>`)
        .join("");
      lista.hidden = itens.length === 0;
    });
    campoBusca.addEventListener("blur", () => setTimeout(() => ($("#buscaLista").hidden = true), 150));
    $("#buscaLista").addEventListener("mousedown", (ev) => {
      const b = ev.target.closest("[data-busca]");
      if (!b) return;
      ev.preventDefault();
      const [tipo, valor] = b.dataset.busca.split("::");
      aplicarBusca(tipo, valor);
    });

    // Conteúdo: um só ouvinte por tipo de evento, delegando pelo data-attr.
    const conteudo = $("#conteudo");

    conteudo.addEventListener("click", (ev) => {
      const alvo = (sel) => ev.target.closest(sel);
      const chipEsfera = alvo("[data-esfera]");
      if (chipEsfera) {
        Estado.esfera = chipEsfera.dataset.esfera;
        Estado.f = { autor: "", mun: "", ex: "", conf: "", regiao: "", partido: "" };
        Estado.limite = POR_PAGINA;
        return render();
      }
      const chipVista = alvo("[data-vista]");
      if (chipVista) {
        Estado.vista = chipVista.dataset.vista;
        return render();
      }
      const th = alvo("th[data-col]");
      if (th && th.dataset.col) {
        const acao = th.closest("tr").dataset.acao;
        const alvoOrdem = acao === "ordenarTerr" ? "ordemTerr" : acao === "ordenarGab" ? "ordemGab" : "ordem";
        const k = th.dataset.col;
        Estado[alvoOrdem] = { k, dir: Estado[alvoOrdem].k === k ? -Estado[alvoOrdem].dir : -1 };
        return render();
      }
      const linhaGab = alvo("[data-gab]");
      if (linhaGab) {
        Estado.gabAberto = Estado.gabAberto === linhaGab.dataset.gab ? null : linhaGab.dataset.gab;
        return render();
      }
      const botao = alvo("[data-acao]");
      if (!botao || botao.tagName !== "BUTTON") return;
      if (botao.dataset.acao === "limpar") {
        Estado.f = { autor: "", mun: "", ex: "", conf: "", regiao: "", partido: "" };
        return render();
      }
      if (botao.dataset.acao === "gLimpar") {
        Estado.gf = { dep: "", partido: "", pessoa: "" };
        Estado.gabAberto = null;
        return render();
      }
      if (botao.dataset.acao === "mais") {
        Estado.limite += POR_PAGINA;
        return render();
      }
      if (botao.dataset.acao === "comparar") {
        Estado.comparando = !Estado.comparando;
        if (Estado.comparando && !Estado.depB) Estado.depB = segundoSlug(Estado.depA);
        return render();
      }
    });

    // Filtros de texto: renderiza sem perder o foco nem o cursor.
    conteudo.addEventListener("input", (ev) => {
      const campo = ev.target;
      const chaveF = campo.dataset.f;
      const chaveG = campo.dataset.gf;
      if (!chaveF && !chaveG) return;
      if (chaveF) {
        Estado.f[chaveF] = campo.value;
        Estado.limite = POR_PAGINA;
      } else {
        Estado.gf[chaveG] = campo.value;
      }
      const marca = chaveF ? `[data-f="${chaveF}"]` : `[data-gf="${chaveG}"]`;
      const pos = campo.selectionStart;
      render().then(() => {
        const novo = $(marca, conteudo);
        if (!novo) return;
        novo.focus();
        if (novo.type === "text" && pos != null) novo.setSelectionRange(pos, pos);
      });
    });

    conteudo.addEventListener("change", (ev) => {
      const sel = ev.target;
      if (sel.dataset.dep === "A") {
        Estado.depA = sel.value;
        if (Estado.depB === sel.value) Estado.depB = segundoSlug(sel.value);
        return render();
      }
      if (sel.dataset.dep === "B") {
        Estado.depB = sel.value === Estado.depA ? segundoSlug(sel.value) : sel.value;
        return render();
      }
    });

    addEventListener("resize", () => Graficos.redimensionar());
    addEventListener("hashchange", () => {
      Estado.lerHash();
      render();
    });
    PE.aoTrocarTema(() => render());
  }

  /* =================================================================== boot */

  function iniciar() {
    const salvo = PE.temaSalvo();
    if (salvo) document.documentElement.setAttribute("data-theme", salvo);
    $("#btnTema").lastChild.textContent = PE.temaAtual() === "dark" ? "Tema claro" : "Tema escuro";

    Estado.lerHash();
    ligarEventos();
    render();
  }

  if (document.readyState === "loading") addEventListener("DOMContentLoaded", iniciar);
  else iniciar();
})();
