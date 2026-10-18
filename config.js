/**
 * Brazil Sensi Legends - Frontend Configuration
 * 
 * Production Backend: https://bsl-real2.onrender.com
 * Local Development Backend: http://localhost:5000 (or relative '' if served by backend)
 */
(function () {
    // Injected during 'npm run build' if BACKEND_URL environment variable is set
    const INJECTED_BACKEND_URL = '';

    // Production backend URL for Render Web Service
    const DEFAULT_BACKEND_URL = 'https://bsl-real-backend.onrender.com';

    // Local development backend URL
    const LOCAL_DEV_URL = 'http://localhost:5000';

    const isLocalhost = Boolean(
        typeof window !== 'undefined' &&
        window.location &&
        (window.location.hostname === 'localhost' ||
         window.location.hostname === '127.0.0.1' ||
         window.location.hostname === '')
    );

    const forceProd = Boolean(
        typeof window !== 'undefined' &&
        window.location &&
        (new URLSearchParams(window.location.search).get('prod') === '1' ||
         new URLSearchParams(window.location.search).get('backend') === 'prod')
    );

    let resolvedBackendUrl = '';
    if (INJECTED_BACKEND_URL) {
        resolvedBackendUrl = INJECTED_BACKEND_URL;
    } else if (forceProd || !isLocalhost) {
        resolvedBackendUrl = DEFAULT_BACKEND_URL;
    } else {
        // If served from port 3000 or 5000 on localhost, use relative path or local port
        resolvedBackendUrl = (window.location.port === '3000' || window.location.port === '5000') 
            ? '' 
            : LOCAL_DEV_URL;
    }

    window.APP_CONFIG = {
        BACKEND_URL: resolvedBackendUrl.replace(/\/+$/, ''),
        PRODUCTION_BACKEND_URL: DEFAULT_BACKEND_URL,
        LOCAL_BACKEND_URL: LOCAL_DEV_URL
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
            : (isLocalhost ? '' : DEFAULT_BACKEND_URL);
        return base ? `${base}${cleanEndpoint}` : cleanEndpoint;
    };
})();
