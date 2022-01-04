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
  StorageFileReplica,
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
    blockNumber: event.blockNumber,
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
  const [roundIndex, mine] = rawEvent.event.data as unknown as [u32, Balance];
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
  prevRound.mine = mine.toBigInt();
  await prevRound.save();
};

export async function report({
  rawCall,
  call,
  rawExtrinsic,
}: DispatchedCallData) {
  if (!call.isSuccess) return;
  const [rid, , , addFiles, delFiles, settleFiles] =
    rawCall.args as unknown as [
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
  const storeFileDeletedEvents = rawExtrinsic.events.filter(
    ({ event }) =>
      event.section === "fileStorage" && event.method === "FileDeleted"
  );
  const storeFileNewOrderEvents = rawExtrinsic.events.filter(
    ({ event }) =>
      event.section === "fileStorage" && event.method === "FileStored"
  );
  const [
    reporter,
    machineId,
    mineReward,
    shareStoreReward,
    DirectStoreReward,
    slash,
  ] = event.data as unknown as [
    AccountId32,
    Bytes,
    Balance,
    Balance,
    Balance,
    Balance
  ];
  const currentRound = await api.query.fileStorage.currentRound();
  const node = await syncNode(reporter, machineId);
  const round = await getReportRound(currentRound);
  const blockNumber = rawExtrinsic.block.block.header.number.toBigInt();

  const nodeReport = StorageNodeReport.create({
    id: call.id,
    reporterId: node.id,
    roundId: round.id,
    rid: rid.toNumber(),
    used: node.used,
    power: node.power,
    deposit: node.deposit,
    mineReward: mineReward.toBigInt(),
    shareStoreReward: shareStoreReward.toBigInt(),
    directStoreReward: DirectStoreReward.toBigInt(),
    slash: slash.toBigInt(),
    extrinsicId: call.extrinsicId,
    blockNumber,
    timestamp: call.timestamp,
  });
  await nodeReport.save();
  const removeOrders: Bytes[] = storeFileDeletedEvents.map(
    ({ event }) => event.data[0] as unknown as Bytes
  );
  const newOrders: Bytes[] = storeFileNewOrderEvents.map(
    ({ event }) => event.data[0] as unknown as Bytes
  );
  const maybeChangeFiles = [...addFiles.map(([cid]) => cid), ...settleFiles];
  const maybeFileOrders = await batchQueryFileOrders([
    ...maybeChangeFiles,
    ...delFiles,
    ...newOrders,
  ]);
  const getOrderId = (cid: Bytes) => cidToString(cid) + "-" + call.id;
  const getReplicaId = (node: AccountId32, cid: Bytes) =>
    node.toString() + "-" + cidToString(cid) + "-" + blockNumber;
  await Promise.all([
    ...removeOrders.map(async (cid) => {
      const file = await StorageStoreFile.get(cidToString(cid));
      if (file.currentOrderId) {
        await setFileOrderDeteleted(file, blockNumber);
      }
      file.status = StorageFileStatus.INVALID;
      await file.save();
    }),
    ...newOrders.map(async (cid) => {
      const file = await syncStoreFile(cid);
      const fileOrder = maybeFileOrders[cidToString(cid)].unwrap();
      const currentReplicaIds = fileOrder.replicas.map((node) =>
        getReplicaId(node, cid)
      );
      const order = StorageFileOrder.create({
        id: getOrderId(cid),
        fee: fileOrder.fee.toBigInt(),
        fileSize: fileOrder.fileSize.toBigInt(),
        expireAt: fileOrder.expireAt.toBigInt(),
        renew: 0,
        currentReplicaIds,
        addedAt: blockNumber,
        storeFileId: file.id,
      });
      file.currentOrderId = order.id;
      await order.save();
      await file.save();
      await Promise.all(
        fileOrder.replicas.map(async (node) => {
          const repoterNode = await ensureNode(node);
          const replica = StorageFileReplica.create({
            id: getReplicaId(node, cid),
            addedAt: blockNumber,
            orderId: order.id,
            reporterId: repoterNode.id,
            storeFileId: file.id,
          });
          await replica.save();
        })
      );
    }),
  ]);
  await Promise.all([
    ...maybeChangeFiles.map(async (cid) => {
      const maybeFileOrder = maybeFileOrders[cidToString(cid)];
      if (maybeFileOrder.isNone) return;
      const fileOrder = maybeFileOrder.unwrap();
      const file = await StorageStoreFile.get(cidToString(cid));
      if (!file || !file.currentOrderId) return;
      const order = await StorageFileOrder.get(file.currentOrderId);
      if (order.expireAt !== fileOrder.expireAt.toBigInt()) {
        order.renew += 1;
        order.expireAt = fileOrder.expireAt.toBigInt();
      }
      const newCurrentReplicaIds = [];
      const toRemoveReplicas = order.currentReplicaIds.slice();
      const toAddReplicas = [];
      for (const node of fileOrder.replicas.map((v) => v.toString())) {
        const index = toRemoveReplicas.findIndex((v) => v.startsWith(node));
        if (index > -1) {
          newCurrentReplicaIds.push(toRemoveReplicas[index]);
          toRemoveReplicas.splice(index, 1);
        } else {
          toAddReplicas.push(node);
        }
      }
      await Promise.all([
        ...toAddReplicas.map(async (node) => {
          const repoterNode = await ensureNode(node);
          const id = getReplicaId(node, cid);
          const replica = StorageFileReplica.create({
            id,
            addedAt: blockNumber,
            orderId: order.id,
            reporterId: repoterNode.id,
            storeFileId: file.id,
          });
          await replica.save();
          newCurrentReplicaIds.push(id);
        }),
        ...toRemoveReplicas.map(async (id) => {
          const replica = await StorageFileReplica.get(id);
          if (replica) {
            replica.deletedAt = blockNumber;
            await replica.save();
          }
        }),
      ]);
      order.currentReplicaIds = newCurrentReplicaIds;
      await order.save();
    }),
    ...delFiles.map(async (cid) => {
      const maybeFileOrder = maybeFileOrders[cidToString(cid)];
      if (maybeFileOrder.isNone) return;
      const file = await StorageStoreFile.get(cidToString(cid));
      if (!file || !file.currentOrderId) return;
      const order = await StorageFileOrder.get(file.currentOrderId);
      const replicaId = order.currentReplicaIds.find(
        (v) => v.split("-")[1] === cidToString(cid)
      );
      if (replicaId) {
        const replica = await StorageFileReplica.get(replicaId);
        if (replica) {
          replica.deletedAt = blockNumber;
          await replica.save();
        }
      }
    }),
  ]);
}

async function syncStoreFile(cid: Bytes) {
  const id = cidToString(cid);
  let file = await StorageStoreFile.get(id);
  if (!file) {
    file = new StorageStoreFile(id);
  }
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

function cidToString(cid: Bytes) {
  if (!isUtf8(cid)) return cid.toString();
  try {
    const maybeCid = cid.toUtf8();
    CID.parse(maybeCid);
    return maybeCid;
  } catch {}
  return cid.toString();
}
async function syncNode(owner: AccountId32, machineId: Bytes) {
  const id = machineId.toString();
  let node = await StorageNode.get(id);
  if (!node) {
    node = new StorageNode(id);
  }
  const [maybeRegister, maybeNodeInfo] = (await api.queryMulti([
    [api.query.fileStorage.registers, machineId],
    [api.query.fileStorage.nodes, owner],
  ])) as [Option<PalletStorageRegisterInfo>, Option<PalletStorageNodeInfo>];
  const registerInfo = maybeRegister.unwrap() as PalletStorageRegisterInfo;
  const nodeInfo = maybeNodeInfo.unwrap() as PalletStorageNodeInfo;
  node.enclave = registerInfo.enclave.toString();
  const controllerAccount = await ensureAccount(owner.toString());
  const stashAccount = await ensureAccount(nodeInfo.stash.toString());
  node.controllerId = controllerAccount.id;
  node.stashId = stashAccount.id;
  node.deposit = nodeInfo.deposit.toBigInt();
  node.rid = nodeInfo.rid.toNumber();
  node.used = nodeInfo.used.toBigInt();
  node.power = nodeInfo.power.toBigInt();
  node.reportedAt = nodeInfo.reportedAt.toBigInt();
  await node.save();
  return node;
}

async function ensureNode(owner: AccountId32 | string, machineId?: Bytes) {
  if (!machineId) {
    const maybeNodeInfo = await api.query.fileStorage.nodes(owner);
    const nodeInfo = maybeNodeInfo.unwrap();
    machineId = nodeInfo.machineId.unwrap();
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
  if (!reportRound) {
    reportRound = new StorageReportRound(roundIndex.toString());
    const [roundReward, roundSummary] = (await api.queryMulti([
      [api.query.fileStorage.roundsReward, roundIndex],
      [api.query.fileStorage.roundsSummary, roundIndex],
    ])) as [PalletStorageRewardInfo, PalletStorageSummaryStats];
    reportRound.used = roundSummary.used.toBigInt();
    reportRound.power = roundSummary.power.toBigInt();
    reportRound.storeReward = roundReward.storeReward.toBigInt();
    reportRound.mineReward = roundReward.mineReward.toBigInt();
    reportRound.paidMineReard = roundReward.paidMineReward.toBigInt();
    reportRound.paidStoreReward = roundReward.paidStoreReward.toBigInt();
    reportRound.mine = BigInt(0);
    await reportRound.save();
  }
  return reportRound;
}

async function batchQueryFileOrders(cids: Bytes[]): Promise<BatchFileOrders> {
  if (cids.length === 0) return {};
  const allCids = Array.from(new Set(cids.map((v) => cidToString(v))));
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
  const replicas = await StorageFileReplica.getByOrderId(order.id);
  await Promise.all(
    replicas.map(async (replica) => {
      if (!replica.deletedAt) {
        replica.deletedAt = blockNumber;
        await replica.save();
      }
    })
  );
}
