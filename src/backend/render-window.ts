import { readFileSync } from 'fs';
import { join } from 'path';
import type { PluginAPI, AuthWindowHelpers, MermaidLook, MermaidCurve, Engine } from '../shared/types.js';

export type RenderSpec = {
  engine: Engine;
  source: string;
  format: 'png' | 'svg';
  look?: MermaidLook;
  curve?: MermaidCurve;
  isDark?: boolean;
  resolveSystemDark?: boolean;
  /** For forced styles (neo/plain): strip source %%{init}%% theme/look overrides. */
  lockStyle?: boolean;
  scale?: number;
  width?: number;
  height?: number;
};

type RenderJsResult =
  | { ok: true; mediaType: string; base64: string }
  | { ok: false; error: string };

let renderJsCache: string | null = null;

function loadRenderJs(api: PluginAPI): string {
  if (renderJsCache !== null) return renderJsCache;
  // render.js is emitted next to backend.js in the plugin's install dir.
  const path = join(api.pluginDir, 'render.js');
  renderJsCache = readFileSync(path, 'utf-8');
  return renderJsCache;
}

/**
 * Render a visualization to image bytes inside a hidden Chromium window.
 *
 * We reuse the host's `auth:window` capability purely as an off-screen browser:
 * open it hidden, inject the render bundle, call `__vizRender`, and read the
 * base64 straight off the `executeJavaScript` return value (so large images
 * never have to travel through a callback URL). Nothing is shown to the user.
 */
export async function renderViaHiddenWindow(
  api: PluginAPI,
  spec: RenderSpec,
  abortSignal?: AbortSignal,
): Promise<{ mediaType: string; base64: string }> {
  if (abortSignal?.aborted) throw new Error('Export cancelled.');
  if (!api.auth?.openAuthWindow) {
    throw new Error(
      'Background rendering is unavailable: this host build does not expose the auth:window capability.',
    );
  }

  let renderJs: string;
  try {
    renderJs = loadRenderJs(api);
  } catch (e) {
    throw new Error(
      `Could not load render bundle (render.js): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Minimal dark page. A strict CSP blocks the network fetches the diagram
  // source might try to trigger (mermaid/chart.js honor source-controlled
  // image/CSS URLs) — only inline/data/blob resources are allowed, so the
  // hidden renderer can't be turned into an SSRF/tracking beacon. img-src keeps
  // data:/blob: for the SVG→canvas rasterization round-trip.
  //
  // (We intentionally do NOT add a `sandbox` directive: `sandbox allow-scripts`
  // forces an opaque origin that taints the canvas and breaks toDataURL()/blob
  // rasterization — the core of this feature.)
  //
  // ACCEPTED RESIDUAL RISK: the diagram author is normally the user themselves.
  // A determined attacker who fully controls the mermaid source could craft
  // output that attempts to fetch when the *exported SVG file* is later opened
  // in a permissive external viewer (outside this CSP). The SVG sanitizer scrubs
  // the common url()/@import/image-set cases but is not a hardened CSS parser.
  // We do not model diagram source as a sandbox-escape adversary; see README.
  const csp =
    "default-src 'none'; " +
    "script-src 'unsafe-inline' 'unsafe-eval'; " +
    "style-src 'unsafe-inline'; " +
    "img-src data: blob:; " +
    "font-src data:; " +
    "connect-src 'none'";
  const html =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<style>html,body{margin:0;background:#020617}</style></head><body></body></html>`;
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

  return await new Promise<{ mediaType: string; base64: string }>((resolve, reject) => {
    let done = false;
    let injected = false;
    const finishOk = (v: { mediaType: string; base64: string }, helpers: AuthWindowHelpers) => {
      if (done) return;
      done = true;
      try { helpers.close(); } catch { /* ignore */ }
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      resolve(v);
    };
    const finishErr = (err: Error, helpers?: AuthWindowHelpers) => {
      if (done) return;
      done = true;
      try { helpers?.close(); } catch { /* ignore */ }
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      reject(err);
    };
    // Tear the hidden window down promptly if the agent is cancelled, instead
    // of leaving it running until the 30s host timeout.
    let helpersRef: AuthWindowHelpers | undefined;
    const onAbort = () => finishErr(new Error('Export cancelled.'), helpersRef);
    if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });

    const injectAndRender = async (helpers: AuthWindowHelpers) => {
      // The host calls onReady BEFORE it navigates to our data URL, so the
      // initial context is about:blank; injecting there would be wiped by the
      // pending navigation. Wait until the document has actually loaded our
      // page (readyState complete + our CSP meta present) before injecting.
      try {
        const deadline = Date.now() + 15_000;
        for (;;) {
          if (done) return;
          const ready = (await helpers.executeJavaScript(
            `(document.readyState === 'complete' || document.readyState === 'interactive') && location.protocol === 'data:'`,
          )) as boolean;
          if (ready) break;
          if (Date.now() > deadline) {
            finishErr(new Error('Render page did not finish loading in time.'), helpers);
            return;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        // Define __vizRender in the page. executeJavaScript structured-clones
        // the script's completion value back to the main process; the bundle's
        // last expression could be a function (not cloneable → "could not be
        // cloned"), so force a cloneable completion value with a trailing `;0`.
        await helpers.executeJavaScript(`${renderJs}\n;0;`);
        // Invoke it; executeJavaScript resolves with the returned value.
        const call = `window.__vizRender(${JSON.stringify(spec)})`;
        const raw = (await helpers.executeJavaScript(call)) as RenderJsResult | undefined;
        if (!raw || typeof raw !== 'object') {
          finishErr(new Error('Renderer returned no result.'), helpers);
          return;
        }
        if (raw.ok) {
          finishOk({ mediaType: raw.mediaType, base64: raw.base64 }, helpers);
        } else {
          finishErr(new Error(raw.error || 'Render failed.'), helpers);
        }
      } catch (e) {
        finishErr(e instanceof Error ? e : new Error(String(e)), helpers);
      }
    };

    void api
      .auth!.openAuthWindow({
        url,
        title: 'Visualization export',
        width: 1200,
        height: 800,
        showOnCreate: false,
        timeoutMs: 30_000,
        onReady: (helpers) => {
          helpersRef = helpers;
          // Trigger injection once the window navigates to our data URL. Guard
          // so redirect/navigate events (which can fire more than once) only
          // kick off a single injection.
          const start = () => {
            if (injected || done) return;
            injected = true;
            void injectAndRender(helpers);
          };
          helpers.onDidNavigate(() => start());
        },
      })
      // The auth promise settles when we close the window (a "Closed by plugin"
      // failure we intentionally ignore) or on timeout. Only surface a timeout
      // if we haven't already resolved with an image.
      .then((res) => {
        if (!done) {
          finishErr(new Error(res.error || 'Rendering timed out before completing.'));
        }
      })
      .catch((e) => finishErr(e instanceof Error ? e : new Error(String(e))));
  });
}
