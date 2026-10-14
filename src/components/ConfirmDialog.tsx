import { useEffect, useRef, useState } from "react";
import { X, AlertTriangle } from "lucide-react";

// In-app replacement for window.confirm / the native Tauri ask() dialog, styled like the
// rest of the app. Call `confirmDialog(...)` from anywhere; <ConfirmDialogHost /> (mounted
// once in App) renders the pending request. Resolves true on confirm, false otherwise.
export interface ConfirmOptions {
  title: string;
  message: string;
  detail?: string;        // secondary, dimmed paragraph
  confirmLabel?: string;  // default "OK"
  cancelLabel?: string;   // default "Cancel"
  danger?: boolean;       // red confirm button (destructive actions)
}

type Request = ConfirmOptions & { resolve: (ok: boolean) => void };

let show: ((req: Request) => void) | null = null;

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!show) { resolve(window.confirm(opts.message)); return; } // host not mounted yet
    show({ ...opts, resolve });
  });
}

export function ConfirmDialogHost() {
  const [req, setReq] = useState<Request | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    show = (r) => setReq((prev) => { prev?.resolve(false); return r; });
    return () => { show = null; };
  }, []);

  const finish = (ok: boolean) => { req?.resolve(ok); setReq(null); };

  useEffect(() => {
    if (!req) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (!req) return null;
  return (
    <div className="md-overlay" onClick={() => finish(false)}>
      <div className="md-dialog confirm-dialog" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="md-head">
          <span className="md-title">{req.title}</span>
          <button className="md-head-btn" onClick={() => finish(false)} aria-label="Close"><X size={14} /></button>
        </div>
        <div className="confirm-body">
          {req.danger && <AlertTriangle size={18} className="confirm-icon" />}
          <div className="confirm-text">
            <div className="confirm-message">{req.message}</div>
            {req.detail && <div className="confirm-detail">{req.detail}</div>}
          </div>
        </div>
        <div className="upd-foot">
          <div className="upd-foot-spacer" />
          <button className="btn" onClick={() => finish(false)}>{req.cancelLabel ?? "Cancel"}</button>
          <button ref={confirmRef} className={`btn ${req.danger ? "btn-danger" : "btn-primary"}`} onClick={() => finish(true)}>{req.confirmLabel ?? "OK"}</button>
        </div>
      </div>
    </div>
  );
}
