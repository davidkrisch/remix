import {
  // This has been added as a global in node 15+
  AbortController,
  Headers as NodeHeaders,
  Request as NodeRequest,
  createRequestHandler as createRemixRequestHandler,
} from "@remix-run/node";
import type {
  APIGatewayProxyEventHeaders,
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import type {
  AppLoadContext,
  ServerBuild,
  Response as NodeResponse,
} from "@remix-run/node";

import { isBinaryType } from "./binaryTypes";

/**
 * A function that returns the value to use as `context` in route `loader` and
 * `action` functions.
 *
 * You can think of this as an escape hatch that allows you to pass
 * environment/platform-specific values through to your loader/action.
 */
export type GetLoadContextFunction = (
  event: APIGatewayProxyEventV2
) => AppLoadContext;

export type RequestHandler = APIGatewayProxyHandlerV2;

/**
 * Returns a request handler for Architect that serves the response using
 * Remix.
 */
export function createRequestHandler({
  build,
  getLoadContext,
  mode = process.env.NODE_ENV,
}: {
  build: ServerBuild;
  getLoadContext?: GetLoadContextFunction;
  mode?: string;
}): RequestHandler {
  let handleRequest = createRemixRequestHandler(build, mode);

  return async (event /*, context*/) => {
    let abortController = new AbortController();
    let request = createRemixRequest(event, abortController);
    let loadContext =
      typeof getLoadContext === "function" ? getLoadContext(event) : undefined;

    let response = (await handleRequest(
      request as unknown as Request,
      loadContext
    )) as unknown as NodeResponse;

    return sendRemixResponse(response, abortController);
  };
}

export function createRemixRequest(
  event: APIGatewayProxyEventV2,
  abortController?: AbortController
): NodeRequest {
  let host = event.headers["x-forwarded-host"] || event.headers.host;
  let search = event.rawQueryString.length ? `?${event.rawQueryString}` : "";
  let url = new URL(event.rawPath + search, `https://${host}`);

  return new NodeRequest(url.href, {
    method: event.requestContext.http.method,
    headers: createRemixHeaders(event.headers, event.cookies),
    body:
      event.body && event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString()
        : event.body,
    abortController,
    signal: abortController?.signal,
  });
}

export function createRemixHeaders(
  requestHeaders: APIGatewayProxyEventHeaders,
  requestCookies?: string[]
): NodeHeaders {
  let headers = new NodeHeaders();

  for (let [header, value] of Object.entries(requestHeaders)) {
    if (value) {
      headers.append(header, value);
    }
  }

  if (requestCookies) {
    headers.append("Cookie", requestCookies.join("; "));
  }

  return headers;
}

export async function sendRemixResponse(
  nodeResponse: NodeResponse,
  abortController: AbortController
): Promise<APIGatewayProxyStructuredResultV2> {
  let cookies: string[] = [];

  // Arc/AWS API Gateway will send back set-cookies outside of response headers.
  for (let [key, values] of Object.entries(nodeResponse.headers.raw())) {
    if (key.toLowerCase() === "set-cookie") {
      for (let value of values) {
        cookies.push(value);
      }
    }
  }

  if (cookies.length) {
    nodeResponse.headers.delete("Set-Cookie");
  }

  if (abortController.signal.aborted) {
    nodeResponse.headers.set("Connection", "close");
  }

  let contentType = nodeResponse.headers.get("Content-Type");
  let isBinary = isBinaryType(contentType);
  let body;
  let isBase64Encoded = false;

  if (isBinary) {
    let blob = await nodeResponse.arrayBuffer();
    body = Buffer.from(blob).toString("base64");
    isBase64Encoded = true;
  } else {
    body = await nodeResponse.text();
  }

  return {
    statusCode: nodeResponse.status,
    headers: Object.fromEntries(nodeResponse.headers),
    cookies,
    body,
    isBase64Encoded,
  };
}
