// ============================================================
// DASHBOARD DE INSPECCIONES Y CONTROL DE DENGUE
// CONEXIÓN REAL: datos.csv
// RANGO DE FECHAS + ACTUALIZACIÓN AUTOMÁTICA
// ============================================================

let datosOriginales = [];
let datosFiltrados = [];
let recuperadasFiltradas = [];
let mapaDniInspector = null;
let charts = {};
let mapa = null;
let marcadores = [];
let capaMarcadores = null;
let busquedaInspector = "";

const ARCHIVO_CSV = "datos.csv.gz";
const ARCHIVO_CSV_RESPALDO = "datos.csv";
const SEGUNDOS_ACTUALIZACION = 60;

const MESES = [
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre",
    "Diciembre"
];

// Evita inicializar varias veces el dashboard.
let dashboardIniciado = false;
let temporizadorCSV = null;
let ultimaCargaCSV = 0;
let fechaArchivoCSV = null; // Last-Modified del datos.csv(.gz) publicado
let firmaArchivoCSV = null; // ETag/Last-Modified de la última base procesada
let esPrimeraCarga = true;

// ============================================================
// INICIO
// ============================================================

function iniciar() {
    if (dashboardIniciado) return;
    dashboardIniciado = true;

    fijarTextoFecha("Cargando...", "Datos reales y registrados");

    configurarBuscadorSugerencias();
    configurarBotones();
    cargarDatosCSV();

    // Actualización automática cada 60 segundos.
    if (temporizadorCSV) clearInterval(temporizadorCSV);

    temporizadorCSV = setInterval(() => {
        if (!document.hidden) {
            cargarDatosCSV(true);
        }
    }, SEGUNDOS_ACTUALIZACION * 1000);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
} else {
    iniciar();
}

// ============================================================
// CARGAR CSV
// ============================================================

// Descarga datos.csv.gz y lo descomprime en el navegador.
// Si no existe el .gz (o el navegador es antiguo), usa datos.csv como respaldo.
async function leerTextoCSV() {
    // "no-cache" = usar la copia guardada en el navegador, pero preguntando
    // antes a GitHub si cambió (ETag). Si no cambió, no se vuelve a descargar.
    if (typeof DecompressionStream !== "undefined") {
        const urlGz = new URL(ARCHIVO_CSV, window.location.href).href;
        const resp = await fetch(urlGz, { cache: "no-cache" });

        if (resp.ok) {
            guardarFechaArchivo(resp);
            const buffer = await resp.arrayBuffer();
            const bytes = new Uint8Array(buffer);

            // Si el archivo empieza con la firma gzip (1F 8B), se descomprime.
            if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
                const stream = new Blob([buffer]).stream()
                    .pipeThrough(new DecompressionStream("gzip"));
                return await new Response(stream).text();
            }

            // Si el servidor ya lo entregó descomprimido, se lee directo.
            return new TextDecoder("utf-8").decode(buffer);
        }
    }

    // Respaldo: CSV sin comprimir.
    const urlCsv = new URL(ARCHIVO_CSV_RESPALDO, window.location.href).href;
    const resp2 = await fetch(urlCsv, { cache: "no-cache" });
    if (!resp2.ok) throw new Error("No se encontró datos.csv.gz ni datos.csv");
    guardarFechaArchivo(resp2);
    return await resp2.text();
}

function firmaRespuesta(resp) {
    return resp.headers.get("etag") || resp.headers.get("last-modified") ||
        resp.headers.get("content-length") || null;
}

// Consulta liviana (solo encabezados) para saber si la base publicada cambió.
async function baseCambio() {
    if (!firmaArchivoCSV) return true;
    try {
        const url = new URL(ARCHIVO_CSV, window.location.href).href;
        const resp = await fetch(url, { method: "HEAD", cache: "no-cache" });
        if (!resp.ok) return true;
        const firma = firmaRespuesta(resp);
        return !firma || firma !== firmaArchivoCSV;
    } catch (e) {
        return false; // sin conexión: conservar lo que ya está en pantalla
    }
}

function guardarFechaArchivo(resp) {
    firmaArchivoCSV = firmaRespuesta(resp);
    const lm = resp.headers.get("last-modified");
    const f = lm ? new Date(lm) : null;
    fechaArchivoCSV = f && !Number.isNaN(f.getTime()) ? f : null;
}

async function cargarDatosCSV(esActualizacionAutomatica = false) {

    if (typeof Papa === "undefined") {
        console.error("No se encontró Papa Parse.");
        fijarTextoFecha("Error", "No se cargó la librería Papa Parse");
        return;
    }

    // Actualización automática: solo se reprocesa si se publicó una base nueva.
    if (esActualizacionAutomatica && !(await baseCambio())) return;

    let textoCSV;
    try {
        textoCSV = await leerTextoCSV();
    } catch (error) {
        console.error("Error cargando CSV:", error);
        if (!esActualizacionAutomatica) {
            fijarTextoFecha("Sin datos", "No se pudo cargar datos.csv.gz");
        }
        return;
    }

    Papa.parse(textoCSV, {
        header: true,
        skipEmptyLines: true,

        complete: function (resultado) {

            if (resultado.errors && resultado.errors.length) {
                console.warn("Advertencias del CSV:", resultado.errors);
            }

            const registros = (resultado.data || []).filter(
                fila => fila && Object.keys(fila).length > 1
            );

            if (registros.length === 0) {
                console.warn("El CSV no contiene registros.");
                if (!esActualizacionAutomatica) {
                    fijarTextoFecha("Sin datos", "El archivo CSV está vacío");
                }
                return;
            }

            datosOriginales = quitarDuplicados(registros);
            mapaDniInspector = null;
            cacheInspectorRec = new WeakMap();
            ultimaCargaCSV = Date.now();

            console.log("CSV cargado:", datosOriginales.length, "registros");
            console.log("Columnas:", Object.keys(datosOriginales[0]));

            // Actualiza los filtros conservando las selecciones existentes.
            inicializarFiltros(esPrimeraCarga);
            esPrimeraCarga = false;

            seguro("actualizarFecha", actualizarFecha);
            seguro("inicializarMapa", inicializarMapa);
            seguro("actualizarDashboard", actualizarDashboard);
        }
    });
}

// ============================================================
// QUITAR REGISTROS DUPLICADOS DEL CSV
// ============================================================
// La descarga de Dengue-Admin puede traer la misma vivienda en dos filas
// (ej. ANA KELY 02/10/2026, Mz 309-F Jr. Apurimac Mz E Lote 2), aunque el
// Formato 03 la muestre una sola vez. Aqui solo se quitan filas identicas
// en todas sus columnas; los re-registros se tratan en quitarReRegistros().
// Orden de columnas ya calculado, por cada conjunto de columnas distinto
// (normalmente uno solo para todo el CSV).
const cacheColumnasOrdenadas = new Map();

function claveRegistroUnico(f) {
    // Fila identica en todas sus columnas. Misma clave que la version
    // original (columnas ordenadas, "columna=valor" unidos con "|"),
    // pero sin ordenar las columnas de nuevo en cada fila.
    const columnas = Object.keys(f);
    const firma = columnas.join("\u0002");
    let ordenadas = cacheColumnasOrdenadas.get(firma);
    if (!ordenadas) {
        ordenadas = [...columnas].sort();
        cacheColumnasOrdenadas.set(firma, ordenadas);
    }
    let clave = "";
    for (let i = 0; i < ordenadas.length; i++) {
        if (i) clave += "|";
        clave += ordenadas[i] + "=" + texto(f[ordenadas[i]]);
    }
    return clave;
}

function quitarDuplicados(filas) {
    const mapa = new Map();
    const duplicados = [];

    filas.forEach(f => {
        const clave = claveRegistroUnico(f);
        const existente = mapa.get(clave);

        if (!existente) {
            mapa.set(clave, f);
            return;
        }

        duplicados.push(f);
        // Conservar la copia que tenga datos de recuperacion.
        if (numero(f.recuperada) === 1 && numero(existente.recuperada) !== 1) {
            mapa.set(clave, f);
        }
    });

    if (duplicados.length) {
        console.warn("Registros duplicados eliminados:", duplicados.length);
        console.table(duplicados.slice(0, 30).map(f => ({
            fecha: texto(f.fecha_creacion) || texto(f.fecha_inspeccion),
            inspector: texto(f.nombre_inspector),
            localidad: texto(f.localidad_eess),
            sector: texto(f.sector),
            manzana: texto(f.codigo_manzana),
            direccion: texto(f.direccion)
        })));
    }

    return quitarReRegistros([...mapa.values()]);
}

// Re-registros: el inspector registra una vivienda y luego la vuelve a
// registrar corregida (ej. ANA KELY 02/10: 309-F "JR APRURIMAC MZ E LOTE 2" ->
// "JR APURIMAC MZ E LOTE 2"; 296 "JR / LOTE LIBRE" -> "JR IQUITOS / LOTE LIBRE").
// Dengue-Admin muestra solo la ultima, pero su exportacion trae ambas.
// Es la misma vivienda si coinciden jornada + manzana + GPS exacto + condicion
// + tipo, Y ADEMAS la direccion es compatible:
//   - con numeros: los mismos numeros (369 vs 340 = casas distintas, aunque
//     el GPS sea igual: ERICKA 17/09 Nueve de Abril, Mz 17);
//   - sin numeros: las palabras de una estan todas contenidas en la otra.
// Se conserva la mas reciente. Validado contra Formato 03:
//   Morales 01-02/10 = 373 / 63 / 104 ; Nueve de Abril 17-19/09 = 358 / 75 / 124.

function numerosDireccion(valor) {
    return [...new Set(texto(valor).match(/\d+/g) || [])]
        .map(n => String(Number(n))).sort().join(",");
}

function palabrasDireccion(valor) {
    return new Set(
        texto(valor).toUpperCase()
            .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
            .split(/[^A-Z0-9]+/).filter(Boolean)
    );
}

// ------------------------------------------------------------
// Comparacion de direcciones con el MISMO numero (re-registros)
// ------------------------------------------------------------
// Mismo numero no basta para decir que es la misma casa. Ademas:
//  - la calle debe coincidir, admitiendo errores de tipeo
//    (APRURIMAC/APURIMAC, CAWIDE/CAHUIDE, SAN MARTIN786/SAN MARTIN 786);
//  - si ambas indican letra de interior/lote y no coinciden (A vs B),
//    son casas distintas.
// Caso real: PUNTA DEL ESTE 29/09, Mz 266, mismo GPS: JR PEDRO DE URZUA 345
// y JR CAHUIDE 345 son dos viviendas (Formato de encuesta: zona 6 = 36).
const PALABRAS_GENERICAS = new Set([
    "JR", "JIRON", "AV", "AVENIDA", "CALLE", "CA", "PSJ", "PSJE", "PJE", "PASAJE",
    "CARRETERA", "CARRT", "CARR", "PROLONGACION", "PROLOGACION", "PROLG", "PROL",
    "MZ", "MZA", "MANZANA", "LT", "LOT", "LOTE", "SN", "NRO", "NUM", "NO",
    "INTERIOR", "INT", "CDR", "CUADRA", "CASA", "SUM", "SUMINISTRO",
    "DE", "LA", "EL", "LOS", "LAS", "DEL", "Y"
]);

function tokensDireccion(valor) {
    return texto(valor).toUpperCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/([A-Z])(\d)/g, "$1 $2").replace(/(\d)([A-Z])/g, "$1 $2")
        .split(/[^A-Z0-9]+/).filter(Boolean);
}

function partesDireccion(valor) {
    const t = tokensDireccion(valor);
    const palabras = t.filter(w => /^[A-Z]{2,}$/.test(w) && !PALABRAS_GENERICAS.has(w));
    return {
        letras: new Set(t.filter(w => /^[A-Z]$/.test(w))),
        palabras,
        calle: palabras.join("")
    };
}

// Distancia de edicion (letras cambiadas, agregadas o quitadas).
function distanciaEdicion(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length];
}

function parecidas(x, y) {
    const tope = Math.max(1, Math.round(Math.max(x.length, y.length) * 0.25));
    return x === y || distanciaEdicion(x, y) <= tope;
}

function mismaCalleConNumero(a, b) {
    const pa = partesDireccion(a), pb = partesDireccion(b);

    if (pa.letras.size && pb.letras.size &&
        ![...pa.letras].some(l => pb.letras.has(l))) return false;

    const ca = pa.calle, cb = pb.calle;
    if (!ca || !cb || ca.includes(cb) || cb.includes(ca)) return true;

    if (parecidas(ca, cb)) return true;

    // Una direccion agrega palabras a la otra (JR BELEN #325 ->
    // JR BELEN TORRES #325; ... 656 DEPARTAMENTO 2 -> ... 656 SEGUNDO PISO
    // DEPARTAMENTO 2): cada palabra de la corta esta (o casi) en la larga.
    const [corta, larga] = pa.palabras.length <= pb.palabras.length
        ? [pa.palabras, pb.palabras] : [pb.palabras, pa.palabras];
    return corta.every(w => larga.some(x => parecidas(w, x)));
}

function mismaDireccion(a, b) {
    // Llamada solo con los mismos numeros (son parte de la clave).
    if (numerosDireccion(a)) return mismaCalleConNumero(a, b);
    const pa = palabrasDireccion(a), pb = palabrasDireccion(b);
    const [menor, mayor] = pa.size <= pb.size ? [pa, pb] : [pb, pa];
    return [...menor].every(w => mayor.has(w));
}

// obtenerFecha() descarta la hora; aqui se necesita la hora exacta.
function marcaTiempoRegistro(f) {
    const v = texto(f.fecha_creacion) || texto(f._createdAt_y) || texto(f.fecha_inspeccion);
    let m = v.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
    m = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)).getTime();
    return null; // sin hora: no se puede saber si es re-registro
}

function quitarReRegistros(filas) {
    const grupos = new Map();
    const resultado = [];
    const quitados = [];

    filas.forEach((f, orden) => {
        const x = texto(f.georeferencia_X), y = texto(f.georeferencia_Y);
        const jornada = texto(f._uid) || texto(f._id_x);
        if (!x || !y || !jornada) { resultado.push(f); return; }

        const clave = [
            jornada,
            texto(f.codigo_manzana).toUpperCase(),
            x, y,
            texto(f.atencion_vivienda_indicador),
            texto(f.tipoActividadInspeccion).toUpperCase(),
            numerosDireccion(f.direccion)
        ].join("|");

        const t = marcaTiempoRegistro(f);
        if (!grupos.has(clave)) grupos.set(clave, []);
        grupos.get(clave).push({ f, t: t === null ? -Infinity : t, orden });
    });

    grupos.forEach(lista => {
        if (lista.length === 1) { resultado.push(lista[0].f); return; }

        // Del mas antiguo al mas reciente; cada registro reemplaza a una
        // version anterior compatible de la misma vivienda.
        lista.sort((a, b) => (a.t - b.t) || (a.orden - b.orden));
        const casas = [];
        lista.forEach(reg => {
            const i = casas.findIndex(c => mismaDireccion(c.f.direccion, reg.f.direccion));
            if (i === -1) {
                casas.push(reg);
            } else {
                quitados.push({ quitado: casas[i].f, conservado: reg.f });
                casas[i] = reg;
            }
        });
        casas.forEach(c => resultado.push(c.f));
    });

    if (quitados.length) {
        console.warn("Re-registros eliminados (misma jornada + manzana + GPS + direccion):", quitados.length);
        console.table(quitados.slice(0, 30).map(q => ({
            inspector: texto(q.quitado.nombre_inspector),
            localidad: texto(q.quitado.localidad_eess),
            manzana: texto(q.quitado.codigo_manzana),
            quitado: texto(q.quitado.direccion),
            conservado: texto(q.conservado.direccion)
        })));
    }

    return resultado;
}

// ============================================================
// SEGURIDAD
// ============================================================

function seguro(nombre, fn) {
    try {
        if (typeof fn === "function") fn();
    } catch (e) {
        console.error("Error en " + nombre + ":", e);
    }
}

// ============================================================
// PROCESAR DATOS
// ============================================================

