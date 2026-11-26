// Pump.fun launch sniper for the 6h bot sprint — rewritten from scratch.
//
// The bot watches every bonding curve from its CreateEvent and only ever
// buys a launch that already looks honest: the creator put real money in
// during the creation slot, a few real trades have printed, the early
// buyers are few enough that it is not a Sybil bundle, the creator has
// not sold a token, and the curve holds a sane amount of real SOL. One
// buy per coin, a fixed stake, and a fast exit — take profit at +25%,
// stop out at -20%, never hold longer than ten slots, and leave the
// moment the creator sells. In every batch the exits are worked out
// before any new entry, so a slot never spends money it is about to free.
//
// The whole thing is deterministic: no clock, no randomness, no I/O.
// The only iteration is over maps that grow in first-seen order, so the
// same replay always yields the same orders.

import {
  type Batch,
  type BotState,
  type OrderInput,
} from './vendor/agentfun-bot.ts';

/** Every knob the sniper takes, in plain units (lamports, slots, bps). */
export interface Params {
  /** Youngest age, in slots since the CreateEvent, at which a buy is allowed. */
  minAge: number;
  /** Oldest age, in slots since the CreateEvent, at which a buy is allowed. */
  maxAge: number;
  /** Trades that must already have printed on the curve before a buy. */
  minTrades: number;
  /** Smallest creator buy in the creation slot, in lamports. */
  minDevBuy: number;
  /** Largest creator buy in the creation slot, in lamports. */
  maxDevBuy: number;
  /** Fewest distinct non-creator buyers before a buy. */
  minBuyers: number;
  /** Most distinct non-creator buyers before a buy. */
  maxBuyers: number;
  /** Least real SOL, in lamports, the curve may hold at decision time. */
  minRealSol: number;
  /** Most real SOL, in lamports, the curve may hold at decision time. */
  maxRealSol: number;
  /** SOL to spend on one coin, in lamports, before the reserve cap. */
  stakeLamports: number;
  /** Smallest buy worth sending, in lamports; anything below is skipped. */
  minBuyLamports: number;
  /** Extra buys into a coin already held (0 means one buy per coin, ever). */
  maxAdds: number;
  /** Most pieces a buy may be split into (1 means never split). */
  maxSplit: number;
  /** Pieces the base buy is split into (1 means whole). */
  baseSplit: number;
  /** Take-profit level, in basis points above the all-in cost. */
  tpBps: number;
  /** Stop-loss level, in basis points below the all-in cost. */
  slBps: number;
  /** First partial take-profit level, in bps; a huge value disables it. */
  tp1Bps: number;
  /** Longest a position may be held, in slots from the buy decision. */
  maxHold: number;
  /** Sell everything the moment the creator sells. */
  exitOnDevSell: boolean;
  /** Slippage cap on buys and sells, in basis points. */
  buySlippageBps: number;
}

/**
 * Defaults: the 6h tuning documented in STRATEGY.md. main.ts overrides
 * every field, so these only matter to a caller that passes nothing.
 */
export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 10,
  minTrades: 4,
  minDevBuy: 500_000_000,
  maxDevBuy: 2_500_000_000,
  minBuyers: 0,
  maxBuyers: 10,
  minRealSol: 1_000_000_000,
  maxRealSol: 30_000_000_000,
  stakeLamports: 200_000_000,
  minBuyLamports: 5_000_000,
  maxAdds: 0,
  maxSplit: 1,
  baseSplit: 1,
  tpBps: 2500,
  slBps: 2000,
  tp1Bps: 1_000_000,
  maxHold: 10,
  exitOnDevSell: true,
  buySlippageBps: 10_000,
};

