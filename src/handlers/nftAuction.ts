import { u64 } from "@polkadot/types";
import { AccountId32 } from "@polkadot/types/interfaces/runtime";
import { Balance } from "@polkadot/types/interfaces";
import { EventHandler } from "./types";
import { NftAuction, NftAuctionBid } from "../types";
import { ensureAccount } from "./account";
import { getTokenId } from "./nft";

export const createNftDutchAuction: EventHandler = async ({ rawEvent }) => {
  const [auctionId, creator] = rawEvent.event.data as unknown as [
    u64,
    AccountId32
  ];
  await getNftAution(auctionId, creator, "dutch");
};

export const bidNftDutchAuction: EventHandler = async ({ rawEvent, event }) => {
  const [auctionId, owner, bidder, price] = rawEvent.event.data as unknown as [
    u64,
    AccountId32,
    AccountId32,
    Balance
  ];
  const nftAuction = await getNftAution(auctionId, owner, "dutch");
  const bidderAccount = await ensureAccount(bidder.toString());
  const bid = NftAuctionBid.create({
    id: event.id,
    bidderId: bidderAccount.id,
    tokenId: nftAuction.tokenId,
    price: price.toBigInt(),
    bidAt: event.blockNumber,
    extrinsicId: event.extrinsicId,
    timestamp: event.timestamp,
  });
  await bid.save();
  nftAuction.currentBidId = bid.id;
  await nftAuction.save();
};

export const cancelNftDutchAuction: EventHandler = async ({ rawEvent }) => {
  const [auctionId, owner] = rawEvent.event.data as unknown as [
    u64,
    AccountId32
  ];
  const nftAuction = await getNftAution(auctionId, owner, "dutch");
  nftAuction.isRemoved = true;
  await nftAuction.save();
};

export const redeemNftDutchAuction: EventHandler = async ({
  rawEvent,
  event,
}) => {
  const [auctionId, owner, bidder, price] = rawEvent.event.data as unknown as [
    u64,
    AccountId32,
    AccountId32,
    Balance
  ];
  const nftAuction = await getNftAution(auctionId, owner, "dutch");
  if (!nftAuction.currentBidId) {
    const bidderAccount = await ensureAccount(bidder.toString());
    const bid = NftAuctionBid.create({
      id: event.id,
      bidderId: bidderAccount.id,
      tokenId: nftAuction.tokenId,
      price: price.toBigInt(),
      bidAt: event.blockNumber,
      extrinsicId: event.extrinsicId,
      timestamp: event.timestamp,
    });
    await bid.save();
    nftAuction.currentBidId = bid.id;
  }

  nftAuction.isRedeemed = true;
  await nftAuction.save();
};

export const createNftEnglishAuction: EventHandler = async ({ rawEvent }) => {
  const [auctionId, creator] = rawEvent.event.data as unknown as [
    u64,
    AccountId32
  ];
  await getNftAution(auctionId, creator, "english");
};

export const bidNftEnglishAuction: EventHandler = async ({
  rawEvent,
  event,
}) => {
  const [auctionId, owner, bidder, price] = rawEvent.event.data as unknown as [
    u64,
    AccountId32,
    AccountId32,
    Balance
  ];
  const nftAuction = await getNftAution(auctionId, owner, "english");
  const bidderAccount = await ensureAccount(bidder.toString());
  const bid = NftAuctionBid.create({
    id: event.id,
    bidderId: bidderAccount.id,
    tokenId: nftAuction.tokenId,
    price: price.toBigInt(),
    bidAt: event.blockNumber,
    extrinsicId: event.extrinsicId,
    timestamp: event.timestamp,
  });
  await bid.save();
  nftAuction.currentBidId = bid.id;
  await nftAuction.save();
};

export const cancelNftEnglishAuction: EventHandler = async ({
  rawEvent,
  event,
}) => {
  const [auctionId, owner] = rawEvent.event.data as unknown as [
    u64,
    AccountId32
  ];
  const nftAuction = await getNftAution(auctionId, owner, "english");
  nftAuction.isRemoved = true;
  await nftAuction.save();
};

export const redeemNftEnglishAuction: EventHandler = async ({ rawEvent }) => {
  const [auctionId, owner] = rawEvent.event.data as unknown as [
    u64,
    AccountId32
  ];
  const nftAuction = await getNftAution(auctionId, owner, "english");
  nftAuction.isRedeemed = true;
  await nftAuction.save();
};

export async function getNftAution(
  auctionId: u64,
  creator: AccountId32,
  kind: "dutch" | "english"
) {
  const id = auctionId.toString();
  let nftAuction = await NftAuction.get(id);
  if (!nftAuction) {
    if (kind === "dutch") {
      const maybeDutchAuction = await api.query.nftAuction.dutchAuctions(
        creator,
        auctionId
      );
      const dutchDetails = maybeDutchAuction.unwrap();
      const creatorAccount = await ensureAccount(creator.toString());
      nftAuction = NftAuction.create({
        id,
        creatorId: creatorAccount.id,
        tokenId: getTokenId(dutchDetails.classId, dutchDetails.tokenId),
        quantity: dutchDetails.quantity.toBigInt(),
        deposit: dutchDetails.deposit.toBigInt(),
        dutch: {
          maxPrice: dutchDetails.maxPrice.toString(),
          mixPrice: dutchDetails.minPrice.toString(),
        },
        openAt: dutchDetails.openAt.toBigInt(),
        deadline: dutchDetails.deadline.toBigInt(),
      });
    } else {
      const maybeEnglishAuction = await api.query.nftAuction.englishAuctions(
        creator,
        auctionId
      );
      const englishDetails = maybeEnglishAuction.unwrap();
      const creatorAccount = await ensureAccount(creator.toString());
      nftAuction = NftAuction.create({
        id,
        creatorId: creatorAccount.id,
        tokenId: getTokenId(englishDetails.classId, englishDetails.tokenId),
        quantity: englishDetails.quantity.toBigInt(),
        deposit: englishDetails.deposit.toBigInt(),
        english: {
          minRaisePrice: englishDetails.minRaisePrice.toString(),
          initPrice: englishDetails.initPrice.toString(),
        },
        openAt: englishDetails.openAt.toBigInt(),
        deadline: englishDetails.deadline.toBigInt(),
      });
    }
    await nftAuction.save();
  }
  return nftAuction;
}
