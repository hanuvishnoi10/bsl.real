require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const recordsManager = require('./records-manager');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 5000;

// Initialize order records data store
recordsManager.ensureDataFiles();

// ==========================================
// CANONICAL SERVER-SIDE PRICING & PRODUCTS
// ==========================================
// NEVER trust prices submitted by client browser.
// Amount is defined strictly here in paise (1 INR = 100 paise).
const PRODUCTS = {
    legends: {
        id: 'legends',
        name: 'VIP PLAN',
        pricePaise: 39900, // ₹399.00
        currency: 'INR'
    },
    elite: {
        id: 'elite',
        name: 'PRIME PLAN',
        pricePaise: 69900, // ₹699.00
        currency: 'INR'
    }
};

const PLAN_ALIASES = {
    'vip': 'legends',
    '399': 'legends',
    'legends': 'legends',
    'prime': 'elite',
    '699': 'elite',
    'elite': 'elite'
};

function resolveProductPlan(rawPlan) {
    if (!rawPlan) return PRODUCTS.legends; // Default plan is VIP (₹399)
    const key = String(rawPlan).toLowerCase().trim();
    const resolvedKey = PLAN_ALIASES[key] || key;
    return PRODUCTS[resolvedKey] || null;
}

// ==========================================
// RAZORPAY SDK INITIALIZATION
// ==========================================
function getRazorpayConfig() {
    const key_id = (process.env.RAZORPAY_KEY_ID || '').trim();
    const key_secret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
    return {
        key_id,
        key_secret,
        isConfigured: Boolean(key_id && key_secret),
        mode: key_id.startsWith('rzp_live') ? 'live' : (key_id.startsWith('rzp_test') ? 'test' : 'unconfigured')
    };
}

function getRazorpayInstance() {
    const { key_id, key_secret, isConfigured } = getRazorpayConfig();
    if (!isConfigured) return null;
    return new Razorpay({ key_id, key_secret });
}

// ==========================================
// CORS & SECURITY MIDDLEWARE
// ==========================================
const configuredCorsOrigin = (process.env.CORS_ORIGIN || '*').trim();
const corsOrigins = configuredCorsOrigin === '*'
    ? '*'
    : configuredCorsOrigin.split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (e.g. mobile apps, curl, server-to-server)
        if (!origin) return callback(null, true);
        if (corsOrigins === '*' || (Array.isArray(corsOrigins) && corsOrigins.includes('*'))) {
            return callback(null, true);
        }
        if (Array.isArray(corsOrigins) && corsOrigins.includes(origin)) {
            return callback(null, true);
        }
        // Always allow localhost during non-production
        if (process.env.NODE_ENV !== 'production' && (origin.includes('localhost') || origin.includes('127.0.0.1'))) {
            return callback(null, true);
        }
        return callback(null, true); // Allow gracefully or restrict if strictly desired
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Enterprise Security Headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// ==========================================
// ADMIN AUTHENTICATION STORE (SKYSHOT DASHBOARD)
// ==========================================
const ADMIN_USER = (process.env.ADMIN_USER || 'blazen').trim();
const ADMIN_PASS = (process.env.ADMIN_PASS || '2437').trim();

const activeSessions = new Map(); // token -> { user, expiresAt }
const loginAttempts = new Map();  // ip -> { count, firstAttempt, lockedUntil }
const MAX_FAILED_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

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

function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const hashA = crypto.createHash('sha256').update(a).digest();
    const hashB = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(hashA, hashB);
}

function createAdminSession(user) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
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

    const queryToken = req.query?.token;
    if (queryToken && activeSessions.has(queryToken)) {
        const sess = activeSessions.get(queryToken);
        if (sess.expiresAt > Date.now()) return true;
        activeSessions.delete(queryToken);
    }

    return false;
}

// ==========================================
// HEALTH CHECK ENDPOINTS
// ==========================================
function getHealthStatus() {
    const { key_id, isConfigured, mode } = getRazorpayConfig();
    return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'brazil-sensi-legends-payment-backend',
        environment: process.env.NODE_ENV || 'development',
        razorpay: {
            configured: isConfigured,
            mode: mode,
            key_id_preview: key_id ? (key_id.substring(0, 10) + '...') : null
        },
        products: {
            legends: { name: PRODUCTS.legends.name, price: '₹399' },
            elite: { name: PRODUCTS.elite.name, price: '₹699' }
        }
    };
}

app.get('/', (req, res) => {
    res.status(200).json(getHealthStatus());
});

app.get('/health', (req, res) => {
    res.status(200).json(getHealthStatus());
});

app.get('/api/health', (req, res) => {
    res.status(200).json(getHealthStatus());
});

