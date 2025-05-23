import dotenv from 'dotenv';
import { addonBuilder } from 'stremio-addon-sdk';
import serveHTTP from 'stremio-addon-sdk/src/serveHTTP.js';
import fetch from 'node-fetch';
import os from 'os'; // Import the 'os' module

dotenv.config();

const API_BASE_URL = 'http://localhost:8081';
const TMDB_API_URL = 'https://api.themoviedb.org/3';
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const PORT = process.env.PORT || 7004;  // Added port configuration
const DISABLE_M3U8_PROXY = process.env.DISABLE_M3U8_PROXY === 'true'; // Added option to disable proxy
const MAX_RETRIES = 3; // Maximum number of retries for failed requests
const RETRY_DELAY_MS = 1000; // Delay between retries in milliseconds

// Cache settings
const CACHE_MAX_AGE = 60 * 60; // 1 hour in seconds
const CACHE_MAX_AGE_EMPTY = 60; // 60 seconds
const STALE_REVALIDATE_AGE = 4 * 60 * 60; // 4 hours
const STALE_ERROR_AGE = 7 * 24 * 60 * 60; // 7 days

// Common browser-like headers
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Upgrade-Insecure-Requests': '1',
    'Connection': 'keep-alive'
};

// HDRezka Constants
const REZKA_BASE_URL = 'https://hdrezka.ag'; // Ensure no trailing slash
const REZKA_BASE_HEADERS = {
  'X-Hdrezka-Android-App': '1',
  'X-Hdrezka-Android-App-Version': '2.2.0',
  ...BROWSER_HEADERS
};

// HDRezka Helper Functions
function generateRandomFavsRezka() {
  const randomHex = () => Math.floor(Math.random() * 16).toString(16);
  const generateSegment = (length) => Array.from({ length }, randomHex).join('');
  return `${generateSegment(8)}-${generateSegment(4)}-${generateSegment(4)}-${generateSegment(4)}-${generateSegment(12)}`;
}

function extractTitleAndYearRezka(input) {
  const regex = /^(.*?),.*?(\d{4})/;
  const match = input.match(regex);
  if (match) {
    const title = match[1];
    const year = match[2];
    return { title: title.trim(), year: year ? parseInt(year, 10) : null };
  }
  return null;
}

function parseVideoLinksRezka(inputString) {
    if (!inputString) {
        console.warn('[HDRezka] No video links string found in response for parseVideoLinksRezka.');
        return {};
    }
    const linksArray = inputString.split(',');
    const result = {};
    linksArray.forEach((link) => {
        let match = link.match(/\[([^\[\]]+)\](https?:\/\/[^\s,]+\.mp4|null)/);
        if (!match) {
            const qualityMatch = link.match(/\[<span[^>]*>([^<]+)/);
            const urlMatch = link.match(/\][^\[]*?(https?:\/\/[^\s,]+\.mp4|null)/);
            if (qualityMatch && urlMatch) {
                match = [null, qualityMatch[1].trim(), urlMatch[1]];
            }
        }
        if (match) {
            let qualityText = match[1].trim(); // Original quality text, potentially with HTML
            const mp4Url = match[2];

            // Strip HTML tags from qualityText for a cleaner label
            const cleanQualityText = qualityText.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim(); 

            if (mp4Url !== 'null') {
                // Use the cleaned quality text as the key
                result[cleanQualityText] = { type: 'mp4', url: mp4Url };
            }
        } else {
             console.warn(`[HDRezka] Could not parse quality from link: ${link}`);
        }
    });
    return result;
}

function parseSubtitlesRezka(inputString) {
    if (!inputString) {
        console.log('[HDRezka] No subtitles string found in response for parseSubtitlesRezka.');
        return [];
    }
    const linksArray = inputString.split(',');
    const captions = [];
    linksArray.forEach((link) => {
        const match = link.match(/\[([^\]]+)\](https?:\/\/\S+?)(?=,\[|$)/);
        if (match) {
            const language = match[1];
            const url = match[2];
            let langCode = language.toLowerCase();
            if (language === 'Русский') langCode = 'ru';
            else if (language === 'Українська') langCode = 'uk';
            else if (language === 'English') langCode = 'en';
            
            captions.push({
                id: url, // Using URL as ID, or generate one
                language: langCode,
                hasCorsRestrictions: false, // Assuming false, adjust if known
                type: 'vtt', // Assuming VTT, adjust if different
                url: url,
            });
        }
    });
    return captions;
}

// Helper function for retries
async function fetchWithRetry(url, options, maxRetries = MAX_RETRIES) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, options);
            
            // Check if response is OK, if not throw error with status
            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }
            
            return response; // Success, return response
        } 
        catch (error) {
            lastError = error;
            console.warn(`Attempt ${attempt}/${maxRetries} failed for ${url}: ${error.message}`);
            
            // If it's the last attempt, don't wait
            if (attempt < maxRetries) {
                // Wait with exponential backoff
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * Math.pow(2, attempt - 1)));
            }
        }
    }
    
    // All attempts failed
    throw lastError;
}

