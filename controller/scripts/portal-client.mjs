import { createPortalController } from "../index.mjs";

const PORTAL_REGISTRY = Symbol.for("portal-spt-control.active-portals");
let activePortal = null;

export async function setupPortalRuntime({ globals = globalThis, spt = {} } = {}) {
  const existingPortals = collectExistingPortals(globals);

  for (const portal of existingPortals) {
    closePortal(globals, portal);
  }
  activePortal = null;
  if (existingPortals.includes(globals.portal)) {
    delete globals.portal;
  }

  activePortal = await createPortalController({ spt });
  getPortalRegistry(globals).add(activePortal);
  globals.portal = activePortal;

  return activePortal;
}

export async function closePortalRuntime({ globals = globalThis } = {}) {
  const existingPortals = collectExistingPortals(globals);

  for (const portal of existingPortals) {
    closePortal(globals, portal);
  }

  activePortal = null;
  if (existingPortals.includes(globals.portal)) {
    delete globals.portal;
  }
}

function collectExistingPortals(globals) {
  const portals = [];
  for (const candidate of [activePortal, globals.portal, ...getPortalRegistry(globals)]) {
    if (isPortal(candidate) && !portals.includes(candidate)) {
      portals.push(candidate);
    }
  }
  return portals;
}

function isPortal(value) {
  return (
    value != null &&
    typeof value.close === "function" &&
    typeof value.screenshot === "function" &&
    typeof value.tas === "function"
  );
}

function closePortal(globals, portal) {
  try {
    portal.close();
  } catch {}
  getPortalRegistry(globals).delete(portal);
}

function getPortalRegistry(globals) {
  if (!(globals[PORTAL_REGISTRY] instanceof Set)) {
    globals[PORTAL_REGISTRY] = new Set();
  }
  return globals[PORTAL_REGISTRY];
}
