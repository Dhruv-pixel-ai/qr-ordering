const socket = io();
let menu = [];

async function init() {
  menu = await fetch("/api/menu").then((r) => r.json());
  render();
  const settings = await fetch("/api/settings").then((r) => r.json());
  applySettingsToForm(settings);
}

function applySettingsToForm(settings) {
  document.getElementById("gstInput").value = settings.gstPercent;
  document.getElementById("businessNameInput").value = settings.businessName || "";
  document.getElementById("phoneInput").value = settings.phone || "";
  document.getElementById("addressInput").value = settings.address || "";
}

document.getElementById("saveGstBtn").addEventListener("click", async () => {
  const gstPercent = document.getElementById("gstInput").value;
  const businessName = document.getElementById("businessNameInput").value;
  const phone = document.getElementById("phoneInput").value;
  const address = document.getElementById("addressInput").value;
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gstPercent, businessName, phone, address }),
  });
  const data = await res.json();
  if (data.success) {
    showToast(`Settings saved — GST ${data.settings.gstPercent}%`);
  } else {
    showToast(data.error || "Could not update settings");
  }
});

socket.on("settings_updated", (settings) => {
  // Don't overwrite fields while someone is actively typing in this tab.
  const active = document.activeElement;
  const formIds = ["gstInput", "businessNameInput", "phoneInput", "addressInput"];
  if (!active || !formIds.includes(active.id)) {
    applySettingsToForm(settings);
  }
});

// Live updates from other devices/tabs (waiter app, customer menu, or another
// manager tab) all flow through this same event.
socket.on("menu_updated", (updatedMenu) => {
  menu = updatedMenu;
  // Don't yank the list out from under someone who is mid-edit in a text field.
  const activeInList = document.activeElement && document.getElementById("menuManagerList").contains(document.activeElement);
  if (!activeInList) render();
});

function render() {
  const categories = [...new Set(menu.map((m) => m.category))];
  const listEl = document.getElementById("menuManagerList");
  listEl.innerHTML = categories
    .map(
      (cat) => `
      <div class="mm-category">
        <h3>${cat}</h3>
        ${menu
          .filter((m) => m.category === cat)
          .map(renderRow)
          .join("")}
      </div>
    `
    )
    .join("");

  // populate category datalist for the "add item" form
  document.getElementById("categoryList").innerHTML = categories.map((c) => `<option value="${c}">`).join("");

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
        <option value="true" ${item.veg ? "selected" : ""}>Veg</option>
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

function escapeAttr(str) {
  return String(str).replace(/"/g, "&quot;");
}

function attachHandlers() {
  document.querySelectorAll(".mm-row").forEach((row) => {
    const id = row.dataset.id;

    row.querySelector(".mm-name-input").addEventListener("change", (e) => {
      updateItem(id, { name: e.target.value });
    });
    row.querySelector(".mm-desc-input").addEventListener("change", (e) => {
      updateItem(id, { desc: e.target.value });
    });
    row.querySelector(".mm-price-input").addEventListener("change", (e) => {
      updateItem(id, { price: e.target.value });
    });
    row.querySelector(".mm-veg-select").addEventListener("change", (e) => {
      updateItem(id, { veg: e.target.value === "true" });
    });
    row.querySelector(".mm-stock-checkbox").addEventListener("change", (e) => {
      updateStock(id, e.target.checked);
    });
    row.querySelector(".mm-delete-btn").addEventListener("click", () => deleteItem(id, row));
  });
}

async function updateItem(id, patch) {
  const res = await fetch(`/api/menu/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
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
  const res = await fetch(`/api/menu/${id}/stock`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
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
  const res = await fetch(`/api/menu/${id}`, { method: "DELETE" });
  const data = await res.json();
  if (data.success) {
    menu = menu.filter((m) => m.id !== id);
    row.remove();
    showToast("Item removed");
  }
}

document.getElementById("addItemBtn").addEventListener("click", async () => {
  const category = document.getElementById("newCategory").value.trim();
  const name = document.getElementById("newName").value.trim();
  const price = document.getElementById("newPrice").value;
  const veg = document.getElementById("newVeg").value === "true";
  const desc = document.getElementById("newDesc").value.trim();

  if (!category || !name || !price) {
    return showToast("Category, name and price are required");
  }

  const res = await fetch("/api/menu", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category, name, price, veg, desc }),
  });
  const data = await res.json();
  if (data.success) {
    menu.push(data.item);
    render();
    document.getElementById("newCategory").value = "";
    document.getElementById("newName").value = "";
    document.getElementById("newPrice").value = "";
    document.getElementById("newDesc").value = "";
    showToast("Item added");
  } else {
    showToast(data.error || "Could not add item");
  }
});

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 2000);
}

init();