// HDRezka Main Scraping Functions
async function searchAndFindMediaIdRezka(media) {
    console.log(`[HDRezka] Searching for: ${media.title}, Type: ${media.type}, Year: ${media.releaseYear || 'any'}`);
    const itemRegexPattern = /<a href="([^"]+)"><span class="enty">([^<]+)<\/span> \(([^)]+)\)/g;
    const idRegexPattern = /\/(\d+)-[^\/]+\.html$/;
    
    const searchUrl = new URL('/engine/ajax/search.php', REZKA_BASE_URL);
    searchUrl.searchParams.append('q', media.title);

    try {
        const response = await fetchWithRetry(searchUrl.toString(), { 
            headers: REZKA_BASE_HEADERS,
            // Cloudflare often checks this:
            referrer: REZKA_BASE_URL + "/",
            referrerPolicy: 'strict-origin-when-cross-origin'
        });
        const searchData = await response.text();
        const movieData = [];
        let match;
        while ((match = itemRegexPattern.exec(searchData)) !== null) {
            const url = match[1];
            const titleAndYear = match[3];
            const result = extractTitleAndYearRezka(titleAndYear);
            if (result !== null) {
                const id = url.match(idRegexPattern)?.[1] || null;
                const isMovie = url.includes('/films/');
                const isShow = url.includes('/series/');
                const type = isMovie ? 'movie' : isShow ? 'show' : 'unknown';
                movieData.push({ id: id ?? '', year: result.year ?? 0, type, url, title: match[2] });
            }
        }

        let filteredItems = movieData;
        if (media.releaseYear) {
            filteredItems = movieData.filter(item => item.year === media.releaseYear);
        }
        if (media.type) {
            filteredItems = filteredItems.filter(item => item.type === media.type);
        }

        if (filteredItems.length > 0) {
            console.log(`[HDRezka] Selected item by specific criteria: id=${filteredItems[0].id}, title=${filteredItems[0].title}`);
            return filteredItems[0];
        }
        if (movieData.length > 0) {
            console.log(`[HDRezka] No exact match, selecting first available item: id=${movieData[0].id}, title=${movieData[0].title}`);
            return movieData[0];
        }
        console.log(`[HDRezka] No items found for: ${media.title}`);
        return null;

    } catch (error) {
        console.error(`[HDRezka] Error in searchAndFindMediaIdRezka: ${error.message}`, error);
        return null;
    }
}

