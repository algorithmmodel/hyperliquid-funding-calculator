// ===================== Utilidad: escapado de texto proveniente de APIs externas =====================
// Todo dato que llega de una API de terceros (Jupiter, CoinGecko, deBridge, LI.FI,
// Chainflip, NEAR Intents, Bitget) o de un mensaje de error se inserta como texto
// plano, nunca como HTML. Sin esto, un token con symbol/name malicioso o una API
// que devuelva un mensaje con etiquetas podria ejecutar JS en la pagina.
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ===================== CARD 1: Búsqueda individual vía Jupiter =====================
const tickerSearch = document.getElementById('tickerSearch');
const suggestionsEl = document.getElementById('suggestions');
const btnConsultar = document.getElementById('btnConsultar');
const searchStatus = document.getElementById('searchStatus');
const resultCard = document.getElementById('resultCard');
const resTitle = document.getElementById('resTitle');
const resPrice = document.getElementById('resPrice');
const resChange = document.getElementById('resChange');
const resLiquidity = document.getElementById('resLiquidity');
const resStatus = document.getElementById('resStatus');
const resAddr = document.getElementById('resAddr');

let searchTimeout = null;
let selectedToken = null; // { symbol, name, address }

async function searchTokens(query) {
  searchStatus.textContent = 'Buscando en Jupiter...';
  try {
    const resp = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(query)}`);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const results = await resp.json();
    if (!Array.isArray(results) || results.length === 0) {
      suggestionsEl.innerHTML = '<div class="suggestion-item" style="color:var(--muted); cursor:default;">Sin coincidencias</div>';
      suggestionsEl.classList.add('open');
      searchStatus.textContent = '';
      return;
    }
    suggestionsEl.innerHTML = results.slice(0, 20).map(t => {
      const symbol = String(t.symbol || '?');
      const name = String(t.name || '');
      const addr = String(t.id || t.address || '');
      return `<div class="suggestion-item" data-addr="${esc(addr)}" data-symbol="${esc(symbol)}" data-name="${esc(name)}">
        <span>${esc(symbol)} <span style="color:var(--muted);">— ${esc(name)}</span></span>
        <span class="suggestion-tag">${esc(addr.slice(0,4))}...${esc(addr.slice(-4))}</span>
      </div>`;
    }).join('');
    suggestionsEl.classList.add('open');
    searchStatus.textContent = `${results.length} resultado(s). Elija uno.`;
  } catch (err) {
    searchStatus.innerHTML = `<span class="error">Error al buscar: ${esc(err.message)}. Posible bloqueo CORS.</span>`;
  }
}

tickerSearch.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  selectedToken = null;
  resultCard.style.display = 'none';
  const q = tickerSearch.value.trim();
  if (!q) { suggestionsEl.classList.remove('open'); suggestionsEl.innerHTML = ''; searchStatus.textContent = ''; return; }
  searchTimeout = setTimeout(() => searchTokens(q), 350);
});

document.addEventListener('click', (e) => {
  const item = e.target.closest('#suggestions .suggestion-item');
  if (item && item.dataset.addr) {
    selectedToken = { symbol: item.dataset.symbol, name: item.dataset.name, address: item.dataset.addr };
    tickerSearch.value = item.dataset.symbol;
    suggestionsEl.classList.remove('open');
    searchStatus.textContent = `Seleccionado: ${item.dataset.symbol}. Toque "Consultar".`;
  } else if (!e.target.closest('#tickerSearch') && !e.target.closest('#suggestions')) {
    suggestionsEl.classList.remove('open');
  }
});

btnConsultar.addEventListener('click', async () => {
  if (!selectedToken) {
    searchStatus.innerHTML = '<span class="error">Primero elija un token de la lista de sugerencias.</span>';
    return;
  }
  btnConsultar.disabled = true;
  searchStatus.textContent = 'Consultando precio y liquidez...';
  resultCard.style.display = 'none';

  try {
    const resp = await fetch(`https://lite-api.jup.ag/price/v3?ids=${encodeURIComponent(selectedToken.address)}`);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const json = await resp.json();
    const info = json && json[selectedToken.address];
    if (!info || typeof info.usdPrice !== 'number') {
      searchStatus.innerHTML = '<span class="error">No se encontró precio para este token.</span>';
      btnConsultar.disabled = false;
      return;
    }
    resTitle.textContent = `${selectedToken.symbol} — ${selectedToken.name}`;
    resPrice.textContent = '$' + info.usdPrice.toLocaleString('en-US', { maximumFractionDigits: 4 });
    resChange.textContent = typeof info.priceChange24h === 'number'
      ? `${info.priceChange24h >= 0 ? '+' : ''}${info.priceChange24h.toFixed(2)}%`
      : '—';
    const liq = typeof info.liquidity === 'number' ? info.liquidity : null;
    resLiquidity.textContent = liq !== null ? '$' + liq.toLocaleString('en-US', { maximumFractionDigits: 0 }) : 'No disponible';

    if (liq !== null) {
      if (liq >= 500000) {
        resStatus.innerHTML = 'Operable <span class="badge badge-ok">✓ liquidez OK</span>';
      } else {
        resStatus.innerHTML = 'Riesgo de slippage <span class="badge badge-warn">⚠ baja liquidez</span>';
      }
    } else {
      resStatus.textContent = 'Sin dato de liquidez';
    }

    resAddr.textContent = selectedToken.address;
    resultCard.style.display = 'block';
    searchStatus.textContent = 'Listo.';
  } catch (err) {
    searchStatus.innerHTML = `<span class="error">Error: ${esc(err.message)}. Posible bloqueo CORS.</span>`;
  }
  btnConsultar.disabled = false;
});

