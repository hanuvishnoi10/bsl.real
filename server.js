require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const recordsManager = require('./records-manager');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;

// Ensure records data directory and files exist
recordsManager.ensureDataFiles();

// Initialize Razorpay SDK Helper
function getRazorpayInstance() {
    const key_id = (process.env.RAZORPAY_KEY_ID || '').trim();
    const key_secret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
    if (!key_id || !key_secret) return null;
    return new Razorpay({ key_id, key_secret });
}

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.lottie': 'application/json'
};

function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 1e6) {
                req.destroy();
                reject(new Error('Payload too large'));
            }
        });
        req.on('end', () => {
            if (!body.trim()) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch (err) {
                reject(new Error('Invalid JSON format'));
            }
        });
        req.on('error', reject);
    });
}

// ==========================================
// ADMIN AUTHENTICATION (SKYSHOT DASHBOARD)
// ==========================================
const ADMIN_USER = (process.env.ADMIN_USER || 'blazen').trim();
const ADMIN_PASS = (process.env.ADMIN_PASS || '2437').trim();

// In-memory active session store: token -> { user, expiresAt }
const activeSessions = new Map();

// Brute-force rate limiting: max 5 failed attempts within 15 mins per IP
const loginAttempts = new Map(); // ip -> { count, firstAttempt, lockedUntil }
const MAX_FAILED_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15 mins window
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 mins lockout

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.socket?.remoteAddress || '127.0.0.1';
}

function checkRateLimit(ip) {
    const now = Date.now();
    const record = loginAttempts.get(ip);
    if (!record) return { allowed: true };

    if (record.lockedUntil && record.lockedUntil > now) {
        const remainingSec = Math.ceil((record.lockedUntil - now) / 1000);
        return { allowed: false, remainingSec, locked: true };
    }

    if (now - record.firstAttempt > ATTEMPT_WINDOW_MS) {
        loginAttempts.delete(ip);
        return { allowed: true };
    }

    if (record.count >= MAX_FAILED_ATTEMPTS) {
        record.lockedUntil = now + LOCKOUT_DURATION_MS;
        const remainingSec = Math.ceil(LOCKOUT_DURATION_MS / 1000);
        return { allowed: false, remainingSec, locked: true };
    }

    return { allowed: true, remainingAttempts: MAX_FAILED_ATTEMPTS - record.count };
}

function recordFailedLogin(ip) {
    const now = Date.now();
    let record = loginAttempts.get(ip);
    if (!record || now - record.firstAttempt > ATTEMPT_WINDOW_MS) {
        record = { count: 1, firstAttempt: now, lockedUntil: null };
    } else {
        record.count += 1;
        if (record.count >= MAX_FAILED_ATTEMPTS) {
            record.lockedUntil = now + LOCKOUT_DURATION_MS;
        }
    }
    loginAttempts.set(ip, record);
    return record;
}

function resetFailedLogin(ip) {
    loginAttempts.delete(ip);
}

// Constant-time safe string comparison to prevent timing attacks
function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const hashA = crypto.createHash('sha256').update(a).digest();
    const hashB = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(hashA, hashB);
}

function createAdminSession(user) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days session
    activeSessions.set(token, { user, expiresAt });
    return { token, expiresAt };
}

function parseCookies(req) {
    const list = {};
    const rc = req.headers.cookie;
    if (rc) {
        rc.split(';').forEach(cookie => {
            const parts = cookie.split('=');
            if (parts.length >= 2) {
                list[parts.shift().trim()] = decodeURIComponent(parts.join('='));
            }
        });
    }
    return list;
}

