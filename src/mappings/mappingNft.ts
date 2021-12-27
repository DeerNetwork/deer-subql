import { SubstrateEvent } from "@subql/types";
import { u32, u64 } from "@polkadot/types";
import {
  NftClass,
  NftTokenOwner,
  NftToken,
  NftTokenBurn,
  NftTokenTransfer,
} from "../types";
import { AccountId } from "@polkadot/types/interfaces";
import { getTokenId, parseMetadata } from "../utils";

export async function handleNftCreated(event: SubstrateEvent): Promise<void> {
  const {
    data: [classIdRaw, owner],
  } = event.event;
  const classId = classIdRaw as unknown as u32;
  const maybeClassDetails = await api.query.nft.classes(classId);
  if (maybeClassDetails.isNone) return;
  const classDetails = maybeClassDetails.unwrap();
  const record = NftClass.create({
    id: classId.toString(),
    owner: owner.toString(),
    deposit: classDetails.deposit.toBigInt(),
    permission: classDetails.permission.toNumber(),
    totalTokens: classDetails.totalTokens.toBigInt(),
    totalIssuance: classDetails.totalIssuance.toBigInt(),
    royaltyRate: classDetails.royaltyRate.toNumber(),
    ...parseMetadata(classDetails.metadata),
  });
  await record.save();
}

export async function handleNftIssued(event: SubstrateEvent): Promise<void> {
  const {
    data: [classIdRaw, tokenIdRaw],
  } = event.event;
  const classId = classIdRaw as unknown as u32;
  const tokenId = tokenIdRaw as unknown as u32;
  const maybeTokenDetails = await api.query.nft.tokens(classId, tokenId);
  if (maybeTokenDetails.isNone) return;
  const tokenDetails = maybeTokenDetails.unwrap();
  const record = NftToken.create({
    id: getTokenId(classId, tokenId),
    classId: classId.toString(),
    tokenId: tokenId.toNumber(),
    isBurned: false,
    // creator: tokenDetails.creator.toString(),
    deposit: tokenDetails.deposit.toBigInt(),
    quantity: tokenDetails.quantity.toBigInt(),
    consumers: tokenDetails.consumers.toNumber(),
    royaltyRate: tokenDetails.royaltyRate.toNumber(),
    royaltyBeneficiary: tokenDetails.royaltyBeneficiary.toString(),
    ...parseMetadata(tokenDetails.metadata),
  });
  await record.save();
  const ownersByToken = await api.query.nft.ownersByToken.entries([
    classId,
    tokenId,
  ]);
  for (const ownerItem of ownersByToken) {
    const tokenOwner = ownerItem[0].args[1];
    const maybeAmount = await api.query.nft.tokensByOwner(tokenOwner, [
      classId,
      tokenId,
    ]);
    const amountInfo = maybeAmount.unwrap();
    const ownerRecord = NftTokenOwner.create({
      id: record.id + "-" + tokenOwner.toString(),
      tokenId: record.id,
      who: tokenOwner.toString(),
      free: amountInfo.free.toBigInt(),
      reserved: amountInfo.reserved.toBigInt(),
    });
    await ownerRecord.save();
  }
}

export async function handleNftCreatedClass(
  event: SubstrateEvent
): Promise<void> {
  return handleNftCreated(event);
}

export async function handleNftMintedToken(
  event: SubstrateEvent
): Promise<void> {
  return handleNftIssued(event);
}

export async function handleNftBurnedToken(
  event: SubstrateEvent
): Promise<void> {
  const {
    data: [classIdRaw, tokenIdRaw, quantityRaw, whoRaw],
  } = event.event;
  const classId = classIdRaw as unknown as u32;
  const tokenId = tokenIdRaw as unknown as u32;
  const quantity = quantityRaw as unknown as u64;
  const who = whoRaw as unknown as AccountId;
  const maybeTokenDetails = await api.query.nft.tokens(classId, tokenId);
  const record = await NftToken.get(getTokenId(classId, tokenId));
  const burnRecord = NftTokenBurn.create({
    id: event.extrinsic.extrinsic.hash.toString(),
    tokenId: record.id,
    who: who.toString(),
    quantity: quantity.toBigInt(),
  });

  await burnRecord.save();
  if (maybeTokenDetails.isNone) {
    record.isBurned = true;
    await record.save();
    return;
  }
}

export async function handleNftTransferredToken(
  event: SubstrateEvent
): Promise<void> {
  const {
    data: [classIdRaw, tokenIdRaw, quantityRaw, fromRaw, toRaw],
  } = event.event;
  const classId = classIdRaw as unknown as u32;
  const tokenId = tokenIdRaw as unknown as u32;
  const quantity = quantityRaw as unknown as u64;
  const from = fromRaw as unknown as AccountId;
  const to = toRaw as unknown as AccountId;
  const recordId = getTokenId(classId, tokenId);
  const maybeAmount = await api.query.nft.tokensByOwner(from, [
    classId,
    tokenId,
  ]);
  const ownerRecordId = recordId + "-" + from.toString();
  if (maybeAmount.isNone) {
    await NftTokenOwner.remove(ownerRecordId);
  } else {
    const amountInfo = maybeAmount.unwrap();
    const ownerRecord = await NftTokenOwner.get(ownerRecordId);
    Object.assign(ownerRecord, {
      who: from.toString(),
      free: amountInfo.free.toBigInt(),
      reserved: amountInfo.reserved.toBigInt(),
    });
    await ownerRecord.save();
  }

  const transferRecord = NftTokenTransfer.create({
    id: event.extrinsic.extrinsic.hash.toString(),
    tokenId: recordId,
    quantity: quantity.toBigInt(),
    from: from.toString(),
    to: to.toString(),
  });
  await transferRecord.save();
}
