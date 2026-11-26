
/**
 * src/ocr/glyph-graphics/glyph-svg-exporter.js
 *
 * Exports extracted OCR glyphs as standalone SVG files.
 *
 * Primary source:
 *   pixelBoundaryContourSvgPath
 *
 * The exported SVG preserves:
 *   - Original glyph width and height
 *   - Pixel-boundary geometry
 *   - Internal holes using even-odd filling
 *   - Original glyph-local coordinate system
 *
 * Does not modify OCR data or extraction results.
 */

const DEFAULT_FILL = "#111111";

/* -------------------------------------------------------
   1. XML HELPERS
------------------------------------------------------- */

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* -------------------------------------------------------
   2. VALIDATE GLYPH
------------------------------------------------------- */

function validateGlyph(glyph) {
  if (!glyph || typeof glyph !== "object") {
    throw new Error("A valid extracted glyph is required.");
  }

  if (
    glyph.status &&
    glyph.status !== "complete"
  ) {
    throw new Error(
      `Cannot export glyph with status: ${glyph.status}`
    );
  }

  const width = Number(glyph.width);
  const height = Number(glyph.height);

  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error("Invalid glyph dimensions.");
  }

  const path = glyph.pixelBoundaryContourSvgPath;

  if (
    typeof path !== "string" ||
    !path.trim()
  ) {
    throw new Error(
      "The glyph does not contain a pixel-boundary SVG path."
    );
  }

  if (
    Number(glyph.pixelBoundaryIncompleteLoopCount || 0) > 0 ||
    Number(glyph.pixelBoundaryUntracedEdgeCount || 0) > 0
  ) {
    throw new Error(
      "Glyph boundary integrity check failed. SVG export cancelled."
    );
  }

  if (
    glyph.mask &&
    glyph.mask.length !== width * height
  ) {
    throw new Error(
      "Glyph mask dimensions do not match its SVG dimensions."
    );
  }

  return {
    width,
    height,
    path,
  };
}

/* -------------------------------------------------------
   3. CREATE SVG SOURCE
------------------------------------------------------- */

/**
 * Create a standalone SVG string from an extracted glyph.
 *
 * Options:
 *   fill: foreground colour
 *   background: optional background colour
 *   title: optional SVG title
 *
 * Example:
 *
 * const svg = createGlyphSvg(glyph);
 */

export function createGlyphSvg(
  glyph,
  {
    fill = DEFAULT_FILL,
    background = null,
    title = null,
  } = {}
) {
  const {
    width,
    height,
    path,
  } = validateGlyph(glyph);

  const glyphTitle = escapeXml(
    title || `Glyph ${glyph.text || ""}`
  );

  const safeFill = escapeXml(fill);

  const backgroundMarkup = background
    ? `<rect width="${width}" height="${height}" fill="${escapeXml(background)}"/>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="${width}"
  height="${height}"
  viewBox="0 0 ${width} ${height}"
  version="1.1"
  role="img"
  aria-label="${glyphTitle}"
>
  <title>${glyphTitle}</title>

  ${backgroundMarkup}

  <path
    d="${escapeXml(path)}"
    fill="${safeFill}"
    fill-rule="evenodd"
    clip-rule="evenodd"
  />
</svg>`;
}

/* -------------------------------------------------------
   4. GENERATE SAFE FILE NAME
------------------------------------------------------- */

export function getGlyphSvgFilename(glyph) {
  const index = Number.isInteger(Number(glyph?.index))
    ? glyph.index
    : "unknown";

  const character = String(
    glyph?.text || "glyph"
  );

  const slug = character
    .normalize("NFKD")
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);

  return `glyph-${index}-${slug || "shape"}.svg`;
}

/* -------------------------------------------------------
   5. DOWNLOAD SVG
------------------------------------------------------- */

/**
 * Download an extracted glyph as an SVG file.
 *
 * This function only creates a file from existing
 * glyph data. It does not modify the original glyph.
 */

export function downloadGlyphSvg(
  glyph,
  options = {}
) {
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof Blob === "undefined"
  ) {
    throw new Error(
      "SVG downloading is unavailable in this environment."
    );
  }

  const svg = createGlyphSvg(glyph, options);

  const blob = new Blob(
    [svg],
    {
      type: "image/svg+xml;charset=utf-8",
    }
  );

  const url = URL.createObjectURL(blob);

  const filename =
    options.fileName || getGlyphSvgFilename(glyph);

  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  link.style.display = "none";

  document.body.appendChild(link);

  try {
    link.click();
  } finally {
    link.remove();

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  return {
    status: "download-triggered",
    filename,
    width: glyph.width,
    height: glyph.height,
    pathLength:
      glyph.pixelBoundaryContourSvgPath.length,
  };
}
