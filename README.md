# QR Code Food Ordering System — THE KD'S CAFE

A complete QR ordering system for a restaurant. Storage is **MongoDB (Atlas)** so data survives redeploys and works on cloud hosting. No payment gateway — bills are settled manually.

## What it does
- Each table has its own QR code (pointing to `menu.html?table=N`) for customers who want to order themselves.
- **Waiter order entry** (`waiter.html`) — waiter picks the table number, enters the customer's name, and places the order for them. Shows up on the dashboard exactly like a self-order.
- Every order (self or waiter-placed) requires a **customer name** — shown on the dashboard and the bill.
- Orders appear **instantly** on the admin dashboard, grouped by table (Socket.io real-time sync).
- Orders **stay visible** until the staff explicitly finishes them: Generate Bill is a *preview*; the order only closes on **Print** or **Clear Table**. Just closing the bill popup changes nothing.
- Bills print in **KOT/thermal receipt format (80mm)**, with café name, address, phone, bill no., GST and totals.
- **Menu Manager** (`menu-manager.html`): add/edit/delete items, change prices, mark out-of-stock, and edit café details + GST% — all live, no restart, no developer.

## Setup

### 1. Create a MongoDB Atlas cluster (free)
1. Go to https://www.mongodb.com/cloud/atlas and sign up (free tier is enough).
2. Create a cluster (choose the free **M0** tier, any nearby region e.g. Mumbai).
3. In **Database Access**, create a database user with a username + password.
4. In **Network Access**, add your IP — or `0.0.0.0/0` to allow from anywhere (needed for most cloud hosts).
5. Click **Connect → Drivers** and copy the connection string. It looks like:
   ```
   mongodb+srv://USERNAME:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```

### 2. Configure environment variables
```bash
cd qr-ordering
cp .env.example .env
```
Edit `.env` and set:
```
MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
DB_NAME=kds_cafe
```
**Never commit `.env` to git** — it contains your database password. It's already in `.gitignore`.

> **No Atlas yet? Quick trial mode:** set `MONGODB_URI=memory` to run with a temporary in-memory database. Everything works, but **all data is lost when the server stops** — use it only to try the app, never in production.

### 3. Install & run
Requires [Node.js](https://nodejs.org) v18+.
```bash
npm install
npm start
```
On **first startup with an empty database**, the app automatically migrates (seeds) your existing data from `data/menu.json` and `data/settings.json` (and `data/orders.json` if present) into MongoDB. After that, MongoDB is the source of truth — the JSON files are no longer read or written.

You'll see:
```
🗄️  Connected to MongoDB — database: kds_cafe
🌱 Seeded 84 menu items from data/menu.json
✅ Server running!
```

### 4. Deploying to a cloud host (Render / Railway / Fly.io / a VPS, etc.)
1. Push the code to a git repo (the `.gitignore` keeps `.env` and `node_modules` out).
2. On your host, set these **environment variables** in its dashboard (don't upload `.env`):
   - `MONGODB_URI` — your Atlas connection string
   - `DB_NAME` — e.g. `kds_cafe`
   - `TOTAL_TABLES` — e.g. `50`
   - `BASE_URL` — your public URL, e.g. `https://kdscafe.onrender.com` — **important**: this makes the printed table QR codes point to your public site instead of a LAN IP.
   - `PORT` is usually set automatically by the host.
3. Set the start command to `npm start`.
4. In Atlas **Network Access**, make sure your host's IPs are allowed (simplest: `0.0.0.0/0`).
5. Re-print QR codes from `/qr.html` after deploying so they contain the public URL.

## Daily use
- **Staff dashboard:** `/admin.html` — live table-wise orders, Generate Bill, Print, Clear Table.
- **Print table QR codes:** `/qr.html` → Print All.
- **Waiter order entry:** `/waiter.html` (also linked from the dashboard header).
- **Menu Manager:** `/menu-manager.html` — menu items + Billing Settings (café name/address/phone, GST%).
- **Customer:** scans the table QR → `menu.html?table=N` → browses, adds to cart, enters name, places order.

## Bill behavior (important)
- **Generate Bill** = preview only. Order stays on the dashboard.
- **Print** = prints receipt (80mm KOT format) and closes the order.
- **Clear Table** = closes/removes the order and frees the table.
- **Close** = just closes the popup; nothing changes.
- GST% changes apply to the *next* bill generated (already-closed bills keep their original rate).

## Data storage
MongoDB collections:
| Collection | Contents |
|---|---|
| `menu` | Menu items (`id`, `category`, `name`, `price`, `veg`, `desc`, `inStock`) |
| `orders` | Orders (`id`, `table`, `items[]`, `customerName`, `source`, `waiterName`, `billed`, `createdAt`) |
| `settings` | One document (`key: "app"`): `gstPercent`, `businessName`, `address`, `phone` |

The old `data/*.json` files are kept only as the **one-time seed source** for a fresh database.

## Folder structure
```
qr-ordering/
  server.js            # Express + Socket.io backend, all APIs (MongoDB-backed)
  db.js                # MongoDB connection + first-run seeding (+ dev memory mode)
  .env.example         # Template for environment variables (copy to .env)
  data/menu.json        # Seed data only (first run into an empty DB)
  data/settings.json    # Seed data only
  public/
    menu.html/css/js       # Customer-facing menu + cart (self-order via QR)
    waiter.html/css/js     # Waiter order-entry screen (table select + customer name)
    admin.html/css/js      # Staff dashboard (table-wise live orders + billing)
    menu-manager.html/css/js  # Menu + billing settings management — live, no deploy
    qr.html                # Printable QR codes per table
```

## Local WiFi notes (if running on a computer in the restaurant)
- The staff computer and customer phones must be on the **same WiFi network**.
- Allow inbound connections on port 3000 in your firewall (Windows will prompt once — click Allow).
- QR codes automatically use the machine's local IP unless `BASE_URL` is set.
