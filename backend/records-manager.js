const fs = require('fs');
const path = require('path');
const Razorpay = require('razorpay');

// Determine data directory (configurable via env, defaults to ./data inside current directory)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const JSON_FILE = path.join(DATA_DIR, 'orders.json');
const CSV_FILE = path.join(DATA_DIR, 'orders.csv');

let lastSyncTimestamp = 0;
const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes cache before auto-refresh
let syncPromise = null; // Prevent overlapping sync executions

// Ensure data directory and files exist
function ensureDataFiles() {
    if (!fs.existsSync(DATA_DIR)) {
        try {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        } catch (e) {
            console.error('[Records Manager]: Failed to create data directory:', e.message);
        }
    }

    if (!fs.existsSync(JSON_FILE)) {
        try {
            fs.writeFileSync(JSON_FILE, JSON.stringify([], null, 2), 'utf-8');
        } catch (e) {
            console.error('[Records Manager]: Failed to initialize orders.json:', e.message);
        }
    }

    if (!fs.existsSync(CSV_FILE)) {
        try {
            const headers = 'Date,Status,Order ID,Payment ID,Customer Name,Email,Phone,Plan,Amount (INR),Failure Reason\n';
            fs.writeFileSync(CSV_FILE, headers, 'utf-8');
        } catch (e) {
            console.error('[Records Manager]: Failed to initialize orders.csv:', e.message);
        }
    }
}

// Read all orders synchronously from JSON
function getAllOrders() {
    ensureDataFiles();
    try {
        if (!fs.existsSync(JSON_FILE)) return [];
        const data = fs.readFileSync(JSON_FILE, 'utf-8');
        return JSON.parse(data || '[]');
    } catch (err) {
        console.error('[Records Manager]: Error reading orders.json:', err.message);
        return [];
    }
}

// Helper: Escape CSV fields
function escapeCsv(val) {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
}

