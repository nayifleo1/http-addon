import { isValidHostName } from "./isValidHostName.js";
import { getProxyForUrl } from "proxy-from-env";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import withCORS from "./withCORS.js";
import parseURL from "./parseURL.js";
import proxyM3U8 from "./proxyM3U8.js";
import { proxyTs } from "./proxyTS.js";

// Helper function to get raw parameter value, then decode it
function getRawParamValueFromRequest(fullRequestUrl, paramName) {
  const paramPrefix = paramName + "=";
  const queryPart = fullRequestUrl.split('?')[1];
  if (!queryPart) {
    return null;
  }

  const params = queryPart.split('&');
  for (const p of params) {
    if (p.startsWith(paramPrefix)) {
      const rawValue = p.substring(paramPrefix.length);
      // decodeURIComponent handles %2B -> +, %20 -> space, etc.
      // If a raw '+' was in rawValue (and not part of a %xx sequence), it remains '+'.
      return decodeURIComponent(rawValue);
    }
  }
  return null;
}

export default function getHandler(options, proxy) {
  const corsAnywhere = {
    handleInitialRequest: null,
    getProxyForUrl: getProxyForUrl,
    maxRedirects: 5,
    originBlacklist: [],
    originWhitelist: [],
    checkRateLimit: null,
    redirectSameOrigin: false,
    requireHeader: null,
    removeHeaders: [],
    setHeaders: {},
    corsMaxAge: 0,
  };

  Object.keys(corsAnywhere).forEach(function (option) {
    if (Object.prototype.hasOwnProperty.call(options, option)) {
      corsAnywhere[option] = options[option];
    }
  });

  if (corsAnywhere.requireHeader) {
    if (typeof corsAnywhere.requireHeader === "string") {
      corsAnywhere.requireHeader = [corsAnywhere.requireHeader.toLowerCase()];
    } else if (
      !Array.isArray(corsAnywhere.requireHeader) ||
      corsAnywhere.requireHeader.length === 0
    ) {
      corsAnywhere.requireHeader = null;
    } else {
      corsAnywhere.requireHeader = corsAnywhere.requireHeader.map(function (
        headerName
      ) {
        return headerName.toLowerCase();
      });
    }
  }
  const hasRequiredHeaders = function (headers) {
    return (
      !corsAnywhere.requireHeader ||
      corsAnywhere.requireHeader.some(function (headerName) {
        return Object.hasOwnProperty.call(headers, headerName);
      })
    );
  };

  return function (req, res) {
    req.corsAnywhereRequestState = {
      getProxyForUrl: corsAnywhere.getProxyForUrl,
      maxRedirects: corsAnywhere.maxRedirects,
      corsMaxAge: corsAnywhere.corsMaxAge,
    };

    const cors_headers = withCORS({}, req);
    if (req.method === "OPTIONS") {
      res.writeHead(200, cors_headers);
      res.end();
      return;
    }

    const location = parseURL(req.url.slice(1));

    if (
      corsAnywhere.handleInitialRequest &&
      corsAnywhere.handleInitialRequest(req, res, location)
    ) {
      return;
    }

    if (!location) {
      if (/^\/https?:\/[^/]/i.test(req.url)) {
        res.writeHead(400, "Missing slash", cors_headers);
        res.end(
          "The URL is invalid: two slashes are needed after the http(s):."
        );
        return;
      }
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);

      res.end(readFileSync(join(__dirname, "../index.html")));
      return;
    }

    if (location.host === "iscorsneeded") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("no");
      return;
    }

    if ((Number(location.port) ?? 0) > 65535) {
      res.writeHead(400, "Invalid port", cors_headers);
      res.end("Port number too large: " + location.port);
      return;
    }

    if (!/^\/https?:/.test(req.url) && !isValidHostName(location.hostname)) {
      // This block handles paths like /m3u8-proxy, /ts-proxy when not in the /http://<actual_url> format
      
      // uri is still useful for pathname and other params like 'headers'
      // Assuming "http://localhost:3000" as a base is for parsing req.url if it's a relative path.
      const uri = new URL(req.url, "http://localhost:3000");

      if (uri.pathname === "/m3u8-proxy") {
        let headers = {};
        try {
          const headersString = uri.searchParams.get("headers");
          if (headersString) {
            // Assuming original author's intent for headers parsing.
            // Note: If headersString is from .get(), it's already URL-decoded.
            // Applying decodeURIComponent again might be problematic if the JSON
            // string itself contained '%' not part of a valid escape sequence.
            // For now, keeping original logic for headers.
            headers = JSON.parse(decodeURIComponent(headersString));
          }
        } catch (e) {
          res.writeHead(500);
          res.end(e.message);
          return;
        }
        const proxiedUrl = getRawParamValueFromRequest(req.url, "url");
        return proxyM3U8(proxiedUrl ?? "", headers, res);
      } else if (uri.pathname === "/ts-proxy") {
        let headers = {};
        try {
          const headersString = uri.searchParams.get("headers");
          if (headersString) {
            // Same note about decodeURIComponent(headersString) as above.
            headers = JSON.parse(decodeURIComponent(headersString));
          }
        } catch (e) {
          res.writeHead(500);
          res.end(e.message);
          return;
        }
        const proxiedUrl = getRawParamValueFromRequest(req.url, "url");
        return proxyTs(proxiedUrl ?? "", headers, req, res);
      } else if (uri.pathname === "/") {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);

        res.end(readFileSync(join(__dirname, "../index.html")));
        return;
      } else {
        res.writeHead(404, "Invalid host", cors_headers);
        res.end("Invalid host: " + location.hostname);
        return;
      }
    }

    if (!hasRequiredHeaders(req.headers)) {
      res.writeHead(400, "Header required", cors_headers);
      res.end(
        "Missing required request header. Must specify one of: " +
          corsAnywhere.requireHeader
      );
      return;
    }

    const origin = req.headers.origin || "";
    if (corsAnywhere.originBlacklist.indexOf(origin) >= 0) {
      res.writeHead(403, "Forbidden", cors_headers);
      res.end(
        'The origin "' +
          origin +
          '" was blacklisted by the operator of this proxy.'
      );
      return;
    }

    if (
      corsAnywhere.originWhitelist.length &&
      corsAnywhere.originWhitelist.indexOf(origin) === -1
    ) {
      res.writeHead(403, "Forbidden", cors_headers);
      res.end(
        'The origin "' +
          origin +
          '" was not whitelisted by the operator of this proxy.'
      );
      return;
    }

    const rateLimitMessage =
      corsAnywhere.checkRateLimit && corsAnywhere.checkRateLimit(origin);
    if (rateLimitMessage) {
      res.writeHead(429, "Too Many Requests", cors_headers);
      res.end(
        'The origin "' +
          origin +
          '" has sent too many requests.\n' +
          rateLimitMessage
      );
      return;
    }

    if (
      corsAnywhere.redirectSameOrigin &&
      origin &&
      location.href[origin.length] === "/" &&
      location.href.lastIndexOf(origin, 0) === 0
    ) {
      cors_headers.vary = "origin";
      cors_headers["cache-control"] = "private";
      cors_headers.location = location.href;
      res.writeHead(301, "Please use a direct request", cors_headers);
      res.end();
      return;
    }

    const isRequestedOverHttps =
      req.connection.encrypted ||
      /^\s*https/.test(req.headers["x-forwarded-proto"]);
    const proxyBaseUrl =
      (isRequestedOverHttps ? "https://" : "http://") + req.headers.host;

    corsAnywhere.removeHeaders.forEach(function (header) {
      delete req.headers[header];
    });

    Object.keys(corsAnywhere.setHeaders).forEach(function (header) {
      req.headers[header] = corsAnywhere.setHeaders[header];
    });

    req.corsAnywhereRequestState.location = location;
    req.corsAnywhereRequestState.proxyBaseUrl = proxyBaseUrl;

    proxyRequest(req, res, proxy);
  };
}
