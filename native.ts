
"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");

export async function httpFetch(
    _event: any,
    opts: { method: string; url: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; body: string; error?: string }> {
    try {
        const { method = "GET", url: rawUrl, headers: extraHeaders = {}, body } = opts;

        const u = new URL(rawUrl);
        const isHttps = u.protocol === "https:";

        const headers: Record<string, string> = { ...extraHeaders };

        
        
        headers["x-stickerpull"] = "sp-v1";

        if (body && !headers["content-type"]) {
            headers["content-type"] = "application/json";
        }

        return await new Promise((resolve) => {
            const transport = isHttps ? https : http;

            const req = transport.request(
                {
                    method,
                    hostname: u.hostname,
                    port: u.port || (isHttps ? 443 : 80),
                    path: u.pathname + u.search,
                    headers,
                    timeout: 30_000,
                },
                (res: any) => {
                    const chunks: Buffer[] = [];
                    res.on("data", (chunk: Buffer) => chunks.push(chunk));
                    res.on("end", () =>
                        resolve({
                            status: res.statusCode ?? 0,
                            body: Buffer.concat(chunks).toString("utf-8"),
                        })
                    );
                    res.on("error", (e: any) =>
                        resolve({ status: 0, body: "", error: String(e.message ?? e) })
                    );
                }
            );

            req.on("timeout", () => {
                req.destroy();
                resolve({ status: 0, body: "", error: "timeout" });
            });

            req.on("error", (e: any) =>
                resolve({ status: 0, body: "", error: String(e.message ?? e) })
            );

            if (body) req.write(body);
            req.end();
        });
    } catch (e: any) {
        return { status: 0, body: "", error: String(e.message ?? e) };
    }
}