// Rewrite CSV file from orders array
function syncCsv(orders) {
    try {
        const header = 'Date,Status,Order ID,Payment ID,Customer Name,Email,Phone,Plan,Amount (INR),Failure Reason\n';
        const rows = orders.map(o => {
            const date = o.created_at ? new Date(o.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '';
            return [
                escapeCsv(date),
                escapeCsv(o.status || 'UNKNOWN'),
                escapeCsv(o.order_id || ''),
                escapeCsv(o.payment_id || ''),
                escapeCsv(o.customer?.name || ''),
                escapeCsv(o.customer?.email || ''),
                escapeCsv(o.customer?.phone || ''),
                escapeCsv(o.plan_name || o.plan || ''),
                escapeCsv(o.amount || 0),
                escapeCsv(o.failure_reason || '')
            ].join(',');
        });
        fs.writeFileSync(CSV_FILE, header + rows.join('\n') + '\n', 'utf-8');
    } catch (err) {
        console.error('[Records Manager]: Error syncing orders.csv:', err.message);
    }
}

// Write orders array to JSON and sync CSV
function saveAllOrders(orders) {
    ensureDataFiles();
    try {
        fs.writeFileSync(JSON_FILE, JSON.stringify(orders, null, 2), 'utf-8');
        syncCsv(orders);
        return true;
    } catch (err) {
        console.error('[Records Manager]: Error saving orders:', err.message);
        return false;
    }
}

function getLastSyncTime() {
    return lastSyncTimestamp ? new Date(lastSyncTimestamp).toISOString() : null;
}

/**
 * Reconciles local disk storage with Razorpay Cloud API.
 * Ensures orders are never lost across container sleeps, reboots, or crashes.
 */
async function syncWithRazorpay(customRzp = null) {
    if (syncPromise) return syncPromise;

    syncPromise = (async () => {
        try {
            const key_id = (process.env.RAZORPAY_KEY_ID || 'rzp_live_TmrLRMLEAGkdl2').trim();
            const key_secret = (process.env.RAZORPAY_KEY_SECRET || 'UDokBuQ7ch3PsfVdvADt90Py').trim();

            if (!customRzp && (!key_id || !key_secret)) {
                console.warn('[Records Sync]: Razorpay credentials not configured, skipping cloud sync.');
                return getAllOrders();
            }

            const rzp = customRzp || new Razorpay({ key_id, key_secret });

            console.log('[Records Sync]: Fetching live records from Razorpay Cloud API...');

            // 1. Fetch Razorpay orders (paginated)
            let rzpOrders = [];
            let skip = 0;
            while (true) {
                const batch = await rzp.orders.all({ count: 100, skip });
                rzpOrders = rzpOrders.concat(batch.items || []);
                if (!batch.items || batch.items.length < 100) break;
                skip += 100;
            }

            // 2. Fetch Razorpay payments (paginated)
            let rzpPayments = [];
            skip = 0;
            while (true) {
                const batch = await rzp.payments.all({ count: 100, skip });
                rzpPayments = rzpPayments.concat(batch.items || []);
                if (!batch.items || batch.items.length < 100) break;
                skip += 100;
            }

            // Index payments by order_id
            const paymentByOrderId = new Map();
            rzpPayments.forEach(p => {
                if (p.order_id) {
                    paymentByOrderId.set(p.order_id, p);
                }
            });

            // 3. Map existing local orders
            const localOrders = getAllOrders();
            const orderMap = new Map();
            localOrders.forEach(o => {
                if (o.order_id) orderMap.set(o.order_id, o);
            });

            // 4. Merge Razorpay orders
            rzpOrders.forEach(ro => {
                const linkedPayment = paymentByOrderId.get(ro.id);
                const existing = orderMap.get(ro.id);

                let status = 'PENDING';
                let failureReason = null;
                let paymentId = linkedPayment ? linkedPayment.id : (existing?.payment_id || null);

                if (ro.status === 'paid' || (linkedPayment && linkedPayment.status === 'captured')) {
                    status = 'SUCCESS';
                } else if (linkedPayment && linkedPayment.status === 'failed') {
                    status = 'FAILED';
                    failureReason = linkedPayment.error_description || linkedPayment.error_reason || 'Payment failed';
                } else if (ro.status === 'attempted') {
                    status = 'FAILED';
                    failureReason = 'Payment attempted but checkout was not completed';
                } else if (existing && existing.status) {
                    status = existing.status;
                    failureReason = existing.failure_reason;
                }

                const customerName = ro.notes?.name || linkedPayment?.notes?.name || existing?.customer?.name || '';
                let customerPhone = ro.notes?.phone || linkedPayment?.contact || existing?.customer?.phone || '';
                if (customerPhone.startsWith('+91')) customerPhone = customerPhone.substring(3);
                else if (customerPhone.startsWith('91') && customerPhone.length === 12) customerPhone = customerPhone.substring(2);

                let customerEmail = ro.notes?.email || linkedPayment?.email || existing?.customer?.email || '';
                if (customerEmail && customerEmail.includes('void@razorpay.com')) customerEmail = existing?.customer?.email || '';

                const plan = ro.notes?.plan || existing?.plan || 'legends';
                const planName = ro.notes?.plan_name || existing?.plan_name || (plan === 'elite' ? 'PRIME PLAN' : 'VIP PLAN');
                const amount = ro.amount ? Math.round(ro.amount / 100) : (existing?.amount || 399);
                const createdAt = ro.created_at ? new Date(ro.created_at * 1000).toISOString() : (existing?.created_at || new Date().toISOString());

                const merged = {
                    id: existing?.id || (`rec_${ro.created_at ? ro.created_at * 1000 : Date.now()}_${Math.random().toString(36).substring(2, 7)}`),
                    order_id: ro.id,
                    payment_id: paymentId,
                    status: status,
                    customer: {
                        name: customerName,
                        email: customerEmail,
                        phone: customerPhone
                    },
                    plan: plan,
                    plan_name: planName,
                    amount: amount,
                    currency: ro.currency || 'INR',
                    receipt: ro.receipt || existing?.receipt || '',
                    created_at: createdAt,
                    updated_at: existing?.updated_at || createdAt,
                    failure_reason: failureReason || existing?.failure_reason || null
                };

                orderMap.set(ro.id, merged);
            });

            // 5. Merge any standalone payments
            rzpPayments.forEach(p => {
                if (!p.order_id || !orderMap.has(p.order_id)) {
                    const key = p.order_id || p.id;
                    const existing = orderMap.get(key);
                    let customerPhone = p.contact || p.notes?.phone || existing?.customer?.phone || '';
                    if (customerPhone.startsWith('+91')) customerPhone = customerPhone.substring(3);
                    else if (customerPhone.startsWith('91') && customerPhone.length === 12) customerPhone = customerPhone.substring(2);

                    let customerEmail = p.email || p.notes?.email || existing?.customer?.email || '';
                    if (customerEmail && customerEmail.includes('void@razorpay.com')) customerEmail = existing?.customer?.email || '';

                    const createdAt = p.created_at ? new Date(p.created_at * 1000).toISOString() : (existing?.created_at || new Date().toISOString());
                    const rec = {
                        id: existing?.id || (`rec_${p.created_at ? p.created_at * 1000 : Date.now()}_${Math.random().toString(36).substring(2, 7)}`),
                        order_id: p.order_id || `untracked_${p.id}`,
                        payment_id: p.id,
                        status: p.status === 'captured' ? 'SUCCESS' : 'FAILED',
                        customer: {
                            name: p.notes?.name || existing?.customer?.name || '',
                            email: customerEmail,
                            phone: customerPhone
                        },
                        plan: p.notes?.plan || existing?.plan || 'legends',
                        plan_name: p.notes?.plan_name || existing?.plan_name || 'VIP PLAN',
                        amount: p.amount ? Math.round(p.amount / 100) : 399,
                        currency: p.currency || 'INR',
                        receipt: existing?.receipt || '',
                        created_at: createdAt,
                        updated_at: existing?.updated_at || createdAt,
                        failure_reason: p.error_description || p.error_reason || (p.status === 'captured' ? null : 'Payment failed')
                    };
                    orderMap.set(key, rec);
                }
            });

            const finalOrders = Array.from(orderMap.values());
            finalOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

            saveAllOrders(finalOrders);
            lastSyncTimestamp = Date.now();
            console.log(`[Records Sync]: Successfully synchronized ${finalOrders.length} orders with Razorpay Cloud.`);
            return finalOrders;
        } catch (err) {
            console.error('[Records Sync Error]:', err.message);
            return getAllOrders();
        } finally {
            syncPromise = null;
        }
    })();

    return syncPromise;
}

/**
 * Returns all orders, automatically syncing from Razorpay if database is empty
 * or if auto-sync interval has passed.
 */
async function getOrSyncAllOrders(force = false) {
    const local = getAllOrders();
    const needsSync = force || local.length === 0 || (Date.now() - lastSyncTimestamp > AUTO_SYNC_INTERVAL_MS);
    if (needsSync) {
        return await syncWithRazorpay();
    }
    return local;
}

// Record a new order (PENDING)
function recordOrder(orderData) {
    const orders = getAllOrders();
    const existingIndex = orders.findIndex(o => o.order_id === orderData.order_id);

    const now = new Date().toISOString();
    const newRecord = {
        id: orderData.id || `rec_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        order_id: orderData.order_id,
        payment_id: orderData.payment_id || null,
        status: orderData.status || 'PENDING',
        customer: {
            name: orderData.name || '',
            email: orderData.email || '',
            phone: orderData.phone || ''
        },
        plan: orderData.plan || '',
        plan_name: orderData.plan_name || orderData.plan || '',
        amount: orderData.amount || 0,
        currency: orderData.currency || 'INR',
        receipt: orderData.receipt || '',
        created_at: existingIndex >= 0 ? orders[existingIndex].created_at : now,
        updated_at: now,
        failure_reason: orderData.failure_reason || null
    };

    if (existingIndex >= 0) {
        orders[existingIndex] = { ...orders[existingIndex], ...newRecord };
    } else {
        orders.unshift(newRecord);
    }

    saveAllOrders(orders);
    return newRecord;
}

// Update existing order status (e.g. SUCCESS or FAILED)
function updateOrderStatus(orderId, updates) {
    const orders = getAllOrders();
    const index = orders.findIndex(o => o.order_id === orderId);

    const now = new Date().toISOString();
    if (index >= 0) {
        orders[index] = {
            ...orders[index],
            ...updates,
            updated_at: now
        };
        saveAllOrders(orders);
        return orders[index];
    } else {
        const record = {
            id: `rec_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            order_id: orderId,
            ...updates,
            created_at: now,
            updated_at: now
        };
        orders.unshift(record);
        saveAllOrders(orders);
        return record;
    }
}

