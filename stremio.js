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

// Cache settings
const CACHE_MAX_AGE = 60 * 60; // 1 hour in seconds
const CACHE_MAX_AGE_EMPTY = 60; // 60 seconds
const STALE_REVALIDATE_AGE = 4 * 60 * 60; // 4 hours
const STALE_ERROR_AGE = 7 * 24 * 60 * 60; // 7 days

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
    const m3u8ProxyBaseUrl = isProductionEnvironment ? 'https://m3u8proxy-lon9.onrender.com' : 'http://152.67.188.54:7004';

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

        // Route all m3u8 URLs through our proxy
        let streamUrl = file.file;
        if (file.type === 'hls' || file.file.includes('.m3u8')) {
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
    
    // Only handle IMDB IDs
    if (!args.id.match(/tt\d+/i)) {
        console.log('Not an IMDB ID, skipping');
        return Promise.resolve({ streams: [] });
    }

    try {
        let allStreams = [];
        
        if (args.type === 'movie') {
            // For movies, convert IMDB ID to TMDB ID first
            const imdbId = args.id;
            const tmdbId = await convertImdbToTmdb(imdbId, 'movie');
            
            if (!tmdbId) {
                console.log('Could not find TMDB ID for movie:', imdbId);
                return enrichCacheParams([]);
            }
            
            // Fetch from our API using TMDB ID
            const url = `${API_BASE_URL}/movie/${tmdbId}`;
            console.log(`Fetching from: ${url}`);
            const response = await fetch(url);
            console.log('Response status:', response.status);
            if (!response.ok) {
                console.error(`API error: ${response.status}`);
                return enrichCacheParams([]);
            }
            const results = await response.json();
            console.log('API response:', JSON.stringify(results, null, 2));
            
            if (results && !(results instanceof Error)) {
                // Process each source/provider
                results.forEach(result => {
                    const processedStreams = processStreamingSource(result);
                    console.log('Processed streams for result:', processedStreams);
                    allStreams = allStreams.concat(processedStreams);
                });
            }
        } else if (args.type === 'series') {
            // For series, the ID format is tt1234567:1:1
            const [imdbId, season, episode] = args.id.split(':');
            
            if (!season || !episode) {
                console.log('Missing season or episode number');
                return enrichCacheParams([]);
            }

            // Convert IMDB ID to TMDB ID
            const tmdbId = await convertImdbToTmdb(imdbId, 'series');
            
            if (!tmdbId) {
                console.log('Could not find TMDB ID for series:', imdbId);
                return enrichCacheParams([]);
            }

            // Fetch from our API using TMDB ID
            const url = `${API_BASE_URL}/tv/${tmdbId}?s=${season}&e=${episode}`;
            console.log(`Fetching from: ${url}`);
            const response = await fetch(url);
            console.log('Response status:', response.status);
            if (!response.ok) {
                console.error(`API error: ${response.status}`);
                return enrichCacheParams([]);
            }
            const results = await response.json();
            console.log('API response:', JSON.stringify(results, null, 2));

            if (results && !(results instanceof Error)) {
                // Process each source/provider
                results.forEach(result => {
                    const processedStreams = processStreamingSource(result);
                    console.log('Processed streams for result:', processedStreams);
                    allStreams = allStreams.concat(processedStreams);
                });
            }
        }

        console.log('Final streams:', JSON.stringify(allStreams, null, 2));
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