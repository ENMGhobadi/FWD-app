// MHR Exit Worker — second hop for the mhr-cfw relay.
//
// Wire contract (identical to deploy/cloudflare-worker/worker.js and
// deploy/gas/Code.gs, so the existing GAS + primary Worker stay untouched):
//
//   POST /   headers: x-upstream-auth: <RELAY_KEY>
//   body:    { u, m, h, b, ct, r }        b = base64 request body
//   200:     { s, h, b }                  s = status, h = headers, b = base64 body
//   200:     { e: "message" }             relay-level error (client renders 502)
//
// Modes (env MODE):
//   fetch   - plain fetch(); same egress class as the primary Worker.
//   socket  - minimal HTTP/1.1 client over cloudflare:sockets connect().
//             Uses Cloudflare's TCP egress instead of its fetch egress.
//   forward - POST the envelope to a fixed-IP forwarder. FORWARD_URLS accepts
//             a comma-separated pool; the worker keeps a sticky exit and
//             fails over to the next healthy one (ROUTER_MODE=sticky|hash|
//             round-robin). This is the only mode with a stable exit IP.
//
// Security: RELAY_KEY is mandatory (>= 32 chars). Private/loopback/metadata
// targets, self-fetches and configured block hosts are rejected.

import { connect } from 'cloudflare:sockets';

const VERSION = '1.0.0';

const DEFAULTS = {
	TIMEOUT_MS: 25000,
	MAX_BODY_BYTES: 50 * 1024 * 1024,
	MAX_REQUEST_BYTES: 50 * 1024 * 1024,
	REDIRECT_LIMIT: 5
};

// Headers that must not be copied across a single hop (RFC 7230 §6.1).
const HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'host',
	'content-length'
]);

const PRIVATE_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet'];
const PRIVATE_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '::', 'metadata', 'metadata.google.internal']);

export default {
	async fetch(request, env) {
		const cfg = readConfig(env);

		if (request.method === 'GET') {
			const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';

			if (path === '/status') {
				const provided = request.headers.get('x-upstream-auth') || '';
				if (!timingSafeEqual(provided, cfg.relayKey)) {
					return json({ e: 'unauthorized' }, 401);
				}
				return json(routerStatus(cfg));
			}
			if (path !== '/') {
				return json({ e: 'not found' }, 404);
			}

			return json({
				ok: true,
				service: 'mhr-exit-worker',
				version: VERSION,
				mode: cfg.mode,
				routerMode: cfg.routerMode,
				pool: cfg.forwardUrls.length,
				keepalive: cfg.keepAliveUrls.length > 0
			});
		}
		if (request.method !== 'POST') {
			return json({ e: 'method not allowed' }, 405);
		}

		if (!cfg.relayKey || cfg.relayKey.length < 32) {
			return json({ e: 'exit worker misconfigured: RELAY_KEY must be at least 32 characters' }, 500);
		}

		const provided = request.headers.get('x-upstream-auth') || '';
		if (!timingSafeEqual(provided, cfg.relayKey)) {
			return json({ e: 'unauthorized' }, 401);
		}
		if (request.headers.get('x-relay-hop') === '1' || request.headers.get('x-fwd-hop') === '1') {
			return json({ e: 'loop detected' }, 508);
		}

		let payload;
		try {
			payload = await request.json();
		} catch {
			return json({ e: 'invalid json' }, 400);
		}

		if (!payload || typeof payload.u !== 'string' || !/^https?:\/\//i.test(payload.u)) {
			return json({ e: 'missing or invalid url' }, 400);
		}

		let target;
		try {
			target = new URL(payload.u);
		} catch {
			return json({ e: 'invalid url' }, 400);
		}
		if (target.protocol !== 'http:' && target.protocol !== 'https:') {
			return json({ e: 'unsupported protocol' }, 400);
		}

		cfg.selfHost = new URL(request.url).hostname.toLowerCase();
		const guard = checkTarget(target, cfg);
		if (guard) {
			return json({ e: guard }, 400);
		}

		let body = null;
		if (typeof payload.b === 'string' && payload.b.length) {
			try {
				body = base64ToBytes(payload.b);
			} catch {
				return json({ e: 'invalid base64 body' }, 400);
			}
		}
		if (body && body.byteLength > cfg.maxRequestBytes) {
			return json({ e: 'request body too large' }, 413);
		}

		const req = {
			url: target.toString(),
			method: String(payload.m || 'GET').toUpperCase(),
			headers: normalizeHeaders(payload.h),
			body,
			followRedirects: payload.r !== false
		};

		try {
			const out = await dispatch(req, cfg);
			return json({ s: out.status, h: out.headers, b: bytesToBase64(out.body) });
		} catch (err) {
			// Always answer 200 so the primary Worker can pass the body through;
			// the local proxy turns "e" into a 502 page.
			return json({ e: errorMessage(err) });
		}
	},

	// Cron Trigger (e.g. "*/10 * * * *"): keep the fixed-IP forwarder awake.
	// Free hosting tiers (Render, etc.) sleep after ~15 minutes and need
	// ~1 minute to wake up, which would otherwise time out the relay chain.
	async scheduled(event, env, ctx) {
		const cfg = readConfig(env);
		if (!cfg.keepAliveUrls.length) return;
		ctx.waitUntil(
			Promise.allSettled(
				cfg.keepAliveUrls.map(url =>
					fetch(url, {
						method: 'GET',
						redirect: 'follow',
						signal: AbortSignal.timeout(20000)
					})
				)
			)
		);
	}
};