// ==========================================
// GET PUBLIC KEY
// ==========================================
// Never exposes the Razorpay secret key!
app.get('/api/get-key', (req, res) => {
    const key_id = (process.env.RAZORPAY_KEY_ID || '').trim();
    res.status(200).json({ key_id });
});

// ==========================================
// CREATE ORDER ENDPOINT: POST /api/create-order
// ==========================================
app.post('/api/create-order', async (req, res) => {
    try {
        const body = req.body || {};
        const customerName = (body.name || body.customer_name || body.notes?.name || '').trim();
        const rawPhone = (body.phone || body.contact || body.notes?.phone || '').trim();
        const customerEmail = (body.email || body.notes?.email || '').trim();
        const requestedPlan = body.plan || body.notes?.plan || 'legends';

        // 1. Validate customer name
        if (!customerName || customerName.length < 2) {
            return res.status(400).json({
                error: 'Customer name is required (minimum 2 characters).'
            });
        }

        // 2. Validate customer phone (at least 10 digits)
        const cleanPhone = rawPhone.replace(/[^0-9]/g, '');
        if (!cleanPhone || cleanPhone.length < 10) {
            return res.status(400).json({
                error: 'A valid 10-digit phone/WhatsApp number is required.'
            });
        }

        // 3. Determine payable amount on server from product catalog
        const product = resolveProductPlan(requestedPlan);
        if (!product) {
            return res.status(400).json({
                error: `Invalid plan specified. Allowed plans are 'legends' (VIP ₹399) or 'elite' (Prime ₹699).`
            });
        }

        // 4. Verify Razorpay credentials
        const razorpay = getRazorpayInstance();
        if (!razorpay) {
            console.error('[Create Order Error]: RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET missing on server.');
            return res.status(500).json({
                error: 'Payment gateway credentials are not configured on the server. Please check environment variables.'
            });
        }

        // 5. Generate secure receipt ID
        const receipt = body.receipt || `rcpt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

        // 6. Build genuine Razorpay order options with server-governed price
        const options = {
            amount: product.pricePaise, // strictly enforced from server PRODUCTS catalog!
            currency: product.currency,
            receipt: receipt,
            notes: {
                name: customerName,
                phone: cleanPhone,
                email: customerEmail,
                plan: product.id,
                plan_name: product.name
            }
        };

        const order = await razorpay.orders.create(options);

        // 7. Save pending order in server database
        recordsManager.recordOrder({
            order_id: order.id,
            amount: Math.round(order.amount / 100),
            currency: order.currency,
            receipt: receipt,
            name: customerName,
            email: customerEmail,
            phone: cleanPhone,
            plan: product.id,
            plan_name: product.name,
            status: 'PENDING'
        });

        console.log(`[Order Created]: id=${order.id} | plan=${product.name} | amount=₹${Math.round(order.amount / 100)} | customer=${customerName}`);

        // 8. Return JSON with order_id, amount, currency, and public key_id
        return res.status(200).json({
            order_id: order.id,
            amount: order.amount,
            currency: order.currency,
            key_id: (process.env.RAZORPAY_KEY_ID || '').trim()
        });

    } catch (err) {
        // Log safe server error without exposing secrets
        console.error('[Create Order Exception]:', {
            statusCode: err.statusCode,
            message: err.message,
            description: err.error?.description,
            code: err.error?.code
        });

        if (err.statusCode === 401 || (err.error && err.error.code === 'BAD_REQUEST_ERROR' && err.error.description?.toLowerCase().includes('auth'))) {
            return res.status(401).json({
                error: 'Payment gateway authentication failed. Please check server Razorpay credentials.'
            });
        }

        const clientError = err.error?.description || err.message || 'Failed to create payment order.';
        return res.status(err.statusCode || 500).json({
            error: clientError
        });
    }
});

// ==========================================
// VERIFY PAYMENT ENDPOINT: POST /api/verify-payment
// ==========================================
// Implements server-side cryptographic HMAC-SHA256 signature verification.
// Never trusts client-side callbacks without server verification!
app.post('/api/verify-payment', (req, res) => {
    try {
        const body = req.body || {};
        const orderId = (body.razorpay_order_id || body.order_id || '').trim();
        const paymentId = (body.razorpay_payment_id || body.payment_id || '').trim();
        const signature = (body.razorpay_signature || body.signature || '').trim();

        if (!orderId || !paymentId || !signature) {
            return res.status(400).json({
                success: false,
                error: 'Missing required parameters: razorpay_order_id, razorpay_payment_id, and razorpay_signature are required.'
            });
        }

        const secret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
        if (!secret) {
            console.error('[Verify Payment Error]: RAZORPAY_KEY_SECRET missing on server.');
            return res.status(500).json({
                success: false,
                error: 'Payment gateway secret key is not configured on the server.'
            });
        }

        // HMAC-SHA256(order_id + "|" + payment_id, secret)
        const generatedSignature = crypto
            .createHmac('sha256', secret)
            .update(`${orderId}|${paymentId}`)
            .digest('hex');

        const genBuf = Buffer.from(generatedSignature, 'utf-8');
        const sigBuf = Buffer.from(signature, 'utf-8');

        // Timing-safe signature comparison
        const isSignatureValid = (genBuf.length === sigBuf.length) && crypto.timingSafeEqual(genBuf, sigBuf);

        if (isSignatureValid) {
            recordsManager.updateOrderStatus(orderId, {
                status: 'SUCCESS',
                payment_id: paymentId,
                failure_reason: null
            });

            console.log(`[Payment Verified SUCCESS]: order=${orderId} | payment=${paymentId}`);

            return res.status(200).json({
                success: true,
                message: 'Payment verified successfully',
                order_id: orderId,
                payment_id: paymentId
            });
        } else {
            recordsManager.updateOrderStatus(orderId, {
                status: 'FAILED',
                payment_id: paymentId,
                failure_reason: 'Payment signature verification mismatch'
            });

            console.warn(`[Payment Verified FAILED]: Signature mismatch for order=${orderId} | payment=${paymentId}`);

            return res.status(400).json({
                success: false,
                error: 'Payment verification failed: Signature mismatch'
            });
        }
    } catch (err) {
        console.error('[Verify Payment Exception]:', err.message);
        return res.status(500).json({
            success: false,
            error: 'Internal server error while verifying payment signature.'
        });
    }
});

// ==========================================
// RECORD PAYMENT FAILURE: POST /api/record-failure
// ==========================================
app.post('/api/record-failure', (req, res) => {
    try {
        const body = req.body || {};
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

        console.log(`[Payment Failure Recorded]: order=${orderId || 'none'} | reason=${body.error_description || body.error_reason || 'unknown'}`);

        return res.status(200).json({ success: true, record: updated });
    } catch (err) {
        console.error('[Record Failure Error]:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// ADMIN DASHBOARD ENDPOINTS (SKYSHOT)
// ==========================================
app.post('/api/admin/login', (req, res) => {
    const clientIp = getClientIp(req);
    const rateCheck = checkRateLimit(clientIp);

    if (!rateCheck.allowed) {
        res.setHeader('Retry-After', String(rateCheck.remainingSec));
        res.setHeader('Cache-Control', 'no-store');
        return res.status(429).json({
            success: false,
            error: `Security lockout active: Too many failed login attempts. Please wait ${Math.ceil(rateCheck.remainingSec / 60)} minute(s).`,
            retryAfter: rateCheck.remainingSec,
            locked: true
        });
    }

    try {
        const body = req.body || {};
        const username = (body.username || '').trim();
        const password = (body.password || '').trim();

        const isUserMatch = safeCompare(username, ADMIN_USER);
        const isPassMatch = safeCompare(password, ADMIN_PASS);

        if (isUserMatch && isPassMatch) {
            loginAttempts.delete(clientIp);
            const session = createAdminSession(username);
            const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
            const cookieFlags = isHttps
                ? 'SameSite=None; Secure; HttpOnly; Path=/; Max-Age=604800'
                : 'SameSite=Lax; HttpOnly; Path=/; Max-Age=604800';
            res.setHeader('Set-Cookie', `skyshot_session=${session.token}; ${cookieFlags}`);
            res.setHeader('Cache-Control', 'no-store');
            return res.status(200).json({
                success: true,
                username: ADMIN_USER,
                token: session.token,
                message: 'Authentication successful'
            });
        } else {
            const record = recordFailedLogin(clientIp);
            const attemptsLeft = Math.max(0, MAX_FAILED_ATTEMPTS - record.count);

            if (record.count >= MAX_FAILED_ATTEMPTS) {
                res.setHeader('Retry-After', String(Math.ceil(LOCKOUT_DURATION_MS / 1000)));
                res.setHeader('Cache-Control', 'no-store');
                return res.status(429).json({
                    success: false,
                    error: 'Security lockout: Maximum failed attempts exceeded. Access locked for 15 minutes.',
                    locked: true,
                    retryAfter: Math.ceil(LOCKOUT_DURATION_MS / 1000)
                });
            } else {
                res.setHeader('Cache-Control', 'no-store');
                return res.status(401).json({
                    success: false,
                    error: `Invalid credentials. ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} remaining before security lockout.`,
                    attemptsLeft: attemptsLeft
                });
            }
        }
    } catch (err) {
        console.error('[Admin Login Error]:', err.message);
        return res.status(500).json({ success: false, error: 'Server authentication error' });
    }
});

app.post('/api/admin/logout', (req, res) => {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7).trim();
        activeSessions.delete(token);
    }
    const cookies = parseCookies(req);
    const cookieToken = cookies['skyshot_session'] || cookies['bsl_admin_session'];
    if (cookieToken) activeSessions.delete(cookieToken);

    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const cookieFlags = isHttps
        ? 'SameSite=None; Secure; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
        : 'SameSite=Lax; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
    res.setHeader('Set-Cookie', `skyshot_session=; ${cookieFlags}`);
    return res.status(200).json({ success: true, message: 'Logged out successfully' });
});

app.get('/api/admin/check-session', (req, res) => {
    const authenticated = isUserAuthenticated(req);
    return res.status(200).json({
        authenticated: authenticated,
        username: authenticated ? ADMIN_USER : null
    });
});

app.get('/api/records', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    if (!isUserAuthenticated(req)) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized: Admin authentication required'
        });
    }

    try {
        const forceSync = req.query.sync === '1' || req.query.force === '1';
        const orders = await recordsManager.getOrSyncAllOrders(forceSync);
        return res.status(200).json({
            success: true,
            count: orders.length,
            lastSync: recordsManager.getLastSyncTime(),
            orders: orders
        });
    } catch (err) {
        console.error('[Get Records Error]:', err.message);
        const orders = recordsManager.getAllOrders();
        return res.status(200).json({
            success: true,
            count: orders.length,
            orders: orders
        });
    }
});

app.post('/api/admin/sync-razorpay', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    if (!isUserAuthenticated(req)) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized: Admin authentication required'
        });
    }

    try {
        const razorpay = getRazorpayInstance();
        const orders = await recordsManager.syncWithRazorpay(razorpay);
        return res.status(200).json({
            success: true,
            count: orders.length,
            lastSync: recordsManager.getLastSyncTime(),
            orders: orders,
            message: `Successfully synchronized ${orders.length} orders with Razorpay Cloud.`
        });
    } catch (err) {
        console.error('[Admin Sync Error]:', err);
        return res.status(500).json({
            success: false,
            error: err.message || 'Failed to sync with Razorpay Cloud'
        });
    }
});

app.get('/api/export-csv', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    if (!isUserAuthenticated(req)) {
        return res.status(401).send('Unauthorized: Admin authentication required');
    }

    const fs = require('fs');
    if (fs.existsSync(recordsManager.CSV_FILE)) {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="bsl_customer_records.csv"');
        return fs.createReadStream(recordsManager.CSV_FILE).pipe(res);
    } else {
        return res.status(404).send('CSV file not found');
    }
});

// ==========================================
// 404 & ERROR HANDLING
// ==========================================
app.use((req, res) => {
    res.status(404).json({
        error: `404 Not Found: Cannot ${req.method} ${req.url}`
    });
});

app.use((err, req, res, next) => {
    console.error('[Unhandled Server Error]:', err);
    if (!res.headersSent) {
        res.status(500).json({
            error: 'Internal server error occurred.'
        });
    }
});

// Start listening
if (require.main === module) {
    app.listen(PORT, () => {
        const { isConfigured, mode, key_id } = getRazorpayConfig();
        console.log(`\n======================================================`);
        console.log(`🚀 Brazil Sensi Legends Express Backend Running!`);
        console.log(`======================================================`);
        console.log(`👉 Port:                 ${PORT}`);
        console.log(`👉 Environment:          ${process.env.NODE_ENV || 'development'}`);
        console.log(`👉 Health Check:         http://localhost:${PORT}/health`);
        console.log(`👉 Create Order API:     http://localhost:${PORT}/api/create-order`);
        console.log(`👉 Verify Payment API:   http://localhost:${PORT}/api/verify-payment`);
        console.log(`👉 Razorpay Status:      ${isConfigured ? 'LOADED (' + key_id.substring(0, 10) + '...) [' + mode.toUpperCase() + ']' : 'NOT CONFIGURED ⚠️'}`);
        console.log(`👉 CORS Allowed Origin:  ${configuredCorsOrigin}`);
        console.log(`======================================================\n`);

        // Trigger automatic non-blocking cloud reconciliation on startup
        recordsManager.syncWithRazorpay(getRazorpayInstance()).then(orders => {
            console.log(`[Startup Cloud Sync]: Reconciled & preserved ${orders.length} lifetime customer records.`);
        }).catch(err => {
            console.warn('[Startup Cloud Sync Warning]:', err.message);
        });
    });
}

module.exports = app;
