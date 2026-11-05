import { useEffect, useState } from "react";
import type { Transport } from "../../contracts/src/index";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./components/ui/card";
import { Field, FieldLabel, FieldGroup } from "./components/ui/field";
import { ErrorText } from "./feedback";
type Memory = { key: string; value: { text: string } };
export function Memories({ transport }: { transport: Transport }) {
  const [items, setItems] = useState<Memory[]>([]),
    [text, setText] = useState(""),
    [key, setKey] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = () =>
    transport.request<Memory[]>("GET", "/api/user/memories").then(setItems);
  useEffect(() => {
    let live = true;
    transport
      .request<Memory[]>("GET", "/api/user/memories")
      .then((r) => {
        if (live) setItems(r);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [transport]);
  async function save() {
    if (busy || !text.trim()) return;
    setBusy(true);
    try {
      await transport.request(
        "PUT",
        `/api/user/memories/${key ?? crypto.randomUUID()}`,
        { text, confirmed: true },
      );
      setText("");
      setKey(null);
      await load();
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    setBusy(true);
    try {
      await transport.request("DELETE", `/api/user/memories/${id}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>我的记忆</CardTitle>
          <CardDescription>
            这里保留你保存的偏好，目前尚未用于任务执行。请直接在任务聊天中说明本次要求；此处不要填写密码或验证码。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="memory-text">
                {key ? "修改偏好" : "希望记住的偏好"}
              </FieldLabel>
              <Textarea
                id="memory-text"
                value={text}
                maxLength={1000}
                disabled={busy}
                onChange={(e) => setText(e.target.value)}
              />
            </Field>
          </FieldGroup>
          {error && <ErrorText error={error} />}
        </CardContent>
        <CardFooter>
          <Button disabled={busy || !text.trim()} onClick={() => void save()}>
            确认记住
          </Button>
          {key && (
            <Button
              variant="ghost"
              onClick={() => {
                setKey(null);
                setText("");
              }}
            >
              取消修改
            </Button>
          )}
        </CardFooter>
      </Card>
      {items.map((m) => (
        <Card key={m.key}>
          <CardContent className="pt-4">{m.value.text}</CardContent>
          <CardFooter className="gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setKey(m.key);
                setText(m.value.text);
              }}
            >
              修改
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void remove(m.key)}
            >
              删除
            </Button>
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}
