import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import { connect, isIP, type Socket } from 'node:net';
import { Readable, Writable } from 'node:stream';

export const WECHAT_API_HOST = 'api.weixin.qq.com';
export type Peer = { address: string; port: number };
export type WechatRequest = (url: string, options: RequestInit, observe?: (peer: Peer) => void) => Promise<Response>;

function observeSocket(socket: Socket | undefined, observe?: (peer: Peer) => void) {
  if (socket?.remoteAddress && socket.remotePort) observe?.({address:socket.remoteAddress,port:socket.remotePort});
}

const fetchScope = new AsyncLocalStorage<boolean>();
export const fetchWechat: WechatRequest = async (url, options, observe) => {
  if (!observe) return fetch(url, options);
  const opened = channel('undici:client:connected');
  const record = (value: unknown) => {
    const event = value as { connectParams?: { hostname?: string }; socket?: Socket };
    if (fetchScope.getStore() && event.connectParams?.hostname === WECHAT_API_HOST) observeSocket(event.socket, observe);
  };
  opened.subscribe(record);
  try { return await fetchScope.run(true, () => fetch(url, options)); }
  finally { opened.unsubscribe(record); }
};

type ProxyRequest = Writable & { abort(): void };
type ProxyCallback = (error: Error | null, response: http.IncomingMessage, body: Buffer) => void;
// Maintained API-compatible fork of the request client used by Tencent wxapi.js.
// The client honors the container's existing HTTP(S)_PROXY and NO_PROXY settings.
const requestWithEnvironment: (options: Record<string, unknown>, callback: ProxyCallback) => ProxyRequest = require('@cypress/request');

function responseHeaders(incoming: http.IncomingMessage) {
  const headers = new Headers();
  const marker = incoming.headers['x-openapi-seqid'];
  if (typeof marker === 'string' && marker.trim()) headers.set('x-openapi-seqid', 'present');
  return headers;
}

function responseFrom(incoming: http.IncomingMessage, body: BodyInit | null) {
  const status = incoming.statusCode ?? 502;
  return new Response([204,205,304].includes(status) ? null : body,{status,headers:responseHeaders(incoming)});
}

function postBody(request: Writable, message: Request, json?: string) {
  if (json !== undefined || !message.body) {
    request.end(json);
    return;
  }
  const body = Readable.fromWeb(message.body as Parameters<typeof Readable.fromWeb>[0]);
  body.once('error', error => request.destroy(error));
  request.once('close', () => body.destroy());
  body.pipe(request);
}

function nodeRequest(withoutAgent: boolean): WechatRequest {
  return (url, options, observe) => {
    const message = new Request(url, options);
    const headers = new Headers(message.headers);
    const json = typeof options.body === 'string' ? options.body : undefined;
    if (json !== undefined) headers.set('content-length', String(Buffer.byteLength(json)));
    const protocol = message.url.startsWith('https:') ? https : http;
    return new Promise((resolve,reject) => {
      const request = protocol.request(message.url,{method:message.method,headers:Object.fromEntries(headers),
        signal:message.signal,agent:withoutAgent ? false : protocol.globalAgent,
        ...(protocol===https?{rejectUnauthorized:true}:{})},incoming => {
        observeSocket(incoming.socket, observe);
        try {
          if ([204,205,304].includes(incoming.statusCode ?? 0)) {
            incoming.resume();
            resolve(responseFrom(incoming,null));
          } else {
            resolve(responseFrom(incoming,Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>));
          }
        } catch (error) { incoming.destroy(); reject(error); }
      });
      request.once('error', error => reject(new TypeError('微信云调用连接失败',{cause:error})));
      postBody(request,message,json);
    });
  };
}

export const globalAgentWechat = nodeRequest(false);
export const noAgentWechat = nodeRequest(true);

