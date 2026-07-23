# Artist Route database workspace

This workspace builds the collaboration graph used by the game:

```text
current artist -> choose one of their songs -> choose another credited artist
```

The editable master database is SQLite. The website receives compact static JSON files, so the game itself does not need a backend.

## Folder structure

```text
artist-route-workspace/
├─ generator/
│  ├─ database_generator.py   Main generator and maintenance CLI
│  ├─ config.json             Build settings
│  ├─ requests.json           Community request queue
│  ├─ requirements.txt
│  ├─ music_graph.db          Generated SQLite master database
│  ├─ cache/                  Cached API responses
│  └─ reports/                Resolution and request reports
├─ output/
│  ├─ main.json               Song ID -> credited artist IDs
│  ├─ artists.json            Artist ID -> displayed name
│  ├─ songs.json              Song ID -> displayed title
│  ├─ artistSongs.json        Artist ID -> searchable song IDs
│  └─ manifest.json           Counts and data format version
├─ setup.bat / setup.sh
├─ build.bat / build.sh
└─ tests/
```

## Data sources

- **Last.fm** selects popular artists and popular tracks.
- **MusicBrainz** supplies authoritative recording titles and structured artist credits.

MusicBrainz does not require an API key, but it requires a meaningful User-Agent containing a contact URL or email. `generator/config.json` currently uses `https://romoboss.com`; change it if necessary.

Last.fm requires an API key. Create a Last.fm API application, then set the key in the shell before running any command that contacts the APIs:

```powershell
$env:LASTFM_API_KEY = "your-api-key-here"
```

```bash
export LASTFM_API_KEY="your-api-key-here"
```

The generator uses Last.fm only for popularity. Last.fm recording IDs are resolved through MusicBrainz, and the full MusicBrainz artist-credit list remains authoritative.

## First setup

### Windows

```bat
setup.bat
```

### Linux/macOS

```bash
chmod +x setup.sh build.sh
./setup.sh
```

This creates `.venv`, installs `requests`, initializes the SQLite database, and creates empty output files.

## Build the configured database

```bat
build.bat
```

or directly:

```bash
python generator/database_generator.py build
```

The defaults in `generator/config.json` request the top 100 artists and up to 100 collaborative recordings per artist. Test a smaller build first:

```bash
python generator/database_generator.py build --top-artists 5 --songs-per-artist 10 --pretty
```

The script processes candidates in Last.fm popularity order and continues until it has kept the requested number of collaborative recordings or runs out of candidates. Before requesting an artist's tracks, it counts that artist's distinct songs already stored in SQLite. Artists that already meet `--songs-per-artist` are skipped without making track or recording API requests. Pass `--refresh-existing` when you intentionally want to process them again. It requests at least 100 candidates for every remaining artist because solo tracks and tracks that cannot be resolved through MusicBrainz are skipped.

## Pause and resume a build

Press `Ctrl+C` once to pause a running build. The generator will:

1. Commit all imported artists and songs to `generator/music_graph.db`.
2. Regenerate the website JSON files with everything imported so far.
3. Save progress to `generator/reports/build_checkpoint.json`.

Resume later with the same Last.fm API key available in the new shell:

```bash
python generator/database_generator.py resume
```

The checkpoint remembers the artist and song counts, resolved seed artists, completed artist index, refresh setting, JSON formatting setting, totals, and failures. If an artist was only partly processed, resumption safely replays its cached candidate list; songs already in SQLite keep their existing IDs and are not inserted again.

A successful build or resume removes the checkpoint. To intentionally abandon a checkpoint and begin a new build while preserving all data already stored in SQLite, run:

```bash
python generator/database_generator.py build --restart
```

## Grow the database continuously

Run the progressive builder until you stop it with `Ctrl+C`:

```bash
python generator/database_generator.py constant-grow

# Target a fixed number of stored collaborations for every artist
python generator/database_generator.py constant-grow --songs 25
```