/** What the bot remembers about one mint, built up from the event stream. */
interface CoinWatch {
  mint: string;
  /** The curve's creator; empty until the first event names one. */
  creator: string;
  /** Slot of the CreateEvent; null when the mint was first seen later. */
  createdSlot: number | null;
  /** Lamports the creator bought in the creation slot. */
  creatorBuyLamports: bigint;
  /** Creator buys seen before the CreateEvent arrived, keyed by slot. */
  earlyCreatorBuys: Map<number, bigint>;
  /** Distinct wallets, other than the creator, that have bought. */
  buyers: Set<string>;
  /** The creator has sold at least once. */
  creatorSold: boolean;
  /** A buy has been sent for this coin; one buy per coin, ever. */
  buySent: boolean;
  /**
   * Slot the buy's tokens landed (the fill slot); the max-hold clock
   * runs from here. Set to the decision slot when the buy is sent and
   * corrected to the fill slot when the fill arrives.
   */
  buySlot: number | null;
  /** The first partial take-profit has already been taken. */
  partialTaken: boolean;
}

function freshWatch(mint: string): CoinWatch {
  return {
    mint,
    creator: '',
    createdSlot: null,
    creatorBuyLamports: 0n,
    earlyCreatorBuys: new Map(),
    buyers: new Set(),
    creatorSold: false,
    buySent: false,
    buySlot: null,
    partialTaken: false,
  };
}

