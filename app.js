// Configuración de conexión a Supabase / PostGIS
const SUPABASE_URL = 'https://pkhgazqjosvsbohsphkb.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBraGdhenFqb3N2c2JvaHNwaGtiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ5NjI0NTgsImV4cCI6MjExMDUzODQ1OH0.Uo_8toxOgPaVszekVEaut-TQsFtZDTZCuWHlwDVqhGI';

// Definición de capas con paleta azul y contrastes cartográficos claros
const CAPAS_DB = [
    { tabla: 'barrios', nombre: 'Barrios', tipo: 'poligono', color: '#1e40af' },
    { tabla: 'agua_potable', nombre: 'Red Agua Potable', tipo: 'poligono', color: '#0284c7' },
    { tabla: 'alcantarillado', nombre: 'Alcantarillado', tipo: 'linea', color: '#0369a1' },
    { tabla: 'bomberos_wgs84', nombre: 'Estaciones Bomberos', tipo: 'punto', color: '#dc2626' },
    { tabla: 'policia_wgs84', nombre: 'Unidades Policía', tipo: 'punto', color: '#1d4ed8' },
    { tabla: 'salud_wgs84', nombre: 'Centros de Salud', tipo: 'punto', color: '#059669' }
];

let supabaseClient = null;
let mapa = null;
let mapasBase = {};
let capasLeaflet = {};
let listaBarrios = [];
let barrioResaltado = null;
let marcadorClick = null;

// Inicialización general
document.addEventListener('DOMContentLoaded', () => {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    iniciarUI();
    iniciarMapa();
    cargarGeoportal();
    configurarBuscador();
});

// ==================== INTERFAZ Y NAVEGACIÓN ====================
function iniciarUI() {
    // Pestañas del panel lateral
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            
            btn.classList.add('active');
            document.getElementById(btn.dataset.tab).classList.add('active');
        });
    });

    // Cambio de mapa base
    document.querySelectorAll('input[name="basemap"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            Object.values(mapasBase).forEach(layer => mapa.removeLayer(layer));
            mapasBase[e.target.value].addTo(mapa);
        });
    });

    // Botón GPS y Formulario
    document.getElementById('btnGPS').addEventListener('click', obtenerUbicacionGPS);
    document.getElementById('formReporte').addEventListener('submit', enviarReporte);

    // Responsive móvil
    const sidebar = document.getElementById('sidebar');
    document.getElementById('btnToggleSidebar').addEventListener('click', () => sidebar.classList.add('closed'));
    document.getElementById('btnAbrirSidebar').addEventListener('click', () => sidebar.classList.remove('closed'));
}

function actualizarEstado(mensaje, tipo = 'loading') {
    const estadoEl = document.getElementById('estado');
    const dotEl = document.getElementById('statusDot');
    estadoEl.textContent = mensaje;
    
    dotEl.className = 'status-dot';
    if (tipo === 'ready') dotEl.classList.add('ready');
    if (tipo === 'error') dotEl.classList.add('error');
}

// ==================== MAPA LEAFLET ====================
function iniciarMapa() {
    mapa = L.map('mapa', { zoomControl: true }).setView([-1.83, -78.18], 7);

    mapasBase.claro = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap &copy; CARTO',
        maxZoom: 19
    }).addTo(mapa);

    mapasBase.esri = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri',
        maxZoom: 19
    });

    mapasBase.satelite = L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
        attribution: '&copy; Google',
        maxZoom: 20
    });

    mapa.on('click', (e) => {
        capturarCoordenadasEnFormulario(e.latlng);
        consultarDistancias(e.latlng);
    });
}

function capturarCoordenadasEnFormulario(latlng) {
    document.getElementById('repLat').value = latlng.lat.toFixed(6);
    document.getElementById('repLong').value = latlng.lng.toFixed(6);

    if (marcadorClick) mapa.removeLayer(marcadorClick);
    marcadorClick = L.circleMarker(latlng, {
        radius: 6,
        color: '#1d4ed8',
        fillColor: '#60a5fa',
        fillOpacity: 0.9,
        weight: 2
    }).addTo(mapa);
}

// ==================== CARGA DE DATOS POSTGIS ====================
async function obtenerTodosLosRegistros(tabla, maxRegistros = 4000) {
    let todos = [];
    const paso = 1000;
    for (let inicio = 0; inicio < maxRegistros; inicio += paso) {
        const { data, error } = await supabaseClient
            .from(tabla)
            .select('*')
            .range(inicio, inicio + paso - 1);

        if (error) throw error;
        if (!data || data.length === 0) break;

        todos = todos.concat(data);
        if (data.length < paso) break;
    }
    return todos;
}

