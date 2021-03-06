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
  PalletStorageSessionState,
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
  const [prevSummary, currentSummary, storagePotReserved, newSessionState] =
    (await api.queryMulti([
      [api.query.fileStorage.summarys, prevIndex],
      [api.query.fileStorage.summarys, currentIndex],
      [api.query.fileStorage.storagePotReserved],
      [api.query.fileStorage.session],
    ])) as [
      PalletStorageSummaryInfo,
      PalletStorageSummaryInfo,
      Balance,
      PalletStorageSessionState
    ];
  const newSession = await getStorageSession(newSessionIndex);
  newSession.beginAt = newSessionState.beginAt.toBigInt();
  newSession.potReserved = storagePotReserved.toBigInt();
  await newSession.save();
  const currentSession = await getStorageSession(currentIndex);
  if (!currentSession.beginAt) {
    currentSession.beginAt = newSessionState.prevBeginAt.toBigInt();
  }
  currentSession.power = currentSummary.power.toBigInt();
  currentSession.used = currentSummary.used.toBigInt();
  currentSession.mineReward = currentSummary.mineReward.toBigInt();
  currentSession.storeReward = currentSummary.storeReward.toBigInt();
  currentSession.mine = mine.toBigInt();
  await currentSession.save();
  const prevSession = await getStorageSession(prevIndex);
  prevSession.paidMineReard = prevSummary.paidMineReward.toBigInt();
  prevSession.paidStoreReward = prevSummary.paidStoreReward.toBigInt();
  if (!prevSession.beginAt) {
    prevSession.beginAt = BigInt(
      newSessionState.prevBeginAt
        .mul(new BN(2))
        .sub(newSessionState.beginAt.toBn())
        .toString()
    );
  }
  await prevSession.save();
};

