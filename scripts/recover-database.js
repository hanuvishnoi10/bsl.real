const Razorpay = require('razorpay');
const fs = require('fs');
const path = require('path');

const key_id = (process.env.RAZORPAY_KEY_ID || 'rzp_live_TmrLRMLEAGkdl2').trim();
const key_secret = (process.env.RAZORPAY_KEY_SECRET || 'UDokBuQ7ch3PsfVdvADt90Py').trim();
const rzp = new Razorpay({ key_id, key_secret });

function escapeCsv(val) {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
}

function syncCsv(filePath, orders) {
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
    fs.writeFileSync(filePath, header + rows.join('\n') + '\n', 'utf-8');
}

async function recoverAll() {
    console.log('[Recovery]: Starting full database recovery & synchronization...');
    const orderMap = new Map();

    // 1. Load root data/orders.json if it exists
    const rootJsonPath = path.join(__dirname, '..', 'data', 'orders.json');
    if (fs.existsSync(rootJsonPath)) {
        try {
            const rootData = JSON.parse(fs.readFileSync(rootJsonPath, 'utf-8'));
            rootData.forEach(o => {
                if (o.order_id) orderMap.set(o.order_id, o);
            });
            console.log(`[Recovery]: Loaded ${rootData.length} existing root records.`);
        } catch (e) {
            console.warn('[Recovery]: Root JSON parse warning:', e.message);
        }
    }

    // 2. Load backend/data/orders.json if it exists
    const backendJsonPath = path.join(__dirname, '..', 'backend', 'data', 'orders.json');
    if (fs.existsSync(backendJsonPath)) {
        try {
            const backendData = JSON.parse(fs.readFileSync(backendJsonPath, 'utf-8'));
            backendData.forEach(o => {
                if (o.order_id) {
                    if (orderMap.has(o.order_id)) {
                        orderMap.set(o.order_id, { ...orderMap.get(o.order_id), ...o });
                    } else {
                        orderMap.set(o.order_id, o);
                    }
                }
            });
            console.log(`[Recovery]: Loaded ${backendData.length} existing backend records.`);
        } catch (e) {
            console.warn('[Recovery]: Backend JSON parse warning:', e.message);
        }
    }

    // 3. Fetch all Razorpay orders (paginated)
    let rzpOrders = [];
    let skip = 0;
    while (true) {
        const batch = await rzp.orders.all({ count: 100, skip });
        rzpOrders = rzpOrders.concat(batch.items || []);
        if (!batch.items || batch.items.length < 100) break;
        skip += 100;
    }
    console.log(`[Recovery]: Successfully fetched ${rzpOrders.length} orders from Razorpay Cloud API.`);

    // 4. Fetch all Razorpay payments (paginated)
    let rzpPayments = [];
    skip = 0;
    while (true) {
        const batch = await rzp.payments.all({ count: 100, skip });
        rzpPayments = rzpPayments.concat(batch.items || []);
        if (!batch.items || batch.items.length < 100) break;
        skip += 100;
    }
    console.log(`[Recovery]: Successfully fetched ${rzpPayments.length} payments from Razorpay Cloud API.`);

    const paymentByOrderId = new Map();
    rzpPayments.forEach(p => {
        if (p.order_id) {
            paymentByOrderId.set(p.order_id, p);
        }
    });

    // 5. Merge all Razorpay orders
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

    // 6. Merge any standalone payments
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

    console.log(`[Recovery]: Total reconstructed lifetime orders: ${finalOrders.length}`);

    // Save to root data/
    const rootDataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(rootDataDir)) fs.mkdirSync(rootDataDir, { recursive: true });
    fs.writeFileSync(path.join(rootDataDir, 'orders.json'), JSON.stringify(finalOrders, null, 2), 'utf-8');
    syncCsv(path.join(rootDataDir, 'orders.csv'), finalOrders);

    // Save to backend/data/
    const backendDataDir = path.join(__dirname, '..', 'backend', 'data');
    if (!fs.existsSync(backendDataDir)) fs.mkdirSync(backendDataDir, { recursive: true });
    fs.writeFileSync(path.join(backendDataDir, 'orders.json'), JSON.stringify(finalOrders, null, 2), 'utf-8');
    syncCsv(path.join(backendDataDir, 'orders.csv'), finalOrders);

    console.log('[Recovery]: Successfully synced to both ./data/ and ./backend/data/!');
    return finalOrders;
}

if (require.main === module) {
    recoverAll()
        .then(orders => {
            console.log(`\n======================================================`);
            console.log(`✅ Data Recovery Complete! Total Records: ${orders.length}`);
            console.log(`======================================================`);
            const yesterdayDateStr = new Date(Date.now() - 24 * 3600 * 1000).toISOString().split('T')[0];
            const yesterdayOrders = orders.filter(o => o.created_at.startsWith('2026-10-16'));
            console.log(`Yesterday's (Oct 16) orders recovered: ${yesterdayOrders.length}`);
            yesterdayOrders.slice(0, 5).forEach(o => {
                console.log(`👉 ${o.created_at} | ${o.status} | ${o.customer.name} | ${o.customer.phone} | ₹${o.amount}`);
            });
        })
        .catch(err => {
            console.error('[Recovery Error]:', err);
            process.exit(1);
        });
}

module.exports = { recoverAll };
