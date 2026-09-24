// ---------------------------------------------------------------------------
// Kitchen dashboard.
//
// IMPORTANT — why this polls instead of using websockets:
// This app is hosted on Vercel serverless. Every HTTP request runs in its own
// short-lived process, so Socket.IO cannot hold a persistent connection: the
// io.emit("new_order") raised while saving an order happens in a DIFFERENT
// process from the dashboard's socket, so the push never arrives. That is why
// new orders used to show up only after a manual refresh, and why the beep
// (which lived inside socket.on("new_order")) never fired.
//
// So the dashboard now POLLS /api/orders on a short interval and detects new
// orders by diffing order ids. This works identically for QR self-orders and
// waiter orders, and keeps working if websockets are unavailable.
// Socket.IO is still used opportunistically when it happens to work (e.g. when
// running locally with `npm start`) — it just makes updates instant instead of
// up to POLL_MS late. Both paths funnel through the same code, so an order can
// never be announced twice.
// ---------------------------------------------------------------------------

const POLL_MS = 2500; // how often to check for new orders

let orders = [];
let parcelTables = [16,17,18,19,20]; // updated from /api/config

// Returns "Parcel 1" … "Parcel 5" for parcel tables, else null.
function parcelLabel(table) {
  const idx = parcelTables.indexOf(Number(table));
  return idx >= 0 ? `Parcel ${idx + 1}` : null;
}
// Cafe details / GST, loaded once at init and refreshed by socket if available.
let settings = {
  gstPercent: 5,
  businessName: "THE KD'S CAFE",
  address: "",
  phone: "",
};
// How many times each order slip has been printed, so staff can see at a glance
// what has already gone to the printer. Kept in memory only - printing must not
// change any server state.
const printCounts = new Map();
let totalTables = 12;
let seenOrderIds = new Set(); // every order id we have already announced
let firstLoadDone = false;
let pollInFlight = false;

// Socket.IO is optional. If /socket.io/socket.io.js failed to load, `io` is not
// defined — referencing it directly used to throw and kill this whole script,
// leaving the dashboard completely blank. Guard it.
const socket = typeof io !== "undefined" ? io() : null;

// ---------------------------------------------------------------------------
// Sound
//
// Two things used to break the beep:
//  1. It only ran from the websocket event, which never fired (see above).
//  2. Browsers block/suspend AudioContext until the user interacts with the
//     page. A dashboard left open on the counter without a click stays muted.
// We keep ONE AudioContext, resume it on any user gesture, and also try to
// resume right before each beep. If it is still blocked we show a banner so
// staff know to click once.
// ---------------------------------------------------------------------------
let audioCtx = null;
let audioReady = false;

function getAudioCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  return audioCtx;
}

function updateSoundBanner() {
  const banner = document.getElementById("soundBanner");
  if (!banner) return;
  banner.style.display = audioReady ? "none" : "block";
}

function unlockAudio() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  ctx.resume()
    .then(() => {
      if (ctx.state === "running") {
        audioReady = true;
        updateSoundBanner();
      }
    })
    .catch(() => {});
}

// Any interaction anywhere on the page counts as the unlocking gesture.
["pointerdown", "keydown", "touchstart", "click"].forEach((evt) => {
  window.addEventListener(evt, unlockAudio, { passive: true });
});

