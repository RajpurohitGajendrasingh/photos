
/**
 * src/ocr/paddle-editor-bridge.js
 *
 * Connects the existing PaddleOCR results to the existing
 * editable document-page renderer.
 *
 * Does not modify PaddleOCR or OpenCV measurement logic.
 */

import {
  loadDocument,
} from "../pdf/pdf-loader.js";

import {
  getPageById,
  setPageOCRStatus,
  setStatusMessage,
} from "../state.js";

import {
  renderDocumentPage,
  getRenderedPageById,
  refreshTextOverlay,
} from "../editor/page-editor.js";

import {
  buildPaddleTextBlocks,
} from "./paddle-document-adapter.js";

import {
  repairTextBlock,
} from "../editor/background-repair.js";

/* =========================================================
   WORKSPACE
   ========================================================= */

const STYLE_ID = "paddle-editor-bridge-styles";
const WORKSPACE_ID = "paddle-editor-workspace";

function ensureEditorWorkspace() {
  let workspace = document.getElementById(WORKSPACE_ID);

  if (workspace) {
    return {
      workspace,
      viewport: document.getElementById("paddle-editor-viewport"),
      pageContainer: document.getElementById("paddle-page-container"),
      status: document.getElementById("paddle-editor-status"),
      dimensions: document.getElementById("paddle-editor-dimensions"),
    };
  }

  const preview = document.getElementById("preview");

  if (!preview) {
    throw new Error(
      "The PaddleOCR preview element was not found."
    );
  }

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;

    style.textContent = `
      #${WORKSPACE_ID} {
        width: 100%;
        margin: 22px 0;
        padding: 12px;
        box-sizing: border-box;
        color: #202938;
        background: #f1f4f8;
        border: 1px solid #bdc7d4;
        border-radius: 8px;
      }

      #paddle-editor-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 10px;
        padding: 8px 4px 12px;
        font-family: Arial, sans-serif;
      }

      #paddle-editor-viewport {
        position: relative;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        width: 100%;
        height: min(78vh, 900px);
        min-height: 420px;
        padding: 22px;
        box-sizing: border-box;
        overflow: auto;
        background: #dce2ea;
        border: 1px solid #aeb8c6;
        border-radius: 5px;
      }

      #paddle-page-container {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        width: max-content;
        min-width: 0;
        min-height: 0;
        margin: 0 auto;
      }

      .document-page {
        position: relative;
        flex: 0 0 auto;
        overflow: hidden;
        background: #fff;
        box-shadow: 0 3px 14px rgba(0,0,0,0.25);
      }

      .page-background,
      .page-render-canvas,
      .page-image {
        position: absolute;
        inset: 0;
        display: block;
        width: 100%;
        height: 100%;
        margin: 0;
        padding: 0;
        border: 0;
        pointer-events: none;
        user-select: none;
      }

      .page-background {
        z-index: 0;
        object-fit: fill;
      }

      .page-object-layer,
      .ocr-layer {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
      }

      .page-object-layer {
        z-index: 2;
        overflow: hidden;
      }

      .ocr-layer {
        z-index: 3;
        overflow: visible;
        pointer-events: none;
      }

      .ocr-text-block {
        position: absolute;
        display: block;
        box-sizing: border-box;
        min-width: 1px;
        min-height: 1px;
        margin: 0;
        padding: 0;
        border: 1px solid transparent;
        background: transparent;
        line-height: 1;
        white-space: pre;
        overflow: visible;
        cursor: text;
        user-select: text;
        pointer-events: auto;
        transform-origin: left top;
      }

      .ocr-text-block:hover {
        outline: 1px solid rgba(40, 120, 245, 0.75);
        background: rgba(40, 120, 245, 0.06);
      }

      .ocr-text-block.selected {
        border-color: #2878f5;
        outline: 1px solid rgba(40, 120, 245, 0.35);
        background: rgba(40, 120, 245, 0.10);
      }

      .ocr-text-block:not(.modified):not(.editing) {
        color: transparent !important;
        -webkit-text-fill-color: transparent !important;
      }

   /*
 * Keep each replacement's sampled original ink color.
 * The text element's inline style.color is assigned by text-blocks.js.
 */
.ocr-text-block.editing {
  background: #fff;
  outline: 1px solid #2878f5;
}

/* After committing, reveal the repaired original background. */
.ocr-text-block.modified {
  background: transparent;
}

      #paddle-editor-status,
      #paddle-editor-dimensions {
        font: 13px/1.5 Arial, sans-serif;
        overflow-wrap: anywhere;
      }

      @media (max-width: 600px) {
        #paddle-editor-viewport {
          justify-content: flex-start;
          padding: 10px;
        }
      }
    `;

    document.head.appendChild(style);
  }

  workspace = document.createElement("section");
  workspace.id = WORKSPACE_ID;

  const toolbar = document.createElement("div");
  toolbar.id = "paddle-editor-toolbar";

  const title = document.createElement("strong");
  title.textContent = "PaddleOCR Editable Document";

  const dimensions = document.createElement("span");
  dimensions.id = "paddle-editor-dimensions";
  dimensions.textContent = "No page loaded";

  toolbar.append(title, dimensions);

  const status = document.createElement("div");
  status.id = "paddle-editor-status";
  status.textContent =
    "Choose an image and run PaddleOCR to create editable text.";

  const viewport = document.createElement("div");
  viewport.id = "paddle-editor-viewport";

  const pageContainer = document.createElement("div");
  pageContainer.id = "paddle-page-container";

  viewport.appendChild(pageContainer);
  workspace.append(toolbar, status, viewport);

  preview.insertAdjacentElement("beforebegin", workspace);

  return {
    workspace,
    viewport,
    pageContainer,
    status,
    dimensions,
  };
}


