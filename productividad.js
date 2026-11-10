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

  /* ---------- Excel con formato (ExcelJS) ---------- */
  var C = {
    oscuro: 'FF0D6B7C', teal: 'FF138A9E', tealClaro: 'FFD8F1F5', tealMuyClaro: 'FFF2F9FB', blanco: 'FFFFFFFF',
    texto: 'FF1F2D3A', gris: 'FF6B7A88', linea: 'FFC9D9E0', azul: 'FF3D8FD6', rojo: 'FFE5484D', naranja: 'FFF08A24',
    morado: 'FF7B4FC9', verde: 'FF2FA84F', oro: 'FFFFD54F', plata: 'FFCFD8DC', bronce: 'FFE0A06A'
  };
  var ACT_COLOR = { 'Control larvario': 'FFD8F1F5', 'Vigilancia': 'FFEDE4FA', 'Cerco': 'FFFFE9D2', 'Recuperaci\u00f3n': 'FFDDF3E3' };
  function poner(r, arr) { for (var i = 0; i < arr.length; i++) r.getCell(i + 1).value = arr[i]; }
  function relleno(argb) { return { type: 'pattern', pattern: 'solid', fgColor: { argb: argb } }; }
  function borde(argb) { var b = { style: 'thin', color: { argb: argb || C.linea } }; return { top: b, left: b, bottom: b, right: b }; }
  function nivelIA(v) { return v >= 2 ? { f: 'FFFDE2E3', c: 'FFC62828' } : v >= 1 ? { f: 'FFFFF4CC', c: 'FF9A6B00' } : { f: 'FFE3F5E8', c: 'FF1E7B3A' }; }

  function encabezado(ws, ncol, titulo, subtitulo) {
    ws.mergeCells(1, 1, 1, ncol); ws.mergeCells(2, 1, 2, ncol);
    var t = ws.getCell(1, 1); t.value = titulo;
    t.font = { bold: true, size: 18, color: { argb: C.blanco } }; t.fill = relleno(C.oscuro);
    t.alignment = { vertical: 'middle', horizontal: 'center' }; ws.getRow(1).height = 36;
    var s = ws.getCell(2, 1); s.value = subtitulo;
    s.font = { italic: true, size: 11, color: { argb: C.blanco } }; s.fill = relleno(C.teal);
    s.alignment = { vertical: 'middle', horizontal: 'center' }; ws.getRow(2).height = 22;
  }
  function cabeceraTabla(ws, fila, cab) {
    var r = ws.getRow(fila); poner(r, cab); r.height = 34;
    r.eachCell(function (c) {
      c.font = { bold: true, color: { argb: C.blanco }, size: 11 }; c.fill = relleno(C.oscuro);
      c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; c.border = borde('FF0A5664');
    });
  }

  async function descargarExcel() {
    var u = window.__ultimo; if (!u) return;
    if (typeof ExcelJS === 'undefined') { alert('No se pudo cargar la librer\u00eda de Excel. Revisa tu conexi\u00f3n a internet.'); return; }
    var btn = $('btnExcel'), txt = btn.textContent; btn.disabled = true; btn.textContent = '\u23f3 Generando Excel\u2026';
    try {
      var q = u.q, T = u.tot;
      var wb = new ExcelJS.Workbook(); wb.creator = 'Dashboard Dengue'; wb.created = new Date();

      /* ===== Hoja 1: Por inspector ===== */
      var ws = wb.addWorksheet('Por inspector', { properties: { tabColor: { argb: C.teal } }, views: [{ showGridLines: false }] });
      var NC = 12;
      ws.columns = [{ width: 7 }, { width: 40 }, { width: 12 }, { width: 10 }, { width: 14 }, { width: 14 }, { width: 11 }, { width: 11 }, { width: 13 }, { width: 11 }, { width: 13 }, { width: 13 }];
      encabezado(ws, NC, 'REPORTE DE PRODUCTIVIDAD POR INSPECTOR', 'Vigilancia y control vectorial del dengue \u2014 viviendas atendidas por inspector');

      // Filtros aplicados (2 columnas de pares)
      var filtros = [
        ['Tipo de actividad', q.act || 'Todas'], ['Mes', q.mes ? mesTxt(q.mes) : 'Todos'],
        ['Fecha de inspecci\u00f3n desde', q.desde ? q.desde.split('-').reverse().join('/') : 'Sin l\u00edmite'], ['Fecha de inspecci\u00f3n hasta', q.hasta ? q.hasta.split('-').reverse().join('/') : 'Sin l\u00edmite'],
        ['Localidad', q.loc || 'Todas'], ['Inspector', q.insp || 'Todos']
      ];
      var fr = 4;
      ws.getCell(fr - 1, 1).value = '\ud83d\udd0e Filtros aplicados';
      ws.getCell(fr - 1, 1).font = { bold: true, size: 12, color: { argb: C.oscuro } };
      filtros.forEach(function (p, i) {
        var row = fr + Math.floor(i / 2), col = i % 2 === 0 ? 1 : 7;
        var lw = col === 1 ? 1 : 2;
        ws.mergeCells(row, col, row, col + lw); ws.mergeCells(row, col + lw + 1, row, col + 5);
        var a = ws.getCell(row, col), b = ws.getCell(row, col + lw + 1);
        a.value = p[0]; a.font = { bold: true, color: { argb: C.oscuro } }; a.fill = relleno(C.tealClaro); a.border = borde();
        b.value = p[1]; b.font = { color: { argb: C.texto } }; b.fill = relleno(C.blanco); b.border = borde();
        for (var k = col; k <= col + 5; k++) ws.getCell(row, k).border = borde();
      });
      var gen = ws.getCell(7, 1); gen.value = 'Generado: ' + new Date().toLocaleString('es-PE');
      gen.font = { italic: true, size: 9, color: { argb: C.gris } };

      // Tarjetas de resumen
      var kp = [
        ['Inspectores', u.insp.length, '#,##0', C.oscuro],
        ['Viviendas atendidas', T.viviendas, '#,##0', C.teal],
        ['Inspeccionadas', T.inspeccionadas, '#,##0', C.azul],
        ['Cerradas', T.cerradas, '#,##0', C.rojo],
        ['Positivas', T.positivas, '#,##0', C.naranja],
        ['Prom. viv./d\u00eda', u.diasInsp ? T.viviendas / u.diasInsp : 0, '0.0', C.verde]
      ];
      kp.forEach(function (k, i) {
        var c1 = 1 + i * 2, c2 = c1 + 1;
        ws.mergeCells(9, c1, 9, c2); ws.mergeCells(10, c1, 10, c2);
        var l = ws.getCell(9, c1), v = ws.getCell(10, c1);
        l.value = k[0]; l.font = { bold: true, size: 10, color: { argb: C.blanco } }; l.fill = relleno(k[3]);
        l.alignment = { horizontal: 'center', vertical: 'middle' };
        v.value = k[1]; v.numFmt = k[2]; v.font = { bold: true, size: 18, color: { argb: k[3] } }; v.fill = relleno(C.blanco);
        v.alignment = { horizontal: 'center', vertical: 'middle' };
        [9, 10].forEach(function (r) { [c1, c2].forEach(function (c) { ws.getCell(r, c).border = borde(k[3]); }); });
      });
      ws.getRow(9).height = 20; ws.getRow(10).height = 32;
      var ia = T.inspeccionadas ? T.positivas / T.inspeccionadas * 100 : 0, niv = nivelIA(ia);
      ws.mergeCells(11, 1, 11, NC);
      var iaC = ws.getCell(11, 1);
      iaC.value = '\u00cdndice a\u00e9dico del periodo: ' + nf1.format(ia) + ' %  \u2014  Riesgo ' + (ia >= 2 ? 'ALTO' : ia >= 1 ? 'MEDIANO' : 'BAJO');
      iaC.font = { bold: true, color: { argb: niv.c } }; iaC.fill = relleno(niv.f); iaC.alignment = { horizontal: 'center', vertical: 'middle' };
      ws.getRow(11).height = 22;

      // Tabla
      var H = 13;
      var cab = ['N\u00b0', 'Inspector', 'D\u00edas trabajados', 'Fichas', 'Viviendas atendidas', 'Inspeccio-nadas', 'Cerradas', 'Renuentes', 'Deshabitadas', 'Positivas', '\u00cdndice a\u00e9dico (%)', 'Promedio viv./d\u00eda'];
      cab[5] = 'Inspeccionadas';
      cabeceraTabla(ws, H, cab);
      var orden = u.insp.slice().sort(function (a, b) { return b.viviendas - a.viviendas; });
      var medalla = [C.oro, C.plata, C.bronce];
      orden.forEach(function (t, i) {
        var r = ws.getRow(H + 1 + i);
        poner(r, [i + 1, t.inspector, t.dias, t.fichas, t.viviendas, t.inspeccionadas, t.cerradas, t.renuentes, t.deshabitadas, t.positivas, Math.round(t.ia * 10) / 10, Math.round(t.promedio * 10) / 10]);
        var fondo = i % 2 ? C.tealMuyClaro : C.blanco;
        r.eachCell({ includeEmpty: true }, function (c, n) {
          c.fill = relleno(fondo); c.border = borde(); c.font = { color: { argb: C.texto } };
          c.alignment = { vertical: 'middle', horizontal: n === 2 ? 'left' : 'center' };
          if (n >= 3 && n <= 10) c.numFmt = '#,##0';
        });
        if (i < 3) { r.getCell(1).fill = relleno(medalla[i]); r.getCell(1).font = { bold: true }; r.getCell(2).font = { bold: true, color: { argb: C.oscuro } }; }
        r.getCell(5).font = { bold: true, color: { argb: C.oscuro } };
        r.getCell(7).font = { color: { argb: 'FFC62828' } };
        r.getCell(10).font = { bold: t.positivas > 0, color: { argb: t.positivas > 0 ? 'FFE5484D' : C.gris } };
        var n2 = nivelIA(t.ia), ci = r.getCell(11);
        ci.numFmt = '0.0'; ci.fill = relleno(t.inspeccionadas ? n2.f : fondo); ci.font = { bold: true, color: { argb: t.inspeccionadas ? n2.c : C.gris } };
        r.getCell(12).numFmt = '0.0';
      });
      var last = H + orden.length;
      // Barras de datos y escala de color
      if (orden.length) {
        ws.addConditionalFormatting({ ref: 'E' + (H + 1) + ':E' + last, rules: [{ type: 'dataBar', priority: 1, cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF5AADE2' }, gradient: true }] });
        ws.addConditionalFormatting({ ref: 'L' + (H + 1) + ':L' + last, rules: [{ type: 'colorScale', priority: 2, cfvo: [{ type: 'min' }, { type: 'percentile', value: 50 }, { type: 'max' }], color: [{ argb: 'FFF8696B' }, { argb: 'FFFFEB84' }, { argb: 'FF63BE7B' }] }] });
      }
      // Total
      var tr = ws.getRow(last + 1);
      poner(tr, ['', 'TOTAL', T.fechas.size, T.fichas, T.viviendas, T.inspeccionadas, T.cerradas, T.renuentes, T.deshabitadas, T.positivas, Math.round(ia * 10) / 10, u.diasInsp ? Math.round(T.viviendas / u.diasInsp * 10) / 10 : 0]);
      tr.height = 24;
      tr.eachCell({ includeEmpty: true }, function (c, n) {
        c.fill = relleno(C.teal); c.font = { bold: true, size: 12, color: { argb: C.blanco } };
        c.alignment = { vertical: 'middle', horizontal: n === 2 ? 'left' : 'center' };
        c.border = { top: { style: 'medium', color: { argb: C.oscuro } }, bottom: { style: 'medium', color: { argb: C.oscuro } }, left: { style: 'thin', color: { argb: C.teal } }, right: { style: 'thin', color: { argb: C.teal } } };
        c.numFmt = n >= 11 ? '0.0' : '#,##0';
      });
      // Leyenda
      var lg = last + 3;
      ws.getCell(lg, 2).value = 'Leyenda del \u00edndice a\u00e9dico'; ws.getCell(lg, 2).font = { bold: true, color: { argb: C.oscuro } };
      [['Bajo (menos de 1 %)', nivelIA(0)], ['Mediano (1 % a menos de 2 %)', nivelIA(1)], ['Alto (2 % o m\u00e1s)', nivelIA(2)]].forEach(function (x, i) {
        var c = ws.getCell(lg + 1 + i, 2); c.value = x[0]; c.fill = relleno(x[1].f); c.font = { bold: true, color: { argb: x[1].c } }; c.border = borde();
      });
      var nota = ws.getCell(lg + 5, 2);
      nota.value = 'Cada vivienda registrada cuenta como atendida (incluidas las cerradas revisitadas). Fecha usada: fecha de inspecci\u00f3n. \u00cdndice a\u00e9dico = positivas \u00f7 inspeccionadas \u00d7 100.';
      nota.font = { italic: true, size: 9, color: { argb: C.gris } };

      ws.views = [{ state: 'frozen', ySplit: H, xSplit: 2, showGridLines: false }];
      ws.autoFilter = { from: { row: H, column: 1 }, to: { row: H, column: NC } };
      ws.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: H + ':' + H, margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };

      /* ===== Hoja 2: Detalle por dia ===== */
      var w2 = wb.addWorksheet('Detalle por d\u00eda', { properties: { tabColor: { argb: C.naranja } }, views: [{ showGridLines: false }] });
      w2.columns = [{ width: 40 }, { width: 13 }, { width: 16 }, { width: 18 }, { width: 26 }, { width: 9 }, { width: 13 }, { width: 14 }, { width: 10 }, { width: 11 }, { width: 13 }, { width: 10 }];
      encabezado(w2, 12, 'DETALLE DIARIO POR INSPECTOR', 'Una fila por inspector, fecha de inspecci\u00f3n, tipo de actividad y localidad');
      var H2 = 4;
      cabeceraTabla(w2, H2, ['Inspector', 'Fecha de inspecci\u00f3n', 'Mes', 'Tipo de actividad', 'Localidad', 'Fichas', 'Viviendas atendidas', 'Inspeccionadas', 'Cerradas', 'Renuentes', 'Deshabitadas', 'Positivas']);
      var det = u.lista.slice().sort(function (a, b) { return a.inspector.localeCompare(b.inspector, 'es') || a.fecha.localeCompare(b.fecha); });
      var prev = null, banda = false;
      det.forEach(function (g, i) {
        if (g.inspector !== prev) { banda = !banda; prev = g.inspector; }
        var p = g.fecha.split('-');
        var r = w2.getRow(H2 + 1 + i);
        poner(r, [g.inspector, (Date.UTC(+p[0], +p[1] - 1, +p[2]) - Date.UTC(1899, 11, 30)) / 86400000, mesTxt(g.mes), g.actividad, g.localidad, g.nFichas, g.viviendas, g.inspeccionadas, g.cerradas, g.renuentes, g.deshabitadas, g.positivas]);
        var fondo = banda ? C.blanco : C.tealMuyClaro;
        r.eachCell({ includeEmpty: true }, function (c, n) {
          c.fill = relleno(fondo); c.border = borde(); c.font = { color: { argb: C.texto } };
          c.alignment = { vertical: 'middle', horizontal: n === 1 || n === 5 ? 'left' : 'center' };
          if (n >= 6) c.numFmt = '#,##0';
        });
        r.getCell(2).numFmt = 'dd/mm/yyyy';
        r.getCell(4).fill = relleno(ACT_COLOR[g.actividad] || fondo); r.getCell(4).font = { bold: true, color: { argb: C.oscuro } };
        r.getCell(7).font = { bold: true, color: { argb: C.oscuro } };
        if (g.positivas > 0) r.getCell(12).font = { bold: true, color: { argb: 'FFE5484D' } };
      });
      var l2 = H2 + det.length;
      if (det.length) w2.addConditionalFormatting({ ref: 'G' + (H2 + 1) + ':G' + l2, rules: [{ type: 'dataBar', priority: 1, cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF5AADE2' }, gradient: true }] });
      w2.views = [{ state: 'frozen', ySplit: H2, xSplit: 1, showGridLines: false }];
      w2.autoFilter = { from: { row: H2, column: 1 }, to: { row: H2, column: 12 } };
      w2.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: H2 + ':' + H2, margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };

      var buf = await wb.xlsx.writeBuffer();
      var hoy = new Date(), p2 = function (n) { return String(n).padStart(2, '0'); };
      var nombre = 'Productividad_inspectores_' + hoy.getFullYear() + p2(hoy.getMonth() + 1) + p2(hoy.getDate()) + '.xlsx';
      var blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = nombre;
      document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      if (window.__test) window.__test(buf, nombre);
    } catch (e) { console.error(e); alert('No se pudo generar el Excel: ' + e.message); }
    finally { btn.disabled = false; btn.textContent = txt; }
  }

  /* ---------- Inicio ---------- */
  function iniciarControles() {
    llenarSelect($('fAct'), unicos('actividad'), 'Todas');
    llenarSelect($('fMes'), unicos('mes'), 'Todos', mesTxt);
    llenarSelect($('fLoc'), unicos('localidad'), 'Todas');
    llenarSelect($('fInsp'), unicos('inspector'), 'Todos');
    var fs = unicos('fecha');
    var d = new Date(), p2 = function (n) { return String(n).padStart(2, '0'); };
    var hoy = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    var fMax = fs[fs.length - 1] > hoy ? fs[fs.length - 1] : hoy;
    ['fDesde', 'fHasta'].forEach(function (id) { $(id).min = fs[0] < hoy ? fs[0] : hoy; $(id).max = fMax; $(id).value = hoy; });
    $('btnRestFechas').onclick = function () { $('fDesde').value = ''; $('fHasta').value = ''; render(); };
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
