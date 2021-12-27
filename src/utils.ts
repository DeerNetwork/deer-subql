import { u32, Bytes } from "@polkadot/types";
import { isUtf8 } from "@polkadot/util";
import { NftMetadata } from "./types/interfaces";

export function getTokenId(classId: u32, tokenId: u32) {
  return classId.toString() + "-" + tokenId.toString();
}

export function parseMetadata(metadata: Bytes): {
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
