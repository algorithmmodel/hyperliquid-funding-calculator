// ===================== Utilidad: escapado de texto proveniente de APIs externas =====================
// Todo dato que llega de la API de Hyperliquid (nombres de mercado, nombres de dex
// HIP-3) o de un mensaje de error se inserta como texto plano, nunca como HTML.
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ===================== Utilidad: guardado local =====================
// window.storage solo existe en algunos entornos de previsualizacion; en un
// navegador normal no existe, y sin este respaldo la pagina prometia guardar los
// ultimos valores y en realidad no guardaba nada.
const almacen = {
  async get(clave) {
    try {
      if (window.storage && window.storage.get) {
        const r = await window.storage.get(clave);
        if (r && r.value) return r.value;
      }
    } catch (e) { /* sin entorno: seguimos con localStorage */ }
    try { return localStorage.getItem(clave); } catch (e) { return null; }
  },
  async set(clave, valor) {
    try {
      if (window.storage && window.storage.set) { await window.storage.set(clave, valor); return; }
    } catch (e) { /* sin entorno: seguimos con localStorage */ }
    try { localStorage.setItem(clave, valor); } catch (e) { /* navegacion privada */ }
  }
};

const tickerInput = document.getElementById('ticker');
const montoInput = document.getElementById('monto');
const diasInput = document.getElementById('dias');
const btnGenerar = document.getElementById('btnGenerar');
const statusEl = document.getElementById('status');
const resultPanel = document.getElementById('resultPanel');
const totalValueEl = document.getElementById('totalValue');
const totalNoteEl = document.getElementById('totalNote');
const tbody = document.getElementById('tbody');
const suggestionsEl = document.getElementById('suggestions');
const tickerStatusEl = document.getElementById('tickerStatus');
const priceHero = document.getElementById('priceHero');
const priceLabel = document.getElementById('priceLabel');
const priceValue = document.getElementById('priceValue');

// Alias de nombres conocidos → fragmento(s) del ticker real usado en Hyperliquid.
// Esto NO es una dirección ni un precio hardcodeado: es solo una ayuda de búsqueda,
// porque Hyperliquid nombra sus mercados HIP-3 distinto al ticker real del activo.
const ALIASES = {
  'QQQ': ['XYZ100', 'NDX', 'NASDAQ'],
  'NASDAQ': ['XYZ100', 'NDX'],
  'NASDAQ100': ['XYZ100', 'NDX'],
  'SPY': ['SP500', 'SPX', 'US500'],
  'SPX': ['SP500', 'US500'],
  'SP500': ['SP500', 'SPX', 'US500'],
  'S&P500': ['SP500', 'SPX', 'US500'],
  'S&P': ['SP500', 'SPX', 'US500'],
  'GOLD': ['GOLD', 'XAU'],
  'ORO': ['GOLD', 'XAU'],
  'SILVER': ['SILVER', 'XAG'],
  'PLATA': ['SILVER', 'XAG'],
  'OIL': ['OIL', 'WTI', 'CRUDE'],
  'PETROLEO': ['OIL', 'WTI', 'CRUDE'],
  'PETRÓLEO': ['OIL', 'WTI', 'CRUDE']
};

let allMarkets = []; // { name, tag, volume, markPx }
let validSelection = false;
let selectedMarket = null;

async function loadMarkets() {
  tickerStatusEl.textContent = 'Cargando mercados de Hyperliquid (con datos de volumen)...';
  allMarkets = [];
  try {
    // Mercado base (BTC, ETH, etc.) con contexto de volumen/precio
    const mainResp = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' })
    });
    const mainData = await mainResp.json();
    if (Array.isArray(mainData) && mainData[0] && mainData[0].universe && mainData[1]) {
      const universe = mainData[0].universe;
      const ctxs = mainData[1];
      universe.forEach((a, i) => {
        const ctx = ctxs[i] || {};
        allMarkets.push({
          name: a.name,
          tag: 'Base',
          volume: parseFloat(ctx.dayNtlVlm || 0),
          markPx: parseFloat(ctx.markPx || 0)
        });
      });
    }

    // Mercados HIP-3 (Trade[XYZ], Felix, Markets.xyz, etc.), también con contexto
    try {
      const dexResp = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'perpDexs' })
      });
      const dexList = await dexResp.json();
      if (Array.isArray(dexList)) {
        for (const dex of dexList) {
          if (!dex || !dex.name) continue;
          try {
            const dexResp2 = await fetch('https://api.hyperliquid.xyz/info', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: dex.name })
            });
            const dexData = await dexResp2.json();
            if (Array.isArray(dexData) && dexData[0] && dexData[0].universe && dexData[1]) {
              const universe = dexData[0].universe;
              const ctxs = dexData[1];
              universe.forEach((a, i) => {
                const ctx = ctxs[i] || {};
                allMarkets.push({
                  name: a.name,
                  tag: dex.name,
                  volume: parseFloat(ctx.dayNtlVlm || 0),
                  markPx: parseFloat(ctx.markPx || 0)
                });
              });
            }
          } catch (e) { /* ignorar dex individual si falla */ }
        }
      }
    } catch (e) {
      // si perpDexs no está disponible, seguimos solo con el mercado base
    }

    const conLiquidez = allMarkets.filter(m => m.volume > 0);
    tickerStatusEl.textContent = `${conLiquidez.length} mercados con liquidez detectada (de ${allMarkets.length} totales). Escriba para buscar.`;
  } catch (err) {
    tickerStatusEl.innerHTML = '<span class="error">No se pudo cargar la lista de mercados (posible bloqueo CORS).</span>';
  }
}
loadMarkets();