// ===================== CARD 2: Listado filtrado por liquidez real (CoinGecko + Jupiter) =====================
const btnListado = document.getElementById('btnListado');
const listStatus = document.getElementById('listStatus');
const listTable = document.getElementById('listTable');
const listTbody = document.getElementById('listTbody');
const pisoVolumenInput = document.getElementById('pisoVolumen');

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

btnListado.addEventListener('click', async () => {
  btnListado.disabled = true;
  listTable.style.display = 'none';
  listTbody.innerHTML = '';

  try {
    // Paso 1: lista de xStocks (símbolo, nombre, id, market cap) desde la categoría de CoinGecko
    listStatus.textContent = 'Paso 1/3: trayendo lista de xStocks desde CoinGecko...';
    const catResp = await fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=xstocks-ecosystem&order=market_cap_desc&per_page=250&page=1&sparkline=false');
    if (!catResp.ok) throw new Error('HTTP ' + catResp.status + ' al traer la categoría');
    const catData = await catResp.json();
    if (!Array.isArray(catData)) throw new Error('Respuesta inesperada de CoinGecko (categoría)');

    // Paso 2: direcciones en Solana para cada id (una sola llamada masiva a la lista completa con plataformas)
    listStatus.textContent = `Paso 2/3: resolviendo direcciones en Solana para ${catData.length} tokens...`;
    const platResp = await fetch('https://api.coingecko.com/api/v3/coins/list?include_platform=true');
    if (!platResp.ok) throw new Error('HTTP ' + platResp.status + ' al traer plataformas');
    const platData = await platResp.json();
    const platMap = {};
    if (Array.isArray(platData)) {
      platData.forEach(p => { platMap[p.id] = p.platforms || {}; });
    }

    const conDireccion = catData
      .map(c => ({
        symbol: c.symbol, name: c.name, id: c.id,
        price: c.current_price, mcap: c.market_cap,
        solanaAddr: (platMap[c.id] && platMap[c.id].solana) ? platMap[c.id].solana : null
      }))
      .filter(c => c.solanaAddr);

    if (conDireccion.length === 0) {
      listStatus.innerHTML = '<span class="error">Ningún token de la categoría tiene dirección de Solana resuelta.</span>';
      btnListado.disabled = false;
      return;
    }

    // Paso 3: liquidez real vía Jupiter Price API v3, en lotes
    listStatus.textContent = `Paso 3/3: consultando liquidez real en Jupiter para ${conDireccion.length} tokens...`;
    const lotes = chunkArray(conDireccion, 30);
    const liquidezMap = {};
    for (const lote of lotes) {
      const ids = lote.map(t => t.solanaAddr).join(',');
      try {
        const priceResp = await fetch(`https://lite-api.jup.ag/price/v3?ids=${encodeURIComponent(ids)}`);
        if (priceResp.ok) {
          const priceJson = await priceResp.json();
          Object.keys(priceJson).forEach(addr => {
            liquidezMap[addr] = priceJson[addr];
          });
        }
      } catch (e) { /* si un lote falla, seguimos con los demás */ }
    }

    const conLiquidez = conDireccion
      .map(t => {
        const info = liquidezMap[t.solanaAddr];
        return {
          ...t,
          jupPrice: info ? info.usdPrice : null,
          liquidity: info && typeof info.liquidity === 'number' ? info.liquidity : null
        };
      })
      .filter(t => t.liquidity !== null);

    const piso = parseFloat(pisoVolumenInput.value);
    const pisoFinal = isNaN(piso) ? 500000 : piso;
    const filtrados = conLiquidez.filter(t => t.liquidity > pisoFinal);
    filtrados.sort((a, b) => b.liquidity - a.liquidity);

    if (filtrados.length === 0) {
      listStatus.textContent = `Ningún xStock con dirección en Solana supera $${pisoFinal.toLocaleString('en-US')} de liquidez real (de ${conLiquidez.length} con datos de Jupiter, ${conDireccion.length} con dirección Solana, ${catData.length} totales en la categoría).`;
      btnListado.disabled = false;
      return;
    }

    listTbody.innerHTML = filtrados.map(t => {
      const precio = Number(t.jupPrice ?? t.price ?? 0);
      return `
      <tr>
        <td>${esc(String(t.symbol || '').toUpperCase())}</td>
        <td>$${esc(precio.toLocaleString('en-US', { maximumFractionDigits: 2 }))}</td>
        <td>$${esc((t.liquidity/1e3).toFixed(1))}K</td>
        <td>$${esc(((Number(t.mcap) || 0)/1e6).toFixed(1))}M</td>
      </tr>
    `;
    }).join('');
    listTable.style.display = 'table';
    listStatus.textContent = `${filtrados.length} xStock(s) con liquidez real > $${pisoFinal.toLocaleString('en-US')} (de ${catData.length} totales en la categoría).`;
  } catch (err) {
    listStatus.innerHTML = `<span class="error">Error: ${esc(err.message)}. Posible bloqueo CORS o rate limit.</span>`;
  }
  btnListado.disabled = false;
});

