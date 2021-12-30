import { u32, u64, Bytes, Compact } from "@polkadot/types";
import { AccountId32 } from "@polkadot/types/interfaces/runtime";
import { isUtf8 } from "@polkadot/util";

import { PalletNftTransferReason } from "@polkadot/types/lookup";
import { EventHandler } from "./types";
import { NftMetadata } from "../types/interfaces";
import {
  NftClass,
  NftToken,
  NftTokenBurn,
  NftTokenOwner,
  NftTokenTransfer,
} from "../types";
import { ensureAccount } from "./account";

export const createNftClass: EventHandler = async ({ rawEvent }) => {
  const [classId] = rawEvent.event.data as unknown as [u32];
  await getNftClass(classId);
};

export const createNftToken: EventHandler = async ({ rawEvent }) => {
  const [classId, localTokenId, , tokenOwner] = rawEvent.event
    .data as unknown as [u32, u32, u64, AccountId32];
  await getNftToken(classId, localTokenId);
  await syncNftTokenOwner(classId, localTokenId, tokenOwner);
};

export const createNftTransferHistory: EventHandler = async ({
  rawEvent,
  event,
}) => {
  const [classId, localTokenId, quantity, from, to, reason] = rawEvent.event
    .data as unknown as [
    u32,
    u32,
    u64,
    AccountId32,
    AccountId32,
    PalletNftTransferReason
  ];
  const nftToken = await getNftToken(classId, localTokenId);

  const fromAccount = await ensureAccount(from.toString());
  const toAccount = await ensureAccount(to.toString());

  await syncNftTokenOwner(classId, localTokenId, from);
  await syncNftTokenOwner(classId, localTokenId, to);

  const transfer = NftTokenTransfer.create({
    id: event.id,
    tokenId: nftToken.id,
    quantity: quantity.toBigInt(),
    fromId: fromAccount.id,
    toId: toAccount.id,
    reason: reason.toString(),
    extrinsicId: event.extrinsicId,
    timestamp: event.timestamp,
  });
  await transfer.save();
};

export const createNftBurnHistory: EventHandler = async ({
  rawEvent,
  event,
}) => {
  const [classId, localTokenId, quantity, owner] = rawEvent.event
    .data as unknown as [u32, u32, u64, AccountId32];
  const nftToken = await getNftToken(classId, localTokenId);
  const maybeTokenDetails = await api.query.nft.tokens(classId, localTokenId);
  nftToken.quantity = maybeTokenDetails.unwrapOrDefault().quantity.toBigInt();
  await nftToken.save();
  const ownerAccount = await ensureAccount(owner.toString());
  await syncNftTokenOwner(classId, localTokenId, owner);
  const burn = NftTokenBurn.create({
    id: event.id,
    tokenId: nftToken.id,
    quantity: quantity.toBigInt(),
    ownerId: ownerAccount.id,
    extrinsicId: event.extrinsicId,
    timestamp: event.timestamp,
  });
  await burn.save();
};

export const updateNftToken: EventHandler = async ({ rawEvent, event }) => {
  const [classId, localTokenId] = rawEvent.event.data as unknown as [u32, u32];
  const nftToken = await getNftToken(classId, localTokenId);
  const maybeTokenDetails = await api.query.nft.tokens(classId, localTokenId);
  const tokenDetails = maybeTokenDetails.unwrap();
  Object.assign({
    deposit: tokenDetails.deposit.toBigInt(),
    quantity: tokenDetails.quantity.toBigInt(),
    consumers: tokenDetails.consumers.toNumber(),
    royaltyRate: tokenDetails.royaltyRate.toNumber(),
    royaltyBeneficiary: tokenDetails.royaltyBeneficiary.toString(),
  });
  await nftToken.save();
};

async function getNftClass(classId: u32) {
  let nftClass = await NftClass.get(classId.toString());
  if (!nftClass) {
    const maybeClassDetails = await api.query.nft.classes(classId);
    const classDetails = maybeClassDetails.unwrap();
    const ownerAccount = await ensureAccount(classDetails.owner.toString());
    nftClass = NftClass.create({
      id: classId.toString(),
      ownerId: ownerAccount.id,
      deposit: classDetails.deposit.toBigInt(),
      permission: classDetails.permission.toNumber(),
      totalTokens: classDetails.totalTokens.toBigInt(),
      totalIssuance: classDetails.totalIssuance.toBigInt(),
      royaltyRate: classDetails.royaltyRate.toNumber(),
      ...parseNftMetadata(classDetails.metadata),
    });
    await nftClass.save();
  }
  return nftClass;
}

