// Canonical Netlify Function entry point.
// The .mjs filename is intentionally kept because the admin update validator
// and Netlify's ESM function discovery expect this path in deployment packages.
import handler, { config } from "./api-core.mjs";

export { config };
export default handler;
