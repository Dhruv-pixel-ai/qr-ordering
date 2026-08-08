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
  socket.on("order_finalized", ({ table }) => {
    orders = orders.map((o) => (o.table === table ? { ...o, billed: true } : o));
    render();
  });
  socket.on("table_cleared", ({ table }) => {
    orders = orders.filter((o) => o.table !== table || !o.billed);
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
             </div>`
          : ""
      }
    </div>
  `;
}

function renderOrderBlock(order) {
  const time = new Date(order.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sourceLabel =
    order.source === "waiter"
      ? `🧑‍💼 Waiter${order.waiterName ? " (" + order.waiterName + ")" : ""}`
      : "📱 Self-order (QR)";
  return `
    <div class="order-block">
      <div class="order-block-header">
        <span>#${order.id.slice(-5)} · ${time}</span>
        <span class="source-badge">${sourceLabel}</span>
      </div>
      <div class="customer-name">👤 ${order.customerName || "Guest"}</div>
      ${order.items.map((it) => `<div class="order-item-row"><span>${it.name} x${it.qty}</span><span>₹${it.price * it.qty}</span></div>`).join("")}
      ${order.note ? `<div style="font-size:0.75rem;color:#888;margin-top:4px;">Note: ${order.note}</div>` : ""}
    </div>
  `;
}

function attachHandlers() {
  document.querySelectorAll('[data-action="bill"]').forEach((btn) => {
    btn.addEventListener("click", () => generateBill(btn.dataset.table));
  });
}

async function generateBill(table) {
  const res = await fetch(`/api/tables/${table}/bill`, { method: "POST", cache: "no-store" });
  const bill = await res.json();
  if (bill.error) return alert(bill.error);
  showBillModal(bill);
  // Intentionally NOT mutating `orders` or re-rendering here — the order stays
  // visible on the dashboard until Print or Clear Table is clicked.
}

function showBillModal(bill) {
  const modal = document.getElementById("billModal");
  const content = document.getElementById("billContent");
  const dateStr = new Date(bill.generatedAt).toLocaleString([], {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  content.innerHTML = `
    <div class="receipt">
      <div class="receipt-header">
        <div class="receipt-brand">${bill.businessName}</div>
        <div class="receipt-address">${bill.address}</div>
        <div class="receipt-phone">Ph: ${bill.phone}</div>
      </div>
      <div class="receipt-divider"></div>
      <div class="receipt-meta">
        <span>Bill No: ${bill.billNo}</span>
        <span>Table: ${bill.table}</span>
      </div>
      <div class="receipt-meta">
        <span>${dateStr}</span>
      </div>
      ${bill.customerNames && bill.customerNames.length ? `<div class="receipt-meta"><span>Guest: ${bill.customerNames.join(", ")}</span></div>` : ""}
      <div class="receipt-divider"></div>
      <div class="receipt-items">
        <div class="receipt-item-row receipt-item-head">
          <span class="ri-name">Item</span><span class="ri-qty">Qty</span><span class="ri-amt">Amt</span>
        </div>
        ${bill.items
          .map(
            (it) => `
          <div class="receipt-item-row">
            <span class="ri-name">${it.name}</span>
            <span class="ri-qty">${it.qty}</span>
            <span class="ri-amt">₹${it.price * it.qty}</span>
          </div>`
          )
          .join("")}
      </div>
      <div class="receipt-divider"></div>
      <div class="receipt-totals">
        <div class="receipt-row"><span>Subtotal</span><span>₹${bill.subtotal}</span></div>
        <div class="receipt-row"><span>GST (${bill.gstPercent}%)</span><span>₹${bill.tax}</span></div>
        <div class="receipt-row receipt-grand-total"><span>TOTAL</span><span>₹${bill.total}</span></div>
      </div>
      <div class="receipt-divider"></div>
      <div class="receipt-footer">Thank you! Visit again</div>
    </div>
    <div class="modal-actions">
      <button onclick="printBill(${bill.table})">🖨️ Print</button>
      <button onclick="clearTable(${bill.table})">Clear Table</button>
      <button onclick="closeModal()">Close</button>
    </div>
  `;
  modal.classList.remove("hidden");
}

async function printBill(table) {
  // Prevent the dashboard's own page title from showing up in the browser's
  // default print header/footer.
  const originalTitle = document.title;
  document.title = "Bill";
  window.print();
  document.title = originalTitle;

  await fetch(`/api/tables/${table}/finalize`, { method: "POST", cache: "no-store" });
  orders = orders.map((o) => (o.table === Number(table) ? { ...o, billed: true } : o));
  closeModal();
  render();
}

async function clearTable(table) {
  await fetch(`/api/tables/${table}/clear`, { method: "POST", cache: "no-store" });
  orders = orders.filter((o) => o.table !== Number(table));
  closeModal();
  render();
}

function closeModal() {
  document.getElementById("billModal").classList.add("hidden");
}

init();
