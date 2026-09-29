"use client";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DashboardMetrics } from "@/types";

export function ActivityChart({ data }: { data: DashboardMetrics["chart"] }) {
  const total = data.reduce((s, d) => s + d.calls, 0);
  return (
    <div className="h-64 w-full sm:h-72" role="img" aria-label={`Call volume chart: ${total} calls in the selected period`}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id="callsFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#8b66d6" stopOpacity={0.28} />
              <stop offset="100%" stopColor="#8b66d6" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="#ece8f5" strokeDasharray="4 6" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "#9994b0", fontSize: 12 }} interval="preserveStartEnd" minTickGap={16} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: "#9994b0", fontSize: 12 }} width={44} />
          <Tooltip
            cursor={{ stroke: "#c8b4ef", strokeWidth: 1 }}
            contentStyle={{ borderRadius: 12, border: "1px solid #ece8f5", boxShadow: "0 8px 24px rgb(29 22 51 / 0.12)", fontSize: 13 }}
            labelStyle={{ fontWeight: 700, color: "#1d1633" }}
          />
          <Area type="monotone" dataKey="calls" name="All calls" stroke="#7654c9" strokeWidth={2.5} fill="url(#callsFill)" dot={{ r: 3, fill: "#7654c9", strokeWidth: 0 }} activeDot={{ r: 5 }} />
          <Area type="monotone" dataKey="aiHandled" name="AI handled" stroke="#b39be9" strokeWidth={2} strokeDasharray="5 4" fill="transparent" dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
