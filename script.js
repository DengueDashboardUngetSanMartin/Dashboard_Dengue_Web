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
    const version = "?v=" + Date.now();

    if (typeof DecompressionStream !== "undefined") {
        const urlGz = new URL(ARCHIVO_CSV, window.location.href).href + version;
        const resp = await fetch(urlGz, { cache: "no-store" });

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
    const urlCsv = new URL(ARCHIVO_CSV_RESPALDO, window.location.href).href + version;
    const resp2 = await fetch(urlCsv, { cache: "no-store" });
    if (!resp2.ok) throw new Error("No se encontró datos.csv.gz ni datos.csv");
    guardarFechaArchivo(resp2);
    return await resp2.text();
}

function guardarFechaArchivo(resp) {
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

            datosOriginales = registros;
            mapaDniInspector = null;
            ultimaCargaCSV = Date.now();

            console.log("CSV cargado:", datosOriginales.length, "registros");
            console.log("Columnas:", Object.keys(datosOriginales[0]));

            // Actualiza los filtros conservando las selecciones existentes.
            inicializarFiltros();

            seguro("actualizarFecha", actualizarFecha);
            seguro("inicializarMapa", inicializarMapa);
            seguro("actualizarDashboard", actualizarDashboard);
        }
    });
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
    datosOriginales = (datos || []).filter(
        fila => fila && Object.keys(fila).length > 1
    );

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

function inspectorRecuperacion(f) {
    if (!mapaDniInspector) construirMapaDni();
    const dni = texto(f.recuperacion_usuario_asignado);
    return mapaDniInspector[dni] || texto(f.nombre_inspector);
}

// Fecha de cada vivienda: Dengue-Admin filtra por la hora en que se
// registró la vivienda (fecha_creacion), no por el inicio de la jornada
// (fecha_inspeccion). Si falta fecha_creacion se usa fecha_inspeccion.
function fechaVivienda(f) {
    return obtenerFecha(f.fecha_creacion) || obtenerFecha(f.fecha_inspeccion);
}