// ===================== CARD 3: USDT (TRON) -> USDC (Solana), comparativa DeFi + Bitget =====================
const montoUsdtInput = document.getElementById('montoUsdt');
const btnCotizar = document.getElementById('btnCotizar');
const cotizarStatus = document.getElementById('cotizarStatus');
const providerRowsEl = document.getElementById('providerRows');
const bestQuoteBox = document.getElementById('bestQuoteBox');
const bestProviderEl = document.getElementById('bestProvider');
const bestAmountEl = document.getElementById('bestAmount');
const bestSavingsEl = document.getElementById('bestSavings');

const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const NEAR_ORIGIN_ASSET = 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near'; // USDT-Tron en NEAR Intents
const DUMMY_TRON_ADDR = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
const BITGET_TAKER_FEE = 0.001; // fee taker estandar de Bitget spot, sin descuento por BGB

// Configuracion por red de destino: cada proveedor necesita su propio formato de chain/token
const NETWORKS = {
  SOL: {
    usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    dummyAddr: 'So11111111111111111111111111111111111111112',
    debridgeChainId: 7565164,
    lifiChainId: 1151111081099710,
    chainflipChain: 'Solana',
    nearAsset: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
    bitgetChain: 'SOL'
  },
  ARB: {
    usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    dummyAddr: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    debridgeChainId: 42161,
    lifiChainId: 42161,
    chainflipChain: 'Arbitrum',
    nearAsset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
    bitgetChain: 'ArbitrumOne'
  }
};

