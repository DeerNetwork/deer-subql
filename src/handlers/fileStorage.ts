import { u32, u64, Bytes, Option } from "@polkadot/types";
import { BN, isUtf8 } from "@polkadot/util";
import { CID } from "multiformats/cid";
import { AnyNumber } from "@polkadot/types/types";
import { AccountId32 } from "@polkadot/types/interfaces/runtime";
import { Balance } from "@polkadot/types/interfaces";
import { DispatchedCallData, EventHandler } from "./types";
import {
  StorageNode,
  StorageReportRound,
  StorageStoreFile,
  StorageStoreFileFund,
  StorageFileOrderReplica,
  StorageFileOrder,
  StorageNodeReport,
  StorageFileStatus,
} from "../types";
import { ensureAccount } from "./account";
import {
  PalletStorageFileOrder,
  PalletStorageNodeInfo,
  PalletStorageRegisterInfo,
  PalletStorageRewardInfo,
  PalletStorageStashInfo,
  PalletStorageSummaryStats,
} from "@polkadot/types/lookup";

export const createStoreFile: EventHandler = async ({ rawEvent, event }) => {
  const [cid, funder, fee] = rawEvent.event.data as unknown as [
    Bytes,
    AccountId32,
    Balance
  ];
  const file = await syncStoreFile(cid);
  if (file.status === StorageFileStatus.INVALID) {
    file.status = StorageFileStatus.WAITING;
    await file.save();
  }
  const funderAccount = await ensureAccount(funder.toString());
  const fund = StorageStoreFileFund.create({
    id: event.id,
    funderId: funderAccount.id,
    storeFileId: file.id,
    fee: fee.toBigInt(),
    extrinsicId: event.extrinsicId,
    timestamp: event.timestamp,
  });
  await fund.save();
};

export const registerNode: EventHandler = async ({ rawEvent }) => {
  const [owner, machineId] = rawEvent.event.data as unknown as [
    AccountId32,
    Bytes
  ];
  await syncNode(owner, machineId);
};

export const roundEnd: EventHandler = async ({ rawEvent, event }) => {
  const [roundIndex, unpaid] = rawEvent.event.data as unknown as [u32, Balance];
  const prevIndex = roundIndex.sub(new BN(1));
  const [roundReward, prevRoundReward, roundSummary] = (await api.queryMulti([
    [api.query.fileStorage.roundsReward, roundIndex],
    [api.query.fileStorage.roundsReward, prevIndex],
    [api.query.fileStorage.roundsSummary, roundIndex],
  ])) as [
    PalletStorageRewardInfo,
    PalletStorageRewardInfo,
    PalletStorageSummaryStats
  ];
  const currentRound = await getReportRound(roundIndex);
  currentRound.power = roundSummary.power.toBigInt();
  currentRound.used = roundSummary.used.toBigInt();
  currentRound.mineReward = roundReward.mineReward.toBigInt();
  currentRound.storeReward = roundReward.storeReward.toBigInt();
  currentRound.endedAt = event.blockNumber;
  await currentRound.save();
  const prevRound = await getReportRound(prevIndex);
  prevRound.paidMineReard = prevRoundReward.paidMineReward.toBigInt();
  prevRound.paidStoreReward = prevRoundReward.paidStoreReward.toBigInt();
  prevRound.unpaid = unpaid.toBigInt();
  await prevRound.save();
};