// ── configuration ────────────────────────────────────────────────

function parseList(value) {
	return String(value || '')
		.split(/[\s,]+/)
		.map(item => item.trim())
		.filter(Boolean);
}

function unique(values) {
	return [...new Set(values)];
}

function routerModeOf(value) {
	const mode = String(value || 'sticky').trim().toLowerCase();
	return ['sticky', 'hash', 'round-robin'].includes(mode) ? mode : 'sticky';
}

function readConfig(env) {
	env = env || {};
	const requested = String(env.MODE || 'fetch').trim().toLowerCase();
	const mode = ['fetch', 'socket', 'forward'].includes(requested) ? requested : 'fetch';

	const forwardUrls = unique(
		parseList(env.FORWARD_URLS).concat(parseList(env.FORWARD_URL))
	);
	const explicitKeepAlive = unique(
		parseList(env.KEEPALIVE_URLS).concat(parseList(env.KEEPALIVE_URL))
	);

	return {
		mode,
		relayKey: String(env.RELAY_KEY || ''),
		forwardUrls,
		forwardKey: String(env.FORWARD_KEY || env.RELAY_KEY || ''),
		routerMode: routerModeOf(env.ROUTER_MODE),
		forwardTimeoutMs: intOr(env.FORWARD_TIMEOUT_MS, 45000),
		forwardCooldownMs: intOr(env.FORWARD_COOLDOWN_MS, 120000),
		forwardAttempts: intOr(env.FORWARD_ATTEMPTS, 3),
		keepAliveUrls: explicitKeepAlive.length
			? explicitKeepAlive
			: forwardUrls.map(deriveKeepAlive).filter(Boolean),
		timeoutMs: intOr(env.TIMEOUT_MS, DEFAULTS.TIMEOUT_MS),
		maxBodyBytes: intOr(env.MAX_BODY_BYTES, DEFAULTS.MAX_BODY_BYTES),
		maxRequestBytes: intOr(env.MAX_REQUEST_BYTES, DEFAULTS.MAX_REQUEST_BYTES),
		redirectLimit: intOr(env.REDIRECT_LIMIT, DEFAULTS.REDIRECT_LIMIT),
		fallbackToFetch: boolOr(env.FALLBACK_TO_FETCH, true),
		allowPrivate: boolOr(env.ALLOW_PRIVATE, false),
		blockHosts: String(env.BLOCK_HOSTS || '')
			.split(',')
			.map(s => s.trim().toLowerCase())
			.filter(Boolean),
		selfHost: ''
	};
}

function deriveKeepAlive(forwardUrl) {
	if (!forwardUrl) return '';
	try {
		return new URL(String(forwardUrl)).origin + '/';
	} catch {
		return '';
	}
}

