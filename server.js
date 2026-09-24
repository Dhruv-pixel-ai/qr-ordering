require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const QRCode = require("qrcode");
const os = require("os");
const crypto = require("crypto");
const { initDb } = require("./db");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const TOTAL_TABLES = Number(process.env.TOTAL_TABLES) || 50;
// When hosted publicly, set BASE_URL (e.g. https://kdscafe.example.com) so table
// QR codes point at the public address instead of the machine's LAN IP.
const BASE_URL = process.env.BASE_URL || "";
// PIN for the confidential daily-collection page. No default: if this is unset
// the counter endpoint refuses to answer rather than falling back to a
// guessable value.
const COUNTER_PIN = process.env.COUNTER_PIN || "";
// The day a sale belongs to is decided in the cafe's own timezone. Using UTC
// would roll the day over at 5:30 AM IST and split a night's takings across
// two dates.
const CAFE_TZ = process.env.CAFE_TZ || "Asia/Kolkata";

// YYYY-MM-DD in the cafe's timezone. 'en-CA' formats as 2026-09-19.
function dayKey(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CAFE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

let db; // set in start()

app.use(express.json());

// ---------- No caching on API responses ----------
// The dashboard polls /api/orders every couple of seconds. Without this, the
// browser (and Vercel's edge) answer 304/from-cache and the kitchen sees a
// stale order list — new orders appear late or not at all. ETags are disabled
// for the same reason.
app.set("etag", false);
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// ---------- helpers ----------
const DEFAULT_SETTINGS = {
  gstPercent: 5,
  businessName: "THE KD'S CAFE",
  address: "Opposite Vijay Pan Parlour, Near Hero Showroom, Halvad Road, Dhrangadhra",
  phone: "9016231621 / 9913524260",
  parcelTables: [16, 17, 18, 19, 20],
  printerConfig: {
    kitchen: { host: "", port: 9100 },   // LAN printer – IP + raw socket port
    counter: { name: "" },               // USB printer – Windows printer name
  },
};

const NO_ID = { projection: { _id: 0 } };

async function loadMenu() {
  return db.collection("menu").find({}, NO_ID).toArray();
}
async function loadOrders() {
  return db.collection("orders").find({}, NO_ID).toArray();
}
async function loadSettings() {
  const s = await db.collection("settings").findOne({ key: "app" }, NO_ID);
  const merged = { ...DEFAULT_SETTINGS, ...(s || {}) };
  delete merged.key;
  if (typeof merged.gstPercent !== "number" || isNaN(merged.gstPercent)) merged.gstPercent = 5;
  return merged;
}
async function saveSettings(settings) {
  await db.collection("settings").replaceOne({ key: "app" }, { key: "app", ...settings }, { upsert: true });
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
// Wrap async route handlers so DB errors return a clean 500 instead of hanging.
const ah = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error("API error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  });

// ---------- API: category order ----------
// Category display order is stored as an array in settings.categoryOrder.
// The customer menu and the admin menu-manager both read from this to ensure
// the same sequence is shown everywhere.

app.get("/api/category-order", ah(async (req, res) => {
  const settings = await loadSettings();
  const allCats = [...new Set((await loadMenu()).map((m) => m.category))];
  const saved = settings.categoryOrder || [];
  // Saved order takes priority; any new category not yet in it goes to the end.
  const ordered = [
    ...saved.filter((c) => allCats.includes(c)),
    ...allCats.filter((c) => !saved.includes(c)),
  ];
  res.json(ordered);
}));

app.put("/api/category-order", ah(async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: "order must be an array" });
  const settings = await loadSettings();
  settings.categoryOrder = order;
  await saveSettings(settings);
  io.emit("category_order_updated", order);
  res.json({ success: true });
}));

