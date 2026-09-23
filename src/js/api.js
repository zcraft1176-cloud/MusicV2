/**
 * API Integration Layer - Deezer (Metadata) + Piped (Audio)
 * 
 * Architecture:
 *   Deezer API  → Search, metadata, cover art, browse (NO auth needed)
 *   Piped API   → Audio streaming from YouTube (via PHP proxy)
 *   Jamendo     → Indie music with direct audio (optional, needs API key)
 *   Archive.org → Public domain music with direct audio
 */

/**
 * Scoring helpers for YouTube candidate selection.
 *
 * Deezer supplies the track list the user sees; this scoring only decides WHICH
 * YouTube upload of that track gets played. It never filters search results —
 * every Deezer track stays visible and playable, official or not.
 *
 * A wrong pick here is silent: the title on screen comes from Deezer, so the
 * user reads "Dynamite" while hearing the EDM remix. Nothing downstream can
 * detect that, so prefer the artist's own upload and push down the alternative
 * versions the user did not ask for.
 */

// Title words carrying no signal — never penalise these as "extra".
const TITLE_NOISE_WORDS = ['official', 'video', 'audio', 'music', 'lyric', 'lyrics',
    'hd', 'remix', 'feat', 'ft'];

// Alternative recordings. Penalised only when the user did not ask for one.
const VERSION_WORDS = ['remix', 'cover', 'live', 'instrumental', 'karaoke', 'acoustic',
    'slowed', 'sped', 'nightcore', 'mashup', 'reverb', '8d', 'remastered', 'extended',
    // Alt takes. "Not You (Restrung Performance)" is not the track the user clicked.
    'version', 'restrung', 'performance', 'orchestral', 'reprise', 'demo',
    // Dubbed recordings. "Not You" -> "Not You (Chinese Version)" is a different
    // song to the listener's ears, so never let one win on channel/duration alone.
    'chinese', 'japanese', 'korean', 'spanish', 'indonesian', 'english', 'thai',
    'vietnamese', 'hindi', 'arabic', 'turkish', 'french', 'german', 'portuguese',
    'russian', 'malay', 'tagalog', 'dutch', 'italian', 'polish'];

const VERSION_PENALTY = 40;   // enough to outrank an equally-matching version
const OFFICIAL_BONUS = 25;    // tie-breaker, not a relevance override

/**
 * Penalty for alternative versions the query did not request.
 * "Dynamite" vs "Dynamite (EDM Remix)": same title, same duration, so both
 * scored 150/148 and the remix won. This is what stops that.
 */
function versionPenalty(title, queryLower) {
    let penalty = 0;
    for (const w of VERSION_WORDS) {
        if (new RegExp(`\\b${w}\\b`).test(title) && !new RegExp(`\\b${w}`).test(queryLower)) {
            penalty += VERSION_PENALTY;
        }
    }
    return penalty;
}

/**
 * Is this upload from one of the track's credited artists?
 * "- Topic" = distributor-managed artist channel, "VEVO" = label channel.
 * The query is "{artist} {title}", so an uploader whose name appears in the
 * query is one of the credited artists. Without this, a collaboration credited
 * to "Alan Walker, Emma Steinbakken" never marks Emma's channel as official,
 * even though hers is where the actual track is published.
 */
function isOfficialChannel(uploader, queryLower) {
    if (uploader.includes(' - topic') || uploader.includes('vevo')) return true;
    const clean = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const name = clean(uploader);
    if (!name) return false;
    const q = clean(queryLower);
    if (q === name || q.startsWith(name + ' ')) return true;
    // Whole-phrase containment: "emma steinbakken" inside
    // "alan walker emma steinbakken not you". Padding avoids partial-word hits
    // (e.g. "vera" matching inside "vera dosal").
    return ` ${q} `.includes(` ${name} `);
}

