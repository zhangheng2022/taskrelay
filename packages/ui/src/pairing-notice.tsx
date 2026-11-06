import {createApi,rpcData} from './api';
import { useEffect, useState } from "react";
import { Monitor } from "lucide-react";
import type { Transport } from "../../contracts/src/index";
import { Alert, AlertTitle, AlertDescription } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { ErrorText } from "./feedback";

type Pairing = { name: string; code: string; approved: boolean };

export function PairingNotice({ transport, refresh }: {
  transport: Transport;
  refresh: () => Promise<void>;
}) {
  const [code, setCode] = useState(() => new URL(window.location.href).searchParams.get("pair"));
  const [pair, setPair] = useState<Pairing | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function clearLink(pairCode: string) {
    const url = new URL(window.location.href);
    if (url.searchParams.get("pair") !== pairCode) return;
    url.searchParams.delete("pair");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }

  useEffect(() => {
    if (!code) return;
    let live = true;
    void rpcData(createApi(transport).api.admin.pairings[':code'].$get({param:{code}}))
      .then((value) => {
        if (!live) return;
        if('error' in value)throw Error(value.error);
        setPair(value);
        if (value.approved) clearLink(code);
      })
      .catch((e: Error) => {
        if (!live) return;
        setError(e.message);
        if (e.message === "PAIRING_EXPIRED") clearLink(code);
      });
    return () => { live = false; };
  }, [code, transport]);

  function dismiss() {
    if (code) clearLink(code);
    setCode(null);
    setPair(null);
    setError("");
  }

  async function approve() {
    if (!code || !pair || pair.approved || busy) return;
    setBusy(true);
    setError("");
    try {
      await rpcData(createApi(transport).api.admin.pairings[':code'].approve.$post({param:{code}}));
      setPair({ ...pair, approved: true });
      clearLink(code);
      await refresh();
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      if (message === "PAIRING_EXPIRED") {
        setPair(null);
        clearLink(code);
      }
    } finally {
      setBusy(false);
    }
  }

  if (!code || (!pair && !error)) return null;
  return (
    <section aria-label="设备配对" className="flex shrink-0 flex-col gap-2 px-4 py-3">
      {error && <ErrorText error={error} />}
      {pair && (
        <Alert>
          <Monitor />
          <AlertTitle>{pair.approved ? "设备已授权" : "授权连接这台设备"}</AlertTitle>
          <AlertDescription>
            <p>{pair.name} · 校验码 {pair.code}。请与客户端核对一致。</p>
            {!pair.approved && (
              <Button size="sm" disabled={busy} onClick={() => void approve()}>
                {busy ? "正在授权…" : "授权设备"}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      <div><Button variant="outline" size="sm" disabled={busy} onClick={dismiss}>关闭配对提示</Button></div>
    </section>
  );
}
