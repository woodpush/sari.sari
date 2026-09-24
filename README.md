# Tindahan

A simple point-of-sale and inventory app for a sari-sari store. Scan barcodes, set buy and sell prices, record sales, restock, and see your profit. It runs in the phone's browser, works without internet, and needs no server or monthly fee.

## Features

- **Sell** – scan or search items, adjust quantity, enter cash received and see the change. Quick-cash buttons for ₱20 to ₱1,000 bills.
- **Items** – add, edit and delete items with barcode, name, category, buy price, sell price, stock and a low-stock warning. The form shows your profit and markup per piece as you type.
- **Items without barcodes** (eggs, ice, loose rice) – leave the barcode blank and the app assigns a code like `ITEM-0001`. Find them by typing the name.
- **Restock** – record pieces bought and the new buy price. Stock goes up and the cost is logged.
- **Reports** – sales, cost, gross profit, margin and restock spending for today, 7 days, this month or all time. Best earners, items running low, and the value of stock on hand. Void a sale entered by mistake.
- **Backup** – download/restore a full JSON backup, export items and sales to CSV (opens in Excel or Google Sheets), and bulk-import items from CSV.

Profit is calculated from the buy and sell price *at the moment of each sale*, so changing a price later does not rewrite past profit.

## Barcode scanning

Three ways, all supported at once:

1. **Phone camera** – tap 📷. Works on Android (Chrome) and iPhone (Safari). Needs an `https` address, which GitHub Pages gives you.
2. **USB or Bluetooth barcode scanner** – these act like a keyboard. Keep the cursor in the scan box and scan; the item is added instantly.
3. **Typing** – type the barcode or part of the name and press Enter.

## Run it on GitHub Pages (free)

1. Create a new repository on GitHub, for example `tindahan`.
2. Upload all files in this folder (keep the folder structure).
3. Go to **Settings → Pages**, set **Source** to *Deploy from a branch*, choose `main` and `/ (root)`, and save.
4. After a minute, open `https://<your-username>.github.io/tindahan/` on the store phone.
5. In Chrome, tap ⋮ → **Add to Home screen** (on iPhone: Share → **Add to Home Screen**). It now opens like a normal app and works offline.

## Run it on your computer

Any static web server works, for example:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. (Opening `index.html` directly as a file will not work because the app uses JavaScript modules.)

## Where is my data?

All data is stored **on the device, inside the browser** (IndexedDB). Nothing is sent to GitHub or any server. This means:

- Each phone has its own separate data.
- Clearing browser data or uninstalling the browser deletes it.
- **Download a backup regularly** from *More → Download backup* and save it to Google Drive or send it to yourself.

## Importing items from a spreadsheet

Prepare a CSV with these columns (see `sample-items.csv`):

| column | required | example |
|---|---|---|
| barcode | no | 4800016644290 |
| name | yes | Lucky Me Pancit Canton Original |
| category | no | Noodles |
| buy_price | no | 13.25 |
| sell_price | yes | 16.00 |
| stock | no | 24 |
| low_stock | no | 6 |

Rows whose barcode already exists are updated; others are added.

## Project structure

```
index.html              app layout
css/styles.css          styles (light and dark)
js/app.js               screens and logic
js/db.js                local database (IndexedDB), money stored in centavos
sw.js                   offline support (bump CACHE when you release changes)
manifest.webmanifest    install-to-home-screen settings
vendor/html5-qrcode.min.js   camera barcode library (Apache-2.0)
```

No build step and no dependencies to install.

## Releasing an update

After editing files, change the version in `sw.js` (`CACHE = 'tindahan-v0.1.1'`) and `APP_VERSION` in `js/app.js`, then push. Phones pick up the new version the next time the app is opened with internet.

## Roadmap ideas

- Utang (credit) list per customer, with payments
- Buy by pack, sell by piece (e.g. a box of 12 sachets sold singly)
- Sync between two phones / cloud backup
- Daily closing: expected cash vs. counted cash
- Receipt printing to a Bluetooth thermal printer

## License

MIT. The bundled `html5-qrcode` library is Apache-2.0 (see `vendor/html5-qrcode.LICENSE`).
