import { useEffect, useRef } from "react";
import { Page } from "@apralabs/apra-fleet-ui-kit";
import {
  extSrc,
  isPackageOffline,
  packageLabel,
  type WorkflowPackageView
} from "../api/workflow-packages";

/** Messages a package UI may send its host shell (DQ-18 v1). */
export const NAVIGATE_MESSAGE = "apra-fleet:navigate";
export const CONTEXT_MESSAGE = "apra-fleet:context";

interface ExtProps {
  packageId: string;
  /** Path inside the package, e.g. "/ui/projects". */
  path: string;
  /** The registry entry for this package, when the registry has been read.
   *  Undefined means "not known yet" -- the iframe is still rendered, since
   *  the proxy is the authority on whether the package answers. */
  view?: WorkflowPackageView;
  /** Called with the project id the package reports, or null when it leaves
   *  project context. Drives the visibility of project-scoped nav entries. */
  onContext?: (project: string | null) => void;
}

/**
 * Hosts a workflow package's own UI in a SAME-ORIGIN iframe served through
 * the console proxy at /ext/<id>/*. Same origin is the whole point: the
 * console session cookie rides along, so the package UI is authenticated
 * without the shell ever handling a second credential.
 *
 * DEEP-LINK MIRRORING. The shell hash and the iframe's location are kept in
 * step in both directions, without ever reloading the iframe for a
 * navigation the iframe itself performed:
 *  - iframe -> shell: the package posts {type: NAVIGATE_MESSAGE, path} and
 *    the shell rewrites its hash. The iframe has ALREADY navigated itself, so
 *    pushing the path back into iframe.src would reload it and lose its
 *    state. `appliedPath` records the path we know the iframe is showing, and
 *    the sync effect below skips any path change that matches it.
 *  - shell -> iframe: a hash change the shell originated (a nav link, the
 *    back button) does not match `appliedPath`, so the effect sets
 *    iframe.src and the iframe navigates.
 *
 * TRUST. A message is acted on only when BOTH checks pass: it came from this
 * iframe's own contentWindow (not another frame, not the opener) AND its
 * origin is this document's origin. window "message" is a global bus that any
 * frame or extension can post to, so an unchecked handler here would let any
 * page drive the console's navigation.
 */
export function Ext({ packageId, path, view, onContext }: ExtProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Constant for the lifetime of the mount: the iframe's src is managed
  // imperatively from here on, so React must never re-apply this attribute.
  const initialSrcRef = useRef(extSrc(packageId, path));
  const appliedPathRef = useRef(path);
  // Keep the latest callback reachable without re-subscribing the listener
  // on every parent render (which would drop messages mid-swap).
  const onContextRef = useRef(onContext);
  onContextRef.current = onContext;

  const offline = view ? isPackageOffline(view) : false;

  useEffect(() => {
    if (offline) return;

    function onMessage(event: MessageEvent) {
      const frame = iframeRef.current;
      if (!frame || !frame.contentWindow) return;
      if (event.source !== frame.contentWindow) return;
      if (event.origin !== window.location.origin) return;

      const data = event.data as { type?: unknown; path?: unknown; project?: unknown } | null;
      if (!data || typeof data !== "object") return;

      if (data.type === NAVIGATE_MESSAGE && typeof data.path === "string") {
        // The iframe is already there; record it so the sync effect does not
        // bounce the same path back and reload the frame.
        appliedPathRef.current = data.path;
        window.location.hash = `#/ext/${encodeURIComponent(packageId)}${data.path}`;
        return;
      }

      if (data.type === CONTEXT_MESSAGE) {
        const project = typeof data.project === "string" && data.project ? data.project : null;
        onContextRef.current?.(project);
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [packageId, offline]);

  useEffect(() => {
    if (offline) return;
    if (path === appliedPathRef.current) return;
    appliedPathRef.current = path;
    const frame = iframeRef.current;
    if (frame) frame.src = extSrc(packageId, path);
  }, [packageId, path, offline]);

  // Leaving the package: drop any project context it established, so its
  // project-scoped nav entries do not linger over another screen.
  useEffect(() => {
    return () => onContextRef.current?.(null);
  }, [packageId]);

  const title = view ? packageLabel(view) : packageId;

  if (offline) {
    return (
      <Page title={title} subtitle={`Workflow package ${packageId}`}>
        <p role="status">
          package offline{view?.configError ? `: ${view.configError}` : null}
        </p>
      </Page>
    );
  }

  return (
    <Page title={title} subtitle={`Workflow package ${packageId}`}>
      <iframe
        ref={iframeRef}
        src={initialSrcRef.current}
        title={`${title} package UI`}
        style={{ width: "100%", height: "calc(100vh - 160px)", border: "0" }}
      />
    </Page>
  );
}
