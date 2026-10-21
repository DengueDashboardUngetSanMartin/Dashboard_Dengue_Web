// ============================================================
// DASHBOARD DE INSPECCIONES Y CONTROL DE DENGUE
// CONEXIÓN REAL: datos.csv
// RANGO DE FECHAS + ACTUALIZACIÓN AUTOMÁTICA
// ============================================================

let datosOriginales = [];
let datosFiltrados = [];
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
    return await resp2.text();
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

function recuperada(f) {
    return texto(f.recuperacion_vivienda_indicador_ini) !== "";
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

function actualizarFecha() {
    const ahora = new Date();

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

    fijarTextoFecha(fechaTexto, "Actualizado: " + horaTexto);
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

function aplicarFiltros() {
    const localidad = valorFiltro("filtroLocalidad", "Todas");
    const mes = valorFiltro("filtroMes", "Todos");
    const inspector = valorFiltro("filtroInspector", "Todos");
    const sector = valorFiltro("filtroSector", "Todos");
    const tipo = valorFiltro("filtroTipo", "Todos");
    const manzana = valorFiltro("filtroManzana", "Todas");

    const fechaInicio = valorFiltro("fechaInicio", "");
    const fechaFin = valorFiltro("fechaFin", "");

    const filasFiltradas = datosOriginales.filter(fila => {
        if (
            localidad !== "Todas" &&
            texto(fila.localidad_eess) !== localidad
        ) return false;

        if (
            inspector !== "Todos" &&
            texto(fila.nombre_inspector) !== inspector
        ) return false;

        if (
            sector !== "Todos" &&
            texto(fila.sector) !== sector
        ) return false;

        if (
            tipo !== "Todos" &&
            texto(fila.tipoActividadInspeccion) !== tipo
        ) return false;

        if (
            manzana !== "Todas" &&
            texto(fila.codigo_manzana) !== manzana
        ) return false;

        const fecha = obtenerFecha(fila.fecha_inspeccion);

        if (mes !== "Todos") {
            if (!fecha || MESES[fecha.getMonth()] !== mes) {
                return false;
            }
        }

        // Comparar fechas como YYYY-MM-DD para incluir ambos días completos.
        if (fechaInicio || fechaFin) {
            if (!fecha) return false;

            const claveFecha = fechaLocalISO(fecha);

            if (fechaInicio && claveFecha < fechaInicio) return false;
            if (fechaFin && claveFecha > fechaFin) return false;
        }

        if (busquedaInspector !== "") {
            if (
                !texto(fila.nombre_inspector)
                    .toLowerCase()
                    .includes(busquedaInspector)
            ) return false;
        }

        return true;
    });

// Igual que Dengue-Admin: se cuentan todos los registros, incluidas las cerradas revisitadas.
datosFiltrados = filasFiltradas;
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
    seguro("inspector", actualizarInspector);
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
        fmt(datosFiltrados.filter(recuperada).length));

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
        datosFiltrados.filter(recuperada).length
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
            const fecha = obtenerFecha(fila.fecha_inspeccion);
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
        if (recuperada(fila)) localidades[loc].recuperadas++;
        if (viviendaPositiva(fila)) localidades[loc].positivas++;
        localidades[loc].recipientesPositivos += cantidadRecipientesPositivos(fila);
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
        if (recuperada(fila)) resumen[localidad].Recuperadas++;
        if (viviendaPositiva(fila)) resumen[localidad]["Viviendas positivas"]++;
        resumen[localidad]["Recipientes positivos"] += cantidadRecipientesPositivos(fila);
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

function descargarPositivos() {
    const resultado = obtenerDatosParaDescarga()
        .filter(viviendaPositiva)
        .map(fila => ({
            "Fecha de inspección": texto(fila.fecha_inspeccion),
            "Localidad": texto(fila.localidad_eess),
            "Sector": texto(fila.sector),
            "Código de manzana": texto(fila.codigo_manzana),
            "Dirección": texto(fila.direccion),
            "Inspector": texto(fila.nombre_inspector),
            "Recipientes positivos": cantidadRecipientesPositivos(fila)
        }));

    descargarExcelSeguro(resultado, "Viviendas_y_recipientes_positivos");
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