function renderSuggestions(query) {
  const q = query.trim().toUpperCase();

  // Solo mercados con volumen real > 0 (filtro de liquidez pedido)
  const liquidos = allMarkets.filter(m => m.volume > 0);

  let matches;
  if (!q) {
    matches = [...liquidos].sort((a, b) => b.volume - a.volume).slice(0, 100);
  } else {
    const aliasTargets = ALIASES[q] || [];
    matches = liquidos.filter(m => {
      const nameUpper = m.name.toUpperCase();
      if (nameUpper.includes(q)) return true;
      return aliasTargets.some(alias => nameUpper.includes(alias));
    });
    matches.sort((a, b) => b.volume - a.volume);
    matches = matches.slice(0, 30);
  }

  if (matches.length === 0) {
    suggestionsEl.innerHTML = '<div class="suggestion-item" style="color:var(--muted); cursor:default;">Sin coincidencias con liquidez real</div>';
    suggestionsEl.classList.add('open');
    return;
  }

  suggestionsEl.innerHTML = matches.map(m => {
    const vol = m.volume >= 1e6 ? `$${(m.volume/1e6).toFixed(1)}M` : `$${(m.volume/1e3).toFixed(0)}K`;
    return `<div class="suggestion-item" data-name="${esc(m.name)}" data-tag="${esc(m.tag)}" data-markpx="${esc(Number(m.markPx) || 0)}">
      <span>${esc(m.name)}</span>
      <span class="suggestion-tag">${esc(m.tag)} · Vol 24h ${esc(vol)}</span>
    </div>`;
  }).join('');
  suggestionsEl.classList.add('open');
}

tickerInput.addEventListener('input', () => {
  validSelection = false;
  selectedMarket = null;
  tickerStatusEl.classList.remove('ready');
  const q = tickerInput.value.trim().toUpperCase();
  const aliasHit = ALIASES[q];
  tickerStatusEl.textContent = aliasHit ? `Sugerencia: en Hyperliquid esto suele listarse como "${aliasHit.join('" / "')}" — ya incluido en los resultados de abajo.` : '';
  renderSuggestions(tickerInput.value);
});

tickerInput.addEventListener('focus', () => {
  renderSuggestions(tickerInput.value);
});

document.addEventListener('click', (e) => {
  const item = e.target.closest('.suggestion-item');
  if (item && item.dataset.name) {
    tickerInput.value = item.dataset.name;
    validSelection = true;
    selectedMarket = { name: item.dataset.name, tag: item.dataset.tag, markPx: parseFloat(item.dataset.markpx) };
    tickerStatusEl.textContent = `Seleccionado: ${item.dataset.name} (${item.dataset.tag}).`;
    tickerStatusEl.classList.add('ready');
    suggestionsEl.classList.remove('open');
  } else if (!e.target.closest('.field')) {
    suggestionsEl.classList.remove('open');
  }
});

// Guardado de últimos valores
async function loadSaved() {
  try {
    const raw = await almacen.get('last_inputs');
    if (raw) {
      const data = JSON.parse(raw);
      if (data.ticker) tickerInput.value = data.ticker;
      if (data.monto) montoInput.value = data.monto;
      if (data.dias) diasInput.value = data.dias;
    }
  } catch (e) { /* primera vez, sin datos guardados */ }
}
loadSaved();

async function saveInputs(ticker, monto, dias) {
  try {
    await almacen.set('last_inputs', JSON.stringify({ ticker, monto, dias }));
  } catch (e) { console.error('No se pudo guardar', e); }
}

