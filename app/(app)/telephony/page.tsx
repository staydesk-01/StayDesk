"use client";
import { Lock } from "lucide-react";
import { ConnectionsPanel } from "@/components/telephony/connections-panel";
import { LivePanel } from "@/components/telephony/live-panel";
import { NumbersPanel } from "@/components/telephony/numbers-panel";
import { OutboundPanel } from "@/components/telephony/outbound-panel";
import type { Overview } from "@/components/telephony/shared";
import { PageHeader } from "@/components/common/page-header";
import { ErrorState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApi } from "@/hooks/use-api";
import { useSession } from "@/hooks/use-session";

export default function TelephonyPage() {
  const { canManage } = useSession();
  const { data, error, loading, refetch } = useApi<Overview>(canManage ? "/telephony" : null, { refreshMs: 15_000, events: ["call.updated"] });

  return (
    <>
      <PageHeader title="Telephony" description="Connections, numbers, outbound rules and call health for your phone system." />
      {!canManage ? (
        <Card><CardContent className="flex items-center gap-2 py-8 text-sm text-muted"><Lock className="size-4" /> Only owners and admins can manage telephony.</CardContent></Card>
      ) : loading && !data ? (
        <Skeleton className="h-64" />
      ) : error && !data ? (
        <Card><ErrorState message={error} onRetry={refetch} /></Card>
      ) : !data?.enabled ? (
        <Card><CardContent className="space-y-2 py-8 text-sm"><p className="font-semibold">The telephony core is switched off.</p><p className="text-muted">Your existing Twilio calling is unchanged. To use this page, set <code>FEATURE_TELEPHONY_CORE=true</code> on the server (and <code>TELEPHONY_SECRET_KEY</code> to store credentials).</p></CardContent></Card>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-2 text-xs">
            <Badge tone="success">Telephony core on</Badge>
            <Badge tone={data.flags.sipGateway ? "success" : "neutral"}>SIP gateway events {data.flags.sipGateway ? "on" : "off"}</Badge>
            <Badge tone={data.flags.outboundCalling ? "warning" : "neutral"}>Outbound {data.flags.outboundCalling ? "on" : "off"}</Badge>
            <Badge tone={data.flags.secretsConfigured ? "success" : "danger"}>Credential encryption key {data.flags.secretsConfigured ? "set" : "missing"}</Badge>
          </div>
          <Tabs defaultValue="connections">
            <TabsList aria-label="Telephony sections">
              <TabsTrigger value="connections">Connections</TabsTrigger>
              <TabsTrigger value="numbers">Numbers & trunks</TabsTrigger>
              <TabsTrigger value="outbound">Outbound</TabsTrigger>
              <TabsTrigger value="live">Calls & health</TabsTrigger>
            </TabsList>
            <TabsContent value="connections"><ConnectionsPanel data={data} refetch={refetch} /></TabsContent>
            <TabsContent value="numbers"><NumbersPanel data={data} refetch={refetch} /></TabsContent>
            <TabsContent value="outbound"><OutboundPanel data={data} refetch={refetch} /></TabsContent>
            <TabsContent value="live"><LivePanel data={data} /></TabsContent>
          </Tabs>
        </>
      )}
    </>
  );
}