function procesarDatos(datos) {
    datosOriginales = quitarDuplicados((datos || []).filter(
        fila => fila && Object.keys(fila).length > 1
    ));

    datosFiltrados = [...datosOriginales];

    inicializarFiltros();
    seguro("actualizarFecha", actualizarFecha);
    seguro("inicializarMapa", inicializarMapa);
    seguro("actualizarDashboard", actualizarDashboard);
}

// ============================================================
// UTILIDADES
// ============================================================

function texto(valor) {
    if (valor === undefined || valor === null) return "";
    return String(valor).trim();
}

function numero(valor) {
    if (valor === undefined || valor === null || valor === "") return 0;

    const n = parseFloat(String(valor).replace(",", ".").trim());
    return Number.isNaN(n) ? 0 : n;
}

function setTexto(id, valor) {
    const el = document.getElementById(id);
    if (el) el.textContent = valor;
}

function fmt(n) {
    return Number(n || 0).toLocaleString("es-PE");
}

function fechaLocalISO(fecha) {
    return fecha.getFullYear() + "-" +
        String(fecha.getMonth() + 1).padStart(2, "0") + "-" +
        String(fecha.getDate()).padStart(2, "0");
}

// ============================================================
// ESTADOS DE VIVIENDA
// ============================================================

function inspeccionada(f) {
    return texto(f.atencion_vivienda_indicador) === "1";
}

function cerrada(f) {
    return texto(f.atencion_vivienda_indicador) === "2";
}

function renuente(f) {
    return texto(f.atencion_vivienda_indicador) === "3";
}

function deshabitada(f) {
    return texto(f.atencion_vivienda_indicador) === "4";
}

// Recuperada = vivienda marcada como recuperada en el módulo Recuperación
// de Dengue-Admin (columna "recuperada" = 1). En esa fila, la fecha y el
// inspector de la recuperación están en recuperacion_fecha y
// recuperacion_usuario_asignado (DNI), no en fecha_inspeccion/nombre_inspector.
function recuperada(f) {
    return numero(f.recuperada) === 1;
}

function construirMapaDni() {
    mapaDniInspector = {};
    datosOriginales.forEach(f => {
        const nombre = texto(f.nombre_inspector);
        [f.usuario_registra, f.usuario_registro].forEach(d => {
            const dni = texto(d);
            if (dni && dni !== "-" && nombre && !mapaDniInspector[dni]) {
                mapaDniInspector[dni] = nombre;
            }
        });
    });
}

// ------------------------------------------------------------
// Caché por fila: fechas, inspector de recuperación y recipientes
// positivos se calculan una sola vez por fila, no en cada filtro y gráfico.
// (WeakMap: no agrega columnas a las filas ni a las descargas.)
// ------------------------------------------------------------
let cacheFechaVivienda = new WeakMap();
let cacheFechaRecuperacion = new WeakMap();
let cacheInspectorRec = new WeakMap();
let cacheRecipientesPos = new WeakMap();

function memo(cache, f, calcular) {
    if (cache.has(f)) return cache.get(f);
    const v = calcular(f);
    cache.set(f, v);
    return v;
}

function inspectorRecuperacion(f) {
    return memo(cacheInspectorRec, f, inspectorRecuperacionCalc);
}

function inspectorRecuperacionCalc(f) {
    if (!mapaDniInspector) construirMapaDni();
    const dni = texto(f.recuperacion_usuario_asignado);
    return mapaDniInspector[dni] || texto(f.nombre_inspector);
}

// Fecha de cada vivienda: Dengue-Admin filtra por la hora en que se
// registró la vivienda (fecha_creacion), no por el inicio de la jornada
// (fecha_inspeccion). Si falta fecha_creacion se usa fecha_inspeccion.
function fechaVivienda(f) {
    return memo(cacheFechaVivienda, f, fechaViviendaCalc);
}

function fechaViviendaCalc(f) {
    return obtenerFecha(f.fecha_creacion) || obtenerFecha(f.fecha_inspeccion);
}

function fechaRecuperacion(f) {
    return memo(cacheFechaRecuperacion, f, fechaRecuperacionCalc);
}

function fechaRecuperacionCalc(f) {
    return obtenerFecha(f.recuperacion_fecha) || obtenerFecha(f.fecha_inspeccion);
}

// ============================================================
// VIVIENDAS Y RECIPIENTES POSITIVOS
// ============================================================

const CAMPOS_RECIPIENTES_POSITIVOS = [
    "tanque_alto_P",
    "tanque_bajo_P",
    "barril_cilindro_P",
    "sanson_bidon_P",
    "baldes_bateas_tinajas_P",
    "llantas_P",
    "floreros_maceteros_P",
    "latas_botellas_P",
    "otros_P",
    "inservibles_P"
];

function cantidadRecipientesPositivos(f) {
    return memo(cacheRecipientesPos, f, cantidadRecipientesPositivosCalc);
}

function cantidadRecipientesPositivosCalc(f) {
    return CAMPOS_RECIPIENTES_POSITIVOS.reduce(
        (total, campo) => total + Math.max(0, numero(f[campo])),
        0
    );
}

function viviendaPositiva(f) {
    return cantidadRecipientesPositivos(f) > 0;
}

function camposPositivosParaDescarga(f) {
    return {
        "Vivienda positiva": viviendaPositiva(f) ? "Sí" : "No",
        "Recipientes positivos": cantidadRecipientesPositivos(f)
    };
}

function estadoVivienda(f) {
    if (cerrada(f)) return "CERRADA";
    if (renuente(f)) return "RENUENTE";
    if (deshabitada(f)) return "DESHABITADA";
    if (recuperada(f)) return "RECUPERADA";
    return "INSPECCIONADA";
}

// ============================================================
// FECHAS
// ============================================================

function obtenerFecha(valor) {
    valor = texto(valor);
    if (!valor) return null;

    // dd/mm/yyyy o dd-mm-yyyy
    let m = valor.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);

    if (m) {
        const dia = Number(m[1]);
        const mes = Number(m[2]) - 1;
        const anio = Number(m[3]);

        const fecha = new Date(anio, mes, dia);

        if (
            fecha.getFullYear() !== anio ||
            fecha.getMonth() !== mes ||
            fecha.getDate() !== dia
        ) return null;

        return fecha;
    }

    // yyyy-mm-dd o yyyy/mm/dd
    m = valor.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);

    if (m) {
        const anio = Number(m[1]);
        const mes = Number(m[2]) - 1;
        const dia = Number(m[3]);

        const fecha = new Date(anio, mes, dia);

        if (
            fecha.getFullYear() !== anio ||
            fecha.getMonth() !== mes ||
            fecha.getDate() !== dia
        ) return null;

        return fecha;
    }

    const fecha = new Date(valor);
    return !Number.isNaN(fecha.getTime()) ? fecha : null;
}

function fijarTextoFecha(principal, secundario) {
    setTexto("fechaActualizacion", principal);
    setTexto("horaActualizacion", secundario);
}

// Muestra la fecha de la base publicada (Last-Modified del archivo).
// Si el servidor no la envía, usa el último registro del CSV.
function actualizarFecha() {
    let ahora = fechaArchivoCSV;
    let etiqueta = "Base publicada: ";

    if (!ahora) {
        ahora = datosOriginales.reduce((max, f) => {
            const d = obtenerFecha(f.fecha_creacion);
            return d && (!max || d > max) ? d : max;
        }, null);
        etiqueta = "Último registro: ";
    }
    if (!ahora) ahora = new Date();

    const fechaTexto = ahora.toLocaleDateString("es-PE", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric"
    });

    const horaTexto = ahora.toLocaleTimeString("es-PE", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true
    });

    fijarTextoFecha(fechaTexto, etiqueta + horaTexto);

    const nota = document.getElementById("notaFuenteDatos");
    if (nota) {
        nota.textContent = "Datos de la base descargada de Dengue-Admin (" +
            fechaTexto + " " + horaTexto + "). Las cifras pueden variar " +
            "ligeramente con Dengue-Admin por correcciones hechas después de la descarga.";
    }
}

// ============================================================
// FILTRO POR RANGO DE FECHAS
// ============================================================

function ponerRangoHoyManana() {
    const fechaInicio = document.getElementById("fechaInicio");
    const fechaFin = document.getElementById("fechaFin");

    const hoy = new Date();
    const manana = new Date(hoy);

    manana.setDate(manana.getDate() + 1);

    if (fechaInicio) fechaInicio.value = fechaLocalISO(hoy);
    if (fechaFin) fechaFin.value = fechaLocalISO(manana);
}

function configurarRangoFechas() {
    const fechaInicio = document.getElementById("fechaInicio");
    const fechaFin = document.getElementById("fechaFin");
    const btnLimpiarFecha = document.getElementById("btnLimpiarFecha");

    [fechaInicio, fechaFin].forEach(el => {
        if (!el || el.dataset.configurado === "true") return;

        el.addEventListener("change", function () {
            if (
                fechaInicio &&
                fechaFin &&
                fechaInicio.value &&
                fechaFin.value &&
                fechaInicio.value > fechaFin.value
            ) {
                const temporal = fechaInicio.value;
                fechaInicio.value = fechaFin.value;
                fechaFin.value = temporal;
            }

            actualizarDashboard();
        });

        el.dataset.configurado = "true";
    });

    if (btnLimpiarFecha &&
        btnLimpiarFecha.dataset.configurado !== "true") {

        btnLimpiarFecha.addEventListener("click", function () {
            ponerRangoHoyManana();
            actualizarDashboard();
        });

        btnLimpiarFecha.dataset.configurado = "true";
    }
}

// ============================================================
// FILTROS GENERALES
// ============================================================

function valoresUnicos(campo) {
    return [
        ...new Set(
            datosOriginales.map(f => texto(f[campo])).filter(Boolean)
        )
    ].sort((a, b) => a.localeCompare(b, "es"));
}

function llenarSelect(id, valores, inicial) {
    const select = document.getElementById(id);
    if (!select) return;

    const valorAnterior = select.value;
    select.innerHTML = "";

    const opcionInicial = document.createElement("option");
    opcionInicial.value = inicial;
    opcionInicial.textContent = inicial;
    select.appendChild(opcionInicial);

    valores.forEach(valor => {
        const option = document.createElement("option");
        option.value = valor;
        option.textContent = valor;
        select.appendChild(option);
    });

    // Mantener la selección cuando el CSV se actualiza.
    if ([...select.options].some(o => o.value === valorAnterior)) {
        select.value = valorAnterior;
    } else {
        select.value = inicial;
    }
}


function inicializarFiltros(primeraCarga = true) {
    llenarSelect("filtroLocalidad", valoresUnicos("localidad_eess"), "Todas");
    llenarSelect("filtroInspector", valoresUnicos("nombre_inspector"), "Todos");
    llenarSelect("filtroSector", sectoresUnicos(), "Todos");
    llenarSelect("filtroTipo", valoresUnicos("tipoActividadInspeccion"), "Todos");
    llenarSelect("filtroManzana", valoresUnicos("codigo_manzana"), "Todas");
    llenarSelect("filtroMes", MESES, "Todos");

    // Dejar las fechas vacías al iniciar el dashboard.
    const fechaInicio = document.getElementById("fechaInicio");
    const fechaFin = document.getElementById("fechaFin");

    // En las actualizaciones automáticas se respeta el rango elegido.
    if (primeraCarga) {
        if (fechaInicio) fechaInicio.value = "";
        if (fechaFin) fechaFin.value = "";
    }

    configurarRangoFechas();

    [
        "filtroLocalidad",
        "filtroMes",
        "filtroInspector",
        "filtroSector",
        "filtroTipo",
        "filtroManzana"
    ].forEach(id => {
        const el = document.getElementById(id);

        if (el && el.dataset.configurado !== "true") {
            el.addEventListener("change", actualizarDashboard);
            el.dataset.configurado = "true";
        }
    });
}


// Sectores unificados: "6", "06" y "SECTOR 6" son el mismo sector.
function sectoresUnicos() {
    return [...new Set(
        datosOriginales.map(f => texto(f.sector)).filter(Boolean).map(sectorNormalizado)
    )].sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b, "es"));
}

function valorFiltro(id, porDefecto) {
    const el = document.getElementById(id);
    return el ? texto(el.value) || porDefecto : porDefecto;
}

// ============================================================
// APLICAR TODOS LOS FILTROS
// ============================================================

function leerFiltros() {
    return {
        localidad: valorFiltro("filtroLocalidad", "Todas"),
        mes: valorFiltro("filtroMes", "Todos"),
        inspector: valorFiltro("filtroInspector", "Todos"),
        sector: valorFiltro("filtroSector", "Todos"),
        tipo: valorFiltro("filtroTipo", "Todos"),
        manzana: valorFiltro("filtroManzana", "Todas"),
        fechaInicio: valorFiltro("fechaInicio", ""),
        fechaFin: valorFiltro("fechaFin", "")
    };
}

// nombreInspector y fecha se pasan aparte porque en las recuperaciones
// se usan el inspector y la fecha de la recuperación.
function cumpleFiltros(fila, F, nombreInspector, fecha, usarTipo) {
    if (F.localidad !== "Todas" &&
        texto(fila.localidad_eess) !== F.localidad) return false;

    if (F.inspector !== "Todos" &&
        nombreInspector !== F.inspector) return false;

    if (F.sector !== "Todos" &&
        sectorNormalizado(fila.sector) !== F.sector) return false;

    if (usarTipo && F.tipo !== "Todos" &&
        texto(fila.tipoActividadInspeccion) !== F.tipo) return false;

    if (F.manzana !== "Todas" &&
        texto(fila.codigo_manzana) !== F.manzana) return false;

    if (F.mes !== "Todos") {
        if (!fecha || MESES[fecha.getMonth()] !== F.mes) return false;
    }

    // Comparar fechas como YYYY-MM-DD para incluir ambos días completos.
    if (F.fechaInicio || F.fechaFin) {
        if (!fecha) return false;

        const claveFecha = fechaLocalISO(fecha);

        if (F.fechaInicio && claveFecha < F.fechaInicio) return false;
        if (F.fechaFin && claveFecha > F.fechaFin) return false;
    }

    if (busquedaInspector !== "" &&
        !nombreInspector.toLowerCase().includes(busquedaInspector)) return false;

    return true;
}

function aplicarFiltros() {
    const F = leerFiltros();

    // Igual que Dengue-Admin: se cuentan todos los registros, incluidas las cerradas revisitadas.
    datosFiltrados = datosOriginales.filter(fila =>
        cumpleFiltros(
            fila, F,
            texto(fila.nombre_inspector),
            fechaVivienda(fila),
            true
        )
    );

    // Recuperadas: por inspector asignado y fecha de recuperación,
    // como en el módulo Recuperación de Dengue-Admin (sin filtro de tipo).
    recuperadasFiltradas = datosOriginales
        .filter(recuperada)
        .filter(fila =>
            cumpleFiltros(
                fila, F,
                inspectorRecuperacion(fila),
                fechaRecuperacion(fila),
                false
            )
        );
}

// ============================================================
// ACTUALIZAR DASHBOARD
// ============================================================

function actualizarDashboard() {
    aplicarFiltros();

    seguro("tarjetas", actualizarTarjetas);
    seguro("tratadas", actualizarTratadas);
    seguro("cobertura", actualizarCobertura);
    seguro("condicion", actualizarCondicion);
    seguro("ranking", actualizarRanking);
    seguro("mensual", actualizarMensual);
    seguro("sector", actualizarSector);
    seguro("localidad", actualizarLocalidad);
    seguro("tabla", actualizarTabla);
    seguro("mapa", actualizarMapa);
}

// ============================================================
// TARJETAS
// ============================================================

function actualizarTarjetas() {
    setTexto("totalInspeccionadas",
        fmt(datosFiltrados.filter(inspeccionada).length));

    setTexto("totalCerradas",
        fmt(datosFiltrados.filter(cerrada).length));

    setTexto("totalRenuentes",
        fmt(datosFiltrados.filter(renuente).length));

    setTexto("totalDeshabitadas",
        fmt(datosFiltrados.filter(deshabitada).length));

    setTexto("totalRecuperadas",
        fmt(recuperadasFiltradas.length));

    setTexto("totalViviendasPositivas",
        fmt(datosFiltrados.filter(viviendaPositiva).length));

    setTexto("totalRecipientesPositivos",
        fmt(datosFiltrados.reduce(
            (total, f) => total + cantidadRecipientesPositivos(f), 0)));

    setTexto(
        "totalInspectores",
        fmt(new Set(
            datosFiltrados
                .map(f => texto(f.nombre_inspector))
                .filter(Boolean)
        ).size)
    );
}

