#!/usr/bin/env python3
"""Build and maintain the static collaboration database for Artist Route.

Default behavior (no subcommand):
    python generator/database_generator.py

This reads generator/config.json, updates generator/music_graph.db, and exports:
    output/main.json
    output/artists.json
    output/songs.json
    output/artistSongs.json
    output/manifest.json

Other useful commands:
    python generator/database_generator.py resume
    python generator/database_generator.py add-artist <artist MBID or URL>
    python generator/database_generator.py add-song <recording MBID or URL>
    python generator/database_generator.py constant-grow
    python generator/database_generator.py fill-minimum
    python generator/database_generator.py process-requests
    python generator/database_generator.py export
    python generator/database_generator.py validate
    python generator/database_generator.py stats
"""

from __future__ import annotations

import argparse
from difflib import SequenceMatcher
import hashlib
import json
import math
import os
import re
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Sequence

import requests

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "generator" / "config.json"

MUSICBRAINZ_ROOT = "https://musicbrainz.org/ws/2"
LASTFM_ROOT = "https://ws.audioscrobbler.com/2.0/"
VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377"
BUILD_CHECKPOINT_VERSION = 1
CONSTANT_GROW_CHECKPOINT_VERSION = 1
BUILD_TOTAL_KEYS = (
    "candidateRecordings",
    "importedRecordings",
    "alreadyPresentRecordings",
    "skippedSatisfiedArtists",
    "skippedNonCollaborations",
    "failedRecordings",
)
CONSTANT_GROW_TOTAL_KEYS = (
    "artistsVisited",
    "trackCandidatesExamined",
    "tracksImported",
    "tracksExisting",
    "tracksRejected",
    "tracksUnresolved",
    "trackFailures",
    "fillArtistsAttempted",
    "fillImportedRecordings",
    "exports",
)
UUID_RE = re.compile(
    r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b"
)
ARTIST_TRACK_TERMINAL_STATUSES = frozenset(
    {"existing", "imported", "solo", "wrong_artist", "unresolved"}
)


class GeneratorError(RuntimeError):
    """A user-facing generator failure."""


class ApiError(GeneratorError):
    """An HTTP/API failure."""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class Settings:
    app_name: str
    app_version: str
    contact: str
    database_path: Path
    cache_path: Path
    output_path: Path
    reports_path: Path
    request_file: Path
    top_artists: int
    songs_per_artist: int
    pretty_json: bool
    musicbrainz_min_interval_seconds: float
    minimum_artist_match_score: int
    include_orphan_artists_in_export: bool

    @property
    def user_agent(self) -> str:
        return f"{self.app_name}/{self.app_version} ({self.contact})"


@dataclass(frozen=True)
class ArtistCredit:
    mbid: str
    name: str


@dataclass(frozen=True)
class BuildSummary:
    seed_artists: int
    candidate_recordings: int
    imported_recordings: int
    already_present_recordings: int
    skipped_satisfied_artists: int
    skipped_non_collaborations: int
    failed_recordings: int


@dataclass
class BuildState:
    top_artist_count: int
    songs_per_artist: int
    refresh_existing: bool
    pretty_json: bool
    seeds: list[ArtistCredit] = field(default_factory=list)
    next_artist_index: int = 0
    totals: dict[str, int] = field(
        default_factory=lambda: {key: 0 for key in BUILD_TOTAL_KEYS}
    )
    failures: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class ConstantGrowState:
    cohort_size: int
    coverage_target: float
    minimum_song_count: int
    ignore_zero_songs: bool
    fill_batch_size: int
    export_every_recordings: int
    export_every_minutes: float
    idle_seconds: float
    pretty_json: bool
    songs_per_artist: int | None = None
    seeds: list[ArtistCredit] = field(default_factory=list)
    next_artist_index: int = 0
    chart_total: int | None = None
    stages_completed: int = 0
    maintenance_cycles: int = 0
    recordings_since_export: int = 0
    last_export_at: str | None = None
    totals: dict[str, int] = field(
        default_factory=lambda: {key: 0 for key in CONSTANT_GROW_TOTAL_KEYS}
    )
    failures: list[dict[str, Any]] = field(default_factory=list)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def atomic_write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(value, encoding="utf-8")
    temp_path.replace(path)


def write_json(path: Path, payload: Any, pretty: bool) -> None:
    if pretty:
        text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    else:
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    atomic_write_text(path, text)


def build_checkpoint_path(settings: Settings) -> Path:
    return settings.reports_path / "build_checkpoint.json"


def constant_grow_checkpoint_path(settings: Settings) -> Path:
    return settings.reports_path / "constant_grow_checkpoint.json"


def write_build_checkpoint(path: Path, state: BuildState, *, status: str) -> None:
    write_json(
        path,
        {
            "version": BUILD_CHECKPOINT_VERSION,
            "status": status,
            "savedAt": utc_now(),
            "topArtists": state.top_artist_count,
            "songsPerArtist": state.songs_per_artist,
            "refreshExisting": state.refresh_existing,
            "pretty": state.pretty_json,
            "nextArtistIndex": state.next_artist_index,
            "seedArtists": [
                {"mbid": artist.mbid, "name": artist.name} for artist in state.seeds
            ],
            "totals": state.totals,
            "failures": state.failures,
        },
        pretty=True,
    )


def read_build_checkpoint(path: Path) -> BuildState:
    payload = read_json(path)
    if not isinstance(payload, dict):
        raise GeneratorError(f"Build checkpoint must contain a JSON object: {path}")
    if payload.get("version") != BUILD_CHECKPOINT_VERSION:
        raise GeneratorError(
            f"Unsupported build checkpoint version in {path}: {payload.get('version')!r}"
        )

    raw_seeds = payload.get("seedArtists") or []
    if not isinstance(raw_seeds, list):
        raise GeneratorError(f"Build checkpoint has an invalid seedArtists list: {path}")
    seeds: list[ArtistCredit] = []
    for item in raw_seeds:
        if not isinstance(item, dict):
            raise GeneratorError(f"Build checkpoint has an invalid seed artist: {path}")
        mbid = extract_mbid(str(item.get("mbid") or ""), "artist")
        name = str(item.get("name") or "").strip()
        if not name:
            raise GeneratorError(f"Build checkpoint seed artist has no name: {path}")
        seeds.append(ArtistCredit(mbid=mbid, name=name))

    try:
        next_artist_index = int(payload.get("nextArtistIndex") or 0)
    except (TypeError, ValueError) as exc:
        raise GeneratorError(f"Build checkpoint has an invalid artist index: {path}") from exc
    if next_artist_index < 0 or next_artist_index > len(seeds):
        raise GeneratorError(f"Build checkpoint artist index is out of range: {path}")

    raw_totals = payload.get("totals") or {}
    if not isinstance(raw_totals, dict):
        raise GeneratorError(f"Build checkpoint has invalid totals: {path}")
    totals: dict[str, int] = {}
    for key in BUILD_TOTAL_KEYS:
        try:
            totals[key] = max(0, int(raw_totals.get(key) or 0))
        except (TypeError, ValueError) as exc:
            raise GeneratorError(
                f"Build checkpoint has an invalid total for {key}: {path}"
            ) from exc

    raw_failures = payload.get("failures") or []
    if not isinstance(raw_failures, list) or not all(
        isinstance(item, dict) for item in raw_failures
    ):
        raise GeneratorError(f"Build checkpoint has invalid failures: {path}")

    return BuildState(
        top_artist_count=require_positive_int(payload.get("topArtists"), "topArtists"),
        songs_per_artist=require_positive_int(
            payload.get("songsPerArtist"), "songsPerArtist"
        ),
        refresh_existing=bool(payload.get("refreshExisting", False)),
        pretty_json=bool(payload.get("pretty", False)),
        seeds=seeds,
        next_artist_index=next_artist_index,
        totals=totals,
        failures=list(raw_failures),
    )


def write_constant_grow_checkpoint(
    path: Path,
    state: ConstantGrowState,
    *,
    status: str,
) -> None:
    write_json(
        path,
        {
            "version": CONSTANT_GROW_CHECKPOINT_VERSION,
            "status": status,
            "savedAt": utc_now(),
            "cohortSize": state.cohort_size,
            "growthMode": (
                "songs" if state.songs_per_artist is not None else "coverage"
            ),
            "coverageTarget": state.coverage_target,
            "songsPerArtist": state.songs_per_artist,
            "minimumSongs": state.minimum_song_count,
            "ignoreZeroSongs": state.ignore_zero_songs,
            "fillBatchSize": state.fill_batch_size,
            "exportEveryRecordings": state.export_every_recordings,
            "exportEveryMinutes": state.export_every_minutes,
            "idleSeconds": state.idle_seconds,
            "pretty": state.pretty_json,
            "seedArtists": [
                {"mbid": artist.mbid, "name": artist.name} for artist in state.seeds
            ],
            "nextArtistIndex": state.next_artist_index,
            "chartTotal": state.chart_total,
            "stagesCompleted": state.stages_completed,
            "maintenanceCycles": state.maintenance_cycles,
            "recordingsSinceExport": state.recordings_since_export,
            "lastExportAt": state.last_export_at,
            "totals": state.totals,
            "failures": state.failures,
        },
        pretty=True,
    )


def read_constant_grow_checkpoint(path: Path) -> ConstantGrowState:
    payload = read_json(path)
    if not isinstance(payload, dict):
        raise GeneratorError(f"Constant-grow checkpoint must be an object: {path}")
    if payload.get("version") != CONSTANT_GROW_CHECKPOINT_VERSION:
        raise GeneratorError(
            f"Unsupported constant-grow checkpoint version in {path}: "
            f"{payload.get('version')!r}"
        )

    raw_seeds = payload.get("seedArtists") or []
    if not isinstance(raw_seeds, list):
        raise GeneratorError(f"Constant-grow checkpoint has invalid seedArtists: {path}")
    seeds: list[ArtistCredit] = []
    for item in raw_seeds:
        if not isinstance(item, dict):
            raise GeneratorError(f"Constant-grow checkpoint has an invalid seed: {path}")
        seeds.append(
            ArtistCredit(
                mbid=extract_mbid(str(item.get("mbid") or ""), "artist"),
                name=str(item.get("name") or "").strip(),
            )
        )
    if any(not artist.name for artist in seeds):
        raise GeneratorError(f"Constant-grow checkpoint has a seed without a name: {path}")

    next_artist_index = max(0, int(payload.get("nextArtistIndex") or 0))
    if next_artist_index > len(seeds):
        raise GeneratorError(f"Constant-grow checkpoint artist index is invalid: {path}")
    raw_totals = payload.get("totals") or {}
    if not isinstance(raw_totals, dict):
        raise GeneratorError(f"Constant-grow checkpoint has invalid totals: {path}")
    totals = {
        key: max(0, int(raw_totals.get(key) or 0))
        for key in CONSTANT_GROW_TOTAL_KEYS
    }
    raw_failures = payload.get("failures") or []
    if not isinstance(raw_failures, list) or not all(
        isinstance(item, dict) for item in raw_failures
    ):
        raise GeneratorError(f"Constant-grow checkpoint has invalid failures: {path}")

    return ConstantGrowState(
        cohort_size=require_positive_int(payload.get("cohortSize"), "cohortSize"),
        coverage_target=require_coverage(
            payload.get("coverageTarget"), "coverageTarget"
        ),
        minimum_song_count=require_positive_int(
            payload.get("minimumSongs"), "minimumSongs"
        ),
        ignore_zero_songs=bool(payload.get("ignoreZeroSongs", False)),
        fill_batch_size=require_positive_int(
            payload.get("fillBatchSize"), "fillBatchSize"
        ),
        export_every_recordings=require_positive_int(
            payload.get("exportEveryRecordings"), "exportEveryRecordings"
        ),
        export_every_minutes=require_nonnegative_float(
            payload.get("exportEveryMinutes"), "exportEveryMinutes"
        ),
        idle_seconds=require_nonnegative_float(
            payload.get("idleSeconds"), "idleSeconds"
        ),
        pretty_json=bool(payload.get("pretty", False)),
        songs_per_artist=(
            require_positive_int(payload.get("songsPerArtist"), "songsPerArtist")
            if payload.get("songsPerArtist") is not None
            else None
        ),
        seeds=seeds,
        next_artist_index=next_artist_index,
        chart_total=(
            max(0, int(payload["chartTotal"]))
            if payload.get("chartTotal") is not None
            else None
        ),
        stages_completed=max(0, int(payload.get("stagesCompleted") or 0)),
        maintenance_cycles=max(0, int(payload.get("maintenanceCycles") or 0)),
        recordings_since_export=max(
            0, int(payload.get("recordingsSinceExport") or 0)
        ),
        last_export_at=(
            str(payload.get("lastExportAt"))
            if payload.get("lastExportAt")
            else None
        ),
        totals=totals,
        failures=list(raw_failures),
    )


