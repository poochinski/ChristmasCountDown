# Christmas Movie Countdown

A nightly Christmas movie schedule from November 1 to Christmas Day, with star ratings,
"seen before" checks, Rotten Tomatoes scores, where-to-stream info, VHS-style movie details,
a night editor (swap, take off, or add movies on any night) and a builder so friends can make
their own countdown.

## How it works

- `server.js` serves the page from `public/` and saves the owner's list (movies, watched,
  ratings, seen) plus any poster images you upload.
- Storage is Postgres when `DATABASE_URL` is set (Railway), otherwise a local `data.json` file.
- The 62 built-in films have real poster artwork, including on previously saved countdowns. An uploaded poster takes priority. If the art goes offline, the app tries the film lookup before showing its generated cover.
- Adding a title in Database or My movies looks up its release year, poster, director, cast, genres, runtime and synopsis using Cinemeta. Add a year to distinguish remakes. Signed-in owners can also import US content ratings and available Rotten Tomatoes critic scores by setting `OMDB_API_KEY`. Scores come from the named Rotten Tomatoes rating. The app links to JustWatch for current US streaming options.
- On first start with an empty database it loads `seed.json` (the list as it was exported).
- Anyone can view the page. Only someone signed in with `ADMIN_PASSWORD` can change the
  owner's list. Visitors who aren't signed in get the "Make a list" builder; their lists are
  saved in their own browser.

## Run it locally (Codespaces)

```bash
npm install
ADMIN_PASSWORD=pick-a-password npm start
```

Open the forwarded port 3000, scroll to the bottom and use **Owner sign-in**.

## Deploy on Railway

1. railway.app → **New Project → Deploy from GitHub repo** → pick this repo.
2. In the project: **+ New → Database → Add PostgreSQL**.
3. On the app service → **Variables**:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `ADMIN_PASSWORD` = the password you'll use to edit your list
   - `OMDB_API_KEY` (optional) = get and activate a [key from OMDb](https://www.omdbapi.com/apikey.aspx), then add it to the app service to import available Rotten Tomatoes scores.
   - `ANTHROPIC_API_KEY` (optional) = enables "Fill in details with Claude" for movies you add
     (billed to your Anthropic API account). `ANTHROPIC_MODEL` is optional too.
4. App service → **Settings → Networking → Generate Domain**.

Railway redeploys automatically every time you push to `main`.

## Environment variables

| Name | Required | What it does |
| --- | --- | --- |
| `DATABASE_URL` | On Railway | Postgres connection string |
| `ADMIN_PASSWORD` | Yes, to edit | Password for the owner sign-in |
| `OMDB_API_KEY` | No | Imports available Rotten Tomatoes critic scores and parental ratings on owner lookups |
| `ANTHROPIC_API_KEY` | No | Turns on Claude fill-in for added movies |
| `ANTHROPIC_MODEL` | No | Model for fill-in (default `claude-sonnet-5-5`) |
| `PORT` | No | Set by Railway automatically |
