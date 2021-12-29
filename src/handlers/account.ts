import { Account } from "../types/models";

export async function ensureAccount(accountId: string) {
  let account = await Account.get(accountId);

  if (account) return account;

  account = new Account(accountId);

  await account.save();

  return account;
}
