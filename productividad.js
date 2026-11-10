/* Reporte de productividad por inspector - lee el mismo datos.csv(.gz) del dashboard */
(function () {
  'use strict';
  var ARCHIVOS = ['datos.csv.gz', 'datos.csv'];
  var MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Setiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  var NUM = ['viviendas', 'inspeccionadas', 'cerradas', 'renuentes', 'deshabitadas', 'positivas'];
  var COND = { '1': 'inspeccionadas', '2': 'cerradas', '3': 'renuentes', '4': 'deshabitadas' };
  var ACT = { 'recuperacio': 'Recuperaci\u00f3n', 'vigilancia': 'Vigilancia', 'cerco': 'Cerco', 'control larvario': 'Control larvario' };

  var GRUPOS = [];           // filas agregadas: inspector, fecha, mes, actividad, localidad, fichas(Set), sumas
  var estado = { orden: 'viviendas', asc: false, busca: '' };
  var chTop = null, chDia = null;
  var $ = function (id) { return document.getElementById(id); };
  var nf = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 0 });
  var nf1 = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  function avance(p, txt) { $('cargaBar').style.width = Math.round(p * 100) + '%'; if (txt) $('cargaTxt').textContent = txt; }

  /* ---------- Lectura en streaming (no carga 150 MB en memoria) ---------- */
  async function abrir() {
    for (var i = 0; i < ARCHIVOS.length; i++) {
      try {
        var r = await fetch(ARCHIVOS[i] + '?v=' + Date.now());
        if (r.ok) return r;
      } catch (e) { /* probar siguiente */ }
    }
    throw new Error('No se encontr\u00f3 datos.csv.gz ni datos.csv en la carpeta del dashboard.');
  }

  async function leerDatos() {
    var resp = await abrir();
    var total = Number(resp.headers.get('content-length')) || 0;
    var reader = resp.body.getReader();
    var first = await reader.read();
    var leidos = first.value ? first.value.length : 0;
    var esGz = first.value && first.value[0] === 0x1f && first.value[1] === 0x8b;
    var crudo = new ReadableStream({
      start: function (c) { if (first.value) c.enqueue(first.value); if (first.done) c.close(); },
      pull: async function (c) {
        var x = await reader.read();
        if (x.done) { c.close(); return; }
        leidos += x.value.length; if (total) avance(Math.min(0.98, leidos / total));
        c.enqueue(x.value);
      }
    });
    var flujo = esGz ? crudo.pipeThrough(new DecompressionStream('gzip')) : crudo;
    var tr = flujo.pipeThrough(new TextDecoderStream('utf-8')).getReader();

    var mapa = new Map(), idx = null, resto = '', filas = 0;
    function procesar(bloque) {
      var res = Papa.parse(bloque, { header: false, skipEmptyLines: true });
      var d = res.data, k = 0;
      if (!idx) {
        var h = d[0].map(function (s) { return String(s).replace(/^\ufeff/, '').trim(); });
        idx = {};
        ['_id_x', 'fecha_inspeccion', 'nombre_inspector', 'tipoActividadInspeccion', 'localidad_eess', 'atencion_vivienda_indicador', 'viv_positiva']
          .forEach(function (c) { idx[c] = h.indexOf(c); });
        if (idx.fecha_inspeccion < 0 || idx.nombre_inspector < 0) throw new Error('El CSV no tiene las columnas fecha_inspeccion / nombre_inspector.');
        k = 1;
      }
      for (; k < d.length; k++) {
        var f = d[k];
        var fecha = String(f[idx.fecha_inspeccion] || '').slice(0, 10);
        if (fecha.length < 10) continue;
        var insp = String(f[idx.nombre_inspector] || 'SIN INSPECTOR').trim().toUpperCase() || 'SIN INSPECTOR';
        var a0 = String(f[idx.tipoActividadInspeccion] || '').trim();
        var act = ACT[a0.toLowerCase()] || a0 || 'Sin actividad';
        var loc = String(f[idx.localidad_eess] || '').trim() || 'SIN LOCALIDAD';
        var key = insp + '|' + fecha + '|' + act + '|' + loc;
        var g = mapa.get(key);
        if (!g) { g = { inspector: insp, fecha: fecha, mes: fecha.slice(0, 7), actividad: act, localidad: loc, fichas: new Set(), viviendas: 0, inspeccionadas: 0, cerradas: 0, renuentes: 0, deshabitadas: 0, positivas: 0 }; mapa.set(key, g); }
        g.viviendas++;
        var c = COND[String(f[idx.atencion_vivienda_indicador]).trim()]; if (c) g[c]++;
        if (String(f[idx.viv_positiva]).trim() === '1') g.positivas++;
        if (idx._id_x >= 0) g.fichas.add(f[idx._id_x]);
        filas++;
      }
    }
    while (true) {
      var x = await tr.read();
      if (x.done) break;
      var buf = resto + x.value;
      // cortar en el ultimo salto de linea que no este dentro de comillas
      var dentro = false, corte = -1;
      for (var i = 0; i < buf.length; i++) {
        var ch = buf.charCodeAt(i);
        if (ch === 34) dentro = !dentro; else if (ch === 10 && !dentro) corte = i;
      }
      if (corte < 0) { resto = buf; continue; }
      procesar(buf.slice(0, corte));
      resto = buf.slice(corte + 1);
    }
    if (resto.trim()) procesar(resto);
    GRUPOS = Array.from(mapa.values()).map(function (g) { g.nFichas = g.fichas.size; return g; });
    return filas;
  }

  /* ---------- Filtros ---------- */
  function llenarSelect(sel, valores, todos, etiq) {
    sel.innerHTML = '';
    sel.appendChild(new Option(todos, ''));
    valores.forEach(function (v) { sel.appendChild(new Option(etiq ? etiq(v) : v, v)); });
  }
  function unicos(campo) { return Array.from(new Set(GRUPOS.map(function (g) { return g[campo]; }))).sort(function (a, b) { return a.localeCompare(b, 'es'); }); }
  function mesTxt(m) { var p = m.split('-'); return MESES[Number(p[1]) - 1] + ' ' + p[0]; }

  function filtros() {
    return { act: $('fAct').value, mes: $('fMes').value, desde: $('fDesde').value, hasta: $('fHasta').value, loc: $('fLoc').value, insp: $('fInsp').value };
  }
  function filtrar(q, sinInsp) {
    return GRUPOS.filter(function (g) {
      return (!q.act || g.actividad === q.act) && (!q.mes || g.mes === q.mes) &&
        (!q.desde || g.fecha >= q.desde) && (!q.hasta || g.fecha <= q.hasta) &&
        (!q.loc || g.localidad === q.loc) && (sinInsp || !q.insp || g.inspector === q.insp);
    });
  }
  function porInspector(lista) {
    var m = new Map();
    lista.forEach(function (g) {
      var t = m.get(g.inspector);
      if (!t) { t = { inspector: g.inspector, fechas: new Set(), fichas: 0 }; NUM.forEach(function (k) { t[k] = 0; }); m.set(g.inspector, t); }
      NUM.forEach(function (k) { t[k] += g[k]; }); t.fichas += g.nFichas; t.fechas.add(g.fecha);
    });
    return Array.from(m.values()).map(function (t) {
      t.dias = t.fechas.size; t.promedio = t.dias ? t.viviendas / t.dias : 0;
      t.ia = t.inspeccionadas ? t.positivas / t.inspeccionadas * 100 : 0; return t;
    });
  }

  /* ---------- Render ---------- */
  function pct(a, b) { return b ? nf1.format(a / b * 100) + ' %' : '\u2014'; }
  function render() {
    var q = filtros();
    var lista = filtrar(q, false);
    var insp = porInspector(lista);
    var tot = { fichas: 0, fechas: new Set() }; NUM.forEach(function (k) { tot[k] = 0; });
    lista.forEach(function (g) { NUM.forEach(function (k) { tot[k] += g[k]; }); tot.fichas += g.nFichas; tot.fechas.add(g.fecha); });
    var diasInsp = insp.reduce(function (s, t) { return s + t.dias; }, 0);

    $('kInsp').textContent = nf.format(insp.length);
    $('kViv').textContent = nf.format(tot.viviendas);
    $('kFichas').textContent = nf.format(tot.fichas);
    $('kIns').textContent = nf.format(tot.inspeccionadas);
    $('kInsPct').textContent = pct(tot.inspeccionadas, tot.viviendas);
    $('kCer').textContent = nf.format(tot.cerradas);
    $('kRen').textContent = nf.format(tot.renuentes);
    $('kDes').textContent = nf.format(tot.deshabitadas);
    $('kPos').textContent = nf.format(tot.positivas);
    $('kIA').textContent = pct(tot.positivas, tot.inspeccionadas);
    $('kProm').textContent = diasInsp ? nf1.format(tot.viviendas / diasInsp) : '\u2014';

    graficoTop(porInspector(filtrar(q, true)), q.insp);
    graficoDia(lista, q.insp);
    tabla(insp, tot, diasInsp, q.insp);
    window.__ultimo = { q: q, insp: insp, tot: tot, diasInsp: diasInsp, lista: lista };
  }

  function graficoTop(insp, sel) {
    var d = insp.sort(function (a, b) { return b.viviendas - a.viviendas; }).slice(0, 15);
    var cfg = {
      type: 'bar',
      data: {
        labels: d.map(function (t) { return t.inspector; }),
        datasets: [
          { label: 'Viviendas atendidas', data: d.map(function (t) { return t.viviendas; }), backgroundColor: d.map(function (t) { return !sel || sel === t.inspector ? '#138a9e' : 'rgba(19,138,158,.3)'; }) },
          { label: 'Inspeccionadas', data: d.map(function (t) { return t.inspeccionadas; }), backgroundColor: '#5aade2' },
          { label: 'Positivas', data: d.map(function (t) { return t.positivas; }), backgroundColor: '#e5484d' }
        ]
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top' }, tooltip: { callbacks: { label: function (c) { return c.dataset.label + ': ' + nf.format(c.raw); } } } },
        scales: { x: { ticks: { callback: function (v) { return nf.format(v); } } }, y: { ticks: { font: { size: 11 }, callback: function (v) { var s = this.getLabelForValue(v); return s.length > 26 ? s.slice(0, 25) + '\u2026' : s; } } } },
        onClick: function (e, el) { if (el.length) { var n = d[el[0].index].inspector; $('fInsp').value = $('fInsp').value === n ? '' : n; render(); } }
      }
    };
    if (chTop) chTop.destroy();
    chTop = new Chart($('chTop'), cfg);
  }

  function graficoDia(lista, sel) {
    var m = new Map();
    lista.forEach(function (g) {
      var t = m.get(g.fecha) || { viv: 0, ins: 0, pos: 0, insp: new Set() };
      t.viv += g.viviendas; t.ins += g.inspeccionadas; t.pos += g.positivas; t.insp.add(g.inspector); m.set(g.fecha, t);
    });
    var f = Array.from(m.keys()).sort();
    $('tDiaria').textContent = '\ud83d\udcca Producci\u00f3n diaria' + (sel ? ' \u2014 ' + sel : '');
    var cfg = {
      type: 'bar',
      data: {
        labels: f.map(function (x) { return x.slice(8, 10) + '/' + x.slice(5, 7) + '/' + x.slice(0, 4); }),
        datasets: [
          { label: 'Viviendas atendidas', data: f.map(function (x) { return m.get(x).viv; }), backgroundColor: '#138a9e' },
          { label: 'Inspeccionadas', data: f.map(function (x) { return m.get(x).ins; }), backgroundColor: '#5aade2' }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: {
          label: function (c) { return c.dataset.label + ': ' + nf.format(c.raw); },
          afterBody: function (it) { var x = f[it[0].dataIndex]; return 'Inspectores: ' + m.get(x).insp.size + '   Positivas: ' + nf.format(m.get(x).pos); }
        } } },
        scales: { x: { grouped: false, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } }, y: { beginAtZero: true, ticks: { callback: function (v) { return nf.format(v); } } } },
        datasets: { bar: { grouped: false } }
      }
    };
    if (chDia) chDia.destroy();
    chDia = new Chart($('chDia'), cfg);
  }

  function tabla(insp, tot, diasInsp, sel) {
    var k = estado.orden, s = estado.asc ? 1 : -1;
    insp.sort(function (a, b) { return k === 'inspector' ? s * a.inspector.localeCompare(b.inspector, 'es') : s * (a[k] - b[k]) || b.viviendas - a.viviendas; });
    var b = estado.busca;
    var ver = b ? insp.filter(function (t) { return t.inspector.indexOf(b) >= 0; }) : insp;
    var tb = $('tbody'); tb.innerHTML = '';
    ver.forEach(function (t, i) {
      var tr = document.createElement('tr'); if (sel === t.inspector) tr.className = 'sel';
      var v = [i + 1, t.inspector, nf.format(t.dias), nf.format(t.fichas), nf.format(t.viviendas), nf.format(t.inspeccionadas), nf.format(t.cerradas), nf.format(t.renuentes), nf.format(t.deshabitadas), nf.format(t.positivas), t.inspeccionadas ? nf1.format(t.ia) + ' %' : '\u2014', nf1.format(t.promedio)];
      v.forEach(function (x, j) { var td = document.createElement('td'); td.textContent = x; if (j === 1) td.className = 'l'; if (j === 10 && t.ia >= 2) td.className = 'alto'; tr.appendChild(td); });
      tr.onclick = function () { $('fInsp').value = $('fInsp').value === t.inspector ? '' : t.inspector; render(); };
      tb.appendChild(tr);
    });
    if (!ver.length) tb.innerHTML = '<tr><td colspan="12" class="vacio">No hay registros con estos filtros.</td></tr>';
    $('nFilas').textContent = nf.format(ver.length);
    var tf = $('tfoot'); tf.innerHTML = '';
    if (insp.length) {
      var tr = document.createElement('tr');
      ['', 'TOTAL', nf.format(tot.fechas.size) + ' fechas', nf.format(tot.fichas), nf.format(tot.viviendas), nf.format(tot.inspeccionadas), nf.format(tot.cerradas), nf.format(tot.renuentes), nf.format(tot.deshabitadas), nf.format(tot.positivas), pct(tot.positivas, tot.inspeccionadas), diasInsp ? nf1.format(tot.viviendas / diasInsp) : '\u2014']
        .forEach(function (x, j) { var td = document.createElement('td'); td.textContent = x; if (j === 1) td.className = 'l'; tr.appendChild(td); });
      tf.appendChild(tr);
    }
    document.querySelectorAll('#tabla th').forEach(function (th) {
      var a = th.querySelector('.ar'); if (a) a.remove();
      if (th.dataset.k === estado.orden) { var sp = document.createElement('span'); sp.className = 'ar'; sp.textContent = estado.asc ? '\u25b2' : '\u25bc'; th.appendChild(sp); }
    });
  }

  /* ---------- Excel ---------- */
  function descargarExcel() {
    var u = window.__ultimo; if (!u) return;
    var q = u.q;
    var filtro = [
      ['REPORTE DE PRODUCTIVIDAD POR INSPECTOR'],
      ['Tipo de actividad', q.act || 'Todas'], ['Mes', q.mes ? mesTxt(q.mes) : 'Todos'],
      ['Fecha de inspecci\u00f3n desde', q.desde || '\u2014'], ['Fecha de inspecci\u00f3n hasta', q.hasta || '\u2014'],
      ['Localidad', q.loc || 'Todas'], ['Inspector', q.insp || 'Todos'], ['Generado', new Date().toLocaleString('es-PE')], []
    ];
    var cab = ['N\u00b0', 'Inspector', 'D\u00edas trabajados', 'Fichas', 'Viviendas atendidas', 'Inspeccionadas', 'Cerradas', 'Renuentes', 'Deshabitadas', 'Positivas', '\u00cdndice a\u00e9dico (%)', 'Promedio viv./d\u00eda'];
    var orden = u.insp.slice().sort(function (a, b) { return b.viviendas - a.viviendas; });
    var filas = orden.map(function (t, i) { return [i + 1, t.inspector, t.dias, t.fichas, t.viviendas, t.inspeccionadas, t.cerradas, t.renuentes, t.deshabitadas, t.positivas, Math.round(t.ia * 10) / 10, Math.round(t.promedio * 10) / 10]; });
    var T = u.tot;
    filas.push(['', 'TOTAL', T.fechas.size, T.fichas, T.viviendas, T.inspeccionadas, T.cerradas, T.renuentes, T.deshabitadas, T.positivas, T.inspeccionadas ? Math.round(T.positivas / T.inspeccionadas * 1000) / 10 : '', u.diasInsp ? Math.round(T.viviendas / u.diasInsp * 10) / 10 : '']);
    var ws1 = XLSX.utils.aoa_to_sheet(filtro.concat([cab], filas));
    ws1['!cols'] = [{ wch: 5 }, { wch: 38 }].concat(cab.slice(2).map(function () { return { wch: 14 }; }));

    var det = u.lista.slice().sort(function (a, b) { return a.inspector.localeCompare(b.inspector, 'es') || a.fecha.localeCompare(b.fecha); })
      .map(function (g) { return [g.inspector, g.fecha.slice(8, 10) + '/' + g.fecha.slice(5, 7) + '/' + g.fecha.slice(0, 4), mesTxt(g.mes), g.actividad, g.localidad, g.nFichas, g.viviendas, g.inspeccionadas, g.cerradas, g.renuentes, g.deshabitadas, g.positivas]; });
    var ws2 = XLSX.utils.aoa_to_sheet([['Inspector', 'Fecha de inspecci\u00f3n', 'Mes', 'Tipo de actividad', 'Localidad', 'Fichas', 'Viviendas atendidas', 'Inspeccionadas', 'Cerradas', 'Renuentes', 'Deshabitadas', 'Positivas']].concat(det));
    ws2['!cols'] = [{ wch: 38 }, { wch: 12 }, { wch: 16 }, { wch: 18 }, { wch: 26 }].concat(new Array(7).fill({ wch: 12 }));

    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, 'Por inspector');
    XLSX.utils.book_append_sheet(wb, ws2, 'Detalle por dia');
    var hoy = new Date(); var p2 = function (n) { return String(n).padStart(2, '0'); };
    XLSX.writeFile(wb, 'Productividad_inspectores_' + hoy.getFullYear() + p2(hoy.getMonth() + 1) + p2(hoy.getDate()) + '.xlsx');
  }

  /* ---------- Inicio ---------- */
  function iniciarControles() {
    llenarSelect($('fAct'), unicos('actividad'), 'Todas');
    llenarSelect($('fMes'), unicos('mes'), 'Todos', mesTxt);
    llenarSelect($('fLoc'), unicos('localidad'), 'Todas');
    llenarSelect($('fInsp'), unicos('inspector'), 'Todos');
    var fs = unicos('fecha');
    ['fDesde', 'fHasta'].forEach(function (id) { $(id).min = fs[0]; $(id).max = fs[fs.length - 1]; });
    ['fAct', 'fMes', 'fLoc', 'fInsp'].forEach(function (id) { $(id).addEventListener('change', render); });
    ['fDesde', 'fHasta'].forEach(function (id) { $(id).addEventListener('change', function () { if (!this.value || this.validity.valid) render(); }); });
    $('btnLimpiar').onclick = function () { ['fAct', 'fMes', 'fDesde', 'fHasta', 'fLoc', 'fInsp', 'buscar'].forEach(function (id) { $(id).value = ''; }); estado.busca = ''; render(); };
    $('buscar').addEventListener('input', function () { estado.busca = this.value.trim().toUpperCase(); render(); });
    $('btnExcel').onclick = descargarExcel;
    document.querySelectorAll('#tabla th').forEach(function (th) {
      th.addEventListener('click', function () {
        var k = th.dataset.k; if (k === 'n') k = 'viviendas';
        if (estado.orden === k) estado.asc = !estado.asc; else { estado.orden = k; estado.asc = k === 'inspector'; }
        render();
      });
    });
    $('nota').textContent += ' Datos del ' + fs[0].split('-').reverse().join('/') + ' al ' + fs[fs.length - 1].split('-').reverse().join('/') + '.';
  }

  leerDatos().then(function (n) {
    avance(1, nf.format(n) + ' viviendas le\u00eddas');
    iniciarControles(); render();
    setTimeout(function () { $('carga').style.display = 'none'; }, 250);
  }).catch(function (e) {
    console.error(e);
    $('carga').classList.add('err');
    $('cargaTxt').textContent = 'No se pudieron cargar los datos: ' + e.message;
  });
})();
