const PROJECT_ID = 'speraymer-desktopnote';
const API_KEY = 'AIzaSyAem8-cUq3MTjRFN0gy6Nzvrkn2YHROo5k';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-DesktopNote-Client',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const allowedAuthActions = new Set([
  'signInWithPassword',
  'signUp',
  'lookup',
  'update',
  'sendOobCode',
]);

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function destinationFor(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'firebase') return null;

  if (parts[1] === 'auth' && parts.length === 3 && allowedAuthActions.has(parts[2])) {
    if (url.searchParams.get('key') !== API_KEY) return null;
    return `https://identitytoolkit.googleapis.com/v1/accounts:${parts[2]}?key=${API_KEY}`;
  }

  if (parts[1] === 'token' && parts.length === 2 && url.searchParams.get('key') === API_KEY) {
    return `https://securetoken.googleapis.com/v1/token?key=${API_KEY}`;
  }

  return null;
}

async function workspaceResponse(request, operation) {
  let input;
  try { input = await request.json(); } catch { return json(400, { error: { message: 'INVALID_JSON' } }); }
  const userId = String(input?.userId || '');
  const idToken = String(input?.idToken || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId) || idToken.length < 100) {
    return json(400, { error: { message: 'INVALID_WORKSPACE_REQUEST' } });
  }

  const destination = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${encodeURIComponent(userId)}/workspace/current`;
  const upstream = await fetch(destination, {
    method: operation === 'read' ? 'GET' : 'PATCH',
    headers: {
      Authorization: `Bearer ${idToken}`,
      ...(operation === 'write' ? { 'Content-Type': 'application/json' } : {}),
    },
    body: operation === 'write' ? JSON.stringify(input.document || {}) : undefined,
  });
  if (operation === 'read' && upstream.status === 404) return json(200, { missing: true });
  const responseHeaders = new Headers(corsHeaders);
  responseHeaders.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json; charset=utf-8');
  responseHeaders.set('Cache-Control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    const url = new URL(request.url);
    if (url.pathname === '/health') return json(200, { ok: true, project: PROJECT_ID });
    if (request.method === 'POST' && url.pathname === '/firebase/workspace/read') return workspaceResponse(request, 'read');
    if (request.method === 'POST' && url.pathname === '/firebase/workspace/write') return workspaceResponse(request, 'write');
    if (!['GET', 'POST', 'PATCH'].includes(request.method)) return json(405, { error: 'Method not allowed' });

    const destination = destinationFor(url);
    if (!destination) return json(404, { error: 'Route not allowed' });

    const headers = new Headers();
    for (const name of ['authorization', 'content-type']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    try {
      const upstream = await fetch(destination, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        redirect: 'manual',
      });
      const responseHeaders = new Headers(corsHeaders);
      responseHeaders.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json; charset=utf-8');
      responseHeaders.set('Cache-Control', 'no-store');
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    } catch {
      return json(502, { error: { message: 'UPSTREAM_UNAVAILABLE' } });
    }
  },
};
