(() => {
    "use strict";

    const REQUIRED_CONNECTIONS_MIN = 1;
    const REQUIRED_CONNECTIONS_MAX = 3;
    const REQUIRED_LINKED_SONGS = 50;
    const MIN_COLLABORATORS_TO_SONGS_RATIO = 0.15;
    const DAILY_CHALLENGES_FORMAT_VERSION = 1;
    const DATE_KEY_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
    let cachedSavedTableReference;
    let cachedSavedTableResult;

    function isValidDateKey(dateKey) {
        if (typeof dateKey !== "string" || !DATE_KEY_PATTERN.test(dateKey)) return false;

        const parsedDate = new Date(`${dateKey}T00:00:00.000Z`);
        return !Number.isNaN(parsedDate.getTime())
            && parsedDate.toISOString().slice(0, 10) === dateKey;
    }

    function getUtcDateKey(date = new Date()) {
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
            throw new TypeError("A valid Date is required.");
        }

        return date.toISOString().slice(0, 10);
    }

    function getDateKey(value = new Date()) {
        if (value instanceof Date) return getUtcDateKey(value);
        if (isValidDateKey(value)) return value;
        throw new RangeError("A real date in YYYY-MM-DD format is required.");
    }

    function shiftUtcDateKey(dateKey, days) {
        const date = new Date(`${dateKey}T00:00:00.000Z`);
        date.setUTCDate(date.getUTCDate() + days);
        return getUtcDateKey(date);
    }

    function createSeededRandom(seed) {
        let state = 2166136261;

        for (let index = 0; index < seed.length; index += 1) {
            state ^= seed.charCodeAt(index);
            state = Math.imul(state, 16777619);
        }

        return () => {
            state = (state + 0x6D2B79F5) | 0;
            let value = state;
            value = Math.imul(value ^ (value >>> 15), value | 1);
            value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
            return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
        };
    }

    function compareArtistIds(left, right) {
        const leftNumber = Number(left);
        const rightNumber = Number(right);
        const bothNumeric = Number.isFinite(leftNumber) && Number.isFinite(rightNumber);

        if (bothNumeric && leftNumber !== rightNumber) return leftNumber - rightNumber;
        return left < right ? -1 : left > right ? 1 : 0;
    }

    function shuffle(values, random) {
        const result = [...values];

        for (let index = result.length - 1; index > 0; index -= 1) {
            const swapIndex = Math.floor(random() * (index + 1));
            [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
        }

        return result;
    }

    function assertDatabase(database) {
        const isFullDatabase = database
            && typeof database.artists === "object"
            && typeof database.artistSongs === "object"
            && typeof database.songData === "object";
        const isRouteDatabase = database
            && Array.isArray(database.records)
            && Array.isArray(database.adjacency);
        if (!isFullDatabase && !isRouteDatabase) {
            throw new TypeError("A valid Songaveler database is required.");
        }
    }

    function getSavedTable() {
        const table = globalThis.SongavelerDailyChallenges;
        if (table === cachedSavedTableReference) return cachedSavedTableResult;
        if (table == null) return null;

        if (
            typeof table !== "object"
            || table.formatVersion !== DAILY_CHALLENGES_FORMAT_VERSION
            || !isValidDateKey(table.firstDate)
            || !table.entries
            || typeof table.entries !== "object"
            || Array.isArray(table.entries)
        ) {
            throw new TypeError("The saved Daily Challenge table is invalid.");
        }

        const dates = Object.keys(table.entries).sort();
        if (dates.length === 0 || dates[0] !== table.firstDate) {
            throw new TypeError("The saved Daily Challenge table has an invalid first date.");
        }

        let expectedDate = table.firstDate;
        for (const dateKey of dates) {
            const challenge = table.entries[dateKey];
            if (dateKey !== expectedDate) {
                throw new TypeError("The saved Daily Challenge table must be contiguous.");
            }
            if (
                !isValidDateKey(dateKey)
                || !challenge
                || typeof challenge !== "object"
                || typeof challenge.startId !== "string"
                || challenge.startId.length === 0
                || typeof challenge.endId !== "string"
                || challenge.endId.length === 0
                || challenge.startId === challenge.endId
                || typeof challenge.startName !== "string"
                || challenge.startName.length === 0
                || typeof challenge.endName !== "string"
                || challenge.endName.length === 0
                || !Number.isInteger(challenge.requiredConnections)
                || challenge.requiredConnections < REQUIRED_CONNECTIONS_MIN
                || challenge.requiredConnections > REQUIRED_CONNECTIONS_MAX
                || !Number.isInteger(challenge.requiredLinkedSongs)
                || challenge.requiredLinkedSongs < 1
                || typeof challenge.sourceDatabaseGeneratedAt !== "string"
                || challenge.sourceDatabaseGeneratedAt.length === 0
            ) {
                throw new TypeError(`The saved Daily Challenge for ${dateKey} is invalid.`);
            }
            expectedDate = shiftUtcDateKey(expectedDate, 1);
        }

        cachedSavedTableReference = table;
        cachedSavedTableResult = { table, dates };
        return cachedSavedTableResult;
    }

    function getSaved(dateKey) {
        if (!isValidDateKey(dateKey)) return null;

        const savedTable = getSavedTable();
        const saved = savedTable?.table.entries[dateKey];
        if (!saved) return null;

        return Object.freeze({
            dateKey,
            startId: saved.startId,
            endId: saved.endId,
            startName: saved.startName,
            endName: saved.endName,
            requiredConnections: saved.requiredConnections,
            requiredLinkedSongs: saved.requiredLinkedSongs,
            sourceDatabaseGeneratedAt: saved.sourceDatabaseGeneratedAt,
            source: "saved"
        });
    }

    function getBounds(todayOrDate = new Date()) {
        const savedTable = getSavedTable();
        if (!savedTable) return null;

        const todayKey = getDateKey(todayOrDate);
        return Object.freeze({
            firstDate: savedTable.table.firstDate,
            lastSavedDate: savedTable.dates.at(-1),
            maxArchiveDate: shiftUtcDateKey(todayKey, -1)
        });
    }

    function findArtistDistances(
        database,
        startId,
        maximumDistance,
        routeRecordsById = null
    ) {
        const startKey = String(startId);
        const distances = new Map([[startKey, 0]]);
        const queue = [startKey];

        for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
            const artistId = queue[queueIndex];
            const distance = distances.get(artistId);
            if (distance >= maximumDistance) continue;

            if (routeRecordsById) {
                for (const nextArtistId of database.adjacency[Number(artistId)] || []) {
                    const nextId = String(nextArtistId);
                    if (distances.has(nextId)) continue;

                    distances.set(nextId, distance + 1);
                    if (routeRecordsById.get(nextId)?.[2] !== 1) queue.push(nextId);
                }
                continue;
            }

            for (const songId of database.artistSongs[artistId] || []) {
                for (const nextArtistId of database.songData[songId]?.artists || []) {
                    const nextId = String(nextArtistId);
                    if (distances.has(nextId)) continue;

                    distances.set(nextId, distance + 1);

                    // Artists linked to only one song are valid endpoints but not bridges.
                    if ((database.artistSongs[nextId] || []).length !== 1) {
                        queue.push(nextId);
                    }
                }
            }
        }

        return distances;
    }

    function getCollaboratorCount(database, artistId, routeRecordsById) {
        if (routeRecordsById) {
            return (database.adjacency[Number(artistId)] || []).length;
        }

        const collaborators = new Set();
        for (const songId of database.artistSongs[artistId] || []) {
            for (const nextArtistId of database.songData[songId]?.artists || []) {
                const nextId = String(nextArtistId);
                if (nextId !== artistId) collaborators.add(nextId);
            }
        }
        return collaborators.size;
    }

    function getCandidatePools(database, candidates, routeRecordsById) {
        const preferredCandidates = candidates.filter(artistId => {
            const songCount = routeRecordsById
                ? Number(routeRecordsById.get(artistId)?.[2])
                : (database.artistSongs[artistId] || []).length;
            const collaboratorCount = getCollaboratorCount(
                database,
                artistId,
                routeRecordsById
            );
            return collaboratorCount / songCount > MIN_COLLABORATORS_TO_SONGS_RATIO;
        });

        return preferredCandidates.length > 0 && preferredCandidates.length < candidates.length
            ? [preferredCandidates, candidates]
            : [candidates];
    }

    function generate(database, dateKey) {
        assertDatabase(database);

        if (!isValidDateKey(dateKey)) {
            throw new RangeError("The challenge date must be a real date in YYYY-MM-DD format.");
        }

        const routeRecordsById = Array.isArray(database.records)
            ? new Map(database.records.map(record => [String(record[0]), record]))
            : null;
        const candidates = routeRecordsById
            ? database.records
                .filter(record => (
                    typeof record[1] === "string"
                    && record[1].length > 0
                    && record[2] >= REQUIRED_LINKED_SONGS
                ))
                .map(record => String(record[0]))
                .sort(compareArtistIds)
            : Object.keys(database.artists)
                .filter(id => (
                    typeof database.artists[id] === "string"
                    && database.artists[id].length > 0
                    && (database.artistSongs[id] || []).length >= REQUIRED_LINKED_SONGS
                ))
                .sort(compareArtistIds);
        const connectionCounts = Array.from(
            { length: REQUIRED_CONNECTIONS_MAX - REQUIRED_CONNECTIONS_MIN + 1 },
            (_, index) => REQUIRED_CONNECTIONS_MIN + index
        );
        const connectionOrder = shuffle(
            connectionCounts,
            createSeededRandom(`${dateKey}:connection-count`)
        );
        const candidatePools = getCandidatePools(database, candidates, routeRecordsById);

        for (const requiredConnections of connectionOrder) {
            for (const [poolIndex, candidatePool] of candidatePools.entries()) {
                const random = createSeededRandom(
                    `${dateKey}:${requiredConnections}:candidate-pool-${poolIndex}`
                );
                for (const startId of shuffle(candidatePool, random)) {
                    const distances = findArtistDistances(
                        database,
                        startId,
                        requiredConnections,
                        routeRecordsById
                    );
                    const possibleEnds = candidatePool.filter(endId => (
                        endId !== startId
                        && distances.get(endId) === requiredConnections
                    ));

                    if (possibleEnds.length > 0) {
                        const endId = possibleEnds[Math.floor(random() * possibleEnds.length)];
                        const startCollaboratorCount = getCollaboratorCount(
                            database,
                            startId,
                            routeRecordsById
                        );
                        const endCollaboratorCount = getCollaboratorCount(
                            database,
                            endId,
                            routeRecordsById
                        );
                        const [challengeStartId, challengeEndId] = startCollaboratorCount
                            > endCollaboratorCount
                            ? [endId, startId]
                            : [startId, endId];
                        return Object.freeze({
                            dateKey,
                            startId: challengeStartId,
                            endId: challengeEndId,
                            requiredConnections,
                            requiredLinkedSongs: REQUIRED_LINKED_SONGS
                        });
                    }
                }
            }
        }

        return null;
    }

    function resolve(database, dateKey) {
        if (!isValidDateKey(dateKey)) {
            throw new RangeError("The challenge date must be a real date in YYYY-MM-DD format.");
        }

        return getSaved(dateKey) || generate(database, dateKey);
    }

    function resolveArchive(database, dateKey, todayOrDate = new Date()) {
        if (!isValidDateKey(dateKey)) return null;

        const bounds = getBounds(todayOrDate);
        if (
            !bounds
            || dateKey < bounds.firstDate
            || dateKey > bounds.maxArchiveDate
        ) {
            return null;
        }

        if (dateKey <= bounds.lastSavedDate) return getSaved(dateKey);
        return generate(database, dateKey);
    }

    globalThis.SongavelerDailyGenerator = Object.freeze({
        DAILY_CHALLENGES_FORMAT_VERSION,
        REQUIRED_CONNECTIONS_MIN,
        REQUIRED_CONNECTIONS_MAX,
        REQUIRED_LINKED_SONGS,
        MIN_COLLABORATORS_TO_SONGS_RATIO,
        generate,
        getBounds,
        getSaved,
        getUtcDateKey,
        isValidDateKey,
        resolve,
        resolveArchive
    });
})();
