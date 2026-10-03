# Raven Prop: Full Setup Guide (step by step)

This guide assumes you have never done this before. Follow the steps **in order**. After many steps there is a **"You should see"** line so you know it worked. If you do not see it, stop and check the Troubleshooting table at the bottom.

---

## Folder structure

Everything is in one folder called `raven`. The only sub-folder is `.github/workflows/`, and it must stay exactly like this because GitHub only runs the balance checker from that path.

```
raven/
├── index.html            landing page (small, fast, static)
├── app.html              the app: sign in, challenges, dashboard, payouts and all info pages
├── admin.html            admin page (your control panel)
├── logo.svg
├── favicon.svg
├── og-image.png
├── twitter-card.jpg
├── site.webmanifest
├── robots.txt
├── sitemap.xml
├── CNAME                 your domain (ravenprop.cfd)
├── Code.gs, Access.gs               back office code, split into small files
├── Migrate.gs            list of one-time fixes for a live system (Run migration button)
├── Bootstrap.gs          one call that loads config, user, alerts and challenges on start
├── Engine.gs, Engine_2.gs
├── Money.gs ... Money_13.gs
├── Ops.gs ... Ops_5.gs
├── appsscript.json
├── equity_monitor.py     balance checker (Python)
├── README.md             this guide
├── .gitignore            stops secrets being uploaded
└── .github/
    └── workflows/
        └── equity.yml    schedule that runs the balance checker on GitHub
```

Upload the **whole `raven` folder contents to GitHub with this same structure**. Do not move `equity.yml` out of `.github/workflows/`.

> `.github` and `.gitignore` start with a dot, so they are hidden on Mac and Linux. On Mac press **Cmd + Shift + .** in Finder to show hidden files. On Windows they are visible by default.

---

## About the minified files

The code files in this folder are **minified**: comments and spaces are removed and inner variable names are shortened, so the files are smaller and load faster. They work exactly the same as the readable versions, but they are hard to read and edit by hand.

- Files minified: all the back office `.gs` files, `index.html`, `admin.html`, `equity_monitor.py`, `equity.yml`, `appsscript.json`.
- Public function names such as `ops_installTriggers` are **not** changed, so every instruction in this guide still works.
- The zip `raven-source-unminified.zip` has the versions from before minifying (with comments). **Keep it.** Edit those, then minify again, instead of editing the minified files.
- The comment that explained the `cron` time in `equity.yml` was removed. The time is on the line `cron: "5 0 * * *"` (00:05 UTC). Change the numbers to match your broker's midnight.

---

## PART 0: Understand what you have

Your project has 3 parts. Think of a shop:

| Part | What it does | Files |
|------|--------------|-------|
| **Shop window** | The website people see and the admin page you use | `index.html`, `admin.html`, `logo.svg`, `favicon.svg`, `og-image.png`, `twitter-card.jpg` |
| **Back office** | The brain. Sign-ups, payments, accounts, payouts, emails. It runs free on Google | the 22 `.gs` files listed in Part 2, `appsscript.json` |
| **Balance checker** | A Python script that reads trading account balances so the system knows who passed or breached | `equity_monitor.py`, `.github/workflows/equity.yml` |

Your data (users, orders, payouts, accounts) is stored in a **Google Sheet** that the back office creates by itself. You never edit code to run daily business. You use `admin.html`.

Other files: `CNAME` (your domain, `ravenprop.cfd`), `robots.txt` and `sitemap.xml` (for Google search), `site.webmanifest` (phone home-screen icon info), `.gitignore` (stops secrets being uploaded).

**How money and accounts flow, in plain words**
1. You buy demo trading accounts from a broker in bulk and load them into the **Account pool** (Part 8).
2. A trader pays a fee on your website. The system hands them one account from the pool.
3. The **balance checker** (Part 10) reads that account's balance. The system decides pass, breach or keep going.
4. A funded trader asks for a payout. You review it in the admin page and pay them by bank transfer yourself.

---

## PART 1: Before you start (checklist)

Tick each one. Do not skip.