export function createStrategy(params: Params): {
  onBatch(state: BotState, batch: Batch): OrderInput[];
} {
  /** Every mint ever seen, in first-seen order. */
  const watch = new Map<string, CoinWatch>();

  function noteFor(mint: string): CoinWatch {
    const found = watch.get(mint);
    if (found !== undefined) return found;
    const note = freshWatch(mint);
    watch.set(mint, note);
    return note;
  }

  /**
   * Fold this batch's events into the per-mint notes. The shim has
   * already folded the same events into its curve table; this keeps the
   * rug-filter facts the curve table does not carry.
   */
  function absorb(batch: Batch): void {
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        const note = noteFor(event.mint);
        note.creator = event.creator;
        note.createdSlot = event.slot;
        note.creatorBuyLamports = note.earlyCreatorBuys.get(event.slot) ?? 0n;
      } else if (event.event === 'TradeEvent') {
        const note = noteFor(event.mint);
        if (note.creator === '') note.creator = event.creator;
        const spent = BigInt(event.sol_amount);
        if (event.is_buy) {
          if (event.user === note.creator) {
            // The creator's own buy: only the creation slot counts.
            if (note.createdSlot !== null && event.slot === note.createdSlot) {
              note.creatorBuyLamports += spent;
            } else if (note.createdSlot === null) {
              const slot = event.slot;
              note.earlyCreatorBuys.set(slot, (note.earlyCreatorBuys.get(slot) ?? 0n) + spent);
            }
          } else {
            note.buyers.add(event.user);
          }
        } else if (event.user === note.creator) {
          note.creatorSold = true;
        }
      }
      // A CompleteEvent needs no note: the curve table already flags it,
      // and the exit planner skips completed curves.
    }
  }

  /**
   * A buy that came back rejected or failed never landed, so the coin
   * may be tried again while it is still fresh. A filled buy starts the
   * max-hold clock at the slot its tokens actually landed, not the slot
   * the order was decided in (fills land two slots later). Filled buys
   * need no other bookkeeping: the position table carries them.
   */
  function settleFills(batch: Batch): void {
    for (const fill of batch.fills) {
      if (fill.side === 'buy' && fill.status === 'filled') {
        const note = watch.get(fill.mint);
        if (note !== undefined) note.buySlot = fill.slot;
        continue;
      }
      if (fill.side !== 'buy') continue;
      const note = watch.get(fill.mint);
      if (note === undefined) continue;
      note.buySent = false;
      note.buySlot = null;
    }
  }

  /**
   * Decide this batch's sells. Every holding is checked against the
   * take-profit, the stop, the max hold and the creator-sell tripwire;
   * any one of them sells the whole position at once.
   */
  function planExits(state: BotState): OrderInput[] {
    const orders: OrderInput[] = [];
    const hundred = 10_000n;
    // Mints with a sell already in flight: the position table still shows
    // them until the fill lands, so without this guard every exit would
    // be sent twice and the duplicate rejected for insufficient tokens.
    const selling = new Set<string>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === 'sell') selling.add(pending.order.mint);
    }
    for (const [mint, holding] of state.positions) {
      if (selling.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const tokens = holding.token_amount;
      const cost = holding.cost_lamports;
      if (tokens <= 0n || cost <= 0n) continue;
      const tokenReserves = curve.virtual_token_reserves;
      if (tokenReserves <= 0n) continue;
      // What the holding is worth now, at the virtual price, in lamports.
      const value = (tokens * curve.virtual_quote_reserves) / tokenReserves;
      const tpLine = (cost * (hundred + BigInt(params.tpBps))) / hundred;
      const slLine = (cost * (hundred - BigInt(params.slBps))) / hundred;
      const note = watch.get(mint);
      let leave = value >= tpLine || value <= slLine;
      if (note !== undefined) {
        if (params.exitOnDevSell && note.creatorSold) leave = true;
        if (note.buySlot !== null && state.slot - note.buySlot >= params.maxHold) leave = true;
      }
      if (leave) {
        orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: params.buySlippageBps });
        continue;
      }
      // First partial take-profit: one half-slice at the tp1 level. The
      // 6h tuning sets tp1Bps far out of reach, so this never fires here;
      // the branch stays so the knob means what it says.
      if (note !== undefined && !note.partialTaken) {
        const tp1Line = (cost * (hundred + BigInt(params.tp1Bps))) / hundred;
        if (value >= tp1Line) {
          note.partialTaken = true;
          const half = tokens / 2n;
          if (half > 0n) {
            orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: params.buySlippageBps });
          }
        }
      }
    }
    return orders;
  }

  /**
   * Decide this batch's buys, appended after the exits. A coin qualifies
   * only while it is young, the rug filter passes, the reserve band
   * holds, and a slot is free; the buy is the stake capped at 1% of the
   * curve's real SOL, sent whole in a single order (maxSplit and
   * baseSplit are 1, so no splitting).
   */
  function planEntries(state: BotState, orders: OrderInput[]): void {
    const batchCap = state.hello.caps.max_orders_per_batch;
    const txFee = state.txFeeLamports();
    const openCap = state.hello.caps.max_open_positions;
    let plannedBuys = 0;
    let plannedSpend = 0n;
    for (const note of watch.values()) {
      if (orders.length >= batchCap) break;
      if (note.createdSlot === null) continue;
      const age = state.slot - note.createdSlot;
      if (age < params.minAge || age > params.maxAge) continue;
      if (note.buySent) continue;
      const curve = state.curves.get(note.mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.trades < params.minTrades) continue;
      if (note.creatorBuyLamports < BigInt(params.minDevBuy)) continue;
      if (note.creatorBuyLamports > BigInt(params.maxDevBuy)) continue;
      if (note.buyers.size < params.minBuyers || note.buyers.size > params.maxBuyers) continue;
      if (note.creatorSold) continue;
      const realSol = curve.real_quote_reserves;
      if (realSol < BigInt(params.minRealSol) || realSol > BigInt(params.maxRealSol)) continue;
      // Never hold the same coin twice, and never add: one buy per coin.
      if (state.positions.has(note.mint)) continue;
      if (state.committedPositionCount() + plannedBuys >= openCap) break;
      // The stake, capped at 1% of the curve's real SOL.
      let size = BigInt(params.stakeLamports);
      const reserveCap = state.maxBuyLamports(note.mint);
      if (size > reserveCap) size = reserveCap;
      if (size < BigInt(params.minBuyLamports)) continue;
      if (state.freeCashLamports() - plannedSpend < size + txFee) continue;
      note.buySent = true;
      note.buySlot = state.slot;
      plannedBuys += 1;
      plannedSpend += size + txFee;
      orders.push({
        side: 'buy',
        mint: note.mint,
        quote_lamports: size,
        max_slippage_bps: params.buySlippageBps,
      });
    }
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    absorb(batch);
    settleFills(batch);
    const orders = planExits(state);
    planEntries(state, orders);
    return orders;
  }

  return { onBatch };
}
