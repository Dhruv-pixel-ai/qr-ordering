const socket = io();
let menu = [];
let cart = {}; // id -> {item, qty}
let activeCategory = null;
let totalTables = 12;

async function init() {
  const cfg = await fetch("/api/config").then((r) => r.json());
  totalTables = cfg.totalTables;
  const select = document.getElementById("tableSelect");
  select.innerHTML = Array.from({ length: totalTables }, (_, i) => i + 1)
    .map((t) => `<option value="${t}">Table ${t}</option>`)
    .join("");

  const res = await fetch("/api/menu");
  menu = await res.json();
  renderTabs();
  renderMenu();
}

// Live-reflect Menu Manager changes (price, new/removed items, stock).
socket.on("menu_updated", (updatedMenu) => {
  menu = updatedMenu;
  Object.keys(cart).forEach((id) => {
    const stillThere = menu.find((m) => m.id === id && m.inStock);
    if (!stillThere) delete cart[id];
  });
  renderTabs();
  renderMenu();
  updateCartUI();
});

function renderTabs() {
  const categories = [...new Set(menu.map((m) => m.category))];
  activeCategory = categories[0];
  const tabsEl = document.getElementById("categoryTabs");
  tabsEl.innerHTML = categories
    .map((c) => `<div class="tab ${c === activeCategory ? "active" : ""}" data-cat="${c}">${c}</div>`)
    .join("");
  tabsEl.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      activeCategory = tab.dataset.cat;
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(activeCategory + "-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function renderMenu() {
  const categories = [...new Set(menu.map((m) => m.category))];
  const listEl = document.getElementById("menuList");
  listEl.innerHTML = categories
    .map((cat) => {
      const items = menu.filter((m) => m.category === cat);
      return `
        <section id="${cat}-section">
          <h2 class="category-title">${cat}</h2>
          ${items.map(renderItemCard).join("")}
        </section>
      `;
    })
    .join("");
  attachItemHandlers();
}

function renderItemCard(item) {
  const qty = cart[item.id]?.qty || 0;
  if (!item.inStock) {
    return `
      <div class="item-card out-of-stock" data-id="${item.id}">
        <div class="item-info">
          <div class="item-name">
            <span class="${item.veg ? "veg-dot" : "nonveg-dot"}"></span> ${item.name}
          </div>
          <div class="item-desc">${item.desc || ""}</div>
          <div class="item-price">₹${item.price}</div>
        </div>
        <div class="item-actions">
          <span class="oos-badge">Out of Stock</span>
        </div>
      </div>
    `;
  }
  return `
    <div class="item-card" data-id="${item.id}">
      <div class="item-info">
        <div class="item-name">
          <span class="${item.veg ? "veg-dot" : "nonveg-dot"}"></span> ${item.name}
        </div>
        <div class="item-desc">${item.desc || ""}</div>
        <div class="item-price">₹${item.price}</div>
      </div>
      <div class="item-actions">
        ${
          qty === 0
            ? `<button class="add-btn" data-action="add">ADD</button>`
            : `<div class="qty-control">
                 <button data-action="dec">-</button>
                 <span>${qty}</span>
                 <button data-action="inc">+</button>
               </div>`
        }
      </div>
    </div>
  `;
}

function attachItemHandlers() {
  document.querySelectorAll(".item-card").forEach((card) => {
    const id = card.dataset.id;
    card.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.action;
        const item = menu.find((m) => m.id === id);
        if (!cart[id]) cart[id] = { item, qty: 0 };
        if (action === "add" || action === "inc") cart[id].qty += 1;
        if (action === "dec") cart[id].qty -= 1;
        if (cart[id].qty <= 0) delete cart[id];
        renderMenu();
        updateCartUI();
      });
    });
  });
}

function updateCartUI() {
  const count = Object.values(cart).reduce((sum, c) => sum + c.qty, 0);
  document.getElementById("cartCount").textContent = count;

  const cartItemsEl = document.getElementById("cartItems");
  const rows = Object.values(cart);
  cartItemsEl.innerHTML = rows.length
    ? rows
        .map(
          (c) => `
      <div class="cart-row">
        <span>${c.item.name} x${c.qty}</span>
        <span>₹${c.item.price * c.qty}</span>
      </div>`
        )
        .join("")
    : `<p style="color:#999;">No items added yet</p>`;

  const total = rows.reduce((sum, c) => sum + c.item.price * c.qty, 0);
  document.getElementById("cartTotal").textContent = total;
}

document.getElementById("cartBtn").addEventListener("click", () => {
  document.getElementById("cartDrawer").classList.remove("hidden");
});
document.getElementById("closeCart").addEventListener("click", () => {
  document.getElementById("cartDrawer").classList.add("hidden");
});

document.getElementById("placeOrderBtn").addEventListener("click", async () => {
  const rows = Object.values(cart);
  if (!rows.length) return showToast("Add items to the order first");

  const customerName = document.getElementById("customerName").value.trim();
  if (!customerName) return showToast("Please enter the customer's name");

  const table = document.getElementById("tableSelect").value;
  const waiterName = document.getElementById("waiterName").value.trim();
  const items = rows.map((c) => ({ id: c.item.id, name: c.item.name, price: c.item.price, qty: c.qty }));
  const note = document.getElementById("orderNote").value;

  const res = await fetch("/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ table, items, note, customerName, source: "waiter", waiterName }),
  });
  const data = await res.json();
  if (data.success) {
    showToast(`✅ Order sent for Table ${table}`);
    cart = {};
    document.getElementById("orderNote").value = "";
    document.getElementById("customerName").value = "";
    renderMenu();
    updateCartUI();
    document.getElementById("cartDrawer").classList.add("hidden");
  } else {
    showToast(data.error || "Something went wrong, please try again.");
  }
});

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 2500);
}

init();