// ============================================================
// VIVIENDAS TRATADAS = suma de TQ (tratamiento quimico) + TF (tratamiento
// fisico) de los 10 tipos de criadero, segun definicion del usuario.
// ============================================================
const CRIADEROS_TRATAMIENTO = [
    "tanque_alto", "tanque_bajo", "barril_cilindro", "sanson_bidon",
    "baldes_bateas_tinajas", "llantas", "floreros_maceteros",
    "latas_botellas", "inservibles", "otros"
];

function tratamientosFila(f) {
    let tq = 0, tf = 0;
    CRIADEROS_TRATAMIENTO.forEach(c => {
        tq += Math.max(0, numero(f[c + "_TQ"]));
        tf += Math.max(0, numero(f[c + "_TF"]));
    });
    return { tq, tf };
}

// La tarjeta se crea desde aqui (copiando la de "Recipientes positivos")
// para no tener que modificar dashboard.html.
function asegurarTarjetaTratadas() {
    if (document.getElementById("totalTratadas")) return true;
    const ref = document.getElementById("totalRecipientesPositivos");
    if (!ref) return false;

    // Subir hasta la tarjeta: el ultimo contenedor que todavia NO incluye
    // la tarjeta vecina (viviendas positivas).
    const vecina = document.getElementById("totalViviendasPositivas");
    let card = ref;
    while (card.parentElement && !(vecina && card.parentElement.contains(vecina))) {
        card = card.parentElement;
    }
    if (!card.parentElement || !vecina) return false;

    const nueva = card.cloneNode(true);
    nueva.querySelectorAll("[id]").forEach(e => e.removeAttribute("id"));

    // Cambiar textos de la copia.
    const recorrer = document.createTreeWalker(nueva, NodeFilter.SHOW_TEXT);
    const nodos = [];
    while (recorrer.nextNode()) nodos.push(recorrer.currentNode);
    nodos.forEach(n => {
        const t = n.textContent.trim().toLowerCase();
        if (t === "recipientes positivos") n.textContent = "Viviendas tratadas";
        else if (t.startsWith("positividad")) n.textContent = "TQ + TF de los 10 criaderos";
    });

    // El numero: el nodo que en la original tiene el id del total.
    const ruta = [];
    for (let e = ref; e !== card; e = e.parentElement) {
        ruta.unshift([...e.parentElement.children].indexOf(e));
    }
    let valor = nueva;
    ruta.forEach(i => { valor = valor.children[i]; });
    valor.id = "totalTratadas";
    nueva.dataset.tarjeta = "tratadas";

    card.parentElement.insertBefore(nueva, card.nextSibling);
    return true;
}

function actualizarTratadas() {
    if (!asegurarTarjetaTratadas()) return;
    let tq = 0, tf = 0;
    datosFiltrados.forEach(f => {
        const r = tratamientosFila(f);
        tq += r.tq;
        tf += r.tf;
    });
    setTexto("totalTratadas", fmt(tq + tf));
    const el = document.getElementById("totalTratadas");
    if (el) el.title = "Tratamiento qu\u00edmico (TQ): " + fmt(tq) +
        " \u00b7 Tratamiento f\u00edsico (TF): " + fmt(tf);
}

// ============================================================
// COBERTURA
// ============================================================