export async function report({
  rawCall,
  call,
  rawExtrinsic,
}: DispatchedCallData) {
  if (!call.isSuccess) return;
  const [rid, , , addFiles, delFiles] = rawCall.args as unknown as [
    u64,
    u64,
    Bytes,
    [[Bytes, u64]],
    [Bytes],
    [Bytes]
  ];
  const { event } = rawExtrinsic.events.find(
    ({ event }) =>
      event.section === "fileStorage" && event.method === "NodeReported"
  );
  const storeFileRemovedEvents = rawExtrinsic.events.filter(
    ({ event }) =>
      event.section === "fileStorage" && event.method === "StoreFileRemoved"
  );
  const storeFileNewOrderEvents = rawExtrinsic.events.filter(
    ({ event }) =>
      event.section === "fileStorage" && event.method === "StoreFileNewOrder"
  );
  const [
    reporter,
    machineId,
    roundIndex,
    slash,
    mineReward,
    shareStoreReward,
    directStoreReward,
  ] = event.data as unknown as [
    AccountId32,
    Bytes,
    u32,
    Balance,
    Balance,
    Balance,
    Balance
  ];
  const node = await syncNode(reporter, machineId);
  const round = await getReportRound(roundIndex);
  const blockNumber = rawExtrinsic.block.block.header.number.toBigInt();

  const nodeReport = StorageNodeReport.create({
    id: call.id,
    nodeId: node.id,
    roundId: round.id,
    rid: rid.toNumber(),
    used: node.used,
    power: node.power,
    slash: slash.toBigInt(),
    mineReward: mineReward.toBigInt(),
    shareStoreReward: shareStoreReward.toBigInt(),
    directStoreReward: directStoreReward.toBigInt(),
    extrinsicId: call.extrinsicId,
    timestamp: call.timestamp,
  });
  await nodeReport.save();
  const removeOrders: Bytes[] = storeFileRemovedEvents.map(
    ({ event }) => event.data[0] as unknown as Bytes
  );
  const newOrders: Bytes[] = storeFileNewOrderEvents.map(
    ({ event }) => event.data[0] as unknown as Bytes
  );
  const maybeFileOrders = await batchQueryFileOrders([
    ...addFiles.map(([cid]) => cid),
    ...delFiles,
    ...newOrders,
  ]);
  await Promise.all([
    ...removeOrders.map(async (cid) => {
      const file = await StorageStoreFile.get(cid.toString());
      if (file.currentOrderId) {
        await setFileOrderDeteleted(file, blockNumber);
      }
      file.status = StorageFileStatus.INVALID;
      await file.save();
    }),
    ...newOrders.map(async (cid) => {
      const file = await syncStoreFile(cid);
      if (file.currentOrderId) {
        await setFileOrderDeteleted(file, blockNumber);
      }
      const fileOrder = maybeFileOrders[cid.toString()].unwrap();
      const order = StorageFileOrder.create({
        id: cid.toString() + "-" + call.id,
        fee: fileOrder.fee.toBigInt(),
        fileSize: fileOrder.fileSize.toBigInt(),
        expireAt: fileOrder.expireAt.toBigInt(),
        addedAt: blockNumber,
        storeFileId: file.id,
      });
      file.currentOrderId = order.id;
      await order.save();
      await file.save();
      await Promise.all(
        fileOrder.replicas.map(async (reporter) => {
          const repoterNode = await ensureNode(reporter);
          const replica = StorageFileOrderReplica.create({
            id: report.toString() + "-" + call.id,
            addedAt: blockNumber,
            orderId: order.id,
            nodeId: repoterNode.id,
          });
          await replica.save();
        })
      );
    }),
  ]);
  await Promise.all([
    ...addFiles.map(async ([cid]) => {
      const maybeFileOrder = maybeFileOrders[cid.toString()];
      if (maybeFileOrder.isNone) return;
      const fileOrder = maybeFileOrder.unwrap();
      if (!fileOrder.replicas.find((replica) => replica.eq(reporter))) return;
      const file = await StorageStoreFile.get(cid.toString());
      if (!file || !file.currentOrderId) return;
      const replicas = await StorageFileOrderReplica.getByOrderId(
        file.currentOrderId
      );
      let replica = replicas.find((replica) => replica.nodeId == node.id);
      if (replica) return;
      replica = StorageFileOrderReplica.create({
        id: report.toString() + "-" + call.id,
        addedAt: blockNumber,
        orderId: file.currentOrderId,
        nodeId: node.id,
      });
      await replica.save();
    }),
    ...delFiles.map(async (cid) => {
      const maybeFileOrder = maybeFileOrders[cid.toString()];
      if (maybeFileOrder.isNone) return;
      const fileOrder = maybeFileOrder.unwrap();
      if (fileOrder.replicas.find((replica) => replica.eq(reporter))) return;
      const file = await StorageStoreFile.get(cid.toString());
      const replicas = await StorageFileOrderReplica.getByOrderId(
        file.currentOrderId
      );
      const replica = replicas.find((replica) => replica.nodeId == node.id);
      if (!replica) return;
      replica.deletedAt = blockNumber;
      await replica.save();
    }),
  ]);
}

