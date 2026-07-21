const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const os = require("os");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const TOTAL_TABLES = 50; // change to match your restaurant

const MENU_PATH = path.join(__dirname, "data", "menu.json");
const ORDERS_PATH = path.join(__dirname, "data", "orders.json");
const SETTINGS_PATH = path.join(__dirname, "data", "settings.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- helpers ----------
function loadMenu() {
  return JSON.parse(fs.readFileSync(MENU_PATH, "utf-8"));
}
function saveMenu(menu) {
  fs.writeFileSync(MENU_PATH, JSON.stringify(menu, null, 2));
}
function loadOrders() {
  if (!fs.existsSync(ORDERS_PATH)) return [];
  return JSON.parse(fs.readFileSync(ORDERS_PATH, "utf-8"));
}
function saveOrders(orders) {
  fs.writeFileSync(ORDERS_PATH, JSON.stringify(orders, null, 2));
}
const DEFAULT_SETTINGS = {
  gstPercent: 5,
  businessName: "THE KD'S CAFE",
  address: "Opposite Vijay Pan Parlour, Near Hero Showroom, Halvad Road, Dhrangadhra",
  phone: "9016231621 / 9913524260",
};
function loadSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) return { ...DEFAULT_SETTINGS };
  const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
  const merged = { ...DEFAULT_SETTINGS, ...s };
  if (typeof merged.gstPercent !== "number" || isNaN(merged.gstPercent)) merged.gstPercent = 5;
  return merged;
}
function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

// ---------- API: menu ----------
app.get("/api/menu", (req, res) => {
  res.json(loadMenu());
});

// ---------- API: billing settings (GST%) ----------
app.get("/api/settings", (req, res) => {
  res.json(loadSettings());
});

app.put("/api/settings", (req, res) => {
  const { gstPercent, businessName, address, phone } = req.body;
  if (gstPercent === undefined || gstPercent === "" || isNaN(Number(gstPercent)) || Number(gstPercent) < 0) {
    return res.status(400).json({ error: "gstPercent must be a number ≥ 0" });
  }
  const settings = loadSettings();
  settings.gstPercent = Number(gstPercent);
  if (businessName !== undefined) settings.businessName = businessName.trim();
  if (address !== undefined) settings.address = address.trim();
  if (phone !== undefined) settings.phone = phone.trim();
  saveSettings(settings);
  io.emit("settings_updated", settings);
  res.json({ success: true, settings });
});

// ---------- API: add a new menu item (dashboard, no deploy needed) ----------
app.post("/api/menu", (req, res) => {
  const { category, name, price, veg, desc } = req.body;
  if (!category || !name || price === undefined || price === "") {
    return res.status(400).json({ error: "category, name and price are required" });
  }
  const menu = loadMenu();
  const newItem = {
    id: "item_" + Date.now(),
    category: category.trim(),
    name: name.trim(),
    price: Number(price),
    veg: veg !== false,
    desc: desc || "",
    inStock: true,
  };
  menu.push(newItem);
  saveMenu(menu);
  io.emit("menu_updated", menu);
  res.json({ success: true, item: newItem });
});

// ---------- API: update a menu item (price, name, category, stock, etc.) ----------
app.put("/api/menu/:id", (req, res) => {
  const menu = loadMenu();
  const item = menu.find((m) => m.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });
  const { category, name, price, veg, desc, inStock } = req.body;
  if (category !== undefined) item.category = category.trim();
  if (name !== undefined) item.name = name.trim();
  if (price !== undefined && price !== "") item.price = Number(price);
  if (veg !== undefined) item.veg = veg;
  if (desc !== undefined) item.desc = desc;
  if (inStock !== undefined) item.inStock = inStock;
  saveMenu(menu);
  io.emit("menu_updated", menu);
  res.json({ success: true, item });
});

// ---------- API: quick out-of-stock toggle ----------
app.patch("/api/menu/:id/stock", (req, res) => {
  const menu = loadMenu();
  const item = menu.find((m) => m.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });
  item.inStock = req.body.inStock;
  saveMenu(menu);
  io.emit("menu_updated", menu);
  res.json({ success: true, item });
});

// ---------- API: delete a menu item ----------
app.delete("/api/menu/:id", (req, res) => {
  let menu = loadMenu();
  const exists = menu.some((m) => m.id === req.params.id);
  if (!exists) return res.status(404).json({ error: "Item not found" });
  menu = menu.filter((m) => m.id !== req.params.id);
  saveMenu(menu);
  io.emit("menu_updated", menu);
  res.json({ success: true });
});

