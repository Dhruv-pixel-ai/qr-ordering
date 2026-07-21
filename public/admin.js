const socket = io();
let orders = [];
let totalTables = 12;

async function init() {
  const cfg = await fetch("/api/config").then((r) => r.json());
  totalTables = cfg.totalTables;
  orders = await fetch("/api/orders").then((r) => r.json());
  render();
}

socket.on("new_order", (order) => {
  orders.push(order);
  render();
  playPing();
});
socket.on("order_finalized", ({ table }) => {
  orders = orders.map((o) => (o.table === table ? { ...o, billed: true } : o));
  render();
});
socket.on("table_cleared", ({ table }) => {
  orders = orders.filter((o) => o.table !== table || !o.billed);
  render();
});

function playPing() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch (e) {}
}

function render() {
  const grid = document.getElementById("tablesGrid");
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
  const res = await fetch(`/api/tables/${table}/bill`, { method: "POST" });
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
        <div class="receipt-phone">📞 ${bill.phone}</div>
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
        <div class="receipt-row receipt-grand-total"><span>Total</span><span>₹${bill.total}</span></div>
      </div>
      <div class="receipt-divider"></div>
      <div class="receipt-footer">Thank you! Visit again 🙏</div>
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
  // Prevent the dashboard's own page title ("Kitchen Dashboard") from showing up
  // in the browser's default print header/footer.
  const originalTitle = document.title;
  document.title = "Bill";
  window.print();
  document.title = originalTitle;

  await fetch(`/api/tables/${table}/finalize`, { method: "POST" });
  orders = orders.map((o) => (o.table === Number(table) ? { ...o, billed: true } : o));
  closeModal();
  render();
}

async function clearTable(table) {
  await fetch(`/api/tables/${table}/clear`, { method: "POST" });
  orders = orders.filter((o) => o.table !== Number(table));
  closeModal();
  render();
}
function closeModal() {
  document.getElementById("billModal").classList.add("hidden");
}

init();