// ── forwarder pool / failover ────────────────────────────────────
//
// Workers are ephemeral, so this state is best-effort per isolate. The
// selection itself is deterministic (config order for sticky), and a failed
// target is skipped for a cooldown window.

const ROUTER_STATE = new Map();
let stickyUrl = '';
let roundRobinCursor = 0;

function routerState(url) {
	let state = ROUTER_STATE.get(url);
	if (!state) {
		state = { failures: 0, cooldownUntil: 0, lastError: '', lastSuccess: 0 };
		ROUTER_STATE.set(url, state);
	}
	return state;
}

function markSuccess(url) {
	const state = routerState(url);
	state.failures = 0;
	state.cooldownUntil = 0;
	state.lastError = '';
	state.lastSuccess = Date.now();
	stickyUrl = url;
}

function markFailure(url, err, cfg) {
	const state = routerState(url);
	state.failures += 1;
	state.lastError = errorMessage(err);
	const backoff = Math.min(cfg.forwardCooldownMs * state.failures, 10 * 60 * 1000);
	state.cooldownUntil = Date.now() + backoff;
}

function pickCandidates(cfg, req) {
	const urls = cfg.forwardUrls;
	if (!urls.length) return [];

	const now = Date.now();
	const healthy = urls.filter(url => routerState(url).cooldownUntil <= now);
	const pool = healthy.length
		? healthy
		: urls.slice().sort((a, b) => routerState(a).cooldownUntil - routerState(b).cooldownUntil);

	if (cfg.routerMode === 'hash') {
		let key = req.url;
		try {
			key = new URL(req.url).hostname;
		} catch {
			/* keep the full URL */
		}
		const start = hashString(key) % pool.length;
		return pool.slice(start).concat(pool.slice(0, start));
	}

	if (cfg.routerMode === 'round-robin') {
		const start = roundRobinCursor % pool.length;
		roundRobinCursor = (roundRobinCursor + 1) % Number.MAX_SAFE_INTEGER;
		return pool.slice(start).concat(pool.slice(0, start));
	}

	// sticky: keep using one exit until it fails, so IP-bound sessions survive.
	const sticky = pool.includes(stickyUrl) ? stickyUrl : '';
	return sticky ? [sticky].concat(pool.filter(url => url !== sticky)) : pool.slice();
}