function parsearGeometria(geomRaw) {
    if (!geomRaw) return null;
    try {
        if (typeof geomRaw === 'object' && geomRaw.type) return geomRaw;
        if (typeof geomRaw === 'string' && geomRaw.trim().startsWith('{')) return JSON.parse(geomRaw);
        if (typeof geomRaw === 'string') {
            const wktLimpio = geomRaw.replace(/^SRID=\d+;/i, '');
            const wkt = new Wkt.Wkt();
            wkt.read(wktLimpio);
            return wkt.toJson();
        }
    } catch (e) {
        console.warn('Error parseando geometría:', e);
    }
    return null;
}

function registrarItemEnPanelCapas(idCapa, nombre, tipo, color, cantidad) {
    const contenedor = document.getElementById('contenedorCapas');
    let itemExistente = document.getElementById(`control-capa-${idCapa}`);
    
    if (itemExistente) {
        itemExistente.querySelector('.layer-count').textContent = cantidad;
        return;
    }

    const label = document.createElement('label');
    label.className = 'layer-item';
    label.id = `control-capa-${idCapa}`;
    label.innerHTML = `
        <div class="layer-info">
            <input type="checkbox" checked data-capa="${idCapa}">
            <span class="layer-swatch ${tipo}" style="background-color: ${color};"></span>
            <span class="layer-name">${nombre}</span>
        </div>
        <span class="layer-count">${cantidad}</span>
    `;

    label.querySelector('input').addEventListener('change', (e) => {
        const capa = capasLeaflet[idCapa];
        if (!capa) return;
        if (e.target.checked) {
            mapa.addLayer(capa);
        } else {
            mapa.removeLayer(capa);
        }
    });

    contenedor.appendChild(label);
}

async function cargarGeoportal() {
    const grupoLimites = L.featureGroup();

    for (const cfg of CAPAS_DB) {
        try {
            actualizarEstado(`Cargando ${cfg.nombre}...`, 'loading');
            const data = await obtenerTodosLosRegistros(cfg.tabla, 4000);

            const features = [];
            data.forEach(fila => {
                const geometria = parsearGeometria(fila.geom);
                if (geometria) {
                    const props = { ...fila };
                    delete props.geom;
                    features.push({ type: 'Feature', geometry: geometria, properties: props });
                }
            });

            const capa = L.geoJSON({ type: 'FeatureCollection', features }, {
                style: () => {
                    if (cfg.tipo === 'poligono') return { color: cfg.color, weight: 1.5, fillOpacity: 0.18 };
                    if (cfg.tipo === 'linea') return { color: cfg.color, weight: 2.2 };
                },
                pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
                    radius: 6,
                    fillColor: cfg.color,
                    color: '#ffffff',
                    weight: 1.5,
                    fillOpacity: 0.95
                }),
                onEachFeature: (feature, layer) => {
                    if (cfg.tabla === 'barrios' && feature.properties) {
                        const nombreBarrio = feature.properties.BARRIO || 'Sin nombre';
                        listaBarrios.push({
                            id: feature.properties.id,
                            nombre: nombreBarrio,
                            layer: layer
                        });

                        layer.bindTooltip(nombreBarrio, {
                            permanent: true,
                            direction: 'center',
                            className: 'etiqueta-barrio'
                        });
                    }

                    layer.on('click', (e) => {
                        L.DomEvent.stopPropagation(e);
                        capturarCoordenadasEnFormulario(e.latlng);
                        consultarDistancias(e.latlng, feature.properties, cfg.nombre);
                    });
                }
            }).addTo(mapa);

            capasLeaflet[cfg.tabla] = capa;
            registrarItemEnPanelCapas(cfg.tabla, cfg.nombre, cfg.tipo, cfg.color, features.length);

            if (features.length > 0) grupoLimites.addLayer(capa);

        } catch (err) {
            console.error(`Fallo cargando ${cfg.tabla}:`, err);
        }
    }

    await cargarCapaReportes(false);
    listaBarrios.sort((a, b) => a.nombre.localeCompare(b.nombre));

    if (grupoLimites.getLayers().length > 0) {
        mapa.fitBounds(grupoLimites.getBounds());
        actualizarEstado('Sistema espacial listo. Haz clic en el mapa para consultar.', 'ready');
    } else {
        actualizarEstado('Conectado sin geometrías visibles.', 'error');
    }
}

