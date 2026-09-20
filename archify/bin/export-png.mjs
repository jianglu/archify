// Direct PNG export: renders an HTML artifact in headless Chrome, asks the
// embedded viewer for a rasterized diagram (Archify.exportMenu.renderRaster),
// and writes the decoded bytes to disk. Theme, background transparency, and
// scale are caller-controlled; the artifact itself stays the single source of
// diagram geometry and styling.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChromeVisualBrowser, findChrome } from './visual-check.mjs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DATA_URL_PREFIX = 'data:image/png;base64,';

const VIEWPORT = { width: 1440, height: 1000 };

async function evaluate(cdp, sessionId, expression, awaitPromise = false, timeoutMs) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  }, sessionId, timeoutMs);
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description
      || response.exceptionDetails.text
      || 'Runtime.evaluate failed');
  }
  return response.result?.value;
}

function decodeDataUrl(dataUrl, expectedPrefix) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(expectedPrefix)) {
    throw new Error('Raster export returned an unexpected payload (missing data URL).');
  }
  return Buffer.from(dataUrl.slice(expectedPrefix.length), 'base64');
}

function assertPngSignature(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Exported bytes are not a valid PNG (bad signature).');
  }
}

// Mirrors the stability sequence visual-check uses before it measures or
// captures: motion parked, fonts loaded, both layout stabilizers settled,
// then two animation frames.
const STABILITY_EXPRESSION = `(function () {
  document.documentElement.setAttribute('data-motion', 'still');
  var fontsReady = document.fonts && document.fonts.ready
    ? document.fonts.ready.catch(function () {})
    : Promise.resolve();
  var settle = function () {
    var chain = Promise.resolve();
    if (window.Archify && Archify.readerLayout && typeof Archify.readerLayout.whenStable === 'function') {
      chain = chain.then(function () { return Archify.readerLayout.whenStable(); });
    }
    if (window.Archify && Archify.viewerChromeLayout && typeof Archify.viewerChromeLayout.whenStable === 'function') {
      chain = chain.then(function () { return Archify.viewerChromeLayout.whenStable(); });
    }
    return chain.then(function () {
      return new Promise(function (resolve) {
        requestAnimationFrame(function () { requestAnimationFrame(resolve); });
      });
    });
  };
  return fontsReady.then(function () { return settle(); });
})()`;

export async function runExportPng({
  artifactPath,
  outputPath,
  theme = 'dark',
  transparent = false,
  scale,
  loadTimeoutMs = 30000,
}) {
  if (!fs.existsSync(artifactPath)) throw new Error(`Artifact not found: ${artifactPath}`);
  const chromePath = findChrome();
  if (!chromePath) {
    throw new Error('No Chrome/Chromium executable found. Install Google Chrome or set ARCHIFY_CHROME.');
  }

  const rasterOptions = {
    format: 'png',
    transparent: transparent === true,
    ...(Number.isFinite(scale) && scale >= 1 ? { scale } : {}),
  };

  const browser = new ChromeVisualBrowser(chromePath);
  try {
    const sessionId = await browser.sessionPromise;
    await browser.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId);

    const url = new URL(pathToFileURL(artifactPath).href);
    url.searchParams.set('theme', theme);
    const loaded = browser.cdp.waitFor('Page.loadEventFired', sessionId);
    const navigation = await browser.cdp.send('Page.navigate', { url: url.href }, sessionId, loadTimeoutMs);
    if (navigation.errorText) throw new Error(`Chrome navigation failed: ${navigation.errorText}`);
    await loaded;
    await evaluate(browser.cdp, sessionId, STABILITY_EXPRESSION, true);

    const raster = await evaluate(browser.cdp, sessionId, `(function () {
      if (!window.Archify || !Archify.exportMenu || typeof Archify.exportMenu.renderRaster !== 'function') {
        throw new Error('Artifact does not expose Archify.exportMenu.renderRaster; regenerate the HTML with an updated archify template.');
      }
      return Archify.exportMenu.renderRaster(${JSON.stringify(rasterOptions)});
    })()`, true, loadTimeoutMs);
    if (!raster || typeof raster.dataUrl !== 'string') {
      throw new Error('Raster export did not return image data.');
    }

    const bytes = decodeDataUrl(raster.dataUrl, DATA_URL_PREFIX);
    assertPngSignature(bytes);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, bytes);

    return {
      outputPath,
      bytes: bytes.length,
      width: raster.width,
      height: raster.height,
      scale: raster.scale,
      theme: raster.theme || theme,
      transparent: raster.transparent === true,
    };
  } finally {
    await browser.close();
  }
}
