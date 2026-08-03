(() => {
    "use strict";

    const REQUIRED_CONNECTIONS = 2;
    const REQUIRED_LINKED_SONGS = 25;
    const DATE_KEY_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

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
        if (
            !database
            || typeof database.artists !== "object"
            || typeof database.artistSongs !== "object"
            || typeof database.songData !== "object"
        ) {
            throw new TypeError("A valid Songaveler database is required.");
        }
    }

    function findArtistDistances(database, startId) {
        const startKey = String(startId);
        const distances = new Map([[startKey, 0]]);
        const queue = [startKey];

        for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
            const artistId = queue[queueIndex];
            const distance = distances.get(artistId);
            if (distance >= REQUIRED_CONNECTIONS) continue;

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

    function generate(database, dateKey) {
        assertDatabase(database);

        if (!isValidDateKey(dateKey)) {
            throw new RangeError("The challenge date must be a real date in YYYY-MM-DD format.");
        }

        const candidates = Object.keys(database.artists)
            .filter(id => (
                typeof database.artists[id] === "string"
                && database.artists[id].length > 0
                && (database.artistSongs[id] || []).length >= REQUIRED_LINKED_SONGS
            ))
            .sort(compareArtistIds);
        const random = createSeededRandom(dateKey);

        for (const startId of shuffle(candidates, random)) {
            const distances = findArtistDistances(database, startId);
            const possibleEnds = candidates.filter(endId => (
                endId !== startId
                && distances.get(endId) === REQUIRED_CONNECTIONS
            ));

            if (possibleEnds.length > 0) {
                const endId = possibleEnds[Math.floor(random() * possibleEnds.length)];
                return Object.freeze({
                    dateKey,
                    startId,
                    endId,
                    requiredConnections: REQUIRED_CONNECTIONS,
                    requiredLinkedSongs: REQUIRED_LINKED_SONGS
                });
            }
        }

        return null;
    }

    globalThis.SongavelerDailyGenerator = Object.freeze({
        REQUIRED_CONNECTIONS,
        REQUIRED_LINKED_SONGS,
        generate,
        getUtcDateKey,
        isValidDateKey
    });
})();
