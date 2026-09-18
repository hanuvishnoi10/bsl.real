const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;

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

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(urlObj.pathname);

    // Route aliases
    if (pathname === '/' || pathname === '/india/home' || pathname === '/india/home/') {
        pathname = '/index.html';
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
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`404 Not Found: ${pathname}`);
    }
});

server.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 Brazil Sensi Legends Clone server running!`);
    console.log(`======================================================`);
    console.log(`👉 Homepage:             http://localhost:${PORT}/`);
    console.log(`👉 Payment Page (VIP):   http://localhost:${PORT}/payment.html?plan=legends`);
    console.log(`👉 Payment Page (Prime): http://localhost:${PORT}/payment.html?plan=elite`);
    console.log(`======================================================\n`);
});