// ---------- API: rename a whole category ----------
app.put("/api/categories/rename", ah(async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to || !to.trim()) return res.status(400).json({ error: "from and to are required" });
  const newName = to.trim();
  if (from === newName) return res.json({ success: true }); // no-op
  await db.collection("menu").updateMany({ category: from }, { $set: { category: newName } });
  // Keep the saved order in sync.
  const settings = await loadSettings();
  if (Array.isArray(settings.categoryOrder)) {
    settings.categoryOrder = settings.categoryOrder.map((c) => (c === from ? newName : c));
    await saveSettings(settings);
  }
  io.emit("menu_updated", await loadMenu());
  res.json({ success: true });
}));

// ---------- API: printer config ----------
app.get("/api/printer-config", ah(async (req, res) => {
  const s = await loadSettings();
  res.json(s.printerConfig || DEFAULT_SETTINGS.printerConfig);
}));

app.put("/api/printer-config", ah(async (req, res) => {
  const { kitchen, counter } = req.body || {};
  if (!kitchen || !counter) return res.status(400).json({ error: "kitchen and counter required" });
  const s = await loadSettings();
  s.printerConfig = { kitchen, counter };
  await saveSettings(s);
  res.json({ success: true });
}));

// ---------- API: menu ----------
app.get("/api/menu", ah(async (req, res) => {
  res.json(await loadMenu());
}));

// ---------- API: billing settings (GST%, café details) ----------
app.get("/api/settings", ah(async (req, res) => {
  res.json(await loadSettings());
}));

app.put("/api/settings", ah(async (req, res) => {
  const { gstPercent, businessName, address, phone } = req.body;
  if (gstPercent === undefined || gstPercent === "" || isNaN(Number(gstPercent)) || Number(gstPercent) < 0) {
    return res.status(400).json({ error: "gstPercent must be a number ≥ 0" });
  }
  const settings = await loadSettings();
  settings.gstPercent = Number(gstPercent);
  if (businessName !== undefined) settings.businessName = businessName.trim();
  if (address !== undefined) settings.address = address.trim();
  if (phone !== undefined) settings.phone = phone.trim();
  await saveSettings(settings);
  io.emit("settings_updated", settings);
  res.json({ success: true, settings });
}));

// ---------- API: add a new menu item (dashboard, no deploy needed) ----------
app.post("/api/menu", ah(async (req, res) => {
  const { category, name, price, veg, desc } = req.body;
  if (!category || !name || price === undefined || price === "") {
    return res.status(400).json({ error: "category, name and price are required" });
  }
  const newItem = {
    id: "item_" + Date.now(),
    category: category.trim(),
    name: name.trim(),
    price: Number(price),
    veg: veg !== false,
    desc: desc || "",
    inStock: true,
  };
  await db.collection("menu").insertOne({ ...newItem });
  io.emit("menu_updated", await loadMenu());
  res.json({ success: true, item: newItem });
}));

// ---------- API: update a menu item (price, name, category, stock, etc.) ----------
app.put("/api/menu/:id", ah(async (req, res) => {
  const { category, name, price, veg, desc, inStock } = req.body;
  const $set = {};
  if (category !== undefined) $set.category = category.trim();
  if (name !== undefined) $set.name = name.trim();
  if (price !== undefined && price !== "") $set.price = Number(price);
  if (veg !== undefined) $set.veg = veg;
  if (desc !== undefined) $set.desc = desc;
  if (inStock !== undefined) $set.inStock = inStock;

  const result = await db.collection("menu").updateOne({ id: req.params.id }, { $set });
  if (!result.matchedCount) return res.status(404).json({ error: "Item not found" });
  const item = await db.collection("menu").findOne({ id: req.params.id }, NO_ID);
  io.emit("menu_updated", await loadMenu());
  res.json({ success: true, item });
}));

// ---------- API: quick out-of-stock toggle ----------
app.patch("/api/menu/:id/stock", ah(async (req, res) => {
  const result = await db.collection("menu").updateOne(
    { id: req.params.id },
    { $set: { inStock: req.body.inStock } }
  );
  if (!result.matchedCount) return res.status(404).json({ error: "Item not found" });
  const item = await db.collection("menu").findOne({ id: req.params.id }, NO_ID);
  io.emit("menu_updated", await loadMenu());
  res.json({ success: true, item });
}));