function activarSelectorRed(containerId, onChange) {
  const container = document.getElementById(containerId);
  let seleccionada = 'SOL';
  container.querySelectorAll('.network-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      seleccionada = btn.dataset.network;
      container.querySelectorAll('.network-btn').forEach(b => b.classList.toggle('active', b === btn));
      if (onChange) onChange(seleccionada);
    });
  });
  return { get: () => seleccionada };
}
let redCard3 = 'SOL';
const selectorCard3 = activarSelectorRed('networkSelectCard3', (red) => { redCard3 = red; });
let redCard4 = 'SOL';
const selectorCard4 = activarSelectorRed('networkSelectCard4', (red) => { redCard4 = red; });

async function quoteDebridge(amount, network) {
  const net = NETWORKS[network];
  const amt = Math.round(amount * 1e6);
  const url = `https://api.dln.trade/v1.0/dln/order/create-tx?srcChainId=100000026&srcChainTokenIn=${USDT_TRON}&srcChainTokenInAmount=${amt}&dstChainId=${net.debridgeChainId}&dstChainTokenOut=${net.usdc}`;
  const resp = await fetch(url);
  const d = await resp.json();
  if (!resp.ok || !d.estimation) throw new Error(d.errorMessage || ('HTTP ' + resp.status));
  const neto = parseFloat(d.estimation.dstChainTokenOut.amount) / 1e6;
  const min = d.order && d.order.approximateFulfillmentDelay;
  return { neto, tiempo: min ? `~${min} min` : '—' };
}

async function quoteLifi(amount, network) {
  const net = NETWORKS[network];
  const amt = Math.round(amount * 1e6);
  const url = `https://li.quest/v1/quote?fromChain=728126428&toChain=${net.lifiChainId}&fromToken=${USDT_TRON}&toToken=${net.usdc}&fromAmount=${amt}&fromAddress=${DUMMY_TRON_ADDR}&toAddress=${net.dummyAddr}`;
  const resp = await fetch(url);
  const d = await resp.json();
  if (!resp.ok || !d.estimate) throw new Error(d.message || ('HTTP ' + resp.status));
  const neto = parseFloat(d.estimate.toAmount) / 1e6;
  const seg = d.estimate.executionDuration;
  return { neto, tiempo: seg ? `~${Math.round(seg)} seg` : '—' };
}

async function quoteChainflip(amount, network) {
  const net = NETWORKS[network];
  const amt = Math.round(amount * 1e6);
  const url = `https://chainflip-swap.chainflip.io/v2/quote?srcChain=Tron&srcAsset=USDT&destChain=${net.chainflipChain}&destAsset=USDC&amount=${amt}&brokerCommissionBps=0&dcaEnabled=false`;
  const resp = await fetch(url);
  const d = await resp.json();
  if (!resp.ok || !Array.isArray(d) || !d[0] || !d[0].egressAmount) throw new Error((d && d.message) || ('HTTP ' + resp.status));
  const neto = parseFloat(d[0].egressAmount) / 1e6;
  const seg = d[0].estimatedDurationSeconds;
  return { neto, tiempo: seg ? `~${Math.round(seg)} seg` : '—' };
}