// ==================== REPORTES CIUDADANOS ====================
async function cargarCapaReportes(esRecarga = false) {
    try {
        const data = await obtenerTodosLosRegistros('reportes', 4000);
        const features = [];

        data.forEach(fila => {
            const geometria = parsearGeometria(fila.geom);
            if (geometria) {
                const props = { ...fila };
                delete props.geom;
                features.push({ type: 'Feature', geometry: geometria, properties: props });
            }
        });

        if (capasLeaflet['reportes']) {
            mapa.removeLayer(capasLeaflet['reportes']);
        }

        const capaReportes = L.geoJSON({ type: 'FeatureCollection', features }, {
            pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
                radius: 7,
                fillColor: '#f59e0b',
                color: '#0f172a',
                weight: 1.5,
                fillOpacity: 1
            }),
            onEachFeature: (feature, layer) => {
                const p = feature.properties;
                layer.bindPopup(`
                    <div class="popup-card">
                        <div class="popup-title">Reporte Ciudadano #${p.id}</div>
                        <div class="popup-row"><span>Solicitante:</span><strong>${p.nombre}</strong></div>
                        <div class="popup-row"><span>Categoría:</span><strong>${p.tipo_requerimiento}</strong></div>
                        <div style="margin-top:6px; color:#334155;">${p.comentarios || 'Sin comentarios adicionales.'}</div>
                    </div>
                `);
            }
        }).addTo(mapa);

        capasLeaflet['reportes'] = capaReportes;
        registrarItemEnPanelCapas('reportes', 'Reportes Ciudadanos', 'punto', '#f59e0b', features.length);

        if (esRecarga && features.length > 0) {
            const ultimo = features[features.length - 1];
            const [lng, lat] = ultimo.geometry.coordinates;
            mapa.setView([lat, lng], 16);
        }
    } catch (err) {
        console.error('Error cargando reportes:', err);
    }
}

function obtenerUbicacionGPS() {
    if (!navigator.geolocation) {
        alert('Tu navegador no soporta geolocalización.');
        return;
    }
    actualizarEstado('Obteniendo señal GPS...', 'loading');
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const latlng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            capturarCoordenadasEnFormulario(latlng);
            mapa.setView([latlng.lat, latlng.lng], 16);
            actualizarEstado('Ubicación GPS capturada correctamente.', 'ready');
        },
        (err) => {
            actualizarEstado(`Error GPS: ${err.message}`, 'error');
        },
        { enableHighAccuracy: true }
    );
}

async function enviarReporte(event) {
    event.preventDefault();
    const btn = document.getElementById('btnEnviarReporte');

    const nuevoReporte = {
        nombre: document.getElementById('repNombre').value.trim(),
        tipo_requerimiento: document.getElementById('repTipo').value,
        comentarios: document.getElementById('repComentarios').value.trim(),
        lat: parseFloat(document.getElementById('repLat').value),
        long: parseFloat(document.getElementById('repLong').value)
    };

    btn.disabled = true;
    actualizarEstado('Guardando reporte en PostGIS...', 'loading');

    const { error } = await supabaseClient.from('reportes').insert([nuevoReporte]);
    btn.disabled = false;

    if (error) {
        actualizarEstado(`Error al guardar: ${error.message}`, 'error');
        return;
    }

    document.getElementById('formReporte').reset();
    actualizarEstado('Reporte publicado en el geoportal.', 'ready');
    await cargarCapaReportes(true);
}

// ==================== CONSULTAS ESPACIALES RPC ====================
function formatearDistancia(metros) {
    if (metros < 0 || metros === null || metros === undefined) return 'Sin datos';
    if (metros >= 1000) return `${(metros / 1000).toFixed(2)} km`;
    return `${Math.round(metros)} m`;
}