/* =========================================================
   REGISTER AND RENDER THE ORIGINAL IMAGE
   ========================================================= */

/**
 * Load the same selected image through the application's
 * normal document loader and render its original dimensions.
 */
export async function preparePaddleEditor(file, {
  zoom = 1,
} = {}) {
  if (!(file instanceof Blob) || file.size <= 0) {
    throw new Error("A valid image file is required.");
  }

  const ui = ensureEditorWorkspace();

  ui.status.textContent = "Loading original document image...";

  const loaded = await loadDocument(file);

  if (loaded.type !== "image") {
    throw new Error(
      "The PaddleOCR editor currently expects an image document."
    );
  }

  const page = loaded.pages[0];

  if (!page) {
    throw new Error("No image page was created.");
  }

  ui.pageContainer.replaceChildren();

  const renderedPage = await renderDocumentPage({
    container: ui.pageContainer,
    page,
    pdfDocument: null,
    zoom,
  });

  if (!renderedPage) {
    throw new Error(
      "The image page rendering was superseded."
    );
  }

  const registeredPage = getPageById(page.id);

  if (!registeredPage) {
    throw new Error(
      "The image page was not registered in application state."
    );
  }

  const image = renderedPage.backgroundElement;

 const dimensionDiagnostics = {
  isImageElement: image instanceof HTMLImageElement,

  imageNaturalWidth: Number(image?.naturalWidth),
  imageNaturalHeight: Number(image?.naturalHeight),

  pageWidth: Number(registeredPage.width),
  pageHeight: Number(registeredPage.height),

  pageSourceWidth: Number(registeredPage.sourceWidth),
  pageSourceHeight: Number(registeredPage.sourceHeight),

  renderedSourceWidth: Number(renderedPage.sourceWidth),
  renderedSourceHeight: Number(renderedPage.sourceHeight),

  ocrScaleX: Number(renderedPage.ocrScaleX),
  ocrScaleY: Number(renderedPage.ocrScaleY),
};

console.log(
  "[PADDLE EDITOR] IMAGE DIMENSION DIAGNOSTICS:",
  dimensionDiagnostics
);

if (
  !dimensionDiagnostics.isImageElement ||
  !Number.isFinite(dimensionDiagnostics.imageNaturalWidth) ||
  !Number.isFinite(dimensionDiagnostics.imageNaturalHeight) ||
  Math.abs(
    dimensionDiagnostics.imageNaturalWidth -
    dimensionDiagnostics.pageSourceWidth
  ) > 0.5 ||
  Math.abs(
    dimensionDiagnostics.imageNaturalHeight -
    dimensionDiagnostics.pageSourceHeight
  ) > 0.5
) {
  throw new Error(
    "Image dimension validation failed. Check console diagnostics."
  );
}

  ui.dimensions.textContent =
    `${registeredPage.sourceWidth} × ${registeredPage.sourceHeight} source pixels`;

  ui.status.textContent =
    "Original image loaded. Ready for PaddleOCR.";

  setStatusMessage(
    "PaddleOCR document image loaded."
  );

  return {
    page: registeredPage,
    renderedPage,
  };
}


/* =========================================================
   CONVERT AND DISPLAY PADDLEOCR RESULTS
   ========================================================= */

/**
 * Convert the completed PaddleOCR + OpenCV result into
 * editable text blocks and render them on the original image.
 *
 * result must contain:
 * {
 *   imageWidth,
 *   imageHeight,
 *   items
 * }
 */