async function quoteNearIntents(amount, network) {
  const net = NETWORKS[network];
  const amt = Math.round(amount * 1e6);
  const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const body = {
    dry: true,
    swapType: 'EXACT_INPUT',
    originAsset: NEAR_ORIGIN_ASSET,
    destinationAsset: net.nearAsset,
    amount: String(amt),
    slippageTolerance: 100,
    deadline,
    depositType: 'ORIGIN_CHAIN',
    recipient: net.dummyAddr,
    recipientType: 'DESTINATION_CHAIN',
    refundTo: DUMMY_TRON_ADDR,
    refundType: 'ORIGIN_CHAIN'
  };
  const resp = await fetch('https://1click.chaindefuser.com/v0/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const d = await resp.json();
  if (!resp.ok || !d.quote) throw new Error(d.message || ('HTTP ' + resp.status));
  const neto = parseFloat(d.quote.amountOut) / 1e6;
  const seg = d.quote.timeEstimate;
  return { neto, tiempo: seg ? `~${Math.round(seg)} seg` : '—' };
}

async function quoteBitget(amount, network) {
  const net = NETWORKS[network];
  const [tickerResp, coinResp] = await Promise.all([
    fetch('https://api.bitget.com/api/v2/spot/market/tickers?symbol=USDCUSDT'),
    fetch('https://api.bitget.com/api/v2/spot/public/coins?coin=USDC')
  ]);
  if (!tickerResp.ok || !coinResp.ok) throw new Error('HTTP error');
  const tickerJson = await tickerResp.json();
  const coinJson = await coinResp.json();
  const askPrice = parseFloat(tickerJson.data[0].askPr);
  const chainInfo = (coinJson.data[0].chains || []).find(c => c.chain === net.bitgetChain);
  if (!chainInfo) throw new Error('Sin dato de retiro para esta red');
  const withdrawFee = parseFloat(chainInfo.withdrawFee);
  const gross = amount / askPrice;
  const afterTrade = gross * (1 - BITGET_TAKER_FEE);
  const neto = afterTrade - withdrawFee;
  return { neto };
}

function normalizarError(err) {
  const msg = (err && err.message) || '';
  if (msg.includes('Failed to fetch') || msg.includes('Load failed') || msg.includes('NetworkError') || msg.startsWith('HTTP')) return 'API no disponible';
  if (msg.includes('Sin ruta')) return 'Sin ruta disponible';
  return msg || 'API no disponible';
}

const PROVIDER_URLS = {
  'deBridge': 'https://debridge.com',
  'LI.FI': 'https://li.fi',
  'Chainflip': 'https://chainflip.io',
  'NEAR Intents': 'https://near-intents.org',
  'Bitget': 'https://www.bitget.com'
};

function renderProviderRow(nombre, resultado, esBitget, esGanador) {
  const rowClass = 'provider-row' + (esBitget ? ' bitget' : '') + (esGanador ? ' winner' : '');
  const nombreMostrado = esBitget ? 'Bitget — referencia centralizada' : nombre;
  const url = PROVIDER_URLS[nombre];
  const nombreHtml = url
    ? `<a class="name" href="${url}" target="_blank" rel="noopener">${nombreMostrado}</a>`
    : `<span class="name">${nombreMostrado}</span>`;
  if (resultado.error) {
    return `<div class="${rowClass}">
      <div class="head">
        ${nombreHtml}
        <span class="badge badge-warn">${esc(resultado.error)}</span>
      </div>
    </div>`;
  }
  const costo = resultado.monto - resultado.neto;
  const costoPct = (costo / resultado.monto * 100).toFixed(3);
  return `<div class="${rowClass}">
    <div class="head">
      ${nombreHtml}
      <span class="badge badge-ok">Disponible</span>
    </div>
    <div class="figures">
      <span>${esc(resultado.neto.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}))} USDC</span>
      <span>-$${esc(costo.toFixed(2))} (${esc(costoPct)}%)</span>
      <span>${esc(resultado.tiempo || '')}</span>
    </div>
  </div>`;
}

btnCotizar.addEventListener('click', async () => {
  const monto = parseFloat(montoUsdtInput.value);
  if (!monto || monto <= 0) {
    cotizarStatus.innerHTML = '<span class="error">Ingrese un monto válido.</span>';
    return;
  }
  btnCotizar.disabled = true;
  cotizarStatus.textContent = 'Consultando proveedores...';
  bestQuoteBox.style.display = 'none';
  providerRowsEl.innerHTML = '';

  const proveedores = [
    { nombre: 'deBridge', fn: quoteDebridge },
    { nombre: 'LI.FI', fn: quoteLifi },
    { nombre: 'Chainflip', fn: quoteChainflip },
    { nombre: 'NEAR Intents', fn: quoteNearIntents }
  ];

  const resultados = await Promise.all(proveedores.map(async p => {
    try {
      const r = await p.fn(monto, redCard3);
      return { nombre: p.nombre, monto, neto: r.neto, tiempo: r.tiempo };
    } catch (err) {
      return { nombre: p.nombre, error: normalizarError(err) };
    }
  }));

  let bitgetResult;
  try {
    const r = await quoteBitget(monto, redCard3);
    bitgetResult = { nombre: 'Bitget', monto, neto: r.neto };
  } catch (err) {
    bitgetResult = { nombre: 'Bitget', error: normalizarError(err) };
  }

  const validos = resultados.filter(r => !r.error);
  validos.sort((a, b) => b.neto - a.neto);
  const invalidos = resultados.filter(r => r.error);

  providerRowsEl.innerHTML = [...validos, ...invalidos].map((r, i) => renderProviderRow(r.nombre, r, false, i === 0 && validos.length > 0)).join('')
    + renderProviderRow('Bitget', bitgetResult, true, false);

  if (validos.length > 0) {
    const mejor = validos[0];
    bestProviderEl.textContent = mejor.nombre;
    bestAmountEl.textContent = mejor.neto.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}) + ' USDC';
    if (!bitgetResult.error) {
      const ahorro = mejor.neto - bitgetResult.neto;
      bestSavingsEl.textContent = `Ahorro frente a Bitget: ${ahorro >= 0 ? '+' : ''}${ahorro.toFixed(2)} USDC`;
    } else {
      bestSavingsEl.textContent = '';
    }
    bestQuoteBox.style.display = 'block';
    cotizarStatus.textContent = `Listo — ${validos.length} de ${proveedores.length} proveedores DeFi respondieron.`;
  } else {
    cotizarStatus.innerHTML = '<span class="error">Ningún proveedor DeFi respondió. Intente de nuevo.</span>';
  }

  btnCotizar.disabled = false;
});