// ------------------------------------------------------------
// TOTAL DE VIVIENDAS POR ESTABLECIMIENTO DE SALUD (denominador de cobertura)
// Fuente: "Total de viviendas por Establecimientos de Salud - NACIONAL.xlsx",
// hoja Hoja1, departamento SAN MARTIN, columna TOTAL DE VIVIENDAS (solo > 0).
// Formato: [codigo unico, distrito, establecimiento, total de viviendas].
// Para actualizar: reemplazar las filas de esta lista.
// ------------------------------------------------------------
const VIVIENDAS_EESS = [
    ["00006524", "ALTO BIAVO", "BARRANCA", 500],
    ["00006714", "ALTO BIAVO", "CENTRO AMERICA", 190],
    ["00035635", "ALTO BIAVO", "CHALLUAL", 275],
    ["00006525", "ALTO BIAVO", "CUZCO", 450],
    ["00006502", "ALTO BIAVO", "HOSPITAL BELLAVISTA II-E", 5570],
    ["00006526", "ALTO BIAVO", "INCAICO", 270],
    ["00006527", "ALTO BIAVO", "JOSE OLAYA", 580],
    ["00006528", "ALTO BIAVO", "NUEVA ARICA", 260],
    ["00006458", "BAJO BIAVO", "ALMIRANTE GRAU BOMBONAJILLO", 300],
    ["00006521", "BAJO BIAVO", "DOS UNIDOS", 360],
    ["00006522", "BAJO BIAVO", "LA UNION", 290],
    ["00011491", "BAJO BIAVO", "LIBANO", 175],
    ["00009893", "BAJO BIAVO", "NUEVO CONTROL", 230],
    ["00006519", "BAJO BIAVO", "NUEVO LIMA", 400],
    ["00006520", "BAJO BIAVO", "NUEVO TARAPOTO", 490],
    ["00006523", "BAJO BIAVO", "SANTA ELENA", 180],
    ["00011343", "BAJO BIAVO", "YANAYACU", 350],
    ["00006503", "BELLAVISTA", "BUENOS AIRES", 150],
    ["00006513", "BELLAVISTA", "HUACHO", 490],
    ["00006511", "BELLAVISTA", "LAS  MERCEDES", 640],
    ["00006505", "BELLAVISTA", "LIMON", 525],
    ["00006512", "BELLAVISTA", "NUEVA FLORIDA", 380],
    ["00006785", "BELLAVISTA", "PERUATE", 395],
    ["00006565", "HUALLAGA", "AUCARARCA", 100],
    ["00006562", "HUALLAGA", "LEDOY", 410],
    ["00029371", "SAN PABLO", "CENTRO AMERICA - SAN PABLO", 200],
    ["00006506", "SAN PABLO", "CONSUELO", 770],
    ["00006509", "SAN PABLO", "DOS DE MAYO", 100],
    ["00006499", "SAN PABLO", "FAUSA LAMISTA", 560],
    ["00006507", "SAN PABLO", "FAUSA SAPINA", 180],
    ["00006514", "SAN PABLO", "HUINGOYACU", 411],
    ["00006508", "SAN PABLO", "SAN PABLO", 320],
    ["00006518", "SAN RAFAEL", "CRISTINO GARCIA CARHUAPOMA", 510],
    ["00006516", "SAN RAFAEL", "LA LIBERTAD", 580],
    ["00006517", "SAN RAFAEL", "PANAMA", 100],
    ["00006515", "SAN RAFAEL", "SAN RAFAEL", 500],
    ["00006496", "AGUA BLANCA", "AGUA BLANCA", 702],
    ["00006498", "AGUA BLANCA", "PACASMAYO", 131],
    ["00006485", "SAN JOSE DE SISA", "HOSPITAL RURAL SAN JOSE DE SISA", 3746],
    ["00006490", "SAN JOSE DE SISA", "HUAJA", 151],
    ["00006486", "SAN JOSE DE SISA", "NAUTA", 360],
    ["00006489", "SAN JOSE DE SISA", "SAN JUAN DE MIRAFLORES", 270],
    ["00006487", "SAN JOSE DE SISA", "SANTA CRUZ", 950],
    ["00007392", "SAN MARTIN", "BUENA VISTA", 95],
    ["00007391", "SAN MARTIN", "CASHNAHUASI", 118],
    ["00007644", "SAN MARTIN", "PACAYPAMPA", 112],
    ["00006492", "SAN MARTIN", "SAN MARTIN DE ALAO", 1182],
    ["00006494", "SAN MARTIN", "SINAMI", 130],
    ["00006500", "SANTA ROSA", "BARRANQUITA RIO SISA", 323],
    ["00035285", "SANTA ROSA", "PUESTO DE SALUD ALTO PALMERAS", 161],
    ["00006510", "SANTA ROSA", "PUESTO DE SALUD RAMON CASTILLA", 219],
    ["00006407", "SANTA ROSA", "SAN JUAN DE TALLIQUIHUI", 250],
    ["00006501", "SANTA ROSA", "SANTA ELENA", 184],
    ["00006488", "SANTA ROSA", "SANTA MARTHA", 610],
    ["00006497", "SANTA ROSA", "SANTA ROSA", 302],
    ["00006491", "SHATOJA", "AMINIO", 180],
    ["00006493", "SHATOJA", "SHATOJA", 503],
    ["00006540", "ALTO SAPOSOA", "NUEVA VIDA", 305],
    ["00006539", "ALTO SAPOSOA", "PASARRAYA", 571],
    ["00035728", "ALTO SAPOSOA", "PUESTO DE SALUD VALLE GRANDE", 120],
    ["00006541", "ALTO SAPOSOA", "YACUSISA", 199],
    ["00006544", "EL ESLABON", "COLLPA", 124],
    ["00006542", "EL ESLABON", "EL ESLABON", 577],
    ["00006545", "PISCOYACU", "NUEVO SACANCHE", 155],
    ["00006533", "PISCOYACU", "PUESTO DE SALUD PISCOYACU", 706],
    ["00027002", "SACANCHE", "LA UNION", 102],
    ["00006543", "SACANCHE", "SACANCHE", 759],
    ["00006530", "SAPOSOA", "7 DE JUNIO-AHUIHUA", 40],
    ["00026163", "SAPOSOA", "AGUA AZUL", 161],
    ["00006531", "SAPOSOA", "ALMENDRAS", 45],
    ["00021587", "SAPOSOA", "ALTO PACHIZA", 160],
    ["00006537", "SAPOSOA", "CHAMBIRA", 30],
    ["00006538", "SAPOSOA", "EL DORADO", 294],
    ["00006529", "SAPOSOA", "HOSPITAL RURAL SAPOSOA I-4", 2844],
    ["00006536", "SAPOSOA", "INTIYACU", 40],
    ["00006532", "SAPOSOA", "PALTAICO", 30],
    ["00006529", "SAPOSOA", "RURAL SAPOSOA", 2844],
    ["00006534", "SAPOSOA", "SAN ANDRES", 50],
    ["00006535", "SAPOSOA", "SAN REGIS", 315],
    ["00006546", "TINGO DE SAPOSOA", "TINGO DE SAPOSOA", 350],
    ["00006350", "ALONSO DE ALVARADO", "PACAYZAPA", 768],
    ["00006348", "ALONSO DE ALVARADO", "ROQUE", 1495],
    ["00006432", "BARRANQUITA", "BARRANQUITA CAYNARACHI", 998],
    ["00006433", "BARRANQUITA", "PUERTO PIZARRO", 50],
    ["00007401", "BARRANQUITA", "SANANGO", 120],
    ["00006435", "BARRANQUITA", "SANTA CLARA", 90],
    ["00006450", "BARRANQUITA", "SANTA ELENA", 30],
    ["00006434", "BARRANQUITA", "SANTIAGO DE BORJA", 1500],
    ["00006416", "CAYNARACHI", "ALFONSO UGARTE", 410],
    ["00006418", "CAYNARACHI", "ALIANZA", 1301],
    ["00006419", "CAYNARACHI", "BONILLA", 480],
    ["00006420", "CAYNARACHI", "NUEVO LAMAS", 100],
    ["00019769", "CAYNARACHI", "NUEVO TOCACHE", 50],
    ["00006415", "CAYNARACHI", "PONGO DEL CAYNARACHI", 823],
    ["00006422", "CAYNARACHI", "SAN JUAN DE SHANUSI", 97],
    ["00006417", "CAYNARACHI", "SAN MIGUEL DE ACHINAMIZA", 260],
    ["00006421", "CAYNARACHI", "YUMBATOS", 400],
    ["00006396", "CU\u00d1UMBUQUI", "CU\u00d1UMBUQUE", 669],
    ["00006352", "LAMAS", "HOSPITAL II-E LAMAS", 4323],
    ["00006353", "LAMAS", "HUAYCO LAMAS", 1039],
    ["00006390", "LAMAS", "LAS FLORES DEL RIO MAYO", 80],
    ["00006388", "LAMAS", "SAN ANTONIO RIO MAYO", 182],
    ["00006410", "PINTO RECODO", "CHURUZAPA PINTO RECODO", 63],
    ["00006344", "PINTO RECODO", "LA LIBERTAD BAJO MAYO", 300],
    ["00006411", "PINTO RECODO", "MISHQUIYACU PINTO RECODO", 220],
    ["00006409", "PINTO RECODO", "PINTO RECODO", 1110],
    ["00006347", "PINTO RECODO", "VENCEDOR", 520],
    ["00006354", "RUMISAPA", "CHIRAPA LA LIBERTAD", 80],
    ["00006389", "RUMISAPA", "CHURUZAPA", 103],
    ["00006392", "RUMISAPA", "MACEDA", 236],
    ["00006393", "RUMISAPA", "PACCHILLA", 184],
    ["00006391", "RUMISAPA", "RUMIZAPA", 726],
    ["00006357", "SAN ROQUE DE CUMBAZA", "ALTO SHAMBOYACU", 80],
    ["00006355", "SAN ROQUE DE CUMBAZA", "CHIRICYACU", 70],
    ["00006356", "SAN ROQUE DE CUMBAZA", "PAMASHTO", 738],
    ["00006386", "SAN ROQUE DE CUMBAZA", "SAN ROQUE DE CUMBAZA", 303],
    ["00006358", "SAN ROQUE DE CUMBAZA", "YURILAMAS", 30],
    ["00006412", "SHANAO", "SHANAO", 590],
    ["00006414", "TABALOSOS", "PUCAYACU PANJUI", 200],
    ["00006413", "TABALOSOS", "SAN MIGUEL DEL RIO MAYO", 844],
    ["00006408", "TABALOSOS", "TABALOSOS", 3762],
    ["00006394", "ZAPATERO", "SANTA ANA DEL RIO MAYO", 75],
    ["00006399", "ZAPATERO", "ZAPATERO", 457],
    ["00006576", "CAMPANILLA", "BALZAYACU", 313],
    ["00006575", "CAMPANILLA", "CAMPANILLA", 1241],
    ["00006566", "CAMPANILLA", "CU\u00d1UMBUZA", 631],
    ["00006579", "CAMPANILLA", "NUEVO JAEN", 311],
    ["00006715", "CAMPANILLA", "PERLAMAYO", 142],
    ["00006577", "CAMPANILLA", "SHUMANZA", 197],
    ["00006578", "CAMPANILLA", "SION", 303],
    ["00006568", "HUICUNGO", "DOS DE MAYO", 299],
    ["00006567", "HUICUNGO", "HUICUNGO", 1328],
    ["00006556", "HUICUNGO", "MIRAFLORES", 183],
    ["00006570", "HUICUNGO", "NUEVA ESPERANZA", 60],
    ["00006571", "HUICUNGO", "PIZARRO", 120],
    ["00006569", "HUICUNGO", "SANTA INES", 102],
    ["00006555", "HUICUNGO", "SHEPTE", 125],
    ["00006551", "JUANJUI", "CAYENA", 149],
    ["00006919", "JUANJUI", "HOSPITAL JUANJUI", 9550],
    ["00006553", "JUANJUI", "HUAYABAMBA", 78],
    ["00006552", "JUANJUI", "HUINGUILLO", 81],
    ["00006549", "JUANJUI", "LA VICTORIA", 425],
    ["00006550", "JUANJUI", "QUINILLA", 57],
    ["00006554", "JUANJUI", "VILLA PRADO", 204],
    ["00006573", "PACHIZA", "ALTO EL SOL", 120],
    ["00006557", "PACHIZA", "BAGAZAN", 448],
    ["00006574", "PACHIZA", "NUEVO CHIMBOTE", 147],
    ["00006572", "PACHIZA", "PACHIZA", 394],
    ["00006558", "PACHIZA", "SAN JUAN DEL CA\u00d1O", 94],
    ["00006559", "PACHIZA", "SAN RAMON", 104],
    ["00006560", "PAJARILLO", "ARMAYARI", 99],
    ["00006563", "PAJARILLO", "COSTA RICA", 302],
    ["00006564", "PAJARILLO", "DOS UNIDOS", 72],
    ["00006561", "PAJARILLO", "PAJARILLO", 1007],
    ["00006783", "PAJARILLO", "SOLEDAD", 61],
    ["00006326", "CALZADA", "CALZADA", 1560],
    ["00006327", "HABANA", "CENTRO DE SALUD HABANA", 1533],
    ["00006341", "JEPELACIO", "CENTRO DE SALUD JERILLO", 755],
    ["00006349", "JEPELACIO", "CENTRO DE SALUD LA HUARPIA", 315],
    ["00006337", "JEPELACIO", "JEPELACIO", 1380],
    ["00006346", "JEPELACIO", "RAMIREZ", 214],
    ["00006339", "JEPELACIO", "SHUCSHUYACU", 923],
    ["00006295", "MOYOBAMBA", "DORADA", 155],
    ["00006292", "MOYOBAMBA", "IMPERIO DE CACHIYACU", 150],
    ["00006312", "MOYOBAMBA", "LLUYLLUCUCHA", 18477],
    ["00006313", "MOYOBAMBA", "MARONA", 329],
    ["00006322", "MOYOBAMBA", "PUEBLO LIBRE", 1153],
    ["00006282", "MOYOBAMBA", "PUESTO DE SALUD LA CONQUISTA", 1200],
    ["00006293", "MOYOBAMBA", "RAFAEL BELAUNDE", 180],
    ["00006296", "MOYOBAMBA", "SAN JOSE DE ALTO MAYO", 250],
    ["00006336", "SORITOR", "PUESTO DE SALUD SAN MARCOS", 537],
    ["00006332", "SORITOR", "SORITOR", 8380],
    ["00006318", "YANTALO", "YANTALO", 833],
    ["00006463", "BUENOS AIRES", "BUENOS AIRES", 432],
    ["00006465", "BUENOS AIRES", "PAUJILZAPA", 100],
    ["00006376", "BUENOS AIRES", "SAN CRISTOBAL DE UPAQUIHUA", 70],
    ["00006466", "BUENOS AIRES", "STA. ROSILLO DE UPAQUIHUA", 70],
    ["00006471", "CASPIZAPA", "CASPIZAPA", 640],
    ["00006459", "PICOTA", "BARRANQUITA PICOTA", 120],
    ["00006457", "PICOTA", "HOSPITAL RURAL  PICOTA", 2650],
    ["00006460", "PICOTA", "SANTA ROSILLO PICOTA", 100],
    ["00006461", "PICOTA", "WINGE", 182],
    ["00006469", "PILLUANA", "MISHQUIYACU", 100],
    ["00006468", "PILLUANA", "PILLUANA", 120],
    ["00006464", "PUCACACA", "CEDRO PAMPA", 100],
    ["00006462", "PUCACACA", "PUCACACA", 550],
    ["00006474", "SAN CRISTOBAL", "PUERTO RICO", 517],
    ["00006473", "SAN HILARION", "NUEVA ESPERANZA", 70],
    ["00006472", "SAN HILARION", "NUEVO EGIPTO", 150],
    ["00006470", "SAN HILARION", "SAN CRISTOBAL DE SISA", 1090],
    ["00006479", "SHAMBOYACU", "ALFONSO UGARTE", 285],
    ["00006902", "SHAMBOYACU", "NUEVO LORETO", 300],
    ["00006477", "SHAMBOYACU", "SHAMBOYACU", 480],
    ["00006480", "SHAMBOYACU", "SIMON BOLIVAR", 88],
    ["00006478", "SHAMBOYACU", "VISTA ALEGRE", 80],
    ["00006482", "TINGO DE PONASA", "AYPENA", 60],
    ["00006476", "TINGO DE PONASA", "HUA\u00d1IPO", 80],
    ["00006475", "TINGO DE PONASA", "LEONCIO PRADO", 290],
    ["00006483", "TINGO DE PONASA", "MARISCAL CASTILLA", 100],
    ["00006481", "TINGO DE PONASA", "TINGO DE PONAZA", 310],
    ["00006467", "TRES UNIDOS", "TRES UNIDOS", 600],
    ["00006297", "AWAJUN", "BAJO NARANJILLO", 894],
    ["00009075", "AWAJUN", "NUEVA SANTA CRUZ", 200],
    ["00007464", "AWAJUN", "SAN CARLOS", 215],
    ["00006298", "AWAJUN", "SAN FRANCISCO ALTO MAYO", 784],
    ["00006277", "ELIAS SOPLIN VARGAS", "CENTRO DE SALUD SEGUNDA JERUSALEN", 6364],
    ["00007298", "ELIAS SOPLIN VARGAS", "PUESTO DE SALUD LA NACIENTE DEL RIO NEGRO", 330],
    ["00017707", "ELIAS SOPLIN VARGAS", "PUESTO DE SALUD LA VICTORIA", 55],
    ["00006279", "ELIAS SOPLIN VARGAS", "PUESTO DE SALUD PUERTO BAGAZAN", 84],
    ["00006903", "ELIAS SOPLIN VARGAS", "PUESTO DE SALUD SANTA FE", 80],
    ["00006278", "ELIAS SOPLIN VARGAS", "PUESTO DE SALUD VALLE GRANDE", 280],
    ["00006300", "NUEVA CAJAMARCA", "CENTRO DE SALUD SAN JUAN RIO SORITOR", 553],
    ["00006283", "NUEVA CAJAMARCA", "HOSPITAL RURAL NUEVA CAJAMARCA", 16372],
    ["00006289", "NUEVA CAJAMARCA", "MIRAFLORES", 400],
    ["00006301", "NUEVA CAJAMARCA", "NARANJILLO", 2685],
    ["00006286", "NUEVA CAJAMARCA", "PALESTINA", 170],
    ["00006284", "NUEVA CAJAMARCA", "PUESTO DE SALUD LA FLORIDA", 380],
    ["00006285", "NUEVA CAJAMARCA", "PUESTO DE SALUD LA UNION", 837],
    ["00006299", "NUEVA CAJAMARCA", "PUESTO DE SALUD PERLA DAGUAS", 189],
    ["00006302", "NUEVA CAJAMARCA", "PUESTO DE SALUD TUPAC AMARU", 100],
    ["00006287", "NUEVA CAJAMARCA", "TAHUANTINSUYO", 119],
    ["00006288", "NUEVA CAJAMARCA", "UCRANIA", 331],
    ["00006304", "PARDO MIGUEL", "AGUAS CLARAS", 458],
    ["00006303", "PARDO MIGUEL", "CENTRO DE SALUD NARANJOS", 2581],
    ["00006306", "PARDO MIGUEL", "EL MIRADOR", 308],
    ["00006310", "PARDO MIGUEL", "PERLA DEL MAYO", 22],
    ["00006307", "PARDO MIGUEL", "PIONEROS BAJO (SAN JUAN DEL MAYO)", 275],
    ["00006305", "PARDO MIGUEL", "PUESTO DE SALUD AGUAS VERDES", 656],
    ["00006308", "PARDO MIGUEL", "PUESTO DE SALUD SAN AGUSTIN", 166],
    ["00006309", "PARDO MIGUEL", "PUESTO DE SALUD TUMBARO", 296],
    ["00006274", "POSIC", "PUESTO DE SALUD POSIC", 1287],
    ["00006270", "RIOJA", "CENTRO DE SALUD NUEVA RIOJA", 10833],
    ["00006708", "RIOJA", "PUESTO DE SALUD LA PERLA DE CASCAYUNGA", 30],
    ["00006271", "RIOJA", "PUESTO DE SALUD MASHUYACU", 15],
    ["00006280", "RIOJA", "PUESTO DE SALUD PORVENIR", 1198],
    ["00006273", "RIOJA", "PUESTO DE SALUD TAMBO", 350],
    ["00006290", "SAN FERNANDO", "CENTRO DE SALUD SAN FERNANDO", 930],
    ["00006294", "SAN FERNANDO", "PERLA MAYO", 120],
    ["00006275", "YORONGOS", "CENTRO DE SALUD YORONGOS", 986],
    ["00006276", "YORONGOS", "PUESTO DE SALUD NUEVO TABALOSOS", 45],
    ["00006281", "YURACYACU", "YURACYACU", 1459],
    ["00006383", "ALBERTO LEVEAU", "MACHUNGO", 128],
    ["00006382", "ALBERTO LEVEAU", "UTCURARCA", 297],
    ["00006395", "CACATACHI", "CACATACHI", 1800],
    ["00006423", "CHAZUTA", "CHAZUTA", 1842],
    ["00006451", "EL PORVENIR", "PELEJO", 1033],
    ["00006437", "HUIMBAYOC", "HUIMBAYOC", 1764],
    ["00006444", "HUIMBAYOC", "SANTA ROSILLO CHIPURANA", 842],
    ["00006374", "JUAN GUERRA", "JUAN GUERRA", 1849],
    ["00006359", "LA BANDA DE SHILCAYO", "BANDA SHILCAYO", 20742],
    ["00006366", "LA BANDA DE SHILCAYO", "LAS PALMAS", 786],
    ["00006361", "MORALES", "MORALES", 18074],
    ["00006449", "PAPAPLAYA", "HOSPITAL RURAL DE PAPAPLAYA", 785],
    ["00006387", "SAN ANTONIO", "AUCALOMA", 136],
    ["00006384", "SAN ANTONIO", "SAN ANTONIO DE CUMBAZA", 853],
    ["00006385", "SAN ANTONIO", "SAN PEDRO DE CUMBAZA", 385],
    ["00006380", "SAUCE", "SAUCE", 2650],
    ["00006375", "SHAPAJA", "SHAPAJA", 726],
    ["00006362", "TARAPOTO", "CENTRO DE SALUD NUEVE DE ABRIL", 7588],
    ["00006371", "TARAPOTO", "HUAYCO TARAPOTO", 4492],
    ["00006363", "TARAPOTO", "PUESTO DE SALUD ATUMPAMPA", 4213],
    ["00006370", "TARAPOTO", "PUNTA DEL ESTE", 8886],
    ["00006587", "NUEVO PROGRESO", "CENTRO DE SALUD NUEVO  PROGRESO", 1797],
    ["00006591", "NUEVO PROGRESO", "CENTRO DE SALUD RAMAL DE ASPUZANA", 471],
    ["00034415", "NUEVO PROGRESO", "PUESTO DE SALUD LAS PALMERAS", 272],
    ["00006590", "NUEVO PROGRESO", "PUESTO DE SALUD MADRE MIA", 168],
    ["00006593", "NUEVO PROGRESO", "PUESTO DE SALUD PUERTO RICO", 127],
    ["00034416", "NUEVO PROGRESO", "PUESTO DE SALUD RIO BLANCO", 256],
    ["00006589", "NUEVO PROGRESO", "PUESTO DE SALUD RIO UCHIZA", 337],
    ["00006592", "NUEVO PROGRESO", "PUESTO DE SALUD SANTA CRUZ", 441],
    ["00006597", "POLVORA", "CENTRO DE SALUD NUEVO HORIZONTE", 595],
    ["00006623", "POLVORA", "PUERTO PIZANA", 575],
    ["00006786", "POLVORA", "PUESTO DE SALUD CEDRO", 79],
    ["00006596", "POLVORA", "PUESTO DE SALUD CHALLUAYACU", 128],
    ["00006626", "POLVORA", "PUESTO DE SALUD NUEVO SAN MARTIN", 248],
    ["00006624", "POLVORA", "PUESTO DE SALUD POLVORA", 305],
    ["00006625", "POLVORA", "PUESTO DE SALUD SANTA ROSA DE MISHOLLO", 258],
    ["00035262", "POLVORA", "PUESTO DE SALUD SARGENTO LORES DE BALZAYACU", 351],
    ["00006602", "SANTA LUC\u00cdA", "SANTA LUCIA", 1234],
    ["00006586", "SHUNTE", "PUESTO DE SALUD SHUNTE", 142],
    ["00006580", "TOCACHE", "HOSPITAL II-1 \"DR. JOSE PE\u00d1A PORTUGUEZ \" - TOCACHE", 6675],
    ["00006581", "TOCACHE", "NUEVA ESPERANZA", 145],
    ["00006594", "TOCACHE", "NUEVO BAMBAMARCA", 778],
    ["00006598", "TOCACHE", "PUESTO DE SALUD ISHANGA", 110],
    ["00006622", "TOCACHE", "PUESTO DE SALUD SAN CRISTOBAL", 91],
    ["00006595", "TOCACHE", "PUESTO DE SALUD TANANTA", 643],
    ["00006582", "TOCACHE", "PUSHURUMBO", 52],
    ["00006584", "TOCACHE", "YACUSISA", 125],
    ["00006600", "UCHIZA", "CAJATAMBO", 127],
    ["00006621", "UCHIZA", "CRUZ PAMPA", 158],
    ["00006601", "UCHIZA", "HUICTE", 173],
    ["00015152", "UCHIZA", "JORGE CHAVEZ", 177],
    ["00006604", "UCHIZA", "PAMPAYACU", 224],
    ["00006603", "UCHIZA", "PUESTO DE SALUD EL PORVENIR", 165],
    ["00006588", "UCHIZA", "PUESTO DE SALUD NUEVO PORONGO", 523],
    ["00017706", "UCHIZA", "SAN JUAN DE DIOS", 25],
    ["00006585", "UCHIZA", "SANTA ROSA DE SHAPAJA", 426],
    ["00006599", "UCHIZA", "UCHIZA", 3318]
];

// "CENTRO DE SALUD NUEVE DE ABRIL", "C.S. Nueve de Abril", "Nueve de Abril" -> "NUEVE DE ABRIL"
function claveEess(valor) {
    return texto(valor).toUpperCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/\(.*?\)/g, " ")
        .replace(/[^A-Z0-9]+/g, " ")
        .replace(/\b(CENTRO DE SALUD|PUESTO DE SALUD|HOSPITAL RURAL DE|HOSPITAL RURAL|CS|PS|C S|P S|I [1-4])\b/g, " ")
        .replace(/\b(DE|DEL|LA|EL|LOS|LAS)\b/g, " ")
        .replace(/\s+/g, " ").trim();
}

let indiceViviendasEess = null;

// Busca el total de viviendas de una localidad (establecimiento) del CSV.
// Primero por distrito + nombre (hay nombres repetidos en otros distritos);
// si no hay distrito, por nombre cuando es unico en el departamento.
function totalViviendasEess(localidad, distrito) {
    if (!indiceViviendasEess) {
        indiceViviendasEess = { porDistrito: {}, porNombre: {} };
        VIVIENDAS_EESS.forEach(([, dist, nombre, total]) => {
            const kn = claveEess(nombre);
            indiceViviendasEess.porDistrito[claveEess(dist) + "|" + kn] = total;
            const pn = indiceViviendasEess.porNombre;
            pn[kn] = (kn in pn) ? null : total; // null = nombre repetido
        });
    }
    const kn = claveEess(localidad);
    const kd = claveEess(distrito) + "|" + kn;
    if (kd in indiceViviendasEess.porDistrito) return indiceViviendasEess.porDistrito[kd];
    const t = indiceViviendasEess.porNombre[kn];
    if (t !== undefined) return t;

    // Nombre incompleto ("Huayco" -> "HUAYCO TARAPOTO"): todas las palabras
    // de uno estan en el otro, dentro del mismo distrito y sin ambiguedad.
    const pal = new Set(kn.split(" ").filter(Boolean));
    // Si la localidad se llama igual que el distrito, no se adivina.
    if (!pal.size || kn === claveEess(distrito)) return null;
    const prefijo = claveEess(distrito) + "|";
    const candidatos = Object.keys(indiceViviendasEess.porDistrito).filter(c => {
        if (!c.startsWith(prefijo)) return false;
        const otras = new Set(c.slice(prefijo.length).split(" ").filter(Boolean));
        const [menor, mayor] = pal.size <= otras.size ? [pal, otras] : [otras, pal];
        return [...menor].every(w => mayor.has(w));
    });
    return candidatos.length === 1 ? indiceViviendasEess.porDistrito[candidatos[0]] : null;
}

