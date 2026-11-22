const CANONICAL_ORIGIN = "https://www.morbohub.com";

function isPagesDevHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "morbohub.pages.dev" || host.endsWith(".morbohub.pages.dev");
}

export async function onRequest(context) {
  const current = new URL(context.request.url);
  if (!isPagesDevHost(current.hostname)) return context.next();
  const dest = new URL(current.pathname + current.search, CANONICAL_ORIGIN);
  return Response.redirect(dest.toString(), 301);
}