async function consultarDistancias(latlng, propsElemento = null, nombreCapa = null) {
    const popup = L.popup()
        .setLatLng(latlng)
        .setContent('<div class="popup-card">Calculando distancias espaciales...</div>')
        .openOn(mapa);

    const { data, error } = await supabaseClient.rpc('distancia_servicios', {
        p_lat: latlng.lat,
        p_lng: latlng.lng
    });

    if (error) {
        popup.setContent(`<div class="popup-card">Error SQL: ${error.message}</div>`);
        return;
    }

    let htmlAtributos = '';
    if (propsElemento) {
        const resumen = Object.entries(propsElemento)
            .filter(([_, v]) => v !== null && v !== '')
            .slice(0, 4)
            .map(([k, v]) => `<div class="popup-row"><span>${k}:</span><strong>${v}</strong></div>`)
            .join('');
        htmlAtributos = `<div class="popup-title">${nombreCapa}</div>${resumen}<hr style="margin:8px 0; border:0; border-top:1px solid #e2e8f0;">`;
    }

    popup.setContent(`
        <div class="popup-card">
            ${htmlAtributos}
            <div style="font-weight:700; color:#1e40af; margin-bottom:5px;">Servicios más cercanos:</div>
            <div class="popup-row"><span>🚒 Bomberos:</span><strong>${formatearDistancia(data.bomberos_m)}</strong></div>
            <div class="popup-row"><span>🚓 Policía:</span><strong>${formatearDistancia(data.policia_m)}</strong></div>
            <div class="popup-row"><span>🏥 Salud:</span><strong>${formatearDistancia(data.salud_m)}</strong></div>
        </div>
    `);
}

// ==================== BUSCADOR Y ANÁLISIS DE BARRIOS ====================
function configurarBuscador() {
    const input = document.getElementById('inputBarrio');
    const lista = document.getElementById('listaResultados');
    const btnLimpiar = document.getElementById('btnLimpiarBusqueda');

    function mostrarCoincidencias(texto) {
        lista.innerHTML = '';
        const filtro = texto.toLowerCase().trim();
        btnLimpiar.style.display = filtro.length > 0 ? 'block' : 'none';

        const filtrados = listaBarrios.filter(b => b.nombre.toLowerCase().includes(filtro));
        if (filtrados.length === 0) {
            lista.style.display = 'none';
            return;
        }

        filtrados.forEach(item => {
            const div = document.createElement('div');
            div.className = 'item-resultado';
            div.innerHTML = `<i class="ph ph-map-pin" style="color:#2563eb;"></i> ${item.nombre}`;
            div.onclick = () => seleccionarBarrio(item);
            lista.appendChild(div);
        });
        lista.style.display = 'block';
    }

    input.addEventListener('input', (e) => mostrarCoincidencias(e.target.value));
    input.addEventListener('focus', (e) => mostrarCoincidencias(e.target.value));

    btnLimpiar.addEventListener('click', () => {
        input.value = '';
        btnLimpiar.style.display = 'none';
        lista.style.display = 'none';
        document.getElementById('infoBarrio').style.display = 'none';
        if (barrioResaltado) {
            barrioResaltado.setStyle({ color: '#1e40af', weight: 1.5, fillOpacity: 0.18 });
            barrioResaltado = null;
        }
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-wrapper')) lista.style.display = 'none';
    });
}

async function seleccionarBarrio(item) {
    document.getElementById('inputBarrio').value = item.nombre;
    document.getElementById('listaResultados').style.display = 'none';
    document.getElementById('btnLimpiarBusqueda').style.display = 'block';

    if (barrioResaltado) {
        barrioResaltado.setStyle({ color: '#1e40af', weight: 1.5, fillOpacity: 0.18 });
    }

    barrioResaltado = item.layer;
    barrioResaltado.setStyle({ color: '#0284c7', weight: 3.5, fillOpacity: 0.35 });
    mapa.fitBounds(item.layer.getBounds());

    const panelInfo = document.getElementById('infoBarrio');
    panelInfo.style.display = 'block';
    document.getElementById('resNombreBarrio').textContent = item.nombre;
    document.getElementById('resAlcantarillado').textContent = 'Calculando...';

    const { data, error } = await supabaseClient.rpc('analizar_barrio', {
        p_barrio_id: item.id
    });

    if (error) {
        document.getElementById('resAlcantarillado').textContent = `Error: ${error.message}`;
        return;
    }

    document.getElementById('resNombreBarrio').textContent = data.barrio;
    document.getElementById('resAlcantarillado').textContent = `${Number(data.longitud_alcantarillado_m).toLocaleString()} m`;

    actualizarPillServicio('pillBomberos', 'txtBomberos', data.bomberos);
    actualizarPillServicio('pillPolicia', 'txtPolicia', data.policia);
    actualizarPillServicio('pillSalud', 'txtSalud', data.salud);
}

function actualizarPillServicio(pillId, txtId, disponible) {
    const pill = document.getElementById(pillId);
    const txt = document.getElementById(txtId);
    if (disponible) {
        pill.classList.add('available');
        txt.textContent = 'Cobertura Sí';
    } else {
        pill.classList.remove('available');
        txt.textContent = 'Sin registro';
    }
}