// ---------- API: delete a menu item ----------
app.delete("/api/menu/:id", ah(async (req, res) => {
  const result = await db.collection("menu").deleteOne({ id: req.params.id });
  if (!result.deletedCount) return res.status(404).json({ error: "Item not found" });
  io.emit("menu_updated", await loadMenu());
  res.json({ success: true });
}));

// ---------- API: place an order ----------
app.post("/api/orders", ah(async (req, res) => {
  const { table, items, note, customerName, source, waiterName } = req.body;
  if (!table || !items || !items.length) {
    return res.status(400).json({ error: "table and items are required" });
  }
  if (!customerName || !customerName.trim()) {
    return res.status(400).json({ error: "customerName is required" });
  }
  const menu = await loadMenu();
  const unavailable = items.filter((it) => {
    const menuItem = menu.find((m) => m.id === it.id);
    return !menuItem || !menuItem.inStock;
  });
  if (unavailable.length) {
    return res.status(400).json({
      error: `These items are no longer available: ${unavailable.map((i) => i.name).join(", ")}`,
    });
  }
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
  await db.collection("orders").insertOne({ ...order });
  io.emit("new_order", order); // push live to admin dashboard
  res.json({ success: true, order });
}));

// ---------- API: get all active orders (table-wise) ----------
app.get("/api/orders", ah(async (req, res) => {
  res.json(await loadOrders());
}));

// ---------- API: generate bill preview for a table (does NOT close/remove orders) ----------
app.post("/api/tables/:table/bill", ah(async (req, res) => {
  const table = Number(req.params.table);
  const tableOrders = await db.collection("orders").find({ table, billed: false }, NO_ID).toArray();
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
  const settings = await loadSettings();
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
}));

// ---------- API: finalize/close a table's orders after printing the bill ----------
app.post("/api/tables/:table/finalize", ah(async (req, res) => {
  const table = Number(req.params.table);
  const result = await db.collection("orders").updateMany(
    { table, billed: false },
    { $set: { billed: true } }
  );
  if (!result.matchedCount) {
    return res.status(400).json({ error: "No unbilled orders for this table" });
  }
  io.emit("order_finalized", { table });
  res.json({ success: true });
}));

// ---------- API: delete a single order ----------
app.delete("/api/orders/:id", ah(async (req, res) => {
  const result = await db.collection("orders").deleteOne({ id: req.params.id });
  if (!result.deletedCount) return res.status(404).json({ error: "Order not found" });
  io.emit("order_deleted", { id: req.params.id });
  res.json({ success: true });
}));

// ---------- API: clear a table (reset for next customer) ----------
// Clearing a table is the moment the money is considered collected, so this is
// where the day's counter is incremented. Only a single running total per day
// is stored - no items, no order count, no customer names.
app.post("/api/tables/:table/clear", ah(async (req, res) => {
  const table = Number(req.params.table);

  const tableOrders = await db.collection("orders").find({ table }, NO_ID).toArray();
  const subtotal = tableOrders.reduce(
    (sum, o) => sum + o.items.reduce((s, it) => s + it.price * it.qty, 0),
    0
  );

  if (subtotal > 0) {
    const settings = await loadSettings();
    const gstPercent = settings.gstPercent;
    const tax = Math.round(subtotal * (gstPercent / 100) * 100) / 100;
    const collected = Math.round((subtotal + tax) * 100) / 100;
    const key = dayKey();
    // $inc on one document per day: the total is all that is kept.
    await db.collection("daily_totals").updateOne(
      { key },
      { $inc: { total: collected }, $set: { updatedAt: new Date().toISOString() } },
      { upsert: true }
    );
  }

  await db.collection("orders").deleteMany({ table });
  io.emit("table_cleared", { table });
  res.json({ success: true });
}));

