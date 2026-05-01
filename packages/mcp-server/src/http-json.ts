import http from "node:http";
import https from "node:https";

export interface JsonHttpResponse<T> {
  ok: boolean;
  status: number;
  statusText: string;
  body: T;
  text: string;
}

export interface JsonHttpOptions {
  headers?: Record<string, string>;
  body?: unknown;
}

export function requestJson<T>(url: URL, options: JsonHttpOptions = {}): Promise<JsonHttpResponse<T>> {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const client = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: body ? "POST" : "GET",
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body).toString() } : {}),
          ...options.headers
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = {};
          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = {};
            }
          }
          const status = response.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            statusText: response.statusMessage ?? "",
            body: parsed as T,
            text
          });
        });
      }
    );

    request.on("error", reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}
