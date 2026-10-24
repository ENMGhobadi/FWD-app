// Upstream Forwarder — single-file Node 18+ HTTP server.
//
// Purpose: provide a stable exit IP for the mhr-cfw relay so sessions and
// CAPTCHA tokens that are bound to an IP survive verification on the target.
//
// Run this on any host with a stable public IP (a free-tier VM is enough).
// The relay reaches it from Cloudflare, so it does NOT need to be reachable
// from the censored network.
//
// Required env:
//   AUTH_KEY  — must match the Worker's UPSTREAM_AUTH_KEY (>= 32 chars)
//
// Optional env:
//   PORT              — listen port (default 8787)
//   HOST              — listen host (default 127.0.0.1, so Caddy/nginx fronts it)
//   TIMEOUT_MS        — per-request timeout (default 25000)
//   MAX_BODY_BYTES    — response cap (default 50 MB)
//   MAX_REQUEST_BYTES — request body cap (default 50 MB)
//   REDIRECT_LIMIT    — max redirects followed (default 5)
//   ALLOW_PRIVATE     — 1 = allow private targets (LOCAL TESTING ONLY)
//
// Wire protocol matches deploy/cloudflare-worker/worker.js:
//   POST /fwd  body: { u, m, h, b, ct, r }   ->  { s, h, b }  or  { e }

"use strict";

const http = require("http");
const dns = require("dns").promises;
const net = require("net");

const AUTH_KEY = process.env.AUTH_KEY || "";
const PORT = parseInt(process.env.PORT, 10) || 8787;
const HOST = process.env.HOST || "0.0.0.0";
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS, 10) || 25000;
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES, 10) || 50 * 1024 * 1024;
const MAX_REQUEST_BYTES = parseInt(process.env.MAX_REQUEST_BYTES, 10) || 50 * 1024 * 1024;
const REDIRECT_LIMIT = parseInt(process.env.REDIRECT_LIMIT, 10) || 5;
const ALLOW_PRIVATE = /^(1|true|yes|on)$/i.test(process.env.ALLOW_PRIVATE || "");

if (!AUTH_KEY || AUTH_KEY.length < 32) {
    console.error("FATAL: AUTH_KEY env var missing or shorter than 32 chars.");
    process.exit(1);
}

// Mirrors SKIP_HEADERS in deploy/gas/Code.gs.
const SKIP_HEADERS = new Set([
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "proxy-connection",
    "proxy-authorization",
    "x-upstream-auth",
    "x-relay-hop",
    "x-fwd-hop"
]);

const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet"];
const PRIVATE_HOSTS = new Set(["localhost", "::1", "::", "metadata", "metadata.google.internal"]);

const STATUS_PAGE =
    "<!DOCTYPE html><html><head><title>Forwarder Active</title></head>" +
    '<body style="font-family:sans-serif;max-width:600px;margin:40px auto">' +
    '<h1>Forwarder <span style="color:#16a34a;font-weight:700">Active</span></h1>' +
    "<p>Upstream forwarder for the mhr-cfw relay.</p>" +
    "</body></html>";

const server = http.createServer(async (req, res) => {
    try {
        if (req.method === "GET" && (req.url === "/" || req.url === "")) {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(STATUS_PAGE);
            return;
        }

        if (req.method !== "POST" || req.url !== "/fwd") {
            sendJson(res, 404, { e: "not found" });
            return;
        }

        if (!timingSafeEqual(req.headers["x-upstream-auth"] || "", AUTH_KEY)) {
            sendJson(res, 401, { e: "unauthorized" });
            return;
        }

        const raw = await readBody(req);
        let body;
        try {
            body = JSON.parse(raw);
        } catch (_) {
            sendJson(res, 200, { e: "invalid json" });
            return;
        }

        if (!body || !body.u || typeof body.u !== "string" || !/^https?:\/\//i.test(body.u)) {
            sendJson(res, 200, { e: "bad url" });
            return;
        }

        let target;
        try {
            target = new URL(body.u);
        } catch (_) {
            sendJson(res, 200, { e: "bad url" });
            return;
        }
        if (target.protocol !== "http:" && target.protocol !== "https:") {
            sendJson(res, 200, { e: "unsupported protocol" });
            return;
        }

        const headers = {};
        if (body.h && typeof body.h === "object") {
            for (const [key, value] of Object.entries(body.h)) {
                if (typeof value !== "string") continue;
                if (SKIP_HEADERS.has(key.toLowerCase())) continue;
                headers[key] = value;
            }
        }
        headers["x-fwd-hop"] = "1";

        const method = String(body.m || "GET").toUpperCase();
        const requestBody = body.b ? Buffer.from(String(body.b), "base64") : null;
        if (requestBody && requestBody.length > MAX_REQUEST_BYTES) {
            sendJson(res, 200, { e: "request body too large" });
            return;
        }

        const result = await fetchWithRedirects(
            target,
            method,
            headers,
            requestBody,
            body.r !== false
        );

        const buffer = Buffer.from(await result.response.arrayBuffer());
        if (buffer.length > MAX_BODY_BYTES) {
            sendJson(res, 200, { e: "response body too large" });
            return;
        }

        sendJson(res, 200, {
            s: result.response.status,
            h: responseHeaders(result.response),
            b: buffer.toString("base64")
        });
    } catch (err) {
        sendJson(res, 200, { e: String((err && err.message) || err) });
    }
});

