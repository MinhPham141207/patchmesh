export type ContractCompatibility = "compatible" | "breaking" | "unknown";

interface FunctionParameter {
  readonly name: string;
  readonly type: string;
  readonly optional: boolean;
  readonly rest: boolean;
}

interface FunctionSignature {
  readonly name: string;
  readonly parameters: readonly FunctionParameter[];
  readonly returnType: string;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function splitParameters(value: string): readonly string[] | null {
  const parameters: string[] = [];
  let start = 0;
  let angleDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "<") angleDepth += 1;
    if (character === ">") angleDepth -= 1;
    if (character === "[") bracketDepth += 1;
    if (character === "]") bracketDepth -= 1;
    if (character === "{") braceDepth += 1;
    if (character === "}") braceDepth -= 1;
    if (angleDepth < 0 || bracketDepth < 0 || braceDepth < 0) return null;
    if (character === "," && angleDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      parameters.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (angleDepth !== 0 || bracketDepth !== 0 || braceDepth !== 0) return null;
  const last = value.slice(start).trim();
  if (last.length > 0) parameters.push(last);
  return parameters;
}

function parseParameter(value: string): FunctionParameter | null {
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  const rest = normalized.startsWith("...");
  const parameter = rest ? normalized.slice(3).trim() : normalized;
  const defaultIndex = parameter.indexOf("=");
  const declaration = (defaultIndex < 0 ? parameter : parameter.slice(0, defaultIndex)).trim();
  const optionalByDefault = defaultIndex >= 0;
  const colonIndex = declaration.indexOf(":");
  if (colonIndex <= 0) return null;
  const rawName = declaration.slice(0, colonIndex).trim();
  const type = normalize(declaration.slice(colonIndex + 1));
  if (type.length === 0) return null;
  const optional = optionalByDefault || rawName.endsWith("?");
  const name = rawName.replace(/\?$/, "").trim();
  if (rest && optional) return null;
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
  return { name, type, optional, rest };
}

function parseFunction(value: string): FunctionSignature | null {
  const normalized = normalize(value);
  const match = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\((.*)\)\s*:\s*(.+)$/.exec(normalized);
  if (!match) return null;
  const rawParameters = splitParameters(match[2] ?? "");
  if (rawParameters === null) return null;
  const parameters: FunctionParameter[] = [];
  for (const rawParameter of rawParameters) {
    const parameter = parseParameter(rawParameter);
    if (parameter === null) return null;
    if (parameters.some((existing) => existing.rest)) return null;
    parameters.push(parameter);
  }
  const returnType = normalize(match[3] ?? "");
  if (returnType.length === 0) return null;
  return { name: match[1]!, parameters, returnType };
}

export function classifyContractCompatibility(before: string, after: string): ContractCompatibility {
  const normalizedBefore = normalize(before);
  const normalizedAfter = normalize(after);
  if (normalizedBefore.length === 0) return "unknown";
  const previous = parseFunction(normalizedBefore);
  if (!previous) return "unknown";
  if (normalizedBefore === normalizedAfter) return "compatible";
  if (normalizedAfter.length === 0) return "breaking";
  const current = parseFunction(normalizedAfter);
  if (!current) return "unknown";
  if (previous.name !== current.name || previous.returnType !== current.returnType) return "breaking";
  if (current.parameters.length < previous.parameters.length) return "breaking";

  for (let index = 0; index < previous.parameters.length; index += 1) {
    const beforeParameter = previous.parameters[index]!;
    const afterParameter = current.parameters[index]!;
    if (beforeParameter.type !== afterParameter.type || beforeParameter.rest !== afterParameter.rest) return "breaking";
    if (beforeParameter.optional && !afterParameter.optional) return "breaking";
  }
  for (const parameter of current.parameters.slice(previous.parameters.length)) {
    if (!parameter.optional && !parameter.rest) return "breaking";
  }
  return "compatible";
}