// ---------- API: place an order ----------
app.post("/api/orders", (req, res) => {
  const { table, items, note, customerName, source, waiterName } = req.body;
  if (!table || !items || !items.length) {
    return res.status(400).json({ error: "table and items are required" });
  }
  if (!customerName || !customerName.trim()) {
    return res.status(400).json({ error: "customerName is required" });
  }
  const menu = loadMenu();
  const unavailable = items.filter((it) => {
    const menuItem = menu.find((m) => m.id === it.id);
    return !menuItem || !menuItem.inStock;
  });
  if (unavailable.length) {
    return res.status(400).json({
      error: `These items are no longer available: ${unavailable.map((i) => i.name).join(", ")}`,
    });
  }
  const orders = loadOrders();
  const order = {
    id: "ord_" + Date.now(),
    table: Number(table),
    items, // [{id, name, price, qty}]
    note: note || "",
    customerName: customerName.trim(),
    source: source === "waiter" ? "waiter" : "customer", // who placed it
    waiterName: source === "waiter" ? (waiterName || "").trim() : "",
    billed: false,
    createdAt: new Date().toISOString(),
  };
  orders.push(order);
  saveOrders(orders);
  io.emit("new_order", order); // push live to admin dashboard
  res.json({ success: true, order });
});

// ---------- API: get all active orders (table-wise) ----------
app.get("/api/orders", (req, res) => {
  res.json(loadOrders());
});

// ---------- API: generate bill preview for a table (does NOT close/remove orders) ----------
app.post("/api/tables/:table/bill", (req, res) => {
  const table = Number(req.params.table);
  const orders = loadOrders();
  const tableOrders = orders.filter((o) => o.table === table && !o.billed);
  if (!tableOrders.length) {
    return res.status(400).json({ error: "No unbilled orders for this table" });
  }
  const lineItems = {};
  tableOrders.forEach((o) => {
    o.items.forEach((it) => {
      const key = it.id;
      if (!lineItems[key]) lineItems[key] = { name: it.name, price: it.price, qty: 0 };
      lineItems[key].qty += it.qty;
    });
  });
  const items = Object.values(lineItems);
  const subtotal = items.reduce((sum, it) => sum + it.price * it.qty, 0);
  const settings = loadSettings();
  const gstPercent = settings.gstPercent; // configurable via Menu Manager, can be 0
  const tax = Math.round(subtotal * (gstPercent / 100) * 100) / 100;
  const total = Math.round((subtotal + tax) * 100) / 100;
  const customerNames = [...new Set(tableOrders.map((o) => o.customerName).filter(Boolean))];

  // NOTE: orders are intentionally NOT mutated here. Generating the bill is just
  // a preview — orders remain visible on the dashboard until Print or Clear Table
  // is explicitly clicked.
  const bill = {
    table,
    items,
    subtotal,
    gstPercent,
    tax,
    total,
    customerNames,
    businessName: settings.businessName,
    address: settings.address,
    phone: settings.phone,
    billNo: String(Date.now()).slice(-6),
    generatedAt: new Date().toISOString(),
  };
  res.json(bill);
});

// ---------- API: finalize/close a table's orders after printing the bill ----------
app.post("/api/tables/:table/finalize", (req, res) => {
  const table = Number(req.params.table);
  const orders = loadOrders();
  const tableOrders = orders.filter((o) => o.table === table && !o.billed);
  if (!tableOrders.length) {
    return res.status(400).json({ error: "No unbilled orders for this table" });
  }
  tableOrders.forEach((o) => (o.billed = true));
  saveOrders(orders);
  io.emit("order_finalized", { table });
  res.json({ success: true });
});

// ---------- API: clear a table (reset for next customer) ----------
app.post("/api/tables/:table/clear", (req, res) => {
  const table = Number(req.params.table);
  let orders = loadOrders();
  orders = orders.filter((o) => o.table !== table);
  saveOrders(orders);
  io.emit("table_cleared", { table });
  res.json({ success: true });
});

// ---------- API: QR code image for a table ----------
app.get("/api/qrcode/:table", async (req, res) => {
  const ip = getLocalIP();
  const url = `http://${ip}:${PORT}/menu.html?table=${req.params.table}`;
  try {
    const png = await QRCode.toBuffer(url, { width: 300, margin: 2 });
    res.type("png").send(png);
  } catch (e) {
    res.status(500).json({ error: "QR generation failed" });
  }
});

app.get("/api/config", (req, res) => {
  res.json({ totalTables: TOTAL_TABLES, ip: getLocalIP(), port: PORT });
});

io.on("connection", (socket) => {
  console.log("client connected:", socket.id);
});

server.listen(PORT, () => {
  const ip = getLocalIP();
  console.log(`\n✅ Server running!`);
  console.log(`   Staff dashboard : http://${ip}:${PORT}/admin.html`);
  console.log(`   QR code page    : http://${ip}:${PORT}/qr.html`);
  console.log(`   Customer menu   : http://${ip}:${PORT}/menu.html?table=1\n`);
});