function isUserAuthenticated(req) {
    // 1. Check Bearer or Basic Auth header
    const authHeader = req.headers['authorization'];
    if (authHeader) {
        if (authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7).trim();
            if (activeSessions.has(token)) {
                const sess = activeSessions.get(token);
                if (sess.expiresAt > Date.now()) return true;
                activeSessions.delete(token);
            }
        } else if (authHeader.startsWith('Basic ')) {
            const creds = Buffer.from(authHeader.substring(6).trim(), 'base64').toString('utf-8');
            const [u, p] = creds.split(':');
            if (safeCompare(u, ADMIN_USER) && safeCompare(p, ADMIN_PASS)) return true;
        }
    }

    const cookies = parseCookies(req);
    const cookieToken = cookies['skyshot_session'] || cookies['bsl_admin_session'];
    if (cookieToken && activeSessions.has(cookieToken)) {
        const sess = activeSessions.get(cookieToken);
        if (sess.expiresAt > Date.now()) return true;
        activeSessions.delete(cookieToken);
    }

    // 3. Check Query parameter token (e.g. for CSV export downloads)
    try {
        const parsedUrl = new URL(req.url, 'http://localhost');
        const queryToken = parsedUrl.searchParams.get('token');
        if (queryToken && activeSessions.has(queryToken)) {
            const sess = activeSessions.get(queryToken);
            if (sess.expiresAt > Date.now()) return true;
            activeSessions.delete(queryToken);
        }
    } catch (_) {}

    return false;
}

