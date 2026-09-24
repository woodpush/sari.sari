# Tindahan

A simple point-of-sale and inventory app for a sari-sari store. Scan barcodes, set buy and sell prices, record sales, restock, and see your profit. It runs in the phone's browser, works without internet, and needs no server or monthly fee.

## Features

- **Sell** – scan or search items, adjust quantity, enter cash received and see the change. Quick-cash buttons for ₱20 to ₱1,000 bills.
- **Items** – add, edit and delete items with barcode, name, category, buy price, sell price, stock and a low-stock warning. The form shows your profit and markup per piece as you type.
- **Items without barcodes** (eggs, ice, loose rice) – leave the barcode blank and the app assigns a code like `ITEM-0001`. Find them by typing the name.
- **Restock** – record pieces bought and the new buy price. Stock goes up and the cost is logged.
- **Reports** – sales, cost, gross profit, margin and restock spending for today, 7 days, this month or all time. Best earners, items running low, and the value of stock on hand. Void a sale entered by mistake.
- **Backup** – automatic cloud backup to a private GitHub repository with full version history, plus save/share a backup file on the phone. Export items and sales to CSV, and bulk-import items from CSV.

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

## Where is my data, and how is it backed up?

The data is stored on the phone, inside the browser (IndexedDB). There are three layers of protection:

1. **Phone copy** – *More → Save backup to phone* saves a `.json` file to Downloads. *Share backup* sends it to Google Drive, email, Messenger or Files.
2. **Cloud copy (GitHub)** – the app backs up automatically to a **private** GitHub repository (every 30 min to once a day, only when something changed). Files: `backups/latest.json` plus one `backups/YYYY-MM-DD.json` per day.
3. **History** – every cloud backup is a Git commit. If a backup file is deleted or overwritten, open the backup repository on github.com, click **Commits** (or open the file and click **History**), pick an older version and download it. Nothing is truly gone unless the whole repository is deleted.

### Set up cloud backup

1. On github.com create a **new private repository**, e.g. `sari-sari-backup` (tick "Add a README file"). Keep it separate from the app repository, which is public.
2. Create a token: profile picture → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
   - Expiration: up to 1 year (set a calendar reminder to renew it)
   - Repository access: **Only select repositories** → `sari-sari-backup`
   - Permissions → Repository permissions → **Contents: Read and write**
3. Copy the token (it starts with `github_pat_`). GitHub shows it only once.
4. In the app: *More → Cloud backup*, enter `your-username/sari-sari-backup`, paste the token, choose how often, and tap **Save and test**. The first backup runs immediately.

The token is kept only on that phone and is never written into backup files. The app refuses to back up to a public repository.

### Restoring

- **Same phone, data lost or wrong:** *More → Restore from cloud…* → pick *Latest* or a date.
- **New or replacement phone:** open the app link, set up cloud backup with the same repository and token, then *Restore from cloud…*.
- **From a file:** *More → Restore from a backup file*.

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
js/cloud.js             backup to a private GitHub repository
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
