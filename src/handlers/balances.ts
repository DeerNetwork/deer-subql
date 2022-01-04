import { AccountId32 } from "@polkadot/types/interfaces/runtime";
import { Balance } from "@polkadot/types/interfaces";

import { EventHandler } from "./types";
import { Transfer } from "../types";
import { ensureAccount } from "./account";

export const createTransfer: EventHandler = async ({ rawEvent, event }) => {
  const [from, to, amount] = rawEvent.event.data as unknown as [
    AccountId32,
    AccountId32,
    Balance
  ];
  const fromAccount = await ensureAccount(from.toString());
  const toAccount = await ensureAccount(to.toString());
  let transfer = await Transfer.get(event.id);
  if (transfer) return;
  transfer = Transfer.create({
    id: event.id,
    fromId: fromAccount.id,
    toId: toAccount.id,
    amount: amount.toBigInt(),
    extrinsicId: event.extrinsicId,
    blockNumber: event.blockNumber,
    timestamp: event.timestamp,
  });
  await transfer.save();
};