// A single clear "ding-ding" that carries over kitchen noise.
function playTone(ctx, startAt, freq, duration, volume) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, startAt);
  // Envelope: ramp up and down so it rings instead of clicking.
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(volume, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

function playNewOrderChime() {
  const ctx = getAudioCtx();
  if (!ctx) return;

  const fire = () => {
    if (ctx.state !== "running") return;
    audioReady = true;
    updateSoundBanner();
    const t = ctx.currentTime;
    // Three rising notes, repeated — deliberately hard to miss.
    playTone(ctx, t + 0.00, 880, 0.18, 0.7);
    playTone(ctx, t + 0.20, 1170, 0.18, 0.7);
    playTone(ctx, t + 0.40, 1568, 0.28, 0.7);
    playTone(ctx, t + 0.85, 880, 0.18, 0.6);
    playTone(ctx, t + 1.05, 1170, 0.18, 0.6);
    playTone(ctx, t + 1.25, 1568, 0.30, 0.6);
  };

  if (ctx.state === "running") {
    fire();
  } else {
    // Blocked by autoplay policy — try to resume, and flag it if we cannot.
    ctx.resume().then(fire).catch(() => {});
    setTimeout(() => {
      if (ctx.state !== "running") {
        audioReady = false;
        updateSoundBanner();
      }
    }, 300);
  }
}

function flashTitle(count) {
  const original = "THE KD'S CAFE — Dashboard";
  document.title = `(${count}) 🔔 NEW ORDER — Dashboard`;
  setTimeout(() => {
    document.title = original;
  }, 6000);
}

// ---------------------------------------------------------------------------
// Order loading
// ---------------------------------------------------------------------------

// Announce anything we have not seen before. Runs for BOTH polling and socket
// updates, so QR orders and waiter orders are treated identically and nothing
// gets announced twice.
function absorbOrders(list) {
  const active = list.filter((o) => !o.billed);
  const brandNew = active.filter((o) => !seenOrderIds.has(o.id));

  list.forEach((o) => seenOrderIds.add(o.id));

  if (firstLoadDone && brandNew.length) {
    playNewOrderChime();
    flashTitle(brandNew.length);
  }
  firstLoadDone = true;
}

async function fetchOrders() {
  // cache:"no-store" + a cache-busting param: the browser was answering this
  // from cache (304 / memory cache) and showing a stale order list.
  const res = await fetch(`/api/orders?t=${Date.now()}`, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" },
  });
  if (!res.ok) throw new Error(`orders ${res.status}`);
  return res.json();
}

function setStatus(ok) {
  const dot = document.getElementById("connStatus");
  if (dot) dot.style.background = ok ? "#2f9e44" : "#e03131";
}

async function poll() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const list = await fetchOrders();
    orders = list;
    absorbOrders(list);
    render();
    setStatus(true);
  } catch (e) {
    // Never let a transient failure stop the polling loop.
    console.error("poll failed:", e);
    setStatus(false);
  } finally {
    pollInFlight = false;
  }
}

async function init() {
  try {
    const cfg = await fetch(`/api/config?t=${Date.now()}`, { cache: "no-store" }).then((r) => r.json());
    totalTables = cfg.totalTables;
    parcelTables = cfg.parcelTables || [16,17,18,19,20];
  } catch (e) {
    console.error("config failed, using default table count:", e);
  }
  // Cafe details + GST are needed to build single-order slips on the client
  // (the /bill endpoint only totals a whole table).
  try {
    settings = await fetch(`/api/settings?t=${Date.now()}`, { cache: "no-store" }).then((r) => r.json());
  } catch (e) {
    console.error("settings failed, using defaults:", e);
  }
  await poll();
  setInterval(poll, POLL_MS);
  initQZ(); // connect to QZ Tray in background; falls back gracefully if not running
  // Catch up the moment the laptop wakes or the tab is refocused.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") poll();
  });
  window.addEventListener("focus", poll);
  updateSoundBanner();
}