async function syncStoreFile(cid: Bytes) {
  const id = cid.toString();
  let file = await StorageStoreFile.get(id);
  if (!file) {
    file = new StorageStoreFile(id);
  }
  maybeSetCid(file, cid);
  const maybeStoreFile = await api.query.fileStorage.storeFiles(cid);
  const storeFile = maybeStoreFile.unwrap();
  file.reserved = storeFile.reserved.toBigInt();
  file.baseFee = storeFile.baseFee.toBigInt();
  file.fileSize = storeFile.fileSize.toBigInt();
  file.addedAt = storeFile.addedAt.toBigInt();
  if (!file.firstAddedAt) {
    file.firstAddedAt = file.addedAt;
  }
  if (file.baseFee === BigInt(0)) {
    file.status = StorageFileStatus.STORING;
  } else {
    file.status = StorageFileStatus.WAITING;
  }
  await file.save();
  return file;
}

function maybeSetCid(file: StorageStoreFile, cid: Bytes) {
  if (!isUtf8(cid)) return;
  try {
    const maybeCid = cid.toUtf8();
    CID.parse(maybeCid);
    file.cid = maybeCid;
  } catch {}
}

async function syncNode(owner: AccountId32, machineId: Bytes) {
  const id = machineId.toString();
  let node = await StorageNode.get(id);
  if (!node) {
    node = new StorageNode(id);
  }
  const [maybeRegister, maybeStashInfo, maybeNodeInfo] = (await api.queryMulti([
    [api.query.fileStorage.registers, machineId],
    [api.query.fileStorage.stashs, owner],
    [api.query.fileStorage.nodes, owner],
  ])) as [
    Option<PalletStorageRegisterInfo>,
    Option<PalletStorageStashInfo>,
    Option<PalletStorageNodeInfo>
  ];
  const registerInfo = maybeRegister.unwrap() as PalletStorageRegisterInfo;
  const stashInfo = maybeStashInfo.unwrap() as PalletStorageStashInfo;
  node.enclave = registerInfo.enclave.toString();
  const ownerAccount = await ensureAccount(owner.toString());
  const stasherAccount = await ensureAccount(stashInfo.stasher.toString());
  node.ownerId = ownerAccount.id;
  node.stasherId = stasherAccount.id;
  node.deposit = stashInfo.deposit.toBigInt();
  if (maybeNodeInfo.isSome) {
    const nodeInfo = maybeNodeInfo.unwrap() as PalletStorageNodeInfo;
    node.rid = nodeInfo.rid.toNumber();
    node.used = nodeInfo.used.toBigInt();
    node.power = nodeInfo.power.toBigInt();
    node.reportedAt = nodeInfo.reportedAt.toBigInt();
  }
  await node.save();
  return node;
}

async function ensureNode(owner: AccountId32, machineId?: Bytes) {
  if (!machineId) {
    const maybeStashInfo = await api.query.fileStorage.stashs(owner);
    const stashInfo = maybeStashInfo.unwrap();
    machineId = stashInfo.machineId.unwrap();
  }
  const id = machineId.toString();
  let node = await StorageNode.get(id);
  if (!node) {
    node = new StorageNode(id);
    await node.save();
  }
  return node;
}

async function getReportRound(roundIndex: AnyNumber) {
  let reportRound = await StorageReportRound.get(roundIndex.toString());
  if (reportRound) {
    reportRound = new StorageReportRound(roundIndex.toString());
    await reportRound.save();
  }
  return reportRound;
}

async function batchQueryFileOrders(cids: Bytes[]): Promise<BatchFileOrders> {
  if (cids.length === 0) return {};
  const allCids = Array.from(new Set(cids.map((v) => v.toString())));
  const maybeFileOrders: Option<PalletStorageFileOrder>[] =
    await api.queryMulti(
      allCids.map((cid) => {
        return [api.query.fileStorage.fileOrders, cid];
      })
    );
  return allCids.reduce((acc, cur, index) => {
    acc[cur] = maybeFileOrders[index];
    return acc;
  }, {} as BatchFileOrders);
}

interface BatchFileOrders {
  [k: string]: Option<PalletStorageFileOrder>;
}

async function setFileOrderDeteleted(
  file: StorageStoreFile,
  blockNumber: bigint
) {
  const order = await StorageFileOrder.get(file.currentOrderId);
  order.deletedAt = blockNumber;
  await order.save();
  const replicas = await StorageFileOrderReplica.getByOrderId(order.id);
  await Promise.all(
    replicas.map(async (replica) => {
      if (!replica.deletedAt) {
        replica.deletedAt = blockNumber;
        await replica.save();
      }
    })
  );
}
