import * as fs from "node:fs";
import * as path from "node:path";

export interface ContractScenario {
  readonly name: string;
  readonly contractPath: string;
  readonly beforeContent: string;
  readonly afterContent: string;
  readonly consumerBeforeContent: string;
  readonly consumerAfterContent: string;
}

const baseDir = path.join(import.meta.dirname, "contract-breaking");

function readScenario(name: string, contractFile: string): ContractScenario {
  const beforeContent = fs.readFileSync(path.join(baseDir, name, "before", contractFile), "utf8");
  const afterContent = fs.readFileSync(path.join(baseDir, name, "after", contractFile), "utf8");
  const consumerBeforeContent = fs.readFileSync(path.join(baseDir, name, "before", "consumer.ts"), "utf8");
  const consumerAfterContent = fs.readFileSync(path.join(baseDir, name, "after", "consumer.ts"), "utf8");
  return {
    name,
    contractPath: contractFile,
    beforeContent,
    afterContent,
    consumerBeforeContent,
    consumerAfterContent,
  };
}

export function loadContractScenarios(): readonly ContractScenario[] {
  return [
    readScenario("scenario-a-function-signature", "api.ts"),
    readScenario("scenario-b-interface-field", "types.ts"),
    readScenario("scenario-c-schema", "schema.ts"),
  ];
}
