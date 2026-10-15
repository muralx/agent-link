import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ZodType } from 'zod';
import { HubError } from './store/errors.ts';

/**
 * MAX_BODY_BYTES caps a request body at 1 MiB; larger bodies are answered 413.
 */
export const MAX_BODY_BYTES = 1_048_576;

/** HttpMethod lists the verbs the router supports. */
export type HttpMethod = 'GET' | 'POST' | 'DELETE';

/**
 * RouteResult is what a handler returns: an optional status (default 200, or
 * 204 when body is absent) and a JSON body.
 */
export interface RouteResult {
  status?: number;
  body?: unknown;
}

/**
 * RequestContext is what a handler receives: the raw request and response, path
 * params, query string, and readJson / parseJson to consume the body once (1
 * MiB limit, zod validation with invalid_message on failure).
 */
export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  readJson: () => Promise<unknown>;
  parseJson: <T>(schema: ZodType<T>) => Promise<T>;
}

/**
 * RouteHandler is a route's function; it may be sync or async and may stream
 * its own response, in which case it returns nothing after ending it.
 */
export type RouteHandler = (
  ctx: RequestContext,
) => RouteResult | void | Promise<RouteResult | void>;

/**
 * Route is a compiled router entry: method, path regex, param names and
 * handler.
 */
interface Route {
  method: HttpMethod;
  pattern: RegExp;
  keys: string[];
  handler: RouteHandler;
}

/**
 * compile turns a path pattern with :param segments into a regex and the
 * ordered list of param names.
 */
function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { pattern: new RegExp(`^${source}/?$`), keys };
}

/**
 * bearerToken returns the token of an Authorization: Bearer header, or
 * undefined when the header is missing or uses another scheme.
 */
export function bearerToken(req: {
  headers: { authorization?: string | undefined };
}): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token ? token : undefined;
}

/**
 * sendJson writes a complete JSON response with the given status; an undefined
 * body sends an empty one.
 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * readBody collects the request body as UTF-8 text, throwing a 413 HubError
 * once it exceeds limit bytes.
 */
export async function readBody(
  req: IncomingMessage,
  limit: number = MAX_BODY_BYTES,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) {
      throw new HubError('invalid_message', `request body exceeds ${limit} bytes`, { status: 413 });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Router is the hub's minimal HTTP router over node:http: routes are method
 * plus path pattern with :params, handlers return a RouteResult (or undefined
 * for 204, or write the response themselves), and every thrown HubError becomes
 * its JSON body and status while any other error is a 500.
 */
export class Router {
  readonly #routes: Route[] = [];

  /**
   * add registers a handler for a method and path pattern such as
   * /v1/agents/:id/inbox; patterns are matched in registration order and a
   * trailing slash is tolerated.
   */
  add(method: HttpMethod, path: string, handler: RouteHandler): void {
    const { pattern, keys } = compile(path);
    this.#routes.push({ method, pattern, keys, handler });
  }

  /**
   * handle dispatches one request: 404 not_found when no route matches, the
   * handler's RouteResult as JSON otherwise, HubError as its status and body,
   * anything else as 500. It never throws; use it as the server's request
   * listener.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const match = this.#match(req.method ?? 'GET', url.pathname);
      if (!match)
        throw new HubError('not_found', `no route for ${req.method ?? ''} ${url.pathname}`);
      const ctx = this.#context(req, res, match.params, url.searchParams);
      const result = await match.route.handler(ctx);
      if (res.writableEnded || res.headersSent) return;
      if (result === undefined) {
        res.writeHead(204).end();
        return;
      }
      sendJson(res, result.status ?? (result.body === undefined ? 204 : 200), result.body);
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HubError) {
        sendJson(res, err.status, err.toBody());
      } else {
        sendJson(res, 500, {
          error: 'internal',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * #match finds the first registered route whose method equals the request
   * method and whose pattern matches the pathname, returning it with the
   * decoded path parameters, or undefined when none matches.
   *
   * Routes are tried in registration order, so an earlier, more general pattern
   * wins over a later, more specific one. Each :name segment is decoded with
   * decodeURIComponent; a segment the pattern did not capture becomes the empty
   * string. The method comparison is exact and case-sensitive.
   */
  #match(
    method: string,
    pathname: string,
  ): { route: Route; params: Record<string, string> } | undefined {
    for (const route of this.#routes) {
      if (route.method !== method) continue;
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(m[i + 1] ?? '');
      });
      return { route, params };
    }
    return undefined;
  }

  /**
   * #context builds the RequestContext a route handler receives: the request,
   * response, path params and query string plus two lazy body readers.
   *
   * Both readers consume the request body on first call, so a handler should
   * call only one of them, once. readJson returns the body parsed as JSON and
   * an empty object for a blank body, throwing HubError invalid_message for
   * malformed JSON and the 413 HubError of readBody when the body exceeds the
   * size limit. parseJson validates that value with a zod schema and throws
   * HubError invalid_message with the issues listed under extra.issues as path:
   * message strings when it does not match. Nothing is read until a reader is
   * invoked.
   */
  #context(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
    query: URLSearchParams,
  ): RequestContext {
    const readJson = async (): Promise<unknown> => {
      const text = await readBody(req);
      if (text.trim() === '') return {};
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new HubError('invalid_message', 'request body is not valid JSON');
      }
    };
    const parseJson = async <T>(schema: ZodType<T>): Promise<T> => {
      const parsed = schema.safeParse(await readJson());
      if (!parsed.success) {
        throw new HubError('invalid_message', 'request body does not match the schema', {
          extra: { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
        });
      }
      return parsed.data;
    };
    return { req, res, params, query, readJson, parseJson };
  }
}