// Viviendas programadas para VIGILANCIA (muestreo aleatorio sistematico),
// misma formula del Excel "Total de viviendas por EESS" (columna METODO
// ALEATORIO SISTEMATICO): n = N*Z^2*p*q / (e^2*(N-1) + Z^2*p*q),
// con Z = 1.96 (95 %), p = q = 0.5, e = 0.05. Ej.: Punta del Este N = 8886 -> 368.
function viviendasProgramadasVigilancia(N) {
    if (!N || N <= 0) return 0;
    const z2pq = 1.96 * 1.96 * 0.5 * 0.5;
    return Math.round((N * z2pq) / (0.05 * 0.05 * (N - 1) + z2pq));
}

// Crea (una sola vez) el recuadro "Viviendas programadas (vigilancia)"
// copiando el de "Total viviendas base", sin modificar dashboard.html.
function asegurarCuadroProgramadas() {
    if (document.getElementById("coverageProgramadas")) return true;
    const ref = document.getElementById("coverageTotal");
    const vecino = document.getElementById("coverageInspeccionadas");
    if (!ref || !vecino) return false;

    let caja = ref;
    while (caja.parentElement && !caja.parentElement.contains(vecino)) {
        caja = caja.parentElement;
    }
    if (!caja.parentElement) return false;

    const ruta = [];
    for (let e = ref; e !== caja; e = e.parentElement) {
        ruta.unshift([...e.parentElement.children].indexOf(e));
    }

    const nueva = caja.cloneNode(true);
    nueva.querySelectorAll("[id]").forEach(e => e.removeAttribute("id"));
    const rec = document.createTreeWalker(nueva, NodeFilter.SHOW_TEXT);
    while (rec.nextNode()) {
        const n = rec.currentNode;
        if (n.textContent.trim().toLowerCase() === "total viviendas base") {
            n.textContent = "Viviendas programadas (vigilancia)";
        }
    }
    let valor = nueva;
    ruta.forEach(i => { valor = valor.children[i]; });
    valor.id = "coverageProgramadas";
    nueva.dataset.caja = "programadas";

    caja.parentElement.insertBefore(nueva, caja.nextSibling);
    ordenarCuadrosCobertura(caja.parentElement);
    return true;
}

// Con 4 recuadros ya no entran apilados: se ordenan en 2 x 2
// (inspeccionadas | total base / programadas | meta anual).
function ordenarCuadrosCobertura(cont) {
    cont.style.display = "grid";
    cont.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
    cont.style.gap = "8px";
    cont.style.alignContent = "center";
    cont.style.height = "auto";
    cont.style.overflow = "visible";
    [...cont.children].forEach(c => {
        c.style.margin = "0";
        c.style.minWidth = "0";
        c.style.boxSizing = "border-box";
        c.style.position = "relative";
    });
}

// ------------------------------------------------------------
// VIVIENDAS PROGRAMADAS MODIFICADAS A MANO
// 1) Para todos los usuarios: escribirlas aqui, con el nombre del
//    establecimiento tal como sale en el dashboard. Ej.:
//      "PUNTA DEL ESTE": 400,
// 2) Desde la pagina: boton "Modificar" del recuadro (filtrando una sola
//    localidad). Ese cambio se guarda solo en el navegador de esa PC.
// Lo escrito en la pagina tiene prioridad sobre esta lista.
// ------------------------------------------------------------
const PROGRAMADAS_FIJAS = {
};

const CLAVE_PROGRAMADAS_LOCAL = "dengue_programadas_vigilancia";

function leerProgramadasLocales() {
    try {
        return JSON.parse(localStorage.getItem(CLAVE_PROGRAMADAS_LOCAL) || "{}") || {};
    } catch (e) {
        return {};
    }
}

function guardarProgramadasLocales(obj) {
    try {
        localStorage.setItem(CLAVE_PROGRAMADAS_LOCAL, JSON.stringify(obj));
        return true;
    } catch (e) {
        return false;
    }
}

// Devuelve { valor, origen } para un establecimiento.
function programadasDe(localidad, totalViviendas) {
    const k = claveEess(localidad);
    const locales = leerProgramadasLocales();
    if (locales[k] > 0) return { valor: locales[k], origen: "modificado en este navegador" };
    for (const [nombre, v] of Object.entries(PROGRAMADAS_FIJAS)) {
        if (claveEess(nombre) === k && v > 0) return { valor: v, origen: "fijado en script.js" };
    }
    return { valor: viviendasProgramadasVigilancia(totalViviendas), origen: "calculado" };
}

// Localidades con total de viviendas que se ven con los filtros actuales.
let locsCoberturaActual = [];

function modificarProgramadas() {
    if (locsCoberturaActual.length !== 1) {
        alert("Para modificar las viviendas programadas, filtra una sola localidad.");
        return;
    }
    const { loc, total } = locsCoberturaActual[0];
    const actual = programadasDe(loc, total);
    const calculado = viviendasProgramadasVigilancia(total);
    const resp = prompt(
        "Viviendas programadas (vigilancia) para " + loc + ".\n" +
        "Calculado por f\u00f3rmula: " + calculado + ". Actual: " + actual.valor +
        " (" + actual.origen + ").\n\n" +
        "Escribe el nuevo valor, o deja vac\u00edo para volver al calculado:",
        String(actual.valor)
    );
    if (resp === null) return; // cancelado

    const locales = leerProgramadasLocales();
    const k = claveEess(loc);
    const n = parseInt(String(resp).replace(/[^0-9]/g, ""), 10);
    if (String(resp).trim() === "") {
        delete locales[k];
    } else if (!n || n <= 0) {
        alert("Escribe un n\u00famero mayor que cero.");
        return;
    } else {
        locales[k] = n;
    }
    if (!guardarProgramadasLocales(locales)) {
        alert("Este navegador no permite guardar el cambio.");
        return;
    }
    actualizarCobertura();
}

// Boton "Modificar" junto al numero (se crea una sola vez).
function asegurarBotonModificar() {
    const valor = document.getElementById("coverageProgramadas");
    if (!valor || document.getElementById("btnModificarProgramadas")) return;
    const b = document.createElement("button");
    b.id = "btnModificarProgramadas";
    b.type = "button";
    b.textContent = "\u270e Modificar";
    b.style.cssText = "position:absolute;top:6px;right:6px;font-size:10px;" +
        "line-height:1.4;padding:1px 6px;border:1px solid #269bb0;" +
        "border-radius:4px;background:#fff;color:#078ca5;cursor:pointer;";
    b.addEventListener("click", modificarProgramadas);
    // En la esquina superior derecha del recuadro, sin mover los textos.
    const caja = valor.closest("[data-caja=\"programadas\"]") || valor.parentElement;
    caja.style.position = "relative";
    caja.appendChild(b);
}

// Cambia el texto bajo el porcentaje de la dona segun el tipo filtrado y
// resalta el recuadro que se usa como denominador.
function rotularCobertura(esVigilancia, tipoSel, insp, denom) {
    const pct = document.getElementById("coveragePercent");
    if (pct) {
        const rotulo = esVigilancia ? "Cobertura de vigilancia"
            : (tipoSel === "Todos" ? "Cobertura de inspecci\u00f3n" : "Cobertura de control");
        const rec = document.createTreeWalker(pct.parentElement, NodeFilter.SHOW_TEXT);
        const nodos = [];
        while (rec.nextNode()) nodos.push(rec.currentNode);
        nodos.filter(n => !pct.contains(n)).forEach(n => {
            // Puede venir en una linea o en dos ("Cobertura" / "de inspeccion").
            const t = n.textContent.trim();
            if (/^cobertura\s+de\s/i.test(t)) {
                n.textContent = rotulo;
            } else if (/^de\s+(inspecci|vigilancia|control)/i.test(t)) {
                n.textContent = rotulo.split(" ").slice(1).join(" ");
            }
        });
        pct.title = "Inspeccionadas " + fmt(insp) + " \u00f7 " +
            (esVigilancia ? "viviendas programadas " : "total de viviendas ") + fmt(denom);
    }
    // Borde en el recuadro que hace de denominador.
    [["coverageTotal", !esVigilancia], ["coverageProgramadas", esVigilancia]].forEach(([id, activo]) => {
        const el = document.getElementById(id);
        if (!el) return;
        const caja = el.closest("[data-caja]") || el.parentElement;
        caja.style.outline = activo ? "2px solid #269bb0" : "none";
        caja.style.outlineOffset = "-2px";
    });
}

let avisoSinTotal = "";

function actualizarCobertura() {
    // Cobertura = viviendas inspeccionadas / total de viviendas de los
    // establecimientos (localidades) que aparecen con los filtros actuales.
    // Las localidades sin total de viviendas no entran al calculo.
    const porLocalidad = {};
    datosFiltrados.forEach(f => {
        const loc = texto(f.localidad_eess);
        if (!loc) return;
        if (!porLocalidad[loc]) porLocalidad[loc] = { insp: 0, dist: texto(f.distrito) };
        if (inspeccionada(f)) porLocalidad[loc].insp++;
    });

    let inspeccionadasTotal = 0;
    let viviendasBase = 0;
    let programadasVigilancia = 0; // suma por establecimiento
    const programadasModificadas = [];
    const locsConTotal = [];
    const sinTotal = [];
    Object.entries(porLocalidad).forEach(([loc, v]) => {
        const total = totalViviendasEess(loc, v.dist);
        if (!total) { sinTotal.push(loc); return; }
        viviendasBase += total;
        const prog = programadasDe(loc, total);
        programadasVigilancia += prog.valor;
        if (prog.origen !== "calculado") programadasModificadas.push(loc + " (" + prog.origen + ")");
        locsConTotal.push({ loc, total });
        inspeccionadasTotal += v.insp;
    });

    const aviso = sinTotal.sort().join(", ");
    if (aviso && aviso !== avisoSinTotal) {
        console.warn("Localidades sin total de viviendas (no entran a la cobertura):", aviso);
    }
    avisoSinTotal = aviso;

    // Denominador segun el tipo de inspeccion filtrado:
    //  - VIGILANCIA: viviendas programadas (muestra).
    //  - CONTROL u otro / Todos: total de viviendas del establecimiento.
    const tipoSel = valorFiltro("filtroTipo", "Todos");
    const esVigilancia = /VIGIL/i.test(tipoSel);
    const denominador = esVigilancia ? programadasVigilancia : viviendasBase;

    const porcentajeReal = denominador > 0
        ? Number(((inspeccionadasTotal / denominador) * 100).toFixed(1))
        : 0;
    // El grafico y la barra se topan en 100; el numero muestra el valor real.
    const porcentaje = Math.min(100, porcentajeReal);

    setTexto("coveragePercent", porcentajeReal + "%");
    rotularCobertura(esVigilancia, tipoSel, inspeccionadasTotal, denominador);
    const notaCob = document.getElementById("coverageTotal");
    if (notaCob) notaCob.title = avisoSinTotal
        ? "Sin total de viviendas (no se cuentan): " + avisoSinTotal : "";
    setTexto("coverageInspeccionadas", fmt(inspeccionadasTotal));
    setTexto("coverageTotal", fmt(viviendasBase));

    locsCoberturaActual = locsConTotal;
    if (asegurarCuadroProgramadas()) {
        setTexto("coverageProgramadas", fmt(programadasVigilancia));
        asegurarBotonModificar();
        const elProg = document.getElementById("coverageProgramadas");
        if (elProg) elProg.title = programadasVigilancia > 0
            ? "Muestra para vigilancia (95 % de confianza, 5 % de error). Avance: " +
              fmt(inspeccionadasTotal) + " de " + fmt(programadasVigilancia) + " (" +
              (inspeccionadasTotal / programadasVigilancia * 100).toFixed(1) + " %)" +
              (programadasModificadas.length
                  ? "\nModificadas a mano: " + programadasModificadas.join(", ") : "")
            : "";
        const btn = document.getElementById("btnModificarProgramadas");
        if (btn) btn.title = locsConTotal.length === 1
            ? "Modificar las viviendas programadas de " + locsConTotal[0].loc
            : "Filtra una sola localidad para modificar";
    }

    const progreso = document.getElementById("coverageProgress");
    if (progreso) progreso.style.width = porcentaje + "%";

    crearGrafico("coverageChart", {
        type: "doughnut",
        data: {
            labels: ["Inspeccionadas", "No inspeccionadas"],
            datasets: [{
                data: [porcentaje, 100 - porcentaje],
                backgroundColor: ["#269bb0", "#e8edf0"],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: "70%",
            plugins: { legend: { display: false } }
        }
    });
}

// ============================================================
// GRÁFICOS
// ============================================================

function opcionesBarras(horizontal) {
    const eje = { beginAtZero: true };

    return {
        indexAxis: horizontal ? "y" : "x",
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        layout: {
            padding: {
                left: horizontal ? 120 : 5,
                right: 10,
                top: 5,
                bottom: 5
            }
        },
        plugins: { legend: { display: false } },
        scales: horizontal
            ? {
                x: eje,
                y: {
                    ticks: {
                        autoSkip: false,
                        padding: 8,
                        font: { size: 10 }
                    }
                }
            }
            : { y: eje }
    };
}

function graficoBarras(id, etiquetas, valores, etiquetaSerie, color, horizontal) {
    crearGrafico(id, {
        type: "bar",
        data: {
            labels: etiquetas,
            datasets: [{
                label: etiquetaSerie,
                data: valores,
                backgroundColor: color
            }]
        },
        options: opcionesBarras(horizontal)
    });
}

function agruparInspeccionadas(campo, vacio, normalizar) {
    const grupos = {};

    datosFiltrados.filter(inspeccionada).forEach(fila => {
        const valor = texto(fila[campo]);
        const clave = (valor && normalizar ? normalizar(valor) : valor) || vacio;
        grupos[clave] = (grupos[clave] || 0) + 1;
    });

    return Object.entries(grupos)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15);
}

function actualizarCondicion() {
    const datos = [
        datosFiltrados.filter(inspeccionada).length,
        datosFiltrados.filter(cerrada).length,
        datosFiltrados.filter(renuente).length,
        datosFiltrados.filter(deshabitada).length,
        recuperadasFiltradas.length
    ];

    graficoBarras(
        "conditionChart",
        ["Inspeccionadas", "Cerradas", "Renuentes", "Deshabitadas", "Recuperadas"],
        datos,
        "Viviendas",
        ["#5dade2", "#ed4149", "#f2aa12", "#7437a5", "#38aa43"],
        false
    );
}

function actualizarRanking() {
    // Por tipo de criadero: recipientes inspeccionados (_I) y positivos (_P),
    // en dos barras. Ya no se suman tratados ni destruidos (TQ, TF, D), que
    // contaban el mismo recipiente varias veces. Solo viviendas inspeccionadas.
    const tipos = [
        ["Tanque alto", "tanque_alto"],
        ["Tanque bajo", "tanque_bajo"],
        ["Barril", "barril_cilindro"],
        ["Sanson / Bid\u00f3n", "sanson_bidon"],
        ["Baldes", "baldes_bateas_tinajas"],
        ["Llantas", "llantas"],
        ["Floreros", "floreros_maceteros"],
        ["Latas", "latas_botellas"],
        ["Inservibles", "inservibles"],
        ["Otros", "otros"]
    ];

    const ranking = tipos.map(([nombre, campo]) => ({ nombre, insp: 0, pos: 0 }));
    datosFiltrados.forEach(fila => {
        if (!inspeccionada(fila)) return;
        tipos.forEach(([, campo], k) => {
            ranking[k].insp += Math.max(0, numero(fila[campo + "_I"]));
            ranking[k].pos += Math.max(0, numero(fila[campo + "_P"]));
        });
    });
    ranking.sort((a, b) => (b.insp - a.insp) || (b.pos - a.pos));

    crearGrafico("rankingChart", {
        type: "bar",
        data: {
            labels: ranking.map(x => x.nombre),
            datasets: [
                {
                    label: "Inspeccionados",
                    data: ranking.map(x => x.insp),
                    backgroundColor: "#5dade2",
                    borderRadius: 4,
                    borderSkipped: false
                },
                {
                    label: "Positivos",
                    data: ranking.map(x => x.pos),
                    backgroundColor: "#ed4149",
                    borderRadius: 4,
                    borderSkipped: false
                }
            ]
        },
        options: {
            indexAxis: "y",
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: { display: true, position: "top" },
                tooltip: {
                    callbacks: {
                        label: c => " " + c.dataset.label + ": " + fmt(c.raw),
                        afterBody: items => {
                            const x = ranking[items[0].dataIndex];
                            return x.insp > 0
                                ? "Positividad: " + (x.pos / x.insp * 100).toFixed(1) + " %"
                                : "";
                        }
                    }
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    ticks: { callback: v => fmt(v) }
                },
                y: {
                    ticks: { autoSkip: false, font: { size: 10 } }
                }
            }
        }
    });
}