`constant-grow` scans the top 10 Last.fm artists, then expands through top 20, 50, 100, 200, 500, 1000, and the same 1-2-5 pattern until it reaches the available chart limit. At that limit it waits and refreshes the catalog periodically instead of exiting. For each artist, the default `--coverage 0.9` means scanning 90% of Last.fm's ranked track candidates; it does not promise that 90% will be stored because solo tracks, unresolved recordings, and tracks with incompatible credits cannot create graph connections. Pass `--songs N` instead to stop processing each artist after it has `N` unique stored collaborations, using the same target behavior as `add-artist --songs N`. Alternate MusicBrainz recordings that resolve to an existing song are retained as aliases but do not increase this count. Progress is reported every 25 ranked tracks; if the available candidates are exhausted before the target is reached, the generator reports the shortfall and continues to the next artist. `--songs` and `--coverage` are mutually exclusive.

Each cohort ends with a bounded `fill-minimum` pass for up to 10 underconnected artists. Use `--minimum-songs N` and `--fill-batch-size N` to change that work. `--ignore-0-songs` affects these fill batches only: it leaves artists with no songs alone and focuses on partially connected artists.

Website JSON is exported after 25 newly imported recordings, after 10 minutes, and at every cohort boundary by default. These intervals can be changed with `--export-every-recordings N` and `--export-every-minutes N`; a cohort-boundary export always occurs. Pressing `Ctrl+C` commits the SQLite data, exports once more, and saves `generator/reports/constant_grow_checkpoint.json`. Run the same command later to resume the saved cohort, artist position, target mode, options, and totals.

Use `constant-grow --restart` to restart the cohort schedule with the command-line options you provide. This removes only the constant-grow checkpoint; songs and reusable track-check outcomes in `generator/music_graph.db` are preserved.

Track outcomes are cached persistently per artist in SQLite. In particular, a solo song is not added to the collaboration graph, but its check is saved so later builds, fill passes, and constant-growth stages do not resolve and reject it again. Existing/imported, wrong-artist, and unresolved outcomes are also reused. Failed checks are not terminal and are retried on a later pass.

## Add one artist collection

Supply either a raw MusicBrainz artist MBID or an artist URL:

```bash
python generator/database_generator.py add-artist \
  f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387 \
  --songs 100
```

The command automatically exports updated website files afterward.

## Add one song

Supply a MusicBrainz recording MBID or recording URL:

```bash
python generator/database_generator.py add-song RECORDING_MBID
```

A recording with fewer than two credited artists is rejected because it cannot create a route in the game.

## Community request queue

Edit `generator/requests.json`:

```json
{
  "artists": [
    {
      "mbid": "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387",
      "songs": 100
    }
  ],
  "songs": [
    "MUSICBRAINZ_RECORDING_MBID_OR_URL"
  ]
}
```

Then run:

```bash
python generator/database_generator.py process-requests
```

Requests that are already present are safe to run again. Transient API failures are retried five
times with increasing delays. If all attempts fail, processing continues with the next request and
the retryable request details plus the error are written to
`generator/reports/failed_requests.json`. Retry those entries later with:

```bash
python generator/database_generator.py process-requests --file generator/reports/failed_requests.json
```

A summary of every queue run is also recorded in `generator/reports/last_request_run.json`.

## Maintenance commands

```bash
# Recreate website JSON without contacting either API
python generator/database_generator.py export

# Check SQLite integrity, foreign keys, and graph validity
python generator/database_generator.py validate

# Print current database counts
python generator/database_generator.py stats

# Fill artists with zero or one song until every stored artist has at least two
python generator/database_generator.py fill-minimum

# Fill only one-song artists, leaving zero-song artists untouched
python generator/database_generator.py fill-minimum --ignore-0-songs

# Report songs with matching titles and compatible credited artists
python generator/database_generator.py dedupe

# Merge those duplicates into the oldest song ID and regenerate website JSON
python generator/database_generator.py dedupe --apply --pretty

# Refresh metadata for already stored recordings during an artist import
python generator/database_generator.py add-artist ARTIST_MBID --refresh-existing
```

