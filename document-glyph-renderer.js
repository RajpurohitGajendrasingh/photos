import {
  getDocumentGlyphRecord,
  getDocumentGlyphSpecimens,
} from "./document-glyph-store.js";

const SVG_NS = "http://www.w3.org/2000/svg";


function buildPixelPathFromMask(mask, width, height) {
  if (
    !mask ||
    mask.length !== width * height
  ) {
    return "";
  }

  const commands = [];

  for (let y = 0; y < height; y++) {
    let x = 0;

    while (x < width) {
      const index = y * width + x;

      if (mask[index] === 0) {
        x++;
        continue;
      }

      const startX = x;

      while (
        x < width &&
        mask[y * width + x] !== 0
      ) {
        x++;
      }

      const runWidth = x - startX;

      commands.push(
        `M${startX} ${y}h${runWidth}v1h-${runWidth}Z`
      );
    }
  }

  return commands.join("");
}


/**
 * Create an SVG containing the original shape
 * of one extracted document glyph.
 */
export function createDocumentGlyphSvg(
  character,
  {
    height = null,
    width = null,
    color = "#222222",
    specimenIndex = 0,
  } = {}
) {
  if (
    typeof character !== "string" ||
    character.length !== 1
  ) {
    return null;
  }

  const specimens =
    getDocumentGlyphSpecimens(character);

  if (!specimens.length) {
    console.warn(
      "[Glyph Renderer] No specimen found:",
      character
    );

    return null;
  }

  const specimen =
    specimens[specimenIndex] ?? specimens[0];

  const record =
    getDocumentGlyphRecord(specimen.glyphId);

  if (
    !record ||
    !record.hasPixelData ||
    record.status !== "complete"
  ) {
    console.warn(
      "[Glyph Renderer] Original glyph data unavailable:",
      specimen.glyphId
    );

    return null;
  }

  const sourceWidth = record.width;
  const sourceHeight = record.height;

  if (
    !sourceWidth ||
    !sourceHeight
  ) {
    return null;
  }

  // Prefer the exact pixel-cell path.
  // Fall back to the traced pixel boundary.
  // Finally, reconstruct the path directly from the mask.

  const pathData =
    record.pixelCellSvgPath ||
    record.pixelBoundaryContourSvgPath ||
    buildPixelPathFromMask(
      record.mask,
      sourceWidth,
      sourceHeight
    );

  if (!pathData) {
    console.warn(
      "[Glyph Renderer] No usable glyph path:",
      specimen.glyphId
    );

    return null;
  }

  const aspectRatio =
    sourceWidth / sourceHeight;

  const outputHeight =
    Number.isFinite(height) && height > 0
      ? height
      : sourceHeight;

  const outputWidth =
    Number.isFinite(width) && width > 0
      ? width
      : outputHeight * aspectRatio;

  const svg = document.createElementNS(
    SVG_NS,
    "svg"
  );

  svg.setAttribute(
    "xmlns",
    SVG_NS
  );

  svg.setAttribute(
    "viewBox",
    `0 0 ${sourceWidth} ${sourceHeight}`
  );

  svg.setAttribute(
    "width",
    String(outputWidth)
  );

  svg.setAttribute(
    "height",
    String(outputHeight)
  );

  svg.setAttribute(
    "preserveAspectRatio",
    "none"
  );

  svg.setAttribute(
    "role",
    "img"
  );

  svg.setAttribute(
    "aria-label",
    `Original document glyph ${character}`
  );

  svg.dataset.glyphId =
    specimen.glyphId;

  svg.dataset.character =
    character;

  svg.style.display =
    "inline-block";

  svg.style.verticalAlign =
    "baseline";

  svg.style.overflow =
    "visible";

  const path = document.createElementNS(
    SVG_NS,
    "path"
  );

  path.setAttribute(
    "d",
    pathData
  );

  path.setAttribute(
    "fill",
    color
  );

  path.setAttribute(
    "fill-rule",
    "evenodd"
  );

  path.setAttribute(
    "stroke",
    "none"
  );

  svg.appendChild(path);

  return svg;
}