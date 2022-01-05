import { u32, u64, Bytes, Option } from "@polkadot/types";
import { BN, isUtf8 } from "@polkadot/util";
import { CID } from "multiformats/cid";
import { AnyNumber } from "@polkadot/types/types";
import { AccountId32 } from "@polkadot/types/interfaces/runtime";
import { Balance } from "@polkadot/types/interfaces";
import { DispatchedCallData, EventHandler } from "./types";
import {
  StorageNode,
  StorageSession,
  StorageFile,
  StorageFileFund,
  StorageFileReplica,
  StorageReport,
  StorageFileStatus,
  StorageFileLiquidation,
} from "../types";
import { ensureAccount } from "./account";
import {
  PalletStorageFileInfo,
  PalletStorageNodeInfo,
  PalletStorageRegisterInfo,
  PalletStorageSummaryInfo,
} from "@polkadot/types/lookup";

export const createFile: EventHandler = async ({ rawEvent, event }) => {
  const [cid, funder, fee] = rawEvent.event.data as unknown as [
    Bytes,
    AccountId32,
    Balance
  ];
  const file = await syncFile(cid);
  if (file.status === StorageFileStatus.INVALID) {
    file.status = StorageFileStatus.WAITING;
    await file.save();
  }
  const funderAccount = await ensureAccount(funder.toString());
  const fund = StorageFileFund.create({
    id: event.id,
    funderId: funderAccount.id,
    fileId: file.id,
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

export const newSession: EventHandler = async ({ rawEvent, event }) => {
  const [newSessionIndex, mine] = rawEvent.event.data as unknown as [
    u32,
    Balance
  ];
  const currentIndex = newSessionIndex.sub(new BN(1));
  const prevIndex = newSessionIndex.sub(new BN(2));
  const [prevSummary, currentSummary] = (await api.queryMulti([
    [api.query.fileStorage.summarys, prevIndex],
    [api.query.fileStorage.summarys, prevIndex],
  ])) as [PalletStorageSummaryInfo, PalletStorageSummaryInfo];
  const currentSession = await getStorageSession(currentIndex);
  currentSession.power = currentSummary.power.toBigInt();
  currentSession.used = currentSummary.used.toBigInt();
  currentSession.mineReward = currentSummary.mineReward.toBigInt();
  currentSession.storeReward = currentSummary.storeReward.toBigInt();
  currentSession.endedAt = event.blockNumber;
  currentSession.mine = mine.toBigInt();
  await currentSession.save();
  const prevSession = await getStorageSession(prevIndex);
  prevSession.paidMineReard = prevSummary.paidMineReward.toBigInt();
  prevSession.paidStoreReward = prevSummary.paidStoreReward.toBigInt();
  await prevSession.save();
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
  const { current } = await api.query.fileStorage.session();
  const node = await syncNode(reporter, machineId);
  const session = await getStorageSession(current);
  const blockNumber = rawExtrinsic.block.block.header.number.toBigInt();

  const nodeReport = StorageReport.create({
    id: call.id,
    machineId: node.id,
    sessionId: session.id,
    rid: rid.toNumber(),
    used: node.used,
    power: node.power,
    deposit: node.deposit,
    mineReward: mineReward.toBigInt(),
    shareStoreReward: shareStoreReward.toBigInt(),
    directStoreReward: DirectStoreReward.toBigInt(),
    slash: slash.toBigInt(),
    extrinsicId: call.extrinsicId,
    timestamp: call.timestamp,
  });
  await nodeReport.save();
  const removeCids: Bytes[] = storeFileDeletedEvents.map(
    ({ event }) => event.data[0] as unknown as Bytes
  );
  const newLiquidateCids: Bytes[] = storeFileNewOrderEvents.map(
    ({ event }) => event.data[0] as unknown as Bytes
  );
  const maybeChangeCids = [...addFiles.map(([cid]) => cid), ...settleFiles];
  const maybeFiles = await batchQueryFiles([
    ...maybeChangeCids,
    ...delFiles,
    ...newLiquidateCids,
  ]);
  const getLiquidationId = (cid: Bytes) => cidToString(cid) + "-" + call.id;
  const getReplicaId = (node: AccountId32, cid: Bytes) =>
    node.toString() + "-" + cidToString(cid) + "-" + blockNumber;
  await Promise.all([
    ...removeCids.map(async (cid) => {
      const file = await StorageFile.get(cidToString(cid));
      if (file.currentLiquidationId) {
        await setFileDeteleted(file, blockNumber);
      }
      file.status = StorageFileStatus.INVALID;
      await file.save();
    }),
    ...newLiquidateCids.map(async (cid) => {
      const file = await syncFile(cid);
      const fileInfo = maybeFiles[cidToString(cid)].unwrap();
      const currentReplicaIds = fileInfo.replicas.map((node) =>
        getReplicaId(node, cid)
      );
      const liquidation = StorageFileLiquidation.create({
        id: getLiquidationId(cid),
        fee: fileInfo.fee.toBigInt(),
        startAt: blockNumber,
        expireAt: fileInfo.expireAt.toBigInt(),
        currentReplicaIds,
        fileId: file.id,
      });
      file.currentLiquidationId = liquidation.id;
      await liquidation.save();
      await file.save();
      await Promise.all(
        fileInfo.replicas.map(async (node) => {
          const repoterNode = await ensureNode(node);
          const replica = StorageFileReplica.create({
            id: getReplicaId(node, cid),
            addedAt: blockNumber,
            liquidationId: liquidation.id,
            machineId: repoterNode.id,
            fileId: file.id,
          });
          await replica.save();
        })
      );
    }),
  ]);
  await Promise.all([
    ...maybeChangeCids.map(async (cid) => {
      const maybeFile = maybeFiles[cidToString(cid)];
      if (maybeFile.isNone) return;
      const fileInfo = maybeFile.unwrap();
      const file = await StorageFile.get(cidToString(cid));
      if (!file || !file.currentLiquidationId) return;
      let liquidation = await StorageFileLiquidation.get(
        file.currentLiquidationId
      );
      const oldCurrentReplicaIds = liquidation.currentReplicaIds;
      if (liquidation.expireAt !== fileInfo.expireAt.toBigInt()) {
        liquidation = StorageFileLiquidation.create({
          id: getLiquidationId(cid),
          fee: fileInfo.fee.toBigInt(),
          startAt: blockNumber,
          expireAt: fileInfo.expireAt.toBigInt(),
          fileId: file.id,
        });
      }
      const newCurrentReplicaIds = [];
      const toAddReplicas = [];
      for (const node of fileInfo.replicas.map((v) => v.toString())) {
        const index = oldCurrentReplicaIds.findIndex((v) => v.startsWith(node));
        if (index > -1) {
          newCurrentReplicaIds.push(oldCurrentReplicaIds[index]);
          oldCurrentReplicaIds.splice(index, 1);
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
            liquidationId: liquidation.id,
            machineId: repoterNode.id,
            fileId: file.id,
          });
          await replica.save();
          newCurrentReplicaIds.push(id);
        }),
        ...oldCurrentReplicaIds.map(async (id) => {
          const replica = await StorageFileReplica.get(id);
          if (replica) {
            replica.deletedAt = blockNumber;
            await replica.save();
          }
        }),
      ]);
      liquidation.currentReplicaIds = newCurrentReplicaIds;
      await liquidation.save();
    }),
    ...delFiles.map(async (cid) => {
      const maybeFile = maybeFiles[cidToString(cid)];
      if (maybeFile.isNone) return;
      const file = await StorageFile.get(cidToString(cid));
      if (!file || !file.currentLiquidationId) return;
      const liquidation = await StorageFileLiquidation.get(
        file.currentLiquidationId
      );
      const replicaId = liquidation.currentReplicaIds.find(
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

async function syncFile(cid: Bytes) {
  const id = cidToString(cid);
  let file = await StorageFile.get(id);
  if (!file) {
    file = new StorageFile(id);
  }
  const maybeFileInfo = await api.query.fileStorage.files(cid);
  const fileInfo = maybeFileInfo.unwrap();
  file.reserved = fileInfo.reserved.toBigInt();
  file.baseFee = fileInfo.baseFee.toBigInt();
  file.fileSize = fileInfo.fileSize.toBigInt();
  file.fee = fileInfo.fee.toBigInt();
  file.expireAt = fileInfo.expireAt.toBigInt();
  if (file.addedAt !== fileInfo.addedAt.toBigInt()) {
    file.addedAt = fileInfo.addedAt.toBigInt();
    if (Number.isInteger(file.addIndex)) {
      file.addIndex = file.addIndex + 1;
    } else {
      file.addIndex = 0;
    }
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
  node.prevReportedAt = nodeInfo.prevReportedAt.toBigInt();
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

async function getStorageSession(index: AnyNumber) {
  let session = await StorageSession.get(index.toString());
  if (!session) {
    session = new StorageSession(index.toString());
    const summary = await api.query.fileStorage.summarys(index);
    session.used = summary.used.toBigInt();
    session.power = summary.power.toBigInt();
    session.storeReward = summary.storeReward.toBigInt();
    session.mineReward = summary.mineReward.toBigInt();
    session.paidMineReard = summary.paidMineReward.toBigInt();
    session.paidStoreReward = summary.paidStoreReward.toBigInt();
    session.mine = BigInt(0);
    session.nodes = summary.count.toNumber();
    await session.save();
  }
  return session;
}

async function batchQueryFiles(cids: Bytes[]): Promise<BatchFiles> {
  if (cids.length === 0) return {};
  const allCids = Array.from(new Set(cids.map((v) => cidToString(v))));
  const maybeFiles: Option<PalletStorageFileInfo>[] = await api.queryMulti(
    allCids.map((cid) => {
      return [api.query.fileStorage.files, cid];
    })
  );
  return allCids.reduce((acc, cur, index) => {
    acc[cur] = maybeFiles[index];
    return acc;
  }, {} as BatchFiles);
}

interface BatchFiles {
  [k: string]: Option<PalletStorageFileInfo>;
}

async function setFileDeteleted(file: StorageFile, blockNumber: bigint) {
  const liquidation = await StorageFile.get(file.currentLiquidationId);
  await liquidation.save();
  const replicas = await StorageFileReplica.getByLiquidationId(liquidation.id);
  await Promise.all(
    replicas.map(async (replica) => {
      if (!replica.deletedAt) {
        replica.deletedAt = blockNumber;
        await replica.save();
      }
    })
  );
}
