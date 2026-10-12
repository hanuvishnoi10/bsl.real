const fs = require('fs');
const jpeg = require('jpeg-js');
const jsQR = require('jsqr');

function processQRImage(srcPath, outStandeeJpg, outCardJpg, outPureJpg) {
    console.log(`\n=== Processing: ${srcPath} ===`);
    const buf = fs.readFileSync(srcPath);
    const raw = jpeg.decode(buf, { useTArray: true });
    const w = raw.width;
    const h = raw.height;

    // Verify original image QR
    const origDecoded = jsQR(raw.data, w, h);
    console.log(`Original QR: ${origDecoded ? origDecoded.data : 'FAILED ❌'}`);

    // 1. Clean Framed Standee (crop away black top triangle and empty bottom space)
    const standeeCropY = 170;
    const standeeCropH = 710;
    const standeeCropW = w;
    const standeeData = Buffer.alloc(standeeCropW * standeeCropH * 4);

    for (let cy = 0; cy < standeeCropH; cy++) {
        const srcY = standeeCropY + cy;
        for (let cx = 0; cx < standeeCropW; cx++) {
            const destIdx = (cy * standeeCropW + cx) * 4;
            const srcIdx = (srcY * w + cx) * 4;

            let r = raw.data[srcIdx];
            let g = raw.data[srcIdx + 1];
            let b = raw.data[srcIdx + 2];

            // Turn top black/angled background into pure white
            if (srcY <= (216 - 0.43 * cx) || (srcY < 230 && cx < 100 && (r < 80 || (b > 120 && b > r + 30)))) {
                r = 255; g = 255; b = 255;
            }

            standeeData[destIdx] = r;
            standeeData[destIdx + 1] = g;
            standeeData[destIdx + 2] = b;
            standeeData[destIdx + 3] = 255;
        }
    }
    const standeeJpeg = jpeg.encode({ data: standeeData, width: standeeCropW, height: standeeCropH }, 97);
    fs.writeFileSync(outStandeeJpg, standeeJpeg.data);
    const standeeDecoded = jsQR(standeeData, standeeCropW, standeeCropH);
    console.log(`✅ Saved Standee: ${outStandeeJpg} (${standeeCropW}x${standeeCropH}) - Decodable: ${!!standeeDecoded}`);

    // 2. Clean QR Card (BHIM UPI + QR + "SCAN & PAY WITH ANY UPI APP")
    const cardX = 66;
    const cardY = 320;
    const cardW = 287;
    const cardH = 390;
    const radius = 24;
    const cardData = Buffer.alloc(cardW * cardH * 4);

    for (let cy = 0; cy < cardH; cy++) {
        for (let cx = 0; cx < cardW; cx++) {
            const destIdx = (cy * cardW + cx) * 4;
            const srcIdx = ((cardY + cy) * w + (cardX + cx)) * 4;

            let r = raw.data[srcIdx];
            let g = raw.data[srcIdx + 1];
            let b = raw.data[srcIdx + 2];

            // Rounded corner check
            let isCorner = false;
            if (cx < radius && cy < radius) {
                const dx = radius - cx;
                const dy = radius - cy;
                if (dx * dx + dy * dy > radius * radius) isCorner = true;
            }
            if (cx >= cardW - radius && cy < radius) {
                const dx = cx - (cardW - radius - 1);
                const dy = radius - cy;
                if (dx * dx + dy * dy > radius * radius) isCorner = true;
            }
            if (cx < radius && cy >= cardH - radius) {
                const dx = radius - cx;
                const dy = cy - (cardH - radius - 1);
                if (dx * dx + dy * dy > radius * radius) isCorner = true;
            }
            if (cx >= cardW - radius && cy >= cardH - radius) {
                const dx = cx - (cardW - radius - 1);
                const dy = cy - (cardH - radius - 1);
                if (dx * dx + dy * dy > radius * radius) isCorner = true;
            }

            const isOuter = (cx < 12 || cx >= cardW - 12 || cy < 12 || cy >= cardH - 12);
            const isCornerZone = (cx < 40 && cy > cardH - 45) || (cx > cardW - 45 && cy < 45);

            if (isCorner) {
                r = 255; g = 255; b = 255;
            } else if ((isOuter || isCornerZone) && (b > 100 && b > r + 10)) {
                r = 255; g = 255; b = 255;
            } else if (cx <= 1 || cx >= cardW - 2 || cy <= 1 || cy >= cardH - 2) {
                r = 255; g = 255; b = 255;
            }

            cardData[destIdx] = r;
            cardData[destIdx + 1] = g;
            cardData[destIdx + 2] = b;
            cardData[destIdx + 3] = 255;
        }
    }
    const cardJpeg = jpeg.encode({ data: cardData, width: cardW, height: cardH }, 97);
    fs.writeFileSync(outCardJpg, cardJpeg.data);
    const cardDecoded = jsQR(cardData, cardW, cardH);
    console.log(`✅ Saved Card: ${outCardJpg} (${cardW}x${cardH}) - Decodable: ${!!cardDecoded}`);

    // 3. Pure Square QR Code with white quiet zone
    const qrX = 76;
    const qrY = 395;
    const qrSize = 267;
    const qrData = Buffer.alloc(qrSize * qrSize * 4);

    for (let qy = 0; qy < qrSize; qy++) {
        for (let qx = 0; qx < qrSize; qx++) {
            const destIdx = (qy * qrSize + qx) * 4;
            const srcIdx = ((qrY + qy) * w + (qrX + qx)) * 4;

            let r = raw.data[srcIdx];
            let g = raw.data[srcIdx + 1];
            let b = raw.data[srcIdx + 2];

            if (b > 140 && r < 140) {
                r = 255; g = 255; b = 255;
            }

            qrData[destIdx] = r;
            qrData[destIdx + 1] = g;
            qrData[destIdx + 2] = b;
            qrData[destIdx + 3] = 255;
        }
    }
    const pureJpeg = jpeg.encode({ data: qrData, width: qrSize, height: qrSize }, 97);
    fs.writeFileSync(outPureJpg, pureJpeg.data);
    const pureDecoded = jsQR(qrData, qrSize, qrSize);
    console.log(`✅ Saved Pure QR: ${outPureJpg} (${qrSize}x${qrSize}) - Decodable: ${!!pureDecoded}`);
}

const u399 = 'C:/Users/LENOVO/.gemini/antigravity-ide/brain/bb3a3ffa-d0b9-4f3d-82c0-6c81df7cdd17/.user_uploaded/media_1791819835660.jpg';
const u699 = 'C:/Users/LENOVO/.gemini/antigravity-ide/brain/bb3a3ffa-d0b9-4f3d-82c0-6c81df7cdd17/.user_uploaded/media_1791819839924.jpg';

processQRImage(u399, 'assets/images/razorpay-qr-399.jpg', 'assets/images/razorpay-qr-399-card.jpg', 'assets/images/razorpay-qr-399-pure.jpg');
processQRImage(u699, 'assets/images/razorpay-qr-699.jpg', 'assets/images/razorpay-qr-699-card.jpg', 'assets/images/razorpay-qr-699-pure.jpg');
