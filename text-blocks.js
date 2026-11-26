
/**
 * src/editor/text-blocks.js
 *
 * Renders OCR text models as interactive text overlays.
 *
 * Features:
 * - Render text using source-page coordinates.
 * - Scale overlays to match the displayed page.
 * - Select text blocks with a single click.
 * - Edit text with a double-click.
 * - Drag text blocks to new positions.
 * - Save edits in the shared application state.
 * - Keep model coordinates stable when the page is zoomed.
 *
 * Background repair is handled by a separate module.
 * Therefore, old scanned lettering may still be visible beneath
 * a replacement until a repair patch is applied.
 */

import {
  getPageById,
  setSelection,
  updatePageObject,
} from "../state.js";


/* =========================================================
   HELPERS
   ========================================================= */

/**
 * Get an object's rectangle.
 *
 * OCR-generated objects contain x/y/width/height and bounds.
 * The fallback also supports manually created text blocks.
 */
function getTextBounds(block) {
  const bounds = block.bounds || {
    x: block.x,
    y: block.y,
    width: block.width,
    height: block.height,
  };

  const result = {
    x: Number(bounds.x),
    y: Number(bounds.y),
    width: Number(bounds.width),
    height: Number(bounds.height),
  };

  if (!Object.values(result).every(Number.isFinite)) {
    throw new Error(
      `Text block ${block.id} has invalid coordinates.`
    );
  }

  return result;
}

function getPageSourceDimensions(page, renderedPage) {
  const pageElement = renderedPage?.pageElement;

  const backgroundImage =
    pageElement?.matches?.("img.page-background")
      ? pageElement
      : pageElement?.querySelector?.("img.page-background");

  const width = [
    renderedPage?.sourceWidth,
    page?.sourceWidth,
    page?.width,
    backgroundImage?.naturalWidth,
  ]
    .map(Number)
    .find(
      (value) =>
        Number.isFinite(value) && value > 0
    );

  const height = [
    renderedPage?.sourceHeight,
    page?.sourceHeight,
    page?.height,
    backgroundImage?.naturalHeight,
  ]
    .map(Number)
    .find(
      (value) =>
        Number.isFinite(value) && value > 0
    );

  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    throw new Error(
      "Cannot render text: invalid page dimensions."
    );
  }

  return { width, height };
}

/**
 * Calculate the scale between source coordinates and displayed
 * page coordinates.
 *
 * This deliberately uses the page element's actual CSS size.
 * It does not use the viewport's scroll offsets.
 */
function getDisplayScale(
  pageElement,
  sourceWidth,
  sourceHeight
) {
  const displayWidth = pageElement.clientWidth;
  const displayHeight = pageElement.clientHeight;

  if (
    displayWidth <= 0 ||
    displayHeight <= 0
  ) {
    throw new Error(
      "The document page has no visible dimensions."
    );
  }

  return {
    x: displayWidth / sourceWidth,
    y: displayHeight / sourceHeight,
  };
}

/**
 * Apply the visual properties stored on a text model.
 */