// ===================== CARD 4: Generar deposito real (NEAR Intents) =====================
const solflareAddrInput = document.getElementById('solflareAddr');
const trustAddrInput = document.getElementById('trustAddr');
const btnPasteSolflare = document.getElementById('btnPasteSolflare');
const btnDeleteSolflare = document.getElementById('btnDeleteSolflare');
const btnPasteTrust = document.getElementById('btnPasteTrust');
const btnDeleteTrust = document.getElementById('btnDeleteTrust');
const btnGenerarDeposito = document.getElementById('btnGenerarDeposito');
const vigenciaMinInput = document.getElementById('vigenciaMin');
const depositoStatus = document.getElementById('depositoStatus');
const depositoResult = document.getElementById('depositoResult');
const depositAddrEl = document.getElementById('depositAddr');
const depositAmountEl = document.getElementById('depositAmount');
const depositDeadlineEl = document.getElementById('depositDeadline');
const btnCopyDeposit = document.getElementById('btnCopyDeposit');
const depositoMontoInput = document.getElementById('depositoMonto');

depositoMontoInput.value = montoUsdtInput.value;

async function loadDireccionesGuardadas() {
  try {
    const saved = await window.storage.get('card4_addrs');
    if (saved && saved.value) {
      const data = JSON.parse(saved.value);
      if (data.solflare) solflareAddrInput.value = data.solflare;
      if (data.trust) trustAddrInput.value = data.trust;
    }
  } catch (e) { /* primera vez, sin datos guardados */ }
}
loadDireccionesGuardadas();