const MusicAPI = {
    config: {
        deezer: {
            baseUrl: 'https://api.deezer.com'
        },
        piped: {
            instances: [
                'https://api.piped.private.coffee',
                'https://pipedapi.kavin.rocks',
                'https://pipedapi.adminforge.de',
                'https://pipedapi.leptons.xyz',
                'https://pipedapi.in.projectsegfau.lt'
            ],
            currentIndex: 0
        },
        invidious: {
            instances: [
                'https://inv.thepixora.com',
                'https://invidious.f5.si',
                'https://yt.chocolatemoo53.com'
            ],
            currentIndex: 0
        },
        jamendo: {
            baseUrl: 'https://api.jamendo.com/v3.0',
            clientId: localStorage.getItem('jamendoClientId') || '',
            format: 'ogg'
        }
    },

    cache: new Map(),
    cacheTimeout: 5 * 60 * 1000,

    /**
     * Get proxy URL.
     *
     * XAMPP serves the PHP proxy; Vercel runs no PHP at all (it would serve
     * proxy.php as source text), so the deployed build must use the serverless
     * /api/proxy function instead. Detected by hostname so the same checkout
     * works locally and on Vercel.
     */
    getProxyUrl(url) {
        // Any local install serves proxy.php through Apache, and a phone on
        // the same wifi reaches that install by its private IP or by the
        // machine's own name. Asking for /api/proxy there hits the Vercel
        // serverless function on an Apache host, where nothing answers.
        const proxyBase = this.isLocalHost() ? 'proxy.php' : '/api/proxy';
        return `${proxyBase}?url=${encodeURIComponent(url)}`;
    },

    /**
     * Is this page served by a local install (which can shell out to yt-dlp)?
     *
     * A phone on the same wifi reaches that install by its private IP, so the
     * LAN counts as local too. Single source of truth: player.js asks this to
     * decide between the stream proxy and the IFrame, and the search fallback
     * below uses it for the same reason.
     */
    isLocalHost() {
        const h = (typeof location !== 'undefined' && location.hostname) || '';
        return h === 'localhost' || h === '127.0.0.1'
            || /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(h)
            // The machine's own name ("DESKTOP-ABC123") has no dot and only
            // resolves on this LAN, so it is a local install too.
            || (h.length > 1 && !h.includes('.') && !/^\d+$/.test(h));
    },

    /**
     * Where the yt-dlp-backed search lives.
     *
     * Same two backends as getProxyUrl: Apache serves search-audio.php on a
     * local install, and the /api/ytsearch function runs the same extractor on
     * Vercel. Search needs no player API, so it is the one piece of the local
     * path that does survive up there — do NOT gate this on isLocalHost().
     */
    searchAudioUrl() {
        return this.isLocalHost() ? 'search-audio.php' : '/api/ytsearch';
    },

    /**
     * Search YouTube through yt-dlp instead of a public instance.
     *
     * Returns the same {items:[...]} shape Piped does, so the caller scores it
     * with identical code and picks the same upload either way.
     */
    async extractorSearch(query, n = 5) {
        try {
            const res = await fetch(`${this.searchAudioUrl()}?q=${encodeURIComponent(query)}&n=${n}`);
            if (!res.ok) return null;
            return await res.json();
        } catch (e) {
            console.warn('yt-dlp search failed:', e.message);
            return null;
        }
    },

    setJamendoClientId(id) {
        this.config.jamendo.clientId = id;
        localStorage.setItem('jamendoClientId', id);
    },

    hasJamendo() {
        return !!this.config.jamendo.clientId;
    },

    getCached(key) {
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.timestamp < this.cacheTimeout) return cached.data;
        this.cache.delete(key);
        return null;
    },

    setCache(key, data) {
        this.cache.set(key, { data, timestamp: Date.now() });
    },

    // =====================
    // UNIFIED SEARCH
    // =====================
    async search(query, options = {}) {
        const { limit = 30, hdOnly = false } = options;
        const cacheKey = `search:${query}:${hdOnly}`;
        const cached = this.getCached(cacheKey);
        if (cached) return cached;

        const promises = [
            this.deezer.search(query, limit)
        ];

        if (this.hasJamendo()) {
            promises.push(this.jamendo.search(query, 5));
        }

        const results = await Promise.allSettled(promises);
        let tracks = [];
        results.forEach(r => {
            if (r.status === 'fulfilled' && r.value) tracks = tracks.concat(r.value);
        });

        // Deduplicate by title similarity
        const seen = new Set();
        tracks = tracks.filter(t => {
            const key = `${t.title.toLowerCase().substring(0, 25)}-${t.artist.toLowerCase().substring(0, 15)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        if (hdOnly) tracks = tracks.filter(t => (t.bitrate || 0) >= 128);

        this.setCache(cacheKey, tracks.slice(0, limit));
        return tracks.slice(0, limit);
    },

    async getTrending(options = {}) {
        const { limit = 20 } = options;
        const cacheKey = `trending:${limit}`;
        const cached = this.getCached(cacheKey);
        if (cached) return cached;

        try {
            const promises = [
                this.deezer.getChart(limit)
            ];
            if (this.hasJamendo()) promises.push(this.jamendo.getPopular(5));

            const results = await Promise.allSettled(promises);
            let tracks = [];
            results.forEach(r => {
                if (r.status === 'fulfilled' && r.value) tracks = tracks.concat(r.value);
            });

            this.setCache(cacheKey, tracks.slice(0, limit));
            return tracks.slice(0, limit);
        } catch (e) {
            console.error('Trending error:', e);
            return [];
        }
    },

    getGenres() {
        return [
            { name: 'Pop', id: 132 },
            { name: 'Rock', id: 152 },
            { name: 'Hip Hop', id: 116 },
            { name: 'Electronic', id: 106 },
            { name: 'Jazz', id: 129 },
            { name: 'Classical', id: 98 },
            { name: 'R&B', id: 165 },
            { name: 'Metal', id: 464 },
            { name: 'Folk', id: 466 },
            { name: 'Blues', id: 153 },
            { name: 'Reggae', id: 144 },
            { name: 'Country', id: 84 },
            { name: 'Indie', id: 85 },
            { name: 'Soul', id: 169 },
            { name: 'Funk', id: 169 },   // Deezer: 169 = "Soul & Funk" (satu genre)
            { name: 'Punk', id: 152 },   // Deezer tak punya Punk → pakai Rock
            { name: 'Ambient', id: 106 }, // Deezer tak punya Ambient → pakai Electro
            { name: 'Latin', id: 197 }
        ];
    },

    async getByGenre(genre, options = {}) {
        const { limit = 50, offset = 0 } = options;
        const genreObj = typeof genre === 'object' ? genre : this.getGenres().find(g => g.name.toLowerCase() === genre.toLowerCase());
        const genreName = genreObj?.name || genre;
        const genreId = genreObj?.id;
        const cacheKey = `genre:${genreName}:${limit}:${offset}`;
        const cached = this.getCached(cacheKey);
        if (cached) return cached;

        let tracks = [];
        try {
            // Method 1: Deezer genre chart endpoint (best results)
            if (genreId) {
                const chartUrl = `${this.config.deezer.baseUrl}/chart/${genreId}/tracks?limit=${limit}&index=${offset}`;
                const proxyUrl = this.getProxyUrl(chartUrl);
                const res = await fetch(proxyUrl);
                const data = await res.json();
                if (data.data && data.data.length > 0) {
                    tracks = data.data.map(t => this.deezer.formatTrack(t));
                }
            }

            // Method 2: If chart gave too few results, supplement with editorial playlist search
            if (tracks.length < 10 && genreId) {
                const artistsUrl = `${this.config.deezer.baseUrl}/genre/${genreId}/artists?limit=10`;
                const proxyUrl2 = this.getProxyUrl(artistsUrl);
                const res2 = await fetch(proxyUrl2);
                const data2 = await res2.json();
                if (data2.data) {
                    // Get top tracks from genre artists
                    const artistPromises = data2.data.slice(0, 5).map(async artist => {
                        try {
                            const topUrl = `${this.config.deezer.baseUrl}/artist/${artist.id}/top?limit=10`;
                            const proxyUrl3 = this.getProxyUrl(topUrl);
                            const res3 = await fetch(proxyUrl3);
                            const data3 = await res3.json();
                            return data3.data ? data3.data.map(t => this.deezer.formatTrack(t)) : [];
                        } catch { return []; }
                    });
                    const artistTracks = (await Promise.all(artistPromises)).flat();
                    // Merge without duplicates
                    const existingIds = new Set(tracks.map(t => t.id));
                    for (const t of artistTracks) {
                        if (!existingIds.has(t.id)) {
                            tracks.push(t);
                            existingIds.add(t.id);
                        }
                        if (tracks.length >= limit) break;
                    }
                }
            }

            // Method 3: Fallback to search with better query
            if (tracks.length < 5) {
                const fallbackTracks = await this.deezer.search(`genre:"${genreName}"`, limit);
                const existingIds = new Set(tracks.map(t => t.id));
                for (const t of fallbackTracks) {
                    if (!existingIds.has(t.id)) tracks.push(t);
                    if (tracks.length >= limit) break;
                }
            }

            this.setCache(cacheKey, tracks);
            return tracks;
        } catch (e) {
            console.error('Genre error:', e);
            return [];
        }
    },

    /**
     * Resolve audio for a track (waterfall fallback chain)
     * Step 1: Piped search with music_songs filter → YouTube IFrame
     * Step 2: Piped search without filter (broader) → YouTube IFrame
     * Step 3: Deezer 30s preview → HTML5 Audio
     */
    async resolveAudioUrl(track, exclude = null) {
        if (track.source !== 'deezer' && track.audioUrl) {
            return track.audioUrl;
        }

        const query = `${track.artist} ${track.title}`;

        // Step 1: YouTube via Piped (filtered — music_songs)
        console.log(`[Step 1] Piped filtered search: ${query}`);
        try {
            const vid = await this.piped.findVideoId(query, track.duration, 'music_songs', exclude, track.title);
            if (vid) {
                track.videoId = vid;
                track.audioUrl = `yt:${vid}`;
                console.log(`[Step 1] ✅ Found: ${vid}`);
                return track.audioUrl;
            }
        } catch (e) { console.warn('[Step 1] Failed:', e.message); }

        // Step 2: YouTube via Piped (unfiltered — broader results)
        console.log(`[Step 2] Piped unfiltered search: ${query}`);
        try {
            const vid = await this.piped.findVideoId(query, track.duration, null, exclude, track.title);
            if (vid) {
                track.videoId = vid;
                track.audioUrl = `yt:${vid}`;
                console.log(`[Step 2] ✅ Found: ${vid}`);
                return track.audioUrl;
            }
        } catch (e) { console.warn('[Step 2] Failed:', e.message); }

        // Step 3: YouTube via Invidious (different API, different instances)
        console.log(`[Step 3] Invidious search: ${query}`);
        try {
            const vid = await this.invidious.findVideoId(query, track.duration, exclude, track.title);
            if (vid) {
                track.videoId = vid;
                track.audioUrl = `yt:${vid}`;
                console.log(`[Step 3] ✅ Found: ${vid}`);
                return track.audioUrl;
            }
        } catch (e) { console.warn('[Step 3] Failed:', e.message); }

        console.warn('All resolve steps failed for:', query);
        return null;
    },

    // =====================
    // DEEZER API (Metadata)
    // =====================
    deezer: {
        async search(query, limit = 30) {
            try {
                const url = `${MusicAPI.config.deezer.baseUrl}/search?q=${encodeURIComponent(query)}&limit=${limit}`;
                const proxyUrl = MusicAPI.getProxyUrl(url);
                const response = await fetch(proxyUrl);
                const data = await response.json();

                if (!data.data) return [];
                return data.data.map(t => this.formatTrack(t));
            } catch (e) {
                console.error('Deezer search error:', e);
                return [];
            }
        },

        async getChart(limit = 20) {
            try {
                const url = `${MusicAPI.config.deezer.baseUrl}/chart/0/tracks?limit=${limit}`;
                const proxyUrl = MusicAPI.getProxyUrl(url);
                const response = await fetch(proxyUrl);
                const data = await response.json();

                if (!data.data) return [];
                return data.data.map(t => this.formatTrack(t));
            } catch (e) {
                console.error('Deezer chart error:', e);
                return [];
            }
        },

        formatTrack(t) {
            return {
                id: `deezer_${t.id}`,
                source: 'deezer',
                title: t.title || t.title_short || 'Unknown',
                artist: t.artist?.name || 'Unknown',
                album: t.album?.title || '',
                cover: t.album?.cover_big || t.album?.cover_medium || t.album?.cover || '',
                duration: t.duration || 0,
                audioUrl: null,
                videoId: null,
                previewUrl: t.preview || null, // Deezer 30s preview MP3
                isPreview: false,
                bitrate: 160,
                format: 'opus',
                genre: [],
                license: '',
                releaseDate: ''
            };
        }
    },

    // =====================
    // YOUTUBE VIDEO FINDER (Piped search → YouTube IFrame)
    // =====================
    piped: {
        async pipedFetch(path) {
            const cfg = MusicAPI.config.piped;
            for (let i = 0; i < cfg.instances.length; i++) {
                const base = cfg.instances[(cfg.currentIndex + i) % cfg.instances.length];
                const target = `${base}${path}`;
                const proxyUrl = MusicAPI.getProxyUrl(target);
                try {
                    const ctrl = new AbortController();
                    const tm = setTimeout(() => ctrl.abort(), 15000);
                    const res = await fetch(proxyUrl, { signal: ctrl.signal });
                    clearTimeout(tm);
                    if (res.ok) return await res.json();
                } catch (e) {
                    console.warn(`Piped ${base} failed:`, e.message);
                }
            }
            cfg.currentIndex = (cfg.currentIndex + 1) % cfg.instances.length;
            return null;
        },

        /**
         * Find best matching YouTube video ID for a track
         * Uses title matching + duration proximity to avoid wrong songs
         */
        async findVideoId(query, expectedDuration = 0, filter = 'music_songs', exclude = null, wantedTitle = null) {
            const queryLower = query.toLowerCase();
            const filterParam = filter ? `&filter=${filter}` : '';

            try {
                let data = await this.pipedFetch(
                    `/search?q=${encodeURIComponent(query)}${filterParam}`
                );
                // Every Piped/Invidious instance is down more often than not,
                // which used to make the whole library unplayable. On a local
                // install yt-dlp answers instead, in the same shape, so the
                // scoring below stays the only thing that picks an upload.
                const pipedItems = data?.items || [];
                if (pipedItems.length === 0) {
                    data = await this.extractorSearch(query);
                }
                if (!data?.items?.length) return null;

                let candidates = data.items
                    .filter(item => item.type === 'stream' && item.duration > 30 && item.duration < 600);
                // On a retry, ignore the upload that already failed to play.
                if (exclude) candidates = candidates.filter(item => this.extractVideoId(item.url) !== exclude);

                if (candidates.length === 0) return null;

                // Score each candidate by title match + duration proximity
                const scored = candidates.map(item => {
                    const title = (item.title || '').toLowerCase();
                    const uploader = (item.uploaderName || '').toLowerCase();
                    let score = 0;

                    // Relevance = how well the TITLE matches the SONG the user
                    // clicked, not the whole "{artist} {title}" query.
                    // Scoring the whole query sent full marks to any upload whose
                    // title is just the artist name: a video titled "Imagine
                    // Dragons" on the "Believer - Topic" channel scored 100 for
                    // "Imagine Dragons Believer" and beat the real "Believer".
                    // Uploader name is excluded here too - channel identity is
                    // rewarded separately by OFFICIAL_BONUS below.
                    const target = (wantedTitle || queryLower).toLowerCase();
                    const queryWords = target.split(/\s+/).filter(w => w.length > 2);
                    // Guard: an all-short target ("iu bb") leaves queryWords empty
                    // and 0/0 is NaN, which makes the sort a no-op and hands the
                    // pick to whatever order YouTube returned.
                    if (queryWords.length > 0) {
                        const matchedWords = queryWords.filter(w => title.includes(w));
                        score += (matchedWords.length / queryWords.length) * 100;
                    }

                    // Duration match bonus — a weak tie-breaker (max 20 points).
                    // At 50 it outranked title relevance: "Not You" (98) lost to
                    // "Not You (Chinese Version)" (153) purely on a 1-second match.
                    if (expectedDuration > 0) {
                        const durationDiff = Math.abs(item.duration - expectedDuration);
                        score += Math.max(0, 20 - durationDiff * 2);
                    }

                    // Penalize if title contains words NOT in the query (likely wrong song)
                    const titleWords = title.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
                    const extraWords = titleWords.filter(w =>
                        !queryLower.includes(w) && !TITLE_NOISE_WORDS.includes(w)
                    );
                    score -= extraWords.length * 10;

                    // Push down versions the user did not ask for (remix/cover/live/...)
                    score -= versionPenalty(title, queryLower);

                    // Prefer the artist's own channel when relevance is close
                    if (isOfficialChannel(uploader, queryLower)) score += OFFICIAL_BONUS;

                    return { item, score };
                });

                // Sort by score descending
                scored.sort((a, b) => b.score - a.score);
                
                console.log('Video candidates:', scored.slice(0, 3).map(s => 
                    `"${s.item.title}" score=${s.score.toFixed(0)}`
                ));

                const best = scored[0];
                if (best) {
                    return this.extractVideoId(best.item.url);
                }
            } catch (e) {
                console.warn('Piped search failed:', e.message);
            }

            return null;
        },

        extractVideoId(url) {
            if (!url) return null;
            const m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/) || url.match(/\/([a-zA-Z0-9_-]{11})/);
            return m ? m[1] : (/^[a-zA-Z0-9_-]{11}$/.test(url) ? url : null);
        }
    },

    // =====================
    // INVIDIOUS API (Fallback YouTube search)
    // =====================
    invidious: {
        async invidiousFetch(path) {
            const cfg = MusicAPI.config.invidious;
            for (let i = 0; i < cfg.instances.length; i++) {
                const base = cfg.instances[(cfg.currentIndex + i) % cfg.instances.length];
                const target = `${base}${path}`;
                const proxyUrl = MusicAPI.getProxyUrl(target);
                try {
                    const ctrl = new AbortController();
                    const tm = setTimeout(() => ctrl.abort(), 15000);
                    const res = await fetch(proxyUrl, { signal: ctrl.signal });
                    clearTimeout(tm);
                    if (res.ok) return await res.json();
                } catch (e) {
                    console.warn(`Invidious ${base} failed:`, e.message);
                }
            }
            cfg.currentIndex = (cfg.currentIndex + 1) % cfg.instances.length;
            return null;
        },

        async findVideoId(query, expectedDuration = 0, exclude = null, wantedTitle = null) {
            try {
                const data = await this.invidiousFetch(
                    `/api/v1/search?q=${encodeURIComponent(query)}&type=video&sort_by=relevance`
                );
                if (!data || !Array.isArray(data) || data.length === 0) return null;

                const queryLower = query.toLowerCase();
                let candidates = data
                    .filter(item => item.type === 'video' && item.lengthSeconds > 30 && item.lengthSeconds < 600);
                // On a retry, ignore the upload that already failed to play.
                if (exclude) candidates = candidates.filter(item => item.videoId !== exclude);

                if (candidates.length === 0) return null;

                // Score candidates (same weighting as piped.findVideoId)
                const scored = candidates.map(item => {
                    const title = (item.title || '').toLowerCase();
                    const author = (item.author || '').toLowerCase();
                    let score = 0;

                    // Score against the song title only (see piped.findVideoId).
                    const target = (wantedTitle || queryLower).toLowerCase();
                    const queryWords = target.split(/\s+/).filter(w => w.length > 2);
                    // Guard against 0/0 = NaN on all-short queries
                    if (queryWords.length > 0) {
                        const matchedWords = queryWords.filter(w => title.includes(w));
                        score += (matchedWords.length / queryWords.length) * 100;
                    }

                    if (expectedDuration > 0) {
                        const durationDiff = Math.abs(item.lengthSeconds - expectedDuration);
                        score += Math.max(0, 20 - durationDiff * 2);
                    }

                    // Push down versions the user did not ask for, prefer artist's channel
                    score -= versionPenalty(title, queryLower);
                    if (isOfficialChannel(author, queryLower)) score += OFFICIAL_BONUS;

                    return { item, score };
                });

                scored.sort((a, b) => b.score - a.score);

                console.log('Invidious candidates:', scored.slice(0, 3).map(s =>
                    `"${s.item.title}" score=${s.score.toFixed(0)}`
                ));

                const best = scored[0];
                if (best && best.item.videoId) {
                    return best.item.videoId;
                }
            } catch (e) {
                console.warn('Invidious search failed:', e.message);
            }
            return null;
        }
    },

    // =====================
    // JAMENDO (Indie, optional)
    // =====================
    jamendo: {
        async search(query, limit = 10) {
            if (!MusicAPI.hasJamendo()) return [];
            const params = new URLSearchParams({
                client_id: MusicAPI.config.jamendo.clientId,
                format: 'json', audioformat: MusicAPI.config.jamendo.format,
                search: query, limit, include: 'musicinfo', imagesize: 300
            });
            try {
                const res = await fetch(`${MusicAPI.config.jamendo.baseUrl}/tracks/?${params}`);
                const data = await res.json();
                if (data.headers?.status === 'success') return data.results.map(t => this.fmt(t));
                return [];
            } catch (e) { return []; }
        },

        async getPopular(limit = 10) {
            if (!MusicAPI.hasJamendo()) return [];
            const params = new URLSearchParams({
                client_id: MusicAPI.config.jamendo.clientId,
                format: 'json', audioformat: MusicAPI.config.jamendo.format,
                order: 'popularity_total', limit, include: 'musicinfo', imagesize: 300
            });
            try {
                const res = await fetch(`${MusicAPI.config.jamendo.baseUrl}/tracks/?${params}`);
                const data = await res.json();
                if (data.headers?.status === 'success') return data.results.map(t => this.fmt(t));
                return [];
            } catch (e) { return []; }
        },

        fmt(t) {
            const url = t.audio || t.audiodownload;
            return {
                id: `jamendo_${t.id}`, source: 'jamendo',
                title: t.name || 'Unknown', artist: t.artist_name || 'Unknown',
                album: t.album_name || '', cover: t.album_image || t.image || '',
                duration: parseInt(t.duration) || 0, audioUrl: url, downloadUrl: url,
                bitrate: t.audioformat === 'ogg' ? 320 : 192,
                format: t.audioformat || 'mp3', genre: t.musicinfo?.tags?.genres || [],
                license: t.license_ccurl || '', releaseDate: t.releasedate || ''
            };
        }
    },

    // =====================
    // HELPERS
    // =====================
    getQualityLabel(bitrate) {
        if (bitrate >= 320) return { label: 'HD', class: 'hd', value: `${bitrate}kbps` };
        if (bitrate >= 256) return { label: 'HQ', class: 'hq', value: '256kbps' };
        if (bitrate >= 128) return { label: 'STD', class: 'std', value: '128kbps' };
        return { label: 'LOW', class: 'std', value: `${bitrate}kbps` };
    },

    getSourceLabel(source) {
        return { deezer: 'Deezer', piped: 'YouTube', jamendo: 'Jamendo', archive: 'Archive' }[source] || source;
    }
};