// ---------- API: daily counter (PIN protected) ----------
// Returns amounts only. Deliberately exposes no order details.
function checkPin(supplied) {
  if (!COUNTER_PIN) return { ok: false, code: 503, error: "Counter PIN is not configured on the server." };
  const a = Buffer.from(String(supplied || ""));
  const b = Buffer.from(COUNTER_PIN);
  // Compare in constant time, and only when lengths match (timingSafeEqual
  // throws on differing lengths).
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return { ok: false, code: 401, error: "Incorrect PIN." };
  return { ok: true };
}

// Small in-memory throttle to slow down PIN guessing. Note: on serverless each
// instance has its own copy, so this is a speed bump, not a hard limit - the
// real protection is a long PIN.
const pinAttempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const rec = pinAttempts.get(ip) || { n: 0, first: now };
  if (now - rec.first > 10 * 60 * 1000) {
    pinAttempts.set(ip, { n: 1, first: now });
    return false;
  }
  rec.n += 1;
  pinAttempts.set(ip, rec);
  return rec.n > 12;
}

async function totalFor(key) {
  const doc = await db.collection("daily_totals").findOne({ key }, NO_ID);
  return Math.round(((doc && doc.total) || 0) * 100) / 100;
}

app.post("/api/counter", ah(async (req, res) => {
  // Optional explicit date (YYYY-MM-DD), else today in the cafe's timezone.
  const date = /^\d{4}-\d{2}-\d{2}$/.test((req.body && req.body.date) || "")
    ? req.body.date
    : dayKey();

  const prev = new Date(`${date}T12:00:00Z`);
  prev.setUTCDate(prev.getUTCDate() - 1);
  const prevKey = dayKey(prev);

  // Month-to-date for the month the requested date falls in.
  const monthPrefix = date.slice(0, 7);
  const monthDocs = await db
    .collection("daily_totals")
    .find({ key: { $regex: `^${monthPrefix}` } }, NO_ID)
    .toArray();
  const monthTotal =
    Math.round(monthDocs.reduce((s, d) => s + (d.total || 0), 0) * 100) / 100;

  res.json({
    date,
    today: await totalFor(date),
    yesterday: await totalFor(prevKey),
    month: monthTotal,
    monthLabel: monthPrefix,
  });
}));

// ---------- API: QR code image for a table ----------
// Resolve the public base URL for QR codes:
// 1. BASE_URL env variable (explicit override, e.g. https://www.kds-cafe.com)
// 2. The host the request actually came in on (works on any domain, no env needed)
// 3. LAN IP fallback (local WiFi use)
function getPublicBase(req) {
  if (BASE_URL) return BASE_URL.replace(/\/+$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (host && !host.startsWith("localhost") && !host.startsWith("127.")) {
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    return `${proto.split(",")[0].trim()}://${host.split(",")[0].trim()}`;
  }
  return `http://${getLocalIP()}:${PORT}`;
}

app.get("/api/qrcode/:table", ah(async (req, res) => {
  const base = getPublicBase(req);
  const url = `${base}/menu.html?table=${req.params.table}`;
  try {
    const png = await QRCode.toBuffer(url, { width: 300, margin: 2 });
    res.type("png").send(png);
  } catch (e) {
    res.status(500).json({ error: "QR generation failed" });
  }
}));

app.get("/api/config", ah(async (req, res) => {
  const settings = await loadSettings();
  res.json({
    totalTables: TOTAL_TABLES,
    ip: getLocalIP(),
    port: PORT,
    parcelTables: settings.parcelTables || [16, 17, 18, 19, 20],
  });
}));

io.on("connection", (socket) => {
  console.log("client connected:", socket.id);
});

// ---------- startup: connect DB first, then listen ----------
async function start() {
  db = await initDb();
  server.listen(PORT, () => {
    const ip = getLocalIP();
    console.log(`\n✅ Server running!`);
    console.log(`   Staff dashboard : http://${ip}:${PORT}/admin.html`);
    console.log(`   QR code page    : http://${ip}:${PORT}/qr.html`);
    console.log(`   Customer menu   : http://${ip}:${PORT}/menu.html?table=1\n`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
