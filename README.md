# Raven Prop: Simple Setup Guide

## What is in this folder?

Your project has 3 parts. Think of it like a shop:

| Part | What it is | Files |
|------|-----------|-------|
| **The shop window** | The website people see | `index.html`, `admin.html`, `assets/` |
| **The back office** | The brain. Handles sign-ups, payments, payouts | `Code.gs`, `Access.gs`, `Engine.gs`, `Money.gs`, `Ops.gs`, `appsscript.json` |
| **The daily checker** (optional) | Checks trading account balances once a day | `equity_monitor.py`, `.github/workflows/equity.yml` |

Your data (users, payments, and so on) is kept in a **Google Sheet** that the back office creates for you.

**Other files:** `CNAME` (your domain name: ravenprop.cfd), `robots.txt`, `sitemap.xml`, `site.webmanifest` (website extras), `.gitignore` (tells GitHub which files to keep private).

---

## STEP 1: Set up the back office (Google Apps Script)

1. Go to https://script.google.com and sign in with the Google account that will OWN the business.
2. Click **New project**. Name it `Raven Prop`.
3. Delete everything in the default file.
4. Create one script file for each of these and paste in the contents:
   - `Code.gs`
   - `Access.gs`
   - `Engine.gs`
   - `Money.gs`
   - `Ops.gs`

   (Click the **+** next to "Files" > **Script**. Type the name without `.gs`.)
5. Click the gear icon (**Project Settings**) and tick **Show "appsscript.json" manifest file in editor**.
6. Open `appsscript.json` in the editor and replace its contents with the one from this folder.
7. Click **Save**.

## STEP 2: Add your secret settings

1. In Apps Script, click the gear icon (**Project Settings**).
2. Scroll to **Script Properties** > **Add script property**.
3. Add these (name on the left, value on the right):

| Name | Value | When |
|------|-------|------|
| `BOOTSTRAP_OPEN` | `true` | Now (see Step 4) |
| `OWNER_EMAIL` | your email | Now |
| `EQUITY_SECRET` | any long random password | Only if you use the daily checker (Step 7) |
| `SQUAD_SECRET_KEY` | from Squad | Only if you accept card payments with Squad |
| `FLW_SECRET_KEY` | from Flutterwave | Only if you use Flutterwave |
| `MONNIFY_API_KEY`, `MONNIFY_SECRET_KEY`, `MONNIFY_CONTRACT_CODE` | from Monnify | Only if you use Monnify |
| `MONNIFY_ENV` | `sandbox` (testing) or `live` | Only if you use Monnify |

Leave the payment ones empty for now. You can add them later.

## STEP 3: Publish the back office and get its link

1. Click **Deploy** > **New deployment**.
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Set **Execute as: Me**.
4. Set **Who has access: Anyone**.
5. Click **Deploy**. Google will ask you to allow permissions. Click **Allow** (if it warns "unsafe", click **Advanced** > **Go to Raven Prop**).
6. **Copy the Web app URL.** It ends in `/exec`. You need it in the next step.

> Every time you change the .gs code later, do **Deploy > Manage deployments > Edit (pencil) > Version: New version > Deploy**. The link stays the same.

## STEP 4: Connect the website to the back office

You need to paste the link from Step 3 into two files.

1. Open `index.html` in a text editor (Notepad works). Search for:
   `PASTE_APPS_SCRIPT_WEB_APP_URL_HERE`
   Replace it with your `/exec` link. Keep the quote marks.
2. Do the same in `admin.html`.
3. Also in `index.html`, search for `YOUR-DOMAIN.com` and replace every one with `ravenprop.cfd` (or your real domain).

## STEP 5: Put the website online (GitHub Pages)

1. Create a free account at https://github.com.
2. Click **New repository**. Name it `raven`. Make it **Public**. Click **Create**.
3. Click **uploading an existing file**. Drag in everything from this folder (including the `assets` and `.github` folders). Click **Commit changes**.
4. Go to **Settings** > **Pages**. Under "Branch" pick `main` and `/ (root)`. Click **Save**.
5. Under "Custom domain" type `ravenprop.cfd` and save. (The `CNAME` file already says this.)
6. At the company where you bought the domain, point it to GitHub Pages. GitHub shows the exact instructions on that same page. Look for "Configuring a custom domain".
7. Wait a few minutes, then open your domain. You should see the site.

## STEP 6: Create your owner account (do this first!)

1. On your live website, click **Start Challenge** and sign up with your own email and a strong password.
2. **The FIRST person to sign up becomes the owner.** The back office also creates your "Raven Prop Data" Google Sheet at this moment.
3. Go back to Apps Script > **Project Settings** > **Script Properties**.
   **Delete `BOOTSTRAP_OPEN`** (or set it to `false`). This stops strangers from taking over.
4. Open `yourdomain.com/admin.html` and sign in with the same account. This is your control panel.

## STEP 7: Turn on the automatic jobs

1. In Apps Script, use the function dropdown at the top and pick `ops_installTriggers`.
2. Click **Run**. Allow permissions if asked.
3. This sets up the timed jobs, one every 10 minutes and one daily. You only do this once.

## STEP 8: Fill in the business details (in the admin panel)

Open `admin.html` and check:
- **Plans and prices**
- **Countries and currencies**
- **Settings** (brand name, support email, WhatsApp link)
- **Legal pages**: the Terms, Privacy and Risk pages on the site are placeholders marked `[DRAFT PLACEHOLDER]`. Have them replaced with lawyer-reviewed text before launch. They are inside `index.html`.

## STEP 9 (optional): Daily balance checker

This only matters when you have real MT5 trading accounts to watch. **The code's own notes say the MT5 install part is untested. Do a trial run first.**

1. In your GitHub repository, go to **Settings** > **Secrets and variables** > **Actions** > **New repository secret**.
2. Add `RAVEN_API_URL` (your `/exec` link from Step 3).
3. Add `EQUITY_SECRET` (the **exact same** value you saved in Step 2).
4. Go to the **Actions** tab > **Equity check** > **Run workflow** to try it.
5. If it works, it then runs by itself every day.

---

## Things that are still missing

- These icons are referenced by the site but are not in the folder, so browsers will show errors for them: `assets/favicon.ico`, `assets/favicon-32.png`, `assets/apple-touch-icon.png`, `assets/icon-512.png`. Add them, or ignore them for now.
- The site shows pictures from Unsplash (an online photo site), so it needs internet to show them.

## Safety rules

- **Never share** your Script Properties or secret keys.
- **Never upload `.csv` files** with trading passwords to GitHub. The `.gitignore` file blocks this, so do not remove it.
- Keep the "Raven Prop Data" Google Sheet **private**. It holds sensitive information.

## If something goes wrong

| Problem | What to check |
|---------|--------------|
| Site says "Could not reach the server" | The link in Step 4 is wrong or was not saved. Make sure it ends in `/exec`. |
| Sign-up says "The system is not set up yet" | `BOOTSTRAP_OPEN` is not set to `true` (Step 2). |
| Site says "Launching soon" | Nobody has signed up yet. Do Step 6. |
| You changed the code but nothing changed | Publish a **New version** (note in Step 3). |
| Domain does not work | DNS changes can take up to a few hours. |