// Record a payment failure
function recordPaymentFailure(failureData) {
    const orders = getAllOrders();
    const orderId = failureData.order_id;
    const index = orders.findIndex(o => o.order_id === orderId);

    const now = new Date().toISOString();
    const reason = failureData.error_description || failureData.error_reason || 'Payment failed';

    if (index >= 0) {
        orders[index].status = 'FAILED';
        orders[index].payment_id = failureData.payment_id || orders[index].payment_id || null;
        orders[index].failure_reason = reason;
        orders[index].updated_at = now;
        if (failureData.name) orders[index].customer.name = failureData.name;
        if (failureData.email) orders[index].customer.email = failureData.email;
        if (failureData.phone) orders[index].customer.phone = failureData.phone;
        saveAllOrders(orders);
        return orders[index];
    } else {
        const record = {
            id: `rec_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            order_id: orderId || `untracked_${Date.now()}`,
            payment_id: failureData.payment_id || null,
            status: 'FAILED',
            customer: {
                name: failureData.name || '',
                email: failureData.email || '',
                phone: failureData.phone || ''
            },
            plan: failureData.plan || '',
            plan_name: failureData.plan_name || failureData.plan || '',
            amount: failureData.amount || 0,
            currency: 'INR',
            created_at: now,
            updated_at: now,
            failure_reason: reason
        };
        orders.unshift(record);
        saveAllOrders(orders);
        return record;
    }
}

module.exports = {
    ensureDataFiles,
    getAllOrders,
    getOrSyncAllOrders,
    syncWithRazorpay,
    getLastSyncTime,
    recordOrder,
    updateOrderStatus,
    recordPaymentFailure,
    saveAllOrders,
    JSON_FILE,
    CSV_FILE
};