function actualizarMensual() {
    // Una sola pasada por los datos (antes eran 12, una por mes).
    const valores = MESES.map(() => 0);
    datosFiltrados.forEach(fila => {
        if (!inspeccionada(fila)) return;
        const fecha = fechaVivienda(fila);
        if (fecha) valores[fecha.getMonth()]++;
    });

    graficoBarras(
        "monthlyChart", MESES, valores,
        "Viviendas inspeccionadas", "#75bce7", false
    );
}

function actualizarSector() {
    const o = agruparInspeccionadas("sector", "Sin sector", sectorNormalizado);

    graficoBarras(
        "sectorChart", o.map(x => x[0]), o.map(x => x[1]),
        "Inspeccionadas", "#75bce7", false
    );
}

function actualizarInspector() {
    const conteoInspectores = {};

    datosFiltrados.filter(inspeccionada).forEach(fila => {
        const inspector = texto(fila.nombre_inspector) || "Sin inspector";
        conteoInspectores[inspector] =
            (conteoInspectores[inspector] || 0) + 1;
    });

    const ranking = Object.entries(conteoInspectores)
        .sort((a, b) => b[1] - a[1]);

    graficoBarras(
        "inspectorChart",
        ranking.map(x => x[0]),
        ranking.map(x => x[1]),
        "Viviendas inspeccionadas",
        "#75bce7",
        true
    );
}

function actualizarLocalidad() {
    const o = agruparInspeccionadas("localidad_eess", "Sin localidad");

    graficoBarras(
        "localityChart", o.map(x => x[0]), o.map(x => x[1]),
        "Viviendas", "#75bce7", false
    );
}

function crearGrafico(id, configuracion) {
    const canvas = document.getElementById(id);

    if (!canvas || typeof Chart === "undefined") return;

    if (charts[id]) {
        try {
            charts[id].destroy();
        } catch (e) {
            console.warn("No se pudo destruir el gráfico:", id, e);
        }
    }

    charts[id] = new Chart(canvas, configuracion);
}

// ============================================================
// TABLA POR LOCALIDAD
// ============================================================

function actualizarTabla() {
    const tbody = document.getElementById("tablaLocalidades");
    if (!tbody) return;

    const localidades = {};

    datosFiltrados.forEach(fila => {
        const loc = texto(fila.localidad_eess) || "Sin localidad";

        if (!localidades[loc]) {
            localidades[loc] = {
                inspeccionadas: 0,
                cerradas: 0,
                renuentes: 0,
                deshabitadas: 0,
                recuperadas: 0,
                positivas: 0,
                recipientesPositivos: 0
            };
        }

        if (inspeccionada(fila)) localidades[loc].inspeccionadas++;
        if (cerrada(fila)) localidades[loc].cerradas++;
        if (renuente(fila)) localidades[loc].renuentes++;
        if (deshabitada(fila)) localidades[loc].deshabitadas++;
        if (viviendaPositiva(fila)) localidades[loc].positivas++;
        localidades[loc].recipientesPositivos += cantidadRecipientesPositivos(fila);
    });

    recuperadasFiltradas.forEach(fila => {
        const loc = texto(fila.localidad_eess) || "Sin localidad";

        if (!localidades[loc]) {
            localidades[loc] = {
                inspeccionadas: 0, cerradas: 0, renuentes: 0, deshabitadas: 0,
                recuperadas: 0, positivas: 0, recipientesPositivos: 0
            };
        }

        localidades[loc].recuperadas++;
    });

    tbody.innerHTML = "";

    Object.entries(localidades)
        .sort((a, b) => b[1].inspeccionadas - a[1].inspeccionadas)
        .forEach(([localidad, v]) => {
            const tr = document.createElement("tr");

            // Crear celdas con textContent para evitar interpretar HTML.
            [
                localidad,
                fmt(v.inspeccionadas),
                fmt(v.cerradas),
                fmt(v.renuentes),
                fmt(v.deshabitadas),
                fmt(v.recuperadas),
                fmt(v.positivas),
                fmt(v.recipientesPositivos)
            ].forEach(valor => {
                const td = document.createElement("td");
                td.textContent = valor;
                tr.appendChild(td);
            });

            tbody.appendChild(tr);
        });
}

// ============================================================
// MAPA
// ============================================================

let capaCalor = null;
let ultimaFirmaMapa = "";

const COLOR_CONDICION = {
    POSITIVA: "#e53935",
    INSPECCIONADA: "#1e6fff",
    CERRADA: "#111111",
    RENUENTE: "#8e24aa",
    DESHABITADA: "#f57c00"
};

function inicializarMapa() {
    const elemento = document.getElementById("map");

    if (!elemento || typeof L === "undefined" || mapa) return;

    // preferCanvas: dibuja los puntos en un solo lienzo (más rápido).
    mapa = L.map("map", { preferCanvas: true }).setView([-6.4869, -76.3625], 11);

    // Mapa base de OpenStreetMap (libre, sin clave). CARTO ahora exige
    // API key y muestra "API KEY REQUIRED" en lugar del mapa.
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap"
    }).addTo(mapa);

    capaMarcadores = (typeof L.markerClusterGroup === "function")
        ? L.markerClusterGroup({
            chunkedLoading: true,
            showCoverageOnHover: false,
            maxClusterRadius: 60,
            iconCreateFunction: grupo => {
                const n = grupo.getChildCount();
                const tam = n < 10 ? 26 : n < 100 ? 40 : n < 1000 ? 50 : 60;
                return L.divIcon({
                    html: "<div style=\"font-size:" + (tam < 30 ? 11 : tam < 45 ? 15 : 18) +
                        "px\">" + n.toLocaleString("es-PE") + "</div>",
                    className: "cluster-viv",
                    iconSize: [tam, tam]
                });
            }
        })
        : L.layerGroup();
    capaMarcadores.addTo(mapa);

    const chk = document.getElementById("mapaCalor");
    if (chk) chk.addEventListener("change", () => { ultimaFirmaMapa = ""; actualizarMapa(); });

    // Al elegir qué representa el calor, se activa el mapa de calor.
    const modo = document.getElementById("mapaCalorModo");
    if (modo) modo.addEventListener("change", () => {
        if (chk) chk.checked = true;
        ultimaFirmaMapa = "";
        actualizarMapa();
    });
}

// En la base de Dengue-Admin, georeferencia_X trae la LATITUD (-6.4...) y
// georeferencia_Y la LONGITUD (-76.3...). Se detecta por el rango de valores,
// así funciona aunque algún registro venga con el orden al revés.
function coordenadas(fila) {
    const x = numero(fila.georeferencia_X);
    const y = numero(fila.georeferencia_Y);
    if (!x || !y) return null;

    const esLat = v => v > -20 && v < 2;
    const esLng = v => v > -82 && v < -68;

    if (esLat(x) && esLng(y)) return [x, y];
    if (esLat(y) && esLng(x)) return [y, x];
    return null;
}

function condicionMapa(fila) {
    if (cerrada(fila)) return "CERRADA";
    if (renuente(fila)) return "RENUENTE";
    if (deshabitada(fila)) return "DESHABITADA";
    if (inspeccionada(fila)) return viviendaPositiva(fila) ? "POSITIVA" : "INSPECCIONADA";
    return null;
}

const MAX_PUNTOS_MAPA = 40000;

function actualizarMapa() {
    if (!mapa) return;

    const chk = document.getElementById("mapaCalor");
    const modoCalor = !!(chk && chk.checked && typeof L.heatLayer === "function");
    const selModo = document.getElementById("mapaCalorModo");
    const tipoCalor = selModo ? selModo.value : "cobertura";

    const puntos = [];
    let sinGps = 0;
    for (const fila of datosFiltrados) {
        const cond = condicionMapa(fila);
        if (!cond) continue;
        const c = coordenadas(fila);
        if (!c) { sinGps++; continue; }
        puntos.push({ c, cond, fila });
    }

    // No redibujar si el resultado no cambió (actualizaciones automáticas).
    const firma = puntos.length + "|" + modoCalor + "|" + tipoCalor + "|" +
        (puntos[0] ? puntos[0].c.join() : "") + "|" +
        (puntos.length ? puntos[puntos.length - 1].c.join() : "");
    if (firma === ultimaFirmaMapa) return;
    ultimaFirmaMapa = firma;

    capaMarcadores.clearLayers();
    if (capaCalor) { mapa.removeLayer(capaCalor); capaCalor = null; }
    marcadores = [];

    const dibujar = puntos.length > MAX_PUNTOS_MAPA
        ? puntos.filter((_, i) => i % Math.ceil(puntos.length / MAX_PUNTOS_MAPA) === 0)
        : puntos;

    let enCalor = 0;
    if (modoCalor) {
        // cobertura : todas las viviendas visitadas, peso 1 cada una.
        // positivas : solo viviendas con algun recipiente positivo, peso 1.
        // intensidad: solo positivas, peso = N° de recipientes positivos
        //             (5 o mas recipientes = color maximo).
        let datosCalor, opciones = { radius: 18, blur: 15, maxZoom: 17 };
        if (tipoCalor === "cobertura") {
            datosCalor = dibujar.map(p => p.c);
        } else {
            const positivas = dibujar.filter(p => p.cond === "POSITIVA");
            datosCalor = tipoCalor === "intensidad"
                ? positivas.map(p => [p.c[0], p.c[1], cantidadRecipientesPositivos(p.fila)])
                : positivas.map(p => p.c);
            opciones = { radius: 22, blur: 18, maxZoom: 17,
                max: tipoCalor === "intensidad" ? 5 : 1 };
        }
        enCalor = datosCalor.length;
        capaCalor = L.heatLayer(datosCalor, opciones).addTo(mapa);
    } else {
        dibujar.forEach(p => {
            const f = p.fila;
            const color = COLOR_CONDICION[p.cond];
            const m = L.circleMarker(p.c, {
                radius: 6, color: "#ffffff", weight: 1.5,
                fillColor: color, fillOpacity: 0.95
            }).bindPopup(() =>
                "<strong>" + p.cond + "</strong><br>" +
                "📍 " + texto(f.localidad_eess) + " · Sector " + texto(f.sector) +
                " · Mz " + texto(f.codigo_manzana) + "<br>" +
                "🏠 " + texto(f.direccion) + "<br>" +
                "👤 " + texto(f.nombre_inspector) + "<br>" +
                "📅 " + texto(f.fecha_creacion).slice(0, 10) +
                (p.cond === "POSITIVA" ? "<br>🦟 Recipientes positivos: " + cantidadRecipientesPositivos(f) : "")
            );
            marcadores.push(m);
        });
        if (capaMarcadores.addLayers) capaMarcadores.addLayers(marcadores);
        else marcadores.forEach(m => m.addTo(capaMarcadores));
    }

    // Acercar el mapa a lo filtrado, como en Dengue-Admin.
    if (dibujar.length) {
        const limites = L.latLngBounds(dibujar.map(p => p.c));
        mapa.fitBounds(limites.pad(0.05), { maxZoom: 17 });
    }

    const total = document.getElementById("mapaTotal");
    if (total) {
        total.textContent = "Se encontraron " + puntos.length.toLocaleString("es-PE") + " viviendas" +
            (sinGps ? " (" + sinGps.toLocaleString("es-PE") + " sin GPS)" : "") +
            (modoCalor && tipoCalor !== "cobertura"
                ? " · calor con " + enCalor.toLocaleString("es-PE") + " positivas" : "") +
            (dibujar.length < puntos.length ? " · mostrando una muestra; filtra por localidad para ver todas" : "");
    }
}

// ============================================================
// BUSCADOR DE INSPECTOR Y SUGERENCIAS
// ============================================================

function buscarInspector() {
    const input = document.getElementById("busquedaInspector");

    busquedaInspector = texto(input ? input.value : "").toLowerCase();
    actualizarDashboard();
}

function configurarBuscadorSugerencias() {
    const input = document.getElementById("busquedaInspector");
    const select = document.getElementById("filtroInspector");

    if (!input || !select || input.dataset.sugerenciasConfiguradas === "true") {
        return;
    }

    input.dataset.sugerenciasConfiguradas = "true";

    const sugerencias = document.createElement("div");
    sugerencias.id = "sugerenciasInspector";

    Object.assign(sugerencias.style, {
        position: "absolute",
        background: "#ffffff",
        border: "1px solid #cfdce3",
        borderRadius: "8px",
        left: "0",
        right: "0",
        top: "100%",
        maxHeight: "200px",
        overflowY: "auto",
        zIndex: "99999",
        display: "none",
        boxShadow: "0 4px 10px rgba(0,0,0,0.12)"
    });

    if (input.parentElement) {
        input.parentElement.style.position = "relative";
        input.parentElement.appendChild(sugerencias);
    }

    function ocultar() {
        sugerencias.innerHTML = "";
        sugerencias.style.display = "none";
    }

    function seleccionar(nombre) {
        const op = [...select.options].find(
            o => texto(o.value).toLowerCase() === nombre.toLowerCase()
        );

        if (!op) return;

        select.value = op.value;
        input.value = "";
        busquedaInspector = "";

        ocultar();
        actualizarDashboard();
    }

    function coincidencias(busqueda) {
        return valoresUnicos("nombre_inspector").filter(
            n => n.toLowerCase().includes(busqueda)
        );
    }

    input.addEventListener("input", function () {
        const busqueda = input.value.trim().toLowerCase();

        sugerencias.innerHTML = "";
        busquedaInspector = "";

        if (!busqueda) {
            ocultar();
            actualizarDashboard();
            return;
        }

        const resultados = coincidencias(busqueda);

        resultados.slice(0, 20).forEach(nombre => {
            const opcion = document.createElement("div");
            opcion.textContent = nombre;

            Object.assign(opcion.style, {
                padding: "9px 12px",
                cursor: "pointer",
                fontSize: "13px",
                color: "#16405a",
                background: "#ffffff"
            });

            opcion.addEventListener("mouseenter", () => {
                opcion.style.background = "#e8f7fa";
            });

            opcion.addEventListener("mouseleave", () => {
                opcion.style.background = "#ffffff";
            });

            opcion.addEventListener("click", () => seleccionar(nombre));
            sugerencias.appendChild(opcion);
        });

        sugerencias.style.display =
            resultados.length > 0 ? "block" : "none";

        actualizarDashboard();
    });

    input.addEventListener("keydown", function (evento) {
        if (evento.key !== "Enter") return;

        evento.preventDefault();

        const busqueda = input.value.trim().toLowerCase();
        if (!busqueda) return;

        const primero = coincidencias(busqueda)[0];
        if (primero) seleccionar(primero);
    });

    select.addEventListener("change", function () {
        input.value = "";
        busquedaInspector = "";
        ocultar();
    });

    document.addEventListener("click", function (evento) {
        if (evento.target !== input && !sugerencias.contains(evento.target)) {
            sugerencias.style.display = "none";
        }
    });
}

// ============================================================
// EXPORTACIÓN A EXCEL
// ============================================================

