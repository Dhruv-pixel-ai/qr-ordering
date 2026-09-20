const socket = typeof io !== "undefined" ? io() : null;
let menu = [];
let categoryOrder = []; // authoritative display order, persisted server-side

// ─── init ──────────────────────────────────────────────────────────────────
async function init() {
  [menu, categoryOrder] = await Promise.all([
    fetch("/api/menu").then((r) => r.json()),
    fetch("/api/category-order").then((r) => r.json()),
  ]);
  render();
  const settings = await fetch("/api/settings").then((r) => r.json());
  applySettingsToForm(settings);
}

// ─── settings form ─────────────────────────────────────────────────────────
function applySettingsToForm(s) {
  document.getElementById("gstInput").value          = s.gstPercent;
  document.getElementById("businessNameInput").value = s.businessName || "";
  document.getElementById("phoneInput").value        = s.phone || "";
  document.getElementById("addressInput").value      = s.address || "";
}

document.getElementById("saveGstBtn").addEventListener("click", async () => {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      gstPercent:   document.getElementById("gstInput").value,
      businessName: document.getElementById("businessNameInput").value,
      phone:        document.getElementById("phoneInput").value,
      address:      document.getElementById("addressInput").value,
    }),
  });
  const data = await res.json();
  showToast(data.success ? `Settings saved — GST ${data.settings.gstPercent}%` : data.error || "Could not save");
});

socket && socket.on("settings_updated", (s) => {
  const active = document.activeElement;
  const formIds = ["gstInput", "businessNameInput", "phoneInput", "addressInput"];
  if (!active || !formIds.includes(active.id)) applySettingsToForm(s);
});

socket && socket.on("menu_updated", (updated) => {
  menu = updated;
  const activeInList = document.activeElement &&
    document.getElementById("menuManagerList").contains(document.activeElement);
  if (!activeInList) render();
});

socket && socket.on("category_order_updated", (order) => {
  categoryOrder = order;
});

// ─── helpers ───────────────────────────────────────────────────────────────
function escapeAttr(str) {
  return String(str == null ? "" : str).replace(/"/g, "&quot;");
}

// Merge saved order with actual categories so new ones always appear at end.
function orderedCategories() {
  const all = [...new Set(menu.map((m) => m.category))];
  return [
    ...categoryOrder.filter((c) => all.includes(c)),
    ...all.filter((c) => !categoryOrder.includes(c)),
  ];
}

// ─── render ────────────────────────────────────────────────────────────────
function render() {
  const cats = orderedCategories();
  const listEl = document.getElementById("menuManagerList");

  listEl.innerHTML = cats.map((cat, idx) => `
    <div class="mm-category" data-cat="${escapeAttr(cat)}">
      <div class="mm-cat-header">

        <!-- Req 2: editable category name -->
        <input
          class="mm-cat-name-input"
          value="${escapeAttr(cat)}"
          data-original="${escapeAttr(cat)}"
          title="Click to rename this category"
        />

        <!-- Req 3: up / down buttons to reorder -->
        <div class="mm-cat-order-btns">
          <button class="mm-cat-btn" data-action="cat-up"   data-cat="${escapeAttr(cat)}" ${idx === 0 ? "disabled" : ""}>▲</button>
          <button class="mm-cat-btn" data-action="cat-down" data-cat="${escapeAttr(cat)}" ${idx === cats.length - 1 ? "disabled" : ""}>▼</button>
        </div>
      </div>

      ${menu.filter((m) => m.category === cat).map(renderRow).join("")}
    </div>
  `).join("");

  // Populate category datalist for the "add item" form.
  document.getElementById("categoryList").innerHTML =
    cats.map((c) => `<option value="${escapeAttr(c)}">`).join("");

  attachHandlers();
}

function renderRow(item) {
  return `
    <div class="mm-row ${item.inStock ? "" : "out-of-stock"}" data-id="${item.id}">
      <div class="mm-name-block">
        <input class="mm-name-input" value="${escapeAttr(item.name)}" />
        <input class="mm-desc-input" value="${escapeAttr(item.desc || "")}" placeholder="description" />
      </div>
      <select class="mm-veg-select">
        <option value="true"  ${item.veg  ? "selected" : ""}>Veg</option>
        <option value="false" ${!item.veg ? "selected" : ""}>Non-Veg</option>
      </select>
      <span>₹</span>
      <input class="mm-price-input" type="number" value="${item.price}" />
      <label class="stock-toggle">
        <input type="checkbox" class="mm-stock-checkbox" ${item.inStock ? "checked" : ""} />
        In stock
      </label>
      <button class="mm-delete-btn" title="Remove item">🗑</button>
    </div>
  `;
}

// ─── attach all event handlers ─────────────────────────────────────────────
function attachHandlers() {
  // Req 2: rename category on blur (if value changed).
  document.querySelectorAll(".mm-cat-name-input").forEach((inp) => {
    inp.addEventListener("blur", async () => {
      const from = inp.dataset.original;
      const to   = inp.value.trim();
      if (!to || to === from) { inp.value = from; return; }
      const res  = await fetch("/api/categories/rename", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to }),
      });
      const data = await res.json();
      if (data.success) {
        // Update local state so re-render uses the new name.
        menu = menu.map((m) => m.category === from ? { ...m, category: to } : m);
        categoryOrder = categoryOrder.map((c) => c === from ? to : c);
        inp.dataset.original = to;
        showToast(`Category renamed to "${to}"`);
        render();
      } else {
        showToast(data.error || "Rename failed");
        inp.value = from;
      }
    });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") inp.blur();
      if (e.key === "Escape") { inp.value = inp.dataset.original; inp.blur(); }
    });
  });

  // Req 3: move category up or down.
  document.querySelectorAll("[data-action='cat-up'], [data-action='cat-down']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const cat  = btn.dataset.cat;
      const cats = orderedCategories();
      const idx  = cats.indexOf(cat);
      if (btn.dataset.action === "cat-up"   && idx > 0)              cats.splice(idx - 1, 0, cats.splice(idx, 1)[0]);
      if (btn.dataset.action === "cat-down" && idx < cats.length - 1) cats.splice(idx + 1, 0, cats.splice(idx, 1)[0]);

      categoryOrder = cats;
      render(); // instant local feedback

      const res = await fetch("/api/category-order", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: cats }),
      });
      if (!res.ok) showToast("Could not save order");
    });
  });

  // Item-level handlers (unchanged).
  document.querySelectorAll(".mm-row").forEach((row) => {
    const id = row.dataset.id;
    row.querySelector(".mm-name-input").addEventListener("change",  (e) => updateItem(id, { name: e.target.value }));
    row.querySelector(".mm-desc-input").addEventListener("change",  (e) => updateItem(id, { desc: e.target.value }));
    row.querySelector(".mm-price-input").addEventListener("change", (e) => updateItem(id, { price: e.target.value }));
    row.querySelector(".mm-veg-select").addEventListener("change",  (e) => updateItem(id, { veg: e.target.value === "true" }));
    row.querySelector(".mm-stock-checkbox").addEventListener("change", (e) => updateStock(id, e.target.checked));
    row.querySelector(".mm-delete-btn").addEventListener("click", () => deleteItem(id, row));
  });
}

