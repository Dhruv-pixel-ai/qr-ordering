const params = new URLSearchParams(window.location.search);
const table = params.get("table") || "1";

// Socket.IO is optional: on serverless hosting the client script may not
// load at all. Referencing a missing `io` throws and kills this entire
// script, so guard it and null-check every listener below.
const socket = typeof io !== "undefined" ? io() : null;
let menu = [];
let categoryOrder = []; // set by server; defines display order for tabs + sections
let parcelTable = 16; // updated from /api/config
let cart = {}; // id -> {item, qty}
let activeCategory = null;

// Returns categories in the server-saved order, with any unknowns at the end.
function orderedCategories() {
  const all = [...new Set(menu.map((m) => m.category))];
  return [
    ...categoryOrder.filter((c) => all.includes(c)),
    ...all.filter((c) => !categoryOrder.includes(c)),
  ];
}

// ---------- Ask the customer's name ONCE, right when the QR is scanned ----------
// Stored per browser tab session, so the same person isn't asked again for each
// order, but a new customer scanning later gets a fresh prompt.
const NAME_KEY = `kds_customer_name_t${table}`;
let customerName = sessionStorage.getItem(NAME_KEY) || "";

function tableLabel() {
  return Number(table) === parcelTable ? "🛍️ Parcel Order" : `Table ${table}`;
}

function updateHeaderBadge() {
  document.getElementById("tableBadge").textContent = customerName
    ? `${tableLabel()} · ${customerName}`
    : tableLabel();
}

async function showWelcomeIfNeeded() {
  if (customerName) {
    updateHeaderBadge();
    return;
  }
  // Personalize the welcome with the café name from settings (best-effort).
  try {
    const s = await fetch("/api/settings").then((r) => r.json());
    if (s.businessName) document.getElementById("welcomeTitle").textContent = `Welcome to ${s.businessName}!`;
  } catch (e) {}
  document.getElementById("welcomeSubtitle").textContent =
    Number(table) === parcelTable ? "Parcel / Takeaway Order" : `You're at Table ${table}`;
  document.getElementById("welcomeOverlay").classList.remove("hidden");
  setTimeout(() => document.getElementById("welcomeName").focus(), 150);
}

function startOrdering() {
  const name = document.getElementById("welcomeName").value.trim();
  if (!name) return showToast("Please enter your name to start");
  customerName = name;
  sessionStorage.setItem(NAME_KEY, name);
  document.getElementById("welcomeOverlay").classList.add("hidden");
  updateHeaderBadge();
  showToast(`Hi ${name}! Add items and place your order 🍽️`);
}

document.getElementById("welcomeStartBtn").addEventListener("click", startOrdering);
document.getElementById("welcomeName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") startOrdering();
});

updateHeaderBadge();
showWelcomeIfNeeded();

async function loadMenu() {
  [menu, categoryOrder] = await Promise.all([
    fetch("/api/menu").then((r) => r.json()),
    fetch("/api/category-order").then((r) => r.json()),
  ]);
  const cfg = await fetch(`/api/config?t=${Date.now()}`, { cache: "no-store" }).then((r) => r.json()).catch(() => ({}));
  parcelTable = cfg.parcelTable || 16;
  renderTabs();
  renderMenu();
}

// Live-reflect price changes, new items, removed items, and out-of-stock
// toggles made from the Menu Manager dashboard — no refresh needed.
socket && socket.on("menu_updated", (updatedMenu) => {
  menu = updatedMenu;
  pruneCartOfMissingOrOutOfStockItems();
  renderTabs();
  renderMenu();
  updateCartUI();
});

socket && socket.on("category_order_updated", (order) => {
  categoryOrder = order;
  renderTabs();
  renderMenu();
});

function pruneCartOfMissingOrOutOfStockItems() {
  Object.keys(cart).forEach((id) => {
    const stillThere = menu.find((m) => m.id === id && m.inStock);
    if (!stillThere) delete cart[id];
  });
}

function renderTabs() {
  const categories = orderedCategories();
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
  const categories = orderedCategories();
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
          <div class="item-desc">${item.desc}</div>
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
        <div class="item-desc">${item.desc}</div>
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
    : `<p style="color:#999;">Your cart is empty</p>`;

  const total = rows.reduce((sum, c) => sum + c.item.price * c.qty, 0);
  document.getElementById("cartTotal").textContent = total;

  // Floating View Cart bar — visible whenever the cart has items
  const bar = document.getElementById("viewCartBar");
  if (count > 0) {
    document.getElementById("viewCartBarText").textContent =
      `🛒 View Cart • ${count} item${count > 1 ? "s" : ""}`;
    document.getElementById("viewCartBarTotal").textContent = `₹${total}`;
    bar.classList.remove("hidden");
  } else {
    bar.classList.add("hidden");
  }
}

function openCart() {
  document.getElementById("cartDrawer").classList.remove("hidden");
}
document.getElementById("cartBtn").addEventListener("click", openCart);
document.getElementById("viewCartBar").addEventListener("click", openCart);
document.getElementById("closeCart").addEventListener("click", () => {
  document.getElementById("cartDrawer").classList.add("hidden");
});

let orderInFlight = false; // prevents double-tap

function showOrderSuccess() {
  document.getElementById("cartDrawer").classList.add("hidden");
  document.getElementById("orderSuccessOverlay").classList.remove("hidden");
}
function hideOrderSuccess() {
  document.getElementById("orderSuccessOverlay").classList.add("hidden");
}
document.getElementById("backToMenuBtn").addEventListener("click", hideOrderSuccess);

document.getElementById("placeOrderBtn").addEventListener("click", async () => {
  const rows = Object.values(cart);
  if (!rows.length) return showToast("Add items to cart first");
  if (!customerName) {
    document.getElementById("cartDrawer").classList.add("hidden");
    return showWelcomeIfNeeded();
  }
  if (orderInFlight) return;
  orderInFlight = true;

  const btn = document.getElementById("placeOrderBtn");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "⏳ Confirming your order…";
  btn.style.opacity = "0.75";

  const items = rows.map((c) => ({ id: c.item.id, name: c.item.name, price: c.item.price, qty: c.qty }));
  const note = document.getElementById("orderNote").value;

  try {
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table, items, note, customerName, source: "customer" }),
    });
    const data = await res.json();
    if (data.success) {
      // Clear cart immediately so the menu is ready when they go back.
      cart = {};
      document.getElementById("orderNote").value = "";
      renderMenu();
      updateCartUI();
      // Show the full-screen thank-you screen.
      showOrderSuccess();
    } else {
      showToast(data.error || "Something went wrong, please try again.");
    }
  } catch (e) {
    showToast("Network error — please try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
    btn.style.opacity = "";
    orderInFlight = false;
  }
});

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 2500);
}

loadMenu();