function configurarBotones() {
    const botonBuscar = document.getElementById("btnBuscarInspector");
    if (botonBuscar) botonBuscar.onclick = buscarInspector;

    const loc = document.getElementById("btnExcelLocalidad");
    if (loc) loc.onclick = descargarDetallesLocalidad;

    const insp = document.getElementById("btnExcelInspector");
    if (insp) insp.onclick = descargarViviendasInspector;

    const dir = document.getElementById("btnExcelDirecciones");
    if (dir) dir.onclick = descargarDirecciones;

    const pos = document.getElementById("btnExcelPositivos");
    if (pos) pos.onclick = descargarPositivos;

    const cons = document.getElementById("btnExcelConsolidado");
    if (cons) cons.onclick = descargarConsolidado;

    const rec = document.getElementById("btnExcelRecuperadas");
    if (rec) rec.onclick = descargarRecuperadas;
}

function obtenerDatosParaDescarga() {
    aplicarFiltros();
    return Array.isArray(datosFiltrados) ? [...datosFiltrados] : [];
}

function asegurarExcel(callback) {
    if (typeof XLSX !== "undefined") {
        callback();
        return;
    }

    const script = document.createElement("script");
    script.src =
        "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";

    script.onload = callback;
    script.onerror = () => alert("No se pudo cargar la herramienta de Excel.");

    document.head.appendChild(script);
}

function descargarExcelSeguro(datos, nombreArchivo) {
    if (!datos || datos.length === 0) {
        alert("No hay datos para descargar con los filtros actuales.");
        return;
    }

    asegurarExcel(function () {
        const hoja = XLSX.utils.json_to_sheet(datos);
        const libro = XLSX.utils.book_new();

        XLSX.utils.book_append_sheet(libro, hoja, "Datos");
        XLSX.writeFile(libro, nombreArchivo + ".xlsx");
    });
}

function descargarDetallesLocalidad() {
    const datosActuales = obtenerDatosParaDescarga();
    const resumen = {};

    datosActuales.forEach(fila => {
        const localidad = texto(fila.localidad_eess) || "Sin localidad";

        if (!resumen[localidad]) {
            resumen[localidad] = {
                "Localidad": localidad,
                "Total de registros": 0,
                "Inspeccionadas": 0,
                "Cerradas": 0,
                "Renuentes": 0,
                "Deshabitadas": 0,
                "Recuperadas": 0,
                "Viviendas positivas": 0,
                "Recipientes positivos": 0
            };
        }

        resumen[localidad]["Total de registros"]++;

        if (inspeccionada(fila)) resumen[localidad].Inspeccionadas++;
        if (cerrada(fila)) resumen[localidad].Cerradas++;
        if (renuente(fila)) resumen[localidad].Renuentes++;
        if (deshabitada(fila)) resumen[localidad].Deshabitadas++;
        if (viviendaPositiva(fila)) resumen[localidad]["Viviendas positivas"]++;
        resumen[localidad]["Recipientes positivos"] += cantidadRecipientesPositivos(fila);
    });

    recuperadasFiltradas.forEach(fila => {
        const localidad = texto(fila.localidad_eess) || "Sin localidad";

        if (!resumen[localidad]) {
            resumen[localidad] = {
                "Localidad": localidad,
                "Total de registros": 0,
                "Inspeccionadas": 0,
                "Cerradas": 0,
                "Renuentes": 0,
                "Deshabitadas": 0,
                "Recuperadas": 0,
                "Viviendas positivas": 0,
                "Recipientes positivos": 0
            };
        }

        resumen[localidad].Recuperadas++;
    });

    descargarExcelSeguro(
        Object.values(resumen),
        "Detalles_por_localidad"
    );
}

function descargarViviendasInspector() {
    const resultado = obtenerDatosParaDescarga().map(fila => ({
        "Inspector": texto(fila.nombre_inspector),
        "Estado": estadoVivienda(fila),
        "Fecha de inspección": texto(fila.fecha_inspeccion),
        "Localidad": texto(fila.localidad_eess),
        "Sector": texto(fila.sector),
        "Código de manzana": texto(fila.codigo_manzana),
        "Dirección": texto(fila.direccion),
        "Tipo de inspección": texto(fila.tipoActividadInspeccion),
        "Persona que atiende": texto(fila.persona_atiende),
        "Número de residentes": texto(fila.numero_residentes),
        "Hora de ingreso": texto(fila.hora_ingreso),
        "Hora de salida": texto(fila.hora_salida),
        ...camposPositivosParaDescarga(fila)
    }));

    descargarExcelSeguro(resultado, "Viviendas_por_inspector");
}

// ============================================================
// VIVIENDAS RECUPERADAS (mismo formato que Dengue-Admin + datos extra)
// ============================================================

function descargarRecuperadas() {
    aplicarFiltros();

    const ESTADOS = { "1": "Inspeccionada", "2": "Cerrada", "3": "Renuente", "4": "Deshabitada" };
    const soloFecha = v => texto(v).substring(0, 10);

    const filas = [...recuperadasFiltradas].sort((a, b) =>
        soloFecha(b.recuperacion_fecha_asignacion).localeCompare(soloFecha(a.recuperacion_fecha_asignacion)) ||
        texto(a.recuperacion_fecha).localeCompare(texto(b.recuperacion_fecha))
    );

    const resultado = filas.map((fila, i) => ({
        "#": i + 1,
        "Fecha Creación": soloFecha(fila.fecha_creacion) || soloFecha(fila.fecha_inspeccion),
        "Fecha Asignación": soloFecha(fila.recuperacion_fecha_asignacion),
        "Dirección": texto(fila.direccion),
        "Código Manzana": texto(fila.codigo_manzana),
        "Estado Vivienda": ESTADOS[texto(fila.atencion_vivienda_indicador)] || texto(fila.atencion_vivienda_indicador),
        "Recuperación": "Recuperada",
        "Referencia": texto(fila.referencia),
        "Establecimiento": texto(fila.localidad_eess),
        "Sector": texto(fila.sector),
        // Columnas adicionales
        "Fecha Recuperación": texto(fila.recuperacion_fecha).substring(0, 16),
        "Inspector que recuperó": inspectorRecuperacion(fila),
        "DNI inspector": texto(fila.recuperacion_usuario_asignado),
        "Inspector inicial": texto(fila.nombre_inspector),
        "Fecha inspección inicial": soloFecha(fila.fecha_inspeccion)
    }));

    if (resultado.length === 0) {
        alert("No hay viviendas recuperadas con los filtros actuales.");
        return;
    }

    const inspector = valorFiltro("filtroInspector", "Todos");
    const nombreArchivo = "Viviendas_recuperadas" +
        (inspector !== "Todos" ? "_" + inspector.replace(/\s+/g, "_") : "") +
        "_" + fechaLocalISO(new Date());

    asegurarExcel(function () {
        const hoja = XLSX.utils.json_to_sheet(resultado);
        hoja["!cols"] = [5, 14, 14, 34, 10, 14, 12, 26, 22, 7, 17, 32, 12, 32, 14].map(w => ({ wch: w }));
        const libro = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(libro, hoja, "Viviendas");
        XLSX.writeFile(libro, nombreArchivo + ".xlsx");
    });
}

function descargarDirecciones() {
    const resultado = obtenerDatosParaDescarga().map(fila => ({
        "Estado": estadoVivienda(fila),
        "Localidad": texto(fila.localidad_eess),
        "Dirección": texto(fila.direccion),
        "Código de manzana": texto(fila.codigo_manzana),
        "Inspector": texto(fila.nombre_inspector),
        "Fecha de inspección": texto(fila.fecha_inspeccion),
        "Tipo de inspección": texto(fila.tipoActividadInspeccion),
        "Sector": texto(fila.sector),
        "Persona que atiende": texto(fila.persona_atiende),
        "Número de residentes": texto(fila.numero_residentes),
        "Hora de ingreso": texto(fila.hora_ingreso),
        "Hora de salida": texto(fila.hora_salida),
        ...camposPositivosParaDescarga(fila)
    }));

    descargarExcelSeguro(resultado, "Direcciones_filtradas");
}

// Código de tipo de criadero para el reporte de positivos
const CODIGOS_CRIADERO_POSITIVO = [
    ["tanque_alto_P", 1],
    ["tanque_bajo_P", 2],
    ["barril_cilindro_P", 3],
    ["sanson_bidon_P", 4],
    ["baldes_bateas_tinajas_P", 5],
    ["llantas_P", 6],
    ["floreros_maceteros_P", 7],
    ["latas_botellas_P", 8],
    ["inservibles_P", 9],
    ["otros_P", 10]
];

// ============================================================
// FORMATO DE LECTURA DE MUESTRAS (viviendas positivas)
// Una fila por cada recipiente positivo, con su código de criadero.
// ============================================================