server.listen(PORT, HOST, () => {
    console.log("upstream_forwarder listening on " + HOST + ":" + PORT);
    if (ALLOW_PRIVATE) console.warn("WARNING: ALLOW_PRIVATE=1 — SSRF protection is disabled");
});

// ── fetching ─────────────────────────────────────────────────────

async function fetchWithRedirects(initialUrl, method, headers, body, followRedirects) {
    const originHost = initialUrl.hostname;
    let currentUrl = initialUrl;
    let currentMethod = method;
    let currentBody = body;
    let currentHeaders = { ...headers };

    for (let hop = 0; ; hop++) {
        await assertPublicTarget(currentUrl);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        let response;
        try {
            const init = {
                method: currentMethod,
                headers: currentHeaders,
                redirect: "manual",
                signal: controller.signal
            };
            if (currentBody && currentBody.length) init.body = currentBody;
            response = await fetch(currentUrl.toString(), init);
        } finally {
            clearTimeout(timer);
        }

        if (!followRedirects || !isRedirect(response.status)) {
            return { response, url: currentUrl };
        }

        const location = response.headers.get("location");
        if (!location) return { response, url: currentUrl };

        let next;
        try {
            next = new URL(location, currentUrl);
        } catch (_) {
            return { response, url: currentUrl };
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
            return { response, url: currentUrl };
        }
        if (hop >= REDIRECT_LIMIT) {
            throw new Error("too many redirects");
        }

        if (next.hostname !== originHost) {
            currentHeaders = stripCredentials(currentHeaders);
        }
        if (
            response.status === 303 ||
            ((response.status === 301 || response.status === 302) &&
                currentMethod !== "GET" &&
                currentMethod !== "HEAD")
        ) {
            currentMethod = "GET";
            currentBody = null;
            currentHeaders = stripHeader(currentHeaders, "content-type");
        }

        currentUrl = next;
    }
}

function responseHeaders(response) {
    const out = {};
    response.headers.forEach((value, key) => {
        out[key] = value;
    });

    if (typeof response.headers.getSetCookie === "function") {
        const cookies = response.headers.getSetCookie();
        if (cookies && cookies.length > 1) out["set-cookie"] = cookies;
    }

    return out;
}

// ── SSRF protection ──────────────────────────────────────────────

async function assertPublicTarget(url) {
    if (ALLOW_PRIVATE) return;

    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host) throw new Error("empty host");
    if (PRIVATE_HOSTS.has(host)) throw new Error("private host blocked");
    if (PRIVATE_SUFFIXES.some(suffix => host.endsWith(suffix))) {
        throw new Error("private host blocked");
    }

    const family = net.isIP(host);
    if (family === 4) {
        if (isPrivateIPv4(host)) throw new Error("private address blocked");
        return;
    }
    if (family === 6) {
        if (isPrivateIPv6(host)) throw new Error("private address blocked");
        return;
    }

    let records;
    try {
        records = await dns.lookup(host, { all: true, verbatim: true });
    } catch (err) {
        throw new Error("DNS resolution failed: " + ((err && err.message) || err));
    }
    if (!records.length) throw new Error("DNS resolution failed");

    for (const record of records) {
        const address = record.address;
        const kind = net.isIP(address);
        if (kind === 4 && isPrivateIPv4(address)) throw new Error("private address blocked");
        if (kind === 6 && isPrivateIPv6(address)) throw new Error("private address blocked");
    }
}

function isPrivateIPv4(ip) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isFinite(part))) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && (b === 168 || b === 0)) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
}

function isPrivateIPv6(ip) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (/^fe[89ab]/.test(lower)) return true;
    if (/^f[cd]/.test(lower)) return true;
    if (lower.startsWith("::ffff:")) {
        const mapped = lower.slice(7);
        return net.isIP(mapped) === 4 ? isPrivateIPv4(mapped) : true;
    }
    return false;
}

// ── helpers ──────────────────────────────────────────────────────

function isRedirect(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function stripCredentials(headers) {
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        const lower = key.toLowerCase();
        if (lower === "authorization" || lower === "cookie" || lower === "proxy-authorization") continue;
        out[key] = value;
    }
    return out;
}

function stripHeader(headers, name) {
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === name) continue;
        out[key] = value;
    }
    return out;
}

function timingSafeEqual(left, right) {
    if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
    let diff = 0;
    for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
    return diff === 0;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;

        req.on("data", chunk => {
            size += chunk.length;
            if (size > MAX_REQUEST_BYTES) {
                reject(new Error("request body too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(body);
}