async function getNftToken(classId: u32, localTokenId: u32) {
  const id = getTokenId(classId, localTokenId);
  let nftToken = await NftToken.get(id);
  if (!nftToken) {
    const maybeTokenDetails = await api.query.nft.tokens(classId, localTokenId);
    const tokenDetails = maybeTokenDetails.unwrap();
    const creatorAccount = await ensureAccount(tokenDetails.creator.toString());
    nftToken = NftToken.create({
      id,
      classId: classId.toString(),
      localTokenId: localTokenId.toString(),
      creatorId: creatorAccount.id,
      deposit: tokenDetails.deposit.toBigInt(),
      quantity: tokenDetails.quantity.toBigInt(),
      royaltyRate: tokenDetails.royaltyRate.toNumber(),
      royaltyBeneficiary: tokenDetails.royaltyBeneficiary.toString(),
      ...parseNftMetadata(tokenDetails.metadata),
    });
    await nftToken.save();
  }
  return nftToken;
}

export async function syncNftTokenOwner(
  classId: u32,
  localTokenId: u32,
  tokenOwner: AccountId32
) {
  const tokenId = getTokenId(classId, localTokenId);
  const id = tokenId + "-" + tokenOwner.toString();
  let nftTokenOwner = await NftTokenOwner.get(id);
  const maybeAmount = await api.query.nft.tokensByOwner(tokenOwner, [
    classId,
    localTokenId,
  ]);
  const tokenOwnerAccount = await ensureAccount(tokenOwner.toString());
  if (maybeAmount.isEmpty) {
    if (nftTokenOwner) {
      await NftTokenOwner.remove(id);
    }
  } else {
    const amountInfo = maybeAmount.unwrap();
    if (nftTokenOwner) {
      Object.assign(nftTokenOwner, {
        free: amountInfo.free.toBigInt(),
        reserved: amountInfo.reserved.toBigInt(),
      });
      await nftTokenOwner.save();
    } else if (!nftTokenOwner) {
      nftTokenOwner = await NftTokenOwner.create({
        id,
        tokenId,
        ownerId: tokenOwnerAccount.id,
        free: amountInfo.free.toBigInt(),
        reserved: amountInfo.reserved.toBigInt(),
      });
      await nftTokenOwner.save();
    }
  }
}

async function upsertTokenOwners(classId: u32, localTokenId: u32) {
  const tokenId = getTokenId(classId, localTokenId);
  const ownersByToken = await api.query.nft.ownersByToken.entries([
    classId,
    localTokenId,
  ]);
  for (const ownerItem of ownersByToken) {
    const tokenOwner = ownerItem[0].args[1];
    const maybeAmount = await api.query.nft.tokensByOwner(tokenOwner, [
      classId,
      localTokenId,
    ]);
    const tokenOwnerAccount = await ensureAccount(tokenOwner.toString());
    const amountInfo = maybeAmount.unwrap();
    const nftTokenOwner = NftTokenOwner.create({
      id: tokenId + "-" + tokenOwner.toString(),
      tokenId,
      ownerId: tokenOwnerAccount.id,
      free: amountInfo.free.toBigInt(),
      reserved: amountInfo.reserved.toBigInt(),
    });
    await nftTokenOwner.save();
  }
}

export function getTokenId(
  classId: u32 | Compact<u32>,
  localTokenId: u32 | Compact<u32>
) {
  return classId.toString() + "-" + localTokenId.toString();
}

function parseNftMetadata(metadata: Bytes): {
  metadataRaw?: string;
  metadata?: NftMetadata;
} {
  if (isUtf8(metadata.toU8a())) {
    try {
      const json = JSON.parse(metadata.toUtf8());
      if (json && typeof json === "object") {
        return { metadata: json };
      }
    } catch {}
  }
  return { metadataRaw: metadata.toString() };
}
