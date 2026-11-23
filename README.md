# Player Cards

Make a player card from your Discord messages, then trade cards with friends.

- **Card maker.** Pick your Discord export's `Messages` folder. Stats, suggested traits, abilities, a quote (with its date) and catchphrases are worked out **in your browser**; messages are never uploaded. You can untick whole servers or single channels to leave them out. Rarity comes from your message count. Everything else stays editable: 7 themes, 9 name fonts, frames, finishes, custom colors and a portrait picture.
- **Originals and copies.** Every card has two originals. **Original 1/2** stays with its creator forever. The creator's first trade of their own card hands out **Original 2/2**; every trade after that mints a numbered **Copy #1, #2, …**. Anyone holding Original 2/2 or a copy can trade it on.
- **Versions.** Once a version of your card has been traded it's frozen, so everyone keeps the card they got. Your next save starts a new version with its own Original 1/2 and 2/2.
- **Trading.** Offers, counter-offers and wishlists, with live updates and optional browser notifications. The rules are enforced in the database, so they can't be bypassed from the browser.
- **Collecting.** 14 badges, a collection score and a leaderboard. Cards you get from a trade are revealed with an animation the first time you see them. Any card can be shared with a link or downloaded as a PNG.
- **Activity and profiles.** An activity feed of new cards, new versions and finished trades (only what changed hands, never messages or open offers), and a profile page for every player with their card, its history, stats, badges and collection.
- **Moderation.** Players can report cards; moderators can hide cards and remove pictures.

It's a static site (GitHub Pages) plus [Supabase](https://supabase.com) for Discord sign-in and the database. Both have free tiers.

## Try it first (demo mode)

With `config.js` left empty, the app runs in **demo mode**: everything is stored in your browser, with two sample players you can switch to and trade with.

```bash
python -m http.server 5181 --directory .
```

Then open http://127.0.0.1:5181. (Opening `index.html` directly doesn't work, because browsers block JavaScript modules from `file://`.)

## Go live

### 1. Create the Supabase project
1. Sign up at supabase.com and create a new project (any name, free plan).
2. Go to **SQL Editor → New query** and run each file in [`supabase/`](supabase) **in this order**, one query each: `schema.sql`, `002_portraits.sql`, `003_versions_moderation.sql`, `004_profile_names.sql`, `005_counters_wishlist.sql`, `006_activity.sql`, `007_bot.sql`. (`008_bot_schedule.sql` is part of the Discord bot setup below.)