function asegurarExcelJS(callback) {
    if (typeof ExcelJS !== "undefined") {
        callback();
        return;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
    script.onload = callback;
    script.onerror = () => alert("No se pudo cargar la herramienta de Excel.");
    document.head.appendChild(script);
}

function nombrePropio(valor) {
    return texto(valor)
        .toLowerCase()
        .replace(/(^|[\s\-\/(])([a-záéíóúñü])/g, (m, a, b) => a + b.toUpperCase());
}

function valorNumeroOTexto(valor) {
    const t = texto(valor);
    return /^\d+$/.test(t) ? Number(t) : t;
}

function fechaExcel(valor) {
    const m = texto(valor).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return texto(valor);
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function direccionJefeFamilia(fila) {
    // Mismo formato del registro: "DIRECCION / /JEFE DE FAMILIA"
    const familia = texto(fila.nombreFamilia) || "-";
    return texto(fila.direccion) + " / /" + familia;
}

// "SECTOR 3", "03" o "3" -> 3 (sin numero: se deja el texto y va al final).
function numeroSector(valor) {
    const m = texto(valor).match(/\d+/);
    return m ? Number(m[0]) : Number.MAX_SAFE_INTEGER;
}

function sectorParaFormato(valor) {
    const n = numeroSector(valor);
    return n === Number.MAX_SAFE_INTEGER ? texto(valor) : n;
}

function compararTexto(a, b) {
    return a < b ? -1 : (a > b ? 1 : 0);
}

function tituloLocalidad(valor) {
    return nombrePropio(valor).replace(/ (De|Del|La|Las|Los|Y) /g, m => m.toLowerCase());
}

function filasLecturaMuestras() {
    const filas = [];
    const casaDeFila = []; // a que vivienda pertenece cada fila (para colorear)

    // Orden: localidad > sector > inspector > fecha > manzana > direccion.
    obtenerDatosParaDescarga()
        .filter(viviendaPositiva)
        .sort((a, b) =>
            compararTexto(texto(a.localidad_eess), texto(b.localidad_eess)) ||
            (numeroSector(a.sector) - numeroSector(b.sector)) ||
            compararTexto(texto(a.nombre_inspector), texto(b.nombre_inspector)) ||
            compararTexto(texto(a.fecha_inspeccion).slice(0, 10), texto(b.fecha_inspeccion).slice(0, 10)) ||
            (numero(a.codigo_manzana) - numero(b.codigo_manzana)) ||
            compararTexto(texto(a.codigo_manzana), texto(b.codigo_manzana)) ||
            compararTexto(texto(a.direccion), texto(b.direccion))
        )
        .forEach((fila, indiceCasa) => {
            CODIGOS_CRIADERO_POSITIVO.forEach(([campo, codigo]) => {
                const cantidad = Math.floor(Math.max(0, numero(fila[campo])));
                for (let i = 0; i < cantidad; i++) {
                    casaDeFila.push(indiceCasa);
                    filas.push([
                        filas.length + 1,
                        nombrePropio(fila.distrito),
                        nombrePropio(fila.localidad_eess),
                        sectorParaFormato(fila.sector),
                        fechaExcel(fila.fecha_inspeccion),
                        valorNumeroOTexto(fila.codigo_manzana),
                        direccionJefeFamilia(fila),
                        texto(fila.nombre_inspector),
                        codigo,
                        "", "", "", "", ""
                    ]);
                }
            });
        });

    filas.casa = casaDeFila;
    return filas;
}

function descargarPositivos() {
    const filas = filasLecturaMuestras();

    if (filas.length === 0) {
        alert("No hay viviendas positivas con los filtros actuales.");
        return;
    }

    asegurarExcelJS(async function () {
        const libro = new ExcelJS.Workbook();
        const hoja = libro.addWorksheet("Lectura de muestras");

        hoja.columns = [
            { width: 6 }, { width: 14 }, { width: 22 }, { width: 9 },
            { width: 12 }, { width: 8 }, { width: 40 }, { width: 36 },
            { width: 7 }, { width: 5 }, { width: 5 }, { width: 5 },
            { width: 10 }, { width: 9 }
        ];

        const localidades = [...new Set(filas.map(f => f[2]).filter(Boolean))];
        const subtitulo = (localidades.length === 1 ? tituloLocalidad(localidades[0]) + " - " : "") +
            "Vigilancia Entomológicas";

        const borde = {
            top: { style: "thin" }, left: { style: "thin" },
            bottom: { style: "thin" }, right: { style: "thin" }
        };

        hoja.mergeCells("A1:N1");
        hoja.getCell("A1").value = "FORMATO DE LECTURA DE MUESTRAS";
        hoja.getCell("A1").font = { bold: true, size: 16 };
        hoja.getCell("A1").alignment = { horizontal: "center", vertical: "middle" };
        hoja.getRow(1).height = 24;

        hoja.mergeCells("A2:N2");
        hoja.getCell("A2").value = subtitulo;
        hoja.getCell("A2").alignment = { horizontal: "center", vertical: "middle" };

        const encabezados = [
            "N°", "DISTRITO", "LOCALIDAD", "SECTOR", "FECHA", "MZ.",
            "DIRECCION O NOMBRE DE JEFE DE FAMILIA", "NOMBRE DE INSPECTOR",
            "N° C", "L", "P", "A", "AEDES AEGYPTI", "OTROS"
        ];
        const filaEnc = hoja.getRow(3);
        filaEnc.values = encabezados;
        filaEnc.height = 45;
        filaEnc.eachCell(celda => {
            celda.font = { bold: true, size: 10 };
            celda.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
            celda.border = borde;
        });

        // Viviendas con 2 o mas criaderos: mismo color de fondo (columnas A-I),
        // rotando colores para que dos casas seguidas no se confundan.
        const COLORES_CASA = [
            "FFD9D9D9", "FFDDEBF7", "FFFCE4D6", "FFE2EFDA", "FFFFF2CC",
            "FFE4DFEC", "FFC6E0B4", "FFF8CBAD", "FFBDD7EE", "FFFFE699"
        ];
        const filasPorCasa = {};
        filas.casa.forEach(c => { filasPorCasa[c] = (filasPorCasa[c] || 0) + 1; });
        const colorDeCasa = {};
        let siguienteColor = 0;

        filas.forEach((valores, idx) => {
            const r = hoja.addRow(valores);
            const casa = filas.casa[idx];
            if (filasPorCasa[casa] > 1) {
                if (!(casa in colorDeCasa)) {
                    colorDeCasa[casa] = COLORES_CASA[siguienteColor % COLORES_CASA.length];
                    siguienteColor++;
                }
                for (let c = 1; c <= 9; c++) {
                    r.getCell(c).fill = {
                        type: "pattern", pattern: "solid",
                        fgColor: { argb: colorDeCasa[casa] }
                    };
                }
            }
            for (let c = 1; c <= 14; c++) {
                const celda = r.getCell(c);
                celda.border = borde;
                celda.font = { size: 10 };
                if (c !== 1 && c !== 7 && c !== 8) {
                    celda.alignment = { horizontal: "center" };
                }
            }
            r.getCell(5).numFmt = "d/mm/yyyy";
        });

        hoja.views = [{ state: "frozen", ySplit: 3 }];
        hoja.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
        hoja.pageSetup.printTitlesRow = "1:3";

        const buffer = await libro.xlsx.writeBuffer();
        const blob = new Blob([buffer], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        });
        const enlace = document.createElement("a");
        enlace.href = URL.createObjectURL(blob);
        enlace.download = "Formato_lectura_muestras.xlsx";
        document.body.appendChild(enlace);
        enlace.click();
        setTimeout(() => {
            URL.revokeObjectURL(enlace.href);
            enlace.remove();
        }, 1000);
    });
}

// ============================================================
// CORRECCIÓN: CERRADAS QUE LUEGO FUERON INSPECCIONADAS
// ============================================================

function claveVivienda(f) {
    const dir = texto(f.direccion).toLowerCase();
    const mz = texto(f.codigo_manzana);

    if (dir) return dir + "|" + mz;

    return "geo|" +
        texto(f.georeferencia_X) + "|" +
        texto(f.georeferencia_Y);
}

function quitarCerradasRevisitadas(filas) {
    const inspeccionadasSet = new Set(
        filas.filter(inspeccionada).map(claveVivienda)
    );

    return filas.filter(f => {
        if (!cerrada(f)) return true;
        return !inspeccionadasSet.has(claveVivienda(f));
    });
}

console.log("Dashboard Dengue cargado correctamente.");


// ============================================================
// CONSOLIDADO DE ENCUESTA (Vigilancia y control del Aedes aegypti)
// Respeta los filtros de la página. Una fila por localidad y sector.
// ============================================================

const RECIPIENTES_CONSOLIDADO = [
    { c: "C1", cap: "≥ 500 L", nombre: "Tanque alto", i: "tanque_alto_I", p: "tanque_alto_P" },
    { c: "C2", cap: "≥ 500 L", nombre: "Tanque bajo", i: "tanque_bajo_I", p: "tanque_bajo_P" },
    { c: "C3", cap: "= 200 L", nombre: "Barril, cilindro", i: "barril_cilindro_I", p: "barril_cilindro_P" },
    { c: "C4", cap: "< 200 L - 100 L", nombre: "Sansón, Bidón", i: "sanson_bidon_I", p: "sanson_bidon_P" },
    { c: "C5", cap: "< 100 L", nombre: "Baldes, bateas, tinajas", i: "baldes_bateas_tinajas_I", p: "baldes_bateas_tinajas_P" },
    { c: "C6", cap: "", nombre: "Llantas", i: "llantas_I", p: "llantas_P" },
    { c: "C7", cap: "", nombre: "Floreros, Maceteros", i: "floreros_maceteros_I", p: "floreros_maceteros_P" },
    { c: "C8", cap: "", nombre: "Latas, Botellas", i: "latas_botellas_I", p: "latas_botellas_P" },
    { c: "C9", cap: "", nombre: "Inservibles", i: "inservibles_I", p: "inservibles_P" },
    { c: "C10", cap: "", nombre: "Otros", i: "otros_I", p: "otros_P" }
];

// "SECTOR 1", "01", "SECTOR.1 ZONA.A" -> "1"
function sectorNormalizado(valor) {
    const m = texto(valor).match(/\d+/);
    return m ? String(Number(m[0])) : (texto(valor) || "-");
}

function porcentaje(a, b) {
    return b > 0 ? Math.round((a / b) * 10000) / 100 : 0;
}

// Grado de infestación según Índice Aédico (IA)
function gradoInfestacion(ia) {
    if (ia < 1) return "BAJO";
    if (ia < 2) return "MEDIO";
    return "ALTO";
}

function fechaCorta(iso) {
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? Number(m[3]) + "/" + m[2] + "/" + m[1] : String(iso);
}

function nuevoGrupoConsolidado() {
    return {
        total: 0, insp: 0, vivPos: 0, recInsp: 0, recPos: 0,
        fechas: new Set(), tipos: new Set(),
        porTipo: RECIPIENTES_CONSOLIDADO.map(() => ({ i: 0, p: 0 })),
        dep: "", prov: "", dist: "", loc: "", sector: ""
    };
}

function sumarAlGrupo(g, f) {
    g.total++;
    const fecha = texto(f.fecha_inspeccion).slice(0, 10);
    if (fecha) g.fechas.add(fecha);
    if (texto(f.tipoActividadInspeccion)) g.tipos.add(texto(f.tipoActividadInspeccion).toUpperCase());
    if (!inspeccionada(f)) return;

    g.insp++;
    let pos = 0;
    RECIPIENTES_CONSOLIDADO.forEach((r, k) => {
        const ni = Math.max(0, numero(f[r.i]));
        const np = Math.max(0, numero(f[r.p]));
        g.porTipo[k].i += ni;
        g.porTipo[k].p += np;
        g.recInsp += ni;
        g.recPos += np;
        pos += np;
    });
    if (pos > 0) g.vivPos++;
}

function datosConsolidado() {
    const grupos = {};
    const total = nuevoGrupoConsolidado();

    obtenerDatosParaDescarga().forEach(f => {
        const clave = [texto(f.distrito), texto(f.localidad_eess), sectorNormalizado(f.sector)].join("|");
        if (!grupos[clave]) {
            const g = nuevoGrupoConsolidado();
            g.dep = texto(f.departamento_x) || "SAN MARTIN";
            g.prov = texto(f.nombre_prov);
            g.dist = texto(f.distrito);
            g.loc = texto(f.localidad_eess);
            g.sector = sectorNormalizado(f.sector);
            grupos[clave] = g;
        }
        sumarAlGrupo(grupos[clave], f);
        sumarAlGrupo(total, f);
    });

    const lista = Object.values(grupos).sort((a, b) =>
        a.dist.localeCompare(b.dist) ||
        a.loc.localeCompare(b.loc) ||
        (numero(a.sector) - numero(b.sector)) ||
        a.sector.localeCompare(b.sector)
    );

    return { lista, total };
}

function rangoFechas(set) {
    const f = [...set].sort();
    if (f.length === 0) return "";
    return f.length === 1 ? fechaCorta(f[0]) : fechaCorta(f[0]) + " - " + fechaCorta(f[f.length - 1]);
}

function descargarConsolidado() {
    const { lista, total } = datosConsolidado();

    if (lista.length === 0 || total.insp === 0) {
        alert("No hay viviendas inspeccionadas con los filtros actuales.");
        return;
    }

    asegurarExcelJS(async function () {
        const libro = new ExcelJS.Workbook();
        const ws = libro.addWorksheet("Consolidado");

        const anchos = [15, 15, 15, 20, 8, 21];
        for (let i = 0; i < 22; i++) anchos.push(7.5);
        ws.columns = anchos.map(w => ({ width: w }));

        const borde = {
            top: { style: "thin" }, left: { style: "thin" },
            bottom: { style: "thin" }, right: { style: "thin" }
        };
        const AZUL = "FF9DC3E6", VERDE = "FFE2EFDA", DURAZNO = "FFFCE4D6", AMARILLO = "FFFFD966";
        const COLOR_GRADO = { BAJO: "FF92D050", MEDIO: "FFFFFF00", ALTO: "FFFF0000" };

        function celda(fila, col, valor, opc = {}) {
            const c = ws.getCell(fila, col);
            c.value = valor;
            c.border = borde;
            c.font = { size: 10, bold: !!opc.bold, color: opc.colorTexto ? { argb: opc.colorTexto } : undefined };
            c.alignment = {
                horizontal: opc.izq ? "left" : "center", vertical: "middle",
                wrapText: !!opc.wrap, textRotation: opc.rot || 0
            };
            if (opc.fondo) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: opc.fondo } };
            if (opc.fmt) c.numFmt = opc.fmt;
            return c;
        }

        function combinar(f1, c1, f2, c2, valor, opc) {
            for (let f = f1; f <= f2; f++)
                for (let c = c1; c <= c2; c++) celda(f, c, null, opc);
            if (f1 !== f2 || c1 !== c2) ws.mergeCells(f1, c1, f2, c2);
            celda(f1, c1, valor, opc);
        }

        // ---------------- Encabezado ----------------
        ws.mergeCells(1, 1, 1, 28);
        ws.getCell(1, 1).value = "FORMATO DE ENCUESTA DE MUESTRAS";
        ws.getCell(1, 1).font = { bold: true, size: 14 };
        ws.getCell(1, 1).alignment = { horizontal: "center" };

        const todas = [...total.fechas].sort();
        ws.getCell(3, 1).value = "FECHA DE INICIO :";
        ws.mergeCells(3, 2, 3, 3);
        ws.getCell(3, 2).value = fechaCorta(todas[0] || "");
        ws.getCell(3, 2).alignment = { horizontal: "center" };
        ws.getCell(3, 2).border = { bottom: { style: "thin" } };
        ws.mergeCells(3, 4, 3, 5);
        ws.getCell(3, 4).value = "FECHA DE TERMINO:";
        ws.getCell(3, 4).alignment = { horizontal: "right" };
        ws.getCell(3, 6).value = fechaCorta(todas[todas.length - 1] || "");
        ws.getCell(3, 6).alignment = { horizontal: "center" };
        ws.getCell(3, 6).border = { bottom: { style: "thin" } };

        // ---------------- Tabla 1 ----------------
        let r = 5;
        ws.getCell(r, 1).value = "VIGILANCIA Y CONTROL DEL AEDES AEGYPTI";
        ws.getCell(r, 1).font = { bold: true, size: 11 };

        r = 7;
        const enc1 = ["Departamento", "Provincia", "Distrito", "Localidad", "Zona", "Fecha de Trabajo"];
        enc1.forEach((t, k) => celda(r, k + 1, t, { bold: true, wrap: true, fondo: AZUL }));
        const enc1b = ["Fecha de recepción", "N° viv. insp.", "Muestras recibidas", "N° viv. posit.",
            "N° recip. insp.", "N° recip. posit.", "IA", "IR", "IB", "Grado de infestación", "Tipo de Intervención"];
        enc1b.forEach((t, k) => combinar(r, 7 + k * 2, r, 8 + k * 2, t, { bold: true, wrap: true, fondo: AZUL }));
        ws.getRow(r).height = 32;

        function filaTabla1(fila, g, esTotal) {
            const ia = porcentaje(g.vivPos, g.insp);
            const ir = porcentaje(g.recPos, g.recInsp);
            const ib = porcentaje(g.recPos, g.insp);
            const grado = gradoInfestacion(ia);
            const b = { bold: esTotal };

            if (esTotal) {
                for (let c = 1; c <= 6; c++) celda(fila, c, null);
                combinar(fila, 7, fila, 8, "TOTAL", { bold: true });
            } else {
                celda(fila, 1, g.dep, { izq: true });
                celda(fila, 2, g.prov, { izq: true });
                celda(fila, 3, g.dist, { izq: true });
                celda(fila, 4, g.loc, { izq: true });
                celda(fila, 5, valorNumeroOTexto(g.sector));
                celda(fila, 6, rangoFechas(g.fechas));
                combinar(fila, 7, fila, 8, null);
            }
            const vals = [g.insp, g.recPos, g.vivPos, g.recInsp, g.recPos];
            vals.forEach((v, k) => combinar(fila, 9 + k * 2, fila, 10 + k * 2, v, b));
            combinar(fila, 19, fila, 20, ia, { ...b, fmt: "0.00" });
            combinar(fila, 21, fila, 22, ir, { ...b, fmt: "0.00" });
            combinar(fila, 23, fila, 24, ib, { ...b, fmt: "0.00" });
            combinar(fila, 25, fila, 26, grado, {
                bold: true, fondo: COLOR_GRADO[grado],
                colorTexto: grado === "ALTO" ? "FFFFFFFF" : undefined
            });
            combinar(fila, 27, fila, 28, [...g.tipos].join(" / "), { bold: true });
        }

        lista.forEach(g => { r++; filaTabla1(r, g, false); });
        r++; filaTabla1(r, total, true);

        // ---------------- Tabla 2 ----------------
        r += 2;
        ws.getCell(r, 1).value = "RECIPIENTES PREFERIDOS PARA LA CRIA DE AEDES AEGYPTI";
        ws.getCell(r, 1).font = { bold: true, size: 11 };

        const h1 = r + 2, h2 = h1 + 1, h3 = h1 + 2, h4 = h1 + 3;
        combinar(h1, 1, h4, 1, "ZONA SECTOR", { bold: true, wrap: true, fondo: AZUL });
        combinar(h1, 2, h1, 6, "VIVIENDAS", { bold: true, fondo: AZUL });
        ["TOTAL", "PROGRAMADAS", "INSPECCIONADAS", "POSITIVAS", "IA"].forEach((t, k) =>
            combinar(h2, 2 + k, h4, 2 + k, t, { bold: true, fondo: AZUL, rot: 90 }));

        RECIPIENTES_CONSOLIDADO.forEach((rc, k) => {
            const c = 7 + k * 2;
            combinar(h1, c, h1, c + 1, rc.c, { bold: true, fondo: VERDE });
            if (rc.cap) {
                combinar(h2, c, h2, c + 1, rc.cap, { bold: true, fondo: VERDE, wrap: true });
                combinar(h3, c, h3, c + 1, rc.nombre, { bold: true, fondo: VERDE, wrap: true });
            } else {
                combinar(h2, c, h3, c + 1, rc.nombre, { bold: true, fondo: VERDE, wrap: true });
            }
            celda(h4, c, "I", { bold: true, fondo: VERDE });
            celda(h4, c + 1, "P", { bold: true, fondo: VERDE });
        });
        combinar(h1, 27, h3, 28, "TOTAL", { bold: true, fondo: DURAZNO });
        celda(h4, 27, "I", { bold: true, fondo: DURAZNO });
        celda(h4, 28, "P", { bold: true, fondo: DURAZNO });
        ws.getRow(h2).height = 30;
        ws.getRow(h3).height = 42;
        ws.getRow(h4).height = 16;

        const variasLocalidades = new Set(lista.map(g => g.loc)).size > 1;

        function filaTabla2(fila, g, etiqueta, esTotal) {
            const b = { bold: esTotal };
            celda(fila, 1, etiqueta, { bold: true, fondo: esTotal ? DURAZNO : undefined, izq: esTotal });
            celda(fila, 2, g.total, { bold: true });
            celda(fila, 3, null);
            celda(fila, 4, g.insp, b);
            celda(fila, 5, g.vivPos, { bold: true });
            celda(fila, 6, porcentaje(g.vivPos, g.insp), { ...b, fmt: "0.0" });
            g.porTipo.forEach((t, k) => {
                celda(fila, 7 + k * 2, t.i, b);
                celda(fila, 8 + k * 2, t.p, b);
            });
            celda(fila, 27, g.recInsp, { bold: true });
            celda(fila, 28, g.recPos, { bold: true });
        }

        r = h4;
        lista.forEach(g => {
            r++;
            const etiqueta = variasLocalidades ? g.loc + " - " + g.sector : valorNumeroOTexto(g.sector);
            filaTabla2(r, g, etiqueta, false);
        });
        r++; filaTabla2(r, total, "TOTAL", true);

        // Índice de recipientes por tipo
        r++;
        combinar(r, 1, r, 6, "Indice de recipientes (IR)", {
            bold: true, fondo: AMARILLO, izq: true
        });
        ws.getCell(r, 1).font = { bold: true, size: 13 };
        total.porTipo.forEach((t, k) =>
            combinar(r, 7 + k * 2, r, 8 + k * 2, porcentaje(t.p, t.i), { bold: true, fmt: "0.00" }));
        celda(r, 27, null);
        celda(r, 28, porcentaje(total.recPos, total.recInsp), { bold: true, fmt: "0.00" });
        ws.getRow(r).height = 26;

        // Pie
        r += 3;
        ws.getCell(r, 1).value = "INFORME:";
        ws.mergeCells(r, 2, r, 8);
        ws.getCell(r, 2).border = { bottom: { style: "thin" } };
        r += 2;
        ws.getCell(r, 1).value = "IA = viv. positivas / viv. inspeccionadas x 100   |   IR = recip. positivos / recip. inspeccionados x 100   |   IB = recip. positivos / viv. inspeccionadas x 100";
        ws.getCell(r, 1).font = { italic: true, size: 9, color: { argb: "FF666666" } };
        r++;
        ws.getCell(r, 1).value = "Grado de infestación según IA: BAJO < 1%   |   MEDIO 1% a < 2%   |   ALTO ≥ 2%";
        ws.getCell(r, 1).font = { italic: true, size: 9, color: { argb: "FF666666" } };

        ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

        const buffer = await libro.xlsx.writeBuffer();
        const blob = new Blob([buffer], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        });
        const enlace = document.createElement("a");
        enlace.href = URL.createObjectURL(blob);
        enlace.download = "Consolidado_encuesta_aedica.xlsx";
        document.body.appendChild(enlace);
        enlace.click();
        setTimeout(() => {
            URL.revokeObjectURL(enlace.href);
            enlace.remove();
        }, 1000);
    });
}