def write_failed_requests(
    path: Path,
    failures: Sequence[dict[str, Any]],
    *,
    command: str,
    source: str | None = None,
) -> None:
    """Write a retry-compatible request file with failure diagnostics."""
    artists = [failure for failure in failures if failure.get("type") == "artist"]
    songs = [failure for failure in failures if failure.get("type") == "recording"]
    payload: dict[str, Any] = {
        "generatedAt": utc_now(),
        "command": command,
        "artists": artists,
        "songs": songs,
    }
    if source is not None:
        payload["source"] = source
    write_json(path, payload, pretty=True)


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise GeneratorError(f"File not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise GeneratorError(f"Invalid JSON in {path}: {exc}") from exc


def resolve_project_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else PROJECT_ROOT / path


def require_positive_int(value: Any, field_name: str) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise GeneratorError(f"{field_name} must be an integer") from exc
    if number < 1:
        raise GeneratorError(f"{field_name} must be at least 1")
    return number


def require_nonnegative_float(value: Any, field_name: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise GeneratorError(f"{field_name} must be a number") from exc
    if not math.isfinite(number) or number < 0:
        raise GeneratorError(f"{field_name} must be zero or greater")
    return number


def require_coverage(value: Any, field_name: str = "coverage") -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise GeneratorError(f"{field_name} must be a number") from exc
    if number > 1 and number <= 100:
        number /= 100
    if not math.isfinite(number) or number <= 0 or number > 1:
        raise GeneratorError(f"{field_name} must be between 0 and 1 (or 1 and 100)")
    return number


def _nonnegative_int(value: Any, default: int = 0) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return max(0, default)


def load_settings(config_path: Path) -> Settings:
    raw = read_json(config_path)
    if not isinstance(raw, dict):
        raise GeneratorError("config.json must contain a JSON object")

    contact = str(os.environ.get("MUSIC_GRAPH_CONTACT") or raw.get("contact") or "").strip()
    if not contact or contact.upper() == "REPLACE_ME":
        raise GeneratorError(
            "Set 'contact' in generator/config.json or the MUSIC_GRAPH_CONTACT environment variable "
            "to a real email address or website for the MusicBrainz User-Agent."
        )

    return Settings(
        app_name=str(raw.get("app_name") or "ArtistRouteDatabaseBuilder"),
        app_version=str(raw.get("app_version") or "1.0.0"),
        contact=contact,
        database_path=resolve_project_path(raw.get("database_path") or "generator/music_graph.db"),
        cache_path=resolve_project_path(raw.get("cache_path") or "generator/cache"),
        output_path=resolve_project_path(raw.get("output_path") or "output"),
        reports_path=resolve_project_path(raw.get("reports_path") or "generator/reports"),
        request_file=resolve_project_path(raw.get("request_file") or "generator/requests.json"),
        top_artists=require_positive_int(raw.get("top_artists", 100), "top_artists"),
        songs_per_artist=require_positive_int(raw.get("songs_per_artist", 100), "songs_per_artist"),
        pretty_json=bool(raw.get("pretty_json", False)),
        musicbrainz_min_interval_seconds=max(
            float(raw.get("musicbrainz_min_interval_seconds", 1.1)), 1.0
        ),
        minimum_artist_match_score=max(
            0, min(100, int(raw.get("minimum_artist_match_score", 90)))
        ),
        include_orphan_artists_in_export=bool(
            raw.get("include_orphan_artists_in_export", False)
        ),
    )


def extract_mbid(value: str, entity_name: str) -> str:
    match = UUID_RE.search(value.strip())
    if not match:
        raise GeneratorError(
            f"Could not find a valid MusicBrainz {entity_name} MBID in: {value!r}"
        )
    return match.group(0).lower()


class JsonCache:
    MAX_KEY_FILENAME_LENGTH = 96

    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, namespace: str, key: str) -> Path:
        safe_key = "".join(
            char if char.isalnum() or char in "-_." else "_" for char in key
        ).strip(". ")
        if not safe_key:
            safe_key = "empty"
        if len(safe_key) > self.MAX_KEY_FILENAME_LENGTH:
            digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]
            prefix_length = self.MAX_KEY_FILENAME_LENGTH - len(digest) - 2
            prefix = safe_key[:prefix_length].rstrip(". _-") or "key"
            safe_key = f"{prefix}--{digest}"
        path = self.root / namespace / f"{safe_key}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def read(self, namespace: str, key: str) -> Any | None:
        path = self._path(namespace, key)
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def write(self, namespace: str, key: str, value: Any) -> None:
        write_json(self._path(namespace, key), value, pretty=False)


class ApiClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.cache = JsonCache(settings.cache_path)
        self.lastfm_api_key = os.environ.get("LASTFM_API_KEY")
        if not self.lastfm_api_key:
            raise GeneratorError(
                "LASTFM_API_KEY is missing. Set it before running the generator."
            )
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": settings.user_agent,
                "Accept": "application/json",
            }
        )
        self._last_musicbrainz_request = 0.0

    def close(self) -> None:
        self.session.close()

    def _wait_for_musicbrainz(self) -> None:
        elapsed = time.monotonic() - self._last_musicbrainz_request
        remaining = self.settings.musicbrainz_min_interval_seconds - elapsed
        if remaining > 0:
            time.sleep(remaining)

    def _request_json(
        self,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        musicbrainz: bool = False,
        attempts: int = 5,
    ) -> Any:
        for attempt in range(1, attempts + 1):
            if musicbrainz:
                self._wait_for_musicbrainz()

            try:
                response = self.session.get(url, params=params, timeout=45)
            except requests.RequestException as exc:
                if attempt == attempts:
                    raise ApiError(f"Request failed for {url}: {exc}") from exc
                time.sleep(min(2**attempt, 30))
                continue
            finally:
                if musicbrainz:
                    self._last_musicbrainz_request = time.monotonic()

            if response.status_code == 204:
                return None

            if response.status_code == 429 or 500 <= response.status_code < 600:
                if attempt == attempts:
                    raise ApiError(
                        f"HTTP {response.status_code} from {response.url}: {response.text[:300]}",
                        status_code=response.status_code,
                    )
                retry_header = (
                    response.headers.get("Retry-After")
                    or response.headers.get("X-RateLimit-Reset-In")
                )
                try:
                    delay = float(retry_header) if retry_header else float(min(2**attempt, 30))
                except ValueError:
                    delay = float(min(2**attempt, 30))
                delay = max(delay, 1.0)
                print(
                    f"HTTP {response.status_code} from {response.url}; "
                    f"retrying in {delay:g} seconds ({attempt}/{attempts})...",
                    file=sys.stderr,
                )
                time.sleep(delay)
                continue

            if not response.ok:
                raise ApiError(
                    f"HTTP {response.status_code} from {response.url}: {response.text[:500]}",
                    status_code=response.status_code,
                )

            try:
                return response.json()
            except ValueError as exc:
                raise ApiError(f"Invalid JSON returned by {response.url}") from exc

        raise AssertionError("unreachable")

    def get_sitewide_top_artists_snapshot(
        self,
        count: int,
        *,
        refresh: bool = False,
    ) -> dict[str, Any]:
        key = f"count={count}"
        if not refresh:
            cached = self.cache.read("lastfm_top_artists_snapshot", key)
            if isinstance(cached, dict) and isinstance(cached.get("artists"), list):
                return cached

        page_limit = min(max(count, 1), 1000)
        page = 1
        total_pages = 1
        reported_total = 0
        artists: list[dict[str, Any]] = []
        while len(artists) < count and page <= total_pages:
            payload = self._request_json(
                LASTFM_ROOT,
                params={
                    "method": "chart.gettopartists",
                    "api_key": self.lastfm_api_key,
                    "format": "json",
                    "limit": page_limit,
                    "page": page,
                },
            )
            container = (payload or {}).get("artists", {})
            if not isinstance(container, dict):
                raise ApiError("Last.fm top-artists response had an unexpected format")
            page_artists = container.get("artist", [])
            if not isinstance(page_artists, list):
                raise ApiError("Last.fm top-artists response had an unexpected format")
            attrs = container.get("@attr") or {}
            if not isinstance(attrs, dict):
                attrs = {}
            if page == 1:
                reported_total = _nonnegative_int(attrs.get("total"), len(page_artists))
                total_pages = max(
                    1, _nonnegative_int(attrs.get("totalPages"), 1)
                )
            artists.extend(item for item in page_artists if isinstance(item, dict))
            if not page_artists:
                break
            page += 1

        result = {
            "artists": artists[:count],
            "total": max(reported_total, len(artists)),
            "pagesFetched": max(0, page - 1),
        }
        self.cache.write("lastfm_top_artists_snapshot", key, result)
        return result

    def get_sitewide_top_artists(self, count: int) -> list[dict[str, Any]]:
        snapshot = self.get_sitewide_top_artists_snapshot(count)
        return list(snapshot["artists"])

    def get_top_tracks_page_for_artist(
        self,
        artist_name: str,
        artist_mbid: str,
        *,
        page: int = 1,
        limit: int = 100,
        refresh: bool = False,
    ) -> dict[str, Any]:
        key = f"{artist_mbid}|page={page}|limit={limit}"
        if not refresh:
            cached = self.cache.read("lastfm_artist_track_pages", key)
            if isinstance(cached, dict) and isinstance(cached.get("tracks"), list):
                return cached

        payload = self._request_json(
            LASTFM_ROOT,
            params={
                "method": "artist.gettoptracks",
                "artist": artist_name,
                "mbid": artist_mbid,
                "api_key": self.lastfm_api_key,
                "format": "json",
                "limit": min(max(limit, 1), 1000),
                "page": max(page, 1),
                "autocorrect": 1,
            },
        )
        container = (payload or {}).get("toptracks", {})
        if not isinstance(container, dict):
            raise ApiError("Last.fm top-tracks response had an unexpected format")
        tracks = container.get("track", [])
        if not isinstance(tracks, list):
            raise ApiError("Last.fm top-tracks response had an unexpected format")
        attrs = container.get("@attr") or {}
        if not isinstance(attrs, dict):
            attrs = {}
        result = {
            "tracks": [item for item in tracks if isinstance(item, dict)],
            "page": max(1, _nonnegative_int(attrs.get("page"), page)),
            "perPage": max(1, _nonnegative_int(attrs.get("perPage"), limit)),
            "totalPages": max(
                1, _nonnegative_int(attrs.get("totalPages"), 1)
            ),
            "total": max(0, _nonnegative_int(attrs.get("total"), len(tracks))),
        }
        self.cache.write("lastfm_artist_track_pages", key, result)
        return result

    def get_top_tracks_for_artist(
        self,
        artist_name: str,
        artist_mbid: str,
        limit: int,
        *,
        refresh: bool = False,
    ) -> list[dict[str, Any]]:
        key = f"{artist_mbid}|{limit}"
        if not refresh:
            cached = self.cache.read("lastfm_artist_tracks", key)
            if cached is not None:
                return cached

        payload = self._request_json(
            LASTFM_ROOT,
            params={
                "method": "artist.gettoptracks",
                "artist": artist_name,
                "mbid": artist_mbid,
                "api_key": self.lastfm_api_key,
                "format": "json",
                "limit": limit,
                "page": 1,
                "autocorrect": 1,
            },
        )
        tracks = (payload or {}).get("toptracks", {}).get("track", [])
        if not isinstance(tracks, list):
            raise ApiError("Last.fm top-tracks response had an unexpected format")
        self.cache.write("lastfm_artist_tracks", key, tracks)
        return tracks

    def search_artist(self, name: str, limit: int = 10) -> list[dict[str, Any]]:
        key = f"{name}|{limit}"
        cached = self.cache.read("musicbrainz_artist_search", key)
        if cached is not None:
            return cached

        payload = self._request_json(
            f"{MUSICBRAINZ_ROOT}/artist",
            params={"query": f'artist:"{name}"', "fmt": "json", "limit": limit},
            musicbrainz=True,
        )
        artists = (payload or {}).get("artists") or []
        if not isinstance(artists, list):
            raise ApiError("MusicBrainz artist search response had an unexpected format")
        self.cache.write("musicbrainz_artist_search", key, artists)
        return artists

    def search_recording(
        self,
        title: str,
        artist_mbid: str,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        key = f"{artist_mbid}|{title}|{limit}"
        cached = self.cache.read("musicbrainz_recording_search", key)
        if cached is not None:
            return cached

        escaped_title = title.replace('"', '\\"')
        payload = self._request_json(
            f"{MUSICBRAINZ_ROOT}/recording",
            params={
                "query": f'recording:"{escaped_title}" AND arid:{artist_mbid}',
                "fmt": "json",
                "limit": limit,
            },
            musicbrainz=True,
        )
        recordings = (payload or {}).get("recordings", [])
        if not isinstance(recordings, list):
            raise ApiError(
                "MusicBrainz recording search returned an unexpected format"
            )
        self.cache.write("musicbrainz_recording_search", key, recordings)
        return recordings

    def get_artist(self, artist_mbid: str) -> dict[str, Any]:
        cached = self.cache.read("musicbrainz_artist", artist_mbid)
        if cached is not None:
            return cached

        payload = self._request_json(
            f"{MUSICBRAINZ_ROOT}/artist/{artist_mbid}",
            params={"fmt": "json"},
            musicbrainz=True,
        )
        if not isinstance(payload, dict):
            raise ApiError(f"MusicBrainz artist {artist_mbid} returned no object")
        self.cache.write("musicbrainz_artist", artist_mbid, payload)
        return payload

    def get_recording(self, recording_mbid: str) -> dict[str, Any]:
        cached = self.cache.read("musicbrainz_recording", recording_mbid)
        if cached is not None:
            return cached

        payload = self._request_json(
            f"{MUSICBRAINZ_ROOT}/recording/{recording_mbid}",
            params={"inc": "artist-credits", "fmt": "json"},
            musicbrainz=True,
        )
        if not isinstance(payload, dict):
            raise ApiError(f"MusicBrainz recording {recording_mbid} returned no object")
        self.cache.write("musicbrainz_recording", recording_mbid, payload)
        return payload


class GraphDatabase:
    SCHEMA_VERSION = 3

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.connection = sqlite3.connect(path)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys = ON")
        self.connection.execute("PRAGMA journal_mode = WAL")
        self._initialize_schema()

    def _initialize_schema(self) -> None:
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS artists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mbid TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS songs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mbid TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS song_recordings (
                recording_mbid TEXT PRIMARY KEY,
                song_id INTEGER NOT NULL,
                is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0, 1)),
                FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS song_artists (
                song_id INTEGER NOT NULL,
                artist_id INTEGER NOT NULL,
                credit_order INTEGER NOT NULL,
                PRIMARY KEY (song_id, artist_id),
                FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
                FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS import_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                import_type TEXT NOT NULL,
                source_identifier TEXT NOT NULL,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                status TEXT NOT NULL,
                details TEXT
            );

            CREATE TABLE IF NOT EXISTS artist_track_checks (
                artist_mbid TEXT NOT NULL,
                track_key TEXT NOT NULL,
                track_name TEXT NOT NULL,
                lastfm_url TEXT,
                recording_mbid TEXT,
                status TEXT NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 1,
                last_error TEXT,
                processed_at TEXT NOT NULL,
                PRIMARY KEY (artist_mbid, track_key)
            );

            CREATE INDEX IF NOT EXISTS idx_song_artists_artist
                ON song_artists(artist_id, song_id);
            CREATE INDEX IF NOT EXISTS idx_song_artists_song
                ON song_artists(song_id, credit_order);
            CREATE INDEX IF NOT EXISTS idx_song_recordings_song
                ON song_recordings(song_id);
            CREATE INDEX IF NOT EXISTS idx_artists_name
                ON artists(name COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS idx_songs_name
                ON songs(name COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS idx_artist_track_checks_status
                ON artist_track_checks(artist_mbid, status);
            """
        )
        self.connection.execute(
            """
            INSERT OR IGNORE INTO song_recordings(recording_mbid, song_id, is_primary)
            SELECT mbid, id, 1 FROM songs
            """
        )
        self.connection.execute(
            """
            INSERT INTO metadata(key, value) VALUES ('schema_version', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (str(self.SCHEMA_VERSION),),
        )
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()

    def begin_import(self, import_type: str, source_identifier: str) -> int:
        cursor = self.connection.execute(
            """
            INSERT INTO import_history(
                import_type, source_identifier, started_at, status
            ) VALUES (?, ?, ?, 'running')
            """,
            (import_type, source_identifier, utc_now()),
        )
        self.connection.commit()
        return int(cursor.lastrowid)

    def finish_import(self, import_id: int, status: str, details: dict[str, Any]) -> None:
        self.connection.execute(
            """
            UPDATE import_history
            SET finished_at = ?, status = ?, details = ?
            WHERE id = ?
            """,
            (utc_now(), status, json.dumps(details, ensure_ascii=False), import_id),
        )
        self.connection.commit()

    def upsert_artist(self, mbid: str, name: str) -> int:
        clean_name = name.strip()
        row = self.connection.execute(
            "SELECT id, name FROM artists WHERE mbid = ?", (mbid,)
        ).fetchone()
        if row is not None:
            if row["name"] != clean_name:
                self.connection.execute(
                    "UPDATE artists SET name = ?, updated_at = ? WHERE id = ?",
                    (clean_name, utc_now(), int(row["id"])),
                )
            return int(row["id"])

        now = utc_now()
        cursor = self.connection.execute(
            """
            INSERT INTO artists(mbid, name, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (mbid, clean_name, now, now),
        )
        return int(cursor.lastrowid)

    def upsert_song(self, mbid: str, name: str) -> int:
        clean_name = strip_bracketed_title_content(name) or name.strip()
        row = self.connection.execute(
            """
            SELECT s.id, s.mbid, s.name
            FROM song_recordings sr
            JOIN songs s ON s.id = sr.song_id
            WHERE sr.recording_mbid = ?
            """,
            (mbid,),
        ).fetchone()
        if row is not None:
            if row["mbid"] == mbid and row["name"] != clean_name:
                self.connection.execute(
                    "UPDATE songs SET name = ?, updated_at = ? WHERE id = ?",
                    (clean_name, utc_now(), int(row["id"])),
                )
            return int(row["id"])

        now = utc_now()
        cursor = self.connection.execute(
            """
            INSERT INTO songs(mbid, name, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (mbid, clean_name, now, now),
        )
        song_id = int(cursor.lastrowid)
        self.connection.execute(
            """
            INSERT INTO song_recordings(recording_mbid, song_id, is_primary)
            VALUES (?, ?, 1)
            """,
            (mbid, song_id),
        )
        return song_id

    def clean_song_titles(self) -> list[dict[str, Any]]:
        updates: list[dict[str, Any]] = []
        for row in self.connection.execute(
            "SELECT id, name FROM songs ORDER BY id"
        ).fetchall():
            old_name = str(row["name"])
            clean_name = strip_bracketed_title_content(old_name)
            if not clean_name or clean_name == old_name:
                continue
            song_id = int(row["id"])
            self.connection.execute(
                "UPDATE songs SET name = ?, updated_at = ? WHERE id = ?",
                (clean_name, utc_now(), song_id),
            )
            updates.append(
                {
                    "songId": song_id,
                    "oldName": old_name,
                    "newName": clean_name,
                }
            )
        return updates

    def replace_song_artists(self, song_id: int, artist_ids: Sequence[int]) -> None:
        self.connection.execute("DELETE FROM song_artists WHERE song_id = ?", (song_id,))
        self.connection.executemany(
            """
            INSERT INTO song_artists(song_id, artist_id, credit_order)
            VALUES (?, ?, ?)
            """,
            [(song_id, artist_id, order) for order, artist_id in enumerate(artist_ids)],
        )

    def add_song_artists(self, song_id: int, artist_ids: Sequence[int]) -> None:
        merged_artist_ids = self._song_artist_ids(song_id)
        seen_artist_ids = set(merged_artist_ids)
        for artist_id in artist_ids:
            if artist_id not in seen_artist_ids:
                seen_artist_ids.add(artist_id)
                merged_artist_ids.append(artist_id)
        self.replace_song_artists(song_id, merged_artist_ids)

    def commit(self) -> None:
        self.connection.commit()

    def _song_artist_ids(self, song_id: int) -> list[int]:
        return [
            int(row["artist_id"])
            for row in self.connection.execute(
                """
                SELECT artist_id
                FROM song_artists
                WHERE song_id = ?
                ORDER BY credit_order
                """,
                (song_id,),
            )
        ]

    def _merge_song_ids(
        self,
        canonical_song_id: int,
        duplicate_song_ids: Sequence[int],
    ) -> dict[str, Any]:
        canonical = self.connection.execute(
            "SELECT id, mbid, name FROM songs WHERE id = ?", (canonical_song_id,)
        ).fetchone()
        if canonical is None:
            raise GeneratorError(f"Canonical song {canonical_song_id} does not exist")

        merged_artist_ids = self._song_artist_ids(canonical_song_id)
        seen_artist_ids = set(merged_artist_ids)
        removed_song_ids: list[int] = []
        recording_mbids = [
            str(row["recording_mbid"])
            for row in self.connection.execute(
                """
                SELECT recording_mbid
                FROM song_recordings
                WHERE song_id = ?
                ORDER BY is_primary DESC, recording_mbid
                """,
                (canonical_song_id,),
            )
        ]

        for duplicate_song_id in duplicate_song_ids:
            if duplicate_song_id == canonical_song_id:
                continue
            duplicate = self.connection.execute(
                "SELECT id, mbid FROM songs WHERE id = ?", (duplicate_song_id,)
            ).fetchone()
            if duplicate is None:
                continue
            for artist_id in self._song_artist_ids(duplicate_song_id):
                if artist_id not in seen_artist_ids:
                    seen_artist_ids.add(artist_id)
                    merged_artist_ids.append(artist_id)
            recording_mbids.extend(
                str(row["recording_mbid"])
                for row in self.connection.execute(
                    """
                    SELECT recording_mbid
                    FROM song_recordings
                    WHERE song_id = ?
                    ORDER BY is_primary DESC, recording_mbid
                    """,
                    (duplicate_song_id,),
                )
            )
            self.connection.execute(
                """
                UPDATE song_recordings
                SET song_id = ?, is_primary = 0
                WHERE song_id = ?
                """,
                (canonical_song_id, duplicate_song_id),
            )
            self.connection.execute("DELETE FROM songs WHERE id = ?", (duplicate_song_id,))
            removed_song_ids.append(duplicate_song_id)

        self.replace_song_artists(canonical_song_id, merged_artist_ids)
        self.connection.execute(
            """
            UPDATE song_recordings
            SET is_primary = CASE WHEN recording_mbid = ? THEN 1 ELSE 0 END
            WHERE song_id = ?
            """,
            (str(canonical["mbid"]), canonical_song_id),
        )
        return {
            "canonicalSongId": canonical_song_id,
            "songName": str(canonical["name"]),
            "removedSongIds": removed_song_ids,
            "artistIds": merged_artist_ids,
            "recordingMbids": list(dict.fromkeys(recording_mbids)),
        }

    def find_duplicate_song_groups(self) -> list[dict[str, Any]]:
        rows = list(
            self.connection.execute(
                """
                SELECT s.id, s.mbid, s.name
                FROM songs s
                ORDER BY s.id
                """
            )
        )
        songs: list[dict[str, Any]] = []
        for row in rows:
            normalized_name = normalize_title(str(row["name"]))
            comparison_name = normalize_title_version(str(row["name"]))
            artist_ids = self._song_artist_ids(int(row["id"]))
            if not normalized_name or not comparison_name or not artist_ids:
                continue
            songs.append(
                {
                    "id": int(row["id"]),
                    "mbid": str(row["mbid"]),
                    "name": str(row["name"]),
                    "artistIds": artist_ids,
                    "normalizedName": normalized_name,
                    "comparisonName": comparison_name,
                }
            )

        parents = {int(song["id"]): int(song["id"]) for song in songs}

        def find(song_id: int) -> int:
            while parents[song_id] != song_id:
                parents[song_id] = parents[parents[song_id]]
                song_id = parents[song_id]
            return song_id

        def union(left_song_id: int, right_song_id: int) -> None:
            left_root = find(left_song_id)
            right_root = find(right_song_id)
            if left_root == right_root:
                return
            parents[max(left_root, right_root)] = min(left_root, right_root)

        grouped_by_title: dict[str, list[dict[str, Any]]] = {}
        grouped_by_comparison_title: dict[str, list[dict[str, Any]]] = {}
        grouped_by_artists: dict[frozenset[int], list[dict[str, Any]]] = {}
        for song in songs:
            grouped_by_title.setdefault(str(song["normalizedName"]), []).append(song)
            grouped_by_comparison_title.setdefault(
                str(song["comparisonName"]), []
            ).append(song)
            grouped_by_artists.setdefault(frozenset(song["artistIds"]), []).append(song)

        # Exact normalized titles are duplicates when any credited artist overlaps.
        # Connected components retain the existing behavior of unioning credits from
        # differently credited versions of the same recording.
        for title_matches in grouped_by_title.values():
            for index, song in enumerate(title_matches):
                artist_ids = set(song["artistIds"])
                for candidate in title_matches[index + 1 :]:
                    if artist_ids.intersection(candidate["artistIds"]):
                        union(int(song["id"]), int(candidate["id"]))

        # Bracketed content and recognized version/source suffixes do not form
        # part of the comparison title. As with exact normalized titles, a
        # shared credited artist is required to avoid merging unrelated songs.
        for title_matches in grouped_by_comparison_title.values():
            for index, song in enumerate(title_matches):
                artist_ids = set(song["artistIds"])
                for candidate in title_matches[index + 1 :]:
                    if artist_ids.intersection(candidate["artistIds"]):
                        union(int(song["id"]), int(candidate["id"]))

        # Fuzzy title matching is deliberately stricter: the complete artist sets
        # must be identical before version suffixes or small spelling differences
        # are considered. This avoids merging similarly named songs by one artist.
        for artist_matches in grouped_by_artists.values():
            for index, song in enumerate(artist_matches):
                for candidate in artist_matches[index + 1 :]:
                    if titles_are_very_similar(
                        str(song["name"]), str(candidate["name"])
                    ):
                        union(int(song["id"]), int(candidate["id"]))

        components: dict[int, list[dict[str, Any]]] = {}
        for song in songs:
            components.setdefault(find(int(song["id"])), []).append(song)

        duplicate_groups: list[dict[str, Any]] = []
        for component in components.values():
            if len(component) < 2:
                continue
            component.sort(key=lambda song: int(song["id"]))
            shared_artist_ids = set(component[0]["artistIds"])
            for song in component[1:]:
                shared_artist_ids.intersection_update(song["artistIds"])
            normalized_titles = sorted(
                {str(song["normalizedName"]) for song in component}
            )
            comparison_titles = {
                normalize_title_version(str(song["name"])) for song in component
            }
            comparison_titles.discard("")
            duplicate_groups.append(
                {
                    "normalizedTitle": (
                        next(iter(comparison_titles))
                        if len(comparison_titles) == 1
                        else normalized_titles[0]
                    ),
                    "normalizedTitles": normalized_titles,
                    "matchType": (
                        "exactTitle" if len(normalized_titles) == 1 else "similarTitle"
                    ),
                    "sharedArtistIds": sorted(shared_artist_ids),
                    "songs": [
                        {
                            "id": int(song["id"]),
                            "mbid": str(song["mbid"]),
                            "name": str(song["name"]),
                            "artistIds": list(song["artistIds"]),
                        }
                        for song in component
                    ],
                }
            )
        duplicate_groups.sort(key=lambda group: int(group["songs"][0]["id"]))
        return duplicate_groups

    def merge_duplicate_song(self, song_id: int) -> tuple[int, dict[str, Any] | None]:
        for group in self.find_duplicate_song_groups():
            song_ids = [int(song["id"]) for song in group["songs"]]
            if song_id not in song_ids:
                continue
            canonical_song_id = min(song_ids)
            details = self._merge_song_ids(
                canonical_song_id,
                [candidate for candidate in song_ids if candidate != canonical_song_id],
            )
            return canonical_song_id, details
        return song_id, None

    def merge_duplicate_songs(self) -> list[dict[str, Any]]:
        self.clean_song_titles()
        merged: list[dict[str, Any]] = []
        for group in self.find_duplicate_song_groups():
            song_ids = [int(song["id"]) for song in group["songs"]]
            canonical_song_id = min(song_ids)
            merged.append(
                self._merge_song_ids(
                    canonical_song_id,
                    [candidate for candidate in song_ids if candidate != canonical_song_id],
                )
            )
        self.connection.commit()
        return merged

    def has_song(self, recording_mbid: str) -> bool:
        return (
            self.connection.execute(
                "SELECT 1 FROM song_recordings WHERE recording_mbid = ?",
                (recording_mbid,),
            ).fetchone()
            is not None
        )

    def song_contains_artist(self, recording_mbid: str, artist_mbid: str) -> bool:
        return (
            self.connection.execute(
                """
                SELECT 1
                FROM song_recordings sr
                JOIN songs s ON s.id = sr.song_id
                JOIN song_artists sa ON sa.song_id = s.id
                JOIN artists a ON a.id = sa.artist_id
                WHERE sr.recording_mbid = ? AND a.mbid = ?
                LIMIT 1
                """,
                (recording_mbid, artist_mbid),
            ).fetchone()
            is not None
        )

    def count_songs_for_artist(self, artist_mbid: str) -> int:
        return int(
            self.connection.execute(
                """
                SELECT COUNT(DISTINCT sa.song_id)
                FROM artists a
                JOIN song_artists sa ON sa.artist_id = a.id
                WHERE a.mbid = ?
                """,
                (artist_mbid,),
            ).fetchone()[0]
        )

    def get_artist_track_check_statuses(self, artist_mbid: str) -> dict[str, str]:
        return {
            str(row["track_key"]): str(row["status"])
            for row in self.connection.execute(
                """
                SELECT track_key, status
                FROM artist_track_checks
                WHERE artist_mbid = ?
                """,
                (artist_mbid,),
            )
        }

    def record_artist_track_check(
        self,
        artist_mbid: str,
        track_key: str,
        track_name: str,
        *,
        lastfm_url: str | None,
        recording_mbid: str | None,
        status: str,
        error: str | None = None,
    ) -> None:
        self.connection.execute(
            """
            INSERT INTO artist_track_checks(
                artist_mbid,
                track_key,
                track_name,
                lastfm_url,
                recording_mbid,
                status,
                attempt_count,
                last_error,
                processed_at
            ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(artist_mbid, track_key) DO UPDATE SET
                track_name = excluded.track_name,
                lastfm_url = excluded.lastfm_url,
                recording_mbid = excluded.recording_mbid,
                status = excluded.status,
                attempt_count = artist_track_checks.attempt_count + 1,
                last_error = excluded.last_error,
                processed_at = excluded.processed_at
            """,
            (
                artist_mbid,
                track_key,
                track_name,
                lastfm_url,
                recording_mbid,
                status,
                error,
                utc_now(),
            ),
        )
        self.connection.commit()

    def get_artists_below_song_count(
        self,
        minimum_song_count: int,
        *,
        ignore_zero_songs: bool = False,
    ) -> list[dict[str, Any]]:
        minimum_existing_song_count = 1 if ignore_zero_songs else 0
        return [
            {
                "id": int(row["id"]),
                "mbid": str(row["mbid"]),
                "name": str(row["name"]),
                "songCount": int(row["song_count"]),
            }
            for row in self.connection.execute(
                """
                SELECT
                    a.id,
                    a.mbid,
                    a.name,
                    COUNT(DISTINCT sa.song_id) AS song_count
                FROM artists a
                LEFT JOIN song_artists sa ON sa.artist_id = a.id
                GROUP BY a.id, a.mbid, a.name
                HAVING COUNT(DISTINCT sa.song_id) >= ?
                    AND COUNT(DISTINCT sa.song_id) < ?
                ORDER BY song_count, a.id
                """,
                (minimum_existing_song_count, minimum_song_count),
            )
        ]

    def get_stats(self) -> dict[str, int]:
        artist_count = int(self.connection.execute("SELECT COUNT(*) FROM artists").fetchone()[0])
        song_count = int(self.connection.execute("SELECT COUNT(*) FROM songs").fetchone()[0])
        link_count = int(
            self.connection.execute("SELECT COUNT(*) FROM song_artists").fetchone()[0]
        )
        connected_artist_count = int(
            self.connection.execute(
                "SELECT COUNT(DISTINCT artist_id) FROM song_artists"
            ).fetchone()[0]
        )
        return {
            "artists": artist_count,
            "connectedArtists": connected_artist_count,
            "songs": song_count,
            "songArtistLinks": link_count,
        }

    def validate(self) -> tuple[list[str], list[str]]:
        errors: list[str] = []
        warnings: list[str] = []

        integrity = self.connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            errors.append(f"SQLite integrity_check failed: {integrity}")

        foreign_key_errors = list(self.connection.execute("PRAGMA foreign_key_check"))
        if foreign_key_errors:
            errors.append(f"Found {len(foreign_key_errors)} foreign-key violations")

        missing_recording_alias_count = int(
            self.connection.execute(
                """
                SELECT COUNT(*)
                FROM songs s
                LEFT JOIN song_recordings sr
                    ON sr.song_id = s.id
                    AND sr.recording_mbid = s.mbid
                    AND sr.is_primary = 1
                WHERE sr.recording_mbid IS NULL
                """
            ).fetchone()[0]
        )
        if missing_recording_alias_count:
            errors.append(
                f"{missing_recording_alias_count} songs are missing their primary recording alias"
            )

        duplicate_song_groups = self.find_duplicate_song_groups()
        if duplicate_song_groups:
            duplicate_song_count = sum(
                len(group["songs"]) - 1 for group in duplicate_song_groups
            )
            warnings.append(
                f"{duplicate_song_count} duplicate songs have matching titles and artist credits; "
                "run the dedupe command with --apply to merge them"
            )

        bad_song_count = int(
            self.connection.execute(
                """
                SELECT COUNT(*)
                FROM (
                    SELECT s.id
                    FROM songs s
                    LEFT JOIN song_artists sa ON sa.song_id = s.id
                    GROUP BY s.id
                    HAVING COUNT(sa.artist_id) < 2
                )
                """
            ).fetchone()[0]
        )
        if bad_song_count:
            errors.append(f"{bad_song_count} songs have fewer than two credited artists")

        orphan_artist_count = int(
            self.connection.execute(
                """
                SELECT COUNT(*)
                FROM artists a
                LEFT JOIN song_artists sa ON sa.artist_id = a.id
                WHERE sa.artist_id IS NULL
                """
            ).fetchone()[0]
        )
        if orphan_artist_count:
            warnings.append(f"{orphan_artist_count} artists are not connected to any stored song")

        duplicate_artist_names = int(
            self.connection.execute(
                """
                SELECT COUNT(*) FROM (
                    SELECT name
                    FROM artists
                    GROUP BY name COLLATE NOCASE
                    HAVING COUNT(*) > 1
                )
                """
            ).fetchone()[0]
        )
        if duplicate_artist_names:
            warnings.append(
                f"{duplicate_artist_names} artist names belong to multiple MusicBrainz IDs; this is valid but the UI should disambiguate them if needed"
            )

        duplicate_song_names = int(
            self.connection.execute(
                """
                SELECT COUNT(*) FROM (
                    SELECT name
                    FROM songs
                    GROUP BY name COLLATE NOCASE
                    HAVING COUNT(*) > 1
                )
                """
            ).fetchone()[0]
        )
        if duplicate_song_names:
            warnings.append(
                f"{duplicate_song_names} song titles occur more than once; use song IDs rather than titles as identifiers"
            )

        return errors, warnings

    def export_json(self, settings: Settings, pretty_override: bool | None = None) -> dict[str, int]:
        output_dir = settings.output_path
        output_dir.mkdir(parents=True, exist_ok=True)
        pretty = settings.pretty_json if pretty_override is None else pretty_override

        if settings.include_orphan_artists_in_export:
            artist_rows = self.connection.execute(
                "SELECT id, name FROM artists ORDER BY id"
            )
        else:
            artist_rows = self.connection.execute(
                """
                SELECT DISTINCT a.id, a.name
                FROM artists a
                JOIN song_artists sa ON sa.artist_id = a.id
                ORDER BY a.id
                """
            )

        artists = {str(row["id"]): row["name"] for row in artist_rows}
        songs = {
            str(row["id"]): row["name"]
            for row in self.connection.execute("SELECT id, name FROM songs ORDER BY id")
        }

        main: dict[str, dict[str, list[int]]] = {}
        artist_songs: dict[str, list[int]] = {}

        rows = self.connection.execute(
            """
            SELECT sa.song_id, sa.artist_id
            FROM song_artists sa
            ORDER BY sa.song_id, sa.credit_order
            """
        )
        for row in rows:
            song_id = int(row["song_id"])
            artist_id = int(row["artist_id"])
            song_key = str(song_id)
            artist_key = str(artist_id)
            main.setdefault(song_key, {"artists": []})["artists"].append(artist_id)
            artist_songs.setdefault(artist_key, []).append(song_id)

        link_count = sum(len(value["artists"]) for value in main.values())
        manifest = {
            "formatVersion": 1,
            "generatedAt": utc_now(),
            "artistCount": len(artists),
            "songCount": len(songs),
            "songArtistLinkCount": link_count,
            "sources": {
                "metadata": "MusicBrainz",
                "popularity": "Last.fm",
            },
        }

        payloads = {
            "main.json": {"data": main},
            "artists.json": {"artists": artists},
            "songs.json": {"songs": songs},
            "artistSongs.json": {"artistSongs": artist_songs},
            "manifest.json": manifest,
        }
        for filename, payload in payloads.items():
            write_json(output_dir / filename, payload, pretty=pretty)

        return {
            "artists": len(artists),
            "songs": len(songs),
            "songArtistLinks": link_count,
        }


def choose_best_artist_match(
    requested_name: str,
    results: list[dict[str, Any]],
    minimum_score: int,
) -> dict[str, Any] | None:
    if not results:
        return None

    normalized = requested_name.casefold().strip()
    exact = [
        item
        for item in results
        if str(item.get("name") or "").casefold().strip() == normalized
    ]
    candidates = exact or results
    best = max(candidates, key=lambda item: int(item.get("score") or 0))
    return best if int(best.get("score") or 0) >= minimum_score else None


def normalize_title(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.casefold())


def artist_track_key(track: dict[str, Any]) -> str:
    raw_mbid = str(track.get("mbid") or "").strip()
    mbid_match = UUID_RE.search(raw_mbid)
    if mbid_match:
        return f"mbid:{mbid_match.group(0).lower()}"
    url = str(track.get("url") or "").strip().casefold()
    if url:
        return f"url:{url}"
    name = normalize_title(str(track.get("name") or ""))
    return f"name:{name}" if name else "unknown"


TITLE_VERSION_QUALIFIER_RE = re.compile(
    r"\b(?:"
    r"remix(?:ed)?|remaster(?:ed)?|mix|edit|version|vsersion|verison|"
    r"verson|versoin|live|acoustic|"
    r"instrumental|demo|radio|extended|original|single|album|mono|stereo|"
    r"feat(?:uring)?|with|duet|soundtrack|bonus|deluxe|clean|"
    r"explicit|karaoke|cover|alternate|sped\s+up|slowed(?:\s+down)?|"
    r"reverb(?:ed)?|vs"
    r")\b",
    re.IGNORECASE,
)
TITLE_SOURCE_QUALIFIER_RE = re.compile(
    r"^\s*(?:from|as\s+(?:featured|heard|seen|used)\s+in)\b",
    re.IGNORECASE,
)
BRACKETED_TITLE_CONTENT_RE = re.compile(
    r"\([^()]*\)|\[[^\[\]]*\]|\{[^{}]*\}"
)
TRAILING_SEPARATED_TITLE_RE = re.compile(r"\s+(?:-|–|—|:)\s*([^\-–—:]+)\s*$")
TRAILING_PLAIN_VERSION_RE = re.compile(
    r"\s+(?:"
    r"remix(?:ed)?|remaster(?:ed)?(?:\s+\d{4})?|\d{4}\s+remaster(?:ed)?|"
    r"radio\s+edit|extended\s+(?:mix|version)|original\s+mix|"
    r"single\s+version|album\s+version|acoustic(?:\s+version)?|"
    r"instrumental(?:\s+version)?|demo(?:\s+version)?|live(?:\s+version)?"
    r")\s*$",
    re.IGNORECASE,
)
VERY_SIMILAR_TITLE_RATIO = 0.94
VERY_SIMILAR_TITLE_MIN_LENGTH = 8


def strip_bracketed_title_content(value: str) -> str:
    """Remove all bracketed content while retaining a readable display title."""

    candidate = value.strip()
    while candidate:
        without_brackets = BRACKETED_TITLE_CONTENT_RE.sub(" ", candidate)
        if without_brackets == candidate:
            break
        candidate = without_brackets
    candidate = re.sub(r"\s+", " ", candidate).strip()
    return re.sub(r"\s+([,.;:!?])", r"\1", candidate)


def normalize_title_version(value: str) -> str:
    """Normalize a title after removing bracketed content and version labels."""

    candidate = strip_bracketed_title_content(value).casefold()

    while candidate:
        previous = candidate
        separated = TRAILING_SEPARATED_TITLE_RE.search(candidate)
        if separated and (
            TITLE_VERSION_QUALIFIER_RE.search(separated.group(1))
            or TITLE_SOURCE_QUALIFIER_RE.search(separated.group(1))
        ):
            candidate = candidate[: separated.start()].rstrip()
        else:
            candidate = TRAILING_PLAIN_VERSION_RE.sub("", candidate).rstrip()
        if candidate == previous:
            break
    return normalize_title(candidate)


def titles_are_very_similar(left: str, right: str) -> bool:
    """Return whether two titles are safely similar enough for identical credits."""

    normalized_left = normalize_title(left)
    normalized_right = normalize_title(right)
    if not normalized_left or not normalized_right:
        return False
    if normalized_left == normalized_right:
        return True

    version_left = normalize_title_version(left)
    version_right = normalize_title_version(right)
    if version_left and version_left == version_right:
        return True

    if min(len(normalized_left), len(normalized_right)) < VERY_SIMILAR_TITLE_MIN_LENGTH:
        return False
    if re.findall(r"\d+", left) != re.findall(r"\d+", right):
        return False
    length_difference = abs(len(normalized_left) - len(normalized_right))
    if length_difference > max(2, round(max(len(normalized_left), len(normalized_right)) * 0.1)):
        return False
    return (
        SequenceMatcher(None, normalized_left, normalized_right).ratio()
        >= VERY_SIMILAR_TITLE_RATIO
    )


def recording_match_rank(match: dict[str, Any]) -> tuple[bool, bool, int, int]:
    credits = match.get("artist-credit") or []
    credited_artist_mbids = {
        str((credit.get("artist") or {}).get("id") or "").strip().casefold()
        for credit in credits
        if isinstance(credit, dict)
    }
    credited_artist_mbids.discard("")
    releases = match.get("releases") or []
    return (
        not bool(str(match.get("disambiguation") or "").strip()),
        len(credited_artist_mbids) >= 2,
        int(match.get("score") or 0),
        len(releases) if isinstance(releases, list) else 0,
    )


def resolve_lastfm_track_mbid(
    api: ApiClient,
    track: dict[str, Any],
    artist_mbid: str,
) -> str | None:
    provided_mbid = str(track.get("mbid") or "").strip()
    unavailable_mbid: str | None = None
    if provided_mbid:
        try:
            provided_mbid = extract_mbid(provided_mbid, "recording")
        except GeneratorError:
            provided_mbid = ""

    if provided_mbid:
        try:
            api.get_recording(provided_mbid)
        except ApiError as exc:
            if exc.status_code != 404:
                raise
            unavailable_mbid = provided_mbid
        else:
            return provided_mbid

    title = str(track.get("name") or "").strip()
    if not title:
        return None

    matches = api.search_recording(title, artist_mbid)
    if unavailable_mbid:
        matches = [
            match
            for match in matches
            if str(match.get("id") or "").casefold() != unavailable_mbid
        ]
    if not matches:
        return None

    normalized_wanted = normalize_title(title)
    exact_matches = [
        match
        for match in matches
        if normalize_title(str(match.get("title") or "")) == normalized_wanted
    ]
    candidates = exact_matches or matches
    best_match = max(candidates, key=recording_match_rank)
    recording_mbid = str(best_match.get("id") or "").strip()
    if not recording_mbid:
        return None
    return extract_mbid(recording_mbid, "recording")


def parse_artist_credits(recording: dict[str, Any]) -> list[ArtistCredit]:
    credits: list[ArtistCredit] = []
    seen: set[str] = set()

    for credit in recording.get("artist-credit") or []:
        if not isinstance(credit, dict):
            continue
        artist = credit.get("artist") or {}
        mbid = str(artist.get("id") or "").lower().strip()
        name = str(credit.get("name") or artist.get("name") or "").strip()
        if not mbid or not name or mbid in seen or mbid == VARIOUS_ARTISTS_MBID:
            continue
        seen.add(mbid)
        credits.append(ArtistCredit(mbid=mbid, name=name))

    return credits


def resolve_seed_artist_items(
    api: ApiClient,
    settings: Settings,
    sitewide: Sequence[dict[str, Any]],
) -> tuple[list[ArtistCredit], list[dict[str, Any]]]:
    resolved: list[ArtistCredit] = []
    unresolved: list[dict[str, Any]] = []
    seen: set[str] = set()

    for rank, item in enumerate(sitewide, start=1):
        name = str(item.get("name") or "").strip()
        raw_mbid = str(item.get("mbid") or "").strip()
        mbid: str | None = None

        if raw_mbid:
            try:
                mbid = extract_mbid(str(raw_mbid), "artist")
            except GeneratorError:
                mbid = None

        matched: dict[str, Any] | None = None
        if not mbid and name:
            matched = choose_best_artist_match(
                name,
                api.search_artist(name),
                settings.minimum_artist_match_score,
            )
            if matched and matched.get("id"):
                mbid = extract_mbid(str(matched["id"]), "artist")
                name = str(matched.get("name") or name)

        if not mbid or not name or mbid in seen:
            unresolved.append(
                {
                    "rank": rank,
                    "name": name or None,
                    "lastfmArtistMbid": raw_mbid or None,
                    "bestMusicBrainzMatch": matched,
                }
            )
            continue

        seen.add(mbid)
        resolved.append(ArtistCredit(mbid=mbid, name=name))

    return resolved, unresolved


def resolve_top_seed_artists(
    api: ApiClient,
    settings: Settings,
    count: int,
) -> tuple[list[ArtistCredit], list[dict[str, Any]]]:
    return resolve_seed_artist_items(
        api,
        settings,
        api.get_sitewide_top_artists(count),
    )


def import_recording(
    api: ApiClient,
    database: GraphDatabase,
    recording_mbid: str,
    *,
    expected_artist_mbid: str | None = None,
) -> tuple[int, str, list[ArtistCredit]]:
    recording = api.get_recording(recording_mbid)
    credits = parse_artist_credits(recording)

    if len(credits) < 2:
        raise GeneratorError(
            f"Recording {recording_mbid} has fewer than two credited artists and is not useful for this game"
        )
    if expected_artist_mbid and expected_artist_mbid not in {credit.mbid for credit in credits}:
        raise GeneratorError(
            f"Recording {recording_mbid} does not credit the expected artist {expected_artist_mbid}"
        )

    song_name = str(recording.get("title") or recording_mbid).strip()
    song_id = database.upsert_song(recording_mbid, song_name)
    artist_ids = [database.upsert_artist(credit.mbid, credit.name) for credit in credits]
    database.add_song_artists(song_id, artist_ids)
    song_id, _ = database.merge_duplicate_song(song_id)
    database.commit()
    return song_id, song_name, credits


def check_artist_track_candidate(
    api: ApiClient,
    database: GraphDatabase,
    artist: ArtistCredit,
    track: dict[str, Any],
    *,
    cached_status: str | None = None,
    refresh_existing: bool = False,
) -> dict[str, Any]:
    """Resolve one Last.fm candidate and persist its reusable terminal outcome."""

    track_key = artist_track_key(track)
    track_name = str(track.get("name") or "unknown track").strip()
    lastfm_url = str(track.get("url") or "").strip() or None
    if cached_status in ARTIST_TRACK_TERMINAL_STATUSES:
        replay_status = "existing" if cached_status == "imported" else cached_status
        return {
            "trackKey": track_key,
            "trackName": track_name,
            "status": replay_status,
            "cachedStatus": cached_status,
            "cached": True,
            "recordingMbid": None,
            "importedRecording": 0,
        }

    recording_mbid: str | None = None
    try:
        recording_mbid = resolve_lastfm_track_mbid(api, track, artist.mbid)
        if not recording_mbid:
            database.record_artist_track_check(
                artist.mbid,
                track_key,
                track_name,
                lastfm_url=lastfm_url,
                recording_mbid=None,
                status="unresolved",
            )
            return {
                "trackKey": track_key,
                "trackName": track_name,
                "status": "unresolved",
                "cached": False,
                "recordingMbid": None,
                "importedRecording": 0,
            }

        if database.has_song(recording_mbid) and not refresh_existing:
            status = (
                "existing"
                if database.song_contains_artist(recording_mbid, artist.mbid)
                else "wrong_artist"
            )
            database.record_artist_track_check(
                artist.mbid,
                track_key,
                track_name,
                lastfm_url=lastfm_url,
                recording_mbid=recording_mbid,
                status=status,
            )
            return {
                "trackKey": track_key,
                "trackName": track_name,
                "status": status,
                "cached": False,
                "recordingMbid": recording_mbid,
                "importedRecording": 0,
            }

        artist_song_count_before = database.count_songs_for_artist(artist.mbid)
        _, song_name, credits = import_recording(
            api,
            database,
            recording_mbid,
            expected_artist_mbid=artist.mbid,
        )
        artist_song_count_after = database.count_songs_for_artist(artist.mbid)
        database.record_artist_track_check(
            artist.mbid,
            track_key,
            track_name,
            lastfm_url=lastfm_url,
            recording_mbid=recording_mbid,
            status="imported",
        )
        return {
            "trackKey": track_key,
            "trackName": track_name,
            "status": "imported",
            "cached": False,
            "recordingMbid": recording_mbid,
            "songName": song_name,
            "artists": [credit.name for credit in credits],
            "importedRecording": 1,
            "addedArtistSong": artist_song_count_after > artist_song_count_before,
        }
    except ApiError as exc:
        status = "failed"
        error = str(exc)
    except GeneratorError as exc:
        error = str(exc)
        if "fewer than two" in error:
            status = "solo"
        elif "does not credit" in error:
            status = "wrong_artist"
        else:
            status = "failed"

    database.record_artist_track_check(
        artist.mbid,
        track_key,
        track_name,
        lastfm_url=lastfm_url,
        recording_mbid=recording_mbid,
        status=status,
        error=error,
    )
    return {
        "trackKey": track_key,
        "trackName": track_name,
        "status": status,
        "cached": False,
        "recordingMbid": recording_mbid,
        "importedRecording": 0,
        "error": error,
    }


def import_artist_collection(
    api: ApiClient,
    database: GraphDatabase,
    settings: Settings,
    artist: ArtistCredit,
    target_song_count: int,
    *,
    refresh_existing: bool = False,
    refresh_catalog: bool = False,
    on_candidate: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, int]:
    database.upsert_artist(artist.mbid, artist.name)
    database.commit()

    existing_song_count = database.count_songs_for_artist(artist.mbid)
    if not refresh_existing and existing_song_count >= target_song_count:
        print(
            f"  Skipped {artist.name}: already has {existing_song_count} stored "
            f"collaborations (target: {target_song_count})."
        )
        return {
            "candidateRecordings": 0,
            "keptRecordings": existing_song_count,
            "importedRecordings": 0,
            "addedSongs": 0,
            "alreadyPresentRecordings": 0,
            "skippedSatisfiedArtists": 1,
            "skippedNonCollaborations": 0,
            "failedRecordings": 0,
            "cachedTrackChecks": 0,
            "existingSongCount": existing_song_count,
            "finalSongCount": existing_song_count,
            "availableCandidates": 0,
            "scannedCandidates": 0,
            "targetReached": True,
        }

    candidate_count = max(target_song_count * 3, 100)
    if refresh_catalog:
        candidates = api.get_top_tracks_for_artist(
            artist.name,
            artist.mbid,
            candidate_count,
            refresh=True,
        )
    else:
        candidates = api.get_top_tracks_for_artist(
            artist.name,
            artist.mbid,
            candidate_count,
        )
    kept = 0 if refresh_existing else existing_song_count
    imported = 0
    added_songs = 0
    already_present = 0
    skipped_non_collaborations = 0
    failed = 0
    considered = 0
    cached_track_checks = 0
    seen_track_keys: set[str] = set()
    track_statuses = database.get_artist_track_check_statuses(artist.mbid)
    available_candidates = len(candidates)
    scanned_candidates = 0
    last_reported_scan = 0

    def report_scan_progress() -> None:
        nonlocal last_reported_scan
        if scanned_candidates <= 0 or scanned_candidates == last_reported_scan:
            return
        current_song_count = database.count_songs_for_artist(artist.mbid)
        print(
            f"    Scanned {scanned_candidates}/{available_candidates} ranked tracks; "
            f"stored songs: {current_song_count}/{target_song_count}"
        )
        last_reported_scan = scanned_candidates

    for candidate_position, candidate in enumerate(candidates, start=1):
        if candidate_position > 1 and (candidate_position - 1) % 25 == 0:
            report_scan_progress()
        if kept >= target_song_count:
            break
        scanned_candidates = candidate_position
        if not isinstance(candidate, dict):
            continue

        track_key = artist_track_key(candidate)
        if track_key in seen_track_keys:
            continue
        seen_track_keys.add(track_key)
        cached_status = track_statuses.get(track_key)
        if refresh_existing and cached_status in {"existing", "imported"}:
            cached_status = None
        result = check_artist_track_candidate(
            api,
            database,
            artist,
            candidate,
            cached_status=cached_status,
            refresh_existing=refresh_existing,
        )
        status = str(result["status"])
        track_statuses[track_key] = status
        if result.get("cached"):
            cached_track_checks += 1
        elif on_candidate is not None:
            on_candidate(result)

        if result.get("recordingMbid"):
            considered += 1
        if status == "existing":
            already_present += 1
            continue
        if status in {"solo", "wrong_artist"}:
            skipped_non_collaborations += 1
            continue
        if status == "failed":
            failed += 1
            print(f"    Could not process {result['trackName']!r}: {result['error']}")
            continue
        if status != "imported":
            continue

        if refresh_existing:
            kept += 1
        else:
            kept = database.count_songs_for_artist(artist.mbid)
        imported += 1
        if result.get("addedArtistSong"):
            added_songs += 1
            print(
                f"    [{kept}/{target_song_count}] Saved {result['songName']} -> "
                + ", ".join(result["artists"])
            )
        else:
            print(
                f"    Matched alternate recording for {result['songName']}; "
                f"unique-song count remains {database.count_songs_for_artist(artist.mbid)}/"
                f"{target_song_count}"
            )

    report_scan_progress()
    final_song_count = database.count_songs_for_artist(artist.mbid)
    if final_song_count < target_song_count:
        print(
            f"    Available ranked candidates exhausted: {final_song_count}/"
            f"{target_song_count} stored songs after scanning "
            f"{scanned_candidates}/{available_candidates} tracks."
        )

    return {
        "candidateRecordings": considered,
        "keptRecordings": kept,
        "importedRecordings": imported,
        "addedSongs": added_songs,
        "alreadyPresentRecordings": already_present,
        "skippedSatisfiedArtists": 0,
        "skippedNonCollaborations": skipped_non_collaborations,
        "failedRecordings": failed,
        "cachedTrackChecks": cached_track_checks,
        "existingSongCount": existing_song_count,
        "finalSongCount": final_song_count,
        "availableCandidates": available_candidates,
        "scannedCandidates": scanned_candidates,
        "targetReached": final_song_count >= target_song_count,
    }


def build_from_top_artists(
    api: ApiClient,
    database: GraphDatabase,
    settings: Settings,
    *,
    top_artist_count: int | None = None,
    songs_per_artist: int | None = None,
    refresh_existing: bool = False,
    state: BuildState | None = None,
    checkpoint_path: Path | None = None,
) -> BuildSummary:
    if state is None:
        if top_artist_count is None or songs_per_artist is None:
            raise GeneratorError("A build requires top-artist and song counts")
        state = BuildState(
            top_artist_count=top_artist_count,
            songs_per_artist=songs_per_artist,
            refresh_existing=refresh_existing,
            pretty_json=settings.pretty_json,
        )

    settings.reports_path.mkdir(parents=True, exist_ok=True)
    if not state.seeds:
        print(f"Resolving the top {state.top_artist_count} Last.fm artists...")
        seeds, unresolved = resolve_top_seed_artists(
            api, settings, state.top_artist_count
        )
        if not seeds:
            raise GeneratorError("No top artists could be resolved to MusicBrainz IDs")
        state.seeds = seeds
        state.next_artist_index = 0
        write_json(
            settings.reports_path / "unresolved_top_artists.json",
            {"generatedAt": utc_now(), "artists": unresolved},
            pretty=True,
        )
        write_json(
            settings.reports_path / "resolved_top_artists.json",
            {
                "generatedAt": utc_now(),
                "artists": [
                    {"rank": rank, "mbid": seed.mbid, "name": seed.name}
                    for rank, seed in enumerate(state.seeds, start=1)
                ],
            },
            pretty=True,
        )
        if checkpoint_path is not None:
            write_build_checkpoint(checkpoint_path, state, status="running")

    failed_requests_path = settings.reports_path / "failed_requests.json"
    write_failed_requests(failed_requests_path, state.failures, command="build")

    for artist_offset in range(state.next_artist_index, len(state.seeds)):
        artist = state.seeds[artist_offset]
        display_index = artist_offset + 1
        print(
            f"\n[{display_index}/{len(state.seeds)}] {artist.name} ({artist.mbid})"
        )
        import_id = database.begin_import("artist", artist.mbid)
        try:
            result = import_artist_collection(
                api,
                database,
                settings,
                artist,
                state.songs_per_artist,
                refresh_existing=state.refresh_existing,
            )
            database.finish_import(
                import_id,
                "skipped" if result.get("skippedSatisfiedArtists") else "completed",
                result,
            )
        except KeyboardInterrupt:
            database.finish_import(
                import_id,
                "paused",
                {"rank": display_index, "message": "Build paused by user"},
            )
            if checkpoint_path is not None:
                write_build_checkpoint(checkpoint_path, state, status="paused")
            raise
        except GeneratorError as exc:
            database.finish_import(import_id, "failed", {"error": str(exc)})
            failure = {
                "type": "artist",
                "mbid": artist.mbid,
                "name": artist.name,
                "songs": state.songs_per_artist,
                "refreshExisting": state.refresh_existing,
                "rank": display_index,
                "failedAt": utc_now(),
                "error": str(exc),
            }
            state.failures.append(failure)
            state.next_artist_index = display_index
            write_failed_requests(
                failed_requests_path, state.failures, command="build"
            )
            if checkpoint_path is not None:
                write_build_checkpoint(checkpoint_path, state, status="running")
            print(f"  Artist request failed; continuing: {exc}")
            continue
        except Exception as exc:
            database.finish_import(import_id, "failed", {"error": str(exc)})
            raise

        for key in BUILD_TOTAL_KEYS:
            state.totals[key] += int(result.get(key, 0))
        state.next_artist_index = display_index
        if checkpoint_path is not None:
            write_build_checkpoint(checkpoint_path, state, status="running")
        if not result.get("skippedSatisfiedArtists"):
            print(
                f"  Kept {result['keptRecordings']} collaborations; "
                f"imported {result['importedRecordings']} new recordings."
            )

    if checkpoint_path is not None:
        write_build_checkpoint(checkpoint_path, state, status="export_pending")
    return BuildSummary(
        seed_artists=len(state.seeds),
        candidate_recordings=state.totals["candidateRecordings"],
        imported_recordings=state.totals["importedRecordings"],
        already_present_recordings=state.totals["alreadyPresentRecordings"],
        skipped_satisfied_artists=state.totals["skippedSatisfiedArtists"],
        skipped_non_collaborations=state.totals["skippedNonCollaborations"],
        failed_recordings=state.totals["failedRecordings"],
    )


def read_request_entries(path: Path) -> tuple[list[tuple[str, int | None]], list[str]]:
    payload = read_json(path)
    if not isinstance(payload, dict):
        raise GeneratorError("requests.json must contain an object")

    artist_requests: list[tuple[str, int | None]] = []
    for item in payload.get("artists") or []:
        if isinstance(item, str):
            artist_requests.append((extract_mbid(item, "artist"), None))
        elif isinstance(item, dict):
            identifier = str(item.get("mbid") or item.get("url") or "")
            if not identifier:
                raise GeneratorError("Each artist request must have 'mbid' or 'url'")
            songs = item.get("songs")
            artist_requests.append(
                (
                    extract_mbid(identifier, "artist"),
                    require_positive_int(songs, "request artist songs") if songs is not None else None,
                )
            )
        else:
            raise GeneratorError("Artist requests must be strings or objects")

    song_requests: list[str] = []
    for item in payload.get("songs") or []:
        if isinstance(item, str):
            song_requests.append(extract_mbid(item, "recording"))
        elif isinstance(item, dict):
            identifier = str(item.get("mbid") or item.get("url") or "")
            if not identifier:
                raise GeneratorError("Each song request must have 'mbid' or 'url'")
            song_requests.append(extract_mbid(identifier, "recording"))
        else:
            raise GeneratorError("Song requests must be strings or objects")

    return artist_requests, song_requests


def add_artist_by_mbid(
    api: ApiClient,
    database: GraphDatabase,
    settings: Settings,
    artist_mbid: str,
    songs: int,
    refresh_existing: bool,
) -> dict[str, int]:
    metadata = api.get_artist(artist_mbid)
    artist = ArtistCredit(
        mbid=artist_mbid,
        name=str(metadata.get("name") or artist_mbid),
    )
    print(f"Importing {artist.name} ({artist.mbid})...")
    import_id = database.begin_import("artist", artist.mbid)
    try:
        result = import_artist_collection(
            api,
            database,
            settings,
            artist,
            songs,
            refresh_existing=refresh_existing,
        )
        database.finish_import(
            import_id,
            "skipped" if result.get("skippedSatisfiedArtists") else "completed",
            result,
        )
        return result
    except Exception as exc:
        database.finish_import(import_id, "failed", {"error": str(exc)})
        raise


def fill_artists_to_minimum(
    api: ApiClient,
    database: GraphDatabase,
    settings: Settings,
    minimum_song_count: int = 2,
    *,
    ignore_zero_songs: bool = False,
) -> dict[str, Any]:
    """Fill eligible stored artists to a minimum distinct-song count."""

    settings.reports_path.mkdir(parents=True, exist_ok=True)
    report_path = settings.reports_path / "fill_minimum.json"

    def get_underfilled_artists() -> list[dict[str, Any]]:
        return database.get_artists_below_song_count(
            minimum_song_count,
            ignore_zero_songs=ignore_zero_songs,
        )

    initial_artists = get_underfilled_artists()
    attempted_artist_mbids: set[str] = set()
    improved_artist_mbids: set[str] = set()
    failures_by_mbid: dict[str, dict[str, Any]] = {}
    pass_count = 0
    attempt_count = 0
    candidate_recordings = 0
    imported_recordings = 0
    failed_recordings = 0

    def make_summary(status: str) -> dict[str, Any]:
        remaining_artists = get_underfilled_artists()
        return {
            "generatedAt": utc_now(),
            "status": status,
            "completed": status == "completed",
            "minimumSongs": minimum_song_count,
            "ignoreZeroSongs": ignore_zero_songs,
            "passes": pass_count,
            "initialUnderfilledArtistCount": len(initial_artists),
            "attemptCount": attempt_count,
            "artistsAttempted": len(attempted_artist_mbids),
            "artistsImproved": len(improved_artist_mbids),
            "candidateRecordings": candidate_recordings,
            "importedRecordings": imported_recordings,
            "failedRecordings": failed_recordings,
            "failedArtistCount": len(failures_by_mbid),
            "failures": list(failures_by_mbid.values()),
            "remainingArtistCount": len(remaining_artists),
            "remainingArtists": remaining_artists,
        }

    def save_summary(status: str) -> dict[str, Any]:
        summary = make_summary(status)
        write_json(report_path, summary, pretty=True)
        return summary

    remaining = initial_artists
    if not remaining:
        return save_summary("completed")

    try:
        while remaining:
            pass_count += 1
            pass_made_progress = False
            print(
                f"\nFill pass {pass_count}: {len(remaining)} artists have fewer than "
                f"{minimum_song_count} songs."
            )

            for index, item in enumerate(remaining, start=1):
                artist = ArtistCredit(mbid=str(item["mbid"]), name=str(item["name"]))
                before_count = database.count_songs_for_artist(artist.mbid)
                if before_count >= minimum_song_count:
                    continue

                print(
                    f"  [{index}/{len(remaining)}] {artist.name}: "
                    f"{before_count}/{minimum_song_count} songs"
                )
                attempted_artist_mbids.add(artist.mbid)
                attempt_count += 1
                import_id = database.begin_import("fill-artist", artist.mbid)
                try:
                    result = import_artist_collection(
                        api,
                        database,
                        settings,
                        artist,
                        minimum_song_count,
                    )
                except KeyboardInterrupt:
                    database.finish_import(
                        import_id,
                        "paused",
                        {
                            "minimumSongs": minimum_song_count,
                            "ignoreZeroSongs": ignore_zero_songs,
                            "beforeSongCount": before_count,
                            "message": "Fill-minimum command paused by user",
                        },
                    )
                    raise
                except GeneratorError as exc:
                    database.finish_import(import_id, "failed", {"error": str(exc)})
                    failures_by_mbid[artist.mbid] = {
                        "mbid": artist.mbid,
                        "name": artist.name,
                        "songCount": before_count,
                        "failedAt": utc_now(),
                        "error": str(exc),
                    }
                    print(f"    Artist failed: {exc}")
                    continue

                after_count = database.count_songs_for_artist(artist.mbid)
                details = dict(result)
                details.update(
                    {
                        "minimumSongs": minimum_song_count,
                        "ignoreZeroSongs": ignore_zero_songs,
                        "beforeSongCount": before_count,
                        "afterSongCount": after_count,
                    }
                )
                database.finish_import(
                    import_id,
                    "completed" if after_count >= minimum_song_count else "incomplete",
                    details,
                )
                candidate_recordings += int(result.get("candidateRecordings", 0))
                imported_recordings += int(result.get("importedRecordings", 0))
                failed_recordings += int(result.get("failedRecordings", 0))
                failures_by_mbid.pop(artist.mbid, None)

                if after_count > before_count:
                    pass_made_progress = True
                    improved_artist_mbids.add(artist.mbid)
                print(f"    Stored song count: {before_count} -> {after_count}")

            remaining = get_underfilled_artists()
            if not remaining:
                return save_summary("completed")
            if not pass_made_progress:
                return save_summary("stalled")
            save_summary("running")
    except KeyboardInterrupt:
        save_summary("paused")
        raise

    raise AssertionError("unreachable")


def next_constant_grow_cohort_size(current_size: int) -> int:
    """Return the next value in the 10, 20, 50, 100, ... sequence."""

    if current_size < 10:
        return 10
    magnitude = 10
    while current_size >= magnitude * 10:
        magnitude *= 10
    leading = current_size / magnitude
    if leading < 2:
        return 2 * magnitude
    if leading < 5:
        return 5 * magnitude
    return 10 * magnitude


def grow_artist_to_coverage(
    api: ApiClient,
    database: GraphDatabase,
    artist: ArtistCredit,
    coverage_target: float,
    *,
    refresh_catalog: bool = False,
    page_size: int = 100,
    on_candidate: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Scan a ranked Last.fm catalog prefix and import every collaboration found."""

    database.upsert_artist(artist.mbid, artist.name)
    database.commit()
    statuses = database.get_artist_track_check_statuses(artist.mbid)
    first_page = api.get_top_tracks_page_for_artist(
        artist.name,
        artist.mbid,
        page=1,
        limit=page_size,
        refresh=refresh_catalog,
    )
    reported_total = max(int(first_page.get("total") or 0), len(first_page["tracks"]))
    target_candidates = math.ceil(reported_total * coverage_target)
    scanned_candidates = 0
    newly_examined = 0
    cached_candidates = 0
    pages_scanned = 0
    status_counts: dict[str, int] = {}
    attempted_this_run: set[str] = set()
    page_number = 1
    per_page = max(1, int(first_page.get("perPage") or page_size))
    expected_pages = max(
        int(first_page.get("totalPages") or 1),
        math.ceil(target_candidates / per_page) if target_candidates else 1,
    )

    while scanned_candidates < target_candidates and page_number <= expected_pages:
        page_payload = (
            first_page
            if page_number == 1
            else api.get_top_tracks_page_for_artist(
                artist.name,
                artist.mbid,
                page=page_number,
                limit=page_size,
                refresh=refresh_catalog,
            )
        )
        tracks = page_payload["tracks"]
        pages_scanned += 1
        if not tracks:
            break

        for track in tracks:
            if scanned_candidates >= target_candidates:
                break
            scanned_candidates += 1
            track_key = artist_track_key(track)
            if track_key in attempted_this_run:
                cached_candidates += 1
                continue
            attempted_this_run.add(track_key)
            cached_status = statuses.get(track_key)
            result = check_artist_track_candidate(
                api,
                database,
                artist,
                track,
                cached_status=cached_status,
            )
            status = str(result["status"])
            statuses[track_key] = status
            status_counts[status] = status_counts.get(status, 0) + 1
            if result.get("cached"):
                cached_candidates += 1
            else:
                newly_examined += 1
                if on_candidate is not None:
                    on_candidate(result)
            if status == "imported":
                if result.get("addedArtistSong"):
                    print(
                        f"      Saved {result['songName']} -> "
                        + ", ".join(result["artists"])
                    )
                else:
                    print(
                        f"      Matched alternate recording for "
                        f"{result['songName']}"
                    )
            elif scanned_candidates % 25 == 0:
                print(
                    f"      Scanned {scanned_candidates}/{target_candidates} "
                    f"ranked tracks"
                )
        page_number += 1

    return {
        "artistMbid": artist.mbid,
        "artistName": artist.name,
        "reportedTrackTotal": reported_total,
        "coverageTarget": coverage_target,
        "targetCandidates": target_candidates,
        "scannedCandidates": scanned_candidates,
        "coverageAchieved": (
            min(1.0, scanned_candidates / reported_total) if reported_total else 1.0
        ),
        "newlyExamined": newly_examined,
        "cachedCandidates": cached_candidates,
        "pagesScanned": pages_scanned,
        "statusCounts": status_counts,
        "storedSongCount": database.count_songs_for_artist(artist.mbid),
    }


def grow_artist_to_song_count(
    api: ApiClient,
    database: GraphDatabase,
    settings: Settings,
    artist: ArtistCredit,
    song_target: int,
    *,
    refresh_catalog: bool = False,
    on_candidate: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Grow one artist until it reaches a fixed stored-song target."""

    result: dict[str, Any] = dict(
        import_artist_collection(
            api,
            database,
            settings,
            artist,
            song_target,
            refresh_catalog=refresh_catalog,
            on_candidate=on_candidate,
        )
    )
    result.update(
        {
            "artistMbid": artist.mbid,
            "artistName": artist.name,
            "songTarget": song_target,
            "storedSongCount": int(result["finalSongCount"]),
        }
    )
    return result


def fill_underconnected_artist_batch(
    api: ApiClient,
    database: GraphDatabase,
    settings: Settings,
    *,
    minimum_song_count: int,
    ignore_zero_songs: bool,
    batch_size: int,
) -> dict[str, Any]:
    candidates = database.get_artists_below_song_count(
        minimum_song_count,
        ignore_zero_songs=ignore_zero_songs,
    )[:batch_size]
    attempted = 0
    improved = 0
    imported = 0
    failures: list[dict[str, Any]] = []

    for index, item in enumerate(candidates, start=1):
        artist = ArtistCredit(mbid=str(item["mbid"]), name=str(item["name"]))
        before_count = database.count_songs_for_artist(artist.mbid)
        if before_count >= minimum_song_count:
            continue
        attempted += 1
        print(
            f"  Fill [{index}/{len(candidates)}] {artist.name}: "
            f"{before_count}/{minimum_song_count} songs"
        )
        import_id = database.begin_import("constant-grow-fill", artist.mbid)
        try:
            result = import_artist_collection(
                api,
                database,
                settings,
                artist,
                minimum_song_count,
            )
        except KeyboardInterrupt:
            database.finish_import(
                import_id,
                "paused",
                {"message": "Constant-grow fill batch paused by user"},
            )
            raise
        except GeneratorError as exc:
            database.finish_import(import_id, "failed", {"error": str(exc)})
            failures.append(
                {
                    "mbid": artist.mbid,
                    "name": artist.name,
                    "error": str(exc),
                }
            )
            continue

        after_count = database.count_songs_for_artist(artist.mbid)
        details = dict(result)
        details.update(
            {"beforeSongCount": before_count, "afterSongCount": after_count}
        )
        database.finish_import(
            import_id,
            "completed" if after_count >= minimum_song_count else "incomplete",
            details,
        )
        imported += int(result.get("importedRecordings", 0))
        if after_count > before_count:
            improved += 1

    remaining = database.get_artists_below_song_count(
        minimum_song_count,
        ignore_zero_songs=ignore_zero_songs,
    )
    return {
        "minimumSongs": minimum_song_count,
        "ignoreZeroSongs": ignore_zero_songs,
        "batchSize": batch_size,
        "artistsAttempted": attempted,
        "artistsImproved": improved,
        "importedRecordings": imported,
        "failures": failures,
        "remainingArtistCount": len(remaining),
    }


def run_constant_grow(
    api: ApiClient,
    database: GraphDatabase,
    settings: Settings,
    state: ConstantGrowState,
    checkpoint_path: Path,
    *,
    max_stages: int | None = None,
) -> dict[str, Any]:
    """Run progressive growth stages forever, or a bounded number in tests."""

    settings.reports_path.mkdir(parents=True, exist_ok=True)
    report_path = settings.reports_path / "constant_grow.json"
    last_export_monotonic = time.monotonic()
    stages_this_run = 0
    last_fill_result: dict[str, Any] | None = None
    last_artist_results: list[dict[str, Any]] = []

    def save_checkpoint(status: str = "running") -> None:
        write_constant_grow_checkpoint(checkpoint_path, state, status=status)

    def maybe_export(*, force: bool = False) -> dict[str, int] | None:
        nonlocal last_export_monotonic
        due_to_recordings = (
            state.recordings_since_export >= state.export_every_recordings
        )
        due_to_time = (
            state.export_every_minutes > 0
            and time.monotonic() - last_export_monotonic
            >= state.export_every_minutes * 60
        )
        if not force and not due_to_recordings and not due_to_time:
            return None
        summary = database.export_json(
            settings,
            pretty_override=state.pretty_json,
        )
        state.recordings_since_export = 0
        state.last_export_at = utc_now()
        state.totals["exports"] += 1
        last_export_monotonic = time.monotonic()
        save_checkpoint()
        print_export_summary(summary, settings.output_path)
        return summary

    def candidate_finished(result: dict[str, Any]) -> None:
        state.totals["trackCandidatesExamined"] += 1
        status = str(result["status"])
        if status == "imported":
            state.totals["tracksImported"] += 1
            state.recordings_since_export += 1
        elif status == "existing":
            state.totals["tracksExisting"] += 1
        elif status in {"solo", "wrong_artist"}:
            state.totals["tracksRejected"] += 1
        elif status == "unresolved":
            state.totals["tracksUnresolved"] += 1
        elif status == "failed":
            state.totals["trackFailures"] += 1
        save_checkpoint()
        maybe_export()

    save_checkpoint()
    while True:
        refresh_catalog = False
        if not state.seeds:
            refresh_catalog = (
                state.chart_total is not None
                and state.cohort_size >= state.chart_total
                and state.stages_completed > 0
            )
            snapshot = api.get_sitewide_top_artists_snapshot(
                state.cohort_size,
                refresh=refresh_catalog,
            )
            raw_artists = list(snapshot["artists"])
            chart_total = max(int(snapshot.get("total") or 0), len(raw_artists))
            if chart_total and state.cohort_size > chart_total:
                state.cohort_size = chart_total
                raw_artists = raw_artists[:chart_total]
            state.chart_total = chart_total or state.cohort_size
            seeds, unresolved = resolve_seed_artist_items(api, settings, raw_artists)
            if not seeds:
                raise GeneratorError(
                    f"No artists in the top-{state.cohort_size} cohort could be resolved"
                )
            state.seeds = seeds
            state.next_artist_index = 0
            write_json(
                settings.reports_path / "constant_grow_unresolved_artists.json",
                {
                    "generatedAt": utc_now(),
                    "cohortSize": state.cohort_size,
                    "artists": unresolved,
                },
                pretty=True,
            )
            if state.songs_per_artist is None:
                growth_description = (
                    f"{state.coverage_target:.0%} catalog coverage"
                )
            else:
                growth_description = (
                    f"a {state.songs_per_artist}-song target per artist"
                )
            print(
                f"\nConstant-grow cohort: top {state.cohort_size} artists "
                f"using {growth_description}"
            )
            save_checkpoint()

        last_artist_results = []
        for artist_offset in range(state.next_artist_index, len(state.seeds)):
            artist = state.seeds[artist_offset]
            print(
                f"\n[{artist_offset + 1}/{len(state.seeds)}] Growing "
                f"{artist.name} ({artist.mbid})"
            )
            try:
                if state.songs_per_artist is None:
                    result = grow_artist_to_coverage(
                        api,
                        database,
                        artist,
                        state.coverage_target,
                        refresh_catalog=refresh_catalog,
                        on_candidate=candidate_finished,
                    )
                else:
                    result = grow_artist_to_song_count(
                        api,
                        database,
                        settings,
                        artist,
                        state.songs_per_artist,
                        refresh_catalog=refresh_catalog,
                        on_candidate=candidate_finished,
                    )
            except GeneratorError as exc:
                failure = {
                    "cohortSize": state.cohort_size,
                    "artistMbid": artist.mbid,
                    "artistName": artist.name,
                    "failedAt": utc_now(),
                    "error": str(exc),
                }
                state.failures.append(failure)
                state.failures = state.failures[-100:]
                print(f"  Artist scan failed; continuing: {exc}")
            else:
                last_artist_results.append(result)
                if state.songs_per_artist is None:
                    print(
                        f"  Scanned {result['scannedCandidates']}/"
                        f"{result['reportedTrackTotal']} tracks; "
                        f"stored songs: {result['storedSongCount']}"
                    )
                else:
                    print(
                        f"  Target {state.songs_per_artist} songs; "
                        f"stored songs: {result['storedSongCount']}; "
                        f"new unique songs: {result.get('addedSongs', 0)}"
                    )
            state.totals["artistsVisited"] += 1
            state.next_artist_index = artist_offset + 1
            save_checkpoint()
            maybe_export()

        print("\nRunning a bounded fill-minimum batch...")
        last_fill_result = fill_underconnected_artist_batch(
            api,
            database,
            settings,
            minimum_song_count=state.minimum_song_count,
            ignore_zero_songs=state.ignore_zero_songs,
            batch_size=state.fill_batch_size,
        )
        state.totals["fillArtistsAttempted"] += int(
            last_fill_result["artistsAttempted"]
        )
        fill_imported = int(last_fill_result["importedRecordings"])
        state.totals["fillImportedRecordings"] += fill_imported
        state.recordings_since_export += fill_imported
        maybe_export(force=True)

        state.stages_completed += 1
        stages_this_run += 1
        reached_chart_limit = bool(
            state.chart_total and state.cohort_size >= state.chart_total
        )
        completed_cohort = state.cohort_size
        if reached_chart_limit:
            state.maintenance_cycles += 1
        else:
            state.cohort_size = next_constant_grow_cohort_size(state.cohort_size)
        state.seeds = []
        state.next_artist_index = 0
        save_checkpoint()

        report = {
            "generatedAt": utc_now(),
            "status": "running",
            "completedCohort": completed_cohort,
            "nextCohort": state.cohort_size,
            "chartTotal": state.chart_total,
            "growthMode": (
                "songs" if state.songs_per_artist is not None else "coverage"
            ),
            "coverageTarget": state.coverage_target,
            "songsPerArtist": state.songs_per_artist,
            "stagesCompleted": state.stages_completed,
            "maintenanceCycles": state.maintenance_cycles,
            "lastArtistResults": last_artist_results,
            "lastFillResult": last_fill_result,
            "totals": state.totals,
            "database": database.get_stats(),
        }
        write_json(report_path, report, pretty=True)

        if max_stages is not None and stages_this_run >= max_stages:
            return report
        if reached_chart_limit and state.idle_seconds > 0:
            print(
                f"Reached the current Last.fm chart limit; refreshing again in "
                f"{state.idle_seconds:g} seconds. Press Ctrl+C to stop."
            )
            remaining_sleep = state.idle_seconds
            while remaining_sleep > 0:
                sleep_chunk = min(remaining_sleep, 60.0)
                time.sleep(sleep_chunk)
                remaining_sleep -= sleep_chunk


def add_song_by_mbid(
    api: ApiClient,
    database: GraphDatabase,
    recording_mbid: str,
) -> dict[str, Any]:
    print(f"Importing recording {recording_mbid}...")
    import_id = database.begin_import("recording", recording_mbid)
    try:
        song_id, song_name, credits = import_recording(api, database, recording_mbid)
        result = {
            "songId": song_id,
            "songName": song_name,
            "artists": [
                {"mbid": credit.mbid, "name": credit.name} for credit in credits
            ],
        }
        database.finish_import(import_id, "completed", result)
        return result
    except Exception as exc:
        database.finish_import(import_id, "failed", {"error": str(exc)})
        raise


def print_export_summary(summary: dict[str, int], output_path: Path) -> None:
    print(
        f"Exported {summary['artists']} artists, {summary['songs']} songs, and "
        f"{summary['songArtistLinks']} song-artist links to {output_path}."
    )


def create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG_PATH,
        help="Path to config.json (default: generator/config.json)",
    )

    subparsers = parser.add_subparsers(dest="command")

    build = subparsers.add_parser("build", help="Build from Last.fm top artists")
    build.add_argument("--top-artists", type=int)
    build.add_argument("--songs-per-artist", type=int)
    build.add_argument("--refresh-existing", action="store_true")
    build.add_argument("--pretty", action="store_true")
    build.add_argument(
        "--restart",
        action="store_true",
        help="Replace an existing build checkpoint and start a new build",
    )

    subparsers.add_parser("resume", help="Resume the saved build checkpoint")

    add_artist = subparsers.add_parser(
        "add-artist", help="Add the popular collaborations of one MusicBrainz artist"
    )
    add_artist.add_argument("artist", help="MusicBrainz artist MBID or URL")
    add_artist.add_argument("--songs", type=int)
    add_artist.add_argument("--refresh-existing", action="store_true")
    add_artist.add_argument("--pretty", action="store_true")

    add_song = subparsers.add_parser(
        "add-song", help="Add one MusicBrainz recording and all credited artists"
    )
    add_song.add_argument("recording", help="MusicBrainz recording MBID or URL")
    add_song.add_argument("--pretty", action="store_true")

    fill_minimum = subparsers.add_parser(
        "fill-minimum",
        help="Add collaborations until every stored artist reaches a minimum song count",
    )
    fill_minimum.add_argument(
        "--minimum-songs",
        type=int,
        default=2,
        help="Required distinct songs per artist (default: 2)",
    )
    fill_minimum.add_argument(
        "--ignore-0-songs",
        action="store_true",
        help="Ignore artists with zero songs and fill only partially connected artists",
    )
    fill_minimum.add_argument("--pretty", action="store_true")

    constant_grow = subparsers.add_parser(
        "constant-grow",
        help="Continuously grow progressive top-artist cohorts until interrupted",
    )
    constant_grow_target = constant_grow.add_mutually_exclusive_group()
    constant_grow_target.add_argument(
        "--coverage",
        type=float,
        help="Ranked Last.fm catalog fraction to scan per artist (default: 0.9)",
    )
    constant_grow_target.add_argument(
        "--songs",
        type=int,
        help="Fixed stored-song target for each artist instead of coverage",
    )
    constant_grow.add_argument(
        "--minimum-songs",
        type=int,
        default=2,
        help="Minimum distinct songs targeted by each fill batch (default: 2)",
    )
    constant_grow.add_argument(
        "--ignore-0-songs",
        action="store_true",
        help="Exclude disconnected artists from constant-grow fill batches",
    )
    constant_grow.add_argument(
        "--fill-batch-size",
        type=int,
        default=10,
        help="Underconnected artists processed between cohorts (default: 10)",
    )
    constant_grow.add_argument(
        "--export-every-recordings",
        type=int,
        default=25,
        help="Safety export after this many imported recordings (default: 25)",
    )
    constant_grow.add_argument(
        "--export-every-minutes",
        type=float,
        default=10,
        help="Safety export interval in minutes; 0 disables timed exports (default: 10)",
    )
    constant_grow.add_argument(
        "--idle-seconds",
        type=float,
        default=300,
        help="Refresh delay after reaching the available chart limit (default: 300)",
    )
    constant_grow.add_argument(
        "--restart",
        action="store_true",
        help="Restart the cohort schedule while preserving SQLite songs and track checks",
    )
    constant_grow.add_argument("--pretty", action="store_true")

    requests_parser = subparsers.add_parser(
        "process-requests", help="Import entries from generator/requests.json"
    )
    requests_parser.add_argument("--file", type=Path)
    requests_parser.add_argument("--refresh-existing", action="store_true")
    requests_parser.add_argument("--pretty", action="store_true")

    export = subparsers.add_parser("export", help="Regenerate static JSON from SQLite")
    export.add_argument("--pretty", action="store_true")

    dedupe = subparsers.add_parser(
        "dedupe",
        help="Find duplicate songs by title and credited artists",
    )
    dedupe.add_argument(
        "--apply",
        action="store_true",
        help="Merge duplicates into the oldest song ID and union their artist credits",
    )
    dedupe.add_argument("--pretty", action="store_true")

    subparsers.add_parser("validate", help="Validate SQLite graph integrity")
    subparsers.add_parser("stats", help="Display database counts")
    subparsers.add_parser("init", help="Create an empty database and output files")

    return parser


def command_needs_api(command: str) -> bool:
    return command in {
        "build",
        "resume",
        "add-artist",
        "add-song",
        "constant-grow",
        "fill-minimum",
        "process-requests",
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = create_parser()
    args = parser.parse_args(argv)
    command = args.command or "build"

    try:
        settings = load_settings(resolve_project_path(args.config))
        database = GraphDatabase(settings.database_path)
        api: ApiClient | None = ApiClient(settings) if command_needs_api(command) else None
        active_build_state: BuildState | None = None
        active_checkpoint_path: Path | None = None
        active_constant_grow_state: ConstantGrowState | None = None
        active_constant_grow_checkpoint_path: Path | None = None

        try:
            if command == "init":
                summary = database.export_json(settings)
                print_export_summary(summary, settings.output_path)
                print(f"Initialized SQLite database at {settings.database_path}.")

            elif command == "build":
                top_artists = require_positive_int(
                    getattr(args, "top_artists", None) or settings.top_artists,
                    "top_artists",
                )
                songs_per_artist = require_positive_int(
                    getattr(args, "songs_per_artist", None) or settings.songs_per_artist,
                    "songs_per_artist",
                )
                assert api is not None
                active_checkpoint_path = build_checkpoint_path(settings)
                if active_checkpoint_path.exists() and not args.restart:
                    raise GeneratorError(
                        f"A saved build checkpoint already exists at {active_checkpoint_path}. "
                        "Run the 'resume' command to continue it, or use 'build --restart' "
                        "to replace the checkpoint without deleting imported data."
                    )
                active_build_state = BuildState(
                    top_artist_count=top_artists,
                    songs_per_artist=songs_per_artist,
                    refresh_existing=bool(args.refresh_existing),
                    pretty_json=bool(args.pretty or settings.pretty_json),
                )
                write_build_checkpoint(
                    active_checkpoint_path, active_build_state, status="running"
                )
                summary = build_from_top_artists(
                    api,
                    database,
                    settings,
                    state=active_build_state,
                    checkpoint_path=active_checkpoint_path,
                )
                print("\nBuild summary:")
                print(json.dumps(summary.__dict__, indent=2))
                export_summary = database.export_json(
                    settings,
                    pretty_override=active_build_state.pretty_json,
                )
                print_export_summary(export_summary, settings.output_path)
                active_checkpoint_path.unlink(missing_ok=True)
                active_build_state = None
                active_checkpoint_path = None

            elif command == "resume":
                assert api is not None
                active_checkpoint_path = build_checkpoint_path(settings)
                active_build_state = read_build_checkpoint(active_checkpoint_path)
                if (
                    active_build_state.seeds
                    and active_build_state.next_artist_index
                    >= len(active_build_state.seeds)
                ):
                    print("Resuming build at the final export...")
                elif active_build_state.seeds:
                    print(
                        f"Resuming build at artist "
                        f"{active_build_state.next_artist_index + 1}/"
                        f"{len(active_build_state.seeds)}..."
                    )
                else:
                    print("Resuming build while resolving top artists...")
                write_build_checkpoint(
                    active_checkpoint_path, active_build_state, status="running"
                )
                summary = build_from_top_artists(
                    api,
                    database,
                    settings,
                    state=active_build_state,
                    checkpoint_path=active_checkpoint_path,
                )
                print("\nBuild summary:")
                print(json.dumps(summary.__dict__, indent=2))
                export_summary = database.export_json(
                    settings,
                    pretty_override=active_build_state.pretty_json,
                )
                print_export_summary(export_summary, settings.output_path)
                active_checkpoint_path.unlink(missing_ok=True)
                active_build_state = None
                active_checkpoint_path = None

            elif command == "add-artist":
                assert api is not None
                artist_mbid = extract_mbid(args.artist, "artist")
                song_count = require_positive_int(
                    args.songs or settings.songs_per_artist, "songs"
                )
                result = add_artist_by_mbid(
                    api,
                    database,
                    settings,
                    artist_mbid,
                    song_count,
                    refresh_existing=args.refresh_existing,
                )
                print(json.dumps(result, indent=2))
                export_summary = database.export_json(
                    settings, pretty_override=True if args.pretty else None
                )
                print_export_summary(export_summary, settings.output_path)

            elif command == "add-song":
                assert api is not None
                recording_mbid = extract_mbid(args.recording, "recording")
                result = add_song_by_mbid(api, database, recording_mbid)
                print(json.dumps(result, indent=2, ensure_ascii=False))
                export_summary = database.export_json(
                    settings, pretty_override=True if args.pretty else None
                )
                print_export_summary(export_summary, settings.output_path)

            elif command == "fill-minimum":
                assert api is not None
                minimum_songs = require_positive_int(
                    args.minimum_songs, "minimum_songs"
                )
                result = fill_artists_to_minimum(
                    api,
                    database,
                    settings,
                    minimum_song_count=minimum_songs,
                    ignore_zero_songs=bool(args.ignore_0_songs),
                )
                print(json.dumps(result, indent=2, ensure_ascii=False))
                export_summary = database.export_json(
                    settings, pretty_override=True if args.pretty else None
                )
                print_export_summary(export_summary, settings.output_path)
                report_path = settings.reports_path / "fill_minimum.json"
                if not result["completed"]:
                    print(
                        f"Could not bring every eligible artist to {minimum_songs} songs "
                        f"in this run. See {report_path} for the remaining artists."
                    )
                    return 1

            elif command == "constant-grow":
                assert api is not None
                active_constant_grow_checkpoint_path = constant_grow_checkpoint_path(
                    settings
                )
                if active_constant_grow_checkpoint_path.exists() and not args.restart:
                    active_constant_grow_state = read_constant_grow_checkpoint(
                        active_constant_grow_checkpoint_path
                    )
                    print(
                        f"Resuming constant-grow at the top-"
                        f"{active_constant_grow_state.cohort_size} cohort, artist "
                        f"{active_constant_grow_state.next_artist_index + 1}."
                    )
                else:
                    if args.restart:
                        active_constant_grow_checkpoint_path.unlink(missing_ok=True)
                    active_constant_grow_state = ConstantGrowState(
                        cohort_size=10,
                        coverage_target=require_coverage(
                            args.coverage if args.coverage is not None else 0.9
                        ),
                        minimum_song_count=require_positive_int(
                            args.minimum_songs, "minimum_songs"
                        ),
                        ignore_zero_songs=bool(args.ignore_0_songs),
                        fill_batch_size=require_positive_int(
                            args.fill_batch_size, "fill_batch_size"
                        ),
                        export_every_recordings=require_positive_int(
                            args.export_every_recordings,
                            "export_every_recordings",
                        ),
                        export_every_minutes=require_nonnegative_float(
                            args.export_every_minutes,
                            "export_every_minutes",
                        ),
                        idle_seconds=require_nonnegative_float(
                            args.idle_seconds,
                            "idle_seconds",
                        ),
                        pretty_json=bool(args.pretty or settings.pretty_json),
                        songs_per_artist=(
                            require_positive_int(args.songs, "songs")
                            if args.songs is not None
                            else None
                        ),
                    )
                    print(
                        "Starting constant-grow at the top-10 cohort. "
                        "Press Ctrl+C to stop safely."
                    )
                write_constant_grow_checkpoint(
                    active_constant_grow_checkpoint_path,
                    active_constant_grow_state,
                    status="running",
                )
                run_constant_grow(
                    api,
                    database,
                    settings,
                    active_constant_grow_state,
                    active_constant_grow_checkpoint_path,
                )

            elif command == "process-requests":
                assert api is not None
                request_path = (
                    resolve_project_path(args.file) if args.file else settings.request_file
                )
                artist_requests, song_requests = read_request_entries(request_path)
                print(
                    f"Processing {len(artist_requests)} artist requests and "
                    f"{len(song_requests)} song requests from {request_path}."
                )
                failures: list[dict[str, Any]] = []
                failed_requests_path = settings.reports_path / "failed_requests.json"
                write_failed_requests(
                    failed_requests_path,
                    failures,
                    command="process-requests",
                    source=str(request_path),
                )

                for artist_mbid, requested_songs in artist_requests:
                    try:
                        add_artist_by_mbid(
                            api,
                            database,
                            settings,
                            artist_mbid,
                            requested_songs or settings.songs_per_artist,
                            refresh_existing=args.refresh_existing,
                        )
                    except GeneratorError as exc:
                        failures.append(
                            {
                                "type": "artist",
                                "mbid": artist_mbid,
                                "songs": requested_songs or settings.songs_per_artist,
                                "refreshExisting": args.refresh_existing,
                                "failedAt": utc_now(),
                                "error": str(exc),
                            }
                        )
                        write_failed_requests(
                            failed_requests_path,
                            failures,
                            command="process-requests",
                            source=str(request_path),
                        )
                        print(f"Artist request failed: {artist_mbid}: {exc}")

                for recording_mbid in song_requests:
                    try:
                        add_song_by_mbid(api, database, recording_mbid)
                    except GeneratorError as exc:
                        failures.append(
                            {
                                "type": "recording",
                                "mbid": recording_mbid,
                                "failedAt": utc_now(),
                                "error": str(exc),
                            }
                        )
                        write_failed_requests(
                            failed_requests_path,
                            failures,
                            command="process-requests",
                            source=str(request_path),
                        )
                        print(f"Song request failed: {recording_mbid}: {exc}")

                write_json(
                    settings.reports_path / "last_request_run.json",
                    {
                        "generatedAt": utc_now(),
                        "artistRequestCount": len(artist_requests),
                        "songRequestCount": len(song_requests),
                        "failures": failures,
                    },
                    pretty=True,
                )
                export_summary = database.export_json(
                    settings, pretty_override=True if args.pretty else None
                )
                print_export_summary(export_summary, settings.output_path)
                if failures:
                    print(
                        f"Completed with {len(failures)} failed requests. See "
                        f"{failed_requests_path}."
                    )
                    return 1

            elif command == "export":
                summary = database.export_json(
                    settings, pretty_override=True if args.pretty else None
                )
                print_export_summary(summary, settings.output_path)

            elif command == "dedupe":
                duplicate_groups = database.find_duplicate_song_groups()
                if not args.apply:
                    print(
                        json.dumps(
                            {
                                "duplicateGroups": duplicate_groups,
                                "duplicateSongCount": sum(
                                    len(group["songs"]) - 1
                                    for group in duplicate_groups
                                ),
                            },
                            indent=2,
                            ensure_ascii=False,
                        )
                    )
                else:
                    merged = database.merge_duplicate_songs()
                    print(
                        json.dumps(
                            {
                                "mergedGroups": merged,
                                "removedSongCount": sum(
                                    len(group["removedSongIds"]) for group in merged
                                ),
                            },
                            indent=2,
                            ensure_ascii=False,
                        )
                    )
                    export_summary = database.export_json(
                        settings, pretty_override=True if args.pretty else None
                    )
                    print_export_summary(export_summary, settings.output_path)

            elif command == "validate":
                errors, warnings = database.validate()
                for warning in warnings:
                    print(f"WARNING: {warning}")
                for error in errors:
                    print(f"ERROR: {error}")
                if errors:
                    return 1
                print("Database validation passed.")

            elif command == "stats":
                print(json.dumps(database.get_stats(), indent=2))

            else:
                parser.error(f"Unknown command: {command}")

        except KeyboardInterrupt:
            database.commit()
            if active_build_state is not None and active_checkpoint_path is not None:
                write_build_checkpoint(
                    active_checkpoint_path, active_build_state, status="paused"
                )
            export_summary = database.export_json(
                settings,
                pretty_override=(
                    active_build_state.pretty_json
                    if active_build_state is not None
                    else (
                        active_constant_grow_state.pretty_json
                        if active_constant_grow_state is not None
                        else None
                    )
                ),
            )
            if (
                active_constant_grow_state is not None
                and active_constant_grow_checkpoint_path is not None
            ):
                active_constant_grow_state.recordings_since_export = 0
                active_constant_grow_state.last_export_at = utc_now()
                active_constant_grow_state.totals["exports"] += 1
                write_constant_grow_checkpoint(
                    active_constant_grow_checkpoint_path,
                    active_constant_grow_state,
                    status="paused",
                )
            print("\nGeneration paused. All imported data was committed to SQLite.")
            print_export_summary(export_summary, settings.output_path)
            if active_build_state is not None and active_checkpoint_path is not None:
                print(
                    f"Checkpoint saved to {active_checkpoint_path}. Resume with:\n"
                    "  python generator/database_generator.py resume"
                )
            elif (
                active_constant_grow_state is not None
                and active_constant_grow_checkpoint_path is not None
            ):
                print(
                    f"Checkpoint saved to {active_constant_grow_checkpoint_path}. "
                    "Resume with:\n"
                    "  python generator/database_generator.py constant-grow"
                )
            else:
                print("Rerun the same command later to continue from cached and stored data.")
            return 130

        finally:
            if api is not None:
                api.close()
            database.close()

    except (GeneratorError, ApiError, sqlite3.Error, OSError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