export function applyPaddleOCRToEditor({
  result,
  pageId,
} = {}) {
  if (!pageId) {
    throw new Error("A page ID is required.");
  }

  const page = getPageById(pageId);

  if (!page) {
    throw new Error(
      "The registered PaddleOCR page could not be found."
    );
  }

  const renderedPage = getRenderedPageById(pageId);

  if (!renderedPage) {
    throw new Error(
      "The original image must be rendered before applying OCR."
    );
  }

  if (
    !Array.isArray(result?.items) ||
    !Number.isFinite(Number(result.imageWidth)) ||
    !Number.isFinite(Number(result.imageHeight))
  ) {
    throw new Error(
      "The PaddleOCR result has an invalid image size or items array."
    );
  }

  const expectedWidth =
    page.sourceWidth * Number(renderedPage.ocrScaleX ?? 1);

  const expectedHeight =
    page.sourceHeight * Number(renderedPage.ocrScaleY ?? 1);

  if (
    Math.abs(Number(result.imageWidth) - expectedWidth) > 0.5 ||
    Math.abs(Number(result.imageHeight) - expectedHeight) > 0.5
  ) {
    throw new Error(
      `OCR and editor dimensions do not match. ` +
      `OCR: ${result.imageWidth} × ${result.imageHeight}; ` +
      `expected: ${expectedWidth} × ${expectedHeight}.`
    );
  }

  const adapted = buildPaddleTextBlocks({
    result,
    page,
    renderedPage,
  });

  // Replace the OCR blocks from the previous run.
  // This page belongs to the dedicated PaddleOCR workflow.
  page.textBlocks = adapted.textBlocks;

  setPageOCRStatus(pageId, {
    status: "completed",
    progress: 100,
    message:
      `PaddleOCR complete: ${adapted.createdLines} editable lines.`,
  });

  const elements = refreshTextOverlay({
    pageId,
    container: renderedPage.container,
  });

  const ui = ensureEditorWorkspace();

  ui.status.textContent =
    `Editable OCR lines: ${adapted.createdLines} / ${adapted.totalLines}. ` +
    `Measured lines: ${adapted.measuredLines}. ` +
    `Character records: ${adapted.totalCharacterRecords}.`;

  setStatusMessage(
    `Created ${adapted.createdLines} editable PaddleOCR text blocks.`
  );

  return {
    ...adapted,
    renderedElementCount: elements.length,
  };
}

const pendingBackgroundRepairs = new Set();

document.addEventListener(
  "ocr-text-committed",
  async (event) => {
    const {
      pageId,
      objectId,
    } = event.detail || {};

    if (!pageId || !objectId) {
      return;
    }

    const page = getPageById(pageId);

    if (!page) {
      return;
    }

    const block = page.textBlocks.find(
      (item) => item.id === objectId
    );

    if (!block) {
      return;
    }

    const renderedPage = getRenderedPageById(pageId);

    if (!renderedPage?.textLayer) {
      return;
    }

    const element = Array.from(
      renderedPage.textLayer.querySelectorAll(
        ".ocr-text-block"
      )
    ).find(
      (item) => item.dataset.objectId === objectId
    );

    // Keep the edited replacement visible in the original sampled ink color.
    if (element) {
      const replacementColor =
        block.style?.color ||
        element.style.color ||
        "#000000";

      element.classList.add("modified");
      element.style.color = replacementColor;
      element.style.webkitTextFillColor = replacementColor;
    }

    // Only OCR-generated text needs original-background repair.
    const isOCRBlock =
      block.origin === "ocr-engine" ||
      block.source === "ocr";

    if (!isOCRBlock) {
      return;
    }

    // Do not create another patch for the same original text.
    page.repairPatches ??= [];

    const existingPatch = page.repairPatches.find(
      (patch) => patch.textBlockId === objectId
    );

    if (existingPatch) {
      setStatusMessage(
        "Text edited. Existing background repair preserved."
      );
      return;
    }

    const repairKey = `${pageId}:${objectId}`;

    if (pendingBackgroundRepairs.has(repairKey)) {
      return;
    }

    pendingBackgroundRepairs.add(repairKey);

    try {
      setStatusMessage(
        `Repairing original background for "${block.text}"...`
      );

      const patch = await repairTextBlock({
        page,
        renderedPage,
        textBlockId: objectId,
      });

      if (!patch) {
        throw new Error(
          "Background repair did not produce a patch."
        );
      }

      setStatusMessage(
        `Text edited and background repaired: "${block.text}".`
      );

      console.log(
        "[Paddle Editor] Background repair completed:",
        {
          pageId,
          objectId,
          patchId: patch.id,
          repairedPixelCount: patch.repairedPixelCount,
          method: patch.method,
          bounds: patch.bounds,
        }
      );

    } catch (error) {
      console.error(
        "[Paddle Editor] Background repair failed:",
        error
      );

      // Keep the user's text edit even when repair fails.
      setStatusMessage(
        `Text saved, but background repair failed: ${error.message}`
      );

    } finally {
      pendingBackgroundRepairs.delete(repairKey);
    }
  }
);