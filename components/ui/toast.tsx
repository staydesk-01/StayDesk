"use client";
import * as React from "react";
import { CheckCircle2, CircleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface ToastItem {
  id: number;
  title: string;
  tone: "success" | "error";
}
const ToastCtx = React.createContext<{ toast: (title: string, tone?: ToastItem["tone"]) => void }>({ toast: () => {} });
export const useToast = () => React.useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const toast = React.useCallback((title: string, tone: ToastItem["tone"] = "success") => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, title, tone }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cn("pointer-events-auto flex items-start gap-3 rounded-xl border bg-surface px-4 py-3 text-sm shadow-[0_12px_32px_rgb(29_22_51/0.16)]", t.tone === "error" ? "border-danger/30" : "border-border")}>
            {t.tone === "error" ? <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />}
            <p className="flex-1 font-medium">{t.title}</p>
            <button onClick={() => setItems((s) => s.filter((x) => x.id !== t.id))} aria-label="Dismiss" className="text-subtle hover:text-foreground">
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
