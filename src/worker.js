// SonyLIV Proxy Worker - Advanced Version
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const userAgent = request.headers.get('User-Agent') || '';
        const isMobile = /mobile|android|iphone/i.test(userAgent);
        
        // CORS handling
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: corsHeaders()
            });
        }
        
        // Home page
        if (url.pathname === '/' || url.pathname === '') {
            return serveHomePage();
        }
        
        // Player page
        if (url.pathname === '/player') {
            return servePlayerPage();
        }
        
        // API endpoints
        if (url.pathname === '/api/proxy') {
            return handleProxyRequest(request, url);
        }
        
        if (url.pathname === '/api/health') {
            return new Response(JSON.stringify({
                status: 'online',
                timestamp: new Date().toISOString(),
                version: '2.0'
            }), {
                headers: {
                    'Content-Type': 'application/json',
                    ...corsHeaders()
                }
            });
        }
        
        // 404
        return new Response('Not Found', { 
            status: 404,
            headers: { 'Content-Type': 'text/plain' }
        });
    }
};

// CORS headers
function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Expose-Headers': '*',
        'Access-Control-Max-Age': '86400'
    };
}

// Handle proxy requests
async function handleProxyRequest(request, url) {
    const targetUrl = url.searchParams.get('url');
    
    if (!targetUrl) {
        return new Response(JSON.stringify({ error: 'URL parameter required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
    }
    
    try {
        const decodedUrl = decodeURIComponent(targetUrl);
        const isM3U8 = /\.m3u8(\?|$)/i.test(decodedUrl);
        const isSegment = /\.(ts|m4s|aac|mp4|vtt|key)(\?|$)/i.test(decodedUrl);
        
        // Enhanced SonyLIV headers
        const headers = new Headers({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'cross-site',
            'DNT': '1',
            'Upgrade-Insecure-Requests': '1'
        });
        
        // SonyLIV specific configuration
        if (decodedUrl.includes('sonydaimenew') || decodedUrl.includes('sonyliv')) {
            headers.set('Origin', 'https://www.sonyliv.com');
            headers.set('Referer', 'https://www.sonyliv.com/');
            headers.set('Host', new URL(decodedUrl).host);
            headers.set('Accept', 'application/x-mpegURL, application/vnd.apple.mpegurl, */*');
            
            // Add Akamai headers
            headers.set('X-Requested-With', 'XMLHttpRequest');
            headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || '');
            headers.set('CF-IPCountry', request.headers.get('CF-IPCountry') || 'US');
        }
        
        // Fetch with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        
        const response = await fetch(decodedUrl, {
            headers: headers,
            signal: controller.signal,
            cf: {
                cacheTtl: isSegment ? 300 : 0, // Cache segments for 5 minutes
                cacheEverything: isSegment,
                polish: 'off',
                mirage: 'off',
                minify: { javascript: false, css: false, html: false }
            }
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        let body;
        let contentType = response.headers.get('content-type') || 
                         (isM3U8 ? 'application/vnd.apple.mpegurl' : 
                          isSegment ? 'video/mp2t' : 'application/octet-stream');
        
        // Handle m3u8 playlist rewriting
        if (isM3U8) {
            body = await response.text();
            
            if (body.includes('#EXTM3U')) {
                const proxyOrigin = new URL(request.url).origin;
                body = rewriteM3U8Playlist(body, decodedUrl, proxyOrigin);
                
                // Add debug info for testing
                if (url.searchParams.get('debug')) {
                    body = `# Proxy Debug Info\n# Original URL: ${decodedUrl}\n# Rewritten at: ${new Date().toISOString()}\n${body}`;
                }
            }
        } else if (isSegment) {
            // Stream segments directly
            return new Response(response.body, {
                status: response.status,
                headers: {
                    ...corsHeaders(),
                    'Content-Type': contentType,
                    'Cache-Control': 'public, max-age=300',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Expose-Headers': '*'
                }
            });
        } else {
            body = await response.text();
        }
        
        // Response headers
        const responseHeaders = new Headers({
            ...corsHeaders(),
            'Content-Type': contentType,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        
        // Forward important headers
        const forwardHeaders = [
            'Content-Length', 'Content-Range', 'Accept-Ranges',
            'Last-Modified', 'ETag', 'Content-Disposition'
        ];
        
        forwardHeaders.forEach(header => {
            const value = response.headers.get(header);
            if (value) responseHeaders.set(header, value);
        });
        
        return new Response(body, {
            status: response.status,
            headers: responseHeaders
        });
        
    } catch (error) {
        console.error('Proxy error:', error);
        
        // Return error as m3u8 format for HLS compatibility
        if (targetUrl.includes('.m3u8')) {
            return new Response(
                `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ERROR: ${error.message}`,
                {
                    status: 500,
                    headers: {
                        'Content-Type': 'application/vnd.apple.mpegurl',
                        ...corsHeaders()
                    }
                }
            );
        }
        
        return new Response(JSON.stringify({
            error: 'Proxy failed',
            message: error.message,
            url: targetUrl
        }), {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
                ...corsHeaders()
            }
        });
    }
}

// Rewrite m3u8 playlist URLs
function rewriteM3U8Playlist(playlist, originalUrl, proxyOrigin) {
    const lines = playlist.split('\n');
    const baseUrl = new URL(originalUrl);
    const basePath = originalUrl.substring(0, originalUrl.lastIndexOf('/') + 1);
    
    return lines.map(line => {
        line = line.trim();
        
        // Skip comments and empty lines
        if (!line || line.startsWith('#')) {
            return line;
        }
        
        // Handle different URL formats
        let fullUrl;
        
        if (line.startsWith('http')) {
            fullUrl = line;
        } else if (line.startsWith('/')) {
            fullUrl = `${baseUrl.protocol}//${baseUrl.host}${line}`;
        } else {
            fullUrl = basePath + line;
        }
        
        // Return proxied URL
        return `${proxyOrigin}/api/proxy?url=${encodeURIComponent(fullUrl)}`;
    }).join('\n');
}

// Serve home page
function serveHomePage() {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🎬 SonyLIV Proxy Server</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%);
            color: #fff;
            min-height: 100vh;
            padding: 20px;
            line-height: 1.6;
        }
        .container { 
            max-width: 800px; 
            margin: 0 auto;
            padding: 40px 20px;
        }
        header { 
            text-align: center; 
            margin-bottom: 40px;
        }
        h1 { 
            font-size: 3em; 
            margin-bottom: 10px;
            background: linear-gradient(45deg, #00ff88, #ff0080);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            text-shadow: 0 0 30px rgba(0, 255, 136, 0.3);
        }
        .tagline { 
            color: #aaa; 
            font-size: 1.2em;
            margin-bottom: 30px;
        }
        .card {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 15px;
            padding: 30px;
            margin: 20px 0;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        .btn {
            display: inline-block;
            background: linear-gradient(45deg, #00ff88, #ff0080);
            color: white;
            padding: 15px 30px;
            border-radius: 50px;
            text-decoration: none;
            font-weight: bold;
            margin: 10px;
            transition: transform 0.3s, box-shadow 0.3s;
            box-shadow: 0 5px 15px rgba(0, 255, 136, 0.2);
        }
        .btn:hover {
            transform: translateY(-3px);
            box-shadow: 0 10px 25px rgba(0, 255, 136, 0.3);
        }
        .btn-secondary {
            background: rgba(255, 255, 255, 0.1);
        }
        .status {
            padding: 15px;
            border-radius: 10px;
            margin: 20px 0;
            font-family: monospace;
        }
        .success { background: rgba(0, 255, 136, 0.1); border-left: 4px solid #00ff88; }
        .error { background: rgba(255, 0, 128, 0.1); border-left: 4px solid #ff0080; }
        code {
            background: rgba(0, 0, 0, 0.3);
            padding: 2px 6px;
            border-radius: 4px;
            font-family: monospace;
            color: #00ff88;
        }
        .features {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin: 30px 0;
        }
        .feature {
            background: rgba(255, 255, 255, 0.03);
            padding: 20px;
            border-radius: 10px;
            text-align: center;
        }
        .feature-icon {
            font-size: 2em;
            margin-bottom: 10px;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>🔓 SonyLIV Proxy</h1>
            <p class="tagline">Bypass restrictions with Cloudflare Workers</p>
        </header>
        
        <div class="card">
            <h2>🚀 Quick Start</h2>
            <p>This proxy server helps bypass SonyLIV restrictions using Cloudflare Workers.</p>
            
            <div id="status" class="status">Testing connection...</div>
            
            <div style="text-align: center; margin: 30px 0;">
                <a href="/player" class="btn">🎬 Open Player</a>
                <a href="/api/health" class="btn btn-secondary">🔧 API Health</a>
            </div>
        </div>
        
        <div class="features">
            <div class="feature">
                <div class="feature-icon">⚡</div>
                <h3>Fast</h3>
                <p>Cloudflare Edge Network</p>
            </div>
            <div class="feature">
                <div class="feature-icon">🛡️</div>
                <h3>Secure</h3>
                <p>CORS & Headers Handling</p>
            </div>
            <div class="feature">
                <div class="feature-icon">🔄</div>
                <h3>Reliable</h3>
                <p>Automatic Retry & Cache</p>
            </div>
        </div>
        
        <div class="card">
            <h2>📖 How to Use</h2>
            <p>Proxy any SonyLIV M3U8 URL:</p>
            <code>GET /api/proxy?url=ENCODED_M3U8_URL</code>
            
            <p style="margin-top: 20px;">Example:</p>
            <code style="display: block; white-space: pre-wrap; overflow-x: auto;">
https://your-worker.workers.dev/api/proxy?url=https%3A%2F%2Fsonydaimenew.akamaized.net%2Fhls%2Flive%2F2005445%2FDAI06ME-AO%2Fstd_lrh-800300010.m3u8
            </code>
        </div>
    </div>
    
    <script>
        // Test API on load
        async function testAPI() {
            const status = document.getElementById('status');
            
            try {
                const response = await fetch('/api/health');
                const data = await response.json();
                
                status.innerHTML = \`<div class="success">
                    ✅ API Online<br>
                    Status: \${data.status}<br>
                    Version: \${data.version}
                </div>\`;
                
            } catch (error) {
                status.innerHTML = \`<div class="error">
                    ❌ API Offline<br>
                    Error: \${error.message}
                </div>\`;
            }
        }
        
        testAPI();
        
        // Telegram prompt
        setTimeout(() => {
            if (confirm('Join @ᴍᴀᴛᴄʜᴇꜱ ʟɪɴᴋꜱ Telegram for updates?')) {
                window.open('https://t.me/+e3-eAje291cxNGNl', '_blank');
            }
        }, 3000);
    </script>
</body>
</html>`;
    
    return new Response(html, {
        headers: { 'Content-Type': 'text/html' }
    });
}

// Serve player page
function servePlayerPage() {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🎬 SonyLIV Player</title>
    <link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css" />
    <style>
        :root {
            --plyr-color-main: #00ff88;
            --plyr-video-controls-background: rgba(0, 0, 0, 0.8);
        }
        
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            background: #000; 
            color: white; 
            font-family: Arial, sans-serif;
            min-height: 100vh;
        }
        
        .header {
            background: rgba(0, 0, 0, 0.9);
            padding: 15px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid #333;
            position: sticky;
            top: 0;
            z-index: 100;
        }
        
        .logo {
            font-size: 1.5em;
            font-weight: bold;
            background: linear-gradient(45deg, #00ff88, #ff0080);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        
        .controls {
            display: flex;
            gap: 10px;
        }
        
        .btn {
            background: #333;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 14px;
            transition: background 0.3s;
        }
        
        .btn:hover { background: #444; }
        .btn.primary { background: #00ff88; color: #000; }
        .btn.primary:hover { background: #00cc6a; }
        
        .player-container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
        }
        
        #video {
            width: 100%;
            height: 70vh;
            min-height: 500px;
            background: #000;
            border-radius: 10px;
            overflow: hidden;
        }
        
        .info-panel {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 10px;
            padding: 20px;
            margin: 20px 0;
        }
        
        .status {
            padding: 10px;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 5px;
            margin: 10px 0;
            font-family: monospace;
            word-break: break-all;
        }
        
        .debug {
            background: #111;
            padding: 15px;
            border-radius: 5px;
            margin-top: 20px;
            max-height: 200px;
            overflow-y: auto;
            font-size: 12px;
            font-family: monospace;
        }
        
        .debug-line {
            padding: 2px 0;
            border-bottom: 1px solid #222;
        }
        
        .debug-line.success { color: #00ff88; }
        .debug-line.error { color: #ff5252; }
        .debug-line.warning { color: #ffb142; }
        
        .loading {
            display: none;
            text-align: center;
            padding: 40px;
        }
        
        .spinner {
            border: 4px solid rgba(255,255,255,0.1);
            border-top: 4px solid #00ff88;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 0 auto 20px;
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        @media (max-width: 768px) {
            .header { flex-direction: column; gap: 10px; }
            #video { height: 50vh; min-height: 300px; }
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="logo">🎬 SonyLIV Player</div>
        <div class="controls">
            <button class="btn primary" onclick="playStream()">▶ Play</button>
            <button class="btn" onclick="stopStream()">⏹ Stop</button>
            <button class="btn" onclick="testStream()">🔍 Test</button>
            <button class="btn" onclick="location.href='/'">🏠 Home</button>
        </div>
    </div>
    
    <div class="player-container">
        <video id="video" playsinline controls crossorigin="anonymous"></video>
        
        <div class="loading" id="loading">
            <div class="spinner"></div>
            <p>Loading SonyLIV stream...</p>
        </div>
        
        <div class="info-panel">
            <h3>Stream Info</h3>
            <div class="status" id="status">Ready to play...</div>
            
            <div style="margin: 15px 0;">
                <label>Stream URL:</label>
                <input type="text" id="streamUrl" style="width: 100%; padding: 10px; margin: 5px 0; background: #222; color: white; border: 1px solid #444; border-radius: 5px;" 
                       value="https://sonydaimenew.akamaized.net/hls/live/2005445/DAI06ME-AO/std_lrh-800300010.m3u8?hdnea=exp=1769706634~acl=/*~id=39889634370869881063204522079007~hmac=5777fdce8ef0f5d55a25f82f022f2d2b59eb04b122b0f74d4e803163ad80861b">
                <button class="btn" onclick="updateStreamUrl()" style="margin-top: 10px;">Update URL</button>
            </div>
        </div>
        
        <div class="debug" id="debug"></div>
    </div>
    
    <script src="https://cdn.jsdelivr.net/npm/hls.js@1.4.10/dist/hls.min.js"></script>
    <script src="https://cdn.plyr.io/3.7.8/plyr.js"></script>
    
    <script>
        const video = document.getElementById('video');
        const statusDiv = document.getElementById('status');
        const debugDiv = document.getElementById('debug');
        const loadingDiv = document.getElementById('loading');
        const streamUrlInput = document.getElementById('streamUrl');
        
        let hls = null;
        let currentStreamUrl = '';
        
        // Initialize Plyr player
        const player = new Plyr(video, {
            controls: ['play', 'progress', 'current-time', 'mute', 'volume', 'settings', 'fullscreen'],
            settings: ['quality', 'speed'],
            autoplay: false,
            clickToPlay: false
        });
        
        function logDebug(message, type = 'info') {
            const timestamp = new Date().toLocaleTimeString();
            const typeClass = type === 'error' ? 'error' : 
                            type === 'success' ? 'success' : 
                            type === 'warning' ? 'warning' : '';
            
            debugDiv.innerHTML = \`<div class="debug-line \${typeClass}">[\${timestamp}] \${message}</div>\` + debugDiv.innerHTML;
            console.log(\`[\${type.toUpperCase()}] \${message}\`);
        }
        
        function updateStatus(message) {
            statusDiv.textContent = message;
            logDebug(\`Status: \${message}\`);
        }
        
        function showLoading(show) {
            loadingDiv.style.display = show ? 'block' : 'none';
        }
        
        function updateStreamUrl() {
            currentStreamUrl = streamUrlInput.value.trim();
            updateStatus('URL updated');
            logDebug(\`Stream URL updated: \${currentStreamUrl.substring(0, 100)}...\`);
        }
        
        async function testStream() {
            showLoading(true);
            updateStatus('Testing stream...');
            
            const streamUrl = currentStreamUrl || streamUrlInput.value.trim();
            
            if (!streamUrl) {
                updateStatus('❌ No stream URL provided');
                showLoading(false);
                return;
            }
            
            // Build proxy URL
            const proxyUrl = '/api/proxy?url=' + encodeURIComponent(streamUrl) + '&debug=true';
            
            try {
                const response = await fetch(proxyUrl);
                const text = await response.text();
                
                if (response.ok) {
                    if (text.includes('#EXTM3U')) {
                        updateStatus('✅ Stream is working!');
                        logDebug('Proxy response (first 500 chars):', 'success');
                        logDebug(text.substring(0, 500) + '...', 'info');
                        
                        // Show sample of playlist
                        const lines = text.split('\\n').slice(0, 20).join('\\n');
                        logDebug('Playlist sample:\\n' + lines, 'info');
                    } else {
                        updateStatus('⚠️ Got response but not valid M3U8');
                        logDebug('Response: ' + text.substring(0, 200), 'warning');
                    }
                } else {
                    updateStatus(\`❌ HTTP \${response.status}: \${response.statusText}\`);
                    logDebug(\`Error response: \${text}\`, 'error');
                }
            } catch (error) {
                updateStatus(\`❌ Test failed: \${error.message}\`);
                logDebug(\`Test error: \${error.message}\`, 'error');
            }
            
            showLoading(false);
        }
        
        async function playStream() {
            showLoading(true);
            updateStatus('Loading stream...');
            
            // Stop existing stream
            if (hls) {
                hls.destroy();
                hls = null;
            }
            
            const streamUrl = currentStreamUrl || streamUrlInput.value.trim();
            
            if (!streamUrl) {
                updateStatus('❌ Please enter a stream URL');
                showLoading(false);
                return;
            }
            
            // Build proxy URL
            const proxyUrl = '/api/proxy?url=' + encodeURIComponent(streamUrl);
            logDebug(\`Loading via proxy: \${proxyUrl.substring(0, 100)}...\`, 'info');
            
            if (Hls.isSupported()) {
                hls = new Hls({
                    enableWorker: true,
                    lowLatencyMode: true,
                    backBufferLength: 90,
                    manifestLoadingTimeOut: 15000,
                    manifestLoadingMaxRetry: 6,
                    levelLoadingTimeOut: 10000,
                    levelLoadingMaxRetry: 4,
                    fragLoadingTimeOut: 30000,
                    fragLoadingMaxRetry: 10,
                    xhrSetup: function(xhr, url) {
                        logDebug(\`Fetching: \${url.substring(0, 80)}...\`, 'info');
                        
                        // Add headers for better compatibility
                        xhr.setRequestHeader('Origin', window.location.origin);
                        xhr.setRequestHeader('Referer', window.location.href);
                        xhr.setRequestHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
                        
                        // SonyLIV specific
                        if (url.includes('sonydaimenew')) {
                            xhr.setRequestHeader('Accept', 'application/x-mpegURL, application/vnd.apple.mpegurl, */*');
                        }
                    }
                });
                
                hls.loadSource(proxyUrl);
                hls.attachMedia(video);
                
                hls.on(Hls.Events.MANIFEST_PARSED, function(event, data) {
                    logDebug('✅ Manifest parsed successfully!', 'success');
                    logDebug(\`Quality levels: \${data.levels.map(l => l.height + 'p').join(', ')}\`, 'info');
                    
                    updateStatus('Stream ready - playing...');
                    
                    // Auto-play with muted audio
                    video.muted = true;
                    video.play().then(() => {
                        logDebug('🎬 Playback started', 'success');
                        showLoading(false);
                    }).catch(e => {
                        logDebug(\`Autoplay prevented: \${e.message}. Click play button.\`, 'warning');
                        showLoading(false);
                    });
                });
                
                hls.on(Hls.Events.LEVEL_SWITCHED, function(event, data) {
                    logDebug(\`📊 Switched to: \${data.height}p\`, 'info');
                });
                
                hls.on(Hls.Events.ERROR, function(event, data) {
                    logDebug(\`HLS Error: \${data.type} - \${data.details} - \${data.error?.message || ''}\`, 'error');
                    
                    if (data.fatal) {
                        switch(data.type) {
                            case Hls.ErrorTypes.NETWORK_ERROR:
                                updateStatus('🌐 Network error - retrying...');
                                setTimeout(() => hls.startLoad(), 2000);
                                break;
                            case Hls.ErrorTypes.MEDIA_ERROR:
                                updateStatus('🎵 Media error - attempting recovery...');
                                hls.recoverMediaError();
                                break;
                            case Hls.ErrorTypes.KEY_SYSTEM_ERROR:
                                updateStatus('🔒 DRM Protected - Cannot bypass SonyLIV DRM');
                                showLoading(false);
                                break;
                            default:
                                updateStatus('❌ Fatal error');
                                showLoading(false);
                        }
                    }
                });
                
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                // Safari native HLS
                logDebug('Using native HLS (Safari)', 'info');
                video.src = proxyUrl;
                
                video.addEventListener('loadedmetadata', function() {
                    updateStatus('Safari HLS loaded');
                    video.play();
                    showLoading(false);
                });
                
                video.addEventListener('error', function(e) {
                    logDebug(\`Native HLS error: \${video.error?.message}\`, 'error');
                    showLoading(false);
                });
                
            } else {
                updateStatus('❌ HLS not supported by your browser');
                showLoading(false);
            }
        }
        
        function stopStream() {
            if (hls) {
                hls.destroy();
                hls = null;
            }
            if (video.src) {
                video.src = '';
            }
            updateStatus('Stream stopped');
            logDebug('Playback stopped', 'info');
        }
        
        // Initialize
        document.addEventListener('DOMContentLoaded', function() {
            updateStatus('Ready. Click "Test" to check stream, then "Play".');
            logDebug('Player initialized', 'info');
            
            // Set default stream URL
            currentStreamUrl = streamUrlInput.value;
            
            // Auto-test after 2 seconds
            setTimeout(testStream, 2000);
        });
        
        // Telegram prompt
        setTimeout(() => {
            if (confirm('Need help? Join @ᴍᴀᴛᴄʜᴇꜱ ʟɪɴᴋꜱ Telegram for support!')) {
                window.open('https://t.me/+e3-eAje291cxNGNl', '_blank');
            }
        }, 5000);
    </script>
</body>
</html>`;
    
    return new Response(html, {
        headers: { 'Content-Type': 'text/html' }
    });
}
