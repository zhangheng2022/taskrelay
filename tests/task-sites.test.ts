import test from "node:test";
import assert from "node:assert/strict";
import { suppliedTaskUrls } from "../apps/cloud/src/task-sites";

test("网址识别保留路径查询与大小写，并处理中文标点和多个站点", () => {
  assert.deepEqual(suppliedTaskUrls("网站是www.baidu.com，请查看 example.com/News?q=AbC#Top。"), ["https://www.baidu.com/", "https://example.com/News?q=AbC#Top"]);
  assert.deepEqual(suppliedTaskUrls("（HTTPS://WWW.BAIDU.COM/） https://example.com/a?q=1&lang=zh"), ["https://www.baidu.com/", "https://example.com/a?q=1&lang=zh"]);
  assert.deepEqual(suppliedTaskUrls("example.com example.com"), ["https://example.com/"]);
  assert.deepEqual(suppliedTaskUrls("Visit example.com. Then read www.baidu.com."), ["https://example.com/", "https://www.baidu.com/"]);
});

test("不从无效网址截取安全子串，也不放宽公网地址验证", () => {
  for (const value of ["//www.baidu.com", "www..baidu.com", "www.-baidu.com", "example.com:abc", "https://192.168.1.1", "https://[::1]/", "https://example.com:8080", "mailto:user@example.com", "file:///example.com", "bad_example.com", "example.com_bad"]) {
    assert.deepEqual(suppliedTaskUrls(value), [], value);
  }
});
