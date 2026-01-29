// functions/_worker.js - SonyLIV Proxy Worker
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        
        // CORS headers
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Max-Age': '86400'
        };
        
        // Handle preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }
        
        // Proxy endpoint
        if (url.pathname === '/proxy' || url.pathname.startsWith('/api/')) {
            const targetUrl = url.searchParams.get('url');
            
            if (!targetUrl) {
                return new Response('Add ?url=ENCODED_URL parameter', {
                    status: 400,
                    headers: { 'Content-Type': 'text/plain', ...corsHeaders }
                });
            }
            
            try {
                const decodedUrl = decodeURIComponent(targetUrl);
                
                // SonyLIV headers
                const headers = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                };
                
                // Add SonyLIV specific headers
                if (decodedUrl.includes('sonydaimenew')) {
                    headers['Origin'] = 'https://www.sonyliv.com';
                    headers['Referer'] = 'https://www.sonyliv.com/';
                    headers['Host'] = new URL(decodedUrl).host;
                }
                
                // Fetch the stream
                const response = await fetch(decodedUrl, { headers });
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                
                let body = await response.text();
                const contentType = response.headers.get('content-type') || 
                                  (decodedUrl.includes('.m3u8') ? 'application/vnd.apple.mpegurl' : 'text/plain');
                
                // Rewrite m3u8 playlist URLs
                if (decodedUrl.includes('.m3u8') && body.includes('#EXTM3U')) {
                    const proxyOrigin = url.origin;
                    const lines = body.split('\n').map(line => {
                        line = line.trim();
                        if (!line || line.startsWith('#')) return line;
                        
                        if (line.startsWith('http')) {
                            return `${proxyOrigin}/proxy?url=${encodeURIComponent(line)}`;
                        } else if (line.startsWith('/')) {
                            const baseUrl = new URL(decodedUrl);
                            const fullUrl = `${baseUrl.protocol}//${baseUrl.host}${line}`;
                            return `${proxyOrigin}/proxy?url=${encodeURIComponent(fullUrl)}`;
                        }
                        return line;
                    }).join('\n');
                    
                    body = lines;
                }
                
                return new Response(body, {
                    headers: {
                        ...corsHeaders,
                        'Content-Type': contentType,
                        'Cache-Control': 'no-cache, no-store, must-revalidate'
                    }
                });
                
            } catch (error) {
                return new Response(`Proxy Error: ${error.message}`, {
                    status: 500,
                    headers: { 'Content-Type': 'text/plain', ...corsHeaders }
                });
            }
        }
        
        // Serve static files (if any)
        return new Response('SonyLIV Proxy Worker', {
            headers: { 'Content-Type': 'text/plain' }
        });
    }
};
