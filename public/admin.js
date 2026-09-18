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

  return `
    <div class="table-card ${isEmpty ? "empty" : ""}" data-table="${table}">
      <div class="table-card-header">
        <h2>Table ${table}</h2>
        ${isEmpty ? "<span style='font-size:0.75rem;color:#999;'>No active order</span>" : ""}
      </div>
      ${tableOrders.map((o) => renderOrderBlock(o)).join("")}
      ${
        !isEmpty
          ? `<div class="table-total">Total: ₹${total}</div>
             <div class="table-footer">
               <button class="bill-btn" data-action="bill" data-table="${table}">Generate Bill</button>
               <button class="clear-btn" data-action="clear" data-table="${table}">Clear Table</button>
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
  return `
    <div class="order-block">
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
        <button class="order-print-btn" data-action="print-order" data-order-id="${order.id}">
          Print this order${printed ? ` (${printed}x)` : ""}
        </button>
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
  // Per-order slip. Prints ONE order and changes nothing else - the order stays
  // on the table exactly as it was, and can be reprinted any number of times.
  document.querySelectorAll('[data-action="print-order"]').forEach((btn) => {
    btn.addEventListener("click", () => printSingleOrder(btn.dataset.orderId));
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
        <span>Table: ${r.table}</span>
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
      ${r.note ? `<div class="receipt-note">Note: ${escapeHtml(r.note)}</div>` : ""}
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
// finalize, clear, close, or re-render: the customer's order must survive any
// number of prints.
function sendToPrinter(docTitle) {
  const originalTitle = document.title;
  document.title = docTitle || "Receipt";
  window.print();
  document.title = originalTitle;
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

function printSingleOrder(orderId) {
  const order = orders.find((o) => o.id === orderId);
  if (!order) return alert("That order is no longer on the dashboard.");

  const receipt = buildOrderReceipt(order);
  openReceipt(
    receiptHtml(receipt),
    `<div class="modal-actions">
       <button onclick="reprintSingleOrder('${order.id}')">Print again</button>
       <button onclick="closeModal()">Close</button>
     </div>`
  );
  sendToPrinter(`Order ${receipt.refNo}`);
  printCounts.set(order.id, (printCounts.get(order.id) || 0) + 1);
  render(); // refresh only the "(2x)" badge; order data is untouched
}

// Reprint from inside the open modal, without closing it.
function reprintSingleOrder(orderId) {
  const order = orders.find((o) => o.id === orderId);
  if (!order) return;
  const receipt = buildOrderReceipt(order);
  document.getElementById("billContent").innerHTML =
    receiptHtml(receipt) +
    `<div class="modal-actions">
       <button onclick="reprintSingleOrder('${order.id}')">Print again</button>
       <button onclick="closeModal()">Close</button>
     </div>`;
  sendToPrinter(`Order ${receipt.refNo}`);
  printCounts.set(order.id, (printCounts.get(order.id) || 0) + 1);
  render();
}

// ---- whole-table bill ------------------------------------------------------
async function generateBill(table) {
  const res = await fetch(`/api/tables/${table}/bill`, { method: "POST", cache: "no-store" });
  const bill = await res.json();
  if (bill.error) return alert(bill.error);
  showBillModal(bill);
}

function showBillModal(bill) {
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
function printBill(table) {
  sendToPrinter(`Bill - Table ${table}`);
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
