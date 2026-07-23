from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "generator" / "database_generator.py"
SPEC = importlib.util.spec_from_file_location("database_generator", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

ArtistCredit = MODULE.ArtistCredit
BuildState = MODULE.BuildState
ConstantGrowState = MODULE.ConstantGrowState
GraphDatabase = MODULE.GraphDatabase
JsonCache = MODULE.JsonCache
Settings = MODULE.Settings
ApiClient = MODULE.ApiClient
extract_mbid = MODULE.extract_mbid
build_from_top_artists = MODULE.build_from_top_artists
fill_artists_to_minimum = MODULE.fill_artists_to_minimum
grow_artist_to_coverage = MODULE.grow_artist_to_coverage
grow_artist_to_song_count = MODULE.grow_artist_to_song_count
import_artist_collection = MODULE.import_artist_collection
import_recording = MODULE.import_recording
normalize_title = MODULE.normalize_title
normalize_title_version = MODULE.normalize_title_version
strip_bracketed_title_content = MODULE.strip_bracketed_title_content
next_constant_grow_cohort_size = MODULE.next_constant_grow_cohort_size
parse_artist_credits = MODULE.parse_artist_credits
read_request_entries = MODULE.read_request_entries
read_build_checkpoint = MODULE.read_build_checkpoint
read_constant_grow_checkpoint = MODULE.read_constant_grow_checkpoint
recording_match_rank = MODULE.recording_match_rank
resolve_lastfm_track_mbid = MODULE.resolve_lastfm_track_mbid
run_constant_grow = MODULE.run_constant_grow
write_build_checkpoint = MODULE.write_build_checkpoint
write_constant_grow_checkpoint = MODULE.write_constant_grow_checkpoint
write_failed_requests = MODULE.write_failed_requests


class GeneratorTests(unittest.TestCase):
    def make_settings(self, root: Path) -> Settings:
        return Settings(
            app_name="Test",
            app_version="1",
            contact="https://example.com",
            database_path=root / "generator" / "music_graph.db",
            cache_path=root / "generator" / "cache",
            output_path=root / "output",
            reports_path=root / "generator" / "reports",
            request_file=root / "generator" / "requests.json",
            top_artists=5,
            songs_per_artist=5,
            pretty_json=True,
            musicbrainz_min_interval_seconds=1.0,
            minimum_artist_match_score=90,
            include_orphan_artists_in_export=False,
        )

    def make_client(self, settings: Settings) -> ApiClient:
        with patch.dict(os.environ, {"LASTFM_API_KEY": "test-key"}):
            return ApiClient(settings)

    def test_stable_ids_and_exact_export_shape(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            settings = self.make_settings(root)
            database = GraphDatabase(settings.database_path)
            try:
                artist_a = database.upsert_artist(
                    "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387", "Ariana Grande"
                )
                artist_b = database.upsert_artist(
                    "c8b03190-306c-4120-bb0b-6f2ebfc06ea9", "The Weeknd"
                )
                self.assertEqual(
                    artist_a,
                    database.upsert_artist(
                        "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387", "Ariana Grande"
                    ),
                )

                song_id = database.upsert_song(
                    "3434d6d5-4a2b-4e3f-9f4b-87226f67685d", "Love Me Harder"
                )
                database.replace_song_artists(song_id, [artist_a, artist_b])
                database.commit()

                summary = database.export_json(settings)
                self.assertEqual(summary["artists"], 2)
                self.assertEqual(summary["songs"], 1)
                self.assertEqual(summary["songArtistLinks"], 2)

                main = json.loads((settings.output_path / "main.json").read_text())
                artists = json.loads((settings.output_path / "artists.json").read_text())
                songs = json.loads((settings.output_path / "songs.json").read_text())
                artist_songs = json.loads(
                    (settings.output_path / "artistSongs.json").read_text()
                )
                manifest = json.loads((settings.output_path / "manifest.json").read_text())

                self.assertEqual(main, {"data": {str(song_id): {"artists": [artist_a, artist_b]}}})
                self.assertEqual(artists["artists"][str(artist_a)], "Ariana Grande")
                self.assertEqual(songs["songs"][str(song_id)], "Love Me Harder")
                self.assertEqual(artist_songs["artistSongs"][str(artist_b)], [song_id])
                self.assertEqual(manifest["sources"]["popularity"], "Last.fm")
            finally:
                database.close()

    def test_build_checkpoint_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "build_checkpoint.json"
            state = BuildState(
                top_artist_count=5,
                songs_per_artist=10,
                refresh_existing=True,
                pretty_json=True,
                seeds=[
                    ArtistCredit(
                        "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387",
                        "Ariana Grande",
                    )
                ],
                next_artist_index=1,
            )
            state.totals["importedRecordings"] = 7
            state.failures.append({"type": "artist", "error": "test"})

            write_build_checkpoint(path, state, status="paused")
            restored = read_build_checkpoint(path)

            self.assertEqual(restored.top_artist_count, 5)
            self.assertEqual(restored.songs_per_artist, 10)
            self.assertTrue(restored.refresh_existing)
            self.assertTrue(restored.pretty_json)
            self.assertEqual(restored.seeds, state.seeds)
            self.assertEqual(restored.next_artist_index, 1)
            self.assertEqual(restored.totals["importedRecordings"], 7)
            self.assertEqual(restored.failures, state.failures)
            self.assertEqual(json.loads(path.read_text())["status"], "paused")

    def test_resumed_build_starts_at_saved_artist_index(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            settings = self.make_settings(root)
            database = GraphDatabase(settings.database_path)
            checkpoint = settings.reports_path / "build_checkpoint.json"
            first_artist = ArtistCredit(
                "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387", "Ariana Grande"
            )
            second_artist = ArtistCredit(
                "c8b03190-306c-4120-bb0b-6f2ebfc06ea9", "The Weeknd"
            )
            state = BuildState(
                top_artist_count=2,
                songs_per_artist=5,
                refresh_existing=False,
                pretty_json=False,
                seeds=[first_artist, second_artist],
                next_artist_index=1,
            )
            state.totals["candidateRecordings"] = 3
            result = {
                "candidateRecordings": 4,
                "keptRecordings": 2,
                "importedRecordings": 2,
                "alreadyPresentRecordings": 0,
                "skippedNonCollaborations": 2,
                "failedRecordings": 0,
            }
            try:
                with patch.object(
                    MODULE, "import_artist_collection", return_value=result
                ) as importer:
                    summary = build_from_top_artists(
                        Mock(),
                        database,
                        settings,
                        state=state,
                        checkpoint_path=checkpoint,
                    )

                self.assertEqual(importer.call_count, 1)
                self.assertEqual(importer.call_args.args[3], second_artist)
                self.assertEqual(state.next_artist_index, 2)
                self.assertEqual(summary.candidate_recordings, 7)
                self.assertEqual(summary.imported_recordings, 2)
                saved = json.loads(checkpoint.read_text())
                self.assertEqual(saved["status"], "export_pending")
                self.assertEqual(saved["nextArtistIndex"], 2)
            finally:
                database.close()

    def test_interrupted_artist_is_marked_paused_and_checkpointed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            settings = self.make_settings(root)
            database = GraphDatabase(settings.database_path)
            checkpoint = settings.reports_path / "build_checkpoint.json"
            state = BuildState(
                top_artist_count=1,
                songs_per_artist=5,
                refresh_existing=False,
                pretty_json=False,
                seeds=[
                    ArtistCredit(
                        "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387",
                        "Ariana Grande",
                    )
                ],
            )
            try:
                with patch.object(
                    MODULE, "import_artist_collection", side_effect=KeyboardInterrupt
                ):
                    with self.assertRaises(KeyboardInterrupt):
                        build_from_top_artists(
                            Mock(),
                            database,
                            settings,
                            state=state,
                            checkpoint_path=checkpoint,
                        )

                history = database.connection.execute(
                    "SELECT status FROM import_history ORDER BY id DESC LIMIT 1"
                ).fetchone()
                self.assertEqual(history["status"], "paused")
                saved = json.loads(checkpoint.read_text())
                self.assertEqual(saved["status"], "paused")
                self.assertEqual(saved["nextArtistIndex"], 0)
            finally:
                database.close()

    def test_ctrl_c_saves_checkpoint_and_exports_json(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config_path = root / "config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "app_name": "Test",
                        "app_version": "1",
                        "contact": "https://example.com",
                        "database_path": str(root / "generator" / "music_graph.db"),
                        "cache_path": str(root / "generator" / "cache"),
                        "output_path": str(root / "output"),
                        "reports_path": str(root / "generator" / "reports"),
                        "request_file": str(root / "generator" / "requests.json"),
                        "top_artists": 2,
                        "songs_per_artist": 5,
                    }
                ),
                encoding="utf-8",
            )
            fake_api = Mock()

            with patch.object(MODULE, "ApiClient", return_value=fake_api), patch.object(
                MODULE, "build_from_top_artists", side_effect=KeyboardInterrupt
            ):
                result = MODULE.main(
                    [
                        "--config",
                        str(config_path),
                        "build",
                        "--top-artists",
                        "2",
                        "--songs-per-artist",
                        "5",
                        "--pretty",
                    ]
                )

            self.assertEqual(result, 130)
            checkpoint = root / "generator" / "reports" / "build_checkpoint.json"
            self.assertEqual(json.loads(checkpoint.read_text())["status"], "paused")
            self.assertTrue((root / "output" / "main.json").exists())
            self.assertTrue((root / "output" / "manifest.json").exists())
            fake_api.close.assert_called_once()

    def test_validation_rejects_songs_with_one_artist(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            settings = self.make_settings(root)
            database = GraphDatabase(settings.database_path)
            try:
                artist_id = database.upsert_artist(
                    "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387", "Ariana Grande"
                )
                song_id = database.upsert_song(
                    "3434d6d5-4a2b-4e3f-9f4b-87226f67685d", "Solo Test"
                )
                database.replace_song_artists(song_id, [artist_id])
                database.commit()
                errors, _ = database.validate()
                self.assertTrue(any("fewer than two" in error for error in errors))
            finally:
                database.close()

    def test_duplicate_songs_merge_into_oldest_id_and_union_artists(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = self.make_settings(Path(temp))
            database = GraphDatabase(settings.database_path)
            primary_mbid = "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387"
            feature_a_mbid = "c8b03190-306c-4120-bb0b-6f2ebfc06ea9"
            feature_b_mbid = "a4a01f5d-18e7-4571-8c3a-76ec0e24e2d7"
            recording_a = "11111111-1111-4111-8111-111111111111"
            recording_b = "22222222-2222-4222-8222-222222222222"
            api = Mock()
            api.get_recording.side_effect = [
                {
                    "title": "Same Song",
                    "artist-credit": [
                        {"name": "Primary", "artist": {"id": primary_mbid}},
                        {"name": "Feature A", "artist": {"id": feature_a_mbid}},
                    ],
                },
                {
                    "title": "same-song",
                    "artist-credit": [
                        {"name": "Feature B", "artist": {"id": feature_b_mbid}},
                        {"name": "Primary", "artist": {"id": primary_mbid}},
                    ],
                },
            ]
            try:
                first_id, _, _ = import_recording(api, database, recording_a)
                second_id, _, _ = import_recording(api, database, recording_b)

                self.assertEqual(second_id, first_id)
                self.assertEqual(database.get_stats()["songs"], 1)
                self.assertTrue(database.has_song(recording_a))
                self.assertTrue(database.has_song(recording_b))
                self.assertTrue(database.song_contains_artist(recording_b, feature_a_mbid))
                self.assertTrue(database.song_contains_artist(recording_a, feature_b_mbid))
                self.assertEqual(
                    database.connection.execute(
                        "SELECT COUNT(*) FROM song_recordings WHERE song_id = ?",
                        (first_id,),
                    ).fetchone()[0],
                    2,
                )
                self.assertEqual(database.find_duplicate_song_groups(), [])
                errors, warnings = database.validate()
                self.assertEqual(errors, [])
                self.assertFalse(any("duplicate songs" in warning for warning in warnings))
            finally:
                database.close()

    def test_same_title_without_overlapping_artists_is_not_merged(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = self.make_settings(Path(temp))
            database = GraphDatabase(settings.database_path)
            artist_a = database.upsert_artist(
                "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387", "Artist A"
            )
            artist_b = database.upsert_artist(
                "c8b03190-306c-4120-bb0b-6f2ebfc06ea9", "Artist B"
            )
            artist_c = database.upsert_artist(
                "a4a01f5d-18e7-4571-8c3a-76ec0e24e2d7", "Artist C"
            )
            artist_d = database.upsert_artist(
                "9f6a2c03-0cbb-42e4-9722-b885939607cc", "Artist D"
            )
            song_a = database.upsert_song(
                "11111111-1111-4111-8111-111111111111", "Shared Title"
            )
            song_b = database.upsert_song(
                "22222222-2222-4222-8222-222222222222", "shared-title"
            )
            database.replace_song_artists(song_a, [artist_a, artist_b])
            database.replace_song_artists(song_b, [artist_c, artist_d])
            database.commit()
            try:
                self.assertEqual(database.find_duplicate_song_groups(), [])
                self.assertEqual(database.merge_duplicate_songs(), [])
                self.assertEqual(database.get_stats()["songs"], 2)
            finally:
                database.close()

    def test_similar_version_titles_with_same_artists_are_merged(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = self.make_settings(Path(temp))
            database = GraphDatabase(settings.database_path)
            artist_a_mbid = "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387"
            artist_b_mbid = "c8b03190-306c-4120-bb0b-6f2ebfc06ea9"
            recording_a = "11111111-1111-4111-8111-111111111111"
            recording_b = "22222222-2222-4222-8222-222222222222"
            api = Mock()
            api.get_recording.side_effect = [
                {
                    "title": "Old Town Road",
                    "artist-credit": [
                        {"name": "Lil Nas X", "artist": {"id": artist_a_mbid}},
                        {
                            "name": "Billy Ray Cyrus",
                            "artist": {"id": artist_b_mbid},
                        },
                    ],
                },
                {
                    "title": "Old Town Road (remix)",
                    "artist-credit": [
                        {
                            "name": "Billy Ray Cyrus",
                            "artist": {"id": artist_b_mbid},
                        },
                        {"name": "Lil Nas X", "artist": {"id": artist_a_mbid}},
                    ],
                },
            ]
            try:
                first_id, _, _ = import_recording(api, database, recording_a)
                second_id, _, _ = import_recording(api, database, recording_b)

                self.assertEqual(second_id, first_id)
                self.assertEqual(database.get_stats()["songs"], 1)
                self.assertTrue(database.has_song(recording_a))
                self.assertTrue(database.has_song(recording_b))
                self.assertEqual(database.find_duplicate_song_groups(), [])
            finally:
                database.close()

    def test_version_titles_merge_when_one_artist_set_is_a_subset(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = self.make_settings(Path(temp))
            database = GraphDatabase(settings.database_path)
            artist_a = database.upsert_artist(
                "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387", "Artist A"
            )
            artist_b = database.upsert_artist(
                "c8b03190-306c-4120-bb0b-6f2ebfc06ea9", "Artist B"
            )
            artist_c = database.upsert_artist(
                "a4a01f5d-18e7-4571-8c3a-76ec0e24e2d7", "Artist C"
            )
            song_a = database.upsert_song(
                "11111111-1111-4111-8111-111111111111", "Old Town Road"
            )
            song_b = database.upsert_song(
                "22222222-2222-4222-8222-222222222222",
                "Old Town Road (remix)",
            )
            database.replace_song_artists(song_a, [artist_a, artist_b])
            database.replace_song_artists(song_b, [artist_a, artist_b, artist_c])
            database.commit()
            try:
                duplicate_groups = database.find_duplicate_song_groups()
                self.assertEqual(len(duplicate_groups), 1)
                self.assertEqual(
                    [song["id"] for song in duplicate_groups[0]["songs"]],
                    [song_a, song_b],
                )

                merged = database.merge_duplicate_songs()

                self.assertEqual(len(merged), 1)
                self.assertEqual(merged[0]["canonicalSongId"], song_a)
                self.assertEqual(merged[0]["removedSongIds"], [song_b])
                self.assertEqual(database.get_stats()["songs"], 1)
                self.assertTrue(
                    database.song_contains_artist(
                        "11111111-1111-4111-8111-111111111111",
                        "a4a01f5d-18e7-4571-8c3a-76ec0e24e2d7",
                    )
                )
                self.assertTrue(
                    database.has_song("22222222-2222-4222-8222-222222222222")
                )
            finally:
                database.close()

    def test_bracketed_titles_merge_when_they_share_a_credited_artist(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = self.make_settings(Path(temp))
            database = GraphDatabase(settings.database_path)
            artist_a = database.upsert_artist(
                "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387", "Artist A"
            )
            artist_b = database.upsert_artist(
                "c8b03190-306c-4120-bb0b-6f2ebfc06ea9", "Artist B"
            )
            artist_c = database.upsert_artist(
                "a4a01f5d-18e7-4571-8c3a-76ec0e24e2d7", "Artist C"
            )
            song_a = database.upsert_song(
                "11111111-1111-4111-8111-111111111111", "One Last Time"
            )
            song_b = database.upsert_song(
                "22222222-2222-4222-8222-222222222222",
                "One Last Time (live version)",
            )
            database.replace_song_artists(song_a, [artist_a, artist_b])
            database.replace_song_artists(song_b, [artist_a, artist_c])
            database.commit()
            try:
                stored_name = database.connection.execute(
                    "SELECT name FROM songs WHERE id = ?", (song_b,)
                ).fetchone()[0]
                self.assertEqual(stored_name, "One Last Time")
                self.assertEqual(len(database.find_duplicate_song_groups()), 1)
                self.assertEqual(len(database.merge_duplicate_songs()), 1)
                self.assertEqual(database.get_stats()["songs"], 1)
                self.assertTrue(
                    database.song_contains_artist(
                        "11111111-1111-4111-8111-111111111111",
                        "a4a01f5d-18e7-4571-8c3a-76ec0e24e2d7",
                    )
                )
            finally:
                database.close()

    def test_numeric_sequel_is_not_a_fuzzy_duplicate(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = self.make_settings(Path(temp))
            database = GraphDatabase(settings.database_path)
            artist_a = database.upsert_artist(
                "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387", "Artist A"
            )
            artist_b = database.upsert_artist(
                "c8b03190-306c-4120-bb0b-6f2ebfc06ea9", "Artist B"
            )
            song_a = database.upsert_song(
                "11111111-1111-4111-8111-111111111111", "Love Story"
            )
            song_b = database.upsert_song(
                "22222222-2222-4222-8222-222222222222", "Love Story 2"
            )
            database.replace_song_artists(song_a, [artist_a, artist_b])
            database.replace_song_artists(song_b, [artist_a, artist_b])
            database.commit()
            try:
                self.assertEqual(database.find_duplicate_song_groups(), [])
                self.assertEqual(database.get_stats()["songs"], 2)
            finally:
                database.close()

    def test_title_version_normalization_ignores_all_bracketed_content(self) -> None:
        expected = normalize_title("Example Song")
        variants = [
            "Example Song (Nini & E.J. version)",
            "Example Song (Nini & E.J. vsersion)",
            "Example Song (Producer remix)",
            "Example (anything at all) Song",
            "Example Song [2024 remaster]",
            "Example Song {radio edit}",
            "Example Song (outer [nested] label)",
            "Example Song ()",
            "Example Song - acoustic version",
            "Example Song (From Example Movie)",
            "Example Song (album version) (2024 remaster)",
        ]

        for variant in variants:
            with self.subTest(variant=variant):
                self.assertEqual(normalize_title_version(variant), expected)

        self.assertEqual(
            normalize_title_version("Love the Way You Lie (Part II)"),
            normalize_title_version("Love the Way You Lie"),
        )
        self.assertEqual(
            normalize_title_version("One Last Time (Attends-moi)"),
            normalize_title_version("One Last Time"),
        )
        self.assertNotEqual(
            normalize_title_version(
                "I Think I Kinda, You Know - Just for a Moment Mashup"
            ),
            normalize_title_version("I Think I Kinda, You Know"),
        )
        self.assertEqual(
            strip_bracketed_title_content("Example (anything) Song [remix]"),
            "Example Song",
        )

    def test_artist_credit_parser_deduplicates(self) -> None:
        recording = {
            "artist-credit": [
                {
                    "name": "Artist A",
                    "artist": {
                        "id": "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387",
                        "name": "Artist A",
                    },
                },
                {
                    "name": "Artist A",
                    "artist": {
                        "id": "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387",
                        "name": "Artist A",
                    },
                },
                {
                    "name": "Artist B",
                    "artist": {
                        "id": "c8b03190-306c-4120-bb0b-6f2ebfc06ea9",
                        "name": "Artist B",
                    },
                },
            ]
        }
        self.assertEqual(
            parse_artist_credits(recording),
            [
                ArtistCredit(
                    "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387", "Artist A"
                ),
                ArtistCredit(
                    "c8b03190-306c-4120-bb0b-6f2ebfc06ea9", "Artist B"
                ),
            ],
        )

    def test_mbid_can_be_extracted_from_url(self) -> None:
        value = "https://musicbrainz.org/artist/f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387"
        self.assertEqual(
            extract_mbid(value, "artist"),
            "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387",
        )

    def test_lastfm_api_key_is_required(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = self.make_settings(Path(temp))
            with patch.dict(os.environ, {}, clear=True):
                with self.assertRaisesRegex(MODULE.GeneratorError, "LASTFM_API_KEY"):
                    ApiClient(settings)

    def test_lastfm_top_artist_and_track_requests(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            client = self.make_client(self.make_settings(Path(temp)))
            try:
                client._request_json = Mock(
                    side_effect=[
                        {
                            "artists": {
                                "artist": [
                                    {"name": "Artist A", "mbid": "artist-a"},
                                    {"name": "Artist B", "mbid": "artist-b"},
                                ]
                            }
                        },
                        {"toptracks": {"track": [{"name": "Track A", "mbid": ""}]}},
                    ]
                )

                artists = client.get_sitewide_top_artists(1)
                tracks = client.get_top_tracks_for_artist(
                    "Artist A", "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387", 100
                )

                self.assertEqual(artists, [{"name": "Artist A", "mbid": "artist-a"}])
                self.assertEqual(tracks, [{"name": "Track A", "mbid": ""}])
                first_call = client._request_json.call_args_list[0]
                self.assertEqual(first_call.args[0], MODULE.LASTFM_ROOT)
                self.assertEqual(first_call.kwargs["params"]["method"], "chart.gettopartists")
                self.assertEqual(first_call.kwargs["params"]["api_key"], "test-key")
                second_params = client._request_json.call_args_list[1].kwargs["params"]
                self.assertEqual(second_params["method"], "artist.gettoptracks")
                self.assertEqual(second_params["limit"], 100)
                self.assertEqual(second_params["autocorrect"], 1)
            finally:
                client.close()

    def test_lastfm_track_resolver_prefers_exact_normalized_title(self) -> None:
        api = Mock()
        api.search_recording.return_value = [
            {
                "id": "11111111-1111-4111-8111-111111111111",
                "title": "Love Me Harder (live)",
                "score": 100,
            },
            {
                "id": "22222222-2222-4222-8222-222222222222",
                "title": "LOVE-ME-HARDER",
                "score": 95,
            },
        ]

        result = resolve_lastfm_track_mbid(
            api,
            {"name": "Love Me Harder", "mbid": ""},
            "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387",
        )

        self.assertEqual(result, "22222222-2222-4222-8222-222222222222")
        self.assertEqual(normalize_title("LOVE-ME-HARDER"), "lovemeharder")

    def test_lastfm_track_resolver_replaces_a_stale_recording_mbid(self) -> None:
        api = Mock()
        stale_mbid = "151cc0ac-b1ec-4a70-8a74-9d89e2fef888"
        replacement_mbid = "22222222-2222-4222-8222-222222222222"
        api.get_recording.side_effect = MODULE.ApiError(
            "HTTP 404 from MusicBrainz", status_code=404
        )
        api.search_recording.return_value = [
            {"id": stale_mbid, "title": "Track Name", "score": 100},
            {"id": replacement_mbid, "title": "Track Name", "score": 95},
        ]

        result = resolve_lastfm_track_mbid(
            api,
            {"name": "Track Name", "mbid": stale_mbid},
            "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387",
        )

        self.assertEqual(result, replacement_mbid)
        api.get_recording.assert_called_once_with(stale_mbid)
        api.search_recording.assert_called_once_with(
            "Track Name", "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387"
        )

    def test_recording_resolver_prefers_standard_widely_released_collaboration(self) -> None:
        api = Mock()
        rihanna_mbid = "73e5e69d-3554-40d8-8516-00cb38737a1c"
        hins_cheung_mbid = "9f6a2c03-0cbb-42e4-9722-b885939607cc"
        neyo_mbid = "a4a01f5d-18e7-4571-8c3a-76ec0e24e2d7"
        cantonese_mbid = "235595c7-d5fe-44ae-8318-ab9f9fe1790a"
        standard_mbid = "711992bd-dfc8-4463-b4c3-a5edb610ab12"
        api.search_recording.return_value = [
            {
                "id": cantonese_mbid,
                "title": "Hate That I Love You",
                "score": 100,
                "disambiguation": "Cantonese version",
                "artist-credit": [
                    {"artist": {"id": rihanna_mbid}},
                    {"artist": {"id": hins_cheung_mbid}},
                ],
                "releases": [{"id": str(index)} for index in range(6)],
            },
            {
                "id": standard_mbid,
                "title": "Hate That I Love You",
                "score": 100,
                "artist-credit": [
                    {"artist": {"id": rihanna_mbid}},
                    {"artist": {"id": neyo_mbid}},
                ],
                "releases": [{"id": str(index)} for index in range(66)],
            },
        ]

        result = resolve_lastfm_track_mbid(
            api,
            {"name": "Hate That I Love You", "mbid": ""},
            rihanna_mbid,
        )

        self.assertEqual(result, standard_mbid)
        self.assertGreater(
            recording_match_rank(api.search_recording.return_value[1]),
            recording_match_rank(api.search_recording.return_value[0]),
        )

    def test_non_404_recording_error_does_not_trigger_fallback_search(self) -> None:
        api = Mock()
        api.get_recording.side_effect = MODULE.ApiError(
            "HTTP 503 from MusicBrainz", status_code=503
        )

        with self.assertRaises(MODULE.ApiError):
            resolve_lastfm_track_mbid(
                api,
                {
                    "name": "Track Name",
                    "mbid": "151cc0ac-b1ec-4a70-8a74-9d89e2fef888",
                },
                "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387",
            )

        api.search_recording.assert_not_called()

    def test_musicbrainz_recording_search_escapes_the_title(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            client = self.make_client(self.make_settings(Path(temp)))
            artist_mbid = "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387"
            client._request_json = Mock(return_value={"recordings": []})
            try:
                self.assertEqual(
                    client.search_recording('She Said "Hello"', artist_mbid), []
                )
                call = client._request_json.call_args
                self.assertEqual(call.args[0], f"{MODULE.MUSICBRAINZ_ROOT}/recording")
                self.assertEqual(
                    call.kwargs["params"]["query"],
                    f'recording:"She Said \\"Hello\\"" AND arid:{artist_mbid}',
                )
                self.assertTrue(call.kwargs["musicbrainz"])
            finally:
                client.close()

    def test_json_cache_hashes_long_keys_to_windows_safe_filenames(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cache = JsonCache(Path(temp) / "generator" / "cache")
            title = (
                "P.Y.T. (Pretty Young Thing) 2008 with will.i.am "
                "Thriller 25th Anniversary Remix Featuring will.i.am "
                "Thriller 25th Anniversary Remix Featuring will.i.am"
            )
            key = f"f27ec8db-af05-4f36-916e-3d57f91ecf5e|{title}|10"

            first_path = cache._path("musicbrainz_recording_search", key)
            second_path = cache._path("musicbrainz_recording_search", key)
            other_path = cache._path(
                "musicbrainz_recording_search", key + " different"
            )

            self.assertEqual(cache._path("example", "short-key").name, "short-key.json")
            self.assertEqual(first_path, second_path)
            self.assertNotEqual(first_path, other_path)
            self.assertLessEqual(
                len(first_path.stem), JsonCache.MAX_KEY_FILENAME_LENGTH
            )
            cache.write("musicbrainz_recording_search", key, {"ok": True})
            self.assertEqual(
                cache.read("musicbrainz_recording_search", key), {"ok": True}
            )
            self.assertFalse(first_path.with_suffix(".json.tmp").exists())

    def test_artist_import_requests_extra_lastfm_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = self.make_settings(Path(temp))
            database = GraphDatabase(settings.database_path)
            api = Mock()
            recording_mbid = "3434d6d5-4a2b-4e3f-9f4b-87226f67685d"
            artist_mbid = "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387"
            api.get_top_tracks_for_artist.return_value = [
                {"name": "Love Me Harder", "mbid": recording_mbid}
            ]
            api.get_recording.return_value = {
                "id": recording_mbid,
                "title": "Love Me Harder",
                "artist-credit": [
                    {"name": "Ariana Grande", "artist": {"id": artist_mbid}},
                    {
                        "name": "The Weeknd",
                        "artist": {"id": "c8b03190-306c-4120-bb0b-6f2ebfc06ea9"},
                    },
                ],
            }
            try:
                result = import_artist_collection(
                    api,
                    database,
                    settings,
                    ArtistCredit(artist_mbid, "Ariana Grande"),
                    5,
                )
                api.get_top_tracks_for_artist.assert_called_once_with(
                    "Ariana Grande", artist_mbid, 100
                )
                self.assertEqual(result["keptRecordings"], 1)
                self.assertEqual(result["importedRecordings"], 1)
            finally:
                database.close()

    def test_artist_import_reports_alternate_recording_without_counting_new_song(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = self.make_settings(Path(temp))
            database = GraphDatabase(settings.database_path)
            artist_mbid = "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387"
            partner_mbid = "c8b03190-306c-4120-bb0b-6f2ebfc06ea9"
            original_recording = "11111111-1111-4111-8111-111111111111"
            alternate_recording = "22222222-2222-4222-8222-222222222222"
            artist_id = database.upsert_artist(artist_mbid, "Ariana Grande")
            partner_id = database.upsert_artist(partner_mbid, "The Weeknd")
            song_id = database.upsert_song(original_recording, "Love Me Harder")
            database.replace_song_artists(song_id, [artist_id, partner_id])
            database.commit()
            api = Mock()
            api.get_top_tracks_for_artist.return_value = [
                {"name": "Love Me Harder (alternate)", "mbid": alternate_recording}
            ]
            api.get_recording.return_value = {
                "title": "Love Me Harder (alternate)",
                "artist-credit": [
                    {"name": "Ariana Grande", "artist": {"id": artist_mbid}},
                    {"name": "The Weeknd", "artist": {"id": partner_mbid}},
                ],
            }
            try:
                with (
                    patch.object(
                        MODULE,
                        "resolve_lastfm_track_mbid",
                        return_value=alternate_recording,
                    ),
                    patch("builtins.print") as output,
                ):
                    result = import_artist_collection(
                        api,
                        database,
                        settings,
                        ArtistCredit(artist_mbid, "Ariana Grande"),
                        2,
                    )

                messages = [str(call.args[0]) for call in output.call_args_list]
                self.assertEqual(result["importedRecordings"], 1)
                self.assertEqual(result["addedSongs"], 0)
                self.assertEqual(result["finalSongCount"], 1)
                self.assertEqual(result["scannedCandidates"], 1)
                self.assertFalse(result["targetReached"])
                self.assertEqual(database.get_stats()["songs"], 1)
                self.assertTrue(database.has_song(alternate_recording))
                self.assertTrue(
                    any("Matched alternate recording" in message for message in messages)
                )
                self.assertTrue(
                    any("Scanned 1/1 ranked tracks" in message for message in messages)
                )
                self.assertTrue(
                    any("candidates exhausted" in message for message in messages)
                )
            finally:
                database.close()

    def test_artist_import_reports_periodic_ranked_track_progress(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = self.make_settings(Path(temp))
            database = GraphDatabase(settings.database_path)
            artist = ArtistCredit(
                "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387", "Ariana Grande"
            )
            api = Mock()
            api.get_top_tracks_for_artist.return_value = [
                {"name": f"Track {index}"} for index in range(30)
            ]
            cached_result = {
                "status": "unresolved",
                "cached": True,
                "recordingMbid": None,
                "trackName": "cached",
            }
            try:
                with (
                    patch.object(
                        MODULE,
                        "check_artist_track_candidate",
                        return_value=cached_result,
                    ),
                    patch("builtins.print") as output,
                ):
                    result = import_artist_collection(
                        api, database, settings, artist, 10
                    )

                messages = [str(call.args[0]) for call in output.call_args_list]
                self.assertEqual(result["scannedCandidates"], 30)
                self.assertTrue(
                    any("Scanned 25/30 ranked tracks" in message for message in messages)
                )
                self.assertTrue(
                    any("Scanned 30/30 ranked tracks" in message for message in messages)
                )
            finally:
                database.close()

    def test_build_skips_artist_that_already_meets_song_target(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            settings = self.make_settings(root)
            database = GraphDatabase(settings.database_path)
            artist_mbid = "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387"
            other_artist_mbid = "c8b03190-306c-4120-bb0b-6f2ebfc06ea9"
            artist_id = database.upsert_artist(artist_mbid, "Ariana Grande")
            other_artist_id = database.upsert_artist(
                other_artist_mbid, "The Weeknd"
            )
            song_id = database.upsert_song(
                "3434d6d5-4a2b-4e3f-9f4b-87226f67685d", "Love Me Harder"
            )
            database.replace_song_artists(song_id, [artist_id, other_artist_id])
            database.commit()
            api = Mock()
            state = BuildState(
                top_artist_count=1,
                songs_per_artist=1,
                refresh_existing=False,
                pretty_json=False,
                seeds=[ArtistCredit(artist_mbid, "Ariana Grande")],
            )
            try:
                summary = build_from_top_artists(api, database, settings, state=state)

                api.get_top_tracks_for_artist.assert_not_called()
                self.assertEqual(summary.skipped_satisfied_artists, 1)
                self.assertEqual(summary.candidate_recordings, 0)
                self.assertEqual(summary.imported_recordings, 0)
                self.assertEqual(state.next_artist_index, 1)
                history = database.connection.execute(
                    "SELECT status, details FROM import_history ORDER BY id DESC LIMIT 1"
                ).fetchone()
                self.assertEqual(history["status"], "skipped")
                self.assertEqual(json.loads(history["details"])["existingSongCount"], 1)
            finally:
                database.close()

    def test_refresh_existing_bypasses_satisfied_artist_skip(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            settings = self.make_settings(root)
            database = GraphDatabase(settings.database_path)
            artist_mbid = "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387"
            other_artist_mbid = "c8b03190-306c-4120-bb0b-6f2ebfc06ea9"
            artist_id = database.upsert_artist(artist_mbid, "Ariana Grande")
            other_artist_id = database.upsert_artist(
                other_artist_mbid, "The Weeknd"
            )
            song_id = database.upsert_song(
                "3434d6d5-4a2b-4e3f-9f4b-87226f67685d", "Love Me Harder"
            )
            database.replace_song_artists(song_id, [artist_id, other_artist_id])
            database.commit()
            api = Mock()
            api.get_top_tracks_for_artist.return_value = []
            state = BuildState(
                top_artist_count=1,
                songs_per_artist=1,
                refresh_existing=True,
                pretty_json=False,
                seeds=[ArtistCredit(artist_mbid, "Ariana Grande")],
            )
            try:
                summary = build_from_top_artists(api, database, settings, state=state)

                api.get_top_tracks_for_artist.assert_called_once_with(
                    "Ariana Grande", artist_mbid, 100
                )
                self.assertEqual(summary.skipped_satisfied_artists, 0)
                history = database.connection.execute(
                    "SELECT status FROM import_history ORDER BY id DESC LIMIT 1"
                ).fetchone()
                self.assertEqual(history["status"], "completed")
            finally:
                database.close()

    def test_artist_import_fills_missing_distinct_song_gap(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = self.make_settings(Path(temp))
            database = GraphDatabase(settings.database_path)
            artist_mbid = "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387"
            existing_partner_mbid = "c8b03190-306c-4120-bb0b-6f2ebfc06ea9"
            new_partner_mbid = "a4a01f5d-18e7-4571-8c3a-76ec0e24e2d7"
            existing_recording = "3434d6d5-4a2b-4e3f-9f4b-87226f67685d"
            new_recording = "11111111-1111-4111-8111-111111111111"
            artist_id = database.upsert_artist(artist_mbid, "Ariana Grande")
            partner_id = database.upsert_artist(
                existing_partner_mbid, "The Weeknd"
            )
            song_id = database.upsert_song(existing_recording, "Love Me Harder")
            database.replace_song_artists(song_id, [artist_id, partner_id])
            database.commit()
            api = Mock()
            api.get_top_tracks_for_artist.return_value = [
                {"name": "Love Me Harder", "mbid": existing_recording},
                {"name": "New Collaboration", "mbid": new_recording},
            ]
            api.get_recording.return_value = {
                "id": new_recording,
                "title": "New Collaboration",
                "artist-credit": [
                    {"name": "Ariana Grande", "artist": {"id": artist_mbid}},
                    {"name": "New Partner", "artist": {"id": new_partner_mbid}},
                ],
            }
            try:
                with patch.object(
                    MODULE,
                    "resolve_lastfm_track_mbid",
                    side_effect=[existing_recording, new_recording],
                ):
                    result = import_artist_collection(
                        api,
                        database,
                        settings,
                        ArtistCredit(artist_mbid, "Ariana Grande"),
                        2,
                    )

                self.assertEqual(database.count_songs_for_artist(artist_mbid), 2)
                self.assertEqual(result["existingSongCount"], 1)
                self.assertEqual(result["finalSongCount"], 2)
                self.assertEqual(result["alreadyPresentRecordings"], 1)
                self.assertEqual(result["importedRecordings"], 1)
                api.get_recording.assert_called_once_with(new_recording)
            finally:
                database.close()

    def test_fill_minimum_rechecks_newly_discovered_artists(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            settings = self.make_settings(root)
            database = GraphDatabase(settings.database_path)
            artist_a_mbid = "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387"
            artist_b_mbid = "c8b03190-306c-4120-bb0b-6f2ebfc06ea9"
            artist_c_mbid = "a4a01f5d-18e7-4571-8c3a-76ec0e24e2d7"
            artist_d_mbid = "9f6a2c03-0cbb-42e4-9722-b885939607cc"
            artist_a = database.upsert_artist(artist_a_mbid, "Artist A")
            artist_b = database.upsert_artist(artist_b_mbid, "Artist B")
            shared_song = database.upsert_song(
                "11111111-1111-4111-8111-111111111111", "Shared Song"
            )
            database.replace_song_artists(shared_song, [artist_a, artist_b])
            database.commit()
            additions = {
                artist_a_mbid: (
                    artist_c_mbid,
                    "Artist C",
                    "22222222-2222-4222-8222-222222222222",
                ),
                artist_b_mbid: (
                    artist_d_mbid,
                    "Artist D",
                    "33333333-3333-4333-8333-333333333333",
                ),
                artist_c_mbid: (
                    artist_d_mbid,
                    "Artist D",
                    "44444444-4444-4444-8444-444444444444",
                ),
            }

            def fake_import(
                api: Mock,
                graph: GraphDatabase,
                settings: Settings,
                artist: ArtistCredit,
                target: int,
                **_: object,
            ) -> dict[str, int]:
                partner_mbid, partner_name, recording_mbid = additions[artist.mbid]
                artist_id = graph.upsert_artist(artist.mbid, artist.name)
                partner_id = graph.upsert_artist(partner_mbid, partner_name)
                song_id = graph.upsert_song(recording_mbid, f"{artist.name} collaboration")
                graph.replace_song_artists(song_id, [artist_id, partner_id])
                graph.commit()
                return {
                    "candidateRecordings": 1,
                    "keptRecordings": target,
                    "importedRecordings": 1,
                    "alreadyPresentRecordings": 0,
                    "skippedSatisfiedArtists": 0,
                    "skippedNonCollaborations": 0,
                    "failedRecordings": 0,
                    "existingSongCount": target - 1,
                    "finalSongCount": target,
                }

            try:
                with patch.object(
                    MODULE, "import_artist_collection", side_effect=fake_import
                ) as importer:
                    result = fill_artists_to_minimum(
                        Mock(), database, settings, minimum_song_count=2
                    )

                self.assertTrue(result["completed"])
                self.assertEqual(result["status"], "completed")
                self.assertEqual(result["passes"], 2)
                self.assertEqual(result["initialUnderfilledArtistCount"], 2)
                self.assertEqual(result["artistsAttempted"], 3)
                self.assertEqual(result["remainingArtistCount"], 0)
                self.assertEqual(importer.call_count, 3)
                self.assertEqual(database.get_artists_below_song_count(2), [])
                report = json.loads(
                    (settings.reports_path / "fill_minimum.json").read_text()
                )
                self.assertEqual(report["status"], "completed")
            finally:
                database.close()

    def test_fill_minimum_can_ignore_zero_song_artists(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            settings = self.make_settings(root)
            database = GraphDatabase(settings.database_path)
            orphan_mbid = "9f6a2c03-0cbb-42e4-9722-b885939607cc"
            artist_a_mbid = "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387"
            artist_b_mbid = "c8b03190-306c-4120-bb0b-6f2ebfc06ea9"
            database.upsert_artist(orphan_mbid, "Orphan Artist")
            artist_a = database.upsert_artist(artist_a_mbid, "Artist A")
            artist_b = database.upsert_artist(artist_b_mbid, "Artist B")
            first_song = database.upsert_song(
                "11111111-1111-4111-8111-111111111111", "First Song"
            )
            database.replace_song_artists(first_song, [artist_a, artist_b])
            database.commit()

            def add_second_song(
                api: Mock,
                graph: GraphDatabase,
                settings: Settings,
                artist: ArtistCredit,
                target: int,
                **_: object,
            ) -> dict[str, int]:
                second_song = graph.upsert_song(
                    "22222222-2222-4222-8222-222222222222", "Second Song"
                )
                graph.replace_song_artists(second_song, [artist_a, artist_b])
                graph.commit()
                return {
                    "candidateRecordings": 1,
                    "keptRecordings": target,
                    "importedRecordings": 1,
                    "alreadyPresentRecordings": 0,
                    "skippedSatisfiedArtists": 0,
                    "skippedNonCollaborations": 0,
                    "failedRecordings": 0,
                    "existingSongCount": 1,
                    "finalSongCount": 2,
                }

            try:
                with patch.object(
                    MODULE, "import_artist_collection", side_effect=add_second_song
                ) as importer:
                    result = fill_artists_to_minimum(
                        Mock(),
                        database,
                        settings,
                        minimum_song_count=2,
                        ignore_zero_songs=True,
                    )

                self.assertTrue(result["completed"])
                self.assertTrue(result["ignoreZeroSongs"])
                self.assertEqual(result["initialUnderfilledArtistCount"], 2)
                self.assertEqual(result["artistsAttempted"], 1)
                self.assertEqual(importer.call_count, 1)
                self.assertNotEqual(importer.call_args.args[3].mbid, orphan_mbid)
                self.assertEqual(database.count_songs_for_artist(orphan_mbid), 0)
                self.assertEqual(
                    database.get_artists_below_song_count(
                        2, ignore_zero_songs=True
                    ),
                    [],
                )
                self.assertEqual(
                    [
                        item["mbid"]
                        for item in database.get_artists_below_song_count(2)
                    ],
                    [orphan_mbid],
                )
                args = MODULE.create_parser().parse_args(
                    ["fill-minimum", "--ignore-0-songs"]
                )
                self.assertTrue(args.ignore_0_songs)
            finally:
                database.close()

    def test_fill_minimum_stops_when_a_pass_makes_no_progress(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            settings = self.make_settings(root)
            database = GraphDatabase(settings.database_path)
            artist_a = database.upsert_artist(
                "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387", "Artist A"
            )
            artist_b = database.upsert_artist(
                "c8b03190-306c-4120-bb0b-6f2ebfc06ea9", "Artist B"
            )
            song_id = database.upsert_song(
                "11111111-1111-4111-8111-111111111111", "Only Song"
            )
            database.replace_song_artists(song_id, [artist_a, artist_b])
            database.commit()
            no_progress = {
                "candidateRecordings": 0,
                "keptRecordings": 1,
                "importedRecordings": 0,
                "alreadyPresentRecordings": 0,
                "skippedSatisfiedArtists": 0,
                "skippedNonCollaborations": 0,
                "failedRecordings": 0,
                "existingSongCount": 1,
                "finalSongCount": 1,
            }
            try:
                with patch.object(
                    MODULE, "import_artist_collection", return_value=no_progress
                ):
                    result = fill_artists_to_minimum(
                        Mock(), database, settings, minimum_song_count=2
                    )

                self.assertFalse(result["completed"])
                self.assertEqual(result["status"], "stalled")
                self.assertEqual(result["passes"], 1)
                self.assertEqual(result["remainingArtistCount"], 2)
            finally:
                database.close()

    def test_constant_grow_cohorts_follow_one_two_five_sequence(self) -> None:
        cohorts = [10]
        for _ in range(6):
            cohorts.append(next_constant_grow_cohort_size(cohorts[-1]))

        self.assertEqual(cohorts, [10, 20, 50, 100, 200, 500, 1000])

    def test_constant_grow_accepts_a_fixed_song_target(self) -> None:
        args = MODULE.create_parser().parse_args(
            ["constant-grow", "--songs", "25"]
        )

        self.assertEqual(args.songs, 25)
        self.assertIsNone(args.coverage)

    def test_constant_grow_checkpoint_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            checkpoint = Path(temp) / "constant_grow_checkpoint.json"
            state = ConstantGrowState(
                cohort_size=50,
                coverage_target=0.9,
                minimum_song_count=2,
                ignore_zero_songs=True,
                fill_batch_size=7,
                export_every_recordings=25,
                export_every_minutes=10,
                idle_seconds=300,
                pretty_json=True,
                songs_per_artist=25,
                seeds=[
                    ArtistCredit(
                        "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387",
                        "Ariana Grande",
                    )
                ],
                next_artist_index=1,
                chart_total=1000,
                stages_completed=2,
                maintenance_cycles=1,
                recordings_since_export=3,
                last_export_at="2026-07-14T10:00:00Z",
            )
            state.totals["tracksImported"] = 11
            state.failures.append({"artistName": "Example", "error": "temporary"})

            write_constant_grow_checkpoint(checkpoint, state, status="paused")
            resumed = read_constant_grow_checkpoint(checkpoint)

            self.assertEqual(json.loads(checkpoint.read_text())["status"], "paused")
            self.assertEqual(resumed.cohort_size, 50)
            self.assertEqual(resumed.coverage_target, 0.9)
            self.assertEqual(resumed.songs_per_artist, 25)
            self.assertTrue(resumed.ignore_zero_songs)
            self.assertEqual(resumed.next_artist_index, 1)
            self.assertEqual(resumed.chart_total, 1000)
            self.assertEqual(resumed.stages_completed, 2)
            self.assertEqual(resumed.recordings_since_export, 3)
            self.assertEqual(resumed.totals["tracksImported"], 11)
            self.assertEqual(resumed.failures[0]["error"], "temporary")

    def test_artist_coverage_scans_ninety_percent_and_reuses_track_checks(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = self.make_settings(Path(temp))
            database = GraphDatabase(settings.database_path)
            artist = ArtistCredit(
                "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387", "Ariana Grande"
            )
            pages = {
                1: [
                    {"name": f"Track {index}", "url": f"https://last.fm/track/{index}"}
                    for index in range(1, 6)
                ],
                2: [
                    {"name": f"Track {index}", "url": f"https://last.fm/track/{index}"}
                    for index in range(6, 11)
                ],
            }
            api = Mock()

            def track_page(
                artist_name: str,
                artist_mbid: str,
                *,
                page: int,
                limit: int,
                refresh: bool,
            ) -> dict[str, object]:
                self.assertEqual(artist_name, artist.name)
                self.assertEqual(artist_mbid, artist.mbid)
                self.assertEqual(limit, 5)
                self.assertFalse(refresh)
                return {
                    "tracks": pages.get(page, []),
                    "page": page,
                    "perPage": 5,
                    "totalPages": 2,
                    "total": 10,
                }

            api.get_top_tracks_page_for_artist.side_effect = track_page
            examined: list[dict[str, object]] = []
            try:
                with patch.object(
                    MODULE, "resolve_lastfm_track_mbid", return_value=None
                ) as resolver:
                    first = grow_artist_to_coverage(
                        api,
                        database,
                        artist,
                        0.9,
                        page_size=5,
                        on_candidate=examined.append,
                    )
                    self.assertEqual(resolver.call_count, 9)

                self.assertEqual(first["targetCandidates"], 9)
                self.assertEqual(first["scannedCandidates"], 9)
                self.assertEqual(first["coverageAchieved"], 0.9)
                self.assertEqual(first["pagesScanned"], 2)
                self.assertEqual(first["newlyExamined"], 9)
                self.assertEqual(len(examined), 9)

                with patch.object(
                    MODULE, "resolve_lastfm_track_mbid", return_value=None
                ) as resolver:
                    second = grow_artist_to_coverage(
                        api, database, artist, 0.9, page_size=5
                    )
                    resolver.assert_not_called()

                self.assertEqual(second["newlyExamined"], 0)
                self.assertEqual(second["cachedCandidates"], 9)
                check_count = database.connection.execute(
                    "SELECT COUNT(*) FROM artist_track_checks"
                ).fetchone()[0]
                self.assertEqual(check_count, 9)
            finally:
                database.close()

    def test_artist_song_target_uses_collection_import(self) -> None:
        artist = ArtistCredit(
            "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387", "Ariana Grande"
        )
        callback = Mock()
        imported = {
            "candidateRecordings": 10,
            "keptRecordings": 7,
            "importedRecordings": 2,
            "alreadyPresentRecordings": 5,
            "skippedSatisfiedArtists": 0,
            "skippedNonCollaborations": 3,
            "failedRecordings": 0,
            "cachedTrackChecks": 4,
            "existingSongCount": 5,
            "finalSongCount": 7,
        }

        with patch.object(
            MODULE, "import_artist_collection", return_value=imported
        ) as importer:
            result = grow_artist_to_song_count(
                Mock(),
                Mock(),
                Mock(),
                artist,
                7,
                refresh_catalog=True,
                on_candidate=callback,
            )

        self.assertEqual(result["songTarget"], 7)
        self.assertEqual(result["storedSongCount"], 7)
        importer.assert_called_once()
        self.assertEqual(importer.call_args.args[3], artist)
        self.assertEqual(importer.call_args.args[4], 7)
        self.assertTrue(importer.call_args.kwargs["refresh_catalog"])
        self.assertIs(importer.call_args.kwargs["on_candidate"], callback)

    def test_solo_track_outcome_is_saved_and_not_checked_twice(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = self.make_settings(Path(temp))
            database = GraphDatabase(settings.database_path)
            artist_mbid = "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387"
            recording_mbid = "3434d6d5-4a2b-4e3f-9f4b-87226f67685d"
            artist = ArtistCredit(artist_mbid, "Ariana Grande")
            candidate = {
                "name": "Solo Track",
                "mbid": recording_mbid,
                "url": "https://last.fm/track/solo",
            }
            api = Mock()
            api.get_top_tracks_for_artist.return_value = [candidate]
            api.get_recording.return_value = {
                "id": recording_mbid,
                "title": "Solo Track",
                "artist-credit": [
                    {"name": artist.name, "artist": {"id": artist.mbid}}
                ],
            }
            try:
                with patch.object(
                    MODULE,
                    "resolve_lastfm_track_mbid",
                    return_value=recording_mbid,
                ) as resolver:
                    first = import_artist_collection(
                        api, database, settings, artist, 2
                    )
                    second = import_artist_collection(
                        api, database, settings, artist, 2
                    )

                self.assertEqual(resolver.call_count, 1)
                self.assertEqual(api.get_recording.call_count, 1)
                self.assertEqual(first["skippedNonCollaborations"], 1)
                self.assertEqual(second["cachedTrackChecks"], 1)
                self.assertEqual(second["skippedNonCollaborations"], 1)
                self.assertEqual(database.count_songs_for_artist(artist_mbid), 0)
                check = database.connection.execute(
                    """
                    SELECT status, attempt_count, recording_mbid
                    FROM artist_track_checks
                    WHERE artist_mbid = ?
                    """,
                    (artist_mbid,),
                ).fetchone()
                self.assertEqual(check["status"], "solo")
                self.assertEqual(check["attempt_count"], 1)
                self.assertEqual(check["recording_mbid"], recording_mbid)
            finally:
                database.close()

    def test_cached_import_is_replayed_as_existing_not_newly_imported(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = self.make_settings(Path(temp))
            database = GraphDatabase(settings.database_path)
            artist_mbid = "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387"
            partner_mbid = "c8b03190-306c-4120-bb0b-6f2ebfc06ea9"
            recording_mbid = "3434d6d5-4a2b-4e3f-9f4b-87226f67685d"
            artist = ArtistCredit(artist_mbid, "Ariana Grande")
            candidate = {"name": "Love Me Harder", "mbid": recording_mbid}
            api = Mock()
            api.get_top_tracks_for_artist.return_value = [candidate]
            api.get_recording.return_value = {
                "id": recording_mbid,
                "title": "Love Me Harder",
                "artist-credit": [
                    {"name": artist.name, "artist": {"id": artist.mbid}},
                    {"name": "The Weeknd", "artist": {"id": partner_mbid}},
                ],
            }
            try:
                with patch.object(
                    MODULE,
                    "resolve_lastfm_track_mbid",
                    return_value=recording_mbid,
                ) as resolver:
                    first = import_artist_collection(
                        api, database, settings, artist, 2
                    )
                    second = import_artist_collection(
                        api, database, settings, artist, 2
                    )

                self.assertEqual(resolver.call_count, 1)
                self.assertEqual(first["importedRecordings"], 1)
                self.assertEqual(second["importedRecordings"], 0)
                self.assertEqual(second["alreadyPresentRecordings"], 1)
                self.assertEqual(second["cachedTrackChecks"], 1)
                self.assertEqual(database.count_songs_for_artist(artist_mbid), 1)
            finally:
                database.close()

    def test_constant_grow_runs_one_bounded_stage_and_exports(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            settings = self.make_settings(root)
            database = GraphDatabase(settings.database_path)
            checkpoint = settings.reports_path / "constant_grow_checkpoint.json"
            artist = ArtistCredit(
                "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387", "Ariana Grande"
            )
            state = ConstantGrowState(
                cohort_size=10,
                coverage_target=0.9,
                minimum_song_count=2,
                ignore_zero_songs=True,
                fill_batch_size=1,
                export_every_recordings=25,
                export_every_minutes=10,
                idle_seconds=0,
                pretty_json=True,
            )
            api = Mock()
            api.get_sitewide_top_artists_snapshot.return_value = {
                "artists": [{"name": artist.name, "mbid": artist.mbid}],
                "total": 100,
                "pagesFetched": 1,
            }
            artist_result = {
                "artistMbid": artist.mbid,
                "artistName": artist.name,
                "reportedTrackTotal": 10,
                "coverageTarget": 0.9,
                "targetCandidates": 9,
                "scannedCandidates": 9,
                "coverageAchieved": 0.9,
                "newlyExamined": 0,
                "cachedCandidates": 9,
                "pagesScanned": 1,
                "statusCounts": {"solo": 9},
                "storedSongCount": 0,
            }
            fill_result = {
                "minimumSongs": 2,
                "ignoreZeroSongs": True,
                "batchSize": 1,
                "artistsAttempted": 1,
                "artistsImproved": 0,
                "importedRecordings": 0,
                "failures": [],
                "remainingArtistCount": 1,
            }
            try:
                with (
                    patch.object(
                        MODULE,
                        "resolve_seed_artist_items",
                        return_value=([artist], []),
                    ),
                    patch.object(
                        MODULE,
                        "grow_artist_to_coverage",
                        return_value=artist_result,
                    ) as grow,
                    patch.object(
                        MODULE,
                        "fill_underconnected_artist_batch",
                        return_value=fill_result,
                    ) as fill,
                ):
                    report = run_constant_grow(
                        api,
                        database,
                        settings,
                        state,
                        checkpoint,
                        max_stages=1,
                    )

                grow.assert_called_once()
                fill.assert_called_once()
                self.assertEqual(report["completedCohort"], 10)
                self.assertEqual(report["nextCohort"], 20)
                self.assertEqual(report["growthMode"], "coverage")
                self.assertEqual(state.cohort_size, 20)
                self.assertEqual(state.stages_completed, 1)
                self.assertEqual(state.totals["exports"], 1)
                self.assertTrue(checkpoint.exists())
                self.assertTrue((settings.reports_path / "constant_grow.json").exists())
                self.assertTrue((settings.output_path / "main.json").exists())
                saved = json.loads(checkpoint.read_text())
                self.assertEqual(saved["cohortSize"], 20)
                self.assertEqual(saved["status"], "running")
            finally:
                database.close()

    def test_constant_grow_dispatches_to_fixed_song_mode(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            settings = self.make_settings(root)
            database = GraphDatabase(settings.database_path)
            checkpoint = settings.reports_path / "constant_grow_checkpoint.json"
            artist = ArtistCredit(
                "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387", "Ariana Grande"
            )
            state = ConstantGrowState(
                cohort_size=10,
                coverage_target=0.9,
                minimum_song_count=2,
                ignore_zero_songs=True,
                fill_batch_size=1,
                export_every_recordings=25,
                export_every_minutes=10,
                idle_seconds=0,
                pretty_json=True,
                songs_per_artist=6,
                seeds=[artist],
                chart_total=100,
            )
            artist_result = {
                "artistMbid": artist.mbid,
                "artistName": artist.name,
                "songTarget": 6,
                "candidateRecordings": 8,
                "importedRecordings": 2,
                "finalSongCount": 6,
                "storedSongCount": 6,
            }
            fill_result = {
                "minimumSongs": 2,
                "ignoreZeroSongs": True,
                "batchSize": 1,
                "artistsAttempted": 0,
                "artistsImproved": 0,
                "importedRecordings": 0,
                "failures": [],
                "remainingArtistCount": 0,
            }
            try:
                with (
                    patch.object(
                        MODULE,
                        "grow_artist_to_song_count",
                        return_value=artist_result,
                    ) as fixed_grow,
                    patch.object(MODULE, "grow_artist_to_coverage") as coverage_grow,
                    patch.object(
                        MODULE,
                        "fill_underconnected_artist_batch",
                        return_value=fill_result,
                    ),
                ):
                    report = run_constant_grow(
                        Mock(),
                        database,
                        settings,
                        state,
                        checkpoint,
                        max_stages=1,
                    )

                fixed_grow.assert_called_once()
                coverage_grow.assert_not_called()
                self.assertEqual(fixed_grow.call_args.args[4], 6)
                self.assertEqual(report["songsPerArtist"], 6)
                self.assertEqual(report["growthMode"], "songs")
                self.assertEqual(report["lastArtistResults"], [artist_result])
                saved = json.loads(checkpoint.read_text())
                self.assertEqual(saved["songsPerArtist"], 6)
                self.assertEqual(saved["growthMode"], "songs")
            finally:
                database.close()

    def test_transient_server_errors_are_retried(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = self.make_settings(Path(temp))
            client = self.make_client(settings)
            failed_response = SimpleNamespace(
                status_code=500,
                url=MODULE.LASTFM_ROOT,
                text="temporarily unavailable",
                headers={},
                ok=False,
            )
            successful_response = SimpleNamespace(
                status_code=200,
                url=MODULE.LASTFM_ROOT,
                text='{"ok": true}',
                headers={},
                ok=True,
                json=lambda: {"ok": True},
            )
            client.session = Mock()
            client.session.get.side_effect = [
                failed_response,
                failed_response,
                successful_response,
            ]

            with patch.object(MODULE.time, "sleep") as sleep:
                result = client._request_json(
                    MODULE.LASTFM_ROOT, attempts=3
                )

            self.assertEqual(result, {"ok": True})
            self.assertEqual([call.args[0] for call in sleep.call_args_list], [2.0, 4.0])

    def test_http_errors_expose_the_status_code(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            client = self.make_client(self.make_settings(Path(temp)))
            client.session = Mock()
            client.session.get.return_value = SimpleNamespace(
                status_code=404,
                url=f"{MODULE.MUSICBRAINZ_ROOT}/recording/missing",
                text='{"error":"Not Found"}',
                headers={},
                ok=False,
            )
            try:
                with self.assertRaises(MODULE.ApiError) as raised:
                    client._request_json(
                        f"{MODULE.MUSICBRAINZ_ROOT}/recording/missing",
                        musicbrainz=True,
                    )
                self.assertEqual(raised.exception.status_code, 404)
            finally:
                client.close()

    def test_failed_requests_file_can_be_processed_again(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "failed_requests.json"
            artist_mbid = "f4fdbb4c-e4b7-47a0-b83b-d91bbfcfa387"
            recording_mbid = "3434d6d5-4a2b-4e3f-9f4b-87226f67685d"
            write_failed_requests(
                path,
                [
                    {
                        "type": "artist",
                        "mbid": artist_mbid,
                        "songs": 25,
                        "failedAt": "2026-01-01T00:00:00Z",
                        "error": "HTTP 500",
                    },
                    {
                        "type": "recording",
                        "mbid": recording_mbid,
                        "failedAt": "2026-01-01T00:00:00Z",
                        "error": "HTTP 500",
                    },
                ],
                command="process-requests",
            )

            artists, songs = read_request_entries(path)
            self.assertEqual(artists, [(artist_mbid, 25)])
            self.assertEqual(songs, [recording_mbid])


if __name__ == "__main__":
    unittest.main()