// ─── item CRUD ─────────────────────────────────────────────────────────────
async function updateItem(id, patch) {
  const res  = await fetch(`/api/menu/${id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await res.json();
  if (data.success) {
    const idx = menu.findIndex((m) => m.id === id);
    if (idx >= 0) menu[idx] = data.item;
    showToast("Saved");
  } else {
    showToast(data.error || "Update failed");
  }
}

async function updateStock(id, inStock) {
  const res  = await fetch(`/api/menu/${id}/stock`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inStock }),
  });
  const data = await res.json();
  if (data.success) {
    const idx = menu.findIndex((m) => m.id === id);
    if (idx >= 0) menu[idx] = data.item;
    render();
    showToast(inStock ? "Marked in stock" : "Marked out of stock");
  }
}

async function deleteItem(id, row) {
  if (!confirm("Remove this item from the menu?")) return;
  const res  = await fetch(`/api/menu/${id}`, { method: "DELETE" });
  const data = await res.json();
  if (data.success) {
    menu = menu.filter((m) => m.id !== id);
    row.remove();
    showToast("Item removed");
  }
}

document.getElementById("addItemBtn").addEventListener("click", async () => {
  const category = document.getElementById("newCategory").value.trim();
  const name     = document.getElementById("newName").value.trim();
  const price    = document.getElementById("newPrice").value;
  const veg      = document.getElementById("newVeg").value === "true";
  const desc     = document.getElementById("newDesc").value.trim();
  if (!category || !name || !price) return showToast("Category, name and price are required");

  const res  = await fetch("/api/menu", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category, name, price, veg, desc }),
  });
  const data = await res.json();
  if (data.success) {
    menu.push(data.item);
    // If this is a brand-new category, append it to the order.
    if (!categoryOrder.includes(category)) {
      categoryOrder.push(category);
      await fetch("/api/category-order", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: categoryOrder }),
      });
    }
    render();
    ["newCategory","newName","newPrice","newDesc"].forEach((id) => {
      document.getElementById(id).value = "";
    });
    showToast("Item added");
  } else {
    showToast(data.error || "Could not add item");
  }
});

// ─── toast ─────────────────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  setTimeout(() => t.classList.add("hidden"), 2000);
}

init();
