export class FakeElement {
    constructor(id = "") {
        this.id = id;
        this.attributes = new Map();
        this.children = [];
        this.dataset = {};
        this.disabled = false;
        this.hidden = false;
        this.href = "";
        this.listeners = new Map();
        this.parentNode = null;
        this.style = {};
        this.textContent = "";
        this.title = "";
        this.value = "";
        const classes = new Set();
        this.classList = {
            add: name => classes.add(name),
            contains: name => classes.has(name),
            toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
        };
    }

    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
    }

    dispatch(type, event = {}) {
        return Promise.all(
            (this.listeners.get(type) || []).map(listener => listener(event))
        );
    }

    focus() {}

    select() {
        this.selected = true;
    }

    remove() {
        if (!this.parentNode) return;
        this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
    }

    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    replaceChildren(...children) {
        this.children = children;
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }
}

export function installFakeDocument(ids) {
    const elements = Object.fromEntries(ids.map(id => [id, new FakeElement(id)]));
    globalThis.document = {
        body: new FakeElement("body"),
        title: "",
        documentElement: {
            dataset: {
                theme: "white",
                resultLimit: "10",
                luckyConnections: "2",
                luckyLinkedSongs: "25"
            }
        },
        createElement: () => new FakeElement(),
        getElementById: id => elements[id] || null
    };
    return elements;
}

export function createDatabaseFixture() {
    const artists = {
        1: "Start Artist",
        2: "Middle Artist",
        3: "Target Artist",
        4: "Dead End"
    };
    const songs = {
        100: "Bridge One",
        101: "Final Link"
    };
    const artistSongs = {
        1: [100],
        2: [100, 101],
        3: [101],
        4: [100]
    };
    const songData = {
        100: { artists: [1, 2, 4] },
        101: { artists: [2, 3] }
    };

    for (let id = 110; id <= 120; id += 1) {
        songs[id] = `Start Solo ${id}`;
        artistSongs[1].push(id);
        songData[id] = { artists: [1] };
    }

    for (let id = 210; id <= 218; id += 1) {
        songs[id] = `Target Solo ${id}`;
        artistSongs[3].push(id);
        songData[id] = { artists: [3] };
    }

    return {
        manifest: { formatVersion: 1 },
        artists,
        songs,
        artistSongs,
        songData
    };
}
