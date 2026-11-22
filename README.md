# Player Cards

Make a player card from your Discord messages, then trade cards with friends.

- **Card maker.** Pick your Discord export's `Messages` folder. Stats, suggested traits, a quote and catchphrases are worked out **in your browser**; messages are never uploaded. You can untick whole servers or single channels to leave them out. Everything stays editable, or fill the card in by hand.
- **Originals and copies.** Every card has two originals. **Original 1/2** stays with its creator forever. The creator's first trade of their own card hands out **Original 2/2**; every trade after that mints a numbered **Copy #1, #2, …**. Anyone holding Original 2/2 or a copy can trade it on.
- **Trades** are offers: pick what you give and what you want, and nothing moves until the other person accepts. The rules are enforced in the database, so they can't be bypassed from the browser.

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
2. Go to **SQL Editor → New query**, paste all of [`supabase/schema.sql`](supabase/schema.sql) and press **Run**.

### 2. Turn on "Sign in with Discord"
1. In the [Discord Developer Portal](https://discord.com/developers/applications), create a **new application** (keep it separate from your bot) and open **OAuth2**.
2. In Supabase, go to **Authentication → Sign In / Providers → Discord**, switch it on, and copy the **Callback URL** it shows.
3. Back in Discord's OAuth2 page, add that callback URL under **Redirects**, then copy the **Client ID** and **Client Secret** into Supabase's Discord provider settings and save.

### 3. Point the site at Supabase
Open **Project Settings → API** in Supabase and paste these into [`config.js`](config.js):
- **Project URL** → `SUPABASE_URL`
- **anon public** key → `SUPABASE_ANON_KEY`

Both are meant to be public. Never paste the `service_role` key anywhere in this repo.

### 4. Publish on GitHub Pages
1. Push this folder to a GitHub repository.
2. In the repo: **Settings → Pages → Build and deployment → Deploy from a branch**, branch `main`, folder `/ (root)`.
3. Your site will be at `https://<your-username>.github.io/<repo-name>/`.
4. In Supabase, go to **Authentication → URL Configuration** and set **Site URL** to that address (also add it under **Redirect URLs**).

Send friends the link. They sign in with Discord, make a card, and show up under **Players**.

## Files

| Path | What it does |
| --- | --- |
| `index.html` | Page shell |
| `config.js` | Your Supabase URL and anon key (empty = demo mode) |
| `js/app.js` | Screens: My card, Collection, Players, Trades |
| `js/card.js` | Draws a card and its three themes |
| `js/export.js` | Reads a Discord export and suggests card fields |
| `js/api-supabase.js` | Live backend |
| `js/api-local.js` | Demo backend (browser storage) |
| `supabase/schema.sql` | Tables, permissions and the trade rules |
| `css/` | Card and app styles |

## Notes
- Card text (name, quote, lore and so on) is visible to everyone who signs in, so pick a quote you're happy to show.
- Suggestions are rule-based. Having Claude write them would need an API key kept on a server, which GitHub Pages can't do. Supabase Edge Functions could add that later.
- Only the JSON export format is read (the current Discord format). Very old exports with `messages.csv` aren't supported yet.
