# QR Code Food Ordering System

A complete, self-hosted QR ordering system for a restaurant. Runs on **your local computer** — no internet, no payment gateway, no cloud account needed. Customers' phones and your computer just need to be on the **same WiFi**.

## What it does
- Each table has its own QR code (pointing to `menu.html?table=N`) for customers who want to order themselves.
- **Waiter order entry** (`waiter.html`) — if a customer would rather tell the waiter what they want, the waiter opens this page on their own phone/tablet, picks the table number, enters the customer's name, and places the order for them. It shows up on the dashboard exactly like a self-order.
- Every order (self or waiter-placed) requires a **customer name** — shown on the dashboard and on the final bill.
- Orders appear **instantly** on your computer's dashboard, grouped by table (via Socket.io real-time sync). There's no "Preparing/Ready/Served" status step — orders simply sit on the table's card until billed.
- Orders **stay visible** on the dashboard until the staff explicitly clicks **Generate Bill** for that table — nothing disappears before that.
- Generate Bill combines all of that table's unbilled orders (whether self-ordered or waiter-entered) into one itemized bill (with 5% tax) — shown and printable.
- **Clear Table** resets it for the next customer.
- No payment gateway — bill is settled manually (cash/card machine), as requested.

## 1. Install (one-time)
You need [Node.js](https://nodejs.org) (v18+) installed on the computer that will run the server.

```bash
cd qr-ordering
npm install
```

## 2. Start the server
```bash
npm start
```
You'll see something like:
```
✅ Server running!
   Staff dashboard : http://192.168.1.5:3000/admin.html
   QR code page    : http://192.168.1.5:3000/qr.html
   Customer menu   : http://192.168.1.5:3000/menu.html?table=1
```
Keep this terminal window open — this computer is now your restaurant's server.

## 3. Print QR codes for each table
Open `http://<your-ip>:3000/qr.html` in a browser on that computer, click **Print All**, cut out each table's QR code and place it on the matching table.

> Change the number of tables in `server.js` → `const TOTAL_TABLES = 12;`

## 4. Open the staff dashboard
On the restaurant's computer, open:
```
http://<your-ip>:3000/admin.html
```
Leave this tab open at the counter/kitchen — new orders pop in live with a sound alert.

## 5. Waiter order entry (no QR needed)
If a customer prefers to just tell the waiter their order, the waiter opens:
```
http://<your-ip>:3000/waiter.html
```
on their own phone (or a tablet at the counter), selects the table number, enters the customer's name, browses the menu, and hits **Submit Order**. It appears on the dashboard instantly, same as a self-ordered one — tagged "🧑‍💼 Waiter" so staff can tell them apart. There's also a **"Take Order (Waiter)"** button right on the dashboard header.

## Managing the menu — no developer or deployment needed
Open **"Manage Menu"** from the dashboard header, or go directly to:
```
http://<your-ip>:3000/menu-manager.html
```
From here you can, live, with no code changes or restarts:
- **Add a new item** — fill in category, name, price, veg/non-veg, description, click Add Item.
- **Change a price or name** — just click into the field, edit, and click away (auto-saves).
- **Mark an item Out of Stock** — untick "In stock"; it immediately grays out and can't be added on the customer menu or waiter screen (both the QR menu and waiter app update live via the same real-time connection used for orders — no refresh needed).
- **Remove an item entirely** — click the 🗑 button.

Every change is saved straight to `data/menu.json`, so it survives restarts too.

## Bill / receipt customization (also from Menu Manager)
The same page has a **Billing Settings** box at the top where you can set, live, with no restart:
- Café/restaurant name, address, and phone — printed at the top-center of every bill.
- **GST %** — set it to `5`, `0`, or any custom number; it's applied to the *next* bill generated (already-printed bills keep whatever rate was in effect then, for accurate record-keeping).

The bill itself is designed like a proper **KOT/thermal receipt** (80mm width) rather than an A4 printout — so if you connect a thermal receipt printer, it prints cleanly on that narrow roll paper instead of wasting a full A4 sheet. It includes: café header, bill number, table number, date/time, guest name, itemized list, subtotal, GST line, grand total, and a "Thank you" footer. The Print/Clear Table/Close buttons never appear on the printed copy — only on-screen.

## 6. Customer flow (on their phone, self-order)
1. Scan the table's QR code.
2. Browse menu by category, add items, enter their name, place order.
3. Order shows up instantly on the dashboard under that table.

## Editing the menu the old way (not recommended)
You can still hand-edit `data/menu.json` directly if you want, but the **Menu Manager dashboard above is the intended way** — no restart, no file editing, no developer needed.

## Notes on "local computer" requirement
Because phones need to reach this server, make sure:
- The staff computer and all customer phones are on the **same WiFi network**.
- Your firewall allows inbound connections on port 3000 (Windows may prompt "Allow access" the first time — click Allow).
- Use the local IP printed in the terminal (e.g. `192.168.1.5`), not `localhost`, in the QR codes — this is already handled automatically.

## Folder structure
```
qr-ordering/
  server.js          # Express + Socket.io backend, all APIs
  data/menu.json      # Editable menu
  data/orders.json     # Auto-created, stores live orders
  public/
    menu.html/css/js       # Customer-facing menu + cart (self-order via QR)
    waiter.html/css/js     # Waiter order-entry screen (table select + customer name)
    admin.html/css/js      # Staff dashboard (table-wise live orders + billing)
    menu-manager.html/css/js  # Add/edit/remove items, prices, out-of-stock — live, no deploy
    qr.html                # Printable QR codes per table
```

## Optional next steps
- Run this on a Raspberry Pi or an always-on mini PC so it's always available.
- Assign a static local IP to the server machine so QR codes never change.
- Add categories like "Out of stock" toggle in `menu.json`.
