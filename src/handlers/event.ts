import { SubstrateEvent } from "@subql/types";
import { Dispatcher } from "./utils/dispatcher";
import { ensureBlock } from "./block";
import { Event } from "../types/models";
import { getKVData } from "./utils";
import { ensuerExtrinsic } from "./extrinsic";
import { DispatchedEventData } from "./types";
import {
  createNftClass,
  createNftToken,
  createNftTransferHistory,
  createNftBurnHistory,
  updateNftToken,
} from "./nft";
import {
  createNftOrder,
  createNftOffer,
  dealNftOffer,
  removeNftOffer,
  removeNftOrder,
  dealNftOrder,
} from "./nftOrder";
import {
  createNftDutchAuction,
  createNftEnglishAuction,
  bidNftDutchAuction,
  bidNftEnglishAuction,
  cancelNftDutchAuction,
  cancelNftEnglishAuction,
  redeemNftDutchAuction,
  redeemNftEnglishAuction,
} from "./nftAuction";
import { createTransfer } from "./balances";
import { createFile, registerNode, newSession } from "./fileStorage";

const dispatch = new Dispatcher<DispatchedEventData>();

dispatch.batchRegist([
  // balances
  { key: "balances-Transfer", handler: createTransfer },
  // nft
  { key: "nft-CreatedClass", handler: createNftClass },
  { key: "nft-MintedToken", handler: createNftToken },
  { key: "nft-TransferredToken", handler: createNftTransferHistory },
  { key: "nft-BurnedToken", handler: createNftBurnHistory },
  { key: "nft-UpdatedToken", handler: updateNftToken },
  // nftOrder
  { key: "nftOrder-CreatedOrder", handler: createNftOrder },
  { key: "nftOrder-DealedOrder", handler: dealNftOrder },
  { key: "nftOrder-RemovedOrder", handler: removeNftOrder },
  { key: "nftOrder-CreatedOffer", handler: createNftOffer },
  { key: "nftOrder-DealedOffer", handler: dealNftOffer },
  { key: "nftOrder-RemovedOffer", handler: removeNftOffer },
  // nftAuction
  { key: "nftAuction-CreatedDutchAuction", handler: createNftDutchAuction },
  { key: "nftAuction-BidDutchAuction", handler: bidNftDutchAuction },
  { key: "nftAuction-CanceledDutchAuction", handler: cancelNftDutchAuction },
  { key: "nftAuction-RedeemedDutchAuction", handler: redeemNftDutchAuction },
  { key: "nftAuction-CreatedEnglishAuction", handler: createNftEnglishAuction },
  { key: "nftAuction-BidEnglishAuction", handler: bidNftEnglishAuction },
  {
    key: "nftAuction-CanceledEnglishAuction",
    handler: cancelNftEnglishAuction,
  },
  {
    key: "nftAuction-RedeemedEnglishAuction",
    handler: redeemNftEnglishAuction,
  },
  // fileStorage
  { key: "fileStorage-FileAdded", handler: createFile },
  { key: "fileStorage-NodeRegistered", handler: registerNode },
  { key: "fileStorage-NewSession", handler: newSession },
]);

export async function ensureEvnet(event: SubstrateEvent) {
  const block = await ensureBlock(event.block);

  const idx = event.idx;
  const recordId = `${block.number}-${idx}`;

  let data = await Event.get(recordId);

  if (!data) {
    data = new Event(recordId);
    data.index = idx;
    data.blockId = block.id;
    data.blockNumber = block.number;
    data.timestamp = block.timestamp;

    await data.save();
  }

  return data;
}

export async function createEvent(event: SubstrateEvent) {
  const extrinsic = await (event.extrinsic
    ? ensuerExtrinsic(event.extrinsic)
    : undefined);

  const data = await ensureEvnet(event);

  const section = event.event.section;
  const method = event.event.method;
  const eventData = getKVData(event.event.data);

  data.section = section;
  data.method = method;
  data.data = eventData;

  if (extrinsic) {
    data.extrinsicId = extrinsic.id;
  }

  await dispatch.dispatch(`${section}-${data.method}`, {
    event: data,
    rawEvent: event,
  });

  await data.save();

  return data;
}