async function getTranslatorIdRezka(itemUrl, itemId, media) {
    if (!itemUrl || !itemId) return null;
    console.log(`[HDRezka] Getting translator ID for url=${itemUrl}, id=${itemId}`);
    const fullUrl = itemUrl.startsWith('http') ? itemUrl : `${REZKA_BASE_URL}${itemUrl.startsWith('/') ? itemUrl.substring(1) : itemUrl}`;

    try {
        const response = await fetchWithRetry(fullUrl, { 
            headers: REZKA_BASE_HEADERS,
            referrer: REZKA_BASE_URL + "/",
            referrerPolicy: 'strict-origin-when-cross-origin'
        });
        const responseText = await response.text();
        if (responseText.includes('data-translator_id="238"')) {
            console.log('[HDRezka] Found translator ID 238 (Original + subtitles)');
            return '238';
        }
        const functionName = media.type === 'movie' ? 'initCDNMoviesEvents' : 'initCDNSeriesEvents';
        const regexPattern = new RegExp(`sof\.tv\.${functionName}\(${itemId}, ([^,]+)`, 'i');
        const match = responseText.match(regexPattern);
        const translatorId = match ? match[1] : null;
        console.log(`[HDRezka] Extracted translator ID: ${translatorId}`);
        return translatorId;
    } catch (error) {
        console.error(`[HDRezka] Error in getTranslatorIdRezka: ${error.message}`, error);
        return null;
    }
}

async function getStreamRezka(id, translatorId, media) {
    if(!id || !translatorId) return null;
    console.log(`[HDRezka] Getting stream for id=${id}, translatorId=${translatorId}`);
    const searchParams = new URLSearchParams();
    searchParams.append('id', id);
    searchParams.append('translator_id', translatorId);
    if (media.type === 'show' && media.season && media.episode) {
        searchParams.append('season', media.season.number.toString());
        searchParams.append('episode', media.episode.number.toString());
    }
    searchParams.append('favs', generateRandomFavsRezka());
    searchParams.append('action', media.type === 'show' ? 'get_stream' : 'get_movie');
    
    const streamUrl = `${REZKA_BASE_URL}/ajax/get_cdn_series/`;

    try {
        const response = await fetchWithRetry(streamUrl, {
            method: 'POST',
            body: searchParams,
            headers: {
                ...REZKA_BASE_HEADERS,
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest' 
            },
            referrer: `${REZKA_BASE_URL}/`, // Referrer is important for many sites
            referrerPolicy: 'strict-origin-when-cross-origin'
        });
        const responseText = await response.text();
        const parsedResponse = JSON.parse(responseText);
        if (parsedResponse && parsedResponse.success) {
            parsedResponse.formattedQualities = parseVideoLinksRezka(parsedResponse.url);
            parsedResponse.formattedCaptions = parseSubtitlesRezka(parsedResponse.subtitle);
            console.log(`[HDRezka] Successfully fetched and parsed stream data. Qualities: ${Object.keys(parsedResponse.formattedQualities).length}, Captions: ${parsedResponse.formattedCaptions.length}`);
            return parsedResponse;
        } else {
            console.error('[HDRezka] Failed to get stream or success was false. Response:', responseText.substring(0, 200));
            return null;
        }
    } catch (error) {
        console.error(`[HDRezka] Error in getStreamRezka: ${error.message}`, error);
        return null;
    }
}

// Helper function to rank stream quality for sorting
function getQualityRank(qualityLabel) {
    if (!qualityLabel) return 100; // Lowest priority if no label
    const q = String(qualityLabel).toLowerCase();
    if (q.includes('2160') || q.includes('4k') || q.includes('uhd')) return 1;
    if (q.includes('1080') || q.includes('fhd')) return 2;
    if (q.includes('720') || q.includes('hd')) return 3;
    if (q.includes('adaptive')) return 4; // Adaptive streams like HLS
    if (q.includes('480') || q.includes('sd')) return 5;
    if (q.includes('360') || q.includes('ld')) return 6;
    if (q.includes('unknown')) return 99;
    // For qualities like "1080p Ultra" from HDRezka, these specific checks still work.
    // If a quality is not explicitly matched but exists, give it a middle-ground rank.
    return 50; 
}

// Helper function to rank provider for sorting
function getProviderRank(providerName) {
    if (!providerName) return 99; // Lowest if no name
    const name = String(providerName).toLowerCase();
    if (name.includes('xprime.tv')) return 1;
    if (name.includes('hdrezka')) return 2;
    // For streams from API_BASE_URL, their provider name might vary.
    // Assign a general rank for others, or be more specific if provider names are consistent.
    // Example: if your main API_BASE_URL streams have a consistent provider name like 'myapi'.
    // if (name.includes('myapi')) return 3;
    return 10; // Default for other providers
}