function hashString(value) {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function hostOf(url) {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

function routerStatus(cfg) {
	const now = Date.now();
	return {
		ok: true,
		mode: cfg.mode,
		routerMode: cfg.routerMode,
		sticky: stickyUrl || null,
		attempts: cfg.forwardAttempts,
		keepaliveUrls: cfg.keepAliveUrls,
		targets: cfg.forwardUrls.map(url => {
			const state = routerState(url);
			return {
				url,
				failures: state.failures,
				cooldownMs: Math.max(0, state.cooldownUntil - now),
				lastError: state.lastError || null,
				lastSuccess: state.lastSuccess || null
			};
		})
	};
}

function dispatch(req, cfg) {
	if (cfg.mode === 'forward') {
		if (!cfg.forwardUrls.length) {
			throw new RelayError('forward mode requires FORWARD_URL or FORWARD_URLS', 'CONFIG');
		}
		return runForward(req, cfg);
	}
	if (cfg.mode === 'socket') {
		return runSocket(req, cfg).catch(err => {
			if (cfg.fallbackToFetch && isFallbackError(err)) return runFetch(req, cfg);
			throw err;
		});
	}
	return runFetch(req, cfg);
}

// ── fetch mode ───────────────────────────────────────────────────

async function runFetch(req, cfg) {
	const headers = sanitizeRequestHeaders(req.headers);
	headers.set('x-relay-hop', '1');

	const init = {
		method: req.method,
		headers,
		redirect: req.followRedirects ? 'follow' : 'manual',
		signal: AbortSignal.timeout(cfg.timeoutMs)
	};
	if (req.body && req.body.byteLength) init.body = req.body;

	const resp = await fetch(req.url, init);
	const body = new Uint8Array(await resp.arrayBuffer());
	if (body.byteLength > cfg.maxBodyBytes) {
		throw new RelayError('response body too large (' + body.byteLength + ' bytes)', 'TOO_LARGE');
	}

	return { status: resp.status, headers: headersToObject(resp.headers), body };
}

// ── forward mode (fixed-IP upstream) ─────────────────────────────

async function runForward(req, cfg) {
	const candidates = pickCandidates(cfg, req).slice(
		0,
		Math.max(1, Math.min(cfg.forwardAttempts, cfg.forwardUrls.length))
	);
	const errors = [];

	for (const url of candidates) {
		try {
			const out = await runForwardTo(url, req, cfg);
			markSuccess(url);
			return out;
		} catch (err) {
			markFailure(url, err, cfg);
			errors.push(hostOf(url) + ': ' + errorMessage(err));
			if (err instanceof RelayError && err.code === 'CONFIG') break;
		}
	}

	throw new RelayError('all forwarders failed: ' + errors.join(' | '), 'UPSTREAM');
}

async function runForwardTo(url, req, cfg) {
	const payload = {
		u: req.url,
		m: req.method,
		h: headersToPlain(req.headers),
		b: req.body ? bytesToBase64(req.body) : null,
		r: req.followRedirects
	};

	const resp = await fetch(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-upstream-auth': cfg.forwardKey
		},
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(cfg.forwardTimeoutMs)
	});

	if (!resp.ok) {
		throw new RelayError('forwarder HTTP ' + resp.status + ' (' + hostOf(url) + ')', 'UPSTREAM');
	}

	const text = await resp.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		throw new RelayError('forwarder returned invalid JSON', 'UPSTREAM');
	}
	if (data && data.e) throw new RelayError('forwarder: ' + data.e, 'UPSTREAM');
	if (!data || typeof data.s !== 'number') throw new RelayError('forwarder returned an invalid envelope', 'UPSTREAM');

	return {
		status: data.s,
		headers: data.h && typeof data.h === 'object' ? data.h : {},
		body: base64ToBytes(data.b || '')
	};
}

// ── socket mode: HTTP/1.1 over connect() ─────────────────────────

async function runSocket(req, cfg) {
	let current = new URL(req.url);
	let method = req.method;
	let body = req.body;
	let headers = req.headers;
	const originHost = current.hostname;

	for (let hop = 0; hop <= cfg.redirectLimit; hop++) {
		const res = await socketRequest(current, method, headers, body, cfg);

		if (!req.followRedirects) return res;

		const location = headerValue(res.headers, 'location');
		if (!isRedirect(res.status) || !location) return res;

		let next;
		try {
			next = new URL(location, current);
		} catch {
			return res;
		}
		if (next.protocol !== 'http:' && next.protocol !== 'https:') return res;

		const guard = checkTarget(next, cfg);
		if (guard) throw new RelayError(guard, 'FORBIDDEN');

		if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
			method = 'GET';
			body = null;
		}
		// Never forward credentials to a different origin.
		if (next.hostname !== originHost) {
			headers = stripAuthHeaders(headers);
		}

		current = next;
	}

	throw new RelayError('too many redirects', 'BAD_RESPONSE');
}

async function socketRequest(target, method, headers, body, cfg) {
	const secure = target.protocol === 'https:';
	const port = target.port ? Number(target.port) : secure ? 443 : 80;

	if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new RelayError('invalid port', 'FORBIDDEN');
	if (port === 25) throw new RelayError('port 25 is not allowed', 'FORBIDDEN');

	const hostname = target.hostname.replace(/^\[|\]$/g, '');
	const requestBytes = buildRequestBytes(target, method, headers, body);

	let socket;
	let reader;
	try {
		socket = connect({ hostname, port }, { secureTransport: secure ? 'on' : 'off', allowHalfOpen: true });
		await socket.opened;

		const writer = socket.writable.getWriter();
		try {
			await writer.write(requestBytes);
		} finally {
			try {
				await writer.close();
			} catch {
				/* half-close may already have happened */
			}
		}

		reader = socket.readable.getReader();
		const raw = await readHttpResponse(reader, method, cfg);

		const decoded = await decompressBody(raw.headers, raw.body, cfg);
		return { status: raw.status, headers: decoded.headers, body: decoded.body };
	} catch (err) {
		if (err instanceof RelayError) throw err;
		throw new RelayError('socket request failed: ' + errorMessage(err), 'NETWORK');
	} finally {
		try {
			if (reader) reader.releaseLock();
		} catch {
			/* ignore */
		}
		try {
			if (socket) await socket.close();
		} catch {
			/* ignore */
		}
	}
}