async function guardarDirecciones() {
  try {
    await window.storage.set('card4_addrs', JSON.stringify({
      solflare: solflareAddrInput.value.trim(),
      trust: trustAddrInput.value.trim()
    }));
  } catch (e) { console.error('No se pudo guardar', e); }
}

btnPasteSolflare.addEventListener('click', async () => {
  try {
    solflareAddrInput.value = (await navigator.clipboard.readText()).trim();
    guardarDirecciones();
  } catch (e) {
    depositoStatus.innerHTML = '<span class="error">No se pudo leer el portapapeles.</span>';
  }
});
btnDeleteSolflare.addEventListener('click', () => { solflareAddrInput.value = ''; guardarDirecciones(); });

btnPasteTrust.addEventListener('click', async () => {
  try {
    trustAddrInput.value = (await navigator.clipboard.readText()).trim();
    guardarDirecciones();
  } catch (e) {
    depositoStatus.innerHTML = '<span class="error">No se pudo leer el portapapeles.</span>';
  }
});
btnDeleteTrust.addEventListener('click', () => { trustAddrInput.value = ''; guardarDirecciones(); });

btnCopyDeposit.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(depositAddrEl.textContent);
    btnCopyDeposit.textContent = 'Copiado';
    setTimeout(() => { btnCopyDeposit.textContent = 'Copiar'; }, 1500);
  } catch (e) { /* clipboard no disponible */ }
});

btnGenerarDeposito.addEventListener('click', async () => {
  const monto = parseFloat(depositoMontoInput.value);
  const solflare = solflareAddrInput.value.trim();
  const trust = trustAddrInput.value.trim();

  if (!monto || monto <= 0) {
    depositoStatus.innerHTML = '<span class="error">Ingrese un monto válido.</span>';
    return;
  }
  if (!solflare) {
    depositoStatus.innerHTML = '<span class="error">Ingrese su dirección de destino.</span>';
    return;
  }
  if (!trust) {
    depositoStatus.innerHTML = '<span class="error">Ingrese su dirección de Trust (Tron).</span>';
    return;
  }
  let vigenciaMin = parseInt(vigenciaMinInput.value);
  if (!vigenciaMin || vigenciaMin < 1) vigenciaMin = 1;
  if (vigenciaMin > 60) vigenciaMin = 60;
  vigenciaMinInput.value = vigenciaMin;

  await guardarDirecciones();
  btnGenerarDeposito.disabled = true;
  depositoStatus.textContent = 'Generando dirección de depósito...';
  depositoResult.style.display = 'none';

  try {
    const amt = Math.round(monto * 1e6);
    const deadline = new Date(Date.now() + vigenciaMin * 60 * 1000).toISOString();
    const body = {
      dry: false,
      swapType: 'EXACT_INPUT',
      originAsset: NEAR_ORIGIN_ASSET,
      destinationAsset: NETWORKS[redCard4].nearAsset,
      amount: String(amt),
      slippageTolerance: 100,
      deadline,
      depositType: 'ORIGIN_CHAIN',
      recipient: solflare,
      recipientType: 'DESTINATION_CHAIN',
      refundTo: trust,
      refundType: 'ORIGIN_CHAIN'
    };
    const resp = await fetch('https://1click.chaindefuser.com/v0/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d = await resp.json();
    if (!resp.ok || !d.quote || !d.quote.depositAddress) throw new Error(normalizarError({ message: d.message || ('HTTP ' + resp.status) }));

    depositAddrEl.textContent = d.quote.depositAddress;
    depositAmountEl.textContent = (parseFloat(d.quote.amountOut) / 1e6).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}) + ' USDC';
    const venc = new Date(d.quote.deadline);
    depositDeadlineEl.textContent = venc.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

    depositoResult.style.display = 'block';
    depositoStatus.textContent = 'Listo — revisá que las direcciones de arriba sean las tuyas antes de mandar los fondos.';
  } catch (err) {
    depositoStatus.innerHTML = `<span class="error">Error: ${esc(err.message || 'API no disponible')}</span>`;
  }

  btnGenerarDeposito.disabled = false;
});