### 2. Turn on "Sign in with Discord"
1. In the [Discord Developer Portal](https://discord.com/developers/applications), create a **new application** (keep it separate from any bot) and open **OAuth2**.
2. In Supabase, go to **Authentication → Sign In / Providers → Discord**, switch it on, and copy the **Callback URL** it shows.
3. Back in Discord's OAuth2 page, add that callback URL under **Redirects** (and **Save Changes**), then copy the **Client ID** and **Client Secret** into Supabase's Discord provider settings and save.

### 3. Point the site at Supabase
Open **Project Settings → API Keys** in Supabase and paste these into [`config.js`](config.js):
- **Project URL** → `SUPABASE_URL`
- **Publishable key** (`sb_publishable_…`, or the legacy anon key) → `SUPABASE_ANON_KEY`

Both are meant to be public. Never paste a secret key (`sb_secret_…` or `service_role`) anywhere in this repo.

### 4. Publish on GitHub Pages
1. Push this folder to a GitHub repository (public, unless your plan allows Pages on private repos).
2. In the repo: **Settings → Pages → Build and deployment → Deploy from a branch**, branch `main`, folder `/ (root)`.
3. Your site will be at `https://<your-username>.github.io/<repo-name>/`.
4. In Supabase, go to **Authentication → URL Configuration** and set **Site URL** to that address (also add it under **Redirect URLs**).

### 5. Make yourself a moderator
In the SQL Editor, with your own Discord user ID:
```sql
update public.profiles set is_admin = true
where id in (select id from auth.users where raw_user_meta_data->>'provider_id' = 'YOUR_DISCORD_ID');
```

Send friends the link. They sign in with Discord, make a card, and show up under **Players**.

## Discord bot

A Player Cards bot for your server, separate from any other bot you run. It lives on Supabase as an
Edge Function, so there's no server to keep on.

- `/card [player]` shows someone's card (yours if you leave it empty). Right-click a user → **Apps → Player Card** does the same.
- `/collection [player]` lists the cards someone has collected.
- `/feed here` (Manage Server only) posts new cards, new versions and finished trades in that channel, about a minute after they happen. `/feed off` stops it.

The feed only posts what the site's Activity tab already shows everyone. Trade messages, open
offers and hidden cards are never posted. Nothing from before the bot was set up gets posted.

**Set up once:**
1. **Discord app.** In the [Discord Developer Portal](https://discord.com/developers/applications), open the application you made for "Sign in with Discord" (it's already separate from your other bot).
   - **General Information:** copy the **Application ID** and **Public Key**.
   - **Bot:** click **Reset Token** and copy the token. Discord shows it only once. Don't paste it anywhere else (not in chat, not in this repo). No privileged intents are needed.
2. **Supabase secrets.** In Supabase go to **Edge Functions → Secrets** and add three secrets: `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY` and `DISCORD_BOT_TOKEN`.
3. **Database.** In the **SQL Editor**, run `supabase/007_bot.sql`.
4. **Deploy access.** In Supabase open **Account → Access Tokens** ([direct link](https://supabase.com/dashboard/account/tokens)), generate a token named `github-deploy-bot`, and add it to this repo as the Actions secret `SUPABASE_ACCESS_TOKEN` (**Settings → Secrets and variables → Actions**). Then run **Actions → Deploy Discord bot → Run workflow**.
5. **Connect Discord to the bot.** Back in **General Information**, set **Interactions Endpoint URL** to
   `https://xqinypchsnkoiezpvqyn.supabase.co/functions/v1/discord-bot` and save. Discord tests it right away; if it saves, the bot is answering.
6. **Start the feed.** In the **SQL Editor**, run `supabase/008_bot_schedule.sql`. Within a minute the bot registers its commands with Discord.
7. **Invite it.** Open this link with your Application ID in it, pick your server, and allow it:
   `https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot+applications.commands&permissions=536870912`
   (The only permission it asks for is **Manage Webhooks**, which it uses to post the feed.)
8. In the channel you want, type `/feed here`.

**If something's off:** Supabase → **Edge Functions → discord-bot → Logs** shows each request and any error.
To stop the feed everywhere, run `select cron.unschedule('player-cards-discord-feed');` in the SQL Editor.
The once-a-minute job uses about 43,000 of the free plan's 500,000 function calls a month.

## Automatic jobs (GitHub Actions)

| Workflow | When | What it does |
| --- | --- | --- |
| **Tests** | every push | Runs `npm test`. A red ❌ next to a commit means something broke. |
| **Keep Supabase awake** | every 3 days | One small read so the free project never pauses. |
| **Backup** | every Sunday | Encrypted database backup, kept for 90 days. Needs the two secrets below. |
| **Deploy Discord bot** | when the bot's code changes | Sends `supabase/functions/discord-bot` to Supabase. Needs `SUPABASE_ACCESS_TOKEN`; skips itself without it. |

GitHub turns scheduled workflows off after 60 days without commits. If that happens, turn them back on in the repo's **Actions** tab.

## Backups

The repo is public, so backups are **encrypted with a passphrase only you know** before GitHub stores them. Without the passphrase a downloaded backup is useless.

**Set up once** (repo → **Settings → Secrets and variables → Actions → New repository secret**):
1. `SUPABASE_DB_URL`: in Supabase click **Connect**, copy the **Session pooler** connection string, and replace `[YOUR-PASSWORD]` with your database password.
2. `BACKUP_PASSPHRASE`: any long passphrase. Save it in your password manager; you need it to restore.

Then run it once by hand: **Actions → Backup → Run workflow**.

**What's in it:** every table, rule and function in the database (cards, versions, items, trades, wishlists, reports, profiles). **Not included:** login accounts (Supabase keeps those) and portrait picture files (Supabase Storage).

**To restore** (needs PostgreSQL 17 tools and GnuPG):
1. Download the latest backup from **Actions → Backup → (a run) → Artifacts** and unzip it.
2. Decrypt it (asks for your passphrase):
   ```bash
   gpg --output backup.dump --decrypt player-cards-YYYY-MM-DD.dump.gpg
   ```
3. Put it back into the database. This replaces the current tables, so only do it when you mean to:
   ```bash
   pg_restore --clean --if-exists --no-owner --no-privileges --schema=public --dbname "YOUR_SUPABASE_DB_URL" backup.dump
   ```

## Tests

```bash
npm install
npm test
```

- `tests/db.test.js` runs every file in `supabase/` on an in-process Postgres (PGlite) with Supabase's auth and storage faked, then checks the rules: originals and copies, frozen versions, permissions, moderation, names, counter-offers, wishlists and the activity feed.
- `tests/bot-db.test.js` checks what the Discord bot can read: the feed it posts (once each, in order, never messages or hidden cards), the `/card` lookup, and that none of it is open to the site.
- `tests/bot.test.js` runs the bot's code with fake Discord and database calls: request signatures, `/card`, `/collection`, `/feed` and the feed posts.
- `tests/export.test.js` runs the export parser and card cleaning on a small made-up export (no real messages).

## Files

| Path | What it does |
| --- | --- |
| `index.html` | Page shell |
| `config.js` | Your Supabase URL and publishable key (empty = demo mode) |
| `js/app.js` | Screens: My card, Collection, Players, Activity, Trades, Leaderboard, Moderation, player profiles, shared card pages, card reveals |
| `js/card.js` | Draws a card: themes, fonts, frames, finishes, colors, portraits |
| `js/export.js` | Reads a Discord export and suggests card fields |
| `js/goals.js` | Badges, collection score and leaderboard |
| `js/api-supabase.js` | Live backend |
| `js/api-local.js` | Demo backend (browser storage) |
| `supabase/*.sql` | Tables, permissions and all game rules, run in order |
| `supabase/functions/discord-bot/` | The Discord bot (`bot.ts` is the logic, `index.ts` connects it to Discord and the database) |
| `tests/` | Automated tests |
| `.github/workflows/` | Tests, keep-awake, backup and bot deploy jobs |
| `css/` | Card and app styles |

When you change any file the site loads, bump the `?vN` tag in `index.html` and in every `import` so browsers don't keep the old copy.

## Notes
- Card text and pictures are visible to everyone who signs in, and anyone can open a shared card link.
- Suggestions are rule-based, worked out in the browser.
- Only the JSON export format is read (the current Discord format). Very old exports with `messages.csv` aren't supported.