Internal integer IDs are assigned by SQLite and are stable as long as `generator/music_graph.db` is preserved. Do not delete that file when updating the database.

Deduplication preserves the oldest internal song ID, unions credited artist IDs in stable order, and keeps every alternate MusicBrainz recording MBID in an internal alias table. Future imports of any merged recording resolve to the existing song instead of recreating a duplicate. All content inside parentheses, square brackets, or curly braces is removed from stored and exported titles and ignored during duplicate comparison; recognized unbracketed labels such as `remix`, `remastered`, `live`, or `radio edit` are ignored too. Matching comparison titles are merged when they share a credited artist.

`fill-minimum` defaults to two distinct songs per artist and includes artists with zero songs as well as those with one. Pass `--ignore-0-songs` to leave disconnected artists untouched; with the default target, this processes only artists that currently have exactly one song. The filter is reapplied on every pass. The command repeats because imported collaborations can introduce new artists that also need filling. If a complete pass cannot improve any remaining artist, it stops instead of looping forever and writes the unresolved list to `generator/reports/fill_minimum.json`. Use `--minimum-songs N` for another target. Pressing `Ctrl+C` commits and exports all progress; rerun the same command to continue from SQLite and the API cache.

Delete only the relevant folder under `generator/cache/` when you deliberately want to retrieve fresh API responses. Old `listenbrainz_*` cache folders are no longer used and can be removed; preserve `musicbrainz_*` folders unless you want to download that data again.

## Website data format

### `main.json`

```json
{
  "data": {
    "123": {
      "artists": [5, 28]
    }
  }
}
```

### `artists.json`

```json
{
  "artists": {
    "5": "Ariana Grande",
    "28": "The Weeknd"
  }
}
```

### `songs.json`

```json
{
  "songs": {
    "123": "Love Me Harder"
  }
}
```

### `artistSongs.json`

```json
{
  "artistSongs": {
    "5": [123],
    "28": [123]
  }
}
```

The extra `artistSongs.json` file prevents the website from scanning every song after each keystroke.

## Minimal website search example

```js
const [mainResponse, artistsResponse, songsResponse, artistSongsResponse] =
  await Promise.all([
    fetch("./data/main.json"),
    fetch("./data/artists.json"),
    fetch("./data/songs.json"),
    fetch("./data/artistSongs.json")
  ]);

const { data } = await mainResponse.json();
const { artists } = await artistsResponse.json();
const { songs } = await songsResponse.json();
const { artistSongs } = await artistSongsResponse.json();

function normalize(value) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .trim();
}

function searchSongsForArtist(artistId, query) {
  const wanted = normalize(query);

  return (artistSongs[artistId] ?? [])
    .filter(songId => normalize(songs[songId]).includes(wanted))
    .map(songId => ({ id: songId, name: songs[songId] }));
}

function getOtherArtists(songId, currentArtistId) {
  return data[songId].artists
    .filter(artistId => String(artistId) !== String(currentArtistId))
    .map(artistId => ({ id: artistId, name: artists[artistId] }));
}
```

## Initial build performance

Last.fm often omits a MusicBrainz recording ID. In that case the generator searches MusicBrainz by track title and artist before retrieving the recording's full credits. MusicBrainz requests are rate-limited to roughly one per second, so the first large build can take several hours. Cached builds are considerably faster. Start with 5 artists and 10 songs per artist, then increase to 20 artists and 25 songs after checking the results.

## Important limitations

- The graph treats every separately credited MusicBrainz artist as a valid connection; it does not require a strict `feat.` role.
- Different recordings of the same composition can remain separate songs.
- Different artists can have identical displayed names. IDs remain distinct.
- The initial top-artist resolution is name-based when Last.fm does not provide an artist MBID. Review `generator/reports/resolved_top_artists.json` and `unresolved_top_artists.json` after a large build.
- Preserve the SQLite database to preserve IDs used by saved routes or daily challenge seeds.

## Tests

```bash
python -m unittest discover -s tests -v
```