process.on('uncaughtException', (err) => {
    console.error('🛡️ Uncaught Exception prevented crash:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('🛡️ Unhandled Rejection prevented crash:', reason);
});

const server = http.createServer(async (req, res) => {
    try {
        // Enterprise Security Headers
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('X-XSS-Protection', '1; mode=block');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        let pathname = decodeURIComponent(urlObj.pathname);

    // ==========================================
    // HEALTH CHECK & RAZORPAY API ENDPOINTS
    // ==========================================

    // Health check endpoint
    if (req.method === 'GET' && (pathname === '/health' || pathname === '/api/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const key_id = (process.env.RAZORPAY_KEY_ID || '').trim();
        res.end(JSON.stringify({
            status: 'ok',
            timestamp: new Date().toISOString(),
            service: 'brazil-sensi-legends-root-server',
            razorpay_configured: Boolean(key_id && process.env.RAZORPAY_KEY_SECRET),
            razorpay_mode: key_id.startsWith('rzp_live') ? 'live' : (key_id.startsWith('rzp_test') ? 'test' : 'unconfigured')
        }));
        return;
    }

    // 1. GET /api/get-key
    if (req.method === 'GET' && pathname === '/api/get-key') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            key_id: (process.env.RAZORPAY_KEY_ID || '').trim()
        }));
        return;
    }

    // 2. POST /api/create-order
    if (req.method === 'POST' && pathname === '/api/create-order') {
        try {
            const body = await parseJsonBody(req);
            const notes = body.notes || {};
            const customerName = (body.name || notes.name || '').trim();
            const customerEmail = (body.email || notes.email || '').trim();
            const rawPhone = (body.phone || notes.phone || '').trim();
            const cleanPhone = rawPhone.replace(/[^0-9]/g, '');
            const customerPhone = cleanPhone;

            // Validate name
            if (!customerName || customerName.length < 2) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Customer name is required (minimum 2 characters).' }));
                return;
            }

            // Validate phone
            if (!cleanPhone || cleanPhone.length < 10) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'A valid 10-digit phone/WhatsApp number is required.' }));
                return;
            }

            // Server-side price calculation
            const planKey = (body.plan || notes.plan || 'legends').toLowerCase().trim();
            let amount = 39900; // default ₹399 VIP
            let planName = 'VIP PLAN';
            let canonicalPlan = 'legends';

            if (planKey === 'elite' || planKey === 'prime' || planKey === '699') {
                amount = 69900; // ₹699 Prime
                planName = 'PRIME PLAN';
                canonicalPlan = 'elite';
            } else if (planKey === 'legends' || planKey === 'vip' || planKey === '399') {
                amount = 39900;
                planName = 'VIP PLAN';
                canonicalPlan = 'legends';
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid plan selected.' }));
                return;
            }

            const currency = 'INR';
            const receipt = body.receipt || `rcpt_${Date.now()}`;

            const options = {
                amount: amount,
                currency: currency,
                receipt: receipt,
                notes: {
                    ...notes,
                    name: customerName,
                    email: customerEmail,
                    phone: customerPhone,
                    plan: planKey,
                    plan_name: planName
                }
            };

            const order = await razorpay.orders.create(options);

            // Record customer order in data/orders.json and data/orders.csv
            recordsManager.recordOrder({
                order_id: order.id,
                amount: Math.round(order.amount / 100),
                currency: order.currency,
                receipt: receipt,
                name: customerName,
                email: customerEmail,
                phone: customerPhone,
                plan: planKey,
                plan_name: planName,
                status: 'PENDING'
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                order_id: order.id,
                amount: order.amount,
                currency: order.currency,
                key_id: (process.env.RAZORPAY_KEY_ID || '').trim()
            }));
        } catch (err) {
            console.error('Error creating Razorpay order:', err);
            // Handle auth failures (return 401)
            if (err.statusCode === 401 || (err.error && err.error.code === 'BAD_REQUEST_ERROR' && err.error.description && err.error.description.toLowerCase().includes('auth'))) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Razorpay authentication failed'
                }));
                return;
            }
            // Handle Razorpay API errors (return 500)
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: err.error?.description || err.message || 'Failed to create order'
            }));
        }
        return;
    }

    // 3. POST /api/verify-payment
    if (req.method === 'POST' && pathname === '/api/verify-payment') {
        try {
            const body = await parseJsonBody(req);
            const orderId = body.razorpay_order_id || body.order_id;
            const paymentId = body.razorpay_payment_id || body.payment_id;
            const signature = body.razorpay_signature || body.signature;

            // Missing fields validation
            if (!orderId || !paymentId || !signature) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: 'Missing required payment verification fields'
                }));
                return;
            }

            const secret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
            if (!secret) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: 'Razorpay secret key not configured on server'
                }));
                return;
            }

            // Algorithm: HMAC-SHA256(order_id + "|" + payment_id, KEY_SECRET)
            const generatedSignature = crypto
                .createHmac('sha256', secret)
                .update(`${orderId}|${paymentId}`)
                .digest('hex');

            // Timing-safe comparison of HMAC signature
            const genBuf = Buffer.from(generatedSignature, 'utf-8');
            const sigBuf = Buffer.from(signature, 'utf-8');
            const isMatch = (genBuf.length === sigBuf.length) && crypto.timingSafeEqual(genBuf, sigBuf);

            if (isMatch) {
                // Update customer order record to SUCCESS
                recordsManager.updateOrderStatus(orderId, {
                    status: 'SUCCESS',
                    payment_id: paymentId,
                    failure_reason: null
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    message: 'Payment verified successfully',
                    order_id: orderId,
                    payment_id: paymentId
                }));
            } else {
                // Signature mismatch: return 400, record failure
                recordsManager.updateOrderStatus(orderId, {
                    status: 'FAILED',
                    payment_id: paymentId,
                    failure_reason: 'Payment verification failed: Signature mismatch'
                });

                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: 'Payment verification failed: Signature mismatch'
                }));
            }
        } catch (err) {
            console.error('Error verifying payment:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: err.message || 'Server error verifying payment'
            }));
        }
        return;
    }

    // 4. POST /api/record-failure
    if (req.method === 'POST' && pathname === '/api/record-failure') {
        try {
            const body = await parseJsonBody(req);
            const orderId = body.order_id || body.razorpay_order_id;
            const updated = recordsManager.recordPaymentFailure({
                order_id: orderId,
                payment_id: body.payment_id || body.razorpay_payment_id || null,
                name: body.name || '',
                email: body.email || '',
                phone: body.phone || '',
                plan: body.plan || '',
                plan_name: body.plan_name || '',
                amount: body.amount || 0,
                error_description: body.error_description || body.message || 'Payment failed or cancelled',
                error_reason: body.error_reason || body.reason || 'payment_failed'
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, record: updated }));
        } catch (err) {
            console.error('Error recording payment failure:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return;
    }

    // 5. POST /api/admin/login (Rate-limited, timing-safe)
    if (req.method === 'POST' && pathname === '/api/admin/login') {
        const clientIp = getClientIp(req);
        const rateCheck = checkRateLimit(clientIp);

        if (!rateCheck.allowed) {
            res.writeHead(429, {
                'Content-Type': 'application/json',
                'Retry-After': String(rateCheck.remainingSec),
                'Cache-Control': 'no-store'
            });
            res.end(JSON.stringify({
                success: false,
                error: `Security lockout active: Too many failed login attempts. Please wait ${Math.ceil(rateCheck.remainingSec / 60)} minute(s).`,
                retryAfter: rateCheck.remainingSec,
                locked: true
            }));
            return;
        }

        try {
            const body = await parseJsonBody(req);
            const username = (body.username || '').trim();
            const password = (body.password || '').trim();

            const isUserMatch = safeCompare(username, ADMIN_USER);
            const isPassMatch = safeCompare(password, ADMIN_PASS);

            if (isUserMatch && isPassMatch) {
                resetFailedLogin(clientIp);
                const session = createAdminSession(username);
                const isHttps = req.headers['x-forwarded-proto'] === 'https';
                const cookieFlags = isHttps
                    ? 'SameSite=None; Secure; HttpOnly; Path=/; Max-Age=604800'
                    : 'SameSite=Lax; HttpOnly; Path=/; Max-Age=604800';
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Set-Cookie': `skyshot_session=${session.token}; ${cookieFlags}`,
                    'Cache-Control': 'no-store'
                });
                res.end(JSON.stringify({
                    success: true,
                    username: ADMIN_USER,
                    token: session.token,
                    message: 'Authentication successful'
                }));
            } else {
                const record = recordFailedLogin(clientIp);
                const attemptsLeft = Math.max(0, MAX_FAILED_ATTEMPTS - record.count);

                if (record.count >= MAX_FAILED_ATTEMPTS) {
                    res.writeHead(429, {
                        'Content-Type': 'application/json',
                        'Retry-After': String(Math.ceil(LOCKOUT_DURATION_MS / 1000)),
                        'Cache-Control': 'no-store'
                    });
                    res.end(JSON.stringify({
                        success: false,
                        error: 'Security lockout: Maximum failed attempts exceeded. Access locked for 15 minutes.',
                        locked: true,
                        retryAfter: Math.ceil(LOCKOUT_DURATION_MS / 1000)
                    }));
                } else {
                    res.writeHead(401, {
                        'Content-Type': 'application/json',
                        'Cache-Control': 'no-store'
                    });
                    res.end(JSON.stringify({
                        success: false,
                        error: `Invalid credentials. ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} remaining before security lockout.`,
                        attemptsLeft: attemptsLeft
                    }));
                }
            }
        } catch (err) {
            console.error('Error during admin login:', err);
            res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ success: false, error: 'Server authentication error' }));
        }
        return;
    }

    // 6. POST /api/admin/logout
    if (req.method === 'POST' && pathname === '/api/admin/logout') {
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7).trim();
            activeSessions.delete(token);
        }
        const cookies = parseCookies(req);
        const token = cookies['skyshot_session'] || cookies['bsl_admin_session'];
        if (token) activeSessions.delete(token);

        const isHttps = req.headers['x-forwarded-proto'] === 'https';
        const cookieFlags = isHttps
            ? 'SameSite=None; Secure; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
            : 'SameSite=Lax; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': `skyshot_session=; ${cookieFlags}`
        });
        res.end(JSON.stringify({ success: true, message: 'Logged out successfully' }));
        return;
    }

    // 7. GET /api/admin/check-session
    if (req.method === 'GET' && pathname === '/api/admin/check-session') {
        const authenticated = isUserAuthenticated(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            authenticated: authenticated,
            username: authenticated ? ADMIN_USER : null
        }));
        return;
    }

    // 8. GET /api/records (Protected: Admin authentication required)
    if (req.method === 'GET' && pathname === '/api/records') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        if (!isUserAuthenticated(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'Unauthorized: Admin authentication required'
            }));
            return;
        }

        const orders = recordsManager.getAllOrders();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            count: orders.length,
            orders: orders
        }));
        return;
    }

    // 9. GET /api/export-csv (Protected: Admin authentication required)
    if (req.method === 'GET' && pathname === '/api/export-csv') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        if (!isUserAuthenticated(req)) {
            res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Unauthorized: Admin authentication required');
            return;
        }

        if (fs.existsSync(recordsManager.CSV_FILE)) {
            res.writeHead(200, {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': 'attachment; filename="bsl_customer_records.csv"'
            });
            fs.createReadStream(recordsManager.CSV_FILE).pipe(res);
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('CSV file not found');
        }
        return;
    }

    // ==========================================
    // STATIC FILE & ROUTE ALIASES
    // ==========================================
    // Legacy /records and /admin redirect to /skyshot
    if (pathname === '/records' || pathname === '/records/' || pathname === '/admin' || pathname === '/admin/' || pathname === '/customers' || pathname === '/records.html') {
        res.writeHead(302, { 'Location': '/skyshot' });
        res.end();
        return;
    }

    if (pathname === '/' || pathname === '/india/home' || pathname === '/india/home/') {
        pathname = '/index.html';
    } else if (pathname === '/skyshot' || pathname === '/skyshot/' || pathname === '/skyshot.html') {
        pathname = '/skyshot.html';
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
    } else if (pathname === '/payment-699' || pathname === '/checkout-699' || pathname === '/prime' || pathname === '/699' || pathname === '/india/prime') {
        pathname = '/payment-699.html';
    } else if (pathname === '/payment' || pathname === '/checkout' || pathname === '/india/checkout' || pathname === '/legends' || pathname === '/vip') {
        pathname = '/payment.html';
    } else if (pathname === '/tou' || pathname === '/terms-of-use' || pathname === '/terms') {
        pathname = '/terms-of-use.html';
    } else if (pathname === '/pp' || pathname === '/privacy-policy' || pathname === '/privacy') {
        pathname = '/privacy-policy.html';
    }

    let filePath = path.join(PUBLIC_DIR, pathname);

    if (!fs.existsSync(filePath) && fs.existsSync(filePath + '.html')) {
        filePath = filePath + '.html';
    }

        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const contentType = MIME_TYPES[ext] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': contentType });
            fs.createReadStream(filePath).pipe(res);
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: `404 Not Found: ${pathname}` }));
        }
    } catch (criticalErr) {
        console.error('🛡️ Unhandled server error on route:', req.url, criticalErr);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: 'Internal server error' }));
        } else {
            res.end();
        }
    }
});

