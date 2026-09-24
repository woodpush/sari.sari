// db.js — local database (IndexedDB). All data stays on this device.
// Money is stored as integer centavos to avoid rounding errors (₱12.50 -> 1250).

const DB_NAME = 'tindahan';
const DB_VERSION = 1;
let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('products')) {
        const s = db.createObjectStore('products', { keyPath: 'id', autoIncrement: true });
        s.createIndex('barcode', 'barcode', { unique: true });
        s.createIndex('name', 'name');
      }
      if (!db.objectStoreNames.contains('sales')) {
        const s = db.createObjectStore('sales', { keyPath: 'id', autoIncrement: true });
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('restocks')) {
        const s = db.createObjectStore('restocks', { keyPath: 'id', autoIncrement: true });
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

/* ---------- Products ---------- */

export async function allProducts() {
  const list = await wrap((await store('products')).getAll());
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getProduct(id) {
  return wrap((await store('products')).get(id));
}

export async function findByBarcode(code) {
  const s = await store('products');
  return wrap(s.index('barcode').get(String(code).trim()));
}

// Items with no printed barcode (eggs, ice, loose rice) get an internal code.
export async function nextInternalCode() {
  const list = await allProducts();
  let max = 0;
  for (const p of list) {
    const m = /^ITEM-(\d+)$/.exec(p.barcode);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return 'ITEM-' + String(max + 1).padStart(4, '0');
}

export async function saveProduct(p) {
  const clean = {
    ...p,
    barcode: String(p.barcode).trim(),
    name: String(p.name).trim(),
    category: String(p.category || '').trim(),
    updatedAt: new Date().toISOString(),
  };
  if (clean.id == null) delete clean.id;
  const s = await store('products', 'readwrite');
  return wrap(s.put(clean)); // returns id
}

export async function deleteProduct(id) {
  return wrap((await store('products', 'readwrite')).delete(id));
}

/* ---------- Sales ---------- */

// cart: [{ productId, qty }]. Prices are read fresh from the DB and snapshotted
// into the sale, so later price changes don't rewrite past profit.
export async function recordSale(cart, cashReceived) {
  const db = await openDB();
  const tx = db.transaction(['products', 'sales'], 'readwrite');
  const ps = tx.objectStore('products');
  const items = [];
  for (const line of cart) {
    const p = await wrap(ps.get(line.productId));
    if (!p) throw new Error('Item no longer exists');
    p.stock = (p.stock || 0) - line.qty;
    p.updatedAt = new Date().toISOString();
    ps.put(p);
    items.push({
      productId: p.id, barcode: p.barcode, name: p.name, qty: line.qty,
      buyPrice: p.buyPrice, sellPrice: p.sellPrice,
    });
  }
  const total = items.reduce((t, i) => t + i.sellPrice * i.qty, 0);
  const cost = items.reduce((t, i) => t + i.buyPrice * i.qty, 0);
  const sale = {
    date: new Date().toISOString(), items, total, cost, profit: total - cost,
    cash: cashReceived ?? null, change: cashReceived != null ? cashReceived - total : null,
  };
  const req = tx.objectStore('sales').add(sale);
  await done(tx);
  sale.id = req.result;
  return sale;
}

// Undo a sale made by mistake: puts the stock back and removes the record.
export async function voidSale(id) {
  const db = await openDB();
  const tx = db.transaction(['products', 'sales'], 'readwrite');
  const ss = tx.objectStore('sales');
  const ps = tx.objectStore('products');
  const sale = await wrap(ss.get(id));
  if (!sale) return;
  for (const i of sale.items) {
    const p = await wrap(ps.get(i.productId));
    if (p) { p.stock = (p.stock || 0) + i.qty; ps.put(p); }
  }
  ss.delete(id);
  return done(tx);
}

export async function salesBetween(fromISO, toISO) {
  const s = await store('sales');
  const range = IDBKeyRange.bound(fromISO, toISO);
  return wrap(s.index('date').getAll(range));
}

export async function allSales() {
  return wrap((await store('sales')).getAll());
}

/* ---------- Restocks ---------- */

export async function recordRestock({ productId, qty, buyPrice, sellPrice }) {
  const db = await openDB();
  const tx = db.transaction(['products', 'restocks'], 'readwrite');
  const ps = tx.objectStore('products');
  const p = await wrap(ps.get(productId));
  if (!p) throw new Error('Item not found');
  p.stock = (p.stock || 0) + qty;
  p.buyPrice = buyPrice;
  if (sellPrice != null) p.sellPrice = sellPrice;
  p.updatedAt = new Date().toISOString();
  ps.put(p);
  tx.objectStore('restocks').add({
    date: new Date().toISOString(), productId, name: p.name, barcode: p.barcode,
    qty, buyPrice, totalCost: qty * buyPrice,
  });
  return done(tx);
}

export async function restocksBetween(fromISO, toISO) {
  const s = await store('restocks');
  return wrap(s.index('date').getAll(IDBKeyRange.bound(fromISO, toISO)));
}

export async function allRestocks() {
  return wrap((await store('restocks')).getAll());
}

/* ---------- Settings ---------- */

export async function getSetting(key, fallback = null) {
  const row = await wrap((await store('settings')).get(key));
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  return wrap((await store('settings', 'readwrite')).put({ key, value }));
}

/* ---------- Backup ---------- */

export async function exportAll() {
  const db = await openDB();
  const out = { app: 'tindahan', version: DB_VERSION, exportedAt: new Date().toISOString() };
  for (const name of ['products', 'sales', 'restocks', 'settings']) {
    out[name] = await wrap(db.transaction(name).objectStore(name).getAll());
  }
  return out;
}

export async function importAll(data) {
  if (!data || data.app !== 'tindahan') throw new Error('This file is not a Tindahan backup.');
  const db = await openDB();
  const names = ['products', 'sales', 'restocks', 'settings'];
  const tx = db.transaction(names, 'readwrite');
  for (const name of names) {
    const s = tx.objectStore(name);
    s.clear();
    for (const row of data[name] || []) s.put(row);
  }
  return done(tx);
}