// Opportunistic instant updates when websockets actually work.
if (socket) {
  socket.on("new_order", (order) => {
    if (!orders.some((o) => o.id === order.id)) orders.push(order);
    absorbOrders(orders);
    render();
  });
  socket.on("settings_updated", (s) => {
    if (s) settings = s;
  });
  socket.on("table_cleared", ({ table }) => {
    orders = orders.filter((o) => o.table !== table);
    render();
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  const grid = document.getElementById("tablesGrid");
  if (!grid) return;
  const tables = Array.from({ length: totalTables }, (_, i) => i + 1);
  grid.innerHTML = tables.map(renderTableCard).join("");
  attachHandlers();
}

function renderTableCard(table) {
  const tableOrders = orders.filter((o) => o.table === table && !o.billed);
  const isEmpty = tableOrders.length === 0;
  const total = tableOrders.reduce(
    (sum, o) => sum + o.items.reduce((s, it) => s + it.price * it.qty, 0),
    0
  );

  const label = parcelLabel(table);
  const isParcel = !!label;
  return `
    <div class="table-card ${isEmpty ? "empty" : ""} ${isParcel ? "parcel-card" : ""}" data-table="${table}">
      <div class="table-card-header">
        <h2>${isParcel ? `🛍️ ${label}` : `Table ${table}`}</h2>
        ${isEmpty ? `<span style='font-size:0.75rem;color:#999;'>No active order</span>` : ""}
        ${isParcel ? `<span class="parcel-badge">Takeaway</span>` : ""}
      </div>
      ${tableOrders.map((o) => renderOrderBlock(o)).join("")}
      ${
        !isEmpty
          ? `<div class="table-total">Total: ₹${total}</div>
             <div class="table-footer">
               <button class="bill-btn" data-action="bill" data-table="${table}">${isParcel ? `🛍️ ${label} Bill` : "Generate Bill"}</button>
               <button class="clear-btn" data-action="clear" data-table="${table}">Clear</button>
             </div>`
          : ""
      }
    </div>
  `;
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function orderSubtotal(order) {
  return order.items.reduce((s, it) => s + it.price * it.qty, 0);
}

function renderOrderBlock(order) {
  const time = new Date(order.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sourceLabel =
    order.source === "waiter"
      ? `Waiter${order.waiterName ? " (" + escapeHtml(order.waiterName) + ")" : ""}`
      : "Self-order (QR)";
  const printed = printCounts.get(order.id) || 0;
  // Req 1: highlight green until the first print, so kitchen knows what's new.
  const isNew = printed === 0;
  return `
    <div class="order-block${isNew ? " order-block--new" : ""}">
      <div class="order-block-header">
        <span>#${order.id.slice(-5)} &middot; ${time}</span>
        <span class="source-badge">${sourceLabel}</span>
      </div>
      <div class="customer-name">${escapeHtml(order.customerName || "Guest")}</div>
      ${order.items
        .map(
          (it) =>
            `<div class="order-item-row"><span>${escapeHtml(it.name)} x${it.qty}</span><span>&#8377;${it.price * it.qty}</span></div>`
        )
        .join("")}
      ${order.note ? `<div class="order-note">Note: ${escapeHtml(order.note)}</div>` : ""}
      <div class="order-block-footer">
        <span class="order-subtotal">&#8377;${orderSubtotal(order)}</span>
        <div class="order-block-actions">
          <button class="order-print-btn" data-action="print-order" data-order-id="${order.id}">
            🖨️ Print${printed ? ` (${printed}x)` : ""}
          </button>
          <button class="order-delete-btn" data-action="delete-order" data-order-id="${order.id}" title="Delete this order">
            🗑️
          </button>
        </div>
      </div>
    </div>
  `;
}

function attachHandlers() {
  document.querySelectorAll('[data-action="bill"]').forEach((btn) => {
    btn.addEventListener("click", () => generateBill(btn.dataset.table));
  });
  document.querySelectorAll('[data-action="clear"]').forEach((btn) => {
    btn.addEventListener("click", () => clearTable(btn.dataset.table));
  });
  document.querySelectorAll('[data-action="print-order"]').forEach((btn) => {
    btn.addEventListener("click", () => printSingleOrder(btn.dataset.orderId));
  });
  // Req 2: delete a single order without clearing the whole table.
  document.querySelectorAll('[data-action="delete-order"]').forEach((btn) => {
    btn.addEventListener("click", () => deleteOrder(btn.dataset.orderId));
  });
}

// ---------------------------------------------------------------------------
// Receipts
//
// Nothing in this section writes to the server. Printing is purely a render +
// window.print(); orders are only ever removed by Clear Table.
// ---------------------------------------------------------------------------
function receiptHtml(r) {
  const dateStr = new Date(r.generatedAt).toLocaleString([], {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  return `
    <div class="receipt">
      <div class="receipt-header">
        <div class="receipt-brand">${escapeHtml(r.businessName || "")}</div>
        ${r.address ? `<div class="receipt-address">${escapeHtml(r.address)}</div>` : ""}
        ${r.phone ? `<div class="receipt-phone">Ph: ${escapeHtml(r.phone)}</div>` : ""}
      </div>
      <div class="receipt-divider"></div>
      <div class="receipt-doctype">${escapeHtml(r.docType)}</div>
      <div class="receipt-divider"></div>
      <div class="receipt-meta">
        <span>${escapeHtml(r.refLabel)}: ${escapeHtml(r.refNo)}</span>
        <span class="receipt-table-num">${parcelLabel(r.table) ? `🛍️ ${parcelLabel(r.table).toUpperCase()}` : `TABLE ${r.table}`}</span>
      </div>
      <div class="receipt-meta"><span>${dateStr}</span></div>
      ${r.guests ? `<div class="receipt-meta"><span>Guest: ${escapeHtml(r.guests)}</span></div>` : ""}
      ${r.reprint ? `<div class="receipt-meta"><span>** REPRINT **</span></div>` : ""}
      <div class="receipt-divider"></div>
      <div class="receipt-items">
        <div class="receipt-item-row receipt-item-head">
          <span class="ri-name">Item</span><span class="ri-qty">Qty</span><span class="ri-amt">Amt</span>
        </div>
        ${r.items
          .map(
            (it) => `
          <div class="receipt-item-row">
            <span class="ri-name">${escapeHtml(it.name)}</span>
            <span class="ri-qty">${it.qty}</span>
            <span class="ri-amt">&#8377;${it.price * it.qty}</span>
          </div>`
          )
          .join("")}
      </div>
      ${r.note ? `<div class="receipt-special">⚠️ SPECIAL: ${escapeHtml(r.note)}</div>` : ""}
      <div class="receipt-divider"></div>
      <div class="receipt-totals">
        <div class="receipt-row"><span>Subtotal</span><span>&#8377;${r.subtotal}</span></div>
        <div class="receipt-row"><span>GST (${r.gstPercent}%)</span><span>&#8377;${r.tax}</span></div>
        <div class="receipt-row receipt-grand-total"><span>TOTAL</span><span>&#8377;${r.total}</span></div>
      </div>
      <div class="receipt-divider"></div>
      <div class="receipt-footer">Thank you! Visit again</div>
    </div>
  `;
}

function openReceipt(html, actionsHtml) {
  document.getElementById("billContent").innerHTML = html + actionsHtml;
  document.getElementById("billModal").classList.remove("hidden");
}

// Send whatever is currently in the modal to the printer. Deliberately does NOT
// ─── QZ Tray integration ────────────────────────────────────────────────────
// QZ Tray is a free background app that lets the browser print silently to a
// specific physical printer. When it's running we skip the print dialog
// entirely. If it's not running we fall back to window.print().

let qzReady = false;
let printerCfg = { kitchen: { host: "", port: 9100 }, counter: { name: "" } };

const ESC = "\x1B", GS = "\x1D";
const INIT         = ESC + "@";
const CENTER       = ESC + "a\x01";
const LEFT         = ESC + "a\x00";
const BOLD_ON      = ESC + "E\x01";
const BOLD_OFF     = ESC + "E\x00";
const BIG          = GS  + "!\x11";   // 2× width + 2× height
const NORMAL       = GS  + "!\x00";
const CUT          = GS  + "V\x41\x05";
const SEP          = "─".repeat(32) + "\n";

function setDot(id, state) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = "printer-dot printer-dot--" + state; // ok | warn | off
}

async function initQZ() {
  if (typeof qz === "undefined") {
    setDot("kitchenDot", "off"); setDot("counterDot", "off"); return;
  }
  // Unsigned mode – user must enable "Allow unsigned" in QZ Tray site manager.
  qz.security.setCertificatePromise((resolve) => resolve());
  qz.security.setSignatureAlgorithm("SHA512");
  qz.security.setSignaturePromise((toSign) => (resolve) => resolve());

  qz.websocket.setClosedCallbacks(() => {
    qzReady = false;
    setDot("kitchenDot", "off"); setDot("counterDot", "off");
  });

  try {
    await qz.websocket.connect();
    qzReady = true;
    printerCfg = await fetch("/api/printer-config", { cache: "no-store" }).then((r) => r.json());
    updatePrinterDots();
  } catch (e) {
    qzReady = false;
    setDot("kitchenDot", "off"); setDot("counterDot", "off");
  }
}

function updatePrinterDots() {
  setDot("kitchenDot", qzReady && printerCfg.kitchen.host ? "ok" : (qzReady ? "warn" : "off"));
  setDot("counterDot", qzReady && printerCfg.counter.name ? "ok" : (qzReady ? "warn" : "off"));
}

// Build ESC/POS data for a Kitchen Order Ticket.
function buildKOT(order) {
  const time = new Date(order.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const tblLabel = parcelLabel(order.table) || `Table ${order.table}`;
  let d = INIT + CENTER + BIG + BOLD_ON + tblLabel + BOLD_OFF + NORMAL + "\n" + LEFT;
  d += SEP;
  d += BOLD_ON + `#${order.id.slice(-5)}  ${time}` + BOLD_OFF + "\n";
  d += `Guest: ${order.customerName || "Guest"}\n`;
  d += `Type: ${order.source === "waiter" ? "Waiter" + (order.waiterName ? ` (${order.waiterName})` : "") : "Self-order (QR)"}` + "\n";
  d += SEP;
  order.items.forEach((it) => {
    const name = it.name.length > 28 ? it.name.slice(0, 27) + "…" : it.name;
    const qty = `x${it.qty}`;
    d += BOLD_ON + name.padEnd(32 - qty.length) + qty + BOLD_OFF + "\n";
  });
  d += SEP;
  if (order.note) d += BOLD_ON + "⚠ SPECIAL: " + order.note.toUpperCase() + BOLD_OFF + "\n" + SEP;
  d += "\n\n\n" + CUT;
  return d;
}

// Build ESC/POS data for the counter billing receipt.
function buildBillESC(bill) {
  const tblLabel = parcelLabel(bill.table) ? parcelLabel(bill.table).toUpperCase() : `TABLE ${bill.table}`;
  const date = new Date(bill.generatedAt).toLocaleString([], {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  let d = INIT + CENTER + BIG + BOLD_ON + (bill.businessName || "") + BOLD_OFF + NORMAL + "\n";
  if (bill.address) d += bill.address + "\n";
  if (bill.phone)   d += "Ph: " + bill.phone + "\n";
  d += LEFT + SEP;
  d += CENTER + BOLD_ON + "BILL" + BOLD_OFF + "\n" + LEFT;
  d += SEP;
  d += `Bill No: ${bill.billNo}`.padEnd(20) + tblLabel + "\n";
  d += date + "\n";
  if (bill.customerNames && bill.customerNames.length) d += `Guest: ${bill.customerNames.join(", ")}\n`;
  d += SEP;
  const COL = [24, 4, 10]; // name, qty, amount
  d += BOLD_ON + "Item".padEnd(COL[0]) + "Qty".padEnd(COL[1]) + "Amt".padStart(COL[2]) + BOLD_OFF + "\n";
  d += SEP;
  bill.items.forEach((it) => {
    const nm = it.name.length > COL[0] - 1 ? it.name.slice(0, COL[0] - 2) + "…" : it.name;
    d += nm.padEnd(COL[0]) + `x${it.qty}`.padEnd(COL[1]) + `₹${it.price * it.qty}`.padStart(COL[2]) + "\n";
  });
  d += SEP;
  d += "Subtotal".padEnd(28) + `₹${bill.subtotal}`.padStart(10) + "\n";
  d += `GST (${bill.gstPercent}%)`.padEnd(28) + `₹${bill.tax}`.padStart(10) + "\n";
  d += SEP;
  d += BOLD_ON + "TOTAL".padEnd(28) + `₹${bill.total}`.padStart(10) + BOLD_OFF + "\n";
  d += SEP;
  d += CENTER + "Thank you! Visit again 🙏\n\n\n\n" + LEFT + CUT;
  return d;
}

// Silent print to the kitchen LAN printer via QZ Tray.
async function qzPrintKitchen(escData) {
  const cfg = qz.configs.create({ host: printerCfg.kitchen.host, port: printerCfg.kitchen.port || 9100 });
  await qz.print(cfg, [{ type: "raw", format: "plain", data: escData }]);
}

// Silent print to the counter USB printer via QZ Tray.
async function qzPrintCounter(escData) {
  const cfg = qz.configs.create(printerCfg.counter.name);
  await qz.print(cfg, [{ type: "raw", format: "plain", data: escData }]);
}

// Browser fallback (window.print) — used when QZ Tray is not running.
function browserPrint(docTitle) {
  const originalTitle = document.title;
  document.title = docTitle || "Receipt";
  window.print();
  document.title = originalTitle;
  closeModal();
}

// ---- single order slip -----------------------------------------------------
function buildOrderReceipt(order) {
  const subtotal = orderSubtotal(order);
  const gstPercent = Number(settings.gstPercent) || 0;
  const tax = Math.round(subtotal * (gstPercent / 100) * 100) / 100;
  const total = Math.round((subtotal + tax) * 100) / 100;
  return {
    docType: "ORDER SLIP",
    refLabel: "Order",
    refNo: "#" + order.id.slice(-5),
    table: order.table,
    items: order.items,
    note: order.note,
    guests: order.customerName || "",
    subtotal,
    gstPercent,
    tax,
    total,
    businessName: settings.businessName,
    address: settings.address,
    phone: settings.phone,
    generatedAt: new Date().toISOString(),
    reprint: (printCounts.get(order.id) || 0) > 0,
  };
}

async function printSingleOrder(orderId) {
  const order = orders.find((o) => o.id === orderId);
  if (!order) return alert("That order is no longer on the dashboard.");

  printCounts.set(order.id, (printCounts.get(order.id) || 0) + 1);
  render();

  if (qzReady && printerCfg.kitchen.host) {
    // ── QZ Tray path: silent KOT to kitchen printer ──
    try {
      await qzPrintKitchen(buildKOT(order));
      closeModal();
      return;
    } catch (e) {
      console.error("QZ kitchen print failed:", e);
      alert("Kitchen printer error: " + e.message + "\n\nFalling back to browser print.");
    }
  }

  // ── Browser fallback: show KOT receipt in modal then window.print() ──
  const receipt = buildOrderReceipt(order);
  openReceipt(
    receiptHtml(receipt),
    `<div class="modal-actions">
       <button onclick="reprintSingleOrder('${order.id}')">Print again</button>
       <button onclick="closeModal()">Close</button>
     </div>`
  );
  browserPrint(`Order ${receipt.refNo}`);
}

async function reprintSingleOrder(orderId) {
  const order = orders.find((o) => o.id === orderId);
  if (!order) return;

  printCounts.set(order.id, (printCounts.get(order.id) || 0) + 1);
  render();

  if (qzReady && printerCfg.kitchen.host) {
    try {
      await qzPrintKitchen(buildKOT(order));
      closeModal();
      return;
    } catch (e) {
      console.error("QZ kitchen reprint failed:", e);
    }
  }

  const receipt = buildOrderReceipt(order);
  document.getElementById("billContent").innerHTML =
    receiptHtml(receipt) +
    `<div class="modal-actions">
       <button onclick="reprintSingleOrder('${order.id}')">Print again</button>
       <button onclick="closeModal()">Close</button>
     </div>`;
  browserPrint(`Order ${receipt.refNo}`);
}

// ---- whole-table bill ------------------------------------------------------
async function generateBill(table) {
  const res = await fetch(`/api/tables/${table}/bill`, { method: "POST", cache: "no-store" });
  const bill = await res.json();
  if (bill.error) return alert(bill.error);
  showBillModal(bill);
}

function showBillModal(bill) {
  // Stash raw bill data so printBill() can build ESC/POS from it (QZ Tray path).
  document.getElementById("billModal").dataset.bill = JSON.stringify(bill);
  openReceipt(
    receiptHtml({
      docType: "BILL",
      refLabel: "Bill No",
      refNo: bill.billNo,
      table: bill.table,
      items: bill.items,
      guests: (bill.customerNames || []).join(", "),
      subtotal: bill.subtotal,
      gstPercent: bill.gstPercent,
      tax: bill.tax,
      total: bill.total,
      businessName: bill.businessName,
      address: bill.address,
      phone: bill.phone,
      generatedAt: bill.generatedAt,
    }),
    `<div class="modal-actions">
       <button onclick="printBill(${bill.table})">Print bill</button>
       <button onclick="closeModal()">Close</button>
     </div>`
  );
}

// Prints the full bill and leaves EVERYTHING in place. The table is only
// emptied by Clear Table, so the bill can be reprinted and the customer can
// keep ordering afterwards.
async function printBill(table) {
  if (qzReady && printerCfg.counter.name) {
    // ── QZ Tray path: silent bill to counter printer ──
    // We need the bill data — it's in the modal's data attribute.
    const billData = document.getElementById("billModal").dataset.bill;
    if (billData) {
      try {
        await qzPrintCounter(buildBillESC(JSON.parse(billData)));
        closeModal();
        return;
      } catch (e) {
        console.error("QZ counter print failed:", e);
        alert("Counter printer error: " + e.message + "\n\nFalling back to browser print.");
      }
    }
  }
  // ── Browser fallback ──
  browserPrint(`Bill - Table ${table}`);
}

// ---- delete a single order -------------------------------------------------
async function deleteOrder(orderId) {
  const order = orders.find((o) => o.id === orderId);
  if (!order) return;
  const label = order.items.map((it) => `${it.name} x${it.qty}`).join(", ");
  if (!confirm(`Delete this order?

${label}

This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/orders/${orderId}`, { method: "DELETE", cache: "no-store" });
    if (!res.ok) throw new Error(`delete ${res.status}`);
  } catch (e) {
    return alert("Could not delete the order. Check connection and try again.");
  }
  printCounts.delete(orderId);
  orders = orders.filter((o) => o.id !== orderId);
  render();
}

// ---- the only destructive action ------------------------------------------
async function clearTable(table) {
  const tableOrders = orders.filter((o) => o.table === Number(table));
  const total = tableOrders.reduce((s, o) => s + orderSubtotal(o), 0);
  const ok = confirm(
    `Clear Table ${table}?\n\n` +
      `${tableOrders.length} order(s), \u20B9${total} will be removed from the dashboard.\n` +
      `Do this only after the customer has paid and left.`
  );
  if (!ok) return;

  try {
    const res = await fetch(`/api/tables/${table}/clear`, { method: "POST", cache: "no-store" });
    if (!res.ok) throw new Error(`clear ${res.status}`);
  } catch (e) {
    console.error("clear failed:", e);
    return alert("Could not clear the table. Please check the connection and try again.");
  }
  tableOrders.forEach((o) => printCounts.delete(o.id));
  orders = orders.filter((o) => o.table !== Number(table));
  closeModal();
  render();
}

function closeModal() {
  document.getElementById("billModal").classList.add("hidden");
}

init();
