"use client";
import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

export const Tabs = TabsPrimitive.Root;
export const TabsContent = ({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) => (
  <TabsPrimitive.Content className={cn("mt-5 outline-none", className)} {...props} />
);
export const TabsList = ({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) => (
  <TabsPrimitive.List className={cn("inline-flex max-w-full gap-1 overflow-x-auto rounded-xl bg-brand-50 p-1 ring-1 ring-border", className)} {...props} />
);
export const TabsTrigger = ({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) => (
  <TabsPrimitive.Trigger
    className={cn(
      "whitespace-nowrap rounded-lg px-3.5 py-1.5 text-sm font-semibold text-muted outline-none transition focus-visible:ring-2 focus-visible:ring-brand-400 data-[state=active]:bg-surface data-[state=active]:text-brand-800 data-[state=active]:shadow-sm",
      className,
    )}
    {...props}
  />
);
