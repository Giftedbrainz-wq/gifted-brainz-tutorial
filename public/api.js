/* ------------------------------------------------------------------
   Gifted Brainz Tutorial — API client.

   Why this file is defensive: the portal runs on serverless functions, so
   transient gateway failures and mobile-network drops can happen. Requests
   use a bounded timeout and retry only transient gateway errors. Structured
   API errors (including storage/configuration failures) are surfaced directly
   instead of being mislabeled as a generic server wake-up.
------------------------------------------------------------------- */
window.GB = (() => {
  const tokenKey = "gbToken";
  const token = () => { try { return localStorage.getItem(tokenKey) || ""; } catch { return ""; } };

  const esc = v => String(v ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const TIMEOUT = 20000;      // allow a cold serverless start to finish
  const RETRIES = 3;          // retry brief gateway/serverless wake-up failures
  const wait = ms => new Promise(r => setTimeout(r, ms));

  class NetworkError extends Error {}

  async function once(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      return await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
    } catch (e) {
      // Aborts, DNS failures and dropped connections all land here.
      throw new NetworkError(
        e && e.name === "AbortError"
          ? "The server is taking too long to respond. Please try again."
          : "Could not reach the Gifted Brainz server. Check your internet connection and try again."
      );
    } finally { clearTimeout(timer); }
  }

  const api = async (url, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (token()) headers.Authorization = `Bearer ${token()}`;

    let lastError = null;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      if (attempt) await wait(350 * attempt);
      let r;
      try {
        r = await once(url, { ...options, headers });
      } catch (e) { lastError = e; continue; }

      // Distinguish a transient gateway failure from a function that is
      // actually running and returning a structured 503 (for example, a
      // missing production storage configuration). The old code treated every
      // 503 as a generic "server is waking up" message, which hid the real
      // cause and made diagnosis unnecessarily difficult.
      let data = {};
      const type = r.headers.get("content-type") || "";
      if ([502, 504, 522, 524].includes(r.status)) {
        lastError = new NetworkError("The server is temporarily unavailable. Retrying automatically…");
        continue;
      }
      if (r.status === 503 && type.includes("application/json")) {
        try { data = await r.json(); } catch { data = {}; }
        // A structured 503 is an intentional API response (for example a
        // missing production storage configuration), not a cold-start signal.
        // Do not spend three more round trips retrying a deterministic error.
        throw Error(data.error || "The server is temporarily unavailable. Please check diagnostics.");
      }

      if (r.status === 503) {
        throw Error("The server is temporarily unavailable. Open /diagnostics.html for details.");
      }

      if (type.includes("application/json")) {
        try { data = await r.json(); } catch { data = {}; }
      } else {
        // Anything that is not JSON on an /api/ route means the request never
        // reached the API function: the host answered with a web page instead.
        // The usual cause is a deploy that published the static files but not
        // the serverless function (a drag-and-drop deploy does not build
        // functions), in which case /api/* falls through to the 404 page or to
        // the single-page fallback. Reporting that plainly — on a 200 as well
        // as on an error — stops a broken deploy from looking like a wrong
        // password, and stops a fallback page from being mistaken for a
        // successful login.
        const text = await r.text().catch(() => "");
        const looksLikeHtml = text.trim().startsWith("<");
        if (looksLikeHtml || !r.ok) {
          data = {
            error: looksLikeHtml
              ? "The API is not responding on this site: the server returned a web page instead of data. The serverless function was not published with this deploy. Open /diagnostics.html for details."
              : (text || "Request failed."),
            apiMissing: looksLikeHtml
          };
          if (looksLikeHtml) throw Error(data.error);
        }
      }

      if (r.status === 401) {
        try {
          localStorage.removeItem(tokenKey);
          localStorage.removeItem("gbAdminToken");
          localStorage.removeItem("gbUser");
        } catch {}
        const path = location.pathname;
        // Say why the student is back on the sign-in screen. Without this the
        // bounce looks exactly like "the login page just refreshed".
        if (!path.endsWith("login.html") && !path.endsWith("admin.html") && !path.endsWith("register.html") && path !== "/")
          location = "/login.html?session=expired";
      }
      if (!r.ok) throw Error(data.error || `Request failed (${r.status}).`);
      return data;
    }
    throw lastError || new NetworkError("Could not reach the Gifted Brainz server. Please try again.");
  };

  // Used by the sign-in screens to say precisely what is wrong.
  const health = async () => {
    try { const r = await once("/api/health", { method: "GET" }); return r.ok; }
    catch { return false; }
  };

  const logout = () => {
    try {
      localStorage.removeItem("gbToken");
      localStorage.removeItem("gbAdminToken");
      localStorage.removeItem("gbUser");
    } catch {}
    location = "/";
  };

  // Phones frequently report an empty MIME type for camera videos, so the
  // extension is sent along and the server works the real type out.
  const guessType = name => {
    const e = String(name || "").toLowerCase().split(".").pop();
    return ({ mp4: "video/mp4", m4v: "video/x-m4v", mov: "video/quicktime", webm: "video/webm",
      "3gp": "video/3gpp", mkv: "video/x-matroska", avi: "video/x-msvideo",
      mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", aac: "audio/aac",
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
      pdf: "application/pdf" }[e]) || "";
  };


  const upload = async (file, onProgress) => {
    if (!file) return {};
    const report=(v)=>{ if(onProgress) onProgress(v); };
    report(0);
    try{
      const contentType = file.type || guessType(file.name);
      const init = await api("/api/admin/upload/init", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, contentType, size: file.size, chunkSize: 2 * 1024 * 1024 })
      });
      const CHUNK = Math.max(256 * 1024, Number(init.chunkSize) || 1024 * 1024);
      let index = 0, sent = 0;
      for (let off = 0; off < file.size; off += CHUNK, index++) {
        const bytes = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
        let binary = ""; const step = 0x8000;
        for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
        await api("/api/admin/upload/chunk", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uploadId: init.uploadId, index, data: btoa(binary) })
        });
        sent += bytes.length;
        report(Math.min(98, Math.round(sent / Math.max(1, file.size) * 98)));
      }
      const done = await api("/api/admin/upload/complete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId: init.uploadId, parts: index })
      });
      report(100);
      return { ...done, contentType: done.contentType || contentType, size: file.size };
    }catch(err){
      throw err;
    }
  };
  // Browser navigations (downloads, embedded viewers) cannot send an
  // Authorization header, so the signed token travels as a query parameter.
  const fileUrl = (url, opts = {}) => {
    if (!url) return "";
    const u = new URL(url, location.origin);
    if (token()) u.searchParams.set("token", token());
    if (opts.inline) u.searchParams.set("inline", "1");
    return u.pathname + u.search;
  };

  const download = (url, fileName) => {
    if (!url) return;
    const a = document.createElement("a");
    a.href = fileUrl(url); a.download = fileName || ""; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
  };

  const del = url => api(url, { method: "DELETE" });

  return { api, esc, token, logout, upload, fileUrl, download, del, health };
})();
