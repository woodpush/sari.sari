// app.js — Tindahan: inventory, sales and profit for a sari-sari store.
import * as db from './db.js';
import * as cloud from './cloud.js';

const APP_VERSION = '0.2.0';
const $ = (id) => document.getElementById(id);

/* ---------- Helpers ---------- */

const pesoFmt = new Intl.NumberFormat('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const peso = (cents) => (cents < 0 ? '−₱' : '₱') + pesoFmt.format(Math.abs(cents) / 100);

// "12.5" -> 1250 centavos. Returns null if not a valid amount.
function toCents(value) {
  const s = String(value ?? '').replace(/[₱,\s]/g, '');
  if (s === '' || !/^\d*\.?\d{0,2}$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}
const centsToInput = (c) => (c / 100).toFixed(2);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function markupText(buy, sell) {
  if (buy == null || sell == null) return '';
  const profit = sell - buy;
  if (profit < 0) return `<span class="neg">Selling below cost: loss of ${peso(-profit)} per piece</span>`;
  const pct = buy > 0 ? Math.round((profit / buy) * 100) : 0;
  return `Profit ${peso(profit)} per piece · ${pct}% markup on cost`;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function feedback() {
  if (navigator.vibrate) navigator.vibrate(60);
}

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

/* ---------- State ---------- */

let products = [];
let cart = []; // [{ productId, qty }]
const settings = { storeName: 'Tindahan', lowStock: 5 };

async function refreshProducts() {
  products = await db.allProducts();
}
const productById = (id) => products.find((p) => p.id === id);
const lowLimit = (p) => (p.lowStock ?? settings.lowStock);

function searchProducts(q, limit = 8) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  return products
    .filter((p) => {
      const hay = `${p.name} ${p.category} ${p.barcode}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .slice(0, limit);
}

/* ---------- Navigation ---------- */

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  document.querySelectorAll('.tabs button').forEach((b) => {
    if (b.dataset.view === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (name === 'items') renderItems();
  if (name === 'restock') renderRestockLog();
  if (name === 'reports') renderReports();
  if (name === 'more') { fillSettings(); fillCloudForm(); }
  const focusable = { sell: 'sellScan', restock: 'restockScan' }[name];
  if (focusable && matchMedia('(pointer: fine)').matches) $(focusable).focus();
}

document.querySelectorAll('.tabs button').forEach((b) =>
  b.addEventListener('click', () => showView(b.dataset.view)));

/* ---------- Scan / search input ----------
   Works with USB/Bluetooth barcode scanners (they type the code and press Enter),
   with typing, and with the phone camera. */

function attachScanInput(input, suggestEl, { onPick, onUnknown }) {
  function renderSuggest() {
    const hits = searchProducts(input.value);
    if (!hits.length) { suggestEl.hidden = true; suggestEl.innerHTML = ''; return; }
    suggestEl.innerHTML = hits.map((p) => `
      <li><button type="button" data-id="${p.id}">
        <span class="s-name">${esc(p.name)}</span>
        <span class="s-meta">${peso(p.sellPrice)} · ${p.stock ?? 0} left</span>
      </button></li>`).join('');
    suggestEl.hidden = false;
  }

  async function submit(raw) {
    const value = String(raw ?? input.value).trim();
    if (!value) return;
    const exact = await db.findByBarcode(value);
    if (exact) return finish(exact);
    const hits = searchProducts(value);
    if (hits.length === 1) return finish(hits[0]);
    if (hits.length === 0) {
      input.value = '';
      suggestEl.hidden = true;
      return onUnknown(value);
    }
    renderSuggest();
  }

  function finish(p) {
    input.value = '';
    suggestEl.hidden = true;
    feedback();
    onPick(p);
  }

  input.addEventListener('input', renderSuggest);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { input.value = ''; suggestEl.hidden = true; }
  });
  suggestEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-id]');
    if (btn) finish(productById(Number(btn.dataset.id)));
  });
  return { submit };
}

/* ---------- Camera scanner ---------- */

const cameraHandlers = {}; // inputId -> function(code)
let scanner = null;

async function openCamera(targetId) {
  const dlg = $('camDialog');
  $('camError').textContent = '';
  dlg.showModal();
  if (typeof Html5Qrcode === 'undefined') {
    $('camError').textContent = 'The scanner could not load. Type the barcode instead.';
    return;
  }
  const F = Html5QrcodeSupportedFormats;
  scanner = new Html5Qrcode('camReader', {
    formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF, F.QR_CODE],
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    verbose: false,
  });
  let handled = false;
  try {
    await scanner.start(
      { facingMode: 'environment' },
      { fps: 12, qrbox: (w, h) => ({ width: Math.min(w * 0.85, 320), height: Math.min(h * 0.45, 160) }) },
      async (code) => {
        if (handled) return;
        handled = true;
        await closeCamera();
        feedback();
        const handler = cameraHandlers[targetId];
        if (handler) handler(code);
        else $(targetId).value = code;
      },
      () => {},
    );
  } catch (err) {
    $('camError').textContent = location.protocol === 'http:' && location.hostname !== 'localhost'
      ? 'The camera needs a secure (https) address. Open the app from its GitHub Pages link.'
      : 'Camera not available. Allow camera access in your browser settings, or type the barcode.';
  }
}

async function closeCamera() {
  if (scanner) {
    try { if (scanner.isScanning) await scanner.stop(); scanner.clear(); } catch { /* already stopped */ }
    scanner = null;
  }
  $('camDialog').close();
}

$('camClose').addEventListener('click', closeCamera);
$('camDialog').addEventListener('cancel', (e) => { e.preventDefault(); closeCamera(); });
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-camera]');
  if (b) openCamera(b.dataset.camera);
});

/* ---------- Item editor ---------- */

let itemSavedCallback = null;

async function openItemDialog(product = null, { barcode = '', onSaved = null } = {}) {
  itemSavedCallback = onSaved;
  const isNew = !product;
  $('itemFormTitle').textContent = isNew ? 'Add item' : 'Edit item';
  $('fId').value = product?.id ?? '';
  $('fBarcode').value = product?.barcode ?? barcode;
  $('fName').value = product?.name ?? '';
  $('fCategory').value = product?.category ?? '';
  $('fBuy').value = product ? centsToInput(product.buyPrice) : '';
  $('fSell').value = product ? centsToInput(product.sellPrice) : '';
  $('fStock').value = product?.stock ?? 0;
  $('fLow').value = product?.lowStock ?? '';
  $('fDelete').hidden = isNew;
  $('fError').textContent = '';
  const cats = [...new Set(products.map((p) => p.category).filter(Boolean))].sort();
  $('categoryList').innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join('');
  updateItemCalc();
  $('itemDialog').showModal();
  (barcode ? $('fName') : isNew ? $('fBarcode') : $('fName')).focus();
}

function updateItemCalc() {
  $('fCalc').innerHTML = markupText(toCents($('fBuy').value), toCents($('fSell').value));
}
['fBuy', 'fSell'].forEach((id) => $(id).addEventListener('input', updateItemCalc));
$('fCancel').addEventListener('click', () => $('itemDialog').close());
// Enter inside the barcode field (from a USB scanner) should jump to the name, not submit.
$('fBarcode').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('fName').focus(); }
});
cameraHandlers.fBarcode = (code) => { $('fBarcode').value = code; $('fName').focus(); };

$('itemForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('fError');
  const buy = toCents($('fBuy').value);
  const sell = toCents($('fSell').value);
  const name = $('fName').value.trim();
  if (!name) { err.textContent = 'Enter the item name.'; return; }
  if (buy == null) { err.textContent = 'Enter the buy price, for example 12.50.'; return; }
  if (sell == null) { err.textContent = 'Enter the sell price, for example 15.00.'; return; }
  const stock = parseInt($('fStock').value, 10);
  const low = $('fLow').value === '' ? null : parseInt($('fLow').value, 10);
  const idVal = $('fId').value;
  const product = {
    ...(idVal ? productById(Number(idVal)) : {}),
    barcode: $('fBarcode').value.trim() || await db.nextInternalCode(),
    name, category: $('fCategory').value, buyPrice: buy, sellPrice: sell,
    stock: Number.isFinite(stock) ? stock : 0, lowStock: low,
  };
  if (idVal) product.id = Number(idVal);
  try {
    const id = await db.saveProduct(product);
    await refreshProducts();
    $('itemDialog').close();
    markChanged();
    toast(idVal ? 'Item saved' : 'Item added');
    renderItems();
    if (itemSavedCallback) itemSavedCallback(productById(id));
    itemSavedCallback = null;
  } catch (ex) {
    err.textContent = ex?.name === 'ConstraintError'
      ? 'Another item already uses this barcode. Search for it in Items.'
      : 'Could not save: ' + (ex?.message || ex);
  }
});

$('fDelete').addEventListener('click', async () => {
  const id = Number($('fId').value);
  const p = productById(id);
  if (!p || !confirm(`Delete "${p.name}"? Past sales keep their records.`)) return;
  await db.deleteProduct(id);
  cart = cart.filter((c) => c.productId !== id);
  await refreshProducts();
  $('itemDialog').close();
  markChanged();
  toast('Item deleted');
  renderItems();
  renderCart();
});

function offerToAdd(code, onSaved) {
  const looksLikeBarcode = /^[0-9A-Za-z-]{4,}$/.test(code) && /\d/.test(code);
  const msg = looksLikeBarcode
    ? `Barcode ${code} is not in your items yet. Add it now?`
    : `No item matches "${code}". Add a new item?`;
  if (confirm(msg)) {
    openItemDialog(null, { barcode: looksLikeBarcode ? code : '', onSaved });
    if (!looksLikeBarcode) $('fName').value = code;
  }
}

/* ---------- Sell ---------- */

function addToCart(p, qty = 1) {
  const line = cart.find((c) => c.productId === p.id);
  if (line) line.qty += qty;
  else cart.unshift({ productId: p.id, qty });
  renderCart();
  const inCart = cart.find((c) => c.productId === p.id).qty;
  if ((p.stock ?? 0) < inCart) toast(`${p.name}: only ${p.stock ?? 0} in stock`, true);
}

const sellInput = attachScanInput($('sellScan'), $('sellSuggest'), {
  onPick: (p) => addToCart(p),
  onUnknown: (code) => offerToAdd(code, (p) => addToCart(p)),
});
cameraHandlers.sellScan = (code) => sellInput.submit(code);

function cartTotal() {
  return cart.reduce((t, c) => t + (productById(c.productId)?.sellPrice ?? 0) * c.qty, 0);
}

function renderCart() {
  const list = $('cart');
  const total = cartTotal();
  const pieces = cart.reduce((t, c) => t + c.qty, 0);
  $('cartTotal').textContent = peso(total);
  $('cartCount').textContent = pieces ? `${pieces} piece${pieces > 1 ? 's' : ''}, ${cart.length} item${cart.length > 1 ? 's' : ''}` : 'No items yet';
  $('checkout').hidden = cart.length === 0;
  list.innerHTML = cart.map((c) => {
    const p = productById(c.productId);
    if (!p) return '';
    const short = (p.stock ?? 0) < c.qty;
    return `
      <li class="${short ? 'short' : ''}">
        <div class="c-main">
          <span class="c-name">${esc(p.name)}</span>
          <span class="c-meta">${peso(p.sellPrice)} each${short ? ` · only ${p.stock ?? 0} in stock` : ''}</span>
        </div>
        <div class="qty">
          <button type="button" data-dec="${p.id}" aria-label="One less">−</button>
          <input type="number" inputmode="numeric" min="1" value="${c.qty}" data-qty="${p.id}" aria-label="Quantity">
          <button type="button" data-inc="${p.id}" aria-label="One more">+</button>
        </div>
        <span class="c-total">${peso(p.sellPrice * c.qty)}</span>
        <button type="button" class="c-remove" data-remove="${p.id}" aria-label="Remove ${esc(p.name)}">✕</button>
      </li>`;
  }).join('');
  renderQuickCash(total);
  updateChange();
}

$('cart').addEventListener('click', (e) => {
  const t = e.target;
  const find = (id) => cart.find((c) => c.productId === Number(id));
  if (t.dataset.inc) { find(t.dataset.inc).qty++; renderCart(); }
  if (t.dataset.dec) {
    const line = find(t.dataset.dec);
    line.qty--;
    if (line.qty <= 0) cart = cart.filter((c) => c !== line);
    renderCart();
  }
  if (t.dataset.remove) { cart = cart.filter((c) => c.productId !== Number(t.dataset.remove)); renderCart(); }
});
$('cart').addEventListener('change', (e) => {
  if (!e.target.dataset.qty) return;
  const line = cart.find((c) => c.productId === Number(e.target.dataset.qty));
  const q = parseInt(e.target.value, 10);
  if (!Number.isFinite(q) || q <= 0) cart = cart.filter((c) => c !== line);
  else line.qty = q;
  renderCart();
});

function renderQuickCash(total) {
  const bills = [2000, 5000, 10000, 20000, 50000, 100000]; // ₱20 to ₱1000
  const opts = [total, ...bills.filter((b) => b > total)].slice(0, 5);
  $('quickCash').innerHTML = total ? opts.map((v, i) =>
    `<button type="button" data-cash="${v}">${i === 0 ? 'Exact' : peso(v).replace('.00', '')}</button>`).join('') : '';
}
$('quickCash').addEventListener('click', (e) => {
  const v = e.target.dataset.cash;
  if (v) { $('cashIn').value = centsToInput(Number(v)); updateChange(); }
});

function updateChange() {
  const cash = toCents($('cashIn').value);
  const total = cartTotal();
  const out = $('changeOut');
  if (cash == null || $('cashIn').value === '') { out.textContent = ''; out.className = 'change'; return; }
  const diff = cash - total;
  out.className = 'change' + (diff < 0 ? ' neg' : '');
  out.textContent = diff >= 0 ? `Change: ${peso(diff)}` : `Short by ${peso(-diff)}`;
}
$('cashIn').addEventListener('input', updateChange);

$('clearCart').addEventListener('click', () => {
  if (cart.length && !confirm('Remove all items from this sale?')) return;
  cart = [];
  $('cashIn').value = '';
  renderCart();
});

$('completeSale').addEventListener('click', async () => {
  if (!cart.length) return;
  const cashRaw = $('cashIn').value.trim();
  const cash = cashRaw ? toCents(cashRaw) : null;
  const total = cartTotal();
  if (cashRaw && cash == null) { toast('Cash received is not a valid amount', true); return; }
  if (cash != null && cash < total) { toast(`Cash is short by ${peso(total - cash)}`, true); return; }
  try {
    const sale = await db.recordSale(cart, cash);
    await refreshProducts();
    cart = [];
    $('cashIn').value = '';
    renderCart();
    markChanged();
    toast(sale.change != null ? `Sale saved. Change ${peso(sale.change)}` : `Sale saved: ${peso(sale.total)}`);
    $('sellScan').focus();
  } catch (ex) {
    toast('Could not save sale: ' + ex.message, true);
  }
});

/* ---------- Items ---------- */

function renderItems() {
  const q = $('itemSearch').value;
  const list = q.trim() ? searchProducts(q, 500) : products;
  $('itemCount').textContent = q.trim()
    ? `${list.length} of ${products.length} items`
    : `${products.length} item${products.length === 1 ? '' : 's'}`;
  if (!products.length) {
    $('itemList').innerHTML = `<li class="empty">No items yet. Tap <b>Add item</b> or scan a product to start your list.</li>`;
    return;
  }
  $('itemList').innerHTML = list.map((p) => {
    const low = (p.stock ?? 0) <= lowLimit(p);
    return `
      <li><button type="button" class="row" data-edit="${p.id}">
        <span class="r-main">
          <span class="r-name">${esc(p.name)}</span>
          <span class="r-meta">${esc(p.category || 'No category')} · ${esc(p.barcode)}</span>
        </span>
        <span class="r-side">
          <span class="r-price">${peso(p.sellPrice)}</span>
          <span class="r-stock ${low ? 'neg' : ''}">${p.stock ?? 0} in stock</span>
        </span>
      </button></li>`;
  }).join('') || `<li class="empty">Nothing matches. Scan the barcode or tap Add item.</li>`;
}

$('itemSearch').addEventListener('input', renderItems);
$('itemSearch').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const code = $('itemSearch').value.trim();
  if (!code) return;
  const exact = await db.findByBarcode(code);
  if (exact) { $('itemSearch').value = ''; renderItems(); openItemDialog(exact); }
  else if (!searchProducts(code).length) { $('itemSearch').value = ''; renderItems(); offerToAdd(code); }
});
cameraHandlers.itemSearch = async (code) => {
  const exact = await db.findByBarcode(code);
  if (exact) openItemDialog(exact);
  else offerToAdd(code);
};
$('itemList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-edit]');
  if (b) openItemDialog(productById(Number(b.dataset.edit)));
});
$('addItem').addEventListener('click', () => openItemDialog());

/* ---------- Restock ---------- */

let restockProduct = null;

function startRestock(p) {
  restockProduct = p;
  $('restockName').textContent = p.name;
  $('restockInfo').textContent = `${p.stock ?? 0} in stock now · last bought at ${peso(p.buyPrice)}`;
  $('rsQty').value = '';
  $('rsBuy').value = centsToInput(p.buyPrice);
  $('rsSell').value = centsToInput(p.sellPrice);
  updateRestockCalc();
  $('restockForm').hidden = false;
  $('rsQty').focus();
}

function updateRestockCalc() {
  const qty = parseInt($('rsQty').value, 10) || 0;
  const buy = toCents($('rsBuy').value);
  const sell = toCents($('rsSell').value);
  const parts = [];
  if (qty && buy != null) parts.push(`You paid ${peso(qty * buy)} in total`);
  const m = markupText(buy, sell);
  if (m) parts.push(m);
  $('rsCalc').innerHTML = parts.join('<br>');
}
['rsQty', 'rsBuy', 'rsSell'].forEach((id) => $(id).addEventListener('input', updateRestockCalc));

const restockInput = attachScanInput($('restockScan'), $('restockSuggest'), {
  onPick: startRestock,
  onUnknown: (code) => offerToAdd(code, startRestock),
});
cameraHandlers.restockScan = (code) => restockInput.submit(code);

$('rsCancel').addEventListener('click', () => { $('restockForm').hidden = true; restockProduct = null; });

$('restockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!restockProduct) return;
  const qty = parseInt($('rsQty').value, 10);
  const buy = toCents($('rsBuy').value);
  const sell = toCents($('rsSell').value);
  if (!Number.isFinite(qty) || qty <= 0) return toast('Enter how many pieces you added', true);
  if (buy == null || sell == null) return toast('Enter valid prices, for example 12.50', true);
  await db.recordRestock({ productId: restockProduct.id, qty, buyPrice: buy, sellPrice: sell });
  await refreshProducts();
  markChanged();
  toast(`Added ${qty} × ${restockProduct.name}`);
  $('restockForm').hidden = true;
  restockProduct = null;
  renderRestockLog();
  $('restockScan').focus();
});

async function renderRestockLog() {
  const rows = (await db.allRestocks()).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15);
  $('restockLog').innerHTML = rows.length ? rows.map((r) => `
    <li><span class="r-main"><span class="r-name">${esc(r.name)}</span>
      <span class="r-meta">${new Date(r.date).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}</span></span>
      <span class="r-side"><span>+${r.qty}</span><span class="r-meta">${peso(r.totalCost)}</span></span></li>`).join('')
    : `<li class="empty">Restocks you record will show here.</li>`;
}

/* ---------- Reports ---------- */

let period = 'today';

function periodRange(p) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (p === 'week') start.setDate(start.getDate() - 6);
  if (p === 'month') start.setDate(1);
  const from = p === 'all' ? '0000' : start.toISOString();
  return [from, '9999'];
}

document.querySelectorAll('#periodTabs button').forEach((b) => b.addEventListener('click', () => {
  period = b.dataset.period;
  document.querySelectorAll('#periodTabs button').forEach((x) =>
    x.setAttribute('aria-selected', String(x === b)));
  renderReports();
}));

function ledgerRows(rows) {
  return rows.map(([label, value, cls = '']) =>
    `<div class="l-row ${cls}"><span>${label}</span><span>${value}</span></div>`).join('');
}

async function renderReports() {
  const [from, to] = periodRange(period);
  const sales = await db.salesBetween(from, to);
  const restocks = await db.restocksBetween(from, to);
  const total = sales.reduce((t, s) => t + s.total, 0);
  const cost = sales.reduce((t, s) => t + s.cost, 0);
  const profit = total - cost;
  const spent = restocks.reduce((t, r) => t + r.totalCost, 0);
  const margin = total ? Math.round((profit / total) * 100) : 0;

  $('ledger').innerHTML = ledgerRows([
    ['Sales', peso(total)],
    ['Cost of items sold', peso(cost)],
    ['Gross profit', peso(profit), 'strong' + (profit < 0 ? ' neg' : '')],
    ['Profit margin', `${margin}%`],
    ['Number of sales', String(sales.length)],
    ['Spent on restocking', peso(spent), 'muted'],
  ]);

  const agg = new Map();
  for (const s of sales) for (const i of s.items) {
    const a = agg.get(i.productId) || { name: i.name, qty: 0, sales: 0, profit: 0 };
    a.qty += i.qty;
    a.sales += i.sellPrice * i.qty;
    a.profit += (i.sellPrice - i.buyPrice) * i.qty;
    agg.set(i.productId, a);
  }
  const top = [...agg.values()].sort((a, b) => b.profit - a.profit).slice(0, 10);
  $('topItems').innerHTML = top.length ? top.map((a) => `
    <li><span class="r-main"><span class="r-name">${esc(a.name)}</span>
      <span class="r-meta">${a.qty} sold · ${peso(a.sales)} sales</span></span>
      <span class="r-side"><span>${peso(a.profit)}</span><span class="r-meta">profit</span></span></li>`).join('')
    : `<li class="empty">No sales in this period yet.</li>`;

  const low = products.filter((p) => (p.stock ?? 0) <= lowLimit(p))
    .sort((a, b) => (a.stock ?? 0) - (b.stock ?? 0));
  $('lowStock').innerHTML = low.length ? low.map((p) => `
    <li><span class="r-main"><span class="r-name">${esc(p.name)}</span>
      <span class="r-meta">Warn at ${lowLimit(p)}</span></span>
      <span class="r-side"><span class="neg">${p.stock ?? 0} left</span></span></li>`).join('')
    : `<li class="empty">Everything is well stocked.</li>`;

  const onHand = products.filter((p) => (p.stock ?? 0) > 0);
  const atCost = onHand.reduce((t, p) => t + p.stock * p.buyPrice, 0);
  const atRetail = onHand.reduce((t, p) => t + p.stock * p.sellPrice, 0);
  $('stockValue').innerHTML = ledgerRows([
    ['Worth at buy price', peso(atCost)],
    ['Worth at sell price', peso(atRetail)],
    ['Profit if all sold', peso(atRetail - atCost), 'strong'],
  ]);

  const recent = sales.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 50);
  $('saleLog').innerHTML = recent.length ? recent.map((s) => `
    <li><span class="r-main">
        <span class="r-name">${s.items.map((i) => `${i.qty}× ${esc(i.name)}`).join(', ')}</span>
        <span class="r-meta">${new Date(s.date).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })} · profit ${peso(s.profit)}</span></span>
      <span class="r-side"><span>${peso(s.total)}</span>
        <button type="button" class="linkbtn" data-void="${s.id}">Void</button></span></li>`).join('')
    : `<li class="empty">No sales in this period yet.</li>`;
}

$('saleLog').addEventListener('click', async (e) => {
  const id = e.target.dataset.void;
  if (!id || !confirm('Void this sale? Its items go back into stock and it is removed from reports.')) return;
  await db.voidSale(Number(id));
  await refreshProducts();
  markChanged();
  toast('Sale voided');
  renderReports();
});

/* ---------- Settings & backup ---------- */

function fillSettings() {
  $('setName').value = settings.storeName;
  $('setLow').value = settings.lowStock;
}

$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  settings.storeName = $('setName').value.trim() || 'Tindahan';
  settings.lowStock = Math.max(0, parseInt($('setLow').value, 10) || 0);
  await db.setSetting('storeName', settings.storeName);
  await db.setSetting('lowStock', settings.lowStock);
  applySettings();
  markChanged();
  toast('Settings saved');
});

function applySettings() {
  $('storeName').textContent = settings.storeName;
  document.title = settings.storeName;
}

/* ---------- Backups: phone and cloud ---------- */

const DAY = 86400000;
let lastChange = 0;

// Call after anything that changes the data, so auto-backup knows there is news.
function markChanged() {
  lastChange = Date.now();
  db.setSetting('local.lastChange', lastChange);
  maybeAutoBackup();
}

function ago(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return `${Math.round(ms / 60000)} min ago`;
  if (ms < DAY) return `${Math.round(ms / 3600000)} h ago`;
  const d = Math.round(ms / DAY);
  return `${d} day${d > 1 ? 's' : ''} ago`;
}

async function backupFile() {
  const data = await db.exportAll();
  const name = `tindahan-backup-${stamp()}.json`;
  return { name, text: JSON.stringify(data) };
}

async function afterLocalBackup() {
  await db.setSetting('local.lastBackup', new Date().toISOString());
  renderBackupStatus();
}

$('exportJson').addEventListener('click', async () => {
  const { name, text } = await backupFile();
  download(name, text, 'application/json');
  await afterLocalBackup();
});

// Share sheet: lets the owner save the backup to Google Drive, email, Messenger, Files…
if (navigator.canShare && navigator.canShare({ files: [new File(['x'], 't.json', { type: 'application/json' })] })) {
  $('shareJson').hidden = false;
}
$('shareJson').addEventListener('click', async () => {
  const { name, text } = await backupFile();
  const file = new File([text], name, { type: 'application/json' });
  try {
    await navigator.share({ files: [file], title: name });
    await afterLocalBackup();
  } catch (ex) {
    if (ex.name !== 'AbortError') toast('Could not share: ' + ex.message, true);
  }
});

$('importJson').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!confirm('Restoring replaces ALL current items, sales and restocks with the backup. Continue?')) return;
  try {
    await restoreData(JSON.parse(await file.text()));
  } catch (ex) {
    toast(ex.message || 'Could not read that file', true);
  }
});

async function restoreData(data) {
  await db.importAll(data);
  await loadSettings();
  await refreshProducts();
  cart = [];
  renderCart();
  renderItems();
  toast('Backup restored');
}

/* Cloud (GitHub) */

async function cloudConfig() {
  return {
    repo: await db.getSetting('local.ghRepo', ''),
    token: await db.getSetting('local.ghToken', ''),
    every: Number(await db.getSetting('local.ghEvery', 60)),
  };
}

let cloudBusy = false;

async function runCloudBackup({ silent = false } = {}) {
  const cfg = await cloudConfig();
  if (!cfg.repo || !cfg.token) {
    if (!silent) toast('Set up the repository and token first', true);
    return false;
  }
  if (cloudBusy) return false;
  cloudBusy = true;
  setCloudStatus('Backing up…');
  try {
    const data = await db.exportAll();
    await cloud.backup(cfg, data);
    await db.setSetting('local.lastCloud', new Date().toISOString());
    await db.setSetting('local.cloudError', '');
    if (!silent) toast('Backed up to GitHub');
    return true;
  } catch (ex) {
    await db.setSetting('local.cloudError', ex.message);
    if (!silent) toast(ex.message, true);
    return false;
  } finally {
    cloudBusy = false;
    renderBackupStatus();
  }
}

async function maybeAutoBackup() {
  const cfg = await cloudConfig();
  if (!cfg.repo || !cfg.token || !cfg.every || !navigator.onLine) return;
  const last = await db.getSetting('local.lastCloud', null);
  const lastMs = last ? new Date(last).getTime() : 0;
  if (lastChange <= lastMs) return; // nothing new since the last backup
  if (Date.now() - lastMs < cfg.every * 60000) return;
  runCloudBackup({ silent: true });
}

function setCloudStatus(text, isError = false) {
  const el = $('cloudStatus');
  el.textContent = text;
  el.classList.toggle('neg', isError);
}

async function renderBackupStatus() {
  const cfg = await cloudConfig();
  const lastLocal = await db.getSetting('local.lastBackup', null);
  const lastCloud = await db.getSetting('local.lastCloud', null);
  const err = await db.getSetting('local.cloudError', '');
  $('localStatus').textContent = `Last saved to phone: ${ago(lastLocal)}`;
  if (!cfg.repo || !cfg.token) setCloudStatus('Not set up yet.');
  else if (err) setCloudStatus(`Last attempt failed: ${err}`, true);
  else setCloudStatus(`Last cloud backup: ${ago(lastCloud)}`);

  // Reminder on the Sell screen when no backup is recent.
  const newest = Math.max(lastLocal ? new Date(lastLocal).getTime() : 0, lastCloud ? new Date(lastCloud).getTime() : 0);
  const stale = products.length > 0 && Date.now() - newest > 3 * DAY;
  const banner = $('backupBanner');
  banner.hidden = !stale && !(cfg.repo && err && products.length);
  banner.textContent = err && cfg.repo
    ? 'Cloud backup is failing. Tap to check.'
    : `No backup ${newest ? 'for ' + ago(new Date(newest).toISOString()).replace(' ago', '') : 'yet'}. Tap to back up.`;
}
$('backupBanner').addEventListener('click', () => showView('more'));

async function fillCloudForm() {
  const cfg = await cloudConfig();
  $('ghRepo').value = cfg.repo;
  $('ghToken').value = cfg.token;
  $('ghEvery').value = String(cfg.every);
  renderBackupStatus();
}

$('cloudForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const repo = cloud.parseRepo($('ghRepo').value);
  const token = $('ghToken').value.trim();
  if (!repo) { setCloudStatus('Enter the repository as owner/name, for example woodpush/sari-sari-backup.', true); return; }
  if (!token) { setCloudStatus('Paste your GitHub access token.', true); return; }
  setCloudStatus('Checking…');
  try {
    const info = await cloud.testConnection({ repo, token });
    await db.setSetting('local.ghRepo', repo);
    await db.setSetting('local.ghToken', token);
    await db.setSetting('local.ghEvery', Number($('ghEvery').value));
    await db.setSetting('local.cloudError', '');
    $('ghRepo').value = repo;
    setCloudStatus(`Connected to ${info.name} (private). Making the first backup…`);
    await runCloudBackup();
  } catch (ex) {
    setCloudStatus(ex.message, true);
  }
});

$('ghEvery').addEventListener('change', async () => {
  if (await db.getSetting('local.ghRepo', '')) {
    await db.setSetting('local.ghEvery', Number($('ghEvery').value));
    toast('Auto backup updated');
  }
});

$('cloudNow').addEventListener('click', () => runCloudBackup());

$('cloudRestore').addEventListener('click', async () => {
  const cfg = await cloudConfig();
  if (!cfg.repo || !cfg.token) { toast('Set up the repository and token first', true); return; }
  const list = $('restoreList');
  list.innerHTML = '<li class="empty">Loading backups…</li>';
  $('restoreDialog').showModal();
  try {
    const files = (await cloud.listBackups(cfg)).slice(0, 40);
    list.innerHTML = files.length ? files.map((f) => `
      <li><span class="r-main"><span class="r-name">${f.name === 'latest' ? 'Latest backup' : esc(f.name)}</span>
        <span class="r-meta">${Math.max(1, Math.round(f.size / 1024))} KB</span></span>
        <button type="button" class="btn small" data-path="${esc(f.path)}">Restore</button></li>`).join('')
      : '<li class="empty">No backups in this repository yet.</li>';
  } catch (ex) {
    list.innerHTML = `<li class="empty neg">${esc(ex.message)}</li>`;
  }
});
$('restoreList').addEventListener('click', async (e) => {
  const path = e.target.dataset.path;
  if (!path) return;
  if (!confirm('Replace ALL data on this phone with this backup?')) return;
  try {
    const cfg = await cloudConfig();
    await restoreData(await cloud.download(cfg, path));
    $('restoreDialog').close();
  } catch (ex) {
    toast(ex.message, true);
  }
});
$('restoreClose').addEventListener('click', () => $('restoreDialog').close());

window.addEventListener('online', maybeAutoBackup);
setInterval(maybeAutoBackup, 5 * 60000);

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n');

$('exportItemsCsv').addEventListener('click', () => {
  const rows = [['barcode', 'name', 'category', 'buy_price', 'sell_price', 'stock', 'low_stock']];
  for (const p of products) {
    rows.push([p.barcode, p.name, p.category, centsToInput(p.buyPrice), centsToInput(p.sellPrice), p.stock ?? 0, p.lowStock ?? '']);
  }
  download(`tindahan-items-${stamp()}.csv`, toCsv(rows), 'text/csv');
});

$('exportSalesCsv').addEventListener('click', async () => {
  const rows = [['sale_id', 'date', 'barcode', 'name', 'qty', 'buy_price', 'sell_price', 'line_total', 'line_profit']];
  const sales = (await db.allSales()).sort((a, b) => a.date.localeCompare(b.date));
  for (const s of sales) for (const i of s.items) {
    rows.push([s.id, s.date, i.barcode, i.name, i.qty, centsToInput(i.buyPrice), centsToInput(i.sellPrice),
      centsToInput(i.sellPrice * i.qty), centsToInput((i.sellPrice - i.buyPrice) * i.qty)]);
  }
  download(`tindahan-sales-${stamp()}.csv`, toCsv(rows), 'text/csv');
});

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

$('importCsv').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const rows = parseCsv(await file.text());
  const head = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  const col = (name) => head.indexOf(name);
  if (col('name') < 0 || col('sell_price') < 0) {
    toast('The CSV needs at least "name" and "sell_price" columns', true);
    return;
  }
  let added = 0, updated = 0, skipped = 0;
  for (const r of rows) {
    const get = (n) => (col(n) >= 0 ? (r[col(n)] ?? '').trim() : '');
    const name = get('name');
    const sell = toCents(get('sell_price'));
    if (!name || sell == null) { skipped++; continue; }
    const barcode = get('barcode');
    const existing = barcode ? await db.findByBarcode(barcode) : null;
    const stock = parseInt(get('stock'), 10);
    const low = parseInt(get('low_stock'), 10);
    await db.saveProduct({
      ...(existing || {}),
      barcode: barcode || await db.nextInternalCode(),
      name,
      category: get('category') || existing?.category || '',
      buyPrice: toCents(get('buy_price')) ?? existing?.buyPrice ?? 0,
      sellPrice: sell,
      stock: Number.isFinite(stock) ? stock : existing?.stock ?? 0,
      lowStock: Number.isFinite(low) ? low : existing?.lowStock ?? null,
    });
    existing ? updated++ : added++;
  }
  await refreshProducts();
  renderItems();
  markChanged();
  toast(`${added} added, ${updated} updated${skipped ? `, ${skipped} skipped` : ''}`);
});

/* ---------- Start ---------- */

async function loadSettings() {
  settings.storeName = await db.getSetting('storeName', 'Tindahan');
  settings.lowStock = await db.getSetting('lowStock', 5);
  applySettings();
}

async function init() {
  $('appVersion').textContent = 'v' + APP_VERSION;
  $('todayLabel').textContent = new Date().toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' });
  await db.openDB();
  await loadSettings();
  await refreshProducts();
  lastChange = Number(await db.getSetting('local.lastChange', 0));
  renderCart();
  showView('sell');
  renderBackupStatus();
  maybeAutoBackup();
  if (navigator.storage?.persist) navigator.storage.persist(); // ask the browser not to clear our data
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