function buildRequestBytes(target, method, headers, body) {
	const lines = [];
	const path = (target.pathname || '/') + target.search;
	lines.push(method + ' ' + path + ' HTTP/1.1');
	lines.push('Host: ' + target.host);

	const seen = new Set(['host']);
	for (const [name, value] of Object.entries(headers || {})) {
		const lower = String(name).toLowerCase();
		if (HOP_BY_HOP.has(lower) || seen.has(lower)) continue;
		if (lower === 'accept-encoding' || lower === 'connection') continue;
		if (value === undefined || value === null) continue;
		const values = Array.isArray(value) ? value : [value];
		for (const item of values) lines.push(name + ': ' + String(item));
		seen.add(lower);
	}

	// Ask for an identity body: the relay cannot decode brotli/zstd and the
	// client-side proxy strips content-encoding when rebuilding the response.
	lines.push('Accept-Encoding: identity');
	lines.push('Connection: close');

	const bodyLength = body ? body.byteLength : 0;
	if (bodyLength || ['POST', 'PUT', 'PATCH'].includes(method)) {
		lines.push('Content-Length: ' + bodyLength);
	}

	const head = new TextEncoder().encode(lines.join('\r\n') + '\r\n\r\n');
	if (!bodyLength) return head;

	const out = new Uint8Array(head.byteLength + bodyLength);
	out.set(head, 0);
	out.set(body, head.byteLength);
	return out;
}

async function readHttpResponse(reader, method, cfg) {
	const deadline = Date.now() + cfg.timeoutMs;

	// Bytes that have not been consumed as response headers yet.
	let buffer = new Uint8Array(0);
	let headers = null;
	let status = 0;
	let framing = null;
	let eof = false;

	const finish = bodyBytes => {
		const clean = { ...headers };
		delete clean['transfer-encoding'];
		delete clean['content-length'];
		return { status, headers: clean, body: bodyBytes };
	};

	for (;;) {
		if (!headers) {
			const end = indexOfHeaderEnd(buffer);
			if (end !== -1) {
				const parsed = parseHead(decodeLatin1(buffer.subarray(0, end)));
				if (!parsed) {
					// Almost always HTTP/2 negotiated via ALPN: our HTTP/1.1 bytes
					// are not valid there. The caller retries through fetch().
					throw new RelayError('invalid HTTP response (possible HTTP/2 ALPN)', 'ALPN');
				}

				status = parsed.status;
				buffer = buffer.slice(end + 4);

				// 1xx informational responses are followed by the real response.
				if (status >= 100 && status < 200) continue;

				headers = parsed.headers;

				// HEAD and 204/304 never carry a body.
				if (method === 'HEAD' || status === 204 || status === 304) {
					return finish(new Uint8Array(0));
				}

				framing = startFraming(headers);
			} else {
				// A valid HTTP/1.x response always starts with "HTTP/". Anything
				// else is almost certainly an HTTP/2 frame (ALPN chose h2).
				if (buffer.byteLength >= 5 && !looksLikeHttp(buffer)) {
					throw new RelayError('invalid HTTP response (possible HTTP/2 ALPN)', 'ALPN');
				}
				if (buffer.byteLength > 65536) throw new RelayError('response headers too large', 'BAD_RESPONSE');
				if (eof) {
					if (buffer.byteLength >= 5 && !looksLikeHttp(buffer)) {
						throw new RelayError('invalid HTTP response (possible HTTP/2 ALPN)', 'ALPN');
					}
					throw new RelayError('connection closed before response headers', 'BAD_RESPONSE');
				}
			}
		}

		if (headers) {
			const progress = pushBody(framing, buffer, cfg);
			buffer = new Uint8Array(0);
			if (progress.done) return finish(progress.body);

			if (eof) {
				if (framing.type === 'chunked') throw new RelayError('truncated chunked body', 'BAD_RESPONSE');
				if (framing.type === 'length') {
					const body = concatPieces(framing.pieces);
					if (body.byteLength < framing.length) throw new RelayError('truncated response body', 'BAD_RESPONSE');
					return finish(body.slice(0, framing.length));
				}
				return finish(concatPieces(framing.pieces));
			}
		}

		if (Date.now() > deadline) throw new RelayError('response timeout', 'TIMEOUT');

		const { value, done } = await readWithDeadline(reader, deadline, cfg.timeoutMs);
		if (done) {
			eof = true;
			continue;
		}

		const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
		buffer = buffer.byteLength ? concatBytes(buffer, chunk) : chunk;
	}
}

