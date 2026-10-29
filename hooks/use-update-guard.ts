"use client";
import * as React from "react";
import { registerGuard } from "@/lib/app-update";

/**
 * Tell the update notifier not to reload silently while `active` is true.
 *   "call"     -> a voice call is in progress: the update waits until it ends.
 *   "unsaved"  -> edits would be lost: the user must confirm first.
 */
export function useUpdateGuard(kind: "call" | "unsaved", active: boolean) {
  React.useEffect(() => {
    if (!active) return;
    return registerGuard(kind);
  }, [kind, active]);
}
