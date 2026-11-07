import { createRequire } from 'node:module';
export const { Account, JsonRpcProvider, PublicKey, KeyPair, actions } = createRequire(
  new URL('../../package.json', import.meta.url),
)('near-api-js');
export function actionFor(intent, wasm) {
  const p = intent.params;
  switch (intent.type) {
    case 'CreateAccount':
      return actions.createAccount();
    case 'Transfer':
      return actions.transfer(BigInt(p.deposit));
    case 'DeployContract':
      return actions.deployContract(wasm);
    case 'FunctionCall':
      return actions.functionCall(p.methodName, p.args, BigInt(p.gas), BigInt(p.deposit));
    case 'AddKey': {
      const key = PublicKey.fromString(p.publicKey),
        scope = p.accessKey.permission;
      return scope === 'FullAccess'
        ? actions.addFullAccessKey(key)
        : actions.addFunctionCallAccessKey(
            key,
            scope.receiverId,
            scope.methodNames,
            BigInt(scope.allowance),
          );
    }
    default:
      throw Error('UNEXPECTED_ACTION');
  }
}
