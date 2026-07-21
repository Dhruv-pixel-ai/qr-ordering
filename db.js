// db.js — MongoDB connection + first-run seeding.
//
// Usage:
//   MONGODB_URI=mongodb+srv://...   → real MongoDB / Atlas (production)
//   MONGODB_URI=memory              → in-memory dev mode (NO persistence, for
//                                     trying the app without a database)
//
// Collections used: menu, orders, settings

const fs = require("fs");
const path = require("path");

const MENU_PATH = path.join(__dirname, "data", "menu.json");
const ORDERS_PATH = path.join(__dirname, "data", "orders.json");
const SETTINGS_PATH = path.join(__dirname, "data", "settings.json");

// ---------------------------------------------------------------------------
// Minimal in-memory stand-in for the small subset of the MongoDB collection
// API this app uses. Dev/testing only — data is lost when the process exits.
// ---------------------------------------------------------------------------
function createMemoryDb() {
  const store = { menu: [], orders: [], settings: [] };

  const matches = (doc, filter = {}) =>
    Object.entries(filter).every(([k, v]) => doc[k] === v);

  const applyProjection = (doc, projection) => {
    if (!projection) return { ...doc };
    const copy = { ...doc };
    for (const [k, v] of Object.entries(projection)) {
      if (v === 0) delete copy[k];
    }
    return copy;
  };

  function collection(name) {
    const docs = store[name];
    return {
      find(filter = {}, opts = {}) {
        return {
          toArray: async () =>
            docs.filter((d) => matches(d, filter)).map((d) => applyProjection(d, opts.projection)),
        };
      },
      findOne: async (filter = {}, opts = {}) => {
        const d = docs.find((x) => matches(x, filter));
        return d ? applyProjection(d, opts.projection) : null;
      },
      countDocuments: async (filter = {}) => docs.filter((d) => matches(d, filter)).length,
      insertOne: async (doc) => {
        docs.push({ ...doc });
        return { insertedId: doc.id || null };
      },
      insertMany: async (list) => {
        list.forEach((doc) => docs.push({ ...doc }));
        return { insertedCount: list.length };
      },
      updateOne: async (filter, update) => {
        const d = docs.find((x) => matches(x, filter));
        if (!d) return { matchedCount: 0, modifiedCount: 0 };
        Object.assign(d, update.$set || {});
        return { matchedCount: 1, modifiedCount: 1 };
      },
      updateMany: async (filter, update) => {
        const hits = docs.filter((d) => matches(d, filter));
        hits.forEach((d) => Object.assign(d, update.$set || {}));
        return { matchedCount: hits.length, modifiedCount: hits.length };
      },
      deleteOne: async (filter) => {
        const i = docs.findIndex((d) => matches(d, filter));
        if (i === -1) return { deletedCount: 0 };
        docs.splice(i, 1);
        return { deletedCount: 1 };
      },
      deleteMany: async (filter) => {
        const before = docs.length;
        for (let i = docs.length - 1; i >= 0; i--) {
          if (matches(docs[i], filter)) docs.splice(i, 1);
        }
        return { deletedCount: before - docs.length };
      },
      replaceOne: async (filter, doc, opts = {}) => {
        const i = docs.findIndex((x) => matches(x, filter));
        if (i === -1) {
          if (opts.upsert) {
            docs.push({ ...doc });
            return { matchedCount: 0, upsertedCount: 1 };
          }
          return { matchedCount: 0 };
        }
        docs[i] = { ...doc };
        return { matchedCount: 1, modifiedCount: 1 };
      },
    };
  }

  return { collection };
}

// ---------------------------------------------------------------------------
// Seed collections from the old JSON files on first run (empty collections).
// ---------------------------------------------------------------------------
function readJsonIfExists(p) {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    console.warn(`⚠️  Could not read ${p} for seeding:`, e.message);
  }
  return null;
}

async function seedIfEmpty(db) {
  const menuCol = db.collection("menu");
  const ordersCol = db.collection("orders");
  const settingsCol = db.collection("settings");

  if ((await menuCol.countDocuments()) === 0) {
    const menu = readJsonIfExists(MENU_PATH);
    if (menu && menu.length) {
      await menuCol.insertMany(menu);
      console.log(`🌱 Seeded ${menu.length} menu items from data/menu.json`);
    }
  }

  if ((await settingsCol.countDocuments()) === 0) {
    const settings = readJsonIfExists(SETTINGS_PATH);
    if (settings) {
      await settingsCol.insertOne({ key: "app", ...settings });
      console.log("🌱 Seeded settings from data/settings.json");
    }
  }

  if ((await ordersCol.countDocuments()) === 0) {
    const orders = readJsonIfExists(ORDERS_PATH);
    if (orders && orders.length) {
      await ordersCol.insertMany(orders);
      console.log(`🌱 Seeded ${orders.length} orders from data/orders.json`);
    }
  }
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------
async function initDb() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.DB_NAME || "kds_cafe";

  if (!uri) {
    console.error(
      "\n❌ MONGODB_URI is not set.\n" +
        "   Create a .env file (see .env.example) with your MongoDB Atlas connection string,\n" +
        '   or use MONGODB_URI=memory for a temporary in-memory dev database (no persistence).\n'
    );
    process.exit(1);
  }

  let db;
  if (uri === "memory") {
    console.log("⚠️  Using IN-MEMORY database (dev mode) — data will be lost on restart.");
    db = createMemoryDb();
  } else {
    const { MongoClient } = require("mongodb");
    const client = new MongoClient(uri);
    await client.connect();
    db = client.db(dbName);
    console.log(`🗄️  Connected to MongoDB — database: ${dbName}`);
  }

  await seedIfEmpty(db);
  return db;
}

module.exports = { initDb };
