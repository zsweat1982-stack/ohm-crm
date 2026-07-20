# Deploying the OHM CRM (Render)

Goal: put the CRM online so the team can log in at `app.openheartmediaco.com`, with data that
persists across restarts.

## 1. Push this app to a PRIVATE GitHub repo
This repo carries prospect data, so it MUST be private.
1. github.com/new → name `ohm-crm` → **Private** → Create (no README).
2. From `openheartmedia-outreach/app`:
   ```
   git remote add origin https://github.com/<you>/ohm-crm.git
   git branch -M main
   git push -u origin main
   ```

## 2. Create the Render service
1. render.com → New → **Blueprint** → connect the `ohm-crm` repo. Render reads `render.yaml`
   (Node web service, Starter plan, 1 GB persistent disk mounted at `/data`).
2. When prompted, add the **Environment Variables** (from your local `app/.env`):
   - `APP_PASSWORD`  (the shared team password)
   - `AUTH_SECRET`   (the long random string)
   - `ANTHROPIC_API_KEY`
   - `SENDGRID_API_KEY`
   - `SENDGRID_FROM_EMAIL` = zac@openheartmediaco.com
   - `SENDGRID_FROM_NAME`  = Zac - Open Heart Media
   - `CALENDLY_URL` = https://calendly.com/zsweat1982/30min
   - `NOTIFY_EMAILS` = zac@openheartmediaco.com,michelle@openheartmediaco.com
   - `LANDING_URL`  = https://app.openheartmediaco.com/go   (set after step 3)
   - `DAILY_SEND_CAP` = 40
   - `PAGESPEED_KEY` (optional)
3. Deploy. Render gives a URL like `ohm-crm.onrender.com`. Test login there first.

## 3. Point your subdomain at it
1. In Render → the service → Settings → Custom Domains → add `app.openheartmediaco.com`.
   Render shows a CNAME target.
2. In Squarespace DNS (where openheartmediaco.com lives) → add a CNAME:
   Host `app` → Value = the Render target.
3. Once it verifies, set `LANDING_URL=https://app.openheartmediaco.com/go` in Render env and redeploy,
   so every prospect email links to the live page.

## Notes
- Data persists on the `/data` disk. On first boot it seeds from the committed `data/prospects.json`.
- The prospect-facing landing page (`/go`) is public; everything else needs the team login.
- To change the team password later: update `APP_PASSWORD` in Render env and redeploy.
