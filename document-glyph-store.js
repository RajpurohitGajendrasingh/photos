let activeGlyphRuntime = null;

export function registerDocumentGlyphRuntime({
  documentId,
  getGlyphRecord,
  getGlyphSpecimensByCharacter,
  getGlyphSpecimen,
} = {}) {
  if (!documentId) {
    throw new Error(
      "[Document Glyph Store] Missing document ID."
    );
  }

  if (typeof getGlyphRecord !== "function") {
    throw new Error(
      "[Document Glyph Store] Missing glyph record lookup."
    );
  }

  if (typeof getGlyphSpecimensByCharacter !== "function") {
    throw new Error(
      "[Document Glyph Store] Missing character specimen lookup."
    );
  }

  if (typeof getGlyphSpecimen !== "function") {
    throw new Error(
      "[Document Glyph Store] Missing specimen lookup."
    );
  }

  activeGlyphRuntime = {
    documentId,
    getGlyphRecord,
    getGlyphSpecimensByCharacter,
    getGlyphSpecimen,
  };

  console.info(
    "[Document Glyph Store] Registered:",
    documentId
  );

  return activeGlyphRuntime;
}

export function clearDocumentGlyphRuntime() {
  activeGlyphRuntime = null;
}

export function getDocumentGlyphRuntime() {
  return activeGlyphRuntime;
}

export function getDocumentGlyphRecord(glyphId) {
  return activeGlyphRuntime?.getGlyphRecord(glyphId) ?? null;
}

export function getDocumentGlyphSpecimens(character) {
  return (
    activeGlyphRuntime?.getGlyphSpecimensByCharacter(character) ?? []
  );
}

export function getDocumentGlyphSpecimen(glyphId) {
  return activeGlyphRuntime?.getGlyphSpecimen(glyphId) ?? null;
}