function applyTextStyle(element, block, scaleX, scaleY) {
  const style = block.style || {};
  const bounds = getTextBounds(block);

  const estimatedFontSize = Number(
    style.fontSize || bounds.height * 0.82
  );

  const fontSize = Number.isFinite(estimatedFontSize)
    ? Math.max(1, estimatedFontSize * scaleY)
    : Math.max(1, bounds.height * scaleY * 0.82);

  element.style.left = `${bounds.x * scaleX}px`;
  element.style.top = `${bounds.y * scaleY}px`;

  element.style.width =
    `${Math.max(1, bounds.width * scaleX)}px`;

  element.style.height =
    `${Math.max(1, bounds.height * scaleY)}px`;

  element.style.fontSize = `${fontSize}px`;

  element.style.fontFamily =
    style.fontFamily || "Arial, sans-serif";

  element.style.fontWeight =
    String(style.fontWeight || 400);

  element.style.fontStyle =
    style.fontStyle || "normal";

  element.style.color =
    style.color || "#000000";

  element.style.lineHeight = "1";
  element.style.textAlign = style.textAlign || "left";

  element.style.whiteSpace = "pre";
  element.style.boxSizing = "border-box";
const letterSpacing = Number(
  style.letterSpacing ?? 0
);

const wordSpacing = Number(
  style.wordSpacing ?? 0
);

element.style.letterSpacing =
  `${(Number.isFinite(letterSpacing) ? letterSpacing : 0) * scaleX}px`;

element.style.wordSpacing =
  `${(Number.isFinite(wordSpacing) ? wordSpacing : 0) * scaleX}px`;
// -----------------------------------------------
// Apply independent horizontal and vertical stretch
// -----------------------------------------------

const requestedScaleX = Number(
  style.textScaleX ?? 1
);

const requestedScaleY = Number(
  style.textScaleY ?? 1
);

const textScaleX = Number.isFinite(requestedScaleX)
  ? Math.max(0.5, Math.min(2, requestedScaleX))
  : 1;

const textScaleY = Number.isFinite(requestedScaleY)
  ? Math.max(0.5, Math.min(2, requestedScaleY))
  : 1;

element.style.transformOrigin = "left top";

element.style.transform =
  Math.abs(textScaleX - 1) < 0.001 &&
  Math.abs(textScaleY - 1) < 0.001
    ? "none"
    : `scale(${textScaleX}, ${textScaleY})`;

}


/* =========================================================
   SELECTION
   ========================================================= */

/**
 * Select a text block and update shared application state.
 */
export function selectTextBlock(
  element,
  textLayer,
  pageId,
  objectId
) {
  textLayer.querySelectorAll(".ocr-text-block").forEach(
    (otherElement) => {
      otherElement.classList.remove("selected");
      otherElement.setAttribute("aria-selected", "false");
    }
  );

  element.classList.add("selected");
  element.setAttribute("aria-selected", "true");

  setSelection({
    pageId,
    type: "text",
    objectId,
  });
}

/**
 * Clear visual selection within a text layer.
 */
export function clearTextSelection(textLayer) {
  if (!textLayer) {
    return;
  }

  textLayer.querySelectorAll(
    ".ocr-text-block.selected"
  ).forEach((element) => {
    element.classList.remove("selected");
    element.setAttribute("aria-selected", "false");
  });
}


/* =========================================================
   INLINE TEXT EDITING
   ========================================================= */


export function commitTextBlock(element) {
  if (!element) {
    return false;
  }

  const pageId = element.dataset.pageId;
  const objectId = element.dataset.objectId;

  if (!pageId || !objectId) {
    return false;
  }

  const page = getPageById(pageId);

  if (!page) {
    return false;
  }

  const block = page.textBlocks.find(
    (item) => item.id === objectId
  );

  if (!block) {
    return false;
  }

  const newText = element.textContent ?? "";

  const previousText =
    element.dataset.editingOriginalText ??
    block.text ??
    "";

  if (block.text === newText) {
    return false;
  }

  // Preserve the original recognized text for future background repair.
  const originalText =
    block.originalText ??
    previousText ??
    block.text ??
    "";

  block.originalText = originalText;
  block.text = newText;
  block.modified = true;

  updatePageObject(
    pageId,
    "text",
    objectId,
    {
      text: newText,
      originalText,
      modified: true,
    }
  );

  // Notify main.js that the user has committed a text edit.
  element.dispatchEvent(
    new CustomEvent("ocr-text-committed", {
      bubbles: true,
      detail: {
        pageId,
        objectId,
        originalText,
        previousText,
        newText,
        source: block.source || null,
        origin: block.origin || null,
      },
    })
  );

  return true;
}


/**
 * Begin editing a selected text block.
 */
