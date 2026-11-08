const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const root = __dirname;
const processInstanceId = randomUUID();
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.json': 'application/json; charset=utf-8'
};
const snapshot = JSON.parse(
  fs.readFileSync(path.join(root, 'npc-sellback-snapshot.json'), 'utf8').replace(/^\uFEFF/, '')
);
const npcValues = new Map(
  snapshot.items
    .filter(item => item.available && item.npcSellBack > 2)
    .map(item => [Number(item.id), item.npcSellBack])
);
const npcCatalog = snapshot.items
  .filter(item => item.available && item.npcSellBack > 2)
  .map(item => ({ id: Number(item.id), name: item.name, npcSellBack: item.npcSellBack }));
const marketApi = 'https://api.mesos.watch';
let sessionCookieHeader = null;

const ago = unix => {
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - unix));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
};

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Server-Instance': processInstanceId
  });
  response.end(JSON.stringify(data));
}

async function readJsonBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
  }

  try {
    return JSON.parse(body);
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

async function setSessionCookie(request, response) {
  try {
    const body = await readJsonBody(request);
    const cookieHeader = body && typeof body.cookieHeader === 'string'
      ? body.cookieHeader.trim().replace(/^cookie:\s*/i, '')
      : '';
    const cookieParts = cookieHeader.split(';').map(part => part.trim());
    const hasCookie = name => cookieParts.some(part => {
      const separator = part.indexOf('=');
      return separator > 0 &&
        part.slice(0, separator).trim() === name &&
        part.slice(separator + 1).trim().length > 0;
    });

    if (
      !cookieHeader ||
      /[^\x20-\x7E]/.test(cookieHeader) ||
      !hasCookie('mw_session') ||
      !hasCookie('mw_s')
    ) {
      sendJson(response, 400, {
        error: 'Paste a Cookie header containing non-empty mw_session and mw_s values.'
      });
      return;
    }

    sessionCookieHeader = cookieHeader;
    sendJson(response, 200, { ok: true });
  } catch (error) {
    sendJson(response, error.statusCode || 400, { error: error.message });
  }
}

async function liveListings() {
  if (!sessionCookieHeader) {
    const error = new Error('Paste a Mesos Watch Cookie header to load listings.');
    error.statusCode = 428;
    error.needsCookie = true;
    throw error;
  }

  const response = await fetch(`${marketApi}/browse?sort=seen&dir=desc`, {
    headers: {
      accept: 'application/json',
      origin: 'https://mesos.watch',
      referer: 'https://mesos.watch/',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
      cookie: sessionCookieHeader
    }
  });
  console.log(`Mesos Watch API response status: ${response.status}`);

  if (response.status === 401) {
    sessionCookieHeader = null;
    const error = new Error('Mesos Watch rejected the Cookie header. Paste a renewed one to continue.');
    error.statusCode = 401;
    error.needsCookie = true;
    throw error;
  }
  if (!response.ok) {
    throw new Error(`Mesos Watch returned HTTP ${response.status}`);
  }

  const data = await response.json();
  const stores = data.stores || {};
  const items = data.items || {};
  const listings = (data.rows || [])
    .map(row => {
      const store = stores[row[0]];
      if (!store) return null;

      const itemId = Number(row[2]);
      const npcValue = npcValues.get(itemId);
      if (!npcValue) return null;

      const bundles = Number(row[3]) || 0;
      const per = Number(row[4]) || 1;
      const price = Number(row[5]) || 0;
      return {
        storeId: row[0],
        item: items[itemId] || `Item ${itemId}`,
        icon: '◈',
        quantity: bundles * per,
        unitPrice: price / per,
        npcValue,
        seenAt: ago(store[5]),
        seller: store[3] || 'Unknown',
        channel: store[0],
        room: store[1],
        itemId
      };
    })
    .filter(Boolean);

  return {
    retrievedAt: new Date().toISOString(),
    sourceRows: (data.rows || []).length,
    listings
  };
}

async function handleRequest(request, response) {
  const requestPath = request.url === '/'
    ? '/index.html'
    : request.url.split('?')[0];

  if (requestPath === '/api/session' && request.method === 'POST') {
    await setSessionCookie(request, response);
    return;
  }

  if (requestPath === '/api/live-feed') {
    try {
      const data = await liveListings();
      sendJson(response, 200, data);
    } catch (error) {
      sendJson(response, error.statusCode || 502, {
        error: error.message,
        needsCookie: Boolean(error.needsCookie)
      });
    }
    return;
  }

  if (requestPath === '/api/npc-catalog') {
    sendJson(response, 200, npcCatalog);
    return;
  }

  const filePath = path.resolve(root, `.${requestPath}`);
  if (!filePath.startsWith(root) || !fs.existsSync(filePath)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'Content-Type': types[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(filePath).pipe(response);
}

const port = Number(process.env.PORT) || 1270;
http.createServer(handleRequest).listen(port, '0.0.0.0', () => {
  console.log(`Listening on port ${port}`);
  console.log('Paste the Mesos Watch Cookie header in the app when prompted. It is kept in memory only.');
});
