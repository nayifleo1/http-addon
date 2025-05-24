import express from 'express';
import fetch from 'node-fetch'; // Using node-fetch for the proxy's outgoing requests
import { URL } from 'url';

const app = express();
const PORT = process.env.PROXY_PORT || 7005; // Use a different port from the addon

// Middleware to parse JSON bodies (if you ever need to send JSON to the proxy itself)
app.use(express.json());

// All-purpose proxy route
app.all('/*', async (req, res) => {
    const targetUrlString = req.query.target_url; // Expecting target_url as a query param

    if (!targetUrlString) {
        return res.status(400).send({ error: 'Proxy error: target_url query parameter is required' });
    }

    let targetUrl;
    try {
        targetUrl = new URL(targetUrlString);
    } catch (error) {
        console.error(`[Proxy] Invalid target_url: ${targetUrlString}`, error);
        return res.status(400).send({ error: 'Proxy error: Invalid target_url format' });
    }

    // Reconstruct the path and search parameters for the target request
    // req.originalUrl contains the full path and query string, e.g., /proxy/path?param=value&target_url=...
    // We need to strip the '/proxy' part if your proxy route is mounted under /proxy
    // For this setup where it's '/*', req.path should be correct.
    const pathAndQuery = req.originalUrl.split('?')[0]; // Get the path part from the proxy request
    targetUrl.pathname = pathAndQuery; // Set the path on the target URL

    // Append original query parameters from the proxy request to the target URL,
    // excluding 'target_url' itself.
    const originalQueryParams = new URLSearchParams(req.query);
    originalQueryParams.delete('target_url');
    targetUrl.search = originalQueryParams.toString();

    console.log(`[Proxy] Request received for method: ${req.method}, Original URL: ${req.originalUrl}`);
    console.log(`[Proxy] Forwarding to: ${targetUrl.toString()}`);

    const headers = { ...req.headers };
    // Delete host header, as it should be set by fetch based on the targetUrl.hostname
    delete headers['host'];
    // Remove headers added by a potential upstream proxy (like Render's) if this proxy itself runs behind one
    delete headers['x-forwarded-for'];
    delete headers['x-forwarded-host'];
    delete headers['x-forwarded-proto'];
    delete headers['x-forwarded-port'];
    delete headers['x-request-start'];
    delete headers['x-request-id'];
    delete headers['via'];

    try {
        const proxyResponse = await fetch(targetUrl.toString(), {
            method: req.method,
            headers: headers,
            body: (req.method !== 'GET' && req.method !== 'HEAD') ? req : undefined, // Forward body only if present and relevant
            compress: true, // Ask for compressed response from target
            redirect: 'manual', // Handle redirects manually if needed, or 'follow'
        });

        console.log(`[Proxy] Response from target ${targetUrl.toString()}: ${proxyResponse.status}`);

        // Forward status code
        res.status(proxyResponse.status);

        // Forward headers from target to client
        proxyResponse.headers.forEach((value, name) => {
            // Avoid issues with certain headers like 'transfer-encoding' if content is transformed
            if (name.toLowerCase() !== 'transfer-encoding' && name.toLowerCase() !== 'content-encoding') {
                 res.setHeader(name, value);
            }
        });
        
        // Stream the response body from the target to the client
        proxyResponse.body.pipe(res);

    } catch (error) {
        console.error('[Proxy] Error during fetch to target:', error);
        if (error.code) { // System errors like ECONNREFUSED, ECONNRESET
            res.status(502).send({ error: `Proxy error: Could not connect to target. Code: ${error.code}`});
        } else {
            res.status(500).send({ error: 'Proxy error: Internal server error while fetching from target' });
        }
    }
});

app.listen(PORT, () => {
    console.log(`Universal proxy server listening on http://localhost:${PORT}`);
    console.log('Usage: Send requests to http://localhost:${PORT}/<actual_path>?target_url=<encoded_target_service_base_url_and_path>');
    console.log('Example: http://localhost:${PORT}/search.php?q=Test&target_url=https%3A%2F%2Fhdrezka.ag%2Fengine%2Fajax');
}); 