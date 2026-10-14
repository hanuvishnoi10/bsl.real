/**
 * Brazil Sensi Legends - Frontend Configuration
 * 
 * HOW TO CONFIGURE FOR RENDER DEPLOYMENT:
 * ----------------------------------------------------
 * Option 1 (Recommended via Render Environment Variables):
 * In your Render Static Site dashboard:
 * 1. Go to "Environment" > "Add Environment Variable".
 * 2. Set: BACKEND_URL = https://your-backend-service.onrender.com
 * 3. Set Build Command: npm run build
 * (The build script will automatically inject BACKEND_URL into this file).
 * 
 * Option 2 (Direct Edit):
 * Simply replace DEFAULT_BACKEND_URL below with your deployed Render Web Service URL.
 */
(function () {
    // Injected during 'npm run build' if BACKEND_URL environment variable is set
    const INJECTED_BACKEND_URL = '';

    // Production backend placeholder URL (replace with your deployed Render Web Service URL)
    const DEFAULT_BACKEND_URL = 'https://bsl-real2.onrender.com';

    // Local development backend URL
    const LOCAL_DEV_URL = 'http://localhost:5000';

    const isLocalhost = Boolean(
        typeof window !== 'undefined' &&
        window.location &&
        (window.location.hostname === 'localhost' ||
            window.location.hostname === '127.0.0.1' ||
            window.location.hostname === '')
    );

    let resolvedBackendUrl = '';
    if (INJECTED_BACKEND_URL) {
        resolvedBackendUrl = INJECTED_BACKEND_URL;
    } else if (isLocalhost) {
        // If served from port 3000 or 5000 on localhost, use relative path or local port
        resolvedBackendUrl = (window.location.port === '3000' || window.location.port === '5000')
            ? ''
            : LOCAL_DEV_URL;
    } else {
        resolvedBackendUrl = DEFAULT_BACKEND_URL;
    }

    window.APP_CONFIG = {
        BACKEND_URL: resolvedBackendUrl.replace(/\/+$/, '')
    };

    /**
     * Resolves the full URL for an API endpoint.
     * @param {string} endpoint - e.g. '/api/create-order'
     * @returns {string} - Full absolute URL in production or relative/local URL in dev
     */
    window.getApiUrl = function (endpoint) {
        const cleanEndpoint = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
        const base = (window.APP_CONFIG && window.APP_CONFIG.BACKEND_URL)
            ? window.APP_CONFIG.BACKEND_URL.replace(/\/+$/, '')
            : '';
        return base ? `${base}${cleanEndpoint}` : cleanEndpoint;
    };
})();
