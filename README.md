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

# Rebuild data/database.js from the JSON files in output/
npm run build:database

# Run the database generator tests
python -m unittest discover -s tests -v
```

Database setup, build, and maintenance instructions are in
[`docs/DatabaseBuildingHelp.md`](docs/DatabaseBuildingHelp.md).

The files in `data/` are loaded directly by the website. In particular,
`data/daily-challenges.js` is an append-only archive maintained by the GitHub
Actions workflow, so it should not be regenerated manually.