function fechaRecuperacion(f) {
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


function inicializarFiltros() {
    llenarSelect("filtroLocalidad", valoresUnicos("localidad_eess"), "Todas");
    llenarSelect("filtroInspector", valoresUnicos("nombre_inspector"), "Todos");
    llenarSelect("filtroSector", valoresUnicos("sector"), "Todos");
    llenarSelect("filtroTipo", valoresUnicos("tipoActividadInspeccion"), "Todos");
    llenarSelect("filtroManzana", valoresUnicos("codigo_manzana"), "Todas");
    llenarSelect("filtroMes", MESES, "Todos");

    // Dejar las fechas vacías al iniciar el dashboard.
    const fechaInicio = document.getElementById("fechaInicio");
    const fechaFin = document.getElementById("fechaFin");

    if (fechaInicio) fechaInicio.value = "";
    if (fechaFin) fechaFin.value = "";

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
        texto(fila.sector) !== F.sector) return false;

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
// COBERTURA
// ============================================================

function actualizarCobertura() {
    const inspeccionadasTotal =
        datosFiltrados.filter(inspeccionada).length;

    const viviendasBase = new Set(
        datosFiltrados.map(f => texto(f._uid)).filter(Boolean)
    ).size;

    const porcentaje = viviendasBase > 0
        ? Number(Math.min(
            100,
            (inspeccionadasTotal / viviendasBase) * 100
        ).toFixed(1))
        : 0;

    setTexto("coveragePercent", porcentaje + "%");
    setTexto("coverageInspeccionadas", fmt(inspeccionadasTotal));
    setTexto("coverageTotal", fmt(viviendasBase));

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

function agruparInspeccionadas(campo, vacio) {
    const grupos = {};

    datosFiltrados.filter(inspeccionada).forEach(fila => {
        const clave = texto(fila[campo]) || vacio;
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
    const camposCriaderos = {
        "Tanque alto": ["tanque_alto_I", "tanque_alto_P", "tanque_alto_TQ", "tanque_alto_TF"],
        "Tanque bajo": ["tanque_bajo_I", "tanque_bajo_P", "tanque_bajo_TQ", "tanque_bajo_TF"],
        "Barril": ["barril_cilindro_I", "barril_cilindro_P", "barril_cilindro_TQ", "barril_cilindro_TF"],
        "Sanson / Bidón": ["sanson_bidon_I", "sanson_bidon_P", "sanson_bidon_TQ", "sanson_bidon_TF"],
        "Baldes": ["baldes_bateas_tinajas_I", "baldes_bateas_tinajas_P", "baldes_bateas_tinajas_TQ", "baldes_bateas_tinajas_TF"],
        "Llantas": ["llantas_I", "llantas_P", "llantas_TQ", "llantas_TF"],
        "Floreros": ["floreros_maceteros_I", "floreros_maceteros_P", "floreros_maceteros_TQ", "floreros_maceteros_TF"],
        "Latas": ["latas_botellas_I", "latas_botellas_P", "latas_botellas_TQ", "latas_botellas_TF"],
        "Otros": ["otros_I", "otros_P", "otros_TQ", "otros_TF", "otros_D"],
        "Inservibles": ["inservibles_I", "inservibles_P", "inservibles_TQ", "inservibles_TF"]
    };

    const ranking = Object.keys(camposCriaderos)
        .map(nombre => {
            let total = 0;

            datosFiltrados.forEach(fila => {
                camposCriaderos[nombre].forEach(campo => {
                    total += numero(fila[campo]);
                });
            });

            return { nombre, total };
        })
        .sort((a, b) => b.total - a.total)
        .slice(0, 10);

    crearGrafico("rankingChart", {
        type: "bar",
        data: {
            labels: ranking.map(x => x.nombre),
            datasets: [{
                label: "Total",
                data: ranking.map(x => x.total),
                backgroundColor: [
                    "#ed4149", "#168fe0", "#38a947", "#f1ad18", "#7438a4",
                    "#e85aa5", "#7c8790", "#55aee8", "#1598aa", "#7bcfd8"
                ],
                borderRadius: 5,
                borderSkipped: false
            }]
        },
        options: {
            indexAxis: "y",
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: c => " Total: " + fmt(c.raw)
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
    const valores = MESES.map((_, indice) =>
        datosFiltrados.filter(fila => {
            const fecha = fechaVivienda(fila);
            return inspeccionada(fila) && fecha &&
                fecha.getMonth() === indice;
        }).length
    );

    graficoBarras(
        "monthlyChart", MESES, valores,
        "Viviendas inspeccionadas", "#75bce7", false
    );
}

function actualizarSector() {
    const o = agruparInspeccionadas("sector", "Sin sector");

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

function inicializarMapa() {
    const elemento = document.getElementById("map");

    if (!elemento || typeof L === "undefined" || mapa) return;

    mapa = L.map("map").setView([-6.4869, -76.3625], 11);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap"
    }).addTo(mapa);
}

function actualizarMapa() {
    if (!mapa) return;

    marcadores.forEach(m => mapa.removeLayer(m));
    marcadores = [];

    let contador = 0;

    datosFiltrados.filter(inspeccionada).forEach(fila => {
        if (contador >= 1500) return;

        const lat = numero(fila.georeferencia_Y);
        const lng = numero(fila.georeferencia_X);

        if (!lat || !lng) return;
        if (lat < -20 || lat > 5 || lng < -85 || lng > -65) return;

        const marcador = L.circleMarker([lat, lng], {
            radius: 4,
            color: "#078ca5",
            fillColor: "#269bb0",
            fillOpacity: 0.55,
            weight: 1
        }).bindPopup(
            "<strong>Vivienda inspeccionada</strong><br>" +
            "📍 " + texto(fila.localidad_eess) + "<br>" +
            "🏠 " + texto(fila.direccion) + "<br>" +
            "👤 " + texto(fila.nombre_inspector)
        ).addTo(mapa);

        marcadores.push(marcador);
        contador++;
    });
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

function filasLecturaMuestras() {
    const filas = [];

    obtenerDatosParaDescarga()
        .filter(viviendaPositiva)
        .sort((a, b) =>
            texto(a.fecha_inspeccion).slice(0, 10).localeCompare(texto(b.fecha_inspeccion).slice(0, 10)) ||
            texto(a.localidad_eess).localeCompare(texto(b.localidad_eess)) ||
            (numero(a.sector) - numero(b.sector)) ||
            (numero(a.codigo_manzana) - numero(b.codigo_manzana)) ||
            texto(a.direccion).localeCompare(texto(b.direccion))
        )
        .forEach(fila => {
            CODIGOS_CRIADERO_POSITIVO.forEach(([campo, codigo]) => {
                const cantidad = Math.floor(Math.max(0, numero(fila[campo])));
                for (let i = 0; i < cantidad; i++) {
                    filas.push([
                        filas.length + 1,
                        nombrePropio(fila.distrito),
                        nombrePropio(fila.localidad_eess),
                        valorNumeroOTexto(fila.sector),
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
            { width: 12 }, { width: 8 }, { width: 58 }, { width: 36 },
            { width: 7 }, { width: 5 }, { width: 5 }, { width: 5 },
            { width: 10 }, { width: 9 }
        ];

        const distritos = [...new Set(filas.map(f => f[1]).filter(Boolean))];
        const subtitulo = (distritos.length === 1 ? distritos[0] + " - " : "") +
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

        filas.forEach(valores => {
            const r = hoja.addRow(valores);
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