function startFraming(headers) {
	const transfer = String(headerValue(headers, 'transfer-encoding') || '').toLowerCase();
	if (transfer.includes('chunked')) {
		return { type: 'chunked', pending: new Uint8Array(0), pieces: [], size: 0 };
	}

	const lengthHeader = headerValue(headers, 'content-length');
	if (lengthHeader !== undefined) {
		const length = Number(lengthHeader);
		if (!Number.isFinite(length) || length < 0) throw new RelayError('invalid content-length', 'BAD_RESPONSE');
		return { type: 'length', length, pieces: [], size: 0 };
	}

	return { type: 'eof', pieces: [], size: 0 };
}

function pushBody(framing, data, cfg) {
	if (framing.type === 'chunked') {
		framing.pending = concatBytes(framing.pending, data);
		const result = consumeChunked(framing.pending, framing.pieces);
		framing.pending = framing.pending.subarray(result.consumed);
		framing.size += result.added;
		if (framing.size > cfg.maxBodyBytes) throw new RelayError('response body too large', 'TOO_LARGE');
		if (result.done) return { done: true, body: concatPieces(framing.pieces) };
		return { done: false, body: null };
	}

	if (data && data.byteLength) {
		framing.pieces.push(data);
		framing.size += data.byteLength;
	}
	if (framing.size > cfg.maxBodyBytes) throw new RelayError('response body too large', 'TOO_LARGE');

	if (framing.type === 'length' && framing.size >= framing.length) {
		return { done: true, body: concatPieces(framing.pieces).slice(0, framing.length) };
	}

	return { done: false, body: null };
}

// Incremental de-chunking. Appends decoded pieces and reports how many input
// bytes were consumed so the caller keeps only the unprocessed tail.
function consumeChunked(buffer, pieces) {
	let offset = 0;
	let added = 0;

	for (;;) {
		const lineEnd = indexOfCrlf(buffer, offset);
		if (lineEnd === -1) break;

		const sizeText = decodeLatin1(buffer.subarray(offset, lineEnd)).split(';')[0].trim();
		const size = parseInt(sizeText, 16);
		if (!Number.isFinite(size) || size < 0) throw new RelayError('invalid chunk size', 'BAD_RESPONSE');

		const dataStart = lineEnd + 2;

		if (size === 0) {
			// Optional trailers terminated by an empty line.
			if (buffer.byteLength >= dataStart + 2 && buffer[dataStart] === 13 && buffer[dataStart + 1] === 10) {
				return { done: true, consumed: dataStart + 2, added };
			}
			const trailerEnd = indexOfHeaderEnd(buffer.subarray(dataStart));
			if (trailerEnd === -1) break;
			return { done: true, consumed: dataStart + trailerEnd + 4, added };
		}

		const dataEnd = dataStart + size;
		if (buffer.byteLength < dataEnd + 2) break;

		pieces.push(buffer.subarray(dataStart, dataEnd));
		added += size;
		offset = dataEnd + 2;
	}

	return { done: false, consumed: offset, added };
}