/** OpenAPI sidecar mode of wxapi.js, with redirect and socket-reuse retries disabled. */
export const officialStyleWechat: WechatRequest = (url, options, observe) => {
  const message = new Request(url,options);
  const headers = new Headers(message.headers);
  const json = typeof options.body === 'string' ? options.body : undefined;
  if (json !== undefined) headers.set('content-length', String(Buffer.byteLength(json)));
  return new Promise((resolve,reject) => {
    if (message.signal.aborted) { reject(message.signal.reason); return; }
    const outbound = requestWithEnvironment({url:message.url,method:message.method,headers:Object.fromEntries(headers),
      followRedirect:false,followAllRedirects:false,agentOptions:{keepAlive:false},pool:{},encoding:null,strictSSL:true},
    (error,incoming,body) => {
      message.signal.removeEventListener('abort',abort);
      if (error) { reject(new TypeError('微信云调用连接失败',{cause:error})); return; }
      observeSocket(incoming.socket,observe);
      try { resolve(responseFrom(incoming,new Uint8Array(body))); }
      catch (failure) { reject(failure); }
    });
    const abort = () => { outbound.abort(); reject(message.signal.reason); };
    message.signal.addEventListener('abort',abort,{once:true});
    postBody(outbound,message,json);
  });
};

type NetworkError = { code: string; address?: string; port?: number; syscall?: string };
export function networkErrors(error: unknown, depth = 0): NetworkError[] {
  if (!error || typeof error !== 'object' || depth > 3) return [];
  const value = error as { code?: unknown; address?: unknown; port?: unknown; syscall?: unknown; cause?: unknown; errors?: unknown[] };
  const result: NetworkError[] = [];
  if (typeof value.code === 'string' && /^(?:E[A-Z][A-Z0-9_]{1,40}|UND_ERR_[A-Z_]+|HPE_[A-Z_]+|ABORT_ERR|CERT_[A-Z_]+|UNABLE_TO_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)$/.test(value.code)) {
    result.push({code:value.code,
      ...(typeof value.address==='string' && isIP(value.address) ? {address:value.address} : {}),
      ...(typeof value.port==='number' && value.port>0 && value.port<=65535 ? {port:value.port} : {}),
      ...(typeof value.syscall==='string' && /^[A-Za-z][A-Za-z0-9]{0,30}$/.test(value.syscall) ? {syscall:value.syscall} : {})});
  }
  return result.concat(networkErrors(value.cause,depth+1),...(Array.isArray(value.errors)
    ? value.errors.slice(0,6).map(item=>networkErrors(item,depth+1)) : []));
}

function tcp(port: number) {
  return new Promise<{ok:boolean; peer?:Peer; errors?:NetworkError[]}>(resolve => {
    const socket = connect({host:WECHAT_API_HOST,port});
    socket.once('connect',() => {
      const peer=socket.remoteAddress && socket.remotePort ? {address:socket.remoteAddress,port:socket.remotePort} : undefined;
      resolve({ok:true,peer});
      socket.destroy();
    });
    socket.setTimeout(4_000,()=>{ resolve({ok:false,errors:[{code:'ETIMEDOUT',port,syscall:'connect'}]}); socket.destroy(); });
    socket.once('error',error=>resolve({ok:false,errors:networkErrors(error)}));
  });
}

export async function inspectWechatNetwork() {
  const deadline = AbortSignal.timeout(4_000);
  const dns = Promise.race([lookup(WECHAT_API_HOST,{all:true}).then(addresses=>({addresses:addresses.slice(0,12)}),error=>({errors:networkErrors(error)})),
    new Promise(resolve=>deadline.addEventListener('abort',()=>resolve({errors:[{code:'ETIMEDOUT',syscall:'getaddrinfo'}]}),{once:true}))]);
  const [addresses,port80,port443] = await Promise.all([dns,tcp(80),tcp(443)]);
  return {node:process.versions.node,dns:addresses,tcp:{80:port80,443:port443},
    mounts:{legacyToken:existsSync('/.tencentcloudbase/wx/cloudbase_access_token'),certificate:existsSync('/app/cert/certificate.crt')},
    proxy:{http:!!(process.env.http_proxy || process.env.HTTP_PROXY),https:!!(process.env.https_proxy || process.env.HTTPS_PROXY),
      noProxy:!!(process.env.no_proxy || process.env.NO_PROXY),enableNodeProxy:process.env.NODE_USE_ENV_PROXY==='1'
        || process.execArgv.includes('--use-env-proxy') || /(?:^|\s)--use-env-proxy(?:\s|$)/.test(process.env.NODE_OPTIONS ?? ''),
      httpGlobalAgentProxy:!!(http.globalAgent as {options?:{proxyEnv?:object}}).options?.proxyEnv,
      tlsExtraCaConfigured:!!process.env.NODE_EXTRA_CA_CERTS},
    standardCredentialsConfigured:!!(process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET)};
}