export function beginTextEditing(element) {
  if (!element || element.isContentEditable) {
    return;
  }

  element.dataset.editingOriginalText =
    element.textContent || "";

  element.contentEditable = "true";
  element.classList.add("editing");

  element.focus();

  /*
   * Place the caret at the end only if the browser has not
   * already established a selection inside the editing element.
   */
  const selection = window.getSelection();

  if (
    selection &&
    !element.contains(selection.anchorNode)
  ) {
    const range = document.createRange();

    range.selectNodeContents(element);
    range.collapse(false);

    selection.removeAllRanges();
    selection.addRange(range);
  }
}

/**
 * Finish editing, saving or cancelling the current changes.
 */
export function endTextEditing(element, { cancel = false } = {}) {
  if (!element || !element.isContentEditable) {
    return;
  }

  if (cancel) {
    element.textContent =
      element.dataset.editingOriginalText || "";
  }

  element.contentEditable = "false";
  element.classList.remove("editing");

  if (!cancel) {
    commitTextBlock(element);
  }

  delete element.dataset.editingOriginalText;
}


/* =========================================================
   POINTER DRAGGING
   ========================================================= */

/**
 * Enable moving a text block.
 *
 * Movement starts after a small pointer threshold to avoid
 * accidentally moving a block during a normal click.
 *
 * Model positions are always saved in source coordinates,
 * not display pixels.
 */
function enableTextDragging({
  element,
  page,
  pageElement,
  objectId,
  sourceWidth,
  sourceHeight,
}) {
  let pointerStart = null;
  let initialBounds = null;
  let dragging = false;

  const DRAG_THRESHOLD = 4;

  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }

    if (element.isContentEditable) {
      return;
    }

    const registeredPage = getPageById(page.id);

    if (!registeredPage) {
      return;
    }

    const block = registeredPage.textBlocks.find(
      (item) => item.id === objectId
    );

    if (!block) {
      return;
    }

    const bounds = getTextBounds(block);

    pointerStart = {
      id: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
    };

    initialBounds = { ...bounds };
    dragging = false;
  });

  element.addEventListener("pointermove", (event) => {
    if (!pointerStart || pointerStart.id !== event.pointerId) {
      return;
    }

    if (element.isContentEditable) {
      return;
    }

    const dx = event.clientX - pointerStart.clientX;
    const dy = event.clientY - pointerStart.clientY;

    if (
      !dragging &&
      Math.hypot(dx, dy) < DRAG_THRESHOLD
    ) {
      return;
    }

    const scale = getDisplayScale(
      pageElement,
      sourceWidth,
      sourceHeight
    );

    if (
      !Number.isFinite(scale.x) ||
      !Number.isFinite(scale.y) ||
      scale.x <= 0 ||
      scale.y <= 0
    ) {
      return;
    }

    if (!dragging) {
      dragging = true;

      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture may be unavailable in some environments.
      }

      event.preventDefault();
    }

    pointerStart.currentX = event.clientX;
    pointerStart.currentY = event.clientY;

    const sourceX = initialBounds.x + dx / scale.x;
    const sourceY = initialBounds.y + dy / scale.y;

    element.style.left = `${sourceX * scale.x}px`;
    element.style.top = `${sourceY * scale.y}px`;
  });

  function finishDrag(event, cancel = false) {
    if (!pointerStart || pointerStart.id !== event.pointerId) {
      return;
    }

    const wasDragging = dragging;

    if (wasDragging && !cancel) {
      const scale = getDisplayScale(
        pageElement,
        sourceWidth,
        sourceHeight
      );

      if (scale.x > 0 && scale.y > 0) {
        const dx = event.clientX - pointerStart.clientX;
        const dy = event.clientY - pointerStart.clientY;

        const x = initialBounds.x + dx / scale.x;
        const y = initialBounds.y + dy / scale.y;

        const currentPage = getPageById(page.id);

        const block = currentPage?.textBlocks.find(
          (item) => item.id === objectId
        );

        if (block) {
          const nextBounds = {
            ...initialBounds,
            x,
            y,
          };

          block.x = x;
          block.y = y;
          block.bounds = nextBounds;

          updatePageObject(
            page.id,
            "text",
            objectId,
            {
              x,
              y,
              bounds: nextBounds,
            }
          );
        }
      }
    }

    if (cancel) {
      element.style.left =
        `${initialBounds.x * sourceWidth / sourceWidth}px`;

      element.style.top =
        `${initialBounds.y * sourceHeight / sourceHeight}px`;

      // Reapply the actual display scaling after cancellation.
      const scale = getDisplayScale(
        pageElement,
        sourceWidth,
        sourceHeight
      );

      element.style.left = `${initialBounds.x * scale.x}px`;
      element.style.top = `${initialBounds.y * scale.y}px`;
    }

    pointerStart = null;
    initialBounds = null;
    dragging = false;
  }

  element.addEventListener("pointerup", (event) => {
    finishDrag(event, false);
  });

  element.addEventListener("pointercancel", (event) => {
    finishDrag(event, true);
  });

  element.addEventListener("lostpointercapture", () => {
    if (!pointerStart) {
      return;
    }

    if (dragging) {
      const scale = getDisplayScale(
        pageElement,
        sourceWidth,
        sourceHeight
      );

      element.style.left =
        `${initialBounds.x * scale.x}px`;

      element.style.top =
        `${initialBounds.y * scale.y}px`;
    }

    pointerStart = null;
    initialBounds = null;
    dragging = false;
  });
}