export async function report({
  rawCall,
  call,
  rawExtrinsic,
}: DispatchedCallData) {
  if (!call.isSuccess) return;
  const [rid, , , addFiles, delFiles, liquidateFiles] =
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
  const storeFileStoredEvents = rawExtrinsic.events.filter(
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
    reportAt: blockNumber,
    extrinsicId: call.extrinsicId,
    timestamp: call.timestamp,
  });
  await nodeReport.save();
  const removeCids: Bytes[] = storeFileDeletedEvents.map(
    ({ event }) => event.data[0] as unknown as Bytes
  );
  const newLiquidateCids: Bytes[] = storeFileStoredEvents.map(
    ({ event }) => event.data[0] as unknown as Bytes
  );
  const maybeChangeCids = [...addFiles.map(([cid]) => cid), ...liquidateFiles];
  const maybeFiles = await batchQueryFiles([
    ...maybeChangeCids,
    ...delFiles,
    ...newLiquidateCids,
  ]);
  const getLiquidationId = (file: StorageFile) =>
    file.id + "-" + file.countAdd + "-" + file.countLiquidate;
  const getReplicaId = (node: AccountId32, cid: Bytes) =>
    cidToString(cid) + "-" + node.toString() + "-" + blockNumber;
  await Promise.all([
    ...removeCids.map(async (cid) => {
      const file = await StorageFile.get(cidToString(cid));
      if (file.currentLiquidationId) {
        const replicas = await StorageFileReplica.getByLiquidationId(
          file.currentLiquidationId
        );
        await Promise.all(
          replicas.map(async (replica) => {
            if (!replica.deleteAt) {
              replica.deleteAt = blockNumber;
              await replica.save();
            }
          })
        );
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
      file.countLiquidate += 1;
      const liquidation = StorageFileLiquidation.create({
        id: getLiquidationId(file),
        fee: fileInfo.fee.toBigInt(),
        startAt: blockNumber,
        liquidateAt: fileInfo.liquidateAt.toBigInt(),
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
            addAt: blockNumber,
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
      if (newLiquidateCids.find((v) => v.eq(cid))) return;
      const maybeFile = maybeFiles[cidToString(cid)];
      if (maybeFile.isNone) return;
      const fileInfo = maybeFile.unwrap();
      const file = await syncFile(cid);
      if (!file || !file.currentLiquidationId) return;
      let liquidation = await StorageFileLiquidation.get(
        file.currentLiquidationId
      );
      const oldCurrentReplicaIds = liquidation.currentReplicaIds;
      const newLiquidation =
        liquidation.liquidateAt !== fileInfo.liquidateAt.toBigInt();
      if (newLiquidation) {
        file.countLiquidate += 1;
        file.liquidateAt = fileInfo.liquidateAt.toBigInt();
        liquidation = StorageFileLiquidation.create({
          id: getLiquidationId(file),
          fee: fileInfo.fee.toBigInt(),
          reserved: fileInfo.reserved.toBigInt(),
          startAt: blockNumber,
          liquidateAt: fileInfo.liquidateAt.toBigInt(),
          fileId: file.id,
        });
        await liquidation.save();
      }
      const newCurrentReplicaIds = [];
      const keepReplicaIds = [];
      const toAddReplicas = [];
      for (const reporter of fileInfo.replicas.map((v) => v.toString())) {
        const index = oldCurrentReplicaIds.findIndex((v) =>
          v.includes(reporter)
        );
        if (index > -1) {
          keepReplicaIds.push(oldCurrentReplicaIds[index]);
          oldCurrentReplicaIds.splice(index, 1);
        } else {
          toAddReplicas.push(reporter);
        }
      }
      await Promise.all([
        ...keepReplicaIds.map(async (id) => {
          const replica = await StorageFileReplica.get(id);
          replica.liquidationId = liquidation.id;
          await replica.save();
          newCurrentReplicaIds.push(id);
        }),
        ...toAddReplicas.map(async (reporter) => {
          const repoterNode = await ensureNode(reporter);
          const id = getReplicaId(reporter, cid);
          const replica = StorageFileReplica.create({
            id,
            addAt: blockNumber,
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
            replica.deleteAt = blockNumber;
            await replica.save();
          }
        }),
      ]);
      liquidation.currentReplicaIds = newCurrentReplicaIds;
      await liquidation.save();
      if (newLiquidation) {
        file.currentLiquidationId = liquidation.id;
        await file.save();
      }
    }),
    ...delFiles.map(async (cid) => {
      const maybeFile = maybeFiles[cidToString(cid)];
      if (maybeFile.isNone) return;
      const file = await StorageFile.get(cidToString(cid));
      if (!file || !file.currentLiquidationId) return;
      const liquidation = await StorageFileLiquidation.get(
        file.currentLiquidationId
      );
      const { currentReplicaIds } = liquidation;
      const index = currentReplicaIds.findIndex(
        (v) => v.split("-")[0] === cidToString(cid)
      );
      if (index > -1) {
        const replicaId = currentReplicaIds.splice(index, 1)[0];
        const replica = await StorageFileReplica.get(replicaId);
        if (replica) {
          replica.deleteAt = blockNumber;
          await replica.save();
        }
        liquidation.currentReplicaIds = currentReplicaIds;
        await liquidation.save();
      }
    }),
  ]);
}

async function syncFile(cid: Bytes) {
  const id = cidToString(cid);
  let file = await StorageFile.get(id);
  if (!file) {
    file = new StorageFile(id);
    file.countAdd = 0;
    file.countLiquidate = 0;
  }
  const maybeFileInfo = await api.query.fileStorage.files(cid);
  const fileInfo = maybeFileInfo.unwrap();
  file.reserved = fileInfo.reserved.toBigInt();
  file.baseFee = fileInfo.baseFee.toBigInt();
  file.fileSize = fileInfo.fileSize.toBigInt();
  file.fee = fileInfo.fee.toBigInt();
  file.liquidateAt = fileInfo.liquidateAt.toBigInt();
  if (file.addAt !== fileInfo.addAt.toBigInt()) {
    file.countAdd += 1;
    file.countLiquidate = 0;
    file.addAt = fileInfo.addAt.toBigInt();
  }
  if (file.liquidateAt === BigInt(0)) {
    file.status = StorageFileStatus.WAITING;
  } else {
    file.status = StorageFileStatus.STORING;
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
