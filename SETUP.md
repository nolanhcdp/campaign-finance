# Campaign Finance Helper — setup

One Vercel project holds everything:

- **The app** (`/public`) that candidates use.
- **The AI functions** (`/api/extract`, `/api/review`), which read uploads and double-check reports using your Claude key.
- **Saving** (`/api/draft`), which stores each candidate's report under a private code so they can come back to it.
- **Your helper page** (`/admin.html`), which lists every draft so you can open one and help.

## 1. Claude API key (platform.claude.com)
1. **Settings → Billing:** add $10 in credits.
2. **Settings → Limits:** set a monthly spend limit (e.g. $25).
3. **API Keys → Create Key:** name it `finance-tool` and save it in your password manager.

## 2. Deploy to Vercel
1. Put this `vercel` folder in a GitHub repo (private).
2. vercel.com: **Add New → Project**, import the repo, and leave the Framework Preset as **Other**.
3. Deploy.

## 3. Add storage for saved reports
1. In the project, go to **Storage → Create Database** (or **Marketplace**) and choose **Upstash for Redis**. The free plan is enough.
2. Connect it to this project. Vercel adds the connection settings (`KV_REST_API_URL`, `KV_REST_API_TOKEN`) for you.

## 4. Add your settings
**Settings → Environment Variables:**

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your key from step 1 |
| `ACCESS_CODE` | the sign-up code you give candidates, e.g. `Howard2026` |
| `ADMIN_CODE` | a long private code only you know, for the helper page |
| `MODEL` | optional; defaults to `claude-sonnet-5-5` |

Then **Deployments → ⋯ → Redeploy** so the settings take effect.

## How candidates use it
1. You send them the site link and the sign-up code.
2. They click **Start a new report**, enter the sign-up code, and get a personal report code like `7KQ-M2P-X9D` plus a link. They can copy it or email it to themselves.
3. Everything saves automatically about a second after each change, to your storage and to their device. The top bar says "All changes saved."
4. To come back, they open their link on any phone or computer, or go to the site and type their code. They land on the step where they left off.
5. If they have it open in two places and edit both, the older one shows "changed on another device" with a button to load the newest version, so nothing gets silently overwritten.

## Helping a candidate
Go to `your-site/admin.html` and enter your `ADMIN_CODE`. You'll see every draft: the candidate, how many entries, how many red items are left, and when it was last saved. Click a code to open their report. Anything you change saves to their report, so avoid editing while they're working in it.

## Notes
- Photos are read and turned into entries, but the photos themselves aren't stored. Only the entries are saved.
- Candidates can also download a backup file on the last step, and restore it from the start screen.
- Vercel caps each upload at about 4.5 MB, so the app shrinks photos before sending them.