/* =========================================================
   SINGLE TEXT ELEMENT
   ========================================================= */

/**
 * Create one interactive HTML element from a text model.
 */
function createTextElement({
  block,
  page,
  textLayer,
  pageElement,
  sourceWidth,
  sourceHeight,
  scaleX,
  scaleY,
}) {
  const element = document.createElement("span");

  element.className = "ocr-text-block";

  element.dataset.objectId = block.id;
  element.dataset.pageId = page.id;
  element.dataset.objectType = "text";

  element.textContent = block.text || "";

  element.spellcheck = false;
  element.contentEditable = "false";
  element.tabIndex = 0;

  element.setAttribute("role", "textbox");
  element.setAttribute("aria-multiline", "false");
  element.setAttribute("aria-selected", "false");

  element.setAttribute(
    "aria-label",
    `Text block: ${String(block.text || "").slice(0, 100)}`
  );

  element.dataset.sourceX = String(
    getTextBounds(block).x
  );

  element.dataset.sourceY = String(
    getTextBounds(block).y
  );

  applyTextStyle(
    element,
    block,
    scaleX,
    scaleY
  );
if (block.modified) {
  element.classList.add("modified");
}
  /*
   * Single click selects the block.
   */
  element.addEventListener("click", (event) => {
    event.stopPropagation();

    selectTextBlock(
      element,
      textLayer,
      page.id,
      block.id
    );
  });

  /*
   * Double click enters inline editing mode.
   */
  element.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();

    selectTextBlock(
      element,
      textLayer,
      page.id,
      block.id
    );

    beginTextEditing(element);
  });

  /*
   * Enter commits a single-line edit.
   * Escape cancels it.
   */
  element.addEventListener("keydown", (event) => {
    if (!element.isContentEditable) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();

        selectTextBlock(
          element,
          textLayer,
          page.id,
          block.id
        );
      }

      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      element.blur();
    }

    if (event.key === "Escape") {
      event.preventDefault();

      endTextEditing(element, {
        cancel: true,
      });

      element.blur();
    }
  });

  /*
   * Keep text in one visual line. OCR line boxes should not
   * become multi-line editing boxes when the user pastes text.
   */
  element.addEventListener("paste", (event) => {
    if (!element.isContentEditable) {
      return;
    }

    event.preventDefault();

    const pastedText = (
      event.clipboardData?.getData("text/plain") || ""
    ).replace(/[\r\n]+/g, " ");

    const selection = window.getSelection();

    if (!selection || selection.rangeCount === 0) {
      element.appendChild(
        document.createTextNode(pastedText)
      );

      return;
    }

    const range = selection.getRangeAt(0);

    if (!element.contains(range.commonAncestorContainer)) {
      return;
    }

    range.deleteContents();

    const textNode = document.createTextNode(pastedText);
    range.insertNode(textNode);

    range.setStartAfter(textNode);
    range.collapse(true);

    selection.removeAllRanges();
    selection.addRange(range);
  });

  /*
   * Commit the edited text when focus leaves the block.
   */
  element.addEventListener("blur", () => {
    if (!element.isContentEditable) {
      return;
    }

    endTextEditing(element);
  });

  /*
   * Dragging moves the selected line in source coordinates.
   */
  enableTextDragging({
    element,
    page,
    pageElement,
    objectId: block.id,
    sourceWidth,
    sourceHeight,
  });

  return element;
}