btnGenerar.addEventListener('click', async () => {
  const ticker = tickerInput.value.trim();
  const monto = parseFloat(montoInput.value);
  const dias = parseInt(diasInput.value) || 7;

  if (!ticker) { statusEl.innerHTML = '<span class="error">Ingrese o seleccione un ticker.</span>'; return; }
  if (!monto || monto <= 0) { statusEl.innerHTML = '<span class="error">Ingrese un monto válido.</span>'; return; }

  await saveInputs(ticker, monto, dias);

  btnGenerar.disabled = true;
  statusEl.textContent = 'Consultando API de Hyperliquid...';
  resultPanel.style.display = 'none';
  priceHero.style.display = 'none';
  tbody.innerHTML = '';

  // Mostrar precio grande arriba, si ya lo tenemos de la selección
  if (selectedMarket && selectedMarket.markPx) {
    priceLabel.textContent = `Precio actual — ${selectedMarket.name} (${selectedMarket.tag})`;
    priceValue.textContent = '$' + selectedMarket.markPx.toLocaleString('en-US', { maximumFractionDigits: 4 });
    priceHero.style.display = 'block';
  }

  const endTime = Date.now();
  const startTime = endTime - dias * 24 * 60 * 60 * 1000;

  async function tryFetch(coinName, dexName) {
    const body = { type: 'fundingHistory', coin: coinName, startTime, endTime };
    if (dexName) body.dex = dexName;
    const response = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const err = new Error('HTTP ' + response.status);
      err.status = response.status;
      throw err;
    }
    return await response.json();
  }

  try {
    let data;
    let usedTicker = ticker;
    const attempts = [];
    const dexTag = selectedMarket ? selectedMarket.tag : null;

    // Separar siempre el prefijo del dex (ej. "XYZ:XYZ100" -> dexPart="XYZ", shortName="XYZ100")
    let dexPart = null;
    let shortName = ticker;
    if (ticker.includes(':')) {
      const parts = ticker.split(':');
      dexPart = parts[0];
      shortName = parts[1];
    }

    attempts.push({ coin: ticker, dex: null, label: `"${ticker}" sin dex` });
    if (shortName !== ticker) {
      attempts.push({ coin: shortName, dex: null, label: `"${shortName}" sin dex` });
    }
    if (dexTag && dexTag.toUpperCase() !== 'BASE') {
      attempts.push({ coin: shortName, dex: dexTag, label: `"${shortName}" con dex="${dexTag}"` });
    }
    if (dexPart && dexPart.toUpperCase() !== (dexTag || '').toUpperCase()) {
      attempts.push({ coin: shortName, dex: dexPart, label: `"${shortName}" con dex="${dexPart}"` });
    }

    let lastErr;
    let success = false;
    for (const attempt of attempts) {
      try {
        statusEl.textContent = `Probando ${attempt.label}...`;
        data = await tryFetch(attempt.coin, attempt.dex);
        usedTicker = attempt.label;
        success = true;
        break;
      } catch (e) {
        lastErr = e;
      }
    }

    if (!success) {
      throw new Error(`Ningún formato funcionó. Intentos: ${attempts.map(a => a.label).join(' / ')}. Último error: HTTP ${lastErr.status || '?'}.`);
    }

    if (!Array.isArray(data) || data.length === 0) {
      statusEl.innerHTML = '<span class="error">No se encontraron datos de funding para ese rango.</span>';
      btnGenerar.disabled = false;
      return;
    }

    let total = 0;
    let rows = '';
    data.forEach(entry => {
      const rate = parseFloat(entry.fundingRate);
      const costo = monto * rate;
      total += costo;
      const fecha = new Date(entry.time).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const cls = costo >= 0 ? 'pos' : 'neg';
      rows += `<tr><td>${fecha}</td><td>${(rate * 100).toFixed(4)}%</td><td class="${cls}">${costo >= 0 ? '-' : '+'}$${Math.abs(costo).toFixed(2)}</td></tr>`;
    });
    tbody.innerHTML = rows;

    const totalCls = total >= 0 ? 'pos' : 'neg';
    totalValueEl.className = 'total-value ' + totalCls;
    totalValueEl.textContent = (total >= 0 ? '-$' : '+$') + Math.abs(total).toFixed(2);
    totalNoteEl.textContent = total >= 0
      ? `Como LONG, habría pagado $${Math.abs(total).toFixed(2)} en funding en los últimos ${dias} días, sobre $${monto.toFixed(2)}.`
      : `Como LONG, habría cobrado $${Math.abs(total).toFixed(2)} en funding en los últimos ${dias} días (mercado mayormente short), sobre $${monto.toFixed(2)}.`;

    resultPanel.style.display = 'block';
    statusEl.textContent = `Listo — ${data.length} registros procesados (ticker: ${usedTicker}).`;
  } catch (err) {
    statusEl.innerHTML = `<span class="error">Error: ${esc(err.message)}</span>`;
  }
  btnGenerar.disabled = false;
});