- [ ] A **Google account** you will keep forever (this becomes the owner of the database). Use a business Gmail, not a friend's.
- [ ] A **GitHub account** (free): https://github.com
- [ ] Your **domain** (`ravenprop.cfd`) and access to where you bought it (the "DNS settings" page).
- [ ] A text editor. **Notepad** works. Better: free **VS Code** (https://code.visualstudio.com).
- [ ] A **broker with MetaTrader 5 (MT5) demo accounts** you can buy or create in bulk. Write down the exact **server name** (for example `BrokerName-Demo`). You need this in Part 8 and Part 10.
- [ ] For card and bank payments: an account with **Squad**, **Flutterwave** or **Monnify** (optional at first; crypto works without them).
- [ ] A USDT wallet on the **TRC-20** network to receive crypto payments (optional).

Time needed: about 2 to 3 hours for Parts 2 to 9.

---

## PART 2: Create the back office (Google Apps Script)

1. Open https://script.google.com and sign in with the Google account from Part 1.
2. Click **New project**. At the top click "Untitled project" and rename it `Raven Prop`.
3. You will see a file called `Code.gs` with a few lines. **Select all the text in it and delete it.**
4. Open this folder's `Code.gs` in your text editor. Select all (Ctrl+A), copy (Ctrl+C). Go back to Apps Script, click inside the empty `Code.gs`, paste (Ctrl+V).
5. Create the other 21 files, one at a time. For each one:
   - Click the **+** next to "Files" > **Script**.
   - Type the name **without** `.gs`. Example: type `Access` (it becomes `Access.gs`), or `Money_2` for `Money_2.gs`. The name must match exactly.
   - Delete the default text, paste the contents from this folder's file of the same name.
   - Use this list and tick each one off. The back office is split into small files (none is longer than 246 lines):

| # | File | Lines |
|---|------|-------|
| 1 | `Code.gs` | 208 |
| 2 | `Access.gs` | 52 |
| 3 | `Engine.gs` | 223 |
| 4 | `Engine_2.gs` | 205 |
| 5 | `Money.gs` | 245 |
| 6 | `Money_2.gs` | 246 |
| 7 | `Money_3.gs` | 179 |
| 8 | `Money_4.gs` | 244 |
| 9 | `Money_5.gs` | 229 |
| 10 | `Money_6.gs` | 240 |
| 11 | `Money_7.gs` | 246 |
| 12 | `Money_8.gs` | 238 |
| 13 | `Money_9.gs` | 236 |
| 14 | `Money_10.gs` | 213 |
| 15 | `Money_11.gs` | 132 |
| 16 | `Money_12.gs` | 193 |
| 17 | `Money_13.gs` | 163 |
| 18 | `Ops.gs` | 228 |
| 19 | `Ops_2.gs` | 108 |
| 20 | `Ops_3.gs` | 232 |
| 21 | `Ops_4.gs` | 246 |
| 22 | `Ops_5.gs` | 90 |

   Order does not matter (I tested loading them in many different orders), but **all 22 files must be there**. If one is missing you will get "is not defined" errors later.
6. Click the **gear icon** on the left (**Project settings**). Tick **"Show 'appsscript.json' manifest file in editor"**.
7. Go back to **Editor** (the `< >` icon). Open `appsscript.json`. Delete everything and paste the contents of this folder's `appsscript.json`.
8. Press **Ctrl+S** to save all.

**You should see:** 22 `.gs` files plus `appsscript.json` on the left, and no red error marks.

> Tip: after pasting each file press Ctrl+S. When you finish, count the files on the left. It should be 22 `.gs` files.
> If you ever change code, keep every file under about 250 lines by adding a new file (for example `Money_14`) instead of making one file bigger.

---

## PART 3: Add the secret settings (Script Properties)

These are passwords the code reads. They never go on the website.

1. Click the **gear icon** (Project settings).
2. Scroll down to **Script Properties**. Click **Add script property**.
3. Add each of the ones you need below. Left box = name (copy exactly, capital letters). Right box = value.
4. Click **Save script properties** at the end.

| Name | What to put | When you need it |
|------|-------------|------------------|
| `BOOTSTRAP_OPEN` | `true` | Now. It lets the first sign-up become the owner. **You will delete it in Part 7.** |
| `OWNER_EMAIL` | your email | Now. Alerts (new crypto order, low stock) are sent here. |
| `EQUITY_SECRET` | a long random password, at least 30 characters | Only if you use the Python checker. Make one at https://www.random.org/passwords or type random letters and numbers. **Write it down. You need the same value in Part 10.** |
| `SETUP_KEY` | optional | Alternative to `BOOTSTRAP_OPEN` (see the note in Part 7). Leave empty. |
| `SQUAD_SECRET_KEY` | your Squad secret key | Only for Squad payments |
| `FLW_SECRET_KEY` | your Flutterwave secret key | Only for Flutterwave payments |
| `MONNIFY_API_KEY`, `MONNIFY_SECRET_KEY`, `MONNIFY_CONTRACT_CODE` | from Monnify dashboard | Only for Monnify |
| `MONNIFY_ENV` | `sandbox` while testing, `live` when real | Only for Monnify |
| `POOL_ENC_KEY` | a long random password | Optional. Encrypts the trading account passwords stored in your Sheet. **Recommended.** Set it BEFORE you import accounts (Part 8). If you lose it you lose access to those passwords. Save it somewhere safe. |
| `METAAPI_TOKEN` | leave empty | Optional, not needed |

Use **test/sandbox keys first**, switch to live keys only when you are ready to take real money.

---

## PART 4: Publish the back office and get its link

1. Top right, click **Deploy** > **New deployment**.
2. Click the **gear icon** next to "Select type" > choose **Web app**.
3. Fill in:
   - Description: `v1`
   - **Execute as:** `Me`
   - **Who has access:** `Anyone`
4. Click **Deploy**.
5. Google asks to **Authorize access**. Click it, choose your account. If you see "Google hasn't verified this app": click **Advanced** > **Go to Raven Prop (unsafe)** > **Allow**. This is normal because it is your own script.
6. You will get a **Web app URL** that ends in `/exec`. **Click Copy and paste it into a Notepad file. Keep it. You need it in Parts 5 and 10.**

**Test it:** paste that URL into a new browser tab.
**You should see:** text like `{"ok":true,"data":{"service":"raven-prop-api","status":"up"},...}`

If you see a Google login page instead, "Who has access" is not set to `Anyone`. Go to **Deploy > Manage deployments > pencil icon**, fix it, and choose **New version**.

> **Every time you change any `.gs` code later:** Deploy > Manage deployments > pencil icon > Version: **New version** > Deploy. The link stays the same. Just saving is not enough.

---

## PART 5: Connect the website to the back office

You edit 3 small things in the website files. Use Ctrl+F (Find) in your editor.

**In `index.html`:**
1. Find `PASTE_APPS_SCRIPT_WEB_APP_URL_HERE`. Replace it with your `/exec` link. Keep the quote marks around it.
2. Find `YOUR-DOMAIN.com` (about 7 times). Replace every one with `ravenprop.cfd` (or your real domain). Use "Replace all".

**In `admin.html`:**
3. Find `PASTE_APPS_SCRIPT_WEB_APP_URL_HERE`. Replace it with the same `/exec` link.

**In `sitemap.xml` and `robots.txt`:**
4. Replace `YOUR-DOMAIN.com` with `ravenprop.cfd`.

Save all four files.

**You should see:** searching for `PASTE_` or `YOUR-DOMAIN` in these files finds nothing.

---

## PART 6: Put the website online (GitHub Pages)

**A. Upload the files**
1. Log in to https://github.com. Click **+** (top right) > **New repository**.
2. Name: `raven`. Choose **Public**. Click **Create repository**.
3. Click **uploading an existing file**.
4. Open the `raven` folder on your computer. Select **everything inside it** (Ctrl+A), including the `.github` folder, and drag it all into the GitHub page. GitHub keeps the folder structure. Check that the file list on the page shows `.github/workflows/equity.yml`. If hidden files do not appear on your computer, turn on "show hidden files" first (see the Folder structure note above).
5. Scroll down and click **Commit changes**.

**B. Turn on the website**
6. In the repository click **Settings** > **Pages** (left side).
7. Under **Build and deployment** > **Source**: `Deploy from a branch`. Branch: `main`, folder: `/ (root)`. Click **Save**.
8. Wait 1 to 3 minutes. Refresh. You will see "Your site is live at https://YOURNAME.github.io/raven/".

**C. Connect your domain**
9. Same Pages screen, **Custom domain**: type `ravenprop.cfd`. Click **Save**.
10. Go to where you bought the domain. Open **DNS settings** and add:

| Type | Name (Host) | Value |
|------|-------------|-------|
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| CNAME | `www` | `YOURNAME.github.io` (your GitHub username) |

    (GitHub can change these. Check https://docs.github.com/pages under "Managing a custom domain" if in doubt.)
11. Wait 10 minutes to a few hours. Back on the GitHub Pages screen, tick **Enforce HTTPS** once it becomes available.

**You should see:** `https://ravenprop.cfd` opens your website with a padlock.

---

## PART 7: Create your owner account (do this FIRST, before anyone else)

1. Open your website. Click **Start Challenge** or **Create account**.
2. Sign up with **your own** email and a strong password. Write the password down.
3. **The first person to sign up becomes the owner.** At this moment the system also creates your database Sheet (named "Raven Prop Data") in your Google Drive.
4. **Right away**, go back to Apps Script > Project settings > Script Properties. **Delete `BOOTSTRAP_OPEN`** (click the trash icon), then Save. This closes the door so nobody else can become the owner.
5. Open `https://ravenprop.cfd/admin.html` and sign in with the same email and password.

**You should see:** the admin page with the menu Overview, Challenges, Crypto orders, Payouts, Payments, Payment setup, Challenge plans, Account pool, Users, Affiliates, Breach log, Support, Settings, Audit log.

**If sign-up says "The system is not set up yet":** `BOOTSTRAP_OPEN` is missing or not `true` (Part 3). Add it and try again.

Open Google Drive and check that **"Raven Prop Data"** exists. **Keep it private. Never share it.** It holds sensitive data.

---

## PART 8: Turn on the automatic jobs

The system needs two timed jobs (one every 10 minutes: checks pending payments and expires old orders; one daily: inactivity breaches, affiliate holds, data archive).

1. In Apps Script, open the file `Ops.gs`.
2. In the toolbar find the function dropdown (next to the Run button). Choose **`ops_installTriggers`**.
3. Click **Run**. Allow permissions if asked.

**You should see:** "Execution completed" at the bottom. Click the clock icon (**Triggers**) on the left: you should see `ops_every10` and `ops_daily`.

You only do this once.

---

## PART 9: Set up the business in the admin page

Go through the admin menu in this order.

### 9.1 Settings
Open **Settings**. Check at least:
- `brand_name`, `support_email`, `whatsapp_link`
- `site_url` = `https://ravenprop.cfd` (used in emails and referral links)
- `signup_enabled` = true
- `maintenance_mode` = false

### 9.2 Challenge plans
Open **Challenge plans** > **New plan**. For each product you sell, set the account size, fee (USD), profit targets, daily loss limit, max loss limit, minimum trading days and inactivity days. Save. Traders see these numbers before paying, so they are your legal promise (see the Terms page).


### 9.2c Drawdown rules: static max + trailing daily (all accounts)

Every account is now checked against **two** loss limits at once. Breaching either one ends the challenge.

| Rule | Size | How the floor moves |
|---|---|---|
| **Max loss** (unchanged) | `max_drawdown` % of the starting balance | **Static.** Fixed floor, never moves. |
| **Daily loss** (new) | **Half of the max loss %**, as a dollar amount of the starting balance | **Trailing.** Floor = the day's highest level (day-start balance or best equity seen that day) minus the daily amount. It rises as the day's equity peaks and resets at the daily reset time. |

Example, Swift 10k (max 6%, so daily 3% = $300): day starts at $10,000, equity peaks at $10,600, so the daily floor is $10,300. Equity at $10,290 breaches the daily rule even though the static max floor ($9,400) is nowhere near.

Notes:
- The daily % is **always half of the stage's max %** (Funded uses `max_drawdown_funded`). The `daily_drawdown` / `daily_drawdown_funded` values stored in the ChallengePlans sheet are ignored; the plan list and the trader pages show the derived value. Edit the max and the daily limit follows.
- The day's high is built from the equity readings the monitor uploads, so run `equity_monitor.py` often (every few minutes) for tighter tracking. A peak that happens between two readings is not seen.
- **After deploying this update, click Run migration** (admin > Settings, owner only). It adds the new `day_high_equity` column to the Accounts sheet and creates the Starter 1,000 plan (Part 9.2d).
- Accounts that are already open start tracking the day's high from their next reading.

### 9.2d The Starter 1,000 plan ($7, buy as many as you like)

A second Starter plan (`starter-1000`) sits next to the 500 one:
- **$1,000 account, $7 fee.** One phase, 10% target, **7% static max drawdown plus the 3.5% trailing daily drawdown** (Part 9.2c; the daily limit is always half of the max), 70% split rising to 80%, minimum payout 5%, payout cap 10%, inactivity 30 days. No pass fee.
- **Repeat purchases are allowed.** `max_per_user` is left empty, which means no limit. (The 500 plan keeps its one-per-person limit.) Each purchase uses one **1,000-size account from the Account pool**, the same pool the Swift and Apex 1k plans use, so keep it stocked: the low-stock alert threshold is per size (Settings > pool_low_stock_by_size).
- **No promo codes** (`no_promo` = true). This is required: $7 is below the $10 fee floor, and only no-promo plans may go under it.
- **Crypto works at $7.** The manual crypto minimum ($10) now never blocks a plan from being paid at its own list price, so crypto-only countries can buy the $7 plan (and the $3 one).
- Traders see a "Buy as many as you like" tag on the plan card. On the landing page the "From" price still counts only the Swift/Apex plans, with the Starter price shown separately.
- On a live system the plan is created by **Run migration**. On a brand new sheet it is created by the seed. To change the price or limit later, edit it in **Challenge plans** (set **Max purchases per user** to a number to cap it, leave it empty for unlimited).

### 9.2b The Starter plan ($3, then $2 after you pass)

The code now includes a **Starter** plan (`starter-500`) in the starting plans:
- $500 account, **$3 fee**, then **$2 pass fee** when the trader reaches the 10% target (they pay it to unlock the funded account).
- One phase only (10% target), **10% max drawdown, static**, plus the daily trailing drawdown (5%, half of the max) described in Part 9.2c.
- **One purchase per user** (`max_per_user` = 1) and **no promo codes** (`no_promo` = true).
- You need **500-size accounts in the Account pool** (Part 9.5).
- The plan form in the admin page (**Challenge plans > New plan / Edit**) now has boxes for **Pass fee (USD)**, **Max purchases per user** and a **Promo codes not allowed** tick box, right after the fee. The plans table also shows these three columns.
- The starting plans are only added when the Sheet is first built. If your Sheet already exists, run `sheet_buildAll_` once in Apps Script (it adds the new columns), then add the plan in **Challenge plans** with these same values: `pass_fee_usd` 2, `max_per_user` 1, `no_promo` true, `phase2_target` 0.
- `phase2_target` = 0 means the plan skips Phase 2 and goes straight to Funded.

### 9.3 Payment setup (crypto and currency)
Open **Payment setup**.
- **Add address:** coin `USDT`, network `TRC-20`, paste your wallet address (starts with `T`, 34 characters). Only TRC-20 is accepted by the code. **Send yourself a tiny test amount first.**
- **Currencies / exchange rates:** add the currencies you accept and their markup. Click **Refresh live rates** to load current rates.
- **Promo codes:** optional.

### 9.4 Card and bank gateways (optional)
1. Put the secret keys in Script Properties (Part 3).
2. In **Settings** (group "payments") turn on the one you use: `gateway_squad_enabled`, `gateway_flutterwave_enabled` or `gateway_monnify_enabled`. They are OFF by default.
3. For Nigeria, choose who handles it: `nigeria_use_monnify` or `nigeria_use_flutterwave` (otherwise Squad).
4. Do a small test payment in sandbox before switching to live keys.

### 9.5 Account pool (the trading accounts you sell)
This is the stock. Each challenge buyer receives one.

1. Buy or create MT5 **demo accounts** at your broker in bulk (one size per batch, for example 100 accounts of 10,000).
2. Make a CSV file (Excel > Save As > CSV). **Header row exactly:**
   ```
   login,password,investor_password,server,size
   ```
   Then one row per account. Example:
   ```
   login,password,investor_password,server,size
   5012345,Abc12345!,Inv67890!,BrokerName-Demo,10000
   5012346,Abd12346!,Inv67891!,BrokerName-Demo,10000
   ```
   - `login` = MT5 account number
   - `password` = the trader password (given to the buyer)
   - `investor_password` = the **read-only** password (used by the balance checker, Part 10)
   - `server` = exact MT5 server name from the broker
   - `size` = account size in USD (must match a plan's size)
3. Open the CSV in Notepad, select all, copy.
4. Admin > **Account pool** > **Import accounts (CSV)**. Paste. Click **Check only** first (it tests without saving). Fix any rows it complains about. Then click **Import**.
5. Set `pool_low_stock_default` (default 5) so you get an alert email when stock runs low.

**Important:** never put this CSV on GitHub. The `.gitignore` blocks `.csv` files, so do not remove it. Delete the CSV from your computer after importing, or keep it somewhere private.

### 9.6 Payouts
- Settings group "payouts": `payout_enabled`, `payout_approval_hours`, `kyc_required_before_payout` (leave true), `payout_banks` (the list of banks traders can choose).
- Payouts are paid **manually by you** (bank transfer). In admin > **Payouts** you Approve, then **Mark paid** after you send the money.

### 9.7 Emails
The system sends emails (receipts, alerts, password resets) from **your Google account** (limit about 100 per day on a normal Gmail, about 1,500 on Google Workspace). If you expect more users, use Google Workspace.

---

## PART 10: The Python balance checker (equity_monitor.py)

### 10.1 What it is and why you need it
The system must know each trader's balance to decide "passed" or "breached". Two ways to feed it:

| Way | Effort | Best for |
|-----|--------|----------|
| **A. Manual CSV upload** (no Python) | You paste balances in the admin page | Starting out, a few traders |
| **B. Python script** (`equity_monitor.py`) | Set up once, then automatic | Many traders |

**Start with A if you are new.** You can add B later. Both feed the same rules.

### 10.2 Way A: manual CSV upload (no Python)
1. Get balances from your broker/MT5 (Export, or type them).
2. Make text like this (columns: login, balance, equity, timestamp):
   ```
   login,balance,equity,timestamp
   5012345,10450.20,10390.50,2026-09-29T00:05:00Z
   ```
   Optional extra columns: `last_trade`, `open_positions`.
3. Admin > **Challenges**. Find the **Equity CSV** box. Paste. Click **Check only** first (it tests without saving), then click **Upload**.
4. It says how many were updated, passed, breached.

### 10.3 Way B: the Python script

**What the script does, in plain words**
1. Asks your back office: "Give me all active trading accounts and their read-only (investor) passwords."
2. Opens MetaTrader 5, logs in to each one with the investor password.
3. Reads balance, equity, open trades, last trade time.
4. Sends the numbers back to the back office in batches of 50.
5. Prints a summary. It never prints or saves passwords.

**Important limits you must know**
- The Python package `MetaTrader5` only works on **Windows** and needs the **MetaTrader 5 program installed**.
- Your **broker's server** must be known to the MT5 program you install. Some brokers require their own MT5 installer.
- Investor (read-only) passwords cannot place trades. They are safe for reading.

You have two places to run it. **Option 1 (your own Windows PC or VPS) is more reliable. Try it first.**

#### Option 1: Run it on your own Windows PC or Windows VPS (recommended)

**Step 1. Install Python**
1. Go to https://www.python.org/downloads and download Python **3.11** (64-bit).
2. Run the installer. **Tick "Add python.exe to PATH"** at the bottom of the first screen. Click Install Now.
3. Open **Command Prompt** (press Start, type `cmd`, Enter). Type `python --version`.
   **You should see:** `Python 3.11.x`.

**Step 2. Install the MetaTrader 5 program**
1. Download the MT5 installer **from your broker's website** (best) or from https://www.metatrader5.com.
2. Install and open it. Log in to any one of your pool accounts once (File > Login to Trade Account: enter login, the **investor** password, the server). This makes MT5 remember the server.
3. Keep the MT5 program installed. The script will start it automatically.

**Step 3. Install the Python package**
In Command Prompt type:
```
pip install MetaTrader5
```
**You should see:** "Successfully installed MetaTrader5".

**Step 4. Put the script in a folder**
1. Create a folder `C:\raven`.
2. Copy `equity_monitor.py` into it.

**Step 5. Give the script its two secrets**
In Command Prompt type these two lines. Replace the values with **your `/exec` link (Part 4)** and **your `EQUITY_SECRET` (Part 3)**:
```
set RAVEN_API_URL=https://script.google.com/macros/s/XXXXXXXX/exec
set EQUITY_SECRET=your-long-secret-here
```
(These last only while this window is open. For a permanent setting see Step 8.)

**Step 6. Tell the back office to expect the script**
Admin > **Settings** > group "monitoring": set `equity_upload_method` to `script`.

**Step 7. Run it**
```
cd C:\raven
python equity_monitor.py
```
**You should see** a line like:
`Accounts: 12 read: 12 failed login: 0 {'updated': 12, 'passed': 0, 'breached': 0}`

Then open admin > **Challenges**. The balances should now be updated.

**Step 8. Make it run every day by itself**
1. Press Start, type **Task Scheduler**, open it.
2. Click **Create Basic Task**. Name: `Raven equity`.
3. Trigger: **Daily**. Time: shortly **after your broker's midnight** (so the start-of-day balance is captured correctly). Tip: if you want more frequent checks, add a second task for another time.
4. Action: **Start a program**.
   - Program/script: `cmd.exe`
   - Add arguments: `/c "cd /d C:\raven && set RAVEN_API_URL=PASTE_YOUR_URL&& set EQUITY_SECRET=PASTE_YOUR_SECRET&& python equity_monitor.py >> log.txt 2>&1"`
5. Finish. Right-click the task > **Run** to test. Open `C:\raven\log.txt` to see the output.
6. The computer must be **on and logged in** at that time. A cheap Windows VPS is best for this.

> The task stores your secret in plain text on that computer. Only use a computer you control, and do not share it.

#### Option 2: Run it free on GitHub (GitHub Actions)

This is automatic and free but **the MT5 installation step on GitHub is untested** (the file itself says so). It may fail because the plain MT5 installer does not know your broker's server. Try it only after Option 1 works, or if you accept some testing.

**Step 1. Check the workflow file is in the right place**
The file `.github/workflows/equity.yml` came in your upload (Part 6). In your repository click the **Code** tab and open `.github` > `workflows`. You should see `equity.yml`. If it is missing, click **Add file** > **Create new file**, type `.github/workflows/equity.yml` in the name box (each `/` makes a folder), paste the contents of that file from your `raven` folder, and click **Commit changes**.

**Step 2. Add the two secrets**
1. Repository > **Settings** > **Secrets and variables** > **Actions** > **New repository secret**.
2. Name `RAVEN_API_URL`, value = your `/exec` link. Save.
3. Name `EQUITY_SECRET`, value = **exactly the same** as your Script Property. Save.

**Step 3. Set the time**
The file has `cron: "5 0 * * *"`. That means 00:05 **UTC** every day. Change the numbers if your broker's midnight is different. Keep the repository **Public** so the minutes are free.

**Step 4. Test it**
1. Repository > **Actions** tab > click **Equity check** on the left > **Run workflow** > **Run workflow**.
2. Click the run to watch it. Green tick = worked. Click "Run monitor" to see the summary line.

**Step 5. Admin setting**
Admin > **Settings** > `equity_upload_method` = `script`.

If it fails at "Install MT5 terminal" or with `MetaTrader 5 did not start`, use Option 1 instead.

#### Reading the script's messages

| Message | Meaning | Fix |
|---------|---------|-----|
| `RAVEN_API_URL and EQUITY_SECRET must be set.` | The two settings are missing | Redo Step 5 (or the GitHub secrets) |
| `Could not fetch accounts: ...` | Wrong URL or wrong secret | Make sure `EQUITY_SECRET` matches the Script Property exactly (no spaces), and the URL ends in `/exec`. Redeploy a new version if you changed Script Properties |
| `MetaTrader 5 did not start` | MT5 is not installed or cannot start | Install MT5 (Step 2). On a VPS, log in to the desktop once |
| `failed login: 3` and `Could not read logins: 501...` | Those accounts could not be read | Check the server name and investor password in the pool. Make sure MT5 knows that server |
| `Upload failed: ...` | Back office refused the data | Read the message. Usually a wrong secret or a bad number |
| `Accounts: 0` | No active challenges yet | Normal until someone buys |

Never paste `EQUITY_SECRET` in a chat, screenshot or public file.

---

## PART 11: Test everything before real customers

Do a full dry run. Use sandbox keys or crypto with a tiny amount.

1. Sign up as a **normal test user** with a different email (use a private/incognito window).
2. Buy the cheapest plan. Check: the order appears in admin, the user receives an account from the pool.
3. Feed a balance (Way A or B) that is above the target. Check the challenge moves to the next phase.
4. Feed a balance below the loss limit. Check it is marked breached and the user gets an email.
5. As a funded test user, request a payout. In admin approve it, pay a tiny amount to yourself, mark paid.
6. Check emails are delivered (also look in the spam folder).
7. Open the site on a phone.
8. Delete test data or mark it clearly.

---

## PART 12: Go-live checklist

- [ ] `BOOTSTRAP_OPEN` deleted from Script Properties
- [ ] Only trusted people have owner/admin roles (Admin > Users)
- [ ] Live payment keys added, sandbox keys removed, `MONNIFY_ENV` = `live` if used
- [ ] Payment gateways switched on in Settings
- [ ] Crypto wallet address tested
- [ ] Pool has enough accounts of every size (with `POOL_ENC_KEY` set before importing)
- [ ] Balance checker runs and updates (Part 10)
- [ ] Triggers exist (Part 8)
- [ ] Terms, Privacy and Risk pages read and correct (inside `index.html`). Section 16 of the Terms says "the country where Raven Prop is registered". Put your country there if you want. Have a local lawyer review them.
- [ ] `support_email` works and someone reads it
- [ ] Missing icons added (see the note below)
- [ ] "Raven Prop Data" Sheet is private
- [ ] Google Sheet backup: File > Make a copy, once a week

---

## Files the site expects but you do not have yet

The site points to these small images. Without them the browser shows small errors but the site still works:
`favicon.ico`, `favicon-32.png`, `apple-touch-icon.png`, `icon-512.png`, `icon-192.png`, `icon-maskable-512.png`

Make them from your logo at https://realfavicongenerator.net and put them in the same folder as `index.html`.

---

## Changing things later

| I want to... | Do this |
|--------------|---------|
| Change website text or design | Edit `index.html`, then upload it again to GitHub (click the file > pencil icon > paste > Commit) |
| Change a business setting, price or plan | Use the admin page, no code needed |
| Change backend code (`.gs`) | Paste the new code in Apps Script, then Deploy > Manage deployments > pencil > **New version** > Deploy |
| Change the `/exec` link | You should not need to. If you make a brand new deployment the link changes and you must redo Part 5 |
| Add more trading accounts | Admin > Account pool > Import accounts (CSV) |

---

## Troubleshooting

| Problem | What to check |
|---------|---------------|
| Site says it cannot reach the server | The `/exec` link in `index.html` is missing or wrong. It must end in `/exec`. Open the link directly; you should see `"status":"up"` |
| Opening the `/exec` link asks me to log in to Google | "Who has access" must be `Anyone`. Fix under Deploy > Manage deployments |
| Sign-up says "The system is not set up yet" | Add `BOOTSTRAP_OPEN` = `true` (Part 3), sign up, then delete it |
| Site shows "Launching soon" | Nobody has signed up yet. Do Part 7 |
| I changed code but nothing changed | You must deploy a **New version** (Part 4 note) |
| Domain does not open | DNS can take up to a few hours. Check the 4 A records and CNAME. On the GitHub Pages screen it shows if the DNS check passed |
| Padlock/HTTPS missing | Tick **Enforce HTTPS** on the GitHub Pages screen once available |
| Card payment does not show | The gateway is off by default. Turn it on in Settings and check its secret key in Script Properties |
| No account issued after payment | The Account pool has none left of that size. Import more |
| Emails do not arrive | Check spam; check Google's daily email limit; open Apps Script > Executions to see errors |
| Any error I do not understand | Apps Script > left menu **Executions** shows every run and its error message |

---

## Safety rules

- **Never share** Script Properties, the `/exec` link with the secret, `EQUITY_SECRET`, or the pool CSV.
- **Never upload** `.csv` files with trading passwords to GitHub.
- Keep the "Raven Prop Data" Sheet **private**.
- Use a strong, unique password for the owner account and for your Google account. Turn on 2-step verification on Google and GitHub.
- The rules a trader accepted when they bought stay with their challenge. Do not change a plan in a way that surprises existing customers.


---

## Updating a live system: the Run migration button

Seeds in `Code.gs` only run when the spreadsheet is first built. Any change that must reach data that already exists (plan values, settings, new columns) needs an entry in `MIGRATIONS_` in `Migrate.gs`.

Every update, in this order:

1. Replace the changed `.gs` files in Apps Script (add new files like `Migrate.gs` if missing).
2. **Deploy > Manage deployments > Edit > New version > Deploy.** The web app URL stays the same.
3. Upload the changed website files (`index.html`, `admin.html`) to GitHub.
4. Admin > **Settings** > **Run migration** (owner only). The button shows how many fixes are pending and lists them before running.

Rules: never edit or reorder a migration that has already shipped, add a new one at the bottom. Each one must be safe to run twice. Applied ids are stored in the Script Property `MIGRATIONS_DONE`.


---

## Two pages: index.html and app.html

- `index.html` is the landing page. It is small, has no framework, and shows the live plan numbers after the page has painted. Every button goes to `app.html`.
- `app.html` is everything else (sign in, challenges, dashboard, payouts, rules, FAQ, legal pages).
- Old links still work: if `index.html` is opened with a route such as `/#/pay/return?order=...` or `/#reset=...` (payment returns, password reset emails), it forwards to `app.html` with the same address. Referral links (`/?ref=CODE`) are handled by the landing page, which saves the code and counts the click.
- Nothing in the back office changes for this split, so no migration is needed.


---

## One start-up call (app.bootstrap)

`app.html` used to make separate calls on load (config, me, alerts, then challenges). It now makes one call, `app.bootstrap`, which works signed out (public config only) and signed in (adds user, unread count and challenges). A bad or expired token counts as signed out.

- Deploy order: replace `Code.gs`, add `Bootstrap.gs`, then Deploy > New version, then upload `app.html`.
- If `app.html` is uploaded before the new Apps Script version is deployed, it falls back to the old separate calls, so the site keeps working.
- No migration is needed.


---

## Google sign-up and sign-in

The sign-in and sign-up pages show a **Continue with Google** button once a Google Client ID is saved in Settings. With no Client ID the button stays hidden and nothing changes.

**One-time setup (about 10 minutes)**

1. Go to https://console.cloud.google.com and create a project (or pick one), for example `Raven Prop`.
2. Open **APIs & Services > OAuth consent screen**. Choose **External**, fill in the app name, support email and developer email, then save. Click **Publish app** so any Google user can sign in (not just test users).
3. Open **APIs & Services > Credentials > Create credentials > OAuth client ID**. Application type: **Web application**.
4. Under **Authorized JavaScript origins** add `https://ravenprop.cfd` (and `https://www.ravenprop.cfd` if you use it). Leave redirect URIs empty. Click **Create**.
5. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`). It is not a secret.
6. Update the back office: paste the new `Code.gs` and `Access.gs` into Apps Script, then **Deploy > Manage deployments > edit > New version > Deploy**.
7. In `admin.html` open **Settings > Run migration** (this adds the new `google_client_id` setting), then paste the Client ID into **google_client_id** and save.
8. Upload the new `app.html` to GitHub.

**How it behaves**

- New person: an account is created with their Google email and name. All the normal sign-up rules still apply (sign-ups closed, maintenance, blocked emails, referral codes).
- Existing person with the same email: they are signed in to their existing account. Google confirms the email is verified before this is allowed.
- Banned accounts are refused, same as password login.
- Accounts created with Google start with **no password**. On the Profile page the box shows **Set a password** (no current password asked). After that, they can sign in with Google or email and password, and the box becomes the normal **Change password**. **Forgot password** also works.
- If someone with a Google-only account tries email and password, they are told to use the Google button or set a password.
- The admin page (`admin.html`) still uses email and password only.


---

## Colour theme: white by default, dark mode offer after login

- The app (`app.html`) now opens in the **white** theme for everyone.
- Right after each sign-in (password or Google) the person is asked **"Switch to dark mode?"**
  - **Yes**: dark mode stays on for **3 days**, then goes back to white by itself. The Me tab shows the date it ends.
  - **No**: stays white, and the screen tells them they can change the colour scheme any time in the **Me** tab under Appearance. They are not asked again.
- Choosing a theme yourself in **Me > Appearance** is permanent until changed, and the question is not shown again.
- If a 3-day dark period has ended, the next sign-in asks again.
- The 3-day timer is stored in the browser (`raven_dark_until`), so it applies per device. `admin.html` is unchanged.
- The landing page (`index.html`) is also white by default. It reads the same browser setting, so if someone has dark mode switched on (for the 3 days, or by choice in the Me tab) the landing page shows dark too, and returns to white when the 3 days end. The guides pages (`guides/`) are still dark.

## Certificates and the verify page

Three files make up the certificate feature, and they share one stylesheet so they always match the rest of the site:

| File | What it is |
|---|---|
| `certificate.html` | "My certificates": a signed-in trader picks a passed phase or funded account, then downloads a PNG, prints or saves a PDF, or copies the verify link. |
| `verify.html` | The public check. Anyone enters a certificate ID, or scans the QR code on the certificate, to see if it is real. No sign in needed. |
| `cert.css` | Shared design for both pages. **Upload it with them** or the pages will look unstyled. |

How it behaves:

- **Theme:** both pages read the same saved choice as the rest of the site (`raven_theme`, set by the theme picker or the sun/moon button in the page header). They no longer follow the phone's system setting. The certificate style (White or Dark) starts on the site theme and can be changed on its own.
- **Where the traders find it:** a "Get my certificate" card on any passed or funded challenge, a "Certificate" tile on the Accounts screen, "My certificates" on the Me screen, and "Verify certificate" in the app footer and home page footer.
- **Who gets one:** the same rule the public check uses (funded, or in Phase 2, or Phase 1 passed). So every certificate you can download will verify.
- **Dates:** the date on a certificate is the day the milestone happened, so it never changes when reopened. This needs the updated `Cert.gs` below.
- **Names:** the certificate uses the name on the trader's profile. The public check only shows initials (for example `A*** O***`).

**To update a live system:**
1. Replace `Cert.gs` in Apps Script with the new file, then **Deploy > Manage deployments > Edit > New version > Deploy**. The web app link stays the same. No migration is needed.
2. Upload `certificate.html`, `verify.html`, `cert.css`, `app.html` and `index.html` to GitHub.

Until step 1 is done everything still works, but phase certificates show no date.

## Page loading fix (tabs and "hanging")

`app.html` now only draws the screen for the **latest** tab you tapped. Before, a slow page (usually Home) could finish after you had moved on and replace the screen you were on. Home also asked the server for the same data twice in a row; it now asks once. If a page fails to load, you get a "Try again" button instead of a screen that never finishes, and tapping the tab you are already on reloads it.
