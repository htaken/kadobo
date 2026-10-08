#!/usr/bin/env node
/**
 * MF 請求書 API v3（OAuth 2.0、認可コードフロー + PKCE S256）の初回認可を行うローカルスクリプト
 * （実装設計 MF連携 §4.5）。Node 24、依存パッケージ無し（`fetch`・`crypto`・`http` は Node 組込み）。
 *
 * 使い方:
 *   MF_CLIENT_ID=... MF_CLIENT_SECRET=... node scripts/mf-oauth-authorize.mjs
 *
 * 事前に MF のアプリポータルで、連携アプリのリダイレクト URI に
 * `http://127.0.0.1:8765/callback` を登録しておくこと。scope は `mfc/invoice/data.write` のみ
 * （会計 API は API キー認証のため OAuth スコープには含めない）。クライアント認証方式は
 * `CLIENT_SECRET_BASIC`（`Authorization: Basic base64(client_id:client_secret)`）。
 *
 * `127.0.0.1:8765` だけで待ち受け（外部に開かない）、`state`（乱数）と PKCE（S256）を付けて
 * 認可 URL を表示する。コールバックでは `state` の一致を確認し、`error` パラメータが付いて
 * いれば内容を表示して終了する。5 分でコールバック待受けを打ち切る。
 *
 * 成功時は、Script Property `MF_INVOICE_TOKENS` にそのまま貼れる JSON
 * （`{access_token, refresh_token, refreshed_at, generation: 1}`）を**標準出力に 1 度だけ**
 * 出力する。それ以外のメッセージ（URL・進捗・エラー）はすべて標準エラー出力へ出す
 * （stdout をそのまま `pbcopy`/リダイレクト等でトークン JSON だけ扱えるようにするため）。
 * シークレット（`client_secret`・取得したトークン）はファイルに書かない。
 */
import { exec } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const HOST = "127.0.0.1";
const PORT = 8765;
const REDIRECT_URI = `http://${HOST}:${PORT}/callback`;
const AUTHORIZE_URL = "https://api.biz.moneyforward.com/authorize";
const TOKEN_URL = "https://api.biz.moneyforward.com/token";
const SCOPE = "mfc/invoice/data.write";
const TIMEOUT_MS = 5 * 60 * 1000;

function log(...args) {
  console.error(...args);
}

/** 標準エラーへエラーメッセージを出し、非 0 で終了する。 */
function fail(message) {
  log(`\n❌ ${message}`);
  process.exit(1);
}

const clientId = process.env.MF_CLIENT_ID;
const clientSecret = process.env.MF_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  fail("環境変数 MF_CLIENT_ID / MF_CLIENT_SECRET を設定してください。");
}

const state = randomBytes(16).toString("hex");
const codeVerifier = randomBytes(32).toString("base64url");
const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

const authorizeUrl = new URL(AUTHORIZE_URL);
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("client_id", clientId);
authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authorizeUrl.searchParams.set("scope", SCOPE);
authorizeUrl.searchParams.set("state", state);
authorizeUrl.searchParams.set("code_challenge", codeChallenge);
authorizeUrl.searchParams.set("code_challenge_method", "S256");

function htmlPage(title, body) {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
    `<body style="font-family:sans-serif;max-width:32rem;margin:3rem auto">` +
    `<h1>${title}</h1><p>${body}</p></body></html>`
  );
}

/** `POST /token`（`grant_type=authorization_code`）でトークンを取得する。 */
async function exchangeToken(code) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic}`,
    },
    body: body.toString(),
  });
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`トークン交換に失敗しました（HTTP ${res.status}）: ${text}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("トークン交換のレスポンスが JSON として解釈できませんでした。");
  }
  if (typeof json.access_token !== "string" || typeof json.refresh_token !== "string") {
    throw new Error("トークン交換のレスポンスに access_token / refresh_token がありません。");
  }
  return { access_token: json.access_token, refresh_token: json.refresh_token };
}

let settled = false;
let timeoutHandle;

/** レスポンス送出後、少し待ってから後始末（プロセス終了・サーバ停止）を行う。 */
function finishAfterResponse(action) {
  clearTimeout(timeoutHandle);
  setTimeout(() => {
    server.close();
    action();
  }, 50);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  if (settled) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
      htmlPage("処理済み", "この認可は既に処理済みです。ターミナルを確認してください。"),
    );
    return;
  }

  const errorParam = url.searchParams.get("error");
  if (errorParam !== null) {
    const desc = url.searchParams.get("error_description") ?? "";
    settled = true;
    res
      .writeHead(400, { "content-type": "text/html; charset=utf-8" })
      .end(htmlPage("認可エラー", `${errorParam} ${desc}`));
    finishAfterResponse(() => fail(`MF から認可エラーが返されました: ${errorParam} ${desc}`));
    return;
  }

  const returnedState = url.searchParams.get("state");
  if (returnedState !== state) {
    settled = true;
    res
      .writeHead(400, { "content-type": "text/html; charset=utf-8" })
      .end(htmlPage("state 不一致", "state パラメータが一致しません。最初からやり直してください。"));
    finishAfterResponse(() => fail("state パラメータが一致しません（CSRF の可能性、または古いリンクです）。"));
    return;
  }

  const code = url.searchParams.get("code");
  if (code === null) {
    settled = true;
    res
      .writeHead(400, { "content-type": "text/html; charset=utf-8" })
      .end(htmlPage("code がありません", "code パラメータがありません。"));
    finishAfterResponse(() => fail("code パラメータがありません。"));
    return;
  }

  settled = true;
  exchangeToken(code)
    .then((tokens) => {
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(htmlPage("認可が完了しました", "ターミナルに戻ってください。このタブは閉じて構いません。"));
      finishAfterResponse(() => {
        const output = {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          refreshed_at: Date.now(),
          generation: 1,
        };
        log("✅ 認可が完了しました。以下の JSON 1 行を Script Property MF_INVOICE_TOKENS に貼り付けてください。\n");
        process.stdout.write(`${JSON.stringify(output)}\n`);
        process.exitCode = 0;
      });
    })
    .catch((e) => {
      res
        .writeHead(500, { "content-type": "text/html; charset=utf-8" })
        .end(htmlPage("エラー", "トークン交換に失敗しました。ターミナルを確認してください。"));
      finishAfterResponse(() => fail(e instanceof Error ? e.message : String(e)));
    });
});

server.listen(PORT, HOST, () => {
  log(`ブラウザで以下の URL を開いて認可してください（${TIMEOUT_MS / 60000} 分でタイムアウトします）:\n`);
  log(authorizeUrl.toString());
  log("");
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  // 自動起動はベストエフォート（失敗しても上記 URL を手動で開けばよい）。
  exec(`${opener} "${authorizeUrl.toString()}"`, () => {});
});

timeoutHandle = setTimeout(() => {
  if (!settled) {
    settled = true;
    server.close();
    fail(`${TIMEOUT_MS / 60000} 分以内にコールバックを受信できませんでした（タイムアウト）。`);
  }
}, TIMEOUT_MS);