/* =========================================================
   RENDER TEXT BLOCKS
   ========================================================= */

/**
 * Render all current text blocks for a page.
 *
 * Arguments:
 *
 * {
 *   page,
 *   renderedPage,
 *   textLayer? // Optional explicit overlay element
 * }
 *
 * The page must already have been rendered by pdf-renderer.js.
 *
 * Returns the list of created HTML elements.
 */
export function renderTextBlocks({
  page,
  renderedPage,
  textLayer = null,
} = {}) {
  if (!page || !page.id) {
    throw new Error(
      "renderTextBlocks() requires a page model."
    );
  }

  if (!renderedPage?.pageElement) {
    throw new Error(
      "The page must be rendered before adding text overlays."
    );
  }

  const currentPage = getPageById(page.id);

  if (!currentPage) {
    throw new Error(
      `Page ${page.id} is missing from the application state.`
    );
  }

  const targetLayer =
    textLayer || renderedPage.textLayer;

  if (!(targetLayer instanceof HTMLElement)) {
    throw new Error(
      "The page does not have a valid OCR text layer."
    );
  }

  const pageElement = renderedPage.pageElement;

  const { width: sourceWidth, height: sourceHeight } =
    getPageSourceDimensions(
      currentPage,
      renderedPage
    );

  const scale = getDisplayScale(
    pageElement,
    sourceWidth,
    sourceHeight
  );

  /*
   * This layer contains only the rendered text elements.
   * Background repairs and inserted images use their own layers.
   */
  targetLayer.replaceChildren();

  const elements = [];

  for (const block of currentPage.textBlocks) {
    if (!block.id) {
      console.warn(
        "Skipping a text block without an ID:",
        block
      );

      continue;
    }

    try {
      const element = createTextElement({
        block,
        page: currentPage,
        textLayer: targetLayer,
        pageElement,
        sourceWidth,
        sourceHeight,
        scaleX: scale.x,
        scaleY: scale.y,
      });

      targetLayer.appendChild(element);
      elements.push(element);
    } catch (error) {
      console.error(
        `Could not render text block ${block.id}:`,
        error
      );
    }
  }

  return elements;
}


/* =========================================================
   REFRESH A SINGLE TEXT BLOCK
   ========================================================= */

/**
 * Refresh an existing element from its text model.
 *
 * Useful after changing font size, font family, text color,
 * or the element's position from the properties panel.
 */
export function refreshTextBlock({
  pageId,
  objectId,
  element,
  renderedPage,
} = {}) {
  const page = getPageById(pageId);

  if (!page || !element || !renderedPage?.pageElement) {
    return false;
  }

  const block = page.textBlocks.find(
    (item) => item.id === objectId
  );

  if (!block) {
    return false;
  }

const {
  width: sourceWidth,
  height: sourceHeight,
} = getPageSourceDimensions(page, renderedPage);

  const scale = getDisplayScale(
    renderedPage.pageElement,
    sourceWidth,
    sourceHeight
  );

  element.textContent = block.text || "";

  applyTextStyle(
    element,
    block,
    scale.x,
    scale.y
  );

  return true;
}
