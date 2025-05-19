import dotenv from 'dotenv';
import { addonBuilder } from 'stremio-addon-sdk';
import serveHTTP from 'stremio-addon-sdk/src/serveHTTP.js';
import fetch from 'node-fetch';
// Import functions from tmdb.js
import { getMovieFromTmdb, getTvFromTmdb, findTmdbIdByImdbId } from './vidsrc-api-js/src/workers/tmdb.js';

dotenv.config();

const API_BASE_URL = 'http://localhost:8080';
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
            streamUrl = `http://localhost:8082/m3u8-proxy?url=${encodeURIComponent(file.file)}`;
            
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
        let mediaInfo; // To store info from getMovieFromTmdb or getTvFromTmdb
        
        if (args.type === 'movie') {
            const imdbId = args.id;
            // const tmdbId = "placeholder_tmdb_id"; // Placeholder: This needs to be replaced with actual conversion
            const tmdbId = await findTmdbIdByImdbId(imdbId, 'movie'); 
            
            if (!tmdbId || tmdbId instanceof Error) {
                if(tmdbId instanceof Error) console.error('Error converting IMDB to TMDB ID for movie:', imdbId, tmdbId.message);
                else console.log('Could not find TMDB ID for movie:', imdbId);
                return enrichCacheParams([]);
            }
            
            mediaInfo = await getMovieFromTmdb(tmdbId); // Get metadata via imported function

            if (mediaInfo instanceof Error) {
                console.error('Error fetching movie data from tmdb.js:', mediaInfo.message);
                return enrichCacheParams([]);
            }
            
            // Now fetch streams from your API using TMDB ID (or IMDB ID if your API supports it)
            // The API_BASE_URL is for streams.
            const streamUrl = `${API_BASE_URL}/movie/${tmdbId}`; // Assuming your API uses TMDB ID for streams
            console.log(`Fetching streams from: ${streamUrl}`);
            const response = await fetch(streamUrl);
            console.log('Stream API Response status:', response.status);
            if (!response.ok) {
                console.error(`Stream API error: ${response.status}`);
                return enrichCacheParams([]);
            }
            const results = await response.json();
            console.log('Stream API response:', JSON.stringify(results, null, 2));
            
            if (results && !(results instanceof Error)) {
                results.forEach(result => {
                    const processedStreams = processStreamingSource(result);
                    allStreams = allStreams.concat(processedStreams);
                });
            }
        } else if (args.type === 'series') {
            const [imdbId, seasonStr, episodeStr] = args.id.split(':');
            const season = parseInt(seasonStr);
            const episode = parseInt(episodeStr);
            
            if (!season || !episode) {
                console.log('Missing season or episode number');
                return enrichCacheParams([]);
            }

            // const tmdbId = await findTmdbId(imdbId, 'series'); // Ideal call
            // const tmdbId = "placeholder_tmdb_id"; // Placeholder
            const tmdbId = await findTmdbIdByImdbId(imdbId, 'series');

            if (!tmdbId || tmdbId instanceof Error) {
                if(tmdbId instanceof Error) console.error('Error converting IMDB to TMDB ID for series:', imdbId, tmdbId.message);
                else console.log('Could not find TMDB ID for series:', imdbId);
                return enrichCacheParams([]);
            }

            mediaInfo = await getTvFromTmdb(tmdbId, season, episode); // Get metadata

            if (mediaInfo instanceof Error) {
                console.error('Error fetching TV data from tmdb.js:', mediaInfo.message);
                return enrichCacheParams([]);
            }
            
            // Fetch streams from your API
            const streamUrl = `${API_BASE_URL}/tv/${tmdbId}?s=${season}&e=${episode}`; // Assuming your API uses TMDB ID
            console.log(`Fetching streams from: ${streamUrl}`);
            const response = await fetch(streamUrl);
            console.log('Stream API Response status:', response.status);
            if (!response.ok) {
                console.error(`Stream API error: ${response.status}`);
                return enrichCacheParams([]);
            }
            const results = await response.json();
            console.log('Stream API response:', JSON.stringify(results, null, 2));

            if (results && !(results instanceof Error)) {
                results.forEach(result => {
                    const processedStreams = processStreamingSource(result);
                    allStreams = allStreams.concat(processedStreams);
                });
            }
        }

        console.log('Final streams:', JSON.stringify(allStreams, null, 2));
        // Enrich streams with mediaInfo if available and if your processStreamingSource or enrichCacheParams needs it
        // For example, you might want to pass mediaInfo.title to processStreamingSource
        return enrichCacheParams(allStreams);
    } catch (error) {
        console.error('Error in stream handler:', error);
        return enrichCacheParams([]);
    }
});

const addonInterface = builder.getInterface();
console.log('Addon interface created');

// Serve the addon
console.log('Starting HTTP server on port', PORT);
serveHTTP(addonInterface, { port: PORT }); 