# Songaveler

Songaveler is a static, database-backed artist connection game. The HTML entry
pages stay at the project root so they can be served directly by GitHub Pages.

## Project layout

```text
assets/      Images and SVG files used by the site
css/         Shared site styles and themes
data/        Browser-ready generated data and saved Daily Challenges
docs/        Project documentation
generator/   Python/SQLite database generator
js/          Browser application code
output/      JSON exported by the database generator
test/        JavaScript tests
tests/       Python generator tests
tools/       Node.js data and Daily Challenge maintenance scripts
*.html       Static site entry pages
```

## Common commands

```bash
# Run the browser application and automation tests
npm test

# Rebuild the full and compact browser databases from the JSON files in output/
npm run build:database

# Run the database generator tests
python -m unittest discover -s tests -v

# Print the shortest in-game route between two artists
npm run test:route -- "Radiohead" "Daft Punk"
```

The route test accepts artist names without regard to case or accents. If the
database contains duplicate names, pass an explicit value such as `id:123`.

The displayed website version is the `websiteVersion` constant in
`js/navigation.js`. Keep it equal to the `version` in `package.json`; `npm test`
checks that the two values stay synchronized.

Database setup, build, and maintenance instructions are in
[`docs/DatabaseBuildingHelp.md`](docs/DatabaseBuildingHelp.md).

The files in `data/` are loaded directly by the website. In particular,
`data/daily-challenges.js` is an append-only archive maintained by the GitHub
Actions workflow, so it should not be regenerated manually. The workflow runs
after pushes and shortly after 00:00 UTC each day (and can be started manually).
For a push, it saves today's challenge using the database from before that push.
This keeps the current challenge stable across database updates; it becomes
playable from the Daily Archive on the next UTC day.
