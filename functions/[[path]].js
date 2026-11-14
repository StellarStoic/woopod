// Cloudflare Pages catches every address here, so /p, /p/, /c and /c/ all reach the same handler
// without depending on how the platform treats trailing slashes. Anything else is passed straight
// through to the static site.
export { onRequest } from "../server/route.mjs";
