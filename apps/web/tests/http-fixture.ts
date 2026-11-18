import { once } from "node:events";
import { createServer } from "node:http";
import { Writable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { onTestFinished } from "vitest";

export async function serveHttp(handler: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const errors: unknown[] = [];
  const server = createServer(async (incoming, outgoing) => {
    const controller = new AbortController();
    outgoing.once("close", () => {
      if (!outgoing.writableEnded) controller.abort();
    });
    try {
      const headers = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
      }
      const bytes = await buffer(incoming);
      const request = new Request(new URL(incoming.url!, origin), {
        method: incoming.method!,
        headers,
        signal: controller.signal,
        ...(bytes.length ? { body: new Uint8Array(bytes) } : {}),
      });
      const response = await handler(request);
      if (controller.signal.aborted) {
        await response.body?.cancel();
        return;
      }
      if (response.type === "error") {
        outgoing.destroy();
        return;
      }
      outgoing.statusCode = response.status;
      response.headers.forEach((value, key) => outgoing.setHeader(key, value));
      outgoing.flushHeaders();
      if (response.body) {
        await response.body.pipeTo(Writable.toWeb(outgoing), { signal: controller.signal });
      } else {
        outgoing.end();
      }
    } catch (error) {
      if (!controller.signal.aborted) errors.push(error);
      outgoing.destroy();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback port");
  const origin = `http://127.0.0.1:${address.port}`;
  onTestFinished(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
    if (errors.length) throw new AggregateError(errors, "HTTP fixture handler failed");
  });

  const request: typeof fetch = (input, init) => {
    const outgoing = new Request(input instanceof Request ? input : new URL(input, origin), init);
    if (new URL(outgoing.url).origin !== origin) throw new Error("Expected a fixture URL");
    requests.push(outgoing.clone());
    return fetch(outgoing);
  };
  return { origin, fetch: request, requests };
}

export function serveResponses(...responses: Response[]) {
  return serveHttp((request) => {
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected ${request.method} ${request.url}`);
    return response;
  });
}
