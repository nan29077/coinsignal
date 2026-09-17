import { createHash, createHmac, randomUUID } from "node:crypto";
import { AppError, upstream } from "../errors.ts";
import type { Exchange } from "../settings.ts";
import { httpFetch } from "./http.ts";
import { markets } from "./public.ts";

export type Balance = { currency: string; available: number; locked: number; avgPrice: number };
export type OrderState = {
  /** true once the exchange will not fill any more of this order */
  final: boolean;
  state: string;
  executedQty: number;
  executedKrw: number;
  feeKrw: number;
};

export interface LiveClient {
  readonly exchange: Exchange;
  balances(): Promise<Balance[]>;
  marketBuy(symbol: string, krw: number, clientId: string): Promise<string>;
  marketSell(symbol: string, qty: number, clientId: string): Promise<string>;
  /** Look up by exchange id when known, otherwise by our client id (used to recover from timeouts). */
  getOrder(symbol: string, ref: { exchangeOrderId?: string | null; clientId: string }): Promise<OrderState | null>;
}

const n = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Number(v) : 0) || 0;
const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

/** Minimal HS256/HS512 JWT signer (avoids an extra dependency). */
export function signJwt(payload: Record<string, unknown>, secret: string, alg: "HS256" | "HS512") {
  const head = b64url(JSON.stringify({ alg, typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac(alg === "HS256" ? "sha256" : "sha512", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

/** Upbit/Bithumb: request params rendered as an unencoded query string, then SHA-512. */
export function queryString(params: Record<string, string>) {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** Exchanges reject >8 decimals; always round quantities down. */
export function floorTo(value: number, unit: number) {
  if (!(unit > 0) || !(value > 0)) return Math.max(0, value || 0);
  const decimals = Math.min(8, Math.max(0, Math.ceil(-Math.log10(unit) - 1e-9)));
  // relative epsilon absorbs binary float error (0.57 / 1e-8 = 56999999.99999999)
  const steps = Math.floor((value / unit) * (1 + 1e-12));
  return Number((steps * unit).toFixed(decimals));
}
const qtyString = (q: number) => floorTo(q, 1e-8).toFixed(8).replace(/\.?0+$/, "");
const krwString = (k: number) => String(Math.floor(k));

/**
 * Exchange error. `uncertain` means the request may have reached the exchange and been executed
 * (network failure, timeout while reading, 5xx) — callers must verify by client order id.
 */
export class ExchangeError extends AppError {
  constructor(
    message: string,
    public httpStatus: number,
    public uncertain: boolean,
    public exchangeCode = "",
  ) {
    super(message, httpStatus === 401 || httpStatus === 403 ? 400 : 502, "exchange");
  }
}

async function send(label: string, url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  let text: string;
  try {
    res = await httpFetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    text = await res.text();
  } catch (e) {
    throw new ExchangeError(`${label} 연결 실패 (${e instanceof Error ? e.name : "network"})`, 0, true);
  }
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const e = (data as { error?: { message?: string; name?: string } } | null)?.error;
    throw new ExchangeError(`${label} 오류 ${res.status}: ${e?.message ?? e?.name ?? text.slice(0, 160)}`, res.status, res.status >= 500, e?.name ?? "");
  }
  return data;
}

// ------------------------------------------------------------------ Upbit / Bithumb (shared format)
type UbOrder = { state: string; executed_volume?: string; paid_fee?: string; trades?: { funds?: string; volume?: string }[]; executed_funds?: string };

function ubState(o: UbOrder): OrderState {
  const executedQty = n(o.executed_volume);
  const executedKrw = o.trades?.length ? o.trades.reduce((s, t) => s + n(t.funds), 0) : n(o.executed_funds);
  return { final: o.state === "done" || o.state === "cancel", state: o.state, executedQty, executedKrw, feeKrw: n(o.paid_fee) };
}

class UpbitLike implements LiveClient {
  constructor(
    readonly exchange: "upbit" | "bithumb",
    private key: string,
    private secret: string,
  ) {}
  private get host() {
    return this.exchange === "upbit" ? "https://api.upbit.com" : "https://api.bithumb.com";
  }
  private get label() {
    return this.exchange === "upbit" ? "업비트" : "빗썸";
  }
  private token(params?: Record<string, string>) {
    const payload: Record<string, unknown> = { access_key: this.key, nonce: randomUUID() };
    if (this.exchange === "bithumb") payload.timestamp = Date.now();
    if (params && Object.keys(params).length) {
      payload.query_hash = createHash("sha512").update(queryString(params), "utf8").digest("hex");
      payload.query_hash_alg = "SHA512";
    }
    return signJwt(payload, this.secret, this.exchange === "upbit" ? "HS512" : "HS256");
  }
  private get(path: string, params?: Record<string, string>) {
    const qs = params ? `?${queryString(params)}` : "";
    return send(this.label, `${this.host}${path}${qs}`, { headers: { Authorization: `Bearer ${this.token(params)}`, Accept: "application/json" } });
  }
  private post(path: string, body: Record<string, string>) {
    return send(this.label, `${this.host}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token(body)}`, "Content-Type": "application/json; charset=utf-8", Accept: "application/json" },
      body: JSON.stringify(body),
    });
  }
  async balances() {
    const rows = (await this.get("/v1/accounts")) as { currency: string; balance: string; locked: string; avg_buy_price: string }[];
    if (!Array.isArray(rows)) throw upstream(`${this.label} 잔고 형식이 올바르지 않습니다.`);
    return rows.map((r) => ({ currency: r.currency.toUpperCase(), available: n(r.balance), locked: n(r.locked), avgPrice: n(r.avg_buy_price) }));
  }
  private async order(body: Record<string, string>, clientId: string) {
    const idKey = this.exchange === "upbit" ? "identifier" : "client_order_id";
    const typeKey = this.exchange === "upbit" ? "ord_type" : "order_type";
    const { ord_type, ...rest } = body;
    const payload = { ...rest, [typeKey]: ord_type, [idKey]: clientId };
    const path = this.exchange === "upbit" ? "/v1/orders" : "/v2/orders";
    const d = (await this.post(path, payload)) as { uuid?: string; order_id?: string };
    const id = d?.uuid ?? d?.order_id;
    if (!id) throw new ExchangeError(`${this.label} 주문 응답에 주문 ID가 없습니다.`, 200, true);
    return id;
  }
  marketBuy(symbol: string, krw: number, clientId: string) {
    return this.order({ market: `KRW-${symbol}`, side: "bid", ord_type: "price", price: krwString(krw) }, clientId);
  }
  marketSell(symbol: string, qty: number, clientId: string) {
    return this.order({ market: `KRW-${symbol}`, side: "ask", ord_type: "market", volume: qtyString(qty) }, clientId);
  }
  async getOrder(_symbol: string, ref: { exchangeOrderId?: string | null; clientId: string }) {
    const params: Record<string, string> = ref.exchangeOrderId
      ? { uuid: ref.exchangeOrderId }
      : this.exchange === "upbit"
        ? { identifier: ref.clientId }
        : { client_order_id: ref.clientId };
    try {
      return ubState((await this.get("/v1/order", params)) as UbOrder);
    } catch (e) {
      if (e instanceof ExchangeError && e.httpStatus === 404) return null;
      throw e;
    }
  }
}

// ------------------------------------------------------------------ Coinone v2.1
class Coinone implements LiveClient {
  readonly exchange = "coinone" as const;
  constructor(
    private token: string,
    private secret: string,
  ) {}
  private async call(path: string, body: Record<string, unknown>) {
    const payload = Buffer.from(JSON.stringify({ access_token: this.token, nonce: randomUUID(), ...body }), "utf8").toString("base64");
    const signature = createHmac("sha512", this.secret).update(payload).digest("hex");
    const d = (await send("코인원", `https://api.coinone.co.kr${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-COINONE-PAYLOAD": payload, "X-COINONE-SIGNATURE": signature },
      body: payload,
    })) as { result?: string; error_code?: string; error_msg?: string } & Record<string, unknown>;
    if (d?.result !== "success") throw new ExchangeError(`코인원 오류 ${d?.error_code ?? ""}: ${d?.error_msg ?? "요청 실패"}`, 400, false, String(d?.error_code ?? ""));
    return d;
  }
  async balances() {
    const d = await this.call("/v2.1/account/balance/all", {});
    const rows = d.balances as { currency: string; available: string; limit: string; average_price: string }[];
    return rows.map((r) => ({ currency: r.currency.toUpperCase(), available: n(r.available), locked: n(r.limit), avgPrice: n(r.average_price) }));
  }
  private async unit(symbol: string) {
    return (await markets("coinone")).find((m) => m.symbol === symbol)?.qtyUnit ?? 1e-8;
  }
  async marketBuy(symbol: string, krw: number, clientId: string) {
    const d = await this.call("/v2.1/order", { side: "BUY", quote_currency: "KRW", target_currency: symbol, type: "MARKET", amount: krwString(krw), user_order_id: clientId });
    return String(d.order_id);
  }
  async marketSell(symbol: string, qty: number, clientId: string) {
    const q = floorTo(qty, await this.unit(symbol));
    if (!(q > 0)) throw new AppError("매도 수량이 최소 단위보다 작습니다.");
    const d = await this.call("/v2.1/order", { side: "SELL", quote_currency: "KRW", target_currency: symbol, type: "MARKET", qty: String(q), user_order_id: clientId });
    return String(d.order_id);
  }
  async getOrder(symbol: string, ref: { exchangeOrderId?: string | null; clientId: string }) {
    try {
      const d = await this.call("/v2.1/order/detail", {
        ...(ref.exchangeOrderId ? { order_id: ref.exchangeOrderId } : { user_order_id: ref.clientId }),
        quote_currency: "KRW",
        target_currency: symbol,
      });
      const o = d.order as Record<string, string>;
      const status = String(o.status);
      const avg = n(o.average_executed_price);
      // Fee is normally charged in KRW; convert if the exchange reports it in the coin.
      const feeInCoin = o.fee_currency && String(o.fee_currency).toUpperCase() !== "KRW";
      return {
        final: status === "FILLED" || status.startsWith("CANCELED") || status === "PARTIALLY_CANCELED",
        state: status,
        executedQty: n(o.executed_qty),
        executedKrw: n(o.traded_amount) || n(o.executed_qty) * avg,
        feeKrw: feeInCoin ? n(o.fee) * avg : n(o.fee),
      };
    } catch (e) {
      if (e instanceof ExchangeError && /order.?not.?found|존재하지 않/i.test(e.message)) return null;
      throw e;
    }
  }
}

export function liveClient(exchange: Exchange, creds: { key: string; secret: string }): LiveClient {
  return exchange === "coinone" ? new Coinone(creds.key, creds.secret) : new UpbitLike(exchange, creds.key, creds.secret);
}