// ── response decoding ────────────────────────────────────────────

async function decompressBody(headers, body, cfg) {
	const raw = String(headerValue(headers, 'content-encoding') || '').trim().toLowerCase();
	if (!raw || raw === 'identity') return { headers, body };

	const formats = raw.split(',').map(s => s.trim()).filter(Boolean).reverse();
	let out = body;
	for (const format of formats) {
		out = await decodeWith(format, out);
	}
	if (out.byteLength > cfg.maxBodyBytes) throw new RelayError('response body too large', 'TOO_LARGE');

	const clean = { ...headers };
	delete clean['content-encoding'];
	delete clean['content-length'];
	return { headers: clean, body: out };
}

async function decodeWith(format, bytes) {
	const attempts = format === 'gzip' || format === 'x-gzip'
		? ['gzip']
		: format === 'deflate'
			? ['deflate', 'deflate-raw']
			: format === 'deflate-raw'
				? ['deflate-raw']
				: null;

	if (!attempts) {
		throw new RelayError('unsupported content-encoding: ' + format, 'UNSUPPORTED_ENCODING');
	}

	let lastError = null;
	for (const name of attempts) {
		try {
			const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(name));
			return new Uint8Array(await new Response(stream).arrayBuffer());
		} catch (err) {
			lastError = err;
		}
	}
	throw new RelayError('could not decode ' + format + ': ' + errorMessage(lastError), 'UNSUPPORTED_ENCODING');
}

// ── helpers ──────────────────────────────────────────────────────

class RelayError extends Error {
	constructor(message, code) {
		super(message);
		this.name = 'RelayError';
		this.code = code || 'RELAY';
	}
}

function isFallbackError(err) {
	if (!(err instanceof RelayError)) return true;
	return ['ALPN', 'NETWORK', 'DISALLOWED', 'UNSUPPORTED_ENCODING', 'BAD_RESPONSE'].includes(err.code);
}

function errorMessage(err) {
	if (!err) return 'unknown error';
	if (typeof err === 'string') return err;
	return err.message || String(err);
}

function checkTarget(target, cfg) {
	const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (!host) return 'empty host';

	if (cfg.selfHost && host === cfg.selfHost) return 'self fetch blocked';

	for (const blocked of cfg.blockHosts) {
		if (host === blocked || host.endsWith('.' + blocked)) return 'host blocked by policy';
	}

	if (!cfg.allowPrivate) {
		if (PRIVATE_HOSTS.has(host)) return 'private host blocked';
		if (PRIVATE_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) return 'private host blocked';

		const v4 = parseIPv4(host);
		if (v4 && isPrivateIPv4(v4)) return 'private address blocked';
		if (host.includes(':') && isPrivateIPv6(host)) return 'private address blocked';
	}

	return '';
}

function parseIPv4(host) {
	const parts = host.split('.');
	if (parts.length !== 4) return null;
	const octets = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const value = Number(part);
		if (value > 255) return null;
		octets.push(value);
	}
	return octets;
}

function isPrivateIPv4([a, b]) {
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 192 && b === 0) return true;
	if (a === 198 && (b === 18 || b === 19)) return true;
	if (a >= 224) return true;
	return false;
}

function isPrivateIPv6(host) {
	const lower = host.toLowerCase();
	if (lower === '::1' || lower === '::') return true;
	if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
	if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
	if (lower.startsWith('::ffff:')) {
		const mapped = lower.slice(7);
		const v4 = parseIPv4(mapped);
		return !v4 || isPrivateIPv4(v4);
	}
	return false;
}

function normalizeHeaders(input) {
	const out = {};
	if (!input || typeof input !== 'object') return out;
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined || value === null) continue;
		out[String(key)] = Array.isArray(value) ? value.map(String) : String(value);
	}
	return out;
}

function sanitizeRequestHeaders(input) {
	const headers = new Headers();
	for (const [key, value] of Object.entries(input || {})) {
		const lower = String(key).toLowerCase();
		if (HOP_BY_HOP.has(lower)) continue;
		if (lower.startsWith('x-relay-') || lower.startsWith('x-fwd-') || lower.startsWith('x-upstream-')) continue;
		if (value === undefined || value === null) continue;
		try {
			headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
		} catch {
			/* illegal header name/value — skip */
		}
	}
	return headers;
}