server.on('error', (err) => {
    console.error('🚨 HTTP Server Error:', err);
});

server.on('clientError', (err, socket) => {
    console.warn('🛡️ Client Socket Error:', err.message);
    if (socket && !socket.destroyed) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
});

process.on('exit', (code) => {
    console.log(`🚨 Server process exiting with code: ${code}`);
});

process.on('SIGINT', () => {
    console.log('🚨 Server received SIGINT');
});

process.on('SIGTERM', () => {
    console.log('🚨 Server received SIGTERM');
});

server.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 Brazil Sensi Legends Server running with Razorpay!`);
    console.log(`======================================================`);
    console.log(`👉 Homepage:             http://localhost:${PORT}/`);
    console.log(`👉 Payment Page (VIP):   http://localhost:${PORT}/payment.html?plan=legends`);
    console.log(`👉 Payment Page (Prime): http://localhost:${PORT}/payment.html?plan=elite`);
    console.log(`👉 Skyshot Records:      http://localhost:${PORT}/skyshot`);
    console.log(`🔒 Skyshot Security:     Protected (Rate Limiting & Lockout Active 🛡️)`);
    const keyId = (process.env.RAZORPAY_KEY_ID || '').trim();
    const mode = keyId.startsWith('rzp_live') ? 'LIVE 🟢' : (keyId.startsWith('rzp_test') ? 'TEST 🟡' : 'UNKNOWN');
    console.log(`💳 Razorpay Key ID:      ${keyId ? 'Loaded (' + keyId.substring(0, 12) + '...) [' + mode + ']' : 'MISSING'}`);
    console.log(`📁 Records Storage:     ./data/orders.json & ./data/orders.csv`);
    console.log(`======================================================\n`);
});
