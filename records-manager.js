const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const JSON_FILE = path.join(DATA_DIR, 'orders.json');
const CSV_FILE = path.join(DATA_DIR, 'orders.csv');

// Ensure data directory and files exist
function ensureDataFiles() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (!fs.existsSync(JSON_FILE)) {
        fs.writeFileSync(JSON_FILE, JSON.stringify([], null, 2), 'utf-8');
    }

    if (!fs.existsSync(CSV_FILE)) {
        const headers = 'Date,Status,Order ID,Payment ID,Customer Name,Email,Phone,Plan,Amount (INR),Failure Reason\n';
        fs.writeFileSync(CSV_FILE, headers, 'utf-8');
    }
}

// Read all orders from JSON
function getAllOrders() {
    ensureDataFiles();
    try {
        const data = fs.readFileSync(JSON_FILE, 'utf-8');
        return JSON.parse(data || '[]');
    } catch (err) {
        console.error('Error reading orders.json:', err);
        return [];
    }
}

// Write orders array to JSON and rewrite CSV
function saveAllOrders(orders) {
    ensureDataFiles();
    try {
        fs.writeFileSync(JSON_FILE, JSON.stringify(orders, null, 2), 'utf-8');
        syncCsv(orders);
        return true;
    } catch (err) {
        console.error('Error saving orders:', err);
        return false;
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
        console.error('Error syncing orders.csv:', err);
    }
}

// Save a new order (created/pending)
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
        orders.unshift(newRecord); // newest first
    }

    saveAllOrders(orders);
    return newRecord;
}

// Update an existing order status (e.g. SUCCESS on verification)
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
        // If order was not recorded initially, record it now
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
    recordOrder,
    updateOrderStatus,
    recordPaymentFailure,
    JSON_FILE,
    CSV_FILE
};