function stripAuthHeaders(input) {
	const out = {};
	for (const [key, value] of Object.entries(input || {})) {
		const lower = String(key).toLowerCase();
		if (lower === 'authorization' || lower === 'cookie' || lower === 'proxy-authorization') continue;
		out[key] = value;
	}
	return out;
}

function headersToPlain(headers) {
	const out = {};
	for (const [key, value] of Object.entries(headers || {})) {
		out[key] = value;
	}
	return out;
}

function headersToObject(headers) {
	const out = {};
	headers.forEach((value, key) => {
		const lower = key.toLowerCase();
		if (out[lower] === undefined) out[lower] = value;
		else if (Array.isArray(out[lower])) out[lower].push(value);
		else out[lower] = [out[lower], value];
	});

	// Headers iteration merges duplicate set-cookie values; restore them.
	try {
		const cookies = headers.getAll('set-cookie');
		if (cookies && cookies.length > 1) out['set-cookie'] = cookies;
	} catch {
		/* getAll is not available everywhere */
	}

	return out;
}

function headerValue(headers, name) {
	if (!headers) return undefined;
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (String(key).toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
	}
	return undefined;
}

function isRedirect(status) {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function parseHead(text) {
	const lines = text.split('\r\n');
	const match = /^HTTP\/\d\.\d\s+(\d{3})/.exec(lines[0] || '');
	if (!match) return null;

	const headers = {};
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;
		const colon = line.indexOf(':');
		if (colon <= 0) continue;
		const key = line.slice(0, colon).trim().toLowerCase();
		const value = line.slice(colon + 1).trim();
		if (!key) continue;
		if (headers[key] === undefined) headers[key] = value;
		else if (Array.isArray(headers[key])) headers[key].push(value);
		else headers[key] = [headers[key], value];
	}

	return { status: Number(match[1]), headers };
}

async function readWithDeadline(reader, deadline, timeoutMs) {
	const remaining = Math.max(1, deadline - Date.now());
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new RelayError('read timeout', 'TIMEOUT')), Math.min(remaining, timeoutMs));
	});
	try {
		return await Promise.race([reader.read(), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

function looksLikeHttp(bytes) {
	return bytes[0] === 72 && bytes[1] === 84 && bytes[2] === 84 && bytes[3] === 80 && bytes[4] === 47; // "HTTP/"
}

function indexOfHeaderEnd(bytes) {
	for (let i = 0; i + 3 < bytes.byteLength; i++) {
		if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
	}
	return -1;
}

function indexOfCrlf(bytes, from) {
	for (let i = from; i + 1 < bytes.byteLength; i++) {
		if (bytes[i] === 13 && bytes[i + 1] === 10) return i;
	}
	return -1;
}

function concatBytes(left, right) {
	if (!left || !left.byteLength) return right || new Uint8Array(0);
	if (!right || !right.byteLength) return left;
	const out = new Uint8Array(left.byteLength + right.byteLength);
	out.set(left, 0);
	out.set(right, left.byteLength);
	return out;
}

function concatPieces(pieces) {
	if (!pieces.length) return new Uint8Array(0);
	if (pieces.length === 1) return pieces[0];
	let total = 0;
	for (const piece of pieces) total += piece.byteLength;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const piece of pieces) {
		out.set(piece, offset);
		offset += piece.byteLength;
	}
	return out;
}

function decodeLatin1(bytes) {
	let out = '';
	for (let i = 0; i < bytes.byteLength; i++) out += String.fromCharCode(bytes[i]);
	return out;
}

function base64ToBytes(value) {
	const binary = atob(value);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

function bytesToBase64(bytes) {
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.byteLength; i += chunk) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

function timingSafeEqual(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function intOr(value, fallback) {
	const parsed = parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolOr(value, fallback) {
	if (value === undefined || value === null || value === '') return fallback;
	return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function json(obj, status = 200) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' }
	});
}