const manifest = {
    id: 'org.tmdbembedapi',
    version: '1.0.0',
    name: 'TMDB Embed Streams',
    description: 'Stream movies and TV shows from multiple embed sources including 2embed, embedsu, autoembed, and vidsrcsu',
    resources: [
        {
            name: 'stream',
            types: ['movie', 'series'],
            idPrefixes: ['tt']
        }
    ],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: {
        adult: false,
        p2p: false,
        configurable: false
    },
    logo: 'https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_2-d537fb228cf3ded904ef09b136fe3fec72548ebc1fea3fbbd1ad9e36364db38b.svg',
    background: 'https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_2-d537fb228cf3ded904ef09b136fe3fec72548ebc1fea3fbbd1ad9e36364db38b.svg'
};

console.log('Starting Stremio addon with manifest:', manifest);

const builder = new addonBuilder(manifest);

// Function to get local IP address
function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            const { address, family, internal } = iface;
            if (family === 'IPv4' && !internal) {
                return address;
            }
        }
    }
    return '0.0.0.0'; // Fallback
}

// Function to convert IMDB ID to TMDB ID
async function convertImdbToTmdb(imdbId, type = 'movie') {
    try {
        console.log(`Converting IMDB ID ${imdbId} to TMDB ID`);
        const url = `${TMDB_API_URL}/find/${imdbId}?external_source=imdb_id`;
        console.log(`Fetching from TMDB: ${url}`);
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${TMDB_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        if (!response.ok) {
            console.error(`TMDB API error: ${response.status}`);
            return null;
        }
        const data = await response.json();
        console.log('TMDB response:', data);

        // TMDB returns different arrays for movies and TV shows
        if (type === 'movie' && data.movie_results && data.movie_results.length > 0) {
            return data.movie_results[0].id;
        } else if (type === 'series' && data.tv_results && data.tv_results.length > 0) {
            return data.tv_results[0].id;
        }
        return null;
    } catch (error) {
        console.error('Error converting IMDB to TMDB ID:', error);
        return null;
    }
}

function processStreamingSource(source) {
    console.log('Processing source:', source);
    if (!source || source.ERROR) {
        console.log('Invalid source or error:', source);
        return [];
    }
    
    const streams = [];
    const { provider, files, subtitles, headers } = source.source || source;
    
    if (!files) {
        console.log('No files found in source');
        return [];
    }

    // Quality patterns to check in URLs
    const qualityPatterns = {
        '2160p': /2160p|4k|uhd/i,
        '1080p': /1080p|1080|fhd/i,
        '720p': /720p|720|hd/i,
        '480p': /480p|480|sd/i,
        '360p': /360p|360|ld/i
    };

    const isProductionEnvironment = process.env.NODE_ENV === 'production';
    const localIp = getLocalIpAddress(); // Get local IP
    const m3u8ProxyPort = 8082; // Assuming m3u8proxy runs on port 8082 as per logs
    const m3u8ProxyBaseUrl = isProductionEnvironment ? 'http://150.230.133.192:8082' : `http://${localIp}:${m3u8ProxyPort}`;

    files.forEach(file => {
        // Try to determine quality from the file URL if not provided
        let quality = file.quality;
        if (!quality) {
            // Check URL against quality patterns
            for (const [q, pattern] of Object.entries(qualityPatterns)) {
                if (pattern.test(file.file)) {
                    quality = q;
                    break;
                }
            }
            
            // If still no quality found and it's an HLS stream, assume it's adaptive
            if (!quality && (file.type === 'hls' || file.file.includes('.m3u8'))) {
                quality = 'adaptive';
            }
            
            // If still no quality, mark as unknown
            if (!quality) {
                quality = 'unknown';
            }
        }

        // Route m3u8 URLs through our proxy, except for 2embed
        let streamUrl = file.file;
        if (!DISABLE_M3U8_PROXY && (file.type === 'hls' || file.file.includes('.m3u8')) && provider !== '2embed') {
            streamUrl = `${m3u8ProxyBaseUrl}/m3u8-proxy?url=${encodeURIComponent(file.file)}`;
            
            // Include required headers in the proxy URL if they exist
            if (headers) {
                streamUrl += `&headers=${encodeURIComponent(JSON.stringify(headers))}`;
            }
        }

        const stream = {
            title: `${provider} ${quality || ''} ${file.lang || ''}`.trim(),
            url: streamUrl,
            name: provider,
            type: file.type || 'url',
            // Include quality if available
            qualityLabel: quality,
            // Include language if available
            language: file.lang || 'unknown',
            // Include headers required for playback
            behaviorHints: {
                headers: headers || {},
                notWebReady: true // This indicates the stream needs external player
            }
        };
        console.log('Created stream:', stream);
        streams.push(stream);
    });

    // Add subtitles if available
    if (subtitles && subtitles.length > 0) {
        streams.forEach(stream => {
            stream.subtitles = subtitles.map(sub => ({
                url: sub.url,
                lang: sub.lang
            }));
        });
    }

    return streams;
}

function enrichCacheParams(streams) {
    let cacheAge = CACHE_MAX_AGE;
    if (!streams.length) {
        cacheAge = CACHE_MAX_AGE_EMPTY;
    }
    return {
        streams: streams,
        cacheMaxAge: cacheAge,
        staleRevalidate: STALE_REVALIDATE_AGE,
        staleError: STALE_ERROR_AGE
    };
}

// Define stream handler for both movies and series
builder.defineStreamHandler(async (args) => {
    console.log('Stream request received:', args);
    
    if (!args.id.match(/tt\d+/i)) {
        console.log('Not an IMDB ID, skipping');
        return Promise.resolve({ streams: [] });
    }

    try {
        let allStreams = [];
        let title, year, tmdbId; // To store title and year for providers

        // Common logic to get TMDB ID, title, and year
        if (args.type === 'movie') {
            const imdbId = args.id;
            tmdbId = await convertImdbToTmdb(imdbId, 'movie');
            if (!tmdbId) {
                console.log('Could not find TMDB ID for movie:', imdbId);
                return enrichCacheParams([]);
            }
            const movieDetailsUrl = `${TMDB_API_URL}/movie/${tmdbId}`;
            try {
                const movieDetailsResponse = await fetch(movieDetailsUrl, { headers: { 'Authorization': `Bearer ${TMDB_API_KEY}`, 'Content-Type': 'application/json' }});
                if (movieDetailsResponse.ok) {
                    const movieDetails = await movieDetailsResponse.json();
                    title = movieDetails.title;
                    year = movieDetails.release_date ? movieDetails.release_date.substring(0, 4) : null;
                } else { console.error(`TMDB API error fetching movie details: ${movieDetailsResponse.status}`); }
            } catch (e) { console.error('Error fetching movie details from TMDB:', e); }
        } else if (args.type === 'series') {
            const [imdbId, seasonStr, episodeStr] = args.id.split(':');
            if (!seasonStr || !episodeStr) {
                console.log('Missing season or episode number');
                return enrichCacheParams([]);
            }
            tmdbId = await convertImdbToTmdb(imdbId, 'series');
            if (!tmdbId) {
                console.log('Could not find TMDB ID for series:', imdbId);
                return enrichCacheParams([]);
            }
            const seriesDetailsUrl = `${TMDB_API_URL}/tv/${tmdbId}`;
            try {
                const seriesDetailsResponse = await fetch(seriesDetailsUrl, { headers: { 'Authorization': `Bearer ${TMDB_API_KEY}`, 'Content-Type': 'application/json' }});
                if (seriesDetailsResponse.ok) {
                    const seriesDetails = await seriesDetailsResponse.json();
                    title = seriesDetails.name;
                    year = seriesDetails.first_air_date ? seriesDetails.first_air_date.substring(0, 4) : null;
                } else { console.error(`TMDB API error fetching series details: ${seriesDetailsResponse.status}`); }
            } catch (e) { console.error('Error fetching series details from TMDB:', e); }
        }

        // Normalize title if it exists
        if (title) {
            console.log(`[Title Normalization] Original title: ${title}`);
            // Replace 'X²' with 'X 2', 'X³' with 'X 3' to ensure space for sequels
            title = title.replace(/([a-zA-Z0-9])²/g, '$1 2')
                         .replace(/([a-zA-Z0-9])³/g, '$1 3');
            // Handle cases where ² or ³ might be standalone or already spaced (e.g. "Title ²")
            title = title.replace(/²/g, '2')
                         .replace(/³/g, '3');
            // Add other common superscript/subscript or special char normalizations if needed for other providers
            console.log(`[Title Normalization] Normalized title: ${title}`);
        }

        if (!title || !year || !tmdbId) {
            console.log('Could not retrieve essential metadata (title, year, tmdbId). Aborting stream search.');
            return enrichCacheParams([]);
        }
        console.log(`Processing for: ${title} (${year}), TMDB ID: ${tmdbId}, Stremio Type: ${args.type}`);

        // --- Fetch from existing API (e.g., localhost:8081) ---
        try {
            let apiUrl;
            if (args.type === 'movie') {
                apiUrl = `${API_BASE_URL}/movie/${tmdbId}`;
            } else { // series
                const [, season, episode] = args.id.split(':');
                apiUrl = `${API_BASE_URL}/tv/${tmdbId}?s=${season}&e=${episode}`;
            }
            console.log(`Fetching from main API: ${apiUrl}`);
            const mainApiResponse = await fetch(apiUrl);
            if (mainApiResponse.ok) {
                const results = await mainApiResponse.json();
                 if (results && !(results instanceof Error) && Array.isArray(results)) {
                    results.forEach(result => {
                        const processedStreams = processStreamingSource(result);
                        allStreams = allStreams.concat(processedStreams);
                    });
                }
            } else {
                console.error(`Main API error: ${mainApiResponse.status}`);
            }
        } catch (error) {
            console.error('Error fetching from main API:', error);
        }
        
        // --- Fetch from xprime.tv ---
        try {
            console.log('[XPrime.tv] Attempting to fetch streams...');
            const xprimeName = encodeURIComponent(title);
            let xprimeUrl;
            if (args.type === 'movie') {
                xprimeUrl = `https://backend.xprime.tv/primebox?name=${xprimeName}&year=${year}&fallback_year=${year}`;
            } else { // series
                const [, season, episode] = args.id.split(':');
                xprimeUrl = `https://backend.xprime.tv/primebox?name=${xprimeName}&year=${year}&fallback_year=${year}&season=${season}&episode=${episode}`;
            }
            console.log(`Fetching from xprime.tv: ${xprimeUrl}`);
            const xprimeResponse = await fetchWithRetry(xprimeUrl, {
                headers: {
                    ...BROWSER_HEADERS,
                    'Origin': 'https://xprime.tv',
                    'Referer': 'https://xprime.tv/',
                }
            });
            const xprimeResult = await xprimeResponse.json();
            const processXprimeItem = (item) => {
                if (item && typeof item === 'object' && !item.error && item.streams && typeof item.streams === 'object') {
                    const filesArray = Object.entries(item.streams).map(([quality, fileUrl]) => ({
                        file: fileUrl, quality: quality, type: 'url'
                    }));
                    const sourceToProcess = { provider: 'xprime.tv', files: filesArray, subtitles: item.subtitles || [] };
                    const processedXprimeStreams = processStreamingSource(sourceToProcess);
                    allStreams = allStreams.concat(processedXprimeStreams);
                } else { console.log('[XPrime.tv] Skipping item due to missing/invalid streams or error:', item); }
            };
            if (Array.isArray(xprimeResult)) { xprimeResult.forEach(processXprimeItem); } 
            else { processXprimeItem(xprimeResult); }
        } catch (xprimeError) {
            console.error('Error fetching from xprime.tv:', xprimeError);
        }

        // --- Fetch from HDRezka ---
        try {
            console.log('[HDRezka] Attempting to fetch streams...');
            const hdRezkaMedia = {
                title: title,
                type: args.type === 'series' ? 'show' : 'movie',
                releaseYear: parseInt(year),
                season: args.type === 'series' ? { number: parseInt(args.id.split(':')[1]) } : undefined,
                episode: args.type === 'series' ? { number: parseInt(args.id.split(':')[2]) } : undefined
            };

            const searchResultRezka = await searchAndFindMediaIdRezka(hdRezkaMedia);
            if (searchResultRezka && searchResultRezka.id) {
                const translatorIdRezka = await getTranslatorIdRezka(searchResultRezka.url, searchResultRezka.id, hdRezkaMedia);
                if (translatorIdRezka) {
                    const streamDataRezka = await getStreamRezka(searchResultRezka.id, translatorIdRezka, hdRezkaMedia);
                    if (streamDataRezka && streamDataRezka.formattedQualities) {
                        const filesRezka = Object.entries(streamDataRezka.formattedQualities).map(([quality, data]) => ({
                            file: data.url,
                            quality: quality, // e.g., "720p", "1080p Ultra"
                            type: data.type || 'mp4' // Assuming mp4 if not specified
                        }));

                        const subtitlesRezka = streamDataRezka.formattedCaptions ? streamDataRezka.formattedCaptions.map(sub => ({
                            url: sub.url,
                            lang: sub.language // Should be 'en', 'ru', etc.
                        })) : [];
                        
                        if (filesRezka.length > 0) {
                             const hdRezkaSource = {
                                provider: 'HDRezka',
                                files: filesRezka,
                                subtitles: subtitlesRezka,
                                // HDRezka streams don't seem to require special headers for playback from the scraper script
                            };
                            console.log('[HDRezka] Source to process:', JSON.stringify(hdRezkaSource, null, 2).substring(0, 500) + "...");
                            const processedHdRezkaStreams = processStreamingSource(hdRezkaSource);
                            console.log('[HDRezka] Processed streams:', processedHdRezkaStreams.length);
                            allStreams = allStreams.concat(processedHdRezkaStreams);
                        } else {
                             console.log('[HDRezka] No stream files found after processing API response.');
                        }
                    } else {
                        console.log('[HDRezka] No stream data or formatted qualities received.');
                    }
                } else {
                    console.log('[HDRezka] Could not get translator ID.');
                }
            } else {
                console.log('[HDRezka] Could not find media on HDRezka.');
            }
        } catch (hdRezkaError) {
            console.error('Error fetching from HDRezka:', hdRezkaError);
        }

        console.log(`[Sorting] Total streams before sorting: ${allStreams.length}`);
        allStreams.sort((a, b) => {
            const providerRankA = getProviderRank(a.name); // a.name should be the provider
            const providerRankB = getProviderRank(b.name);

            if (providerRankA !== providerRankB) {
                return providerRankA - providerRankB; // Sort by provider first
            }

            // If providers are the same, then sort by quality
            const qualityRankA = getQualityRank(a.qualityLabel);
            const qualityRankB = getQualityRank(b.qualityLabel);
            
            return qualityRankA - qualityRankB; // Lower quality rank is better
        });

        console.log('Final streams from all providers (sorted by provider, then quality):', JSON.stringify(allStreams.map(s => ({title: s.title, provider: s.name, quality: s.qualityLabel})), null, 2));
        return enrichCacheParams(allStreams);
    } catch (error) {
        console.error('Error in stream handler:', error);
        return enrichCacheParams([]);
    }
});

const addonInterface = builder.getInterface();
console.log('Addon interface created');

// Serve the addon
console.log('Starting HTTP server on port ' + PORT);
serveHTTP(addonInterface, { port: PORT, host: '0.0.0.0' }) // Listen on 0.0.0.0
    .then(({ url }) => {
        const localIp = getLocalIpAddress();
        console.log('HTTP addon accessible at: http://' + localIp + ':' + PORT + '/manifest.json');
        console.log('Also accessible at: ' + url); // This will likely show 127.0.0.1
    })
    .catch(err => {
        console.error('Error starting HTTP server:', err);
    }); 