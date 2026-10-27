// Adapta un handler estilo Lambda (event) a una función moderna (Request/Response),
// necesaria para que @netlify/database reciba su conexión automáticamente.
module.exports = function adapt(handler) {
  return async (req) => {
    const url = new URL(req.url);
    const headers = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    const qs = {};
    url.searchParams.forEach((v, k) => { qs[k] = v; });
    const method = req.method.toUpperCase();
    const body = method === "GET" || method === "HEAD" ? null : await req.text();
    const r = await handler({
      httpMethod: method,
      headers,
      queryStringParameters: qs,
      path: url.pathname,
      rawUrl: req.url,
      body,
      isBase64Encoded: false,
    });
    const out = new Headers();
    Object.entries(r.headers || {}).forEach(([k, v]) => out.append(k, String(v)));
    (r.multiValueHeaders && r.multiValueHeaders["Set-Cookie"] || []).forEach((c) => out.append("Set-Cookie", c));
    const noBody = [204, 205, 304].includes(r.statusCode);
    return new Response(noBody ? null : r.body || "", { status: r.statusCode, headers: out });
  };
};
