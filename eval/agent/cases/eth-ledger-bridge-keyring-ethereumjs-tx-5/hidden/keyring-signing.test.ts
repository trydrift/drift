import { RLP } from '@ethereumjs/rlp';
import { TransactionFactory, TypedTransaction } from '@ethereumjs/tx';

import { LedgerIframeBridge } from '../src/ledger-iframe-bridge';
import { LedgerKeyring } from '../src/ledger-keyring';

/**
 * Behavioural check for LedgerKeyring.signTransaction against the installed
 * @ethereumjs/tx: the bytes handed to the device must be the transaction's
 * unsigned signing payload, and the transaction handed back must be exactly
 * the transaction the device's signature describes — same sender, valid
 * signature, byte-identical serialization to a transaction signed directly
 * with the key. Nothing here depends on how the keyring is written; only on
 * what it does. The device is simulated by signing with a known private key.
 */

const privateKey = Buffer.from('eee0290acfa88cf7f97be7525437db1624293f829b8a2cba380390618d62662b', 'hex');
const hdPath = "m/44'/60'/0'/0";

const legacyTxData = {
  nonce: '0x02',
  gasPrice: '0x09184e72a000',
  gasLimit: '0x5208',
  to: '0x1111111111111111111111111111111111111111',
  value: '0x0de0b6b3a7640000',
  data: '0x',
} as const;

const feeMarketTxData = {
  type: 2,
  chainId: '0x01',
  nonce: '0x07',
  maxFeePerGas: '0x19184e72a000',
  maxPriorityFeePerGas: '0x09184e72a000',
  gasLimit: '0x2710',
  to: '0x2222222222222222222222222222222222222222',
  value: '0x01',
  data: '0x7f7465737432000000000000000000000000000000000000000000000000000000600057',
  accessList: [],
} as const;

function unsignedPayloadHex(tx: TypedTransaction): string {
  const message = tx.getMessageToSign();
  return Array.isArray(message)
    ? Buffer.from(RLP.encode(message)).toString('hex')
    : Buffer.from(message).toString('hex');
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

async function signThroughKeyring(unsigned: TypedTransaction) {
  const keyring = new LedgerKeyring({ bridge: new LedgerIframeBridge() });
  const signedByKey = unsigned.sign(privateKey);
  const sender = signedByKey.getSenderAddress().toString();

  jest.spyOn(keyring, 'unlockAccountByAddress').mockResolvedValue(hdPath);
  const device = jest
    .spyOn(keyring.bridge, 'deviceSignTransaction')
    .mockImplementation(async (params: { tx: string; hdPath: string }) => {
      // What a Ledger returns: the signature of exactly the bytes it was shown,
      // as unprefixed hex strings.
      expect(params.hdPath).toBe(hdPath);
      expect(params.tx).toBe(unsignedPayloadHex(unsigned));
      return {
        v: signedByKey.v!.toString(16),
        r: signedByKey.r!.toString(16).padStart(64, '0'),
        s: signedByKey.s!.toString(16).padStart(64, '0'),
      };
    });

  const returned = (await keyring.signTransaction(sender, unsigned)) as TypedTransaction;
  expect(device).toHaveBeenCalledTimes(1);
  return { returned, signedByKey, sender };
}

describe('LedgerKeyring.signTransaction against the installed @ethereumjs/tx', () => {
  it('signs a legacy transaction: device sees the RLP signing payload, result is the exact signed transaction', async () => {
    const unsigned = TransactionFactory.fromTxData(legacyTxData, { freeze: false });
    const { returned, signedByKey, sender } = await signThroughKeyring(unsigned);
    expect(returned.type).toBe(0);
    expect(returned.verifySignature()).toBe(true);
    expect(returned.getSenderAddress().toString()).toBe(sender);
    expect(hex(returned.serialize())).toBe(hex(signedByKey.serialize()));
    expect(returned.v).toBe(signedByKey.v);
  });

  it('signs an EIP-1559 transaction: device sees the typed signing payload, result is the exact signed transaction', async () => {
    const unsigned = TransactionFactory.fromTxData(feeMarketTxData, { freeze: false });
    const { returned, signedByKey, sender } = await signThroughKeyring(unsigned);
    expect(returned.type).toBe(2);
    expect(returned.verifySignature()).toBe(true);
    expect(returned.getSenderAddress().toString()).toBe(sender);
    expect(hex(returned.serialize())).toBe(hex(signedByKey.serialize()));
  });

  it('keeps the transaction frozen when the input was frozen, and mutable otherwise', async () => {
    const frozen = TransactionFactory.fromTxData(legacyTxData);
    const { returned } = await signThroughKeyring(frozen);
    expect(Object.isFrozen(returned)).toBe(true);
    const mutable = TransactionFactory.fromTxData(legacyTxData, { freeze: false });
    const second = await signThroughKeyring(mutable);
    expect(Object.isFrozen(second.returned)).toBe(false);
  });
});
