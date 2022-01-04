import { u64 } from "@polkadot/types";
import { AccountId32 } from "@polkadot/types/interfaces/runtime";
import { Balance } from "@polkadot/types/interfaces";
import { EventHandler } from "./types";
import {
  NftOffer,
  NftOrder,
  NftOrderDeal,
  NftOrderStatus,
  NftOfferStatus,
} from "../types";
import { ensureAccount } from "./account";
import { getTokenId } from "./nft";

export const createNftOrder: EventHandler = async ({ rawEvent }) => {
  const [orderId, creator] = rawEvent.event.data as unknown as [
    u64,
    AccountId32
  ];
  await getNftOrder(orderId, creator);
};

export const dealNftOrder: EventHandler = async ({ rawEvent, event }) => {
  const [orderId, seller, buyer, quantity, fee] = rawEvent.event
    .data as unknown as [u64, AccountId32, AccountId32, u64, Balance];
  const nftOrder = await getNftOrder(orderId, seller);
  const maybeOrderDetails = await api.query.nftOrder.orders(seller, orderId);
  const orderDetails = maybeOrderDetails.unwrapOrDefault();
  const buyerAccount = await ensureAccount(buyer.toString());
  nftOrder.quantity = orderDetails.quantity.toBigInt();
  if (nftOrder.quantity === BigInt(0)) {
    nftOrder.status = NftOrderStatus.FULL_DEAIL;
  } else {
    nftOrder.status = NftOrderStatus.PARTIAL_DEAL;
  }
  await nftOrder.save();
  const orderDeal = NftOrderDeal.create({
    id: event.extrinsicId,
    buyerId: buyerAccount.id,
    tokenId: nftOrder.tokenId,
    orderId: nftOrder.id,
    quantity: quantity.toBigInt(),
    fee: fee.toBigInt(),
    extrinsicId: event.extrinsicId,
    blockNumber: event.blockNumber,
    timestamp: event.timestamp,
  });
  await orderDeal.save();
};

export const removeNftOrder: EventHandler = async ({ rawEvent }) => {
  const [orderId, creator] = rawEvent.event.data as unknown as [
    u64,
    AccountId32
  ];
  const nftOrder = await getNftOrder(orderId, creator);
  if (nftOrder.quantity === nftOrder.totalQuantity) {
    nftOrder.status = NftOrderStatus.CANCEL;
  } else {
    nftOrder.status = NftOrderStatus.PARTIAL_CANCEL;
  }
  await nftOrder.save();
};

export const createNftOffer: EventHandler = async ({ rawEvent }) => {
  const [offerId, creator] = rawEvent.event.data as unknown as [
    u64,
    AccountId32
  ];
  await getNftOffer(offerId, creator);
};

export const dealNftOffer: EventHandler = async ({ rawEvent }) => {
  const [offerId, buyer, , ,] = rawEvent.event.data as unknown as [
    u64,
    AccountId32,
    AccountId32,
    u64,
    Balance
  ];
  const nftOffer = await getNftOffer(offerId, buyer);
  nftOffer.status = NftOfferStatus.DEAL;
  await nftOffer.save();
};

export const removeNftOffer: EventHandler = async ({ rawEvent }) => {
  const [offerId, creator] = rawEvent.event.data as unknown as [
    u64,
    AccountId32
  ];
  const nftOffer = await getNftOffer(offerId, creator);
  nftOffer.status = NftOfferStatus.CANCEL;
  await nftOffer.save();
};

export async function getNftOrder(orderId: u64, creator: AccountId32) {
  const id = orderId.toString();
  let nftOrder = await NftOrder.get(id);
  if (!nftOrder) {
    const maybeOrderDetails = await api.query.nftOrder.orders(creator, orderId);
    const orderDetails = maybeOrderDetails.unwrap();
    const creatorAccount = await ensureAccount(creator.toString());
    nftOrder = NftOrder.create({
      id,
      creatorId: creatorAccount.id,
      tokenId: getTokenId(orderDetails.classId, orderDetails.tokenId),
      totalQuantity: orderDetails.totalQuantity.toBigInt(),
      quantity: orderDetails.quantity.toBigInt(),
      price: orderDetails.price.toBigInt(),
      deposit: orderDetails.deposit.toBigInt(),
      status: NftOrderStatus.NORMAL,
    });
    if (orderDetails.deadline.isSome) {
      nftOrder.deadline = orderDetails.deadline.unwrap().toBigInt();
    }
    await nftOrder.save();
  }
  return nftOrder;
}

async function getNftOffer(offerId: u64, creator: AccountId32) {
  const id = offerId.toString();
  let nftOffer = await NftOffer.get(id);
  if (!nftOffer) {
    const maybeOfferDetails = await api.query.nftOrder.offers(creator, offerId);
    const offerDetails = maybeOfferDetails.unwrap();
    const creatorAccount = await ensureAccount(creator.toString());
    nftOffer = NftOffer.create({
      id,
      creatorId: creatorAccount.id,
      tokenId: getTokenId(offerDetails.classId, offerDetails.tokenId),
      quantity: offerDetails.quantity.toBigInt(),
      price: offerDetails.price.toBigInt(),
      status: NftOfferStatus.NORMAL,
    });
    if (offerDetails.deadline.isSome) {
      nftOffer.deadline = offerDetails.deadline.unwrap().toBigInt();
    }
    await nftOffer.save();
  }
  return nftOffer;
